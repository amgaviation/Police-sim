/**
 * Tactical runtime (design §7.3), fixed step order -640: queued requests, lean, door slicing, footsteps, the sound
 * field (room-graph attenuation to the listeners), the notice pass (sight and flashlight light) and the partner.
 * Sim state draws only from the injected 'tactical' rng stream; nothing here reads a clock.
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { lineOfSight } from '../interior/los';
import { roomAt } from '../interior/nav';
import type { InteriorLayout } from '../interior/types';
import type { City } from '../world/city';
import { SURFACE_NAMES } from '../world/ids';
import { TACTICS, type TacticsConfig } from './data';
import './events';
import { bodyPoints, exposure } from './exposure';
import { PartnerOfficer } from './partner';
import { defaultTacticalSave, type PendingSoundSave, type TacticalSave } from './save';
import { buildSoundGraph, footstepLevel, hearingThreshold, receivedLevel, sourceLevel, stimulus, type SoundGraph, type SoundKind } from './sound';
import { createStance, eyeOffset, speedFactor, stepLean, type StanceState } from './stance';
import { createSliceDoor, pickSliceDoor, sliceStep } from './slice';
import { createListener, type DoorStateName, type InteriorQuery, type Listener, type ListenerPort, type OfficerPose, type TacticalRequest } from './types';

export type { OfficerPose, TacticalRequest } from './types';

export interface TacticalDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** The 'tactical' stream (`session.rng.stream('tactical')`). */
  readonly rng: Rng;
  readonly city: City;
  readonly interiors: InteriorQuery;
  readonly listeners: ListenerPort;
  /** Fills the officer's feet position, facing and speed; returns `out`. */
  officer(out: OfficerPose): OfficerPose;
  /** True while the radio plays in an earpiece (transmissions are quiet). */
  radioEarpiece(): boolean;
  /** 0 (day) .. 1 (night): outdoor darkness. */
  nightFactor(): number;
  readonly config?: TacticsConfig;
}

const MAX_QUEUE = 64;
const MAX_PENDING = 32;
const MAX_LISTENERS = 64;
const MAX_GRAPHS = 8;
/** A sound this close to the officer on the officer's level counts as officer-made (noise meter). */
const OFFICER_NEAR = 2.5;
const NOISE_DECAY_PER_S = 0.5;

interface PendingSound {
  kind: SoundKind;
  x: number;
  z: number;
  building: number;
  level: number;
}

interface GraphEntry {
  graph: SoundGraph;
}

export class TacticalSystem {
  private readonly deps: TacticalDeps;
  private readonly cfg: TacticsConfig;
  private readonly stanceState: StanceState = createStance();
  private flashlight = false;
  private heldLean: -1 | 0 | 1 = 0;
  private heldSlice = false;
  private slicingValue = false;
  private sliceBuilding = -1;
  private sliceIndex = -1;
  private readonly sliceDoor = createSliceDoor();
  private readonly sliceOut = { x: 0, z: 0, yaw: 0 };
  private footTimer = 0;
  private noticeTimer = 0;
  private noiseValue = 0;
  private visibilityValue = 0;
  private queue: TacticalRequest[] = [];
  private readonly pending: PendingSound[] = [];
  private pendingCount = 0;
  private readonly pose: OfficerPose = { x: 0, z: 0, yaw: 0, pitch: 0, building: -1, speed: 0, onFoot: true };
  private readonly buf: Listener[] = [];
  private readonly points = new Float32Array(9);
  private readonly graphs = new Map<number, GraphEntry>();
  private stateBuilding = -1;
  private readonly stateOf = (door: number): DoorStateName => this.deps.interiors.doorState(this.stateBuilding, door);
  private readonly isOpen = (door: number): boolean => {
    const s = this.deps.interiors.doorState(this.stateBuilding, door);
    return s === 'open' || s === 'broken';
  };
  private readonly soundEvent = { kind: 'footstep' as SoundKind, x: 0, z: 0, building: -1, level: 0 };
  private readonly offs: (() => void)[] = [];
  readonly partner: PartnerOfficer;

