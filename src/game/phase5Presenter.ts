/**
 * Presentation of Phase 5 (design 8, 12, 15, 20.3): the bodycam / dashcam snapshots and their media store, the courtroom
 * and evidence review panels (the IA statement flow), and the HUD additions (force tool, camera chips, legal line, duty,
 * court, trust). It changes the simulation only through request queues; snapshots and panels never feed back.
 */
import { iaStatementOptions } from '../conduct';
import { log } from '../core/log';
import { RECORDING, SnapshotScheduler, captureSnapshot, createMediaStore, retentionOf, type MediaStore } from '../recording';
import { formatClockTime } from '../records/calendar';
import { CourtroomPanel, courtroomViewOf } from '../ui/court/courtroomPanel';
import type { HudSnapshot } from '../ui/hud/hud';
import type { HudCam, HudForce, HudLegal, HudTrust } from '../ui/hud/law';
import { iaReviewFooter, iaReviewSource } from '../ui/ia';
import { dutyText, formatUntil } from '../ui/mdt/career';
import { EvidenceReviewPanel } from '../ui/review';
import type { UIRoot } from '../ui/ui';
import { DISTRICT_NAMES } from '../world/ids';
import type { GameSession } from './session';

/** Retention pruning of the media store runs at this real-time interval (ms). */
export const PRUNE_INTERVAL_MS = 60_000;
const TAG_KEY = 'patrol.mediaTag';

/** What the presenter needs from the app. */
export interface Phase5Host {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
}

/** Reads `key` from localStorage; null when unavailable (private window, blocked storage). */
function readStorage(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience: the footage then belongs to the tag of this page load only.
  }
}

/** A fresh snapshot namespace (one per new game). */
export function newMediaTag(): string {
  return String(Date.now());
}

export class Phase5Presenter {
  readonly review: EvidenceReviewPanel;
  readonly courtroom: CourtroomPanel;
  readonly media: MediaStore;
  readonly scheduler = new SnapshotScheduler();
  /** Snapshot namespace of the running game. */
  tag = newMediaTag();

  private readonly host: Phase5Host;
  private readonly hudForce: HudForce = { tool: 'none', ammo: '', attached: false, episode: null };
  private readonly hudCam: HudCam = { body: false, muted: false, dash: false, worn: false };
  private readonly hudLegal: HudLegal = { text: '', severity: 'ok' };
  private readonly hudTrust: HudTrust = { district: '', value: 0 };
  private offs: (() => void)[] = [];
  private pendingCourt = '';
  private nextPruneMs = 0;

  constructor(ui: UIRoot, host: Phase5Host) {
    this.host = host;
    this.media = createMediaStore();
    this.review = new EvidenceReviewPanel(ui);
    this.courtroom = new CourtroomPanel(ui, (caseId, answers) => {
      this.host.session()?.court.request({ kind: 'testify', caseId, answers });
    });
  }

  dispose(): void {
    this.end();
    this.review.dispose?.();
    this.courtroom.dispose();
  }

  /** Per-session start: the snapshot namespace of the game and the bus bridges to the panels. */
  begin(session: GameSession, tag: string): void {
    this.end();
    this.tag = tag;
    this.scheduler.immediate();
    this.pendingCourt = '';
    this.nextPruneMs = 0;
    const bus = session.bus;
    this.offs.push(
      // The court asks to open its session (a hearing was attended, or a saved case was in session).
      bus.on('court:session', (e) => {
        this.pendingCourt = e.caseId;
      }),
      // A force application or an arrest is worth a frame at once.
      bus.on('force:applied', () => this.scheduler.immediate()),
      bus.on('force:other', () => this.scheduler.immediate()),
      bus.on('cad:documentSaved', (e) => {
        if (e.kind === 'booking' && e.final) this.scheduler.immediate();
      }),
    );
    // A save loaded with a case in session reopens its courtroom.
    for (const c of session.court.cases()) if (c.status === 'inSession') session.court.request({ kind: 'attend', caseId: c.id });
  }

  /** Session end: panels closed, bridges removed. */
  end(): void {
    for (const off of this.offs) off();
    this.offs = [];
    if (this.review.isOpen) this.review.close();
    if (this.courtroom.isOpen) this.courtroom.close();
    this.pendingCourt = '';
  }

  /** Per frame: opens a requested courtroom, drives the review playback and prunes the media store. */
  updatePanels(session: GameSession, nowMs: number): void {
    if (this.pendingCourt !== '') {
      const c = session.court.case(this.pendingCourt);
      this.pendingCourt = '';
      if (c && c.status === 'inSession' && !this.courtroom.isOpen) {
        if (this.review.isOpen) this.review.close();
        this.courtroom.open(courtroomViewOf(c));
      }
    }
    if (this.review.isOpen) this.review.update(nowMs);
    if (nowMs >= this.nextPruneMs) {
      const first = this.nextPruneMs === 0;
      this.nextPruneMs = nowMs + PRUNE_INTERVAL_MS;
      if (!first) this.media.prune(retentionOf(), this.tag, new Set(session.incidents.keys())).catch((error: unknown) => log.warn('Media prune failed:', error));
    }
  }

