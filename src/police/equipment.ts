import type { EntityId } from 'bitecs';
import { PoliceLights, SIREN_FLAG } from './components';
import { EQUIPMENT_DATA, SIREN_TONE_NAMES, type RackItem, type SirenTone, type SpotlightSpec } from './data';
import { TRUNK_ITEMS, type OfficerKit } from './inventory';
import { LIGHTBAR_PATTERNS, patternIndex } from './lightbar';

export type { RackItem, SirenTone, SpotlightSpec } from './data';

/** Siren tones in `equipment.json` order (each validated against the `SirenTone` union). */
export const SIREN_TONES: readonly SirenTone[] = EQUIPMENT_DATA.siren.tones;
export const DEFAULT_SIREN_TONE: SirenTone = EQUIPMENT_DATA.siren.defaultTone;
/** Spotlight limits, defaults and mouse aim rate. */
export const SPOTLIGHT: SpotlightSpec = EQUIPMENT_DATA.spotlight;
/** Long guns in the rack, in data order. */
export const RACK_ITEMS: readonly RackItem[] = EQUIPMENT_DATA.rack.items;
/** Unlocking the rack needs the car stopped. */
export const RACK_UNLOCK_REQUIRES_STOP: boolean = EQUIPMENT_DATA.rack.unlockRequiresStop;

export function isSirenTone(x: unknown): x is SirenTone {
  return typeof x === 'string' && (SIREN_TONE_NAMES as readonly string[]).includes(x);
}

/** A vehicle model's `equipment` section (design §4.4). */
export interface VehicleEquipmentSpec {
  readonly pushBumper: { readonly frontStrength: number; readonly engineShare: number } | null;
  readonly partition: boolean;
  readonly rack: boolean;
  readonly spotlight: boolean;
  readonly mdt: boolean;
  /** `trunkLoadouts` id in equipment.json; null for an empty trunk. */
  readonly trunk: string | null;
}

/** Persisted `PatrolEquipment` (one per patrol car in save v4). */
export interface EquipmentSave {
  version: 1;
  sirenOn: boolean;
  tone: SirenTone;
  /** Pattern id, not index (data order may change). */
  pattern: string;
  spotOn: boolean;
  spotYaw: number;
  spotPitch: number;
  rackLocked: boolean;
  /** Rack item id -> in the rack. */
  racked: Record<string, boolean>;
  /** Trunk item id -> count. */
  trunk: Record<string, number>;
  /** Person id in cage seat 1, -1 empty. */
  prisoner: number;
  /** Person ids in cage seats 2..n (-1 empty); absent for single-seat cages and in older saves. */
  extraPrisoners?: number[];
}

/** Spawn-time options of a `PatrolEquipment` (Phase 7: fleet loadouts and multi-seat cages). */
export interface PatrolEquipmentOptions {
  /** Cage seats (default 1; 0 forces no cage even with a partition; ignored without a partition). */
  readonly cageSeats?: number;
  /** Trunk item id -> count; replaces the model's trunk loadout. */
  readonly trunk?: Readonly<Record<string, number>>;
  /** Racked long gun ids; default every rack item except `lessLethal` when the model has a rack. */
  readonly rack?: readonly string[];
}

/** The rack item that is not racked unless a vehicle loadout asks for it. */
const OPTIONAL_RACK_ITEM = 'lessLethal';
/** Most cage seats (a sanity bound for saves). */
const MAX_CAGE_SEATS = 16;

function isRecordOf(x: unknown, check: (v: unknown) => boolean): boolean {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.values(x).every(check);
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function isEquipmentSave(x: unknown): x is EquipmentSave {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.sirenOn === 'boolean' &&
    isSirenTone(s.tone) &&
    typeof s.pattern === 'string' &&
    typeof s.spotOn === 'boolean' &&
    isFiniteNumber(s.spotYaw) &&
    isFiniteNumber(s.spotPitch) &&
    typeof s.rackLocked === 'boolean' &&
    isRecordOf(s.racked, (v) => typeof v === 'boolean') &&
    isRecordOf(s.trunk, isCount) &&
    typeof s.prisoner === 'number' &&
    Number.isInteger(s.prisoner) &&
    s.prisoner >= -1 &&
    (s.extraPrisoners === undefined ||
      (Array.isArray(s.extraPrisoners) && s.extraPrisoners.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= -1)))
  );
}

const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

function loadout(spec: VehicleEquipmentSpec): Readonly<Record<string, number>> {
  if (spec.trunk === null) return {};
  const lo = EQUIPMENT_DATA.trunkLoadouts[spec.trunk];
  if (lo === undefined) throw new Error(`Unknown trunk loadout "${spec.trunk}"`);
  return lo;
}

