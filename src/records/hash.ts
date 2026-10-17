import { createRng, normalizeSeed } from '../core/rng';

/**
 * Integer hashing and modular helpers for the records module. Everything is pure 32-bit /
 * exact-double arithmetic, so results are identical across engines and sessions.
 */

const TWO_POW_32 = 4294967296;
const GOLDEN = 0x9e3779b9;

/** Bijective 32-bit mixer (lowbias32). */
export function mix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uint32 hash of (seed, salt, id); `salt` separates independent properties of the same id. */
export function hash3(seed: number, salt: number, id: number): number {
  const base = mix32((normalizeSeed(seed) ^ Math.imul(salt, GOLDEN)) >>> 0);
  return mix32((base + (id >>> 0)) >>> 0);
}

/** Uniform float in [0, 1) from (seed, salt, id). */
export function unitHash(seed: number, salt: number, id: number): number {
  return hash3(seed, salt, id) / TWO_POW_32;
}

/**
 * a * b mod m for non-negative integers a, b < m and m < 2^34: b is split into 16-bit halves so
 * no intermediate product leaves the exact double range (< 2^53).
 */
export function mulMod(a: number, b: number, m: number): number {
  const hi = Math.floor(b / 65536);
  const lo = b % 65536;
  return (((a * hi) % m) * 65536 + a * lo) % m;
}

/** Modular inverse of a mod m (a coprime to m), extended Euclid. */
export function modInverse(a: number, m: number): number {
  let t = 0, nt = 1, r = m, nr = a % m;
  while (nr !== 0) {
    const q = Math.floor(r / nr);
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  if (r !== 1) throw new RangeError(`modInverse: ${a} is not invertible mod ${m}`);
  return t < 0 ? t + m : t;
}

/** Non-negative a mod m. */
export function posMod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

const offsets = new Map<string, number>();

/**
 * Seed-dependent constant in [0, size) drawn once from `createRng(seed).stream(name)` and memoised
 * (a handful of seeds per run; the memo is cleared when it grows).
 */
export function seedOffset(seed: number, name: string, size: number): number {
  const key = `${normalizeSeed(seed)}:${name}:${size}`;
  let v = offsets.get(key);
  if (v === undefined) {
    if (offsets.size > 256) offsets.clear();
    v = createRng(seed).stream(name).nextInt(0, size - 1);
    offsets.set(key, v);
  }
  return v;
}
