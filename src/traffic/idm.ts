/**
 * Intelligent Driver Model (Treiber): longitudinal acceleration of a follower.
 * a = aMax [1 - (v / v0)^4 - (s* / gap)^2], s* = s0 + max(0, v T + v dv / (2 sqrt(aMax b))).
 */

/** Jam distance: bumper gap kept to a stopped leader (m). */
export const IDM_S0 = 2;

/**
 * Raw IDM acceleration (m/s²); the caller clamps braking to the model's `maxDecel`.
 * `gap` is the bumper-to-bumper distance to the leader (Infinity = free road), `dv` the approach rate
 * (own speed minus leader speed), `v0` the desired speed, `T` the time headway, `b` the comfortable decel.
 */
export function idmAccel(v: number, v0: number, gap: number, dv: number, aMax: number, b: number, T: number, s0 = IDM_S0): number {
  const ratio = v / (v0 > 0.1 ? v0 : 0.1);
  const free = 1 - ratio * ratio * ratio * ratio;
  if (gap === Infinity) return aMax * free;
  const dyn = v * T + (v * dv) / (2 * Math.sqrt(aMax * b));
  const sStar = s0 + (dyn > 0 ? dyn : 0);
  const g = gap > 0.1 ? gap : 0.1;
  const inter = sStar / g;
  return aMax * (free - inter * inter);
}
