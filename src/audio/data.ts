import sirensJson from '../data/audio/sirens.json';
import { fail, readArray, readNumber, readObject, readOneOf, readVersion } from '../vehicles/json';

/** Typed, validated view of `src/data/audio/sirens.json` (design §4.5). */

export const SIREN_TONES = ['wail', 'yelp', 'phaser', 'hilo'] as const;
/** Identical to the equipment module's `SirenTone` (kept separate: audio imports no Phase 2 module). */
export type SirenToneName = (typeof SIREN_TONES)[number];

export const LFO_SHAPES = ['triangle', 'sawtooth', 'square', 'sine'] as const;
export type LfoShape = (typeof LFO_SHAPES)[number];

export interface SirenToneSpec {
  readonly lowHz: number;
  readonly highHz: number;
  readonly periodS: number;
  readonly shape: LfoShape;
}

export interface SirenData {
  readonly tones: Readonly<Record<SirenToneName, SirenToneSpec>>;
  readonly horn: { readonly freqsHz: readonly number[]; readonly attackS: number; readonly releaseS: number };
  readonly manual: { readonly minHz: number; readonly maxHz: number; readonly riseS: number; readonly fallS: number };
  readonly voice: { readonly wave: LfoShape; readonly lowpassHz: number; readonly gain: number };
  readonly panner: { readonly model: 'inverse'; readonly refDistance: number; readonly rolloff: number; readonly maxDistance: number };
  readonly voices: number;
  readonly maxAudibleM: number;
  readonly cabin: { readonly gain: number; readonly lowpassHz: number };
}

const FILE = 'sirens.json';

function readTone(value: unknown, path: string): SirenToneSpec {
  const o = readObject(value, FILE, path);
  const lowHz = readNumber(o.lowHz, FILE, `${path}.lowHz`, 20, 20000);
  const highHz = readNumber(o.highHz, FILE, `${path}.highHz`, 20, 20000);
  if (highHz < lowHz) fail(FILE, `${path}.highHz`, `must be >= lowHz (${lowHz}), got ${highHz}`);
  return {
    lowHz,
    highHz,
    periodS: readNumber(o.periodS, FILE, `${path}.periodS`, 0.01, 60),
    shape: readOneOf(o.shape, LFO_SHAPES, FILE, `${path}.shape`),
  };
}

/** Validates the raw JSON; throws an Error naming the file and field. */
export function parseSirenData(raw: unknown): SirenData {
  const root = readObject(raw, FILE, '');
  readVersion(root, FILE);
  const tonesObj = readObject(root.tones, FILE, 'tones');
  const tones = {} as Record<SirenToneName, SirenToneSpec>;
  for (const name of SIREN_TONES) tones[name] = readTone(tonesObj[name], `tones.${name}`);

  const horn = readObject(root.horn, FILE, 'horn');
  const freqsHz = readArray(horn.freqsHz, FILE, 'horn.freqsHz', 1).map((f, i) => readNumber(f, FILE, `horn.freqsHz[${i}]`, 20, 20000));
  const manual = readObject(root.manual, FILE, 'manual');
  const minHz = readNumber(manual.minHz, FILE, 'manual.minHz', 20, 20000);
  const maxHz = readNumber(manual.maxHz, FILE, 'manual.maxHz', minHz, 20000);
  const voice = readObject(root.voice, FILE, 'voice');
  const panner = readObject(root.panner, FILE, 'panner');
  const refDistance = readNumber(panner.refDistance, FILE, 'panner.refDistance', 0.01, 10000);
  const cabin = readObject(root.cabin, FILE, 'cabin');
  return {
    tones,
    horn: {
      freqsHz,
      attackS: readNumber(horn.attackS, FILE, 'horn.attackS', 0.001, 5),
      releaseS: readNumber(horn.releaseS, FILE, 'horn.releaseS', 0.001, 5),
    },
    manual: {
      minHz,
      maxHz,
      riseS: readNumber(manual.riseS, FILE, 'manual.riseS', 0.01, 60),
      fallS: readNumber(manual.fallS, FILE, 'manual.fallS', 0.01, 60),
    },
    voice: {
      wave: readOneOf(voice.wave, LFO_SHAPES, FILE, 'voice.wave'),
      lowpassHz: readNumber(voice.lowpassHz, FILE, 'voice.lowpassHz', 20, 20000),
      gain: readNumber(voice.gain, FILE, 'voice.gain', 0, 1),
    },
    panner: {
      model: readOneOf(panner.model, ['inverse'] as const, FILE, 'panner.model'),
      refDistance,
      rolloff: readNumber(panner.rolloff, FILE, 'panner.rolloff', 0, 100),
      maxDistance: readNumber(panner.maxDistance, FILE, 'panner.maxDistance', refDistance, 100000),
    },
    voices: Math.floor(readNumber(root.voices, FILE, 'voices', 1, 16)),
    maxAudibleM: readNumber(root.maxAudibleM, FILE, 'maxAudibleM', 1, 100000),
    cabin: {
      gain: readNumber(cabin.gain, FILE, 'cabin.gain', 0, 1),
      lowpassHz: readNumber(cabin.lowpassHz, FILE, 'cabin.lowpassHz', 20, 20000),
    },
  };
}

export const SIREN_DATA: SirenData = parseSirenData(sirensJson);
