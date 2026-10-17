import { hashString } from '../core/rng';

/** Per-speaker TTS voice profile (design §10.4): a pure, deterministic hash of the speaker key. */

export type VoiceKind = 'dispatcher' | 'officer' | 'agency' | 'player';

export interface VoiceProfile {
  readonly pitch: number;
  readonly rate: number;
  /** Index into the voice pool (taken modulo the pool size); 0..63. */
  readonly voiceIndex: number;
}

/** Number of distinct voice indices. */
export const VOICE_INDEX_COUNT = 64;

interface Range {
  readonly pitch: readonly [number, number];
  readonly rate: readonly [number, number];
}

const RANGES: Readonly<Record<VoiceKind, Range>> = {
  dispatcher: { pitch: [0.95, 1.1], rate: [1.05, 1.05] },
  officer: { pitch: [0.8, 1.2], rate: [0.95, 1.15] },
  player: { pitch: [0.8, 1.2], rate: [0.95, 1.15] },
  agency: { pitch: [0.9, 1.1], rate: [0.95, 1.1] },
};

function lerp(range: readonly [number, number], u: number): number {
  return Math.round((range[0] + (range[1] - range[0]) * u) * 1000) / 1000;
}

/** Murmur3 finalizer: spreads FNV-1a's weak low bits for short, similar keys ("21", "23"). */
function mix(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Deterministic voice profile for a speaker (callsign, agency name...) of `kind`. */
export function voiceProfileFor(speakerKey: string, kind: VoiceKind): VoiceProfile {
  const h1 = mix(hashString(`${kind}:${speakerKey}`));
  const h2 = mix(h1 ^ 0x9e3779b9);
  const range = RANGES[kind];
  return {
    pitch: lerp(range.pitch, (h1 & 0xffff) / 0xffff),
    rate: lerp(range.rate, (h1 >>> 16) / 0xffff),
    voiceIndex: h2 % VOICE_INDEX_COUNT,
  };
}