  /** Opens the evidence review for an IA case with the statement footer (closed cases are read-only). */
  openIa(caseId: string): void {
    const session = this.host.session();
    if (!session) return;
    const c = session.conduct.iaCase(caseId);
    const incidentLog = c ? session.incidents.log(c.key) : null;
    if (!c || !incidentLog) {
      this.host.flash('The incident record is no longer available');
      return;
    }
    const assessment = session.incidents.assessment(c.key);
    const options = iaStatementOptions(c, incidentLog);
    this.review.open(
      iaReviewSource(incidentLog, c, this.media, this.tag, assessment),
      iaReviewFooter(c, options, (statement) => {
        session.conduct.request({ kind: 'iaStatement', caseId, statement });
        this.review.refreshFooter();
      }),
    );
  }

  /** Right after `renderer.render()` (same task, after the Phase 4 thumbnail): a due 160x90 frame goes to the media store. */
  afterRender(session: GameSession | null, canvas: HTMLCanvasElement | null): void {
    if (!session || !canvas) return;
    const inc = session.incidents;
    const incident = inc.current;
    if (incident === '') return;
    const sim = session.clock.simTime;
    if (!this.scheduler.due(sim, inc.cam.bits, incident)) return;
    // The scheduler is told at once (not in the async callback), so a slow encode never doubles the capture.
    this.scheduler.taken(sim, incident);
    const source = session.driving ? 'dash' : 'body';
    const game = session.env.time.totalSeconds;
    const tag = this.tag;
    captureSnapshot(canvas, RECORDING.width, RECORDING.height, RECORDING.quality)
      .then((blob) => (blob ? this.media.put({ tag, incident, source, sim, game, w: RECORDING.width, h: RECORDING.height }, blob) : undefined))
      .catch((error: unknown) => log.warn('Snapshot store failed:', error));
  }

  /** Force tool, camera chips, legal line, duty, court and trust for the 10 Hz HUD. */
  fillHud(s: HudSnapshot, session: GameSession, nowSim: number): void {
    const f = session.force.hud;
    this.hudForce.tool = f.tool === 'none' ? 'none' : f.label;
    this.hudForce.ammo = f.ammo;
    this.hudForce.attached = f.attached;
    this.hudForce.episode = f.episode;
    s.force = session.driving ? null : this.hudForce;
    const cam = session.incidents.cam;
    this.hudCam.body = cam.body;
    this.hudCam.muted = cam.muted;
    this.hudCam.dash = cam.dash;
    this.hudCam.worn = session.station.loadout.bodycamMount !== 'none';
    s.cam = this.hudCam;
    const legal = session.phase5.legal;
    if (legal.text !== '' && nowSim < legal.untilSim) {
      this.hudLegal.text = legal.text;
      this.hudLegal.severity = legal.severity;
      s.legal = this.hudLegal;
    } else {
      s.legal = null;
    }
    const game = session.env.time.totalSeconds;
    const duty = session.conduct.dutyStatus(game);
    s.duty = duty.status === 'active' ? null : dutyText(duty.status, duty.untilGame);
    const next = session.court.next(game);
    s.court = next ? `COURT ${formatClockTime(next.hearingGame)} · ${next.id} · ${formatUntil(next.hearingGame - game)}` : null;
    const at = session.playerPosition(scratchAt);
    const district = DISTRICT_NAMES[session.city.districtAt(at.x, at.z)] ?? '';
    this.hudTrust.district = district;
    this.hudTrust.value = session.conduct.trust(district);
    s.trust = this.hudTrust;
  }

  /** Reads the media tag stored for a save slot (a fresh one when the slot has none). */
  static tagOfSlot(slot: string): string {
    return readStorage(`${TAG_KEY}.${slot}`) ?? newMediaTag();
  }

  /** The jurisdiction picked on the title screen last time (generic when none). */
  static storedJurisdiction(): string {
    return readStorage('patrol.jurisdiction') ?? 'generic';
  }

  static storeJurisdiction(id: string): void {
    writeStorage('patrol.jurisdiction', id);
  }

  /** Remembers the running game's media tag for a save slot. */
  rememberSlot(slot: string): void {
    writeStorage(`${TAG_KEY}.${slot}`, this.tag);
  }
}

const scratchAt = { x: 0, z: 0 };