/**
 * One patrol car's equipment (design §11.3): siren controller, light-bar pattern, spotlight,
 * long-gun rack, trunk and rear cage. Pure state; `writeLook` publishes it to `PoliceLights`.
 */
export class PatrolEquipment {
  readonly spec: VehicleEquipmentSpec;
  /** Held this frame (set from input before the fixed steps). */
  horn = false;
  manual = false;

  private siren = false;
  private toneIndex: number;
  private patternIdx = 0;
  private spot = false;
  private yaw: number = SPOTLIGHT.defaultYaw;
  private pitch: number = SPOTLIGHT.defaultPitch;
  private locked = true;
  /** 1 = in the rack, per `RACK_ITEMS` index. */
  private readonly racked = new Uint8Array(RACK_ITEMS.length);
  /** Count per `TRUNK_ITEMS` index. */
  private readonly trunk = new Uint16Array(TRUNK_ITEMS.length);
  /** Person id per cage seat, -1 empty. */
  private readonly cage: Int32Array;
  private lastLightbar = false;

  constructor(spec: VehicleEquipmentSpec, opts: PatrolEquipmentOptions = {}) {
    this.spec = spec;
    this.toneIndex = Math.max(0, SIREN_TONES.indexOf(DEFAULT_SIREN_TONE));
    if (spec.rack) {
      RACK_ITEMS.forEach((r, i) => {
        this.racked[i] = (opts.rack === undefined ? r.id !== OPTIONAL_RACK_ITEM : opts.rack.includes(r.id)) ? 1 : 0;
      });
    }
    const lo = opts.trunk ?? loadout(spec);
    TRUNK_ITEMS.forEach((it, i) => {
      const c = lo[it.id];
      this.trunk[i] = typeof c === 'number' && Number.isInteger(c) && c > 0 ? Math.min(c, 0xffff) : 0;
    });
    const seats = spec.partition ? clamp(Math.trunc(opts.cageSeats ?? 1) || 0, 0, MAX_CAGE_SEATS) : 0;
    this.cage = new Int32Array(seats).fill(-1);
  }

  // --- siren ---------------------------------------------------------------------

  get sirenOn(): boolean {
    return this.siren;
  }

  get tone(): SirenTone {
    return SIREN_TONES[this.toneIndex] ?? DEFAULT_SIREN_TONE;
  }

  toggleSiren(): void {
    this.siren = !this.siren;
  }

  setSiren(on: boolean): void {
    this.siren = on;
  }

  /** Next tone in `SIREN_TONES` order, wrapping. */
  cycleTone(): void {
    this.toneIndex = (this.toneIndex + 1) % SIREN_TONES.length;
  }

  /** False (unchanged) when the tone is not in `SIREN_TONES`. */
  setTone(tone: SirenTone): boolean {
    const i = SIREN_TONES.indexOf(tone);
    if (i < 0) return false;
    this.toneIndex = i;
    return true;
  }

  // --- lights --------------------------------------------------------------------

  /** `LIGHTBAR_PATTERNS` index. */
  get pattern(): number {
    return this.patternIdx;
  }

  /** Light bar state passed to the last `writeLook` (on/off itself is `DrivableVehicle.lightbar`). */
  get lightsOn(): boolean {
    return this.lastLightbar;
  }

  cyclePattern(): void {
    this.patternIdx = (this.patternIdx + 1) % LIGHTBAR_PATTERNS.length;
  }

  /** Clamped to the pattern list; non-finite -> 0. */
  setPattern(index: number): void {
    this.patternIdx = Number.isFinite(index) ? clamp(Math.trunc(index), 0, LIGHTBAR_PATTERNS.length - 1) : 0;
  }

  // --- spotlight -----------------------------------------------------------------

  get spotOn(): boolean {
    return this.spot;
  }

  get spotYaw(): number {
    return this.yaw;
  }

  get spotPitch(): number {
    return this.pitch;
  }

  /** No-op on a car without a spotlight. */
  toggleSpot(): void {
    if (this.spec.spotlight) this.spot = !this.spot;
  }

  /** Adds to yaw/pitch (rad), clamped to the `SPOTLIGHT` limits. */
  aimSpot(dYaw: number, dPitch: number): void {
    if (Number.isFinite(dYaw)) this.yaw = clamp(this.yaw + dYaw, SPOTLIGHT.yawMin, SPOTLIGHT.yawMax);
    if (Number.isFinite(dPitch)) this.pitch = clamp(this.pitch + dPitch, SPOTLIGHT.pitchMin, SPOTLIGHT.pitchMax);
  }

