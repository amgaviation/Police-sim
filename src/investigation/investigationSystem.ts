/**
 * Investigation runtime (design phase 4 §10): evidence markers, photos, plain view and container searches,
 * the chain-of-custody ledger, fingerprint dusting, scene tape, bodycam, neighbourhood canvass and the K9 sweep.
 * UI input arrives as queued requests applied at the start of `step` (order -675); everything random draws from
 * the 'investigation' stream or pure hashes. The rules live in `src/evidence`; this class owns the state.
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import {
  CaseStore,
  CustodyLedger,
  EVIDENCE_DATA,
  MAX_MARKERS,
  brush,
  canvassResult,
  canvassText,
  k9Sweep,
  lawfulPresence,
  lift,
  moveCursor,
  plainView,
  sawChanceFor,
  searchAuthority,
  startDust,
  type CaseFile,
  type ConsentRecord,
  type CustodyAction,
  type EvidenceItem,
  type K9Alert,
  type K9Target,
  type SearchBasis,
  type SearchContext,
  type StatementRecord,
} from '../evidence';
import { levelY } from '../interior/constants';
import { reachableRooms, roomAt } from '../interior/nav';
import type { FurnitureItem, InteriorLayout } from '../interior/types';
import { unitHash } from '../records/hash';
import { BODY, POSE, createHumanoidSource, createPropSource, type HumanoidSource, type PropSource } from '../render/people/pose';
import type { ForceUsedEvent } from '../scene/events';
import type { ActionPanelModel, PanelOption } from '../ui/panels/actionPanel';
import { buildCaseView, type CaseFileView } from './caseView';
import './events';
import { K9_HANDLER_LAG_S, k9Duration, k9Route, k9Sample, scentOf, type K9Route } from './k9run';
import { PROP_CAPACITY, buildProps } from './props';
import {
  MAX_QUEUE,
  emptyInvestigationSave,
  type InvestigationSave,
  type SavedDust,
  type SavedK9,
  type SavedTape,
} from './save';
import { MAX_TAPE_POSTS, MIN_CLOSED_POSTS, MIN_POST_GAP, tapeZone } from './tape';
import {
  PHOTO_FOV_DEFAULT,
  PHOTO_FOV_MAX,
  PHOTO_FOV_MIN,
  type CallContext,
  type CaseSummary,
  type DustView,
  type InvestigationOfficer,
  type InvestigationPorts,
  type InvestigationRequest,
  type NoGoZone,
  type PlaceItemSpec,
  type ToolAction,
} from './types';

/** Seconds between plain-view scans. */
export const SCAN_INTERVAL_S = 0.5;
/** Plain-view scan radius (m). */
export const SCAN_RANGE_M = 10;
/** Photo subject range (m). */
export const PHOTO_RANGE_M = 15;
/** Reach for collecting, searching and dusting (m). */
export const REACH_M = 1.5;
/** A marker is set this far ahead of the officer (m), and snaps to a found item this close to that spot (m). */
export const MARKER_AHEAD_M = 2;
export const MARKER_SNAP_M = 1;
/** Flashlight lighting an item: range (m) and half-angle (rad). */
export const FLASHLIGHT_RANGE_M = 8;
export const FLASHLIGHT_CONE_RAD = 0.5;
/** Eye height above the officer's feet (m). */
export const EYE_HEIGHT_M = 1.6;
/** Canvass: how close to the door (m) and how far from the call's anchor (m). */
export const CANVASS_DOOR_M = 1.8;
export const CANVASS_CALL_M = 150;
/** Dusting is dropped when the officer walks this far from the surface (m). */
export const DUST_ABANDON_M = 4;
/** Longest brush stroke one request may apply (s). */
export const MAX_BRUSH_S = 0.25;
/** Entries kept per case file. */
export const MAX_CONSENTS = 32;
export const MAX_STATEMENTS = 32;
export const MAX_BODYCAM_SEGMENTS = 32;
/** Arrests remembered across all calls. */
export const MAX_ARRESTS = 64;
/** Closed tapes kept. */
export const MAX_TAPES = 8;
/** Photo thumbnails waiting for the presentation. */
const MAX_PENDING_THUMBS = 4;

const HASH_PRINT = 0x9f31;
const HASH_K9 = 0x6b39;
const COS_FLASHLIGHT = Math.cos(FLASHLIGHT_CONE_RAD);
const SCAN_RANGE2 = SCAN_RANGE_M * SCAN_RANGE_M;
const FLASH_RANGE2 = FLASHLIGHT_RANGE_M * FLASHLIGHT_RANGE_M;
const EMPTY_CONSENTS: readonly ConsentRecord[] = [];
const FIELD_CASE = 0;

const BASIS_TEXT: Readonly<Record<SearchBasis, string>> = {
  plainView: 'plain view',
  consent: 'consent',
  warrant: 'warrant',
  incidentToArrest: 'incident to arrest',
  exigency: 'exigency',
  protectiveSweep: 'protective sweep',
  publicArea: 'public area',
};

/** Constructor dependencies. `officer` fills and returns the officer record (allocation-free). */
export interface InvestigationDeps {
  seed: number;
  bus: EventBus<EventMap>;
  /** The 'investigation' stream. */
  rng: Rng;
  ports: InvestigationPorts;
  officer: (out: InvestigationOfficer) => InvestigationOfficer;
}

interface MutablePresence {
  buildingId: number;
  room: number;
  roomPublic: boolean;
  businessOpen: boolean;
  consents: readonly ConsentRecord[];
  exigency: boolean;
  warrant: boolean;
  sim: number;
}

interface ToolRow {
  readonly option: PanelOption;
  readonly action: ToolAction;
}

const NONE: ToolAction = { kind: 'none' };

