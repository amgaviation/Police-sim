/**
 * Two-argument `Math.hypot` without its allocations. V8's builtin takes a rest list and allocates a scratch array
 * and a boxed result on every call; this is the same algorithm (scale both magnitudes by the larger one, add the
 * squares, one square root, scale back) written for two numbers, so results are bit-identical to `Math.hypot(a, b)`
 * in V8 and the simulation stays deterministic. The Kahan compensation of the builtin is exactly zero after its
 * first term, so two terms need none. `test/traffic/fastMath.test.ts` compares the two over millions of pairs.
 */
export function hypot2(a: number, b: number): number {
  const x = a < 0 ? -a : a;
  const y = b < 0 ? -b : b;
  if (x === Infinity || y === Infinity) return Infinity;
  if (x !== x || y !== y) return NaN;
  const max = x > y ? x : y;
  if (max === 0) return 0;
  const nx = x / max;
  const ny = y / max;
  return Math.sqrt(nx * nx + ny * ny) * max;
}
