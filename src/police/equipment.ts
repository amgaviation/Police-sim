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
  /** Person id in the cage, -1 empty. */
  prisoner: number;
}

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
    s.prisoner >= -1
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
  private cage = -1;
  private lastLightbar = false;

  constructor(spec: VehicleEquipmentSpec) {
    this.spec = spec;
    this.toneIndex = Math.max(0, SIREN_TONES.indexOf(DEFAULT_SIREN_TONE));
    if (spec.rack) this.racked.fill(1);
    const lo = loadout(spec);
    TRUNK_ITEMS.forEach((it, i) => {
      this.trunk[i] = lo[it.id] ?? 0;
    });
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

  // --- cage ----------------------------------------------------------------------

  /** Person id in the rear cage, -1 when empty. */
  get prisoner(): number {
    return this.cage;
  }

  /** Needs a partition and an empty seat. */
  seatPrisoner(personId: number): boolean {
    if (!this.spec.partition || this.cage !== -1 || !Number.isInteger(personId) || personId < 0) return false;
    this.cage = personId;
    return true;
  }

  /** Empties the seat; returns who was in it (-1 when empty). */
  releasePrisoner(): number {
    const id = this.cage;
    this.cage = -1;
    return id;
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
    return {
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
      prisoner: this.cage,
    };
  }

  /**
   * Rebuilds the equipment from a save. Unknown ids (pattern, tone, items) fall back to the defaults
   * of a new car; values are clamped to the limits and to what `spec` supports.
   */
  static restore(spec: VehicleEquipmentSpec, save: EquipmentSave): PatrolEquipment {
    const eq = new PatrolEquipment(spec);
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
    if (spec.partition && Number.isInteger(save.prisoner) && save.prisoner >= 0) eq.cage = save.prisoner;
    return eq;
  }
}
