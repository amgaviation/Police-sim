/**
 * Deterministic PRNG: xoshiro128** seeded through splitmix32.
 * All arithmetic is on unsigned 32-bit integers so sequences are identical
 * across engines and sessions.
 */

/** Serializable snapshot of a generator; restore with `Rng.restore`. */
export interface RngState {
  readonly seed: number;
  readonly s: readonly [number, number, number, number];
}

export interface Rng {
  /** Normalized 32-bit root seed of this generator. */
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, maxInclusive]. */
  nextInt(min: number, maxInclusive: number): number;
  /** Uniform float in [min, max). */
  nextFloat(min: number, max: number): number;
  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean;
  /** Uniformly chosen element; throws on an empty array. */
  pick<T>(arr: readonly T[]): T;
  /** In-place Fisher-Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[];
  /** Normally distributed sample (Box-Muller). */
  gaussian(mean?: number, sd?: number): number;
  /**
   * Child generator derived from this generator's seed and `name`.
   * The same name always yields the same stream, regardless of how many
   * numbers were drawn or which other streams were created before.
   */
  stream(name: string): Rng;
  state(): RngState;
  restore(state: RngState): void;
}

const TWO_POW_32 = 4294967296;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a hash of a string (optionally chained from a prior hash). */
export function hashString(text: string, basis: number = FNV_OFFSET): number {
  let h = basis >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

/** Converts a number or string seed to its canonical unsigned 32-bit form. */
export function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'string') return hashString(seed);
  return Number.isFinite(seed) ? seed >>> 0 : 0;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < TWO_POW_32;
}

class Xoshiro128 implements Rng {
  readonly seed: number;
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.reseed(seed);
  }

  private reseed(seed: number): void {
    const mix = splitmix32(seed);
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    // xoshiro must never sit on the all-zero state.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  private nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  next(): number {
    return this.nextUint32() / TWO_POW_32;
  }

  nextInt(min: number, maxInclusive: number): number {
    const lo = Math.ceil(min);
    const hi = Math.floor(maxInclusive);
    if (!(hi >= lo)) throw new RangeError(`nextInt: empty range [${min}, ${maxInclusive}]`);
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new RangeError('pick: empty array');
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }

  gaussian(mean = 0, sd = 1): number {
    // Box-Muller; u1 is kept away from 0 so the log is finite.
    const u1 = 1 - this.next();
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * sd;
  }

  stream(name: string): Rng {
    const childSeed = hashString(name, hashString(String(this.seed)));
    return new Xoshiro128(childSeed);
  }

  state(): RngState {
    return { seed: this.seed, s: [this.s0, this.s1, this.s2, this.s3] };
  }

  restore(state: RngState): void {
    const s = state.s;
    if (!isUint32(s[0]) || !isUint32(s[1]) || !isUint32(s[2]) || !isUint32(s[3])) {
      throw new TypeError('restore: invalid RngState');
    }
    this.s0 = s[0];
    this.s1 = s[1];
    this.s2 = s[2];
    this.s3 = s[3];
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }
}

/** Creates a generator from a numeric or string seed. */
export function createRng(seed: number | string): Rng {
  return new Xoshiro128(normalizeSeed(seed));
}

/** Rebuilds a generator from a serialized state. */
export function rngFromState(state: RngState): Rng {
  const rng = new Xoshiro128(normalizeSeed(state.seed));
  rng.restore(state);
  return rng;
}