  constructor(deps: TacticalDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? TACTICS;
    for (let i = 0; i < MAX_PENDING; i++) this.pending.push({ kind: 'footstep', x: 0, z: 0, building: -1, level: 0 });
    for (let i = 0; i < MAX_LISTENERS; i++) this.buf.push(createListener());
    this.partner = new PartnerOfficer(this.cfg, {
      say: (text) => deps.bus.emit('tactical:partner', { text }),
      occupied: (building, room) => this.roomOccupied(building, room),
    });
    this.offs.push(
      deps.bus.on('radio:start', (e) => {
        if (!e.tx.audible) return;
        const s = this.cfg.sound.sources;
        this.queueAtOfficer('radioChirp', deps.radioEarpiece() ? s.radioEarpiece : s.radioChirp);
      }),
      deps.bus.on('contact:line', (e) => {
        if (e.speaker === 'officer') this.queueAtOfficer('voiceTalk', sourceLevel('voiceTalk', this.cfg));
      }),
      deps.bus.on('force:used', (e) => {
        if (e.kind === 'taser') this.queueAtOfficer('taser', sourceLevel('taser', this.cfg));
      }),
    );
  }

  get stance(): Readonly<StanceState> {
    return this.stanceState;
  }

  get flashlightOn(): boolean {
    return this.flashlight;
  }

  /** True while the officer is slicing a doorway (the session then moves them with `sliceMove`). */
  get slicing(): boolean {
    return this.slicingValue;
  }

  /** Last officer-made sound level / 100 (0..1), decaying 0.5 per second. */
  get noise(): number {
    return this.noiseValue;
  }

  /** Highest exposure x light x facing over the listeners at the last notice pass (0..1). */
  get visibility(): number {
    return this.visibilityValue;
  }

  /** Queues a request; applied at the start of the next step. */
  request(r: TacticalRequest): void {
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push(r);
  }

  /** Held inputs read in the fixed step: lean direction (Q / R) and slice (RMB). */
  setHeld(lean: -1 | 0 | 1, slice: boolean): void {
    this.heldLean = lean;
    this.heldSlice = slice;
  }

  /** Movement multiplier for the current stance (walk speed x this; pass sprint false while crouched). */
  speedFactor(): number {
    return speedFactor(this.stanceState, this.cfg);
  }

  /**
   * While slicing: the velocity (m/s) and yaw that move the officer from (x, z) one slicing step in `dt` seconds.
   * Returns false (out untouched) when not slicing.
   */
  sliceMove(x: number, z: number, forward: number, strafe: number, dt: number, out: { vx: number; vz: number; yaw: number }): boolean {
    if (!this.slicingValue) return false;
    sliceStep(x, z, this.sliceDoor, forward, strafe, dt, this.cfg, this.sliceOut);
    out.vx = dt > 0 ? (this.sliceOut.x - x) / dt : 0;
    out.vz = dt > 0 ? (this.sliceOut.z - z) / dt : 0;
    out.yaw = this.sliceOut.yaw;
    return true;
  }

  /** Eye offset from the feet for the first-person camera. */
  eye(yaw: number, out: { x: number; y: number; z: number; roll: number }): void {
    eyeOffset(this.stanceState, yaw, this.cfg, out);
  }

  /** Places the partner beside (x, z) after a level change (follow mode only). */
  teleportPartner(building: number, x: number, z: number, yaw: number): void {
    this.partner.teleport(building, x, z, yaw, this.deps.interiors);
  }

  step(dt: number, _t: { sim: number; game: number }): void {
    const o = this.deps.officer(this.pose);
    this.applyRequests(o);
    const st = this.stanceState;
    if (!o.onFoot && st.crouched) {
      st.crouched = false;
      this.deps.bus.emit('tactical:stance', { crouched: false });
    }
    st.lean = o.onFoot ? this.heldLean : 0;
    stepLean(st, dt, this.cfg);
    this.updateSlicing(o);
    this.footsteps(dt, o);
    this.propagate(o);
    this.notice(dt, o);
    this.noiseValue = Math.max(0, this.noiseValue - NOISE_DECAY_PER_S * dt);
    this.partner.step(dt, o, this.deps.interiors);
  }

