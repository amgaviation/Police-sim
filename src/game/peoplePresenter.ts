import type * as THREE from 'three';
import '../contact/events';
import '../scene/events';
import { PrevTransform, Transform } from '../ecs/components';
import { ACTOR_STATE, type ActorInfo } from '../npc';
import { describePerson } from '../people';
import {
  FIGURE_FLAG,
  HELD,
  POSE,
  PeopleRenderer,
  PropRenderer,
  createHumanoidSource,
  createPropSource,
  type HumanoidSource,
} from '../render/people';
import { stationStaff, uniformColors } from '../station';
import type { SpeechOut } from '../speech/synthesis';
import { voiceProfileFor } from '../speech/profile';
import { DialoguePanel, SfstPanel, SubtitleBar, type DialogueView, type SfstView } from '../ui/dialogue';
import { MARKER, type MinimapMarkers } from '../ui/hud/minimap';
import type { HudContact, HudOfficer } from '../ui/hud/scene';
import type { HudSnapshot } from '../ui/hud/hud';
import type { UIRoot } from '../ui/ui';
import { PLAYER_SIZE, TALK_DISTANCE, type GameSession } from './session';

/** The dialogue view is rebuilt at most this often (ms; 10 Hz). */
export const DIALOGUE_REFRESH_MS = 100;
/** The SFST panel is refreshed every frame it changes, at most this often (ms). */
const SFST_REFRESH_MS = 33;
/** People are drawn out to this distance (m). */
export const PEOPLE_DRAW_DISTANCE = 150;
/** Walking speeds (m/s) at which the officer figure strides and runs. */
/** Fixed steps per second (app.ts SIM_HZ). */
const SIM_HZ = 60;
/** Seconds without a fixed step after which the officer figure stands still. */
const STILL_AFTER_S = 0.1;
const WALK_SPEED = 0.3;
const RUN_SPEED = 4.2;
/** Stride length (m per gait cycle) of the officer figure. */
const STRIDE_M = 1.45;
/** Scene props + investigation props drawn together (markers, evidence, tape). */
const MERGED_PROP_CAPACITY = 1024;
/** Contact chip: nearest person within this distance (m). */
const CHIP_RANGE_M = 8;
/** Roles drawn as suspects (red) on the minimap. */
const SUSPECT_ROLES = new Set(['suspect', 'assailant', 'agitator', 'ambusher', 'subject']);

const OFFICER_SKIN = 0xd9a77c;
const OFFICER_HAIR = 0x2e2118;

/** What the presenter needs from the app. */
export interface PresenterHost {
  session(): GameSession | null;
  /** One-off HUD line. */
  flash(text: string): void;
  /** Opens an MDT form for a person (citation or report). */
  openForm(kind: 'citation' | 'report', personId: number, vehicleId: number, callId: number): void;
}

/** The subtitle line for an officer or subject line. */
export interface SubtitleLine {
  speaker: string;
  text: string;
}

/**
 * Presentation of the people layer (Phase 3 §12, §20.3): the instanced figures and props, the officer's own
 * figure, the dialogue and SFST panels, subtitles and spoken lines, and the HUD and minimap additions. It
 * never changes the simulation except through the contact manager's request queue.
 */
export class PeoplePresenter {
  readonly renderer: PeopleRenderer | null;
  readonly props: PropRenderer | null;
  readonly dialogue: DialoguePanel;
  readonly sfst: SfstPanel;
  readonly subtitles: SubtitleBar;
  /** Last subtitle shown (tests, console). */
  lastSubtitle: SubtitleLine | null = null;

  private readonly host: PresenterHost;
  private readonly speech: SpeechOut;
  private readonly officerFigure = createHumanoidSource(1);
  private readonly staff = createHumanoidSource(8);
  private readonly mergedProps = createPropSource(MERGED_PROP_CAPACITY);
  private readonly sources: HumanoidSource[] = [createHumanoidSource(0), this.officerFigure, createHumanoidSource(0), createHumanoidSource(0), this.staff];
  /** The camera is at the officer's eyes: the officer's own figure is hidden. */
  private firstPerson = false;
  private readonly offs: (() => void)[] = [];
  private session: GameSession | null = null;
  private lastRevision = -1;
  private nextDialogueMs = 0;
  private nextSfstMs = 0;
  /** Contact whose panel the user closed: not reopened until another contact is active. */
  private dismissedContact = -1;
  private dismissedSfst = false;
  private chipTitle = '';
  private gait = 0;
  private lastSim = NaN;
  private stillS = 0;
  private subtitlesOn = true;
  private readonly hudOfficer: HudOfficer = { weapon: 'none' };
  private readonly hudContact: HudContact = { name: '', state: '', distanceM: -1 };
  private readonly pick = { kind: 'ped' as 'actor' | 'ped' | 'occupant', id: 0, seat: -1, personId: -1, distance: 0 };
  private readonly actorIds: number[] = [];
  private readonly fleeOut = { x: 0, z: 0, yaw: 0, speed: 0, edge: 0 };

