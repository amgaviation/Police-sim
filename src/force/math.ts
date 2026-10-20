import type { Rng } from '../core/rng';

/** Standard normal from exactly two `rng.next()` draws (Box-Muller, u1 clamped to >= 1e-12). */
export function gauss(rng: Rng): number {
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