  serialize(): TacticalSave {
    const base = defaultTacticalSave(this.deps.rng.state());
    const pendingSounds: PendingSoundSave[] = [];
    for (let i = 0; i < this.pendingCount; i++) {
      const p = this.pending[i] as PendingSound;
      pendingSounds.push({ kind: p.kind, x: p.x, z: p.z, building: p.building, level: p.level });
    }
    return {
      ...base,
      crouched: this.stanceState.crouched,
      lean: this.stanceState.lean,
      leanAmount: this.stanceState.leanAmount,
      flashlight: this.flashlight,
      footTimer: this.footTimer,
      noticeTimer: this.noticeTimer,
      noise: this.noiseValue,
      partner: this.partner.serialize(),
      queue: this.queue.map((r) => ({ ...r })),
      pendingSounds,
    };
  }

  restore(s: TacticalSave): void {
    this.deps.rng.restore(s.rng);
    this.stanceState.crouched = s.crouched;
    this.stanceState.lean = s.lean;
    this.stanceState.leanAmount = s.leanAmount;
    this.flashlight = s.flashlight;
    this.footTimer = s.footTimer;
    this.noticeTimer = s.noticeTimer;
    this.noiseValue = s.noise;
    this.visibilityValue = 0;
    this.slicingValue = false;
    this.heldLean = 0;
    this.heldSlice = false;
    this.queue = s.queue.map((r) => ({ ...r }));
    this.pendingCount = 0;
    for (const p of s.pendingSounds) this.queueSound(p.kind, p.x, p.z, p.building, p.level);
    this.partner.restore(s.partner);
    this.graphs.clear();
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  // --- requests and sound queue ----------------------------------------------------------------------------

  private applyRequests(o: OfficerPose): void {
    const queue = this.queue;
    if (queue.length === 0) return;
    const bus = this.deps.bus;
    for (let i = 0; i < queue.length; i++) {
      const r = queue[i] as TacticalRequest;
      switch (r.kind) {
        case 'crouch':
          if (o.onFoot) {
            this.stanceState.crouched = !this.stanceState.crouched;
            bus.emit('tactical:stance', { crouched: this.stanceState.crouched });
          }
          break;
        case 'flashlight':
          this.flashlight = !this.flashlight;
          bus.emit('tactical:flashlight', { on: this.flashlight });
          this.queueSound('flashlightClick', o.x, o.z, o.building, sourceLevel('flashlightClick', this.cfg));
          break;
        case 'partner': {
          const text = this.partner.command(r.command, o, this.deps.interiors);
          if (text !== null) bus.emit('tactical:partner', { text });
          break;
        }
        case 'sound':
          this.queueSound(r.source, r.x, r.z, r.building, r.level ?? sourceLevel(r.source, this.cfg));
          break;
      }
    }
    queue.length = 0;
  }

  private queueAtOfficer(kind: SoundKind, level: number): void {
    const o = this.deps.officer(this.pose);
    this.queueSound(kind, o.x, o.z, o.building, level);
  }

  private queueSound(kind: SoundKind, x: number, z: number, building: number, level: number): void {
    if (this.pendingCount >= MAX_PENDING || !(level > -Infinity)) return;
    const p = this.pending[this.pendingCount++] as PendingSound;
    p.kind = kind;
    p.x = x;
    p.z = z;
    p.building = building;
    p.level = level;
  }

  // --- stance, slicing, footsteps --------------------------------------------------------------------------

  private updateSlicing(o: OfficerPose): void {
    if (!this.heldSlice || !o.onFoot || o.building < 0) {
      this.slicingValue = false;
      return;
    }
    const layout = this.deps.interiors.layout(o.building);
    if (layout === null) {
      this.slicingValue = false;
      return;
    }
    if (this.slicingValue) {
      // Keep the engaged doorway while it stays open and the officer stays in the building.
      this.stateBuilding = o.building;
      const s = this.stateOf(this.sliceIndex);
      const wide = (layout.doors[this.sliceIndex]?.kind ?? '') === 'wide';
      if (this.sliceBuilding === o.building && (wide || s === 'open' || s === 'broken')) return;
      this.slicingValue = false;
    }
    this.stateBuilding = o.building;
    const idx = pickSliceDoor(layout, this.stateOf, o.x, o.z, o.yaw, this.cfg, this.sliceDoor);
    this.slicingValue = idx >= 0;
    this.sliceIndex = idx;
    this.sliceBuilding = o.building;
  }

  private footsteps(dt: number, o: OfficerPose): void {
    if (!o.onFoot || !(o.speed >= 0.3)) {
      this.footTimer = 0;
      return;
    }
    this.footTimer -= dt;
    if (this.footTimer > 0) return;
    const crouched = this.stanceState.crouched;
    const level = footstepLevel(this.surfaceName(o), o.speed, crouched, this.cfg);
    const gait = this.cfg.sound.footstepIntervalS;
    const interval = crouched ? gait.crouch : o.speed > 5 ? gait.run : gait.walk;
    this.footTimer = interval * (0.9 + 0.2 * this.deps.rng.next());
    this.queueSound('footstep', o.x, o.z, o.building, level);
  }

  private surfaceName(o: OfficerPose): string {
    if (o.building >= 0) {
      const layout = this.deps.interiors.layout(o.building);
      if (layout === null) return 'concrete';
      const room = roomAt(layout, o.x, o.z);
      return room < 0 ? 'concrete' : (layout.rooms[room] as InteriorLayout['rooms'][number]).surface;
    }
    return SURFACE_NAMES[this.deps.city.surfaceAt(o.x, o.z)] ?? 'asphalt';
  }

  // --- sound field -----------------------------------------------------------------------------------------

  private propagate(o: OfficerPose): void {
    const n = this.pendingCount;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const s = this.pending[i] as PendingSound;
      if (s.building === o.building && Math.hypot(s.x - o.x, s.z - o.z) <= OFFICER_NEAR) {
        this.noiseValue = Math.min(1, Math.max(this.noiseValue, s.level / 100));
        const e = this.soundEvent;
        e.kind = s.kind;
        e.x = s.x;
        e.z = s.z;
        e.building = s.building;
        e.level = s.level;
        this.deps.bus.emit('tactical:sound', e);
      }
      this.soundField(s);
    }
    this.pendingCount = 0;
  }

