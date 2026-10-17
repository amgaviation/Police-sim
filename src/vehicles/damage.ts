import type { Rng } from '../core/rng';
import type { DamageSpec } from './model';

/** Damage zones, also the order of `VehicleLook.damage` and `DamageState.zones`. */
export const ZONE = { front: 0, rear: 1, left: 2, right: 3 } as const;
export type ZoneId = (typeof ZONE)[keyof typeof ZONE];
export const ZONE_NAMES = ['front', 'rear', 'left', 'right'] as const;
export type ZoneName = (typeof ZONE_NAMES)[number];

/** Wheel indices (chassis order). */
export const WHEEL = { FL: 0, FR: 1, RL: 2, RR: 3 } as const;

export interface DamageState {
  /** 0..1 per zone (front, rear, left, right). */
  readonly zones: Float32Array;
  engineHealth: number;
  /** 1 = flat, per wheel FL, FR, RL, RR. */
  readonly tireFlat: Uint8Array;
  engineFailed: boolean;
}

export interface ImpactResult {
  zone: ZoneId;
  amount: number;
  /** Wheel whose tyre burst on this impact, -1 if none. */
  tireBurst: number;
  /** The engine failed on this impact (it was running before). */
  engineFailedNow: boolean;
}

/** An impact direction counts as near a corner wheel when both components are at least this share of it. */
const CORNER_SHARE = 0.35;

export function createDamageState(): DamageState {
  return { zones: new Float32Array(4), engineHealth: 1, tireFlat: new Uint8Array(4), engineFailed: false };
}

export function resetDamageState(state: DamageState): void {
  state.zones.fill(0);
  state.tireFlat.fill(0);
  state.engineHealth = 1;
  state.engineFailed = false;
}

/**
 * Zone of an impact coming from chassis-local direction (localX, localZ) (-Z = front, +X = right):
 * the dominant axis wins, ties go to front/rear.
 */
export function impactZone(localX: number, localZ: number): ZoneId {
  if (Math.abs(localZ) >= Math.abs(localX)) return localZ < 0 ? ZONE.front : ZONE.rear;
  return localX < 0 ? ZONE.left : ZONE.right;
}

/** Corner wheel an oblique impact direction points at, or -1 for head-on / side-on hits. */
export function cornerWheel(localX: number, localZ: number): number {
  const ax = Math.abs(localX);
  const az = Math.abs(localZ);
  const len = Math.hypot(localX, localZ);
  if (len === 0 || ax < CORNER_SHARE * len || az < CORNER_SHARE * len) return -1;
  return (localZ < 0 ? 0 : 2) + (localX < 0 ? 0 : 1);
}

/**
 * Applies one impact of `impactSpeed` (m/s) from chassis-local direction (localX, localZ). Below
 * `minImpactSpeed` nothing happens. Zone damage grows by `impactSpeed / zoneStrength` (+-10 % from `rng`),
 * front hits also cost engine health (`engineFrontShare`); a push bumper replaces both for front hits by
 * `frontZoneStrength` / `frontEngineShare` when the spec has them. An engine below `failBelow` fails, and an impact
 * of at least `tireBurstSpeed` next to a wheel (`nearWheel`, -1 = none) flattens that tyre.
 */
export function applyImpact(
  state: DamageState,
  localX: number,
  localZ: number,
  impactSpeed: number,
  nearWheel: number,
  params: DamageSpec,
  rng: Rng,
  out: ImpactResult,
): ImpactResult {
  out.zone = impactZone(localX, localZ);
  out.amount = 0;
  out.tireBurst = -1;
  out.engineFailedNow = false;
  if (!(impactSpeed >= params.minImpactSpeed)) return out;

  const front = out.zone === ZONE.front;
  const strength = front ? (params.frontZoneStrength ?? params.zoneStrength) : params.zoneStrength;
  const amount = (impactSpeed / strength) * (0.9 + 0.2 * rng.next());
  out.amount = amount;
  state.zones[out.zone] = Math.min(1, (state.zones[out.zone] ?? 0) + amount);
  if (front) state.engineHealth = Math.max(0, state.engineHealth - amount * (params.frontEngineShare ?? params.engineFrontShare));
  if (!state.engineFailed && state.engineHealth < params.failBelow) {
    state.engineFailed = true;
    out.engineFailedNow = true;
  }
  if (nearWheel >= 0 && nearWheel < 4 && impactSpeed >= params.tireBurstSpeed && state.tireFlat[nearWheel] === 0) {
    state.tireFlat[nearWheel] = 1;
    out.tireBurst = nearWheel;
  }
  return out;
}

/**
 * Random stall roll for one step of a damaged running engine: below `stallBelow` health it stalls with
 * `stallChancePerS` per second for 1-3 s. Returns the stall duration, 0 for none (no draw when healthy).
 */
export function rollStall(state: DamageState, params: DamageSpec, dt: number, rng: Rng): number {
  if (state.engineFailed || state.engineHealth >= params.stallBelow) return 0;
  return rng.chance(params.stallChancePerS * dt) ? rng.nextFloat(1, 3) : 0;
}
