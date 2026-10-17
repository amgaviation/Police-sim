/** Largest crumple (m) of one end or side at full zone damage. */
export const MAX_CRUMPLE = 0.25;
/** Largest blend toward the damage grey. */
export const MAX_TINT = 0.6;

/** Body deformation in the vehicle frame: size multipliers, centre shift (m) and colour tint 0..MAX_TINT. */
export interface DamageTransform {
  scaleX: number;
  scaleZ: number;
  offsetX: number;
  offsetZ: number;
  tint: number;
}

function unit(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Crumple and tint for zone damage (front, rear, left, right, each 0..1). Each zone pushes its face in
 * by up to `MAX_CRUMPLE` m along its axis, so the box shrinks and its centre moves away from the hit
 * (front = -Z, left = -X). `length` and `width` are the body box size the scales refer to. The tint
 * grows with the summed damage; every output is monotonic in each zone and bounded.
 */
export function damageTransform(
  front: number,
  rear: number,
  left: number,
  right: number,
  out: DamageTransform,
  length = 1,
  width = 1,
): DamageTransform {
  const f = unit(front) * MAX_CRUMPLE;
  const r = unit(rear) * MAX_CRUMPLE;
  const lt = unit(left) * MAX_CRUMPLE;
  const rt = unit(right) * MAX_CRUMPLE;
  out.scaleZ = Math.max(0.5, 1 - (f + r) / length);
  out.scaleX = Math.max(0.5, 1 - (lt + rt) / width);
  out.offsetZ = (f - r) / 2;
  out.offsetX = (lt - rt) / 2;
  out.tint = MAX_TINT * Math.min(1, (unit(front) + unit(rear) + unit(left) + unit(right)) / 2);
  return out;
}
