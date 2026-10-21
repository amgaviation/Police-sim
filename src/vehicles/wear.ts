import type { WearSpec } from './model';

/** Oil, tyre tread (FL, FR, RL, RR, 1 = new) and distance of one vehicle. */
export interface WearState {
  oilL: number;
  readonly tread: Float32Array;
  odometerM: number;
  /**
   * Full-precision twin of `tread`: a per-step loss is far below a float32 step, so wear is accumulated here and
   * rounded into `tread`. A write to `tread` that no longer matches it wins (see `stepWear`).
   */
  readonly exact?: Float64Array;
}

export interface WearInputs {
  /** Engine work this step (kW). */
  engineKw: number;
  dt: number;
  /** Distance rolled this step (m). */
  distanceM: number;
  running: boolean;
  /** 1 per slipping wheel (locked or sliding under the handbrake), 4 entries. */
  slipping: Uint8Array;
}

/** Full oil, new tyres, odometer 0. */
export function createWearState(spec: WearSpec): WearState {
  const tread = new Float32Array(4);
  tread.fill(1);
  return { oilL: spec.oilL, tread, odometerM: 0, exact: new Float64Array(4).fill(1) };
}

/**
 * Updates `s` in place: oil burns with engine work, tread with distance and slip, the odometer with distance.
 * Returns the engine health to subtract this step (0 unless the oil is empty and the engine runs). Allocation-free.
 */
export function stepWear(s: WearState, spec: WearSpec, i: WearInputs): number {
  if (i.running) s.oilL = Math.max(0, s.oilL - ((i.engineKw * i.dt) / 3600) * spec.oilPerKWh);
  const rolled = (i.distanceM / 1000) * spec.treadPerKm;
  const slip = spec.treadSlipPerS * i.dt;
  const exact = s.exact;
  for (let w = 0; w < 4; w++) {
    let tread = s.tread[w] ?? 0;
    const full = exact?.[w];
    if (full !== undefined && Math.fround(full) === tread) tread = full;
    tread = Math.max(0, tread - rolled - (i.slipping[w] === 1 ? slip : 0));
    s.tread[w] = tread;
    if (exact) exact[w] = tread;
  }
  s.odometerM += i.distanceM;
  return i.running && s.oilL <= 0 ? spec.oilWearPerS * i.dt : 0;
}

/**
 * Grip factor of one tyre: `lerp(minTreadGrip - wetTreadPenalty * wetness, 1, tread)` clamped to [0.3, 1]
 * (exactly 1 for a new tyre).
 */
export function treadGrip(tread: number, wetness: number, spec: WearSpec): number {
  const t = tread < 0 ? 0 : tread > 1 ? 1 : tread;
  const w = wetness < 0 ? 0 : wetness > 1 ? 1 : wetness;
  const g = (spec.minTreadGrip - spec.wetTreadPenalty * w) * (1 - t) + t;
  return g < 0.3 ? 0.3 : g > 1 ? 1 : g;
}