  // --- rack ----------------------------------------------------------------------

  /** Always locked on a car without a rack. */
  get rackLocked(): boolean {
    return this.locked;
  }

  rackHas(itemId: string): boolean {
    return this.racked[RACK_ITEMS.findIndex((r) => r.id === itemId)] === 1;
  }

  /**
   * Locks or unlocks the rack. Unlocking is refused while moving (`stopped` false) when the data says
   * `unlockRequiresStop`; locking always works. False when nothing changed.
   */
  toggleRackLock(stopped: boolean): boolean {
    if (!this.spec.rack) return false;
    if (this.locked && RACK_UNLOCK_REQUIRES_STOP && !stopped) return false;
    this.locked = !this.locked;
    return true;
  }

  /** Takes a long gun out of the unlocked rack; the officer may carry one. */
  checkOut(itemId: string, kit: OfficerKit): boolean {
    const i = RACK_ITEMS.findIndex((r) => r.id === itemId);
    if (!this.spec.rack || this.locked || i < 0 || this.racked[i] !== 1 || kit.longGun !== null) return false;
    this.racked[i] = 0;
    kit.setLongGun(itemId);
    return true;
  }

  /** Puts the officer's long gun back in its (empty) slot. */
  checkIn(itemId: string, kit: OfficerKit): boolean {
    const i = RACK_ITEMS.findIndex((r) => r.id === itemId);
    if (!this.spec.rack || i < 0 || this.racked[i] === 1 || kit.longGun !== itemId) return false;
    this.racked[i] = 1;
    kit.setLongGun(null);
    return true;
  }

  // --- trunk ---------------------------------------------------------------------

  trunkCount(itemId: string): number {
    return this.trunk[TRUNK_ITEMS.findIndex((it) => it.id === itemId)] ?? 0;
  }

  /** Moves one item from the trunk to the officer (needs one in the trunk and room under `carryMax`). */
  take(itemId: string, kit: OfficerKit): boolean {
    const i = TRUNK_ITEMS.findIndex((it) => it.id === itemId);
    if (i < 0 || (this.trunk[i] ?? 0) === 0 || !kit.adjust(itemId, 1)) return false;
    this.trunk[i] = (this.trunk[i] ?? 0) - 1;
    return true;
  }

  /** Moves one carried item back into the trunk. */
  stow(itemId: string, kit: OfficerKit): boolean {
    const i = TRUNK_ITEMS.findIndex((it) => it.id === itemId);
    if (i < 0 || !kit.adjust(itemId, -1)) return false;
    this.trunk[i] = (this.trunk[i] ?? 0) + 1;
    return true;
  }

  /**
   * Resets the trunk to `trunk` and the rack to `rack` (a changed vehicle loadout). The rack lock stays; a long gun the
   * officer has checked out (`keepOut`) is not put back into its slot.
   */
  setStock(trunk: Readonly<Record<string, number>>, rack: readonly string[], keepOut: string | null): void {
    TRUNK_ITEMS.forEach((it, i) => {
      const c = trunk[it.id];
      this.trunk[i] = typeof c === 'number' && Number.isInteger(c) && c > 0 ? Math.min(c, 0xffff) : 0;
    });
    if (!this.spec.rack) return;
    RACK_ITEMS.forEach((r, i) => {
      this.racked[i] = rack.includes(r.id) && r.id !== keepOut ? 1 : 0;
    });
  }

  // --- cage ----------------------------------------------------------------------

  /** Number of cage seats (0 without a partition). */
  get cageSeats(): number {
    return this.cage.length;
  }

  /** Person id in the first occupied cage seat, -1 when the cage is empty. */
  get prisoner(): number {
    for (const id of this.cage) if (id !== -1) return id;
    return -1;
  }

  /** Everybody in the cage, in seat order. */
  prisoners(): number[] {
    const out: number[] = [];
    for (const id of this.cage) if (id !== -1) out.push(id);
    return out;
  }

  /** Empty seats. */
  cageFree(): number {
    let n = 0;
    for (const id of this.cage) if (id === -1) n++;
    return n;
  }

  /** Needs a partition, a free seat and a person who is not already in the cage; fills the first free seat. */
  seatPrisoner(personId: number): boolean {
    if (!Number.isInteger(personId) || personId < 0 || this.cage.includes(personId)) return false;
    const seat = this.cage.indexOf(-1);
    if (seat < 0) return false;
    this.cage[seat] = personId;
    return true;
  }