  constructor(scene: THREE.Scene | null, ui: UIRoot, speech: SpeechOut, host: PresenterHost, shadows: boolean) {
    this.host = host;
    this.speech = speech;
    this.renderer = scene ? new PeopleRenderer(scene, { capacity: 320, shadows }) : null;
    this.props = scene ? new PropRenderer(scene) : null;
    this.dialogue = new DialoguePanel(ui);
    this.sfst = new SfstPanel(ui);
    this.subtitles = new SubtitleBar(ui.hud);
  }

  setSubtitles(on: boolean): void {
    this.subtitlesOn = on;
    this.subtitles.setVisible(on);
  }

  setShadows(on: boolean): void {
    this.renderer?.setShadows(on);
  }

  /** Per-session subscriptions (subtitles, speech, forms). */
  begin(session: GameSession): void {
    this.end();
    this.session = session;
    this.lastRevision = -1;
    this.dismissedContact = -1;
    this.dismissedSfst = false;
    this.staff.count = 0;
    for (const id of session.interiors.resident) this.onResident(session, id, true);
    const bus = session.bus;
    this.offs.push(
      bus.on('contact:line', (e) => {
        if (e.speaker === 'system') return;
        const s = this.session;
        if (!s) return;
        const speaker = e.speaker === 'officer' ? s.officer.name : e.label === '' ? 'Subject' : e.label;
        this.say(speaker, e.text, e.speaker === 'subject' && e.language === 'en' ? e.personId : -1);
      }),
      bus.on('scene:line', (e) => {
        const s = this.session;
        const speaker = e.personId < 0 && s ? s.officer.name : e.speaker;
        this.say(speaker, e.text, e.personId >= 0 && e.language === 'en' ? e.personId : -1);
      }),
      bus.on('scene:flash', (e) => this.host.flash(e.text)),
      bus.on('interior:resident', (e) => this.onResident(session, e.buildingId, e.loaded)),
      bus.on('tactical:partner', (e) => this.say('Partner', e.text, -1)),
      bus.on('contact:openForm', (e) => this.host.openForm(e.kind, e.personId, e.vehicleId, e.callId)),
      bus.on('scene:openForm', (e) => this.host.openForm(e.kind, e.personId, e.vehicleId, e.callId)),
    );
  }

  end(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.dialogue.close();
    this.sfst.close();
    this.subtitles.clear();
    this.session = null;
    this.lastSubtitle = null;
    this.speech.cancel();
  }

  dispose(): void {
    this.end();
    this.dialogue.dispose();
    this.sfst.dispose();
    this.subtitles.dispose();
    this.renderer?.dispose();
    this.props?.dispose();
  }

  /** Per frame: opens, refreshes and closes the dialogue and SFST panels, and times the subtitle out. */
  updateMenus(nowMs: number): void {
    const session = this.session;
    if (!session) return;
    this.subtitles.update(nowMs);
    this.updateDialogue(session, nowMs);
    this.updateSfst(session, nowMs);
  }

  /** Per frame: the people (npc view and the officer) and the scene props. */
  render(session: GameSession, alpha: number, camX: number, camZ: number, nightFactor: number, dt: number): void {
    const r = this.renderer;
    this.fillOfficer(session, dt);
    this.sources[0] = session.npc.view;
    this.sources[2] = session.tactical.partner.view;
    this.sources[3] = session.investigation.dog;
    r?.update(alpha, this.sources, camX, camZ, PEOPLE_DRAW_DISTANCE);
    this.props?.update(this.mergeProps(session), nightFactor);
  }

  /** First-person camera: the officer's own figure is not drawn. */
  setFirstPerson(on: boolean): void {
    this.firstPerson = on;
  }

  /** Scene props followed by the investigation props (markers, evidence, tape) in one source. */
  private mergeProps(session: GameSession): typeof this.mergedProps {
    const m = this.mergedProps;
    let n = 0;
    for (const src of [session.scene.props, session.investigation.props]) {
      const count = Math.min(src.count, m.x.length - n);
      for (let i = 0; i < count; i++, n++) {
        m.x[n] = src.x[i] ?? 0;
        m.y[n] = src.y[i] ?? 0;
        m.z[n] = src.z[i] ?? 0;
        m.yaw[n] = src.yaw[i] ?? 0;
        m.kind[n] = src.kind[i] ?? 0;
      }
    }
    m.count = n;
    return m;
  }