  /** Stimulates every listener that hears `s`. */
  private soundField(s: PendingSound): void {
    const buf = this.buf;
    const count = Math.min(this.deps.listeners.listeners(s.x, s.z, this.cfg.sound.listenRadiusM, buf), buf.length);
    let cachedB = -2;
    let layout: InteriorLayout | null = null;
    let graph: SoundGraph | null = null;
    for (let i = 0; i < count; i++) {
      const l = buf[i] as Listener;
      let b = s.building;
      if (l.building !== s.building) {
        if (l.building >= 0 && s.building >= 0) continue;
        b = Math.max(l.building, s.building);
      }
      if (b !== cachedB) {
        cachedB = b;
        layout = b >= 0 ? this.deps.interiors.layout(b) : null;
        graph = layout === null ? null : this.graphFor(b, layout);
      }
      const srcNode = layout !== null && s.building === b ? roomAt(layout, s.x, s.z) : -1;
      const dstNode = layout !== null && l.building === b ? roomAt(layout, l.x, l.z) : -1;
      const level = receivedLevel(s.level, srcNode, s.x, s.z, dstNode, l.x, l.z, graph);
      const amount = stimulus(level, hearingThreshold(l.hearing, l.asleep, this.cfg), this.cfg);
      if (amount > 0) this.deps.listeners.stimulate(l.actorId, 'sound', amount, s.x, s.z);
    }
  }