/** 'kitchenCounter' -> 'kitchen counter'. */
function furnitureName(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Distance from (x, z) to the furniture's footprint (0 inside). */
function furnitureDistance(f: FurnitureItem, x: number, z: number): number {
  const dx = x < f.minX ? f.minX - x : x > f.maxX ? x - f.maxX : 0;
  const dz = z < f.minZ ? f.minZ - z : z > f.maxZ ? z - f.maxZ : 0;
  return Math.hypot(dx, dz);
}

function itemNumber(itemId: string): string {
  return itemId.slice(itemId.lastIndexOf('-') + 1);
}

/** Feet height of an item: interior values that look floor-relative get the level floor added. */
function worldY(building: number, y: number): number {
  return building >= 0 && y > -20 ? y + levelY(building) : y;
}

export class InvestigationSystem {
  /** Markers, items lying in place and scene tape for the officer's level; refilled in place. */
  readonly props: PropSource;
  /** The K9 dog (figure 0) and handler (figure 1) while a sweep runs. */
  readonly dog: HumanoidSource;

  private readonly seed: number;
  private readonly bus: EventBus<EventMap>;
  private readonly rng: Rng;
  private readonly ports: InvestigationPorts;
  private readonly officerFn: (out: InvestigationOfficer) => InvestigationOfficer;
  private readonly propBuf = createPropSource(PROP_CAPACITY);
  private readonly dogBuf = createHumanoidSource(2);
  private readonly off: InvestigationOfficer = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, building: -1, room: -1, onFoot: true, badge: '', flashlight: false,
  };
  private readonly offForce = (e: ForceUsedEvent): void => this.onForce(e);
  private readonly unsubForce: () => void;

  private caseStore = new CaseStore();
  private custody = new CustodyLedger();
  private queue: InvestigationRequest[] = [];
  private tapes: SavedTape[] = [];
  private activeTape = -1;
  private held: string[] = [];
  private dustSt: SavedDust | null = null;
  private dustV: DustView | null = null;
  private dustX = 0;
  private dustZ = 0;
  private k9: SavedK9 | null = null;
  private k9Building = -1;
  private k9Path: K9Route | null = null;
  private arrests: [number, number, number, number, number][] = [];
  private scanTimer = 0;
  private camOn = false;
  private camCall = FIELD_CASE;
  private rev = 1;
  private lastSim = 0;
  private thumbs: string[] = [];

  /** Evidence items that are not collected yet (rebuilt when `liveDirty`). */
  private live: EvidenceItem[] = [];
  private liveDirty = true;
  private propsDirty = true;
  private propsLevel = -2;
  private zones: NoGoZone[] = [];

  private readonly presence: MutablePresence = {
    buildingId: -1, room: -1, roomPublic: false, businessOpen: false, consents: EMPTY_CONSENTS, exigency: false, warrant: false, sim: 0,
  };
  private presenceSig = Number.NaN;
  private presenceLawful = false;
  private readonly sample = new Float64Array(3);
  private readonly sampleBack = new Float64Array(3);
  private readonly roomScratch: number[] = [];
  private dogYaw = 0;
  private dogGait = 0;

  private hudRev = -1;
  private hudCall = -1;
  private hudRec = false;
  private hudText: string | null = null;
  private viewCall = Number.NaN;
  private viewRev = -1;
  private viewCache: CaseFileView | null = null;

  constructor(deps: InvestigationDeps) {
    this.seed = deps.seed;
    this.bus = deps.bus;
    this.rng = deps.rng;
    this.ports = deps.ports;
    this.officerFn = deps.officer;
    this.props = this.propBuf;
    this.dog = this.dogBuf;
    this.unsubForce = this.bus.on('force:used', this.offForce);
    this.initDog();
  }

  // --- Public state ----------------------------------------------------------------------------

  /** Case files (items, markers, photos, prints, canvass, consents, statements). Replaced by `restore`. */
  get store(): CaseStore {
    return this.caseStore;
  }

  /** The hash-chained chain-of-custody ledger. Replaced by `restore`. */
  get ledger(): CustodyLedger {
    return this.custody;
  }

  get bodycamOn(): boolean {
    return this.camOn;
  }

  /** The fingerprint minigame, null when none is running. Updated in place. */
  get dust(): DustView | null {
    return this.dustV;
  }

  /** Increments on every change a panel could show. */
  get revision(): number {
    return this.rev;
  }

  // --- Input -----------------------------------------------------------------------------------

  /** Queues a request; it is applied at the start of the next `step`. */
  request(r: InvestigationRequest): void {
    this.queue.push(r);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  /** Scene hook (synchronous, inside its fixed step): puts an item in place and returns its id. */
  placeItem(spec: PlaceItemSpec): string {
    const file = this.fileOf(spec.callId);
    const item = this.caseStore.addItem(spec.callId, {
      item: spec.item,
      label: spec.label,
      x: spec.x,
      y: worldY(spec.buildingId, spec.y),
      z: spec.z,
      buildingId: spec.buildingId,
      room: spec.room,
      furniture: spec.furniture,
      container: spec.container,
      concealed: spec.concealed,
      ownerPersonId: spec.ownerPersonId,
      incriminating: spec.incriminating,
    });
    this.dirtyItems();
    // A full file drops its oldest item; markers must not point at it.
    for (const m of file.markers) {
      if (m.itemId !== null && this.caseStore.item(m.itemId) === null) m.itemId = null;
    }
    return item.id;
  }

  /** Removes the in-place (not yet found) items of a dropped scenario. */
  removeCallItems(callId: number): void {
    const file = this.caseStore.get(callId);
    if (!file) return;
    const before = file.items.length;
    file.items = file.items.filter((i) => i.state !== 'inPlace');
    if (file.items.length === before) return;
    for (const m of file.markers) {
      if (m.itemId !== null && !file.items.some((i) => i.id === m.itemId)) m.itemId = null;
    }
    this.dirtyItems();
  }

  /** Bridged from `contact:consent`. */
  recordConsent(c: Omit<ConsentRecord, 'id'> & { callId: number }): void {
    const { callId, ...rest } = c;
    const file = this.fileOf(callId);
    let id = 0;
    for (const x of file.consents) id = Math.max(id, x.id);
    file.consents.push({ ...rest, id: id + 1 });
    if (file.consents.length > MAX_CONSENTS) file.consents.splice(0, file.consents.length - MAX_CONSENTS);
    this.presenceSig = Number.NaN;
    this.touch();
  }

  /** Bridged from `contact:event` flag 'statement'. */
  recordStatement(callId: number, s: StatementRecord): void {
    const file = this.fileOf(callId);
    file.statements.push({ personId: s.personId, role: s.role, text: s.text, sim: s.sim });
    if (file.statements.length > MAX_STATEMENTS) file.statements.splice(0, file.statements.length - MAX_STATEMENTS);
    this.touch();
  }

  /** Bridged from `contact:event` flag 'custody': an arrest on a call (feeds search incident to arrest). */
  recordArrest(callId: number, personId: number, buildingId: number, room: number, sim: number): void {
    this.arrests.push([callId, personId, buildingId, room, sim]);
    if (this.arrests.length > MAX_ARRESTS) this.arrests.shift();
  }

  // --- Step ------------------------------------------------------------------------------------

  /** Fixed step (order -675): requests, bodycam, dusting guard, plain-view scan, K9, props. */
  step(dt: number, t: { sim: number; game: number }): void {
    this.lastSim = t.sim;
    const o = this.readOfficer();
    if (this.queue.length > 0) {
      const pending = this.queue;
      this.queue = [];
      for (const r of pending) this.apply(r, t);
    }
    if (this.camOn) this.stepBodycam(t);
    if (this.dustSt !== null) this.stepDust(o);
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = SCAN_INTERVAL_S;
      this.scan(o, t);
    }
    if (this.k9 !== null) this.stepK9(dt, t);
    if (this.propsDirty || o.building !== this.propsLevel) this.refreshProps(o.building);
  }

  // --- Queries ---------------------------------------------------------------------------------

  /** A shutter press waiting for its thumbnail (presentation captures the canvas after the next render). */
  pendingThumbnail(): string | null {
    return this.thumbs[0] ?? null;
  }

  /** Presentation only: stores the captured thumbnail (null when capture failed) and clears the pending press. */
  attachThumbnail(photoId: string, dataUrl: string | null): void {
    const i = this.thumbs.indexOf(photoId);
    if (i >= 0) this.thumbs.splice(i, 1);
    for (const f of this.caseStore.files()) {
      const p = f.photos.find((x) => x.id === photoId);
      if (p) {
        p.thumb = dataUrl;
        this.caseStore.trim();
        this.touch();
        return;
      }
    }
  }

  /**
   * Nearest uncollected item within `maxDist` on the level: found items first, else an item lying open in place
   * (not concealed). Check `state` before offering "Collect".
   */
  nearestItem(x: number, z: number, building: number, maxDist: number): EvidenceItem | null {
    if (this.liveDirty) this.refreshLive();
    const r2 = maxDist * maxDist;
    let best: EvidenceItem | null = null;
    let bestScore = Infinity;
    for (const it of this.live) {
      if (it.buildingId !== building) continue;
      if (it.state === 'inPlace' && it.concealed) continue;
      const dx = it.x - x;
      const dz = it.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const score = d2 + (it.state === 'found' ? 0 : 1e6);
      if (score < bestScore) {
        bestScore = score;
        best = it;
      }
    }
    return best;
  }

  /** Furniture with a container or printable surface within 1.5 m ahead (60 degrees), -1 none. */
  nearestFurniture(x: number, z: number, yaw: number, building: number, want: 'container' | 'surface'): number {
    if (building < 0) return -1;
    const layout = this.ports.layout(building);
    if (!layout) return -1;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let best = -1;
    let bestD = Infinity;
    const items = layout.furniture;
    for (let i = 0; i < items.length; i++) {
      const f = items[i] as FurnitureItem;
      if (want === 'container' ? f.container === 'none' : f.surface === null) continue;
      const nx = x < f.minX ? f.minX : x > f.maxX ? f.maxX : x;
      const nz = z < f.minZ ? f.minZ : z > f.maxZ ? f.maxZ : z;
      const dx = nx - x;
      const dz = nz - z;
      const d = Math.hypot(dx, dz);
      if (d > REACH_M || (d > 0.05 && (dx * fx + dz * fz) / d < 0.5) || d >= bestD) continue;
      bestD = d;
      best = i;
    }
    return best;
  }

  /** Markers within `maxDist` of (x, z) on the level, written into `out` (objects are reused); returns the count. */
  nearbyMarkers(x: number, z: number, building: number, maxDist: number, out: { no: number; x: number; y: number; z: number }[]): number {
    let n = 0;
    const r2 = maxDist * maxDist;
    for (const f of this.caseStore.files()) {
      for (const m of f.markers) {
        if (m.buildingId !== building) continue;
        const dx = m.x - x;
        const dz = m.z - z;
        if (dx * dx + dz * dz > r2) continue;
        const slot = out[n];
        if (slot) {
          slot.no = m.no;
          slot.x = m.x;
          slot.y = m.y;
          slot.z = m.z;
        } else {
          out[n] = { no: m.no, x: m.x, y: m.y, z: m.z };
        }
        n++;
      }
    }
    return n;
  }

  caseView(callId: number): CaseFileView | null {
    const file = this.caseStore.get(callId);
    if (!file) return null;
    if (this.viewCache && this.viewCall === callId && this.viewRev === this.rev) return this.viewCache;
    this.viewCache = buildCaseView(file, this.custody, (id) => this.ports.describePerson(id));
    this.viewCall = callId;
    this.viewRev = this.rev;
    return this.viewCache;
  }

  /** HUD case line: 'C-00042 · items 3/5 · markers 2 · photos 4 · REC', null when there is nothing to show. */
  hud(): string | null {
    const call = this.ports.currentCall();
    if (this.hudRev === this.rev && this.hudCall === call && this.hudRec === this.camOn) return this.hudText;
    this.hudRev = this.rev;
    this.hudCall = call;
    this.hudRec = this.camOn;
    const file = this.caseStore.get(call);
    let text: string | null = null;
    if (file && (call !== FIELD_CASE || file.items.length + file.markers.length + file.photos.length > 0)) {
      let found = 0;
      for (const i of file.items) if (i.state !== 'inPlace') found++;
      text =
        `${file.incident === '' ? 'Field case' : file.incident} · items ${String(found)}/${String(file.items.length)}` +
        ` · markers ${String(file.markers.length)} · photos ${String(file.photos.length)}`;
    } else if (call !== FIELD_CASE) {
      text = `${this.ports.incidentOf(call)} · items 0/0 · markers 0 · photos 0`;
    }
    if (this.camOn) text = text === null ? 'REC' : `${text} · REC`;
    this.hudText = text;
    return text;
  }

  /** Counts for `CallOutcome.case`. */
  summary(callId: number): CaseSummary {
    const file = this.caseStore.get(callId);
    const s: CaseSummary = {
      items: 0, found: 0, plainView: 0, suppressed: 0, collected: 0, custodyComplete: false,
      photos: 0, markers: 0, prints: 0, canvass: 0, consents: 0, bodycam: false,
    };
    if (!file) return s;
    let allComplete = true;
    for (const i of file.items) {
      s.items++;
      if (i.state !== 'inPlace') s.found++;
      if (i.plainView) s.plainView++;
      if (i.suppressed) s.suppressed++;
      if (i.state === 'collected') {
        s.collected++;
        if (!this.custody.complete(i.id)) allComplete = false;
      }
    }
    s.custodyComplete = s.collected > 0 && allComplete;
    s.photos = file.photos.length;
    s.markers = file.markers.length;
    s.prints = file.prints.length;
    s.canvass = file.canvass.length;
    s.consents = file.consents.length;
    s.bodycam = file.bodycam.length > 0;
    return s;
  }

  // --- K9 --------------------------------------------------------------------------------------

  /** K9 arrived on a call (bridged from `scene:service { kind: 'k9', phase: 'arrived' }`): starts the sweep now. */
  startK9(callId: number): void {
    if (this.k9 !== null) {
      this.flash(callId, 'The K9 unit is already searching.');
      return;
    }
    const o = this.readOfficer();
    const call = this.ports.callContext(callId);
    const building = call !== null ? call.buildingId : -1;
    const layout = building >= 0 ? this.ports.layout(building) : null;
    const file = this.fileOf(callId);

    let order: number[];
    if (layout !== null) {
      const door = layout.doors.find((d) => d.main);
      const entry = door ? door.a : 0;
      order = reachableRooms(layout, entry, () => true, this.roomScratch).slice();
    } else {
      order = [-1];
    }

    const targets: K9Target[] = [];
    const hidden: { actorId: number; x: number; z: number }[] = [];
    for (let i = 0; i < 16; i++) hidden.push({ actorId: 0, x: 0, z: 0 });
    const n = Math.min(16, Math.max(0, this.ports.hiddenActors(building, hidden)));
    for (let i = 0; i < n; i++) {
      const h = hidden[i] as { actorId: number; x: number; z: number };
      targets.push({
        kind: 'person',
        ref: String(h.actorId),
        room: layout !== null ? roomAt(layout, h.x, h.z) : -1,
        x: h.x,
        z: h.z,
        scent: 'person',
      });
    }
    for (const it of file.items) {
      if (it.state !== 'inPlace' || !it.concealed || it.buildingId !== building) continue;
      targets.push({ kind: 'item', ref: it.id, room: layout !== null ? it.room : -1, x: it.x, z: it.z, scent: scentOf(it.item) });
    }
    const alerts = k9Sweep(order, targets, (i) => unitHash(this.seed, HASH_K9, callId * 64 + i));
    this.k9 = { callId, startedSim: this.lastSim, alerts, fired: 0, order };
    this.k9Building = building;
    this.k9Path = this.routeFor(this.k9, call, layout, o);
    file.k9.push({ sim: this.lastSim, text: 'K9 unit arrived and started a sweep.' });
    this.dogGait = 0;
    this.placeDog(0, true);
    this.dogBuf.count = 2;
    this.flash(callId, 'K9 unit is searching.');
    this.touch();
  }

  // --- Tools panel -----------------------------------------------------------------------------

  /** Rows of the investigation tools panel (`ActionPanel`); recompute while it is open. */
  toolsModel(): ActionPanelModel {
    const rows = this.toolRows();
    const call = this.ports.currentCall();
    return {
      title: 'Investigation',
      subtitle: this.hud() ?? (call === FIELD_CASE ? 'Field case' : this.ports.incidentOf(call)),
      options: rows.map((r) => r.option),
      footer: '1-9 select · ↑↓ Enter · Esc close',
    };
  }

  /** The action of row `index` (none when the row is disabled). The caller performs it. */
  toolsSelect(index: number): ToolAction {
    const row = this.toolRows()[index];
    return row !== undefined && row.option.enabled !== false ? row.action : NONE;
  }

  // --- Save ------------------------------------------------------------------------------------

  serialize(): InvestigationSave {
    const save = emptyInvestigationSave(this.rng.state());
    save.files = this.caseStore.serialize();
    save.ledger = this.custody.serialize();
    save.tapes = this.tapes.map((t) => ({ callId: t.callId, points: t.points.slice(), closed: t.closed }));
    save.activeTape = this.activeTape;
    save.bodycam = this.camOn;
    save.held = this.held.slice();
    save.dust = this.dustSt === null ? null : { ...this.dustSt, coverage: this.dustSt.coverage.slice() };
    save.k9 = this.k9 === null ? null : { ...this.k9, alerts: this.k9.alerts.map((a) => ({ ...a })), order: this.k9.order.slice() };
    save.scanTimer = this.scanTimer;
    save.arrests = this.arrests.map((a) => [a[0], a[1], a[2], a[3], a[4]]);
    save.queue = this.queue.map((r) => ({ ...r }));
    return save;
  }

  restore(s: InvestigationSave): void {
    this.rng.restore(s.rng);
    this.caseStore = CaseStore.restore(s.files);
    this.custody = new CustodyLedger(s.ledger);
    this.tapes = s.tapes.map((t) => ({ callId: t.callId, points: t.points.slice(), closed: t.closed }));
    this.activeTape = s.activeTape;
    this.held = s.held.slice();
    this.arrests = s.arrests.map((a) => [a[0], a[1], a[2], a[3], a[4]]);
    this.queue = s.queue.map((r) => ({ ...r }));
    this.scanTimer = s.scanTimer;
    this.camOn = s.bodycam;
    this.camCall = FIELD_CASE;
    for (const f of this.caseStore.files()) if (f.bodycam.some((seg) => seg.end < 0)) this.camCall = f.callId;
    this.thumbs = [];
    this.presenceSig = Number.NaN;
    this.setDustState(s.dust === null ? null : { ...s.dust, coverage: s.dust.coverage.slice() });
    this.k9 = null;
    this.k9Path = null;
    this.dogBuf.count = 0;
    if (s.k9 !== null) {
      const k = { ...s.k9, alerts: s.k9.alerts.map((a) => ({ ...a })), order: s.k9.order.slice() };
      const call = this.ports.callContext(k.callId);
      this.k9Building = call !== null ? call.buildingId : -1;
      const layout = this.k9Building >= 0 ? this.ports.layout(this.k9Building) : null;
      this.k9 = k;
      this.k9Path = this.routeFor(k, call, layout, this.readOfficer());
      this.placeDog(this.lastSim - k.startedSim, true);
      this.dogBuf.count = 2;
    }
    this.zones = this.closedZones();
    this.ports.setNoGoZones(this.zones);
    this.dirtyItems();
    this.touch();
  }

  dispose(): void {
    this.unsubForce();
    this.queue = [];
    this.dogBuf.count = 0;
    this.propBuf.count = 0;
  }

  // --- Request handling ------------------------------------------------------------------------

  private apply(r: InvestigationRequest, t: { sim: number; game: number }): void {
    switch (r.kind) {
      case 'marker':
        this.doMarker(t);
        break;
      case 'removeMarker':
        this.doRemoveMarker(r.no);
        break;
      case 'photo':
        this.doPhoto(r.fovDeg, t);
        break;
      case 'collect':
        this.doCollect(r.itemId, t);
        break;
      case 'bag':
        this.doBag(r.itemId, t);
        break;
      case 'tag':
        this.doTag(r.itemId, t);
        break;
      case 'transfer':
        this.doTransfer(r.itemId, r.to, t);
        break;
      case 'deposit':
        this.doDeposit(t);
        break;
      case 'search':
        this.doSearch(r.buildingId, r.furniture, r.force, t);
        break;
      case 'dustStart':
        this.doDustStart(r.buildingId, r.furniture);
        break;
      case 'dustMove':
        if (this.dustSt !== null && !this.dustSt.lifted) {
          moveCursor(this.dustSt, r.dir);
          this.syncDust();
        }
        break;
      case 'dustBrush':
        if (this.dustSt !== null && Number.isFinite(r.seconds)) {
          brush(this.dustSt, Math.min(MAX_BRUSH_S, Math.max(0, r.seconds)));
          this.syncDust();
        }
        break;
      case 'dustLift':
        this.doDustLift(t);
        break;
      case 'dustCancel':
        if (this.dustSt !== null) this.setDustState(null);
        break;
      case 'tapePost':
        this.doTapePost();
        break;
      case 'tapeClose':
        this.doTapeClose();
        break;
      case 'tapeClear':
        this.doTapeClear();
        break;
      case 'bodycam':
        this.doBodycam(r.on, t);
        break;
      case 'canvass':
        this.doCanvass(r.buildingId, t);
        break;
    }
  }

  // --- Markers and photos ----------------------------------------------------------------------

  private doMarker(t: { sim: number }): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    const file = this.fileOf(callId);
    if (file.markers.length >= MAX_MARKERS) {
      this.flash(callId, 'No more marker numbers in this case.');
      return;
    }
    if (!this.ports.kit().use('evidenceMarkers', 1)) {
      this.flash(callId, 'No evidence markers.');
      return;
    }
    let x = o.x - Math.sin(o.yaw) * MARKER_AHEAD_M;
    let z = o.z - Math.cos(o.yaw) * MARKER_AHEAD_M;
    let y = o.y;
    if (this.liveDirty) this.refreshLive();
    let linked: EvidenceItem | null = null;
    let bestD2 = MARKER_SNAP_M * MARKER_SNAP_M;
    for (const it of this.live) {
      if (it.state !== 'found' || it.markerNo !== 0 || it.buildingId !== o.building) continue;
      const d2 = (it.x - x) ** 2 + (it.z - z) ** 2;
      if (d2 <= bestD2) {
        bestD2 = d2;
        linked = it;
      }
    }
    const no = file.nextMarker++;
    if (linked !== null) {
      x = linked.x;
      y = linked.y;
      z = linked.z;
      linked.markerNo = no;
    }
    file.markers.push({ no, callId, x, y, z, buildingId: o.building, itemId: linked !== null ? linked.id : null, sim: t.sim });
    this.caseStore.trim();
    this.dirtyItems();
    this.bus.emit('investigation:marker', { callId, no, itemId: linked !== null ? linked.id : null, removed: false });
    this.flash(callId, linked !== null ? `Marker ${String(no)}: ${linked.label}` : `Marker ${String(no)} placed`);
  }

  private doRemoveMarker(no: number): void {
    const callId = this.ports.currentCall();
    const file = this.caseStore.get(callId);
    const at = file ? file.markers.findIndex((m) => m.no === no) : -1;
    if (!file || at < 0) {
      this.flash(callId, `No marker ${String(no)} in this case.`);
      return;
    }
    const m = file.markers[at] as CaseFile['markers'][number];
    file.markers.splice(at, 1);
    if (m.itemId !== null) {
      const item = this.caseStore.item(m.itemId);
      if (item) item.markerNo = 0;
    }
    this.ports.kit().give('evidenceMarkers', 1);
    this.dirtyItems();
    this.bus.emit('investigation:marker', { callId, no, itemId: m.itemId, removed: true });
    this.flash(callId, `Marker ${String(no)} picked up`);
  }

  private doPhoto(fovDeg: number, t: { sim: number; game: number }): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    if (this.ports.kit().carried('camera') < 1) {
      this.flash(callId, 'No camera.');
      return;
    }
    const file = this.fileOf(callId);
    const fov = Number.isFinite(fovDeg) ? Math.min(PHOTO_FOV_MAX, Math.max(PHOTO_FOV_MIN, fovDeg)) : PHOTO_FOV_DEFAULT;
    const cosHalf = Math.cos((fov * Math.PI) / 360);
    const fx = -Math.sin(o.yaw);
    const fz = -Math.cos(o.yaw);
    const floor = levelY(o.building);
    const ey = o.y + EYE_HEIGHT_M - floor;
    const layout = o.building >= 0 ? this.ports.layout(o.building) : null;
    const subjects: { kind: 'marker' | 'item' | 'person'; ref: string }[] = [];
    let caption = '';
    let bestCos = -2;
    const consider = (kind: 'marker' | 'item', ref: string, x: number, y: number, z: number, ignore: number, text: () => string): void => {
      const dx = x - o.x;
      const dz = z - o.z;
      const d = Math.hypot(dx, dz);
      if (d > PHOTO_RANGE_M) return;
      const c = d < 0.3 ? 1 : (dx * fx + dz * fz) / d;
      if (c < cosHalf) return;
      if (!this.ports.lineOfSight(o.building, o.x, ey, o.z, x, y - floor, z, ignore)) return;
      subjects.push({ kind, ref });
      if (c > bestCos) {
        bestCos = c;
        caption = text();
      }
    };
    const placeOf = (room: number, x: number, z: number): string =>
      layout ? (layout.rooms[room >= 0 ? room : roomAt(layout, x, z)]?.label ?? 'Outdoors') : 'Outdoors';
    for (const f of this.caseStore.files()) {
      for (const m of f.markers) {
        if (m.buildingId !== o.building) continue;
        const item = m.itemId !== null ? this.caseStore.item(m.itemId) : null;
        consider('marker', String(m.no), m.x, m.y + 0.1, m.z, item ? item.furniture : -1, () =>
          item ? `Marker ${String(m.no)} — ${item.label} (${placeOf(item.room, m.x, m.z)})` : `Marker ${String(m.no)} (${placeOf(-1, m.x, m.z)})`,
        );
      }
      for (const it of f.items) {
        if (it.state !== 'found' || it.buildingId !== o.building) continue;
        consider('item', it.id, it.x, it.y + 0.05, it.z, it.furniture, () =>
          it.markerNo > 0 ? `Marker ${String(it.markerNo)} — ${it.label} (${placeOf(it.room, it.x, it.z)})` : `${it.label} (${placeOf(it.room, it.x, it.z)})`,
        );
      }
    }
    if (caption === '') caption = `Overview — ${placeOf(o.room, o.x, o.z)}`;
    const id = `P-${String(callId)}-${String(file.nextPhoto++)}`;
    file.photos.push({
      id, callId, sim: t.sim, game: t.game, x: o.x, y: o.y + EYE_HEIGHT_M, z: o.z, yaw: o.yaw, pitch: o.pitch,
      buildingId: o.building, room: o.room, subjects, caption, thumb: null,
    });
    this.caseStore.trim();
    this.thumbs.push(id);
    if (this.thumbs.length > MAX_PENDING_THUMBS) this.thumbs.shift();
    this.touch();
    this.bus.emit('investigation:photo', { callId, photoId: id, subjects });
    this.flash(callId, `Photo ${id}: ${caption}`);
  }

  // --- Plain view and searches -----------------------------------------------------------------

  /** Fills the shared presence scratch for the officer; returns its context for `callId`. */
  private fillPresence(o: InvestigationOfficer, layout: InteriorLayout | null, callId: number, call: CallContext | null, sim: number): MutablePresence {
    const p = this.presence;
    p.buildingId = o.building;
    p.room = o.room;
    p.roomPublic = layout !== null ? (layout.rooms[o.room]?.public ?? false) : false;
    p.businessOpen = o.building >= 0 ? this.ports.businessOpen(o.building) : false;
    p.consents = this.caseStore.get(callId)?.consents ?? EMPTY_CONSENTS;
    p.exigency = call !== null && call.exigency;
    p.warrant = call !== null && call.warrant;
    p.sim = sim;
    return p;
  }

  private scan(o: InvestigationOfficer, t: { sim: number }): void {
    if (this.liveDirty) this.refreshLive();
    const live = this.live;
    if (live.length === 0) return;
    const ports = this.ports;
    const floor = levelY(o.building);
    const fx = -Math.sin(o.yaw);
    const fz = -Math.cos(o.yaw);
    const eyeY = o.y + EYE_HEIGHT_M - floor;
    let layout: InteriorLayout | null = null;
    let layoutDone = false;
    let night = -1;
    let lastCall = -2;
    let lawful = false;
    for (let i = 0; i < live.length; i++) {
      const it = live[i] as EvidenceItem;
      if (it.state !== 'inPlace' || it.concealed || !it.incriminating || it.buildingId !== o.building) continue;
      const dx = it.x - o.x;
      const dz = it.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > SCAN_RANGE2 || Math.abs(it.y - o.y) > 6) continue;
      let lit: boolean;
      if (o.building < 0) {
        if (night < 0) night = ports.nightFactor();
        lit = night < 0.5;
      } else {
        lit = ports.roomLit(o.building, it.room);
      }
      if (!lit && o.flashlight && d2 <= FLASH_RANGE2) {
        const d = Math.sqrt(d2);
        lit = d < 0.05 || (dx * fx + dz * fz) / d >= COS_FLASHLIGHT;
      }
      if (!lit) continue;
      if (it.callId !== lastCall) {
        lastCall = it.callId;
        if (!layoutDone) {
          layout = o.building >= 0 ? ports.layout(o.building) : null;
          layoutDone = true;
        }
        lawful = this.lawfulFor(o, layout, it.callId, t.sim);
      }
      if (!lawful) continue;
      if (!ports.lineOfSight(o.building, o.x, eyeY, o.z, it.x, it.y - floor + 0.05, it.z, it.furniture)) continue;
      const r = plainView({ presence: this.presence, concealed: false, visible: true, incriminating: true });
      if (r.plainView) this.markFound(it, 'plainView', false, true);
    }
  }

  /** Lawful presence for a call, recomputed only when its inputs changed (no allocation in the steady state). */
  private lawfulFor(o: InvestigationOfficer, layout: InteriorLayout | null, callId: number, sim: number): boolean {
    const call = this.ports.callContext(callId);
    const p = this.fillPresence(o, layout, callId, call, sim);
    let revocable = false;
    for (const c of p.consents) if (c.revokedSim >= 0) revocable = true;
    const sig =
      ((((callId * 31 + p.buildingId) * 31 + p.room) * 31 + p.consents.length) * 16 +
        (p.roomPublic ? 1 : 0) + (p.businessOpen ? 2 : 0) + (p.exigency ? 4 : 0) + (p.warrant ? 8 : 0));
    if (!revocable && sig === this.presenceSig) return this.presenceLawful;
    this.presenceLawful = lawfulPresence(p).lawful;
    this.presenceSig = revocable ? Number.NaN : sig;
    return this.presenceLawful;
  }

  /** Marks an in-place item found and tells the world. */
  private markFound(it: EvidenceItem, basis: SearchBasis | null, suppressed: boolean, viaPlainView: boolean): void {
    it.state = 'found';
    it.foundBasis = basis;
    it.suppressed = suppressed;
    it.plainView = viaPlainView;
    this.dirtyItems();
    if (viaPlainView) {
      this.bus.emit('investigation:plainView', { callId: it.callId, itemId: it.id, label: it.label });
      this.flash(it.callId, `Plain view: ${it.label} (${this.roomName(it.buildingId, it.room)})`);
    } else {
      this.bus.emit('investigation:found', { callId: it.callId, itemId: it.id, basis, suppressed });
    }
  }

  /** Search authority for the container `furniture` of `building` (null when it is not a container in reach). */
  private authorityFor(
    building: number,
    furniture: number,
    sim: number,
  ): { auth: ReturnType<typeof searchAuthority>; callId: number; furn: FurnitureItem; items: EvidenceItem[] } | null {
    const o = this.off;
    const layout = this.ports.layout(building);
    const furn = layout?.furniture[furniture];
    if (!layout || !furn || furn.container === 'none') return null;
    if (this.liveDirty) this.refreshLive();
    const items = this.live.filter(
      (i) => i.state === 'inPlace' && i.concealed && i.buildingId === building && i.furniture === furniture,
    );
    const callId = items[0] !== undefined ? items[0].callId : this.ports.currentCall();
    const call = this.ports.callContext(callId);
    const here = o.building === building ? layout : null;
    const p = this.fillPresence(o, here, callId, call, sim);
    const arrests: { personId: number; buildingId: number; room: number; sim: number }[] = call ? [...call.arrests] : [];
    for (const a of this.arrests) if (a[0] === callId) arrests.push({ personId: a[1], buildingId: a[2], room: a[3], sim: a[4] });
    const ctx: SearchContext = {
      buildingId: p.buildingId, room: p.room, roomPublic: p.roomPublic, businessOpen: p.businessOpen, consents: p.consents,
      exigency: p.exigency, warrant: p.warrant, sim: p.sim,
      target: { kind: 'container', buildingId: building, room: furn.room, container: furn.container, hide: furn.hide !== null, personId: -1, vehicleId: -1 },
      arrests,
    };
    return { auth: searchAuthority(ctx), callId, furn, items };
  }

  private doSearch(building: number, furniture: number, force: boolean, t: { sim: number }): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    if (o.building !== building || building < 0) {
      this.flash(callId, 'You are not in that building.');
      return;
    }
    const found = this.authorityFor(building, furniture, t.sim);
    if (found === null) {
      this.flash(callId, 'There is nothing to search there.');
      return;
    }
    const { auth, furn, items } = found;
    const name = furnitureName(furn.id);
    if (furnitureDistance(furn, o.x, o.z) > REACH_M) {
      this.flash(callId, `Too far from the ${name}.`);
      return;
    }
    if (!auth.allowed && !force) {
      this.flash(found.callId, auth.reason);
      return;
    }
    if (items.length === 0) {
      this.flash(found.callId, `Nothing in the ${name}.`);
      return;
    }
    for (const it of items) {
      this.markFound(it, auth.allowed ? auth.basis : null, !auth.allowed, false);
      this.flash(it.callId, auth.allowed ? `Found ${it.label} in the ${name}` : `Found ${it.label} in the ${name} (no lawful basis)`);
    }
  }

  // --- Custody ---------------------------------------------------------------------------------

  private officerId(): string {
    return `officer:${this.off.badge}`;
  }

  private locationText(): string {
    const o = this.off;
    const address = this.ports.addressOf(o.building);
    return `${address === '' ? 'Outdoors' : address} · ${this.roomName(o.building, o.room)}`;
  }

  /** Appends a custody entry and emits the events; returns whether the ledger accepted it. */
  private record(item: EvidenceItem, action: CustodyAction, from: string, to: string, note: string, t: { sim: number; game: number }): boolean {
    const r = this.custody.append({ itemId: item.id, action, from, to, sim: t.sim, game: t.game, location: this.locationText(), note });
    if (!r.ok) {
      this.flash(item.callId, r.reason);
      return false;
    }
    this.touch();
    this.bus.emit('investigation:custody', { callId: item.callId, itemId: item.id, action });
    return true;
  }

  private doCollect(itemId: string, t: { sim: number; game: number }): void {
    const o = this.off;
    const item = this.caseStore.item(itemId);
    if (!item) {
      this.flash(this.ports.currentCall(), 'Unknown evidence item.');
      return;
    }
    if (item.state !== 'found') {
      this.flash(item.callId, item.state === 'collected' ? `${item.label} is already collected.` : 'You have not found that yet.');
      return;
    }
    if (item.buildingId !== o.building || Math.hypot(item.x - o.x, item.z - o.z) > REACH_M) {
      this.flash(item.callId, `Too far to collect the ${item.label.toLowerCase()}.`);
      return;
    }
    const who = this.officerId();
    if (!this.record(item, 'collect', 'scene', who, item.label, t)) return;
    item.state = 'collected';
    this.held.push(item.id);
    this.dirtyItems();
    this.bus.emit('investigation:collected', { callId: item.callId, itemId: item.id, label: item.label });
    this.flash(item.callId, `Collected: ${item.label}`);
  }

  private doBag(itemId: string, t: { sim: number; game: number }): void {
    const item = this.caseStore.item(itemId);
    if (!item) {
      this.flash(this.ports.currentCall(), 'Unknown evidence item.');
      return;
    }
    const kit = this.ports.kit();
    if (kit.carried('evidenceBags') < 1) {
      this.flash(item.callId, 'No evidence bags.');
      return;
    }
    const holder = this.custody.custodian(itemId);
    if (!this.record(item, 'bag', holder, holder, `${item.label} bagged`, t)) return;
    kit.use('evidenceBags', 1);
    this.flash(item.callId, `Bagged: ${item.label}`);
  }

  private doTag(itemId: string, t: { sim: number; game: number }): void {
    const item = this.caseStore.item(itemId);
    if (!item) {
      this.flash(this.ports.currentCall(), 'Unknown evidence item.');
      return;
    }
    const holder = this.custody.custodian(itemId);
    const incident = this.caseStore.get(item.callId)?.incident ?? '';
    const note = `${incident === '' ? this.ports.incidentOf(item.callId) : incident} item ${itemNumber(item.id)}: ${item.label}`;
    if (!this.record(item, 'tag', holder, holder, note, t)) return;
    this.flash(item.callId, `Tagged: ${item.label}`);
  }

  private doTransfer(itemId: string, to: string, t: { sim: number; game: number }): void {
    const item = this.caseStore.item(itemId);
    if (!item) {
      this.flash(this.ports.currentCall(), 'Unknown evidence item.');
      return;
    }
    // Into a trunk: the officer must be standing at that car's trunk.
    if (to.startsWith('locker:') && this.ports.trunkLocker && this.ports.trunkLocker() !== to) {
      this.flash(item.callId, 'Stand at the patrol car trunk to secure evidence.');
      return;
    }
    const holder = this.custody.custodian(itemId);
    if (!this.record(item, 'transfer', holder, to, `Transferred to ${to}`, t)) return;
    if (holder === this.officerId()) this.held = this.held.filter((id) => id !== itemId);
    this.flash(item.callId, to.startsWith('locker:') ? `${item.label} secured in the patrol car` : `${item.label} transferred to ${to}`);
  }

  /** Tagged items the officer holds or that sit in a patrol car trunk (a transfer), for the evidence room deposit. */
  private depositable(who: string): string[] {
    const out: string[] = [];
    for (const id of this.held) {
      if (this.custody.state(id) === 'tagged' && this.custody.custodian(id) === who) out.push(id);
    }
    for (const f of this.caseStore.files()) {
      for (const it of f.items) {
        if (this.custody.state(it.id) === 'tagged' && this.custody.custodian(it.id).startsWith('locker:')) out.push(it.id);
      }
    }
    return out;
  }

  private doDeposit(t: { sim: number; game: number }): void {
    const who = this.officerId();
    const callId = this.ports.currentCall();
    let n = 0;
    for (const id of this.depositable(who)) {
      const item = this.caseStore.item(id);
      if (!item) continue;
      if (!this.record(item, 'deposit', this.custody.custodian(id), 'evidenceRoom', 'Deposited in the evidence room', t)) continue;
      this.held = this.held.filter((x) => x !== id);
      n++;
      this.bus.emit('investigation:custodyComplete', { callId: item.callId, itemId: item.id });
    }
    this.flash(callId, n > 0 ? `Deposited ${String(n)} item${n === 1 ? '' : 's'} in the evidence room` : 'Nothing tagged to deposit.');
  }

  // --- Dusting ---------------------------------------------------------------------------------

  private doDustStart(building: number, furniture: number): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    if (this.dustSt !== null) {
      this.flash(callId, 'Finish the current dusting first.');
      return;
    }
    if (this.ports.kit().carried('fingerprintKit') < 1) {
      this.flash(callId, 'No fingerprint kit.');
      return;
    }
    const layout = building >= 0 ? this.ports.layout(building) : null;
    const furn = layout?.furniture[furniture];
    if (!layout || !furn || furn.surface === null || o.building !== building) {
      this.flash(callId, 'Nothing to dust there.');
      return;
    }
    if (furnitureDistance(furn, o.x, o.z) > REACH_M) {
      this.flash(callId, `Too far from the ${furnitureName(furn.id)}.`);
      return;
    }
    const file = this.caseStore.get(callId);
    if (file?.prints.some((p) => p.buildingId === building && p.furniture === furniture)) {
      this.flash(callId, 'A print was already lifted here.');
      return;
    }
    const call = this.ports.callContext(callId);
    let p = 0.15;
    if (call !== null && call.buildingId === building) {
      const rooms = new Set<number>();
      const door = layout.doors.find((d) => d.main);
      if (door) rooms.add(door.a);
      for (const it of file?.items ?? []) if (it.buildingId === building) rooms.add(it.room);
      if (rooms.has(furn.room)) p = 0.6;
    }
    const hasPrint = unitHash(this.seed, HASH_PRINT, callId * 4099 + building * 64 + furniture) < p;
    const person = call !== null && call.suspectPersonId >= 0 ? call.suspectPersonId : this.ports.residentOf(building, 0);
    const st = startDust(furn.surface, hasPrint, person, this.rng.next());
    this.setDustState({ ...st, callId, buildingId: building, furniture });
    this.flash(callId, `Dusting the ${furnitureName(furn.id)}`);
  }

  private doDustLift(t: { sim: number }): void {
    const d = this.dustSt;
    if (d === null) return;
    const o = this.off;
    const result = lift(d);
    const callId = d.callId;
    const file = this.fileOf(callId);
    const layout = this.ports.layout(d.buildingId);
    const furn = layout?.furniture[d.furniture];
    this.setDustState(null);
    if (!result.usable || !furn || !layout) {
      this.bus.emit('investigation:print', { callId, printId: '', quality: result.quality, usable: false, itemId: null });
      this.flash(callId, `No usable print lifted (quality ${String(Math.round(result.quality * 100))}%)`);
      return;
    }
    const presence = this.presenceBasis(o, layout, callId, t.sim);
    const item = this.caseStore.addItem(callId, {
      item: 'latentPrint',
      label: EVIDENCE_DATA.labels.latentPrint ?? 'Latent print',
      x: furn.x,
      y: levelY(d.buildingId) + furn.h,
      z: furn.z,
      buildingId: d.buildingId,
      room: furn.room,
      furniture: d.furniture,
      container: 'none',
      concealed: false,
      ownerPersonId: result.personId,
      incriminating: true,
    });
    item.state = 'found';
    item.foundBasis = presence;
    item.suppressed = presence === null;
    const printId = `L-${String(callId)}-${String(file.prints.length + 1)}`;
    file.prints.push({
      id: printId, callId, buildingId: d.buildingId, furniture: d.furniture, quality: result.quality,
      personId: result.personId, itemId: item.id, sim: t.sim,
    });
    this.dirtyItems();
    this.bus.emit('investigation:print', { callId, printId, quality: result.quality, usable: true, itemId: item.id });
    this.bus.emit('investigation:found', { callId, itemId: item.id, basis: presence, suppressed: presence === null });
    this.flash(callId, `Lifted a latent print (quality ${String(Math.round(result.quality * 100))}%)`);
  }

  /** The basis for evidence the officer finds where they stand: null when not lawfully present. */
  private presenceBasis(o: InvestigationOfficer, layout: InteriorLayout | null, callId: number, sim: number): SearchBasis | null {
    const call = this.ports.callContext(callId);
    const r = lawfulPresence(this.fillPresence(o, layout, callId, call, sim));
    if (!r.lawful) return null;
    if (r.basis === null) return 'publicArea';
    return r.basis === 'invited' ? 'consent' : r.basis;
  }

  private stepDust(o: InvestigationOfficer): void {
    const d = this.dustSt;
    if (d === null) return;
    if (o.building !== d.buildingId || Math.hypot(o.x - this.dustX, o.z - this.dustZ) > DUST_ABANDON_M) {
      this.setDustState(null);
      this.flash(d.callId, 'Stopped dusting: you stepped away.');
    }
  }

  private setDustState(st: SavedDust | null): void {
    this.dustSt = st;
    if (st === null) {
      this.dustV = null;
      this.touch();
      return;
    }
    const layout = this.ports.layout(st.buildingId);
    const furn = layout?.furniture[st.furniture];
    this.dustX = furn ? furn.x : 0;
    this.dustZ = furn ? furn.z : 0;
    this.dustV = {
      surface: st.surface,
      label: furn ? furnitureName(furn.id) : st.surface,
      cursor: st.cursor,
      coverage: st.coverage,
      quality: 0,
      overbrush: st.overbrush,
    };
    this.syncDust();
  }

  /** Refreshes the dust view after the state changed. */
  private syncDust(): void {
    const st = this.dustSt;
    const v = this.dustV;
    if (st === null || v === null) return;
    let sum = 0;
    for (const c of st.coverage) sum += Math.min(1, c);
    v.cursor = st.cursor;
    v.overbrush = st.overbrush;
    v.quality = Math.min(1, Math.max(0, st.base * (sum / st.coverage.length) - 0.15 * st.overbrush));
    this.touch();
  }

  // --- Tape ------------------------------------------------------------------------------------

  private doTapePost(): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    if (o.building >= 0) {
      this.flash(callId, 'Scene tape goes up outdoors.');
      return;
    }
    if (this.ports.kit().carried('sceneTape') < 1) {
      this.flash(callId, 'No scene tape.');
      return;
    }
    let tape = this.activeTape >= 0 ? this.tapes[this.activeTape] : undefined;
    if (tape !== undefined && tape.points.length / 2 >= MAX_TAPE_POSTS) {
      this.flash(callId, `Scene tape is full (${String(MAX_TAPE_POSTS)} posts).`);
      return;
    }
    if (tape !== undefined) {
      const n = tape.points.length;
      if (Math.hypot(o.x - (tape.points[n - 2] as number), o.z - (tape.points[n - 1] as number)) < MIN_POST_GAP) {
        this.flash(callId, 'Move further from the last post.');
        return;
      }
    }
    if (tape === undefined) {
      if (this.tapes.length >= MAX_TAPES) {
        const drop = this.tapes.findIndex((x) => x.closed);
        this.tapes.splice(drop < 0 ? 0 : drop, 1);
        this.zones = this.closedZones();
        this.ports.setNoGoZones(this.zones);
      }
      tape = { callId, points: [], closed: false };
      this.tapes.push(tape);
      this.activeTape = this.tapes.length - 1;
    }
    tape.points.push(o.x, o.z);
    this.propsDirty = true;
    this.touch();
    this.flash(tape.callId, `Tape post ${String(tape.points.length / 2)} set`);
  }

  private doTapeClose(): void {
    const callId = this.ports.currentCall();
    const tape = this.activeTape >= 0 ? this.tapes[this.activeTape] : undefined;
    if (tape === undefined || tape.points.length / 2 < MIN_CLOSED_POSTS) {
      this.flash(callId, `Set at least ${String(MIN_CLOSED_POSTS)} posts before closing the tape.`);
      return;
    }
    tape.closed = true;
    this.activeTape = -1;
    this.zones = this.closedZones();
    this.ports.setNoGoZones(this.zones);
    this.propsDirty = true;
    this.touch();
    this.bus.emit('investigation:tape', { callId: tape.callId, closed: true, points: tape.points.slice() });
    this.flash(tape.callId, 'Scene tape closed. Pedestrians will keep out.');
  }

  private doTapeClear(): void {
    const callId = this.ports.currentCall();
    let at = this.activeTape;
    if (at < 0) {
      for (let i = this.tapes.length - 1; i >= 0; i--) {
        if ((this.tapes[i] as SavedTape).callId === callId) {
          at = i;
          break;
        }
      }
    }
    const tape = at >= 0 ? this.tapes[at] : undefined;
    if (tape === undefined) {
      this.flash(callId, 'No scene tape to clear.');
      return;
    }
    this.tapes.splice(at, 1);
    if (this.activeTape === at) this.activeTape = -1;
    else if (this.activeTape > at) this.activeTape--;
    if (tape.closed) {
      this.zones = this.closedZones();
      this.ports.setNoGoZones(this.zones);
    }
    this.propsDirty = true;
    this.touch();
    this.bus.emit('investigation:tape', { callId: tape.callId, closed: false, points: [] });
    this.flash(tape.callId, 'Scene tape cleared');
  }

  private closedZones(): NoGoZone[] {
    const zones: NoGoZone[] = [];
    this.tapes.forEach((t, i) => {
      if (t.closed) zones.push(tapeZone(i + 1, t.points));
    });
    return zones;
  }

  // --- Bodycam ---------------------------------------------------------------------------------

  private doBodycam(on: boolean, t: { sim: number }): void {
    const callId = this.ports.currentCall();
    if (on === this.camOn) return;
    if (on && !this.ports.bodycamWorn()) {
      this.flash(callId, 'No bodycam mounted.');
      return;
    }
    this.setBodycam(on, callId, t.sim);
  }

  private setBodycam(on: boolean, callId: number, sim: number): void {
    this.camOn = on;
    if (on) {
      this.openSegment(callId, sim);
      this.camCall = callId;
    } else {
      this.closeSegments(this.camCall, sim);
    }
    this.touch();
    this.bus.emit('investigation:bodycam', { callId, on });
    this.flash(callId, on ? 'Bodycam recording' : 'Bodycam off');
  }

  private openSegment(callId: number, sim: number): void {
    const f = this.fileOf(callId);
    f.bodycam.push({ start: sim, end: -1 });
    if (f.bodycam.length > MAX_BODYCAM_SEGMENTS) f.bodycam.splice(0, f.bodycam.length - MAX_BODYCAM_SEGMENTS);
  }

  private closeSegments(callId: number, sim: number): void {
    const f = this.caseStore.get(callId);
    if (!f) return;
    for (const seg of f.bodycam) if (seg.end < 0) seg.end = sim;
  }

  private stepBodycam(t: { sim: number }): void {
    if (!this.ports.bodycamWorn()) {
      this.setBodycam(false, this.camCall, t.sim);
      return;
    }
    const call = this.ports.currentCall();
    if (call !== this.camCall) {
      this.closeSegments(this.camCall, t.sim);
      this.openSegment(call, t.sim);
      this.camCall = call;
      this.touch();
    }
  }

  private onForce(e: ForceUsedEvent): void {
    if ((e.kind === 'sidearmDrawn' || e.kind === 'taserDrawn') && !this.camOn && this.ports.bodycamWorn()) {
      this.request({ kind: 'bodycam', on: true });
    }
  }

  // --- Canvass ---------------------------------------------------------------------------------

  private doCanvass(building: number, t: { sim: number; game: number }): void {
    const o = this.off;
    const callId = this.ports.currentCall();
    const call = callId !== FIELD_CASE ? this.ports.callContext(callId) : null;
    if (call === null) {
      this.flash(callId, 'There is no active call to canvass for.');
      return;
    }
    if (Math.hypot(o.x - call.anchorX, o.z - call.anchorZ) > CANVASS_CALL_M) {
      this.flash(callId, 'Too far from the scene to canvass.');
      return;
    }
    if (building === call.buildingId) {
      this.flash(callId, 'Talk to the people inside this building instead.');
      return;
    }
    const layout = building >= 0 ? this.ports.layout(building) : null;
    const door = layout?.doors.find((d) => d.main);
    if (!layout || !door) {
      this.flash(callId, 'Nobody answers there.');
      return;
    }
    // Measured from the outdoor pose, the same point the door prompt is offered from.
    const at = door.exit ?? door;
    if (Math.hypot(o.x - at.x, o.z - at.z) > CANVASS_DOOR_M) {
      this.flash(callId, 'Stand at the door to knock.');
      return;
    }
    const file = this.fileOf(callId);
    if (file.canvass.some((c) => c.buildingId === building)) {
      this.flash(callId, 'Already canvassed');
      return;
    }
    const hour = Math.floor(t.game / 3600) % 24;
    const res = canvassResult(this.seed, callId, building, hour, sawChanceFor(call.family));
    const address = this.ports.addressOf(building);
    const text = canvassText(res.result, {
      address: address === '' ? 'this address' : address,
      description: call.suspectPersonId >= 0 ? this.ports.describePerson(call.suspectPersonId) : undefined,
      direction: this.ports.describeDirection(call.anchorX, call.anchorZ, door.x, door.z),
    });
    let personId = -1;
    if (res.answered) {
      personId = this.ports.residentOf(building, res.residentIndex);
      this.ports.spawnResident(building, personId, callId, res.result === 'sawSomething' ? 'witness' : 'resident');
    }
    file.canvass.push({ callId, buildingId: building, sim: t.sim, result: res.result, personId, text });
    this.touch();
    this.bus.emit('investigation:canvass', { callId, buildingId: building, result: res.result, personId });
    this.flash(callId, text);
  }

  // --- K9 sweep --------------------------------------------------------------------------------

  private routeFor(k: SavedK9, call: CallContext | null, layout: InteriorLayout | null, o: InvestigationOfficer): K9Route {
    if (layout !== null) {
      const door = layout.doors.find((d) => d.main);
      const exit = door?.exit;
      return k9Route(layout, k.order, exit ? exit.x : layout.entry.x, exit ? exit.z : layout.entry.z);
    }
    return k9Route(null, k.order, call !== null ? call.anchorX : o.x, call !== null ? call.anchorZ : o.z);
  }

  private stepK9(dt: number, t: { sim: number }): void {
    const k = this.k9;
    if (k === null) return;
    const tau = t.sim - k.startedSim;
    while (k.fired < k.alerts.length && tau >= (k.alerts[k.fired] as K9Alert).atS) {
      this.fireAlert(k, k.alerts[k.fired] as K9Alert, t);
      k.fired++;
    }
    this.dogGait += dt * 1.2;
    this.placeDog(tau, false);
    if (k.fired >= k.alerts.length && tau >= k9Duration(k.order.length)) {
      this.fileOf(k.callId).k9.push({ sim: t.sim, text: 'K9 sweep complete.' });
      this.flash(k.callId, 'The K9 unit finished its sweep.');
      this.k9 = null;
      this.k9Path = null;
      this.dogBuf.count = 0;
      this.touch();
    }
  }

  private fireAlert(k: SavedK9, a: K9Alert, t: { sim: number }): void {
    const layout = this.k9Building >= 0 ? this.ports.layout(this.k9Building) : null;
    const where = a.room >= 0 && layout ? layout.rooms[a.room]?.label.toLowerCase() : undefined;
    const text = where !== undefined ? `K9 has an indication in the ${where}.` : 'K9 has an indication nearby.';
    const file = this.fileOf(k.callId);
    let itemId = '';
    let actorId = 0;
    if (a.kind === 'item') {
      const item = this.caseStore.item(a.ref);
      if (item) {
        item.k9Alert = true;
        itemId = item.id;
      }
      file.k9.push({ sim: t.sim, text: item ? `K9 alerted on a ${item.label.toLowerCase()} in the ${where ?? 'area'}.` : text });
    } else {
      actorId = Number(a.ref);
      file.k9.push({ sim: t.sim, text: `K9 alerted on a person in the ${where ?? 'area'}.` });
    }
    this.touch();
    this.bus.emit('investigation:k9Alert', { callId: k.callId, kind: a.kind, actorId, itemId, room: a.room, text });
    this.bus.emit('investigation:radio', { callId: k.callId, text });
    this.flash(k.callId, text);
  }

  private initDog(): void {
    const d = this.dogBuf;
    d.body[0] = BODY.dog;
    d.height[0] = 0.6;
    d.top[0] = 0x6b4a2b;
    d.bottom[0] = 0x6b4a2b;
    d.body[1] = BODY.human;
    d.height[1] = 1.78;
    d.skin[1] = 0xc99a7a;
    d.hair[1] = 0x2b2118;
    d.top[1] = 0x233044;
    d.bottom[1] = 0x1c2530;
    d.build[1] = 1;
  }

  /** Writes the dog and handler for `tau` seconds into the sweep; `snap` also resets the interpolation. */
  private placeDog(tau: number, snap: boolean): void {
    const route = this.k9Path;
    if (route === null) return;
    const d = this.dogBuf;
    const s = this.sample;
    const b = this.sampleBack;
    k9Sample(route, tau, s);
    k9Sample(route, tau + 0.1, b);
    const vx = (b[0] as number) - (s[0] as number);
    const vz = (b[2] as number) - (s[2] as number);
    const speed = Math.hypot(vx, vz) / 0.1;
    if (speed > 0.05) this.dogYaw = Math.atan2(-vx, -vz);
    this.setFigure(0, s[0] as number, s[1] as number, s[2] as number, speed, snap);
    k9Sample(route, tau - K9_HANDLER_LAG_S, b);
    this.setFigure(1, b[0] as number, b[1] as number, b[2] as number, speed, snap);
    d.gait[0] = this.dogGait;
    d.gait[1] = this.dogGait;
  }

  private setFigure(i: number, x: number, y: number, z: number, speed: number, snap: boolean): void {
    const d = this.dogBuf;
    d.prevX[i] = snap ? x : (d.x[i] as number);
    d.prevY[i] = snap ? y : (d.y[i] as number);
    d.prevZ[i] = snap ? z : (d.z[i] as number);
    d.prevYaw[i] = snap ? this.dogYaw : (d.yaw[i] as number);
    d.x[i] = x;
    d.y[i] = y;
    d.z[i] = z;
    d.yaw[i] = this.dogYaw;
    d.speed[i] = speed;
    d.pose[i] = speed > 0.05 ? POSE.walk : POSE.stand;
  }

  // --- Tools -----------------------------------------------------------------------------------

  private toolRows(): ToolRow[] {
    const o = this.readOfficer();
    const ports = this.ports;
    const kit = ports.kit();
    const call = ports.currentCall();
    const file = this.caseStore.get(call);
    const rows: ToolRow[] = [];
    const add = (label: string, action: ToolAction, off?: string, detail?: string): void => {
      rows.push({
        option: off === undefined ? (detail === undefined ? { label } : { label, detail }) : { label, detail: off, enabled: false },
        action,
      });
    };

    const markers = kit.carried('evidenceMarkers');
    add('Place marker', { kind: 'request', request: { kind: 'marker' } }, markers < 1 ? 'No evidence markers' : undefined, `x${String(markers)}`);
    add('Photograph (camera mode)', { kind: 'camera' }, kit.carried('camera') < 1 ? 'No camera' : undefined);

    const near = this.nearestItem(o.x, o.z, o.building, REACH_M);
    if (near !== null && near.state === 'found') {
      add(`Collect ${near.label}`, { kind: 'request', request: { kind: 'collect', itemId: near.id } });
    } else {
      add('Collect', NONE, 'Nothing found to collect nearby');
    }

    const who = this.officerId();
    const mine = this.held.filter((id) => this.custody.custodian(id) === who);
    const toBag = mine.find((id) => this.custody.state(id) === 'collected');
    const toTag = mine.find((id) => this.custody.state(id) === 'bagged');
    const bagItem = toBag !== undefined ? this.caseStore.item(toBag) : null;
    const tagItem = toTag !== undefined ? this.caseStore.item(toTag) : null;
    if (bagItem !== null) {
      add(`Bag ${bagItem.label}`, { kind: 'request', request: { kind: 'bag', itemId: bagItem.id } }, kit.carried('evidenceBags') < 1 ? 'No evidence bags' : undefined);
    } else {
      add('Bag', NONE, 'Nothing collected to bag');
    }
    if (tagItem !== null) {
      add(`Tag ${tagItem.label}`, { kind: 'request', request: { kind: 'tag', itemId: tagItem.id } });
    } else {
      add('Tag', NONE, 'Nothing bagged to tag');
    }

    // Tagged evidence can be secured in a patrol car trunk (a transfer); the evidence room deposit takes it from there.
    const tagged = mine.find((id) => this.custody.state(id) === 'tagged');
    const taggedItem = tagged !== undefined ? this.caseStore.item(tagged) : null;
    const trunk = ports.trunkLocker ? ports.trunkLocker() : '';
    if (taggedItem !== null) {
      add(`Secure ${taggedItem.label} in the patrol car`, { kind: 'request', request: { kind: 'transfer', itemId: taggedItem.id, to: trunk } }, trunk === '' ? 'Stand at a patrol car trunk' : undefined);
    } else {
      add('Secure in the patrol car', NONE, 'Nothing tagged to secure');
    }

    const cont = this.nearestFurniture(o.x, o.z, o.yaw, o.building, 'container');
    const probe = cont >= 0 ? this.authorityFor(o.building, cont, this.lastSim) : null;
    if (probe !== null) {
      const name = furnitureName(probe.furn.id);
      if (probe.auth.allowed) {
        add(`Search ${name} (${probe.auth.basis !== null ? BASIS_TEXT[probe.auth.basis] : 'authorized'})`, {
          kind: 'request',
          request: { kind: 'search', buildingId: o.building, furniture: cont, force: false },
        });
      } else {
        add('Search anyway (no lawful basis)', { kind: 'request', request: { kind: 'search', buildingId: o.building, furniture: cont, force: true } }, undefined, name);
      }
    } else {
      add('Search', NONE, 'No container within reach');
    }

    const surf = this.nearestFurniture(o.x, o.z, o.yaw, o.building, 'surface');
    const surfLayout = surf >= 0 ? ports.layout(o.building) : null;
    const sf = surfLayout?.furniture[surf];
    if (sf !== undefined && sf.surface !== null) {
      add(`Dust ${furnitureName(sf.id)}`, { kind: 'request', request: { kind: 'dustStart', buildingId: o.building, furniture: surf } },
        kit.carried('fingerprintKit') < 1 ? 'No fingerprint kit' : this.dustSt !== null ? 'Already dusting' : undefined, sf.surface);
    } else {
      add('Dust', NONE, 'No surface within reach');
    }

    const tapeKit = kit.carried('sceneTape') > 0;
    const posts = this.activeTape >= 0 ? (this.tapes[this.activeTape] as SavedTape).points.length / 2 : 0;
    const outdoors = o.building < 0;
    add('Tape: add post', { kind: 'request', request: { kind: 'tapePost' } }, !outdoors ? 'Outdoors only' : !tapeKit ? 'No scene tape' : undefined, posts > 0 ? `${String(posts)} posts` : undefined);
    add('Tape: close', { kind: 'request', request: { kind: 'tapeClose' } }, posts < MIN_CLOSED_POSTS ? `Needs ${String(MIN_CLOSED_POSTS)} posts` : undefined);
    const hasTape = this.activeTape >= 0 || this.tapes.some((x) => x.callId === call);
    add('Tape: clear', { kind: 'request', request: { kind: 'tapeClear' } }, hasTape ? undefined : 'No tape up');

    const doorB = ports.doorBuilding ? ports.doorBuilding(o.x, o.z) : -1;
    if (doorB >= 0 && call !== FIELD_CASE) {
      add('Knock (canvass)', { kind: 'request', request: { kind: 'canvass', buildingId: doorB } });
    } else {
      add('Knock (canvass)', NONE, call === FIELD_CASE ? 'No active call' : 'Stand at a front door');
    }

    const k9Call = call === FIELD_CASE ? null : ports.callContext(call);
    add('Request K9', { kind: 'k9' }, call === FIELD_CASE ? 'No active call' : k9Call?.k9 === false ? 'No K9 for this kind of call' : this.k9 !== null ? 'K9 is searching' : undefined);
    add(this.camOn ? 'Bodycam off' : 'Bodycam on', { kind: 'request', request: { kind: 'bodycam', on: !this.camOn } }, !this.camOn && !ports.bodycamWorn() ? 'No bodycam mounted' : undefined);
    add('Case file', { kind: 'caseFile' }, file === null ? 'No case file yet' : undefined);
    return rows;
  }

  // --- Internals -------------------------------------------------------------------------------

  private readOfficer(): InvestigationOfficer {
    const o = this.officerFn(this.off);
    if (o !== this.off) Object.assign(this.off, o);
    return this.off;
  }

  private fileOf(callId: number): CaseFile {
    if (callId === FIELD_CASE) return this.caseStore.file(FIELD_CASE, 'Field case', 'Field case');
    const incident = this.ports.incidentOf(callId);
    return this.caseStore.file(callId, incident, incident);
  }

  private roomName(building: number, room: number): string {
    if (building < 0) return 'Outdoors';
    return this.ports.layout(building)?.rooms[room]?.label ?? 'Outdoors';
  }

  private flash(callId: number, text: string): void {
    this.bus.emit('investigation:flash', { callId, text });
  }

  private touch(): void {
    this.rev++;
  }

  private dirtyItems(): void {
    this.liveDirty = true;
    this.propsDirty = true;
    this.touch();
  }

  private refreshLive(): void {
    const live = this.live;
    live.length = 0;
    for (const f of this.caseStore.files()) for (const it of f.items) if (it.state !== 'collected') live.push(it);
    this.liveDirty = false;
  }

  private refreshProps(building: number): void {
    buildProps(this.propBuf, this.caseStore.files(), this.tapes, building);
    this.propsLevel = building;
    this.propsDirty = false;
  }
}
