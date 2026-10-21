import type { Rng } from '../../core/rng';
import { VFX_DATA, type VfxTapeData, type VfxWetData } from './data';
import type { VfxParticleKind } from './types';

/** Pure helpers of the VFX module (presentation only; the shaders mirror them). */

/** Render clocks (particles, tape) wrap here so shader floats keep their precision. */
export const VFX_TIME_WRAP = 600;

/** Writable numeric triple / list (typed array or plain array). */
type Out = { [i: number]: number };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Position of a ballistic particle `age` seconds after birth (the vertex shader's formula):
 * `start + vel * age + 0.5 * (0, gravity, 0) * age^2`. Writes x, y, z to `out` and returns it.
 */
export function particleAt(start: ArrayLike<number>, vel: ArrayLike<number>, gravity: number, age: number, out: Out): Out {
  out[0] = (start[0] ?? 0) + (vel[0] ?? 0) * age;
  out[1] = (start[1] ?? 0) + (vel[1] ?? 0) * age + 0.5 * gravity * age * age;
  out[2] = (start[2] ?? 0) + (vel[2] ?? 0) * age;
  return out;
}

/**
 * Slot ranges to upload after writing `count` particles into a ring of `capacity` starting at slot `head`:
 * writes `[start0, length0, start1, length1]` to `out` and returns the number of ranges (0, 1 or 2). The ring
 * wraps, so a write crossing the end is two ranges; `count >= capacity` is the whole buffer.
 */
export function ringRanges(head: number, count: number, capacity: number, out: Out): number {
  if (capacity <= 0 || count <= 0) return 0;
  if (count >= capacity) {
    out[0] = 0;
    out[1] = capacity;
    return 1;
  }
  const start = ((head % capacity) + capacity) % capacity;
  const first = Math.min(count, capacity - start);
  out[0] = start;
  out[1] = first;
  if (first === count) return 1;
  out[2] = 0;
  out[3] = count - first;
  return 2;
}

/** One burst draw: particle count, and the speed / life of the first particle. */
export interface EmitSpec {
  count: number;
  speed: number;
  life: number;
}

/**
 * Draws a burst spec for `kind` from `rng` (count, then speed, then life from the kind's ranges in `vfx.json`).
 * Deterministic per rng state; the burst calls it once per particle and takes `count` from the first call.
 */
export function emitSpec(kind: VfxParticleKind, rng: Rng, out: EmitSpec, data = VFX_DATA): EmitSpec {
  const k = data.particles.kinds[kind];
  out.count = rng.nextInt(k.count[0], k.count[1]);
  out.speed = rng.nextFloat(k.speed[0], k.speed[1]);
  out.life = rng.nextFloat(k.lifeS[0], k.lifeS[1]);
  return out;
}

/**
 * Uniform random unit vector from `rng` into `out`; `hemisphere` limits it to y >= 0.
 */
export function randomDirection(rng: Rng, hemisphere: boolean, out: Out): Out {
  const u = rng.next();
  const y = hemisphere ? u : 2 * u - 1;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = rng.next() * Math.PI * 2;
  out[0] = r * Math.cos(phi);
  out[1] = y;
  out[2] = r * Math.sin(phi);
  return out;
}

/** Wind factor of the tape shader: `clamp(wind / windFull, 0.15, 1)`. */
export function tapeWind(windSpeed: number, tape: VfxTapeData = VFX_DATA.tape): number {
  return clamp(windSpeed / tape.windFull, 0.15, 1);
}

/**
 * Sideways offset (m) of a tape ribbon vertex at local `z` (0 at the post, -3 at the far end), mirroring the shader:
 * `amplitude * wind * sin(2 pi f t + z k + phase) * sin(pi * (-z / 3))`. `wind` is the `tapeWind` factor,
 * `phase` the per-instance phase (`instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61`).
 * Zero at z = 0 and z = -3; never beyond `amplitudeM`.
 */
export function tapeOffset(z: number, timeS: number, wind: number, phase: number, tape: VfxTapeData = VFX_DATA.tape): number {
  return (
    tape.amplitudeM * wind * Math.sin(2 * Math.PI * tape.freqHz * timeS + z * tape.waveK + phase) * Math.sin(Math.PI * (-z / 3))
  );
}

/** Per-instance tape phase from the instance's world x / z. */
export function tapePhase(x: number, z: number): number {
  return x * 0.37 + z * 0.61;
}

/** Wet-road material values. */
export interface WetParams {
  /** Effective wetness `wetness * (1 - snowCover)`, 0..1. */
  w: number;
  groundRoughness: number;
  markingsRoughness: number;
  /** Scalar multiplied into the ground colour, `1 - darken * w`. */
  groundTint: number;
}

/**
 * Wet-sheen mapping: roughness goes from dry to wet by `w = wetness * (1 - snowCover)` (markings use their own
 * wet value, `markingsDry` when dry) and the ground darkens by `darken * w`.
 */
export function wetParams(wetness: number, snowCover: number, markingsDry: number, out: WetParams, wet: VfxWetData = VFX_DATA.wet): WetParams {
  const w = clamp(wetness, 0, 1) * (1 - clamp(snowCover, 0, 1));
  out.w = w;
  out.groundRoughness = wet.dryRoughness + (wet.wetRoughness - wet.dryRoughness) * w;
  out.markingsRoughness = markingsDry + (wet.markingsWetRoughness - markingsDry) * w;
  out.groundTint = 1 - wet.darken * w;
  return out;
}

/**
 * Picks the `capacity` nearest entries to (cx, cz) within `maxDist` (horizontal), nearest first, by allocation-free
 * insertion. Entry i has x at `pos[i * stride]` and z at `pos[i * stride + 2]` (layout x, y, z, ...). Writes entry
 * indices to `out` and squared distances to `dist` (both at least `capacity` long) and returns how many were
 * written. Ties keep the lower index first.
 */
export function nearestN(
  pos: ArrayLike<number>,
  stride: number,
  count: number,
  cx: number,
  cz: number,
  maxDist: number,
  capacity: number,
  out: Int32Array,
  dist: Float64Array,
): number {
  const cap = Math.max(0, Math.min(capacity, out.length, dist.length));
  if (cap === 0) return 0;
  const maxSq = maxDist * maxDist;
  let filled = 0;
  for (let i = 0; i < count; i++) {
    const dx = (pos[i * stride] ?? 0) - cx;
    const dz = (pos[i * stride + 2] ?? 0) - cz;
    const dSq = dx * dx + dz * dz;
    if (!(dSq <= maxSq)) continue;
    let j = filled;
    if (j === cap) {
      if (dSq >= (dist[cap - 1] ?? Infinity)) continue;
      j = cap - 1;
    } else {
      filled++;
    }
    while (j > 0 && (dist[j - 1] ?? 0) > dSq) {
      dist[j] = dist[j - 1] ?? 0;
      out[j] = out[j - 1] ?? 0;
      j--;
    }
    dist[j] = dSq;
    out[j] = i;
  }
  return filled;
}

/**
 * Headlight cone alpha scale: 0 unless `night > 0.2`, else `night` times `fogBoost` in fog (density > 0.01) times
 * `rainBoost` in rain (> 0).
 */
export function coneBoost(night: number, fogDensity: number, rain: number, fogBoost: number, rainBoost: number): number {
  if (!(night > 0.2)) return 0;
  let k = night > 1 ? 1 : night;
  if (fogDensity > 0.01) k *= fogBoost;
  if (rain > 0) k *= rainBoost;
  return k;
}

/**
 * Orthonormal basis whose local -Z axis points along the unit vector (dx, dy, dz): writes the three column vectors
 * (x axis, y axis, z axis = -d) to `out[0..8]`. Falls back to a world-x right axis for a vertical direction.
 */
export function basisFromForward(dx: number, dy: number, dz: number, out: Out): Out {
  const zx = -dx;
  const zy = -dy;
  const zz = -dz;
  // x = normalize(up x z) = (zz, 0, -zx)
  let xx = zz;
  let xz = -zx;
  const len = Math.hypot(xx, xz);
  if (len < 1e-6) {
    xx = 1;
    xz = 0;
  } else {
    xx /= len;
    xz /= len;
  }
  // y = z x x
  out[0] = xx;
  out[1] = 0;
  out[2] = xz;
  out[3] = zy * xz;
  out[4] = zz * xx - zx * xz;
  out[5] = -zy * xx;
  out[6] = zx;
  out[7] = zy;
  out[8] = zz;
  return out;
}