  /** The station's interior became resident (or left): its staff figures stand at their desks. */
  private onResident(session: GameSession, buildingId: number, loaded: boolean): void {
    const st = session.buildings.station();
    if (!st || st.id !== buildingId) return;
    this.staff.count = 0;
    if (!loaded) return;
    const layout = session.interiors.layout(buildingId);
    if (layout) stationStaff(layout, this.staff);
  }

  /** Draw calls of the people and prop meshes, and the figures drawn (perf overlay). */
  get stats(): { figures: number; drawCalls: number; props: number } {
    return {
      figures: this.renderer?.stats.figures ?? 0,
      drawCalls: (this.renderer?.stats.drawCalls ?? 0) + (this.props?.stats.drawCalls ?? 0),
      props: this.props?.stats.props ?? 0,
    };
  }

  /** HUD additions at the HUD rate: weapon chip, contact chip, scene objectives, pursuit line. */
  fillHud(s: HudSnapshot, session: GameSession): void {
    this.hudOfficer.weapon = session.scene.officerWeapon;
    s.officer = this.hudOfficer;
    const hud = session.scene.hud();
    s.scene = hud.scene;
    s.pursuit = hud.pursuit;
    s.contact = this.contactChip(session);
  }

  /** Appends the people markers (scene actors, fleeing cars) after the police markers; returns the new count. */
  fillMarkers(m: MinimapMarkers, session: GameSession): MinimapMarkers {
    const cap = m.x.length;
    let n = m.count;
    const ids = session.npc.actorIds(this.actorIds);
    const info = this.infoScratch;
    for (let i = 0; i < ids.length && n < cap; i++) {
      const a = session.npc.actor(ids[i] as number, info);
      if (!a || a.hidden || a.callId === 0) continue;
      m.x[n] = a.x;
      m.z[n] = a.z;
      m.kind[n] = a.state === ACTOR_STATE.flee ? MARKER.pursuit : SUSPECT_ROLES.has(a.role) ? MARKER.suspect : MARKER.person;
      n++;
    }
    const traffic = session.traffic;
    if (traffic.fleeingCount > 0) {
      const view = traffic.view;
      for (let i = 0; i < view.count && n < cap; i++) {
        const vehicleId = view.vehicleId[i] ?? 0;
        if (!traffic.fleeState(vehicleId, this.fleeOut)) continue;
        m.x[n] = this.fleeOut.x;
        m.z[n] = this.fleeOut.z;
        m.kind[n] = MARKER.pursuit;
        n++;
      }
    }
    m.count = n;
    return m;
  }

  private readonly infoScratch: ActorInfo = {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
    following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };

  // --- Dialogue and SFST ------------------------------------------------------------------

  private updateDialogue(session: GameSession, nowMs: number): void {
    const contact = session.contact;
    const active = contact.active;
    if (active < 0) {
      this.dismissedContact = -1;
      this.chipTitle = '';
      if (this.dialogue.isOpen) this.dialogue.close();
      this.lastRevision = -1;
      return;
    }
    if (active === this.dismissedContact) return;
    const rev = contact.revision;
    if (this.dialogue.isOpen) {
      if (rev === this.lastRevision || nowMs < this.nextDialogueMs) return;
      this.lastRevision = rev;
      this.nextDialogueMs = nowMs + DIALOGUE_REFRESH_MS;
      const view = contact.view(active);
      if (view) {
        this.chipTitle = view.title;
        this.dialogue.update(view);
      } else {
        this.dialogue.close();
      }
      return;
    }
    const view = contact.view(active);
    if (!view) return;
    this.chipTitle = view.title;
    this.lastRevision = rev;
    this.nextDialogueMs = nowMs + DIALOGUE_REFRESH_MS;
    this.dialogue.open(view, this.handlersFor(session, view));
  }

  private handlersFor(session: GameSession, view: DialogueView): Parameters<DialoguePanel['open']>[1] {
    const contact = session.contact;
    const id = view.contactId;
    return {
      say: (utteranceId, tone) => contact.request({ kind: 'say', contactId: id, utteranceId, tone }),
      action: (action) => contact.request({ kind: 'action', contactId: id, action: action as never }),
      commMode: (mode) => contact.request({ kind: 'commMode', contactId: id, mode }),
      close: () => {
        this.dismissedContact = id;
        contact.request({ kind: 'dismiss', contactId: id });
      },
    };
  }