  /** True when `personId` sits in a cage seat. */
  hasPrisoner(personId: number): boolean {
    return personId >= 0 && this.cage.includes(personId);
  }

  /** Empties the seat of `personId`; false when they are not in the cage. */
  release(personId: number): boolean {
    const i = personId >= 0 ? this.cage.indexOf(personId) : -1;
    if (i < 0) return false;
    this.cage[i] = -1;
    return true;
  }

  /** Empties the last occupied seat; returns who was in it (-1 when the cage is empty). */
  releasePrisoner(): number {
    for (let i = this.cage.length - 1; i >= 0; i--) {
      const id = this.cage[i] ?? -1;
      if (id !== -1) {
        this.cage[i] = -1;
        return id;
      }
    }
    return -1;
  }

  /** Empties every seat; returns who was in the cage, in seat order. */
  releaseAll(): number[] {
    const out = this.prisoners();
    this.cage.fill(-1);
    return out;
  }

  // --- publish / persist ---------------------------------------------------------

  /** Writes `PoliceLights` for this car's entity (every fixed step); `lightbarOn` = `DrivableVehicle.lightbar`. */
  writeLook(eid: EntityId, lightbarOn: boolean): void {
    this.lastLightbar = lightbarOn;
    PoliceLights.pattern[eid] = this.patternIdx;
    PoliceLights.siren[eid] = this.siren ? 1 + this.toneIndex : 0;
    PoliceLights.sirenFlags[eid] = (this.horn ? SIREN_FLAG.horn : 0) | (this.manual ? SIREN_FLAG.manual : 0);
    PoliceLights.spot[eid] = this.spot ? 1 : 0;
    PoliceLights.spotYaw[eid] = this.yaw;
    PoliceLights.spotPitch[eid] = this.pitch;
  }

  serialize(): EquipmentSave {
    const racked: Record<string, boolean> = {};
    RACK_ITEMS.forEach((r, i) => {
      racked[r.id] = this.racked[i] === 1;
    });
    const trunk: Record<string, number> = {};
    TRUNK_ITEMS.forEach((it, i) => {
      trunk[it.id] = this.trunk[i] ?? 0;
    });
    const save: EquipmentSave = {
      version: 1,
      sirenOn: this.siren,
      tone: this.tone,
      pattern: LIGHTBAR_PATTERNS[this.patternIdx]?.id ?? '',
      spotOn: this.spot,
      spotYaw: this.yaw,
      spotPitch: this.pitch,
      rackLocked: this.locked,
      racked,
      trunk,
      prisoner: this.cage[0] ?? -1,
    };
    if (this.cage.length > 1) save.extraPrisoners = Array.from(this.cage.subarray(1));
    return save;
  }

  /**
   * Rebuilds the equipment from a save. Unknown ids (pattern, tone, items) fall back to the defaults
   * of a new car; values are clamped to the limits and to what `spec` supports.
   */
  static restore(spec: VehicleEquipmentSpec, save: EquipmentSave, opts?: PatrolEquipmentOptions): PatrolEquipment {
    const eq = new PatrolEquipment(spec, opts);
    eq.siren = save.sirenOn;
    eq.setTone(save.tone);
    eq.patternIdx = Math.max(0, patternIndex(save.pattern));
    eq.spot = spec.spotlight && save.spotOn;
    if (Number.isFinite(save.spotYaw)) eq.yaw = clamp(save.spotYaw, SPOTLIGHT.yawMin, SPOTLIGHT.yawMax);
    if (Number.isFinite(save.spotPitch)) eq.pitch = clamp(save.spotPitch, SPOTLIGHT.pitchMin, SPOTLIGHT.pitchMax);
    if (spec.rack) {
      eq.locked = save.rackLocked;
      RACK_ITEMS.forEach((r, i) => {
        const v = save.racked[r.id];
        if (typeof v === 'boolean') eq.racked[i] = v ? 1 : 0;
      });
    }
    TRUNK_ITEMS.forEach((it, i) => {
      const c = save.trunk[it.id];
      if (typeof c === 'number' && Number.isInteger(c) && c >= 0) eq.trunk[i] = Math.min(c, 0xffff);
    });
    const seated = [save.prisoner, ...(save.extraPrisoners ?? [])];
    for (let i = 0; i < eq.cage.length; i++) {
      const id = seated[i];
      if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && !eq.cage.includes(id)) eq.cage[i] = id;
    }
    return eq;
  }
}