  private graphFor(building: number, layout: InteriorLayout): SoundGraph {
    this.stateBuilding = building;
    const revision = this.deps.interiors.doorRevision(building);
    let e = this.graphs.get(building);
    if (e === undefined) {
      if (this.graphs.size >= MAX_GRAPHS) this.graphs.clear();
      e = { graph: buildSoundGraph(layout, this.stateOf, this.cfg, revision) };
      this.graphs.set(building, e);
    } else {
      e.graph = buildSoundGraph(layout, this.stateOf, this.cfg, revision, e.graph);
    }
    return e.graph;
  }

  // --- notice ----------------------------------------------------------------------------------------------

  private notice(dt: number, o: OfficerPose): void {
    const c = this.cfg.notice;
    this.noticeTimer += dt;
    if (this.noticeTimer < c.periodS) return;
    this.noticeTimer = Math.min(this.noticeTimer - c.periodS, c.periodS);
    const q = this.deps.interiors;
    const buf = this.buf;
    const count = Math.min(this.deps.listeners.listeners(o.x, o.z, c.rangeM, buf), buf.length);
    const layout = o.building >= 0 ? q.layout(o.building) : null;
    this.stateBuilding = o.building;
    const pts = bodyPoints(o.x, o.z, o.yaw, this.stanceState, this.cfg, this.points);
    let light: number;
    if (layout !== null) light = q.roomLit(o.building, roomAt(layout, o.x, o.z)) ? 1 : c.darkFactor;
    else light = 1 - c.nightOutdoor * Math.min(1, Math.max(0, this.deps.nightFactor()));
    const fwdX = -Math.sin(o.yaw);
    const fwdZ = -Math.cos(o.yaw);
    const cosBeam = Math.cos(c.flashlightCone);
    let vis = 0;
    for (let i = 0; i < count; i++) {
      const l = buf[i] as Listener;
      if (l.building !== o.building) continue;
      const dx = o.x - l.x;
      const dz = o.z - l.z;
      const d = Math.hypot(dx, dz);
      if (d > c.rangeM) continue;
      if (this.flashlight && d <= c.flashlightRange && (d < 1e-6 || (-dx * fwdX - dz * fwdZ) / d >= cosBeam)) {
        // The beam must reach the listener's eyes.
        if (layout === null || lineOfSight(layout, this.isOpen, pts[0] as number, pts[1] as number, pts[2] as number, l.x, l.eyeY, l.z)) {
          this.deps.listeners.stimulate(l.actorId, 'light', c.lightRate * c.periodS, o.x, o.z);
        }
      }
      if (l.asleep) continue;
      const fov = d < 1e-6 || (-Math.sin(l.yaw) * dx + -Math.cos(l.yaw) * dz) / d >= c.fovCos ? 1 : c.peripheral;
      const seen = exposure(layout, this.isOpen, l.x, l.eyeY, l.z, pts) * light * fov;
      if (seen > vis) vis = seen;
      const amount = seen * c.sightRate * c.periodS * (1 - d / c.rangeM);
      if (amount > 0) this.deps.listeners.stimulate(l.actorId, 'sight', amount, o.x, o.z);
    }
    this.visibilityValue = vis;
  }

  /** True when an awake listener stands in `room` of `building` (the partner's "Contact!"). */
  private roomOccupied(building: number, room: number): boolean {
    const layout = this.deps.interiors.layout(building);
    if (layout === null || room < 0) return false;
    const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const buf = this.buf;
    const count = Math.min(this.deps.listeners.listeners(cx, cz, Math.hypot(r.maxX - r.minX, r.maxZ - r.minZ) / 2 + 1, buf), buf.length);
    for (let i = 0; i < count; i++) {
      const l = buf[i] as Listener;
      if (l.building === building && !l.asleep && roomAt(layout, l.x, l.z) === room) return true;
    }
    return false;
  }
}