  private updateSfst(session: GameSession, nowMs: number): void {
    const contact = session.contact;
    const open = this.sfst.isOpen;
    if (!open && this.dismissedSfst && contact.sfstView() === null) this.dismissedSfst = false;
    if (open && nowMs < this.nextSfstMs) return;
    this.nextSfstMs = nowMs + SFST_REFRESH_MS;
    const view: SfstView | null = contact.sfstView();
    if (!view) {
      this.dismissedSfst = false;
      if (open) this.sfst.close();
      return;
    }
    if (open) {
      this.sfst.update(view);
    } else if (!this.dismissedSfst) {
      this.sfst.open(view, {
        key: (key) => contact.request({ kind: 'sfstKey', key: key }),
        close: () => {
          this.dismissedSfst = true;
          contact.request({ kind: 'sfstAbort' });
        },
      });
    }
  }

  // --- Subtitles and speech -----------------------------------------------------------------

  private say(speaker: string, text: string, speakPersonId: number): void {
    this.lastSubtitle = { speaker, text };
    if (this.subtitlesOn) this.subtitles.show(speaker, text, performance.now());
    if (speakPersonId >= 0) this.speech.speak(text, voiceProfileFor(`npc:${String(speakPersonId)}`, 'officer'));
  }

  // --- HUD helpers -----------------------------------------------------------------------------

  private contactChip(session: GameSession): HudContact | null {
    const contact = session.contact;
    const chip = this.hudContact;
    if (contact.active >= 0 && this.chipTitle !== '') {
      const actorId = session.npc.actorOfPerson(contact.personOf(contact.active));
      const a = actorId > 0 ? session.npc.actor(actorId, this.infoScratch) : null;
      chip.name = this.chipTitle;
      chip.state = a?.cuffed ? 'cuffed' : 'talking';
      const at = session.playerPosition({ x: 0, z: 0 });
      chip.distanceM = a ? Math.hypot(a.x - at.x, a.z - at.z) : -1;
      return chip;
    }
    if (session.driving) return null;
    const f = session.playerPosition({ x: 0, z: 0 });
    const pick = session.npc.nearestPerson(f.x, f.z, session.controller.yaw, CHIP_RANGE_M, 0.5, this.pick);
    if (!pick || pick.personId < 0) return null;
    const d = describePerson(session.people.identity(pick.personId));
    chip.name = `${d.ageBand} ${d.sex}`;
    chip.state = pick.distance <= TALK_DISTANCE ? 'E to talk' : '';
    chip.distanceM = pick.distance;
    return chip;
  }

  // --- The officer's own figure -------------------------------------------------------------

  private fillOfficer(session: GameSession, dt: number): void {
    const f = this.officerFigure;
    const eid = session.player;
    if (session.driving || eid === 0) {
      f.count = 1;
      f.flags[0] = FIGURE_FLAG.hidden;
      return;
    }
    f.count = 1;
    const x = Transform.x[eid] ?? 0;
    const z = Transform.z[eid] ?? 0;
    const feet = PLAYER_SIZE.y / 2;
    f.x[0] = x;
    f.y[0] = (Transform.y[eid] ?? feet) - feet;
    f.z[0] = z;
    f.prevX[0] = PrevTransform.x[eid] ?? x;
    f.prevY[0] = (PrevTransform.y[eid] ?? feet) - feet;
    f.prevZ[0] = PrevTransform.z[eid] ?? z;
    const yaw = session.controller.yaw;
    f.yaw[0] = yaw;
    f.prevYaw[0] = yaw;
    f.anchor[0] = 0;
    // Speed of the last fixed step: stable between steps, whatever the display rate (render-frame deltas flicker).
    // Without a new step for a moment (paused) the officer stands.
    const sim = session.clock.simTime;
    if (sim === this.lastSim) this.stillS += dt;
    else this.stillS = 0;
    this.lastSim = sim;
    const speed = this.stillS > STILL_AFTER_S ? 0 : Math.hypot(x - (PrevTransform.x[eid] ?? x), z - (PrevTransform.z[eid] ?? z)) * SIM_HZ;
    f.speed[0] = speed;
    this.gait += (speed * dt) / STRIDE_M;
    if (this.gait > 1e4) this.gait -= 1e4;
    f.gait[0] = this.gait;
    const weapon = session.scene.officerWeapon;
    f.held[0] = weapon === 'sidearm' ? HELD.sidearm : weapon === 'taser' ? HELD.taser : HELD.none;
    f.pose[0] = weapon !== 'none' ? POSE.aim : session.tactical.stance.crouched ? POSE.crouch : speed > RUN_SPEED ? POSE.run : speed > WALK_SPEED ? POSE.walk : POSE.stand;
    f.height[0] = 1.78;
    f.build[0] = 1;
    f.skin[0] = OFFICER_SKIN;
    f.hair[0] = OFFICER_HAIR;
    const colors = uniformColors(session.station.loadout);
    f.top[0] = colors.top;
    f.bottom[0] = colors.bottom;
    f.body[0] = 0;
    f.flags[0] = this.firstPerson ? FIGURE_FLAG.hidden : 0;
  }
}
