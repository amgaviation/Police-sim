import chatterJson from '../data/audio/chatter.json';
import { fail, readArray, readNumber, readObject, readVersion } from '../vehicles/json';

/** Typed, validated view of `src/data/audio/chatter.json` (phase 9 design §5.3). */

export interface ChatterData {
  /** Centres of the three formant band-passes (Hz). */
  readonly formantsHz: readonly [number, number, number];
  readonly formantQ: number;
  /** Syllable rate range (Hz). */
  readonly syllableHz: readonly [number, number];
  /** Band limit (high-pass, low-pass) of the babble (Hz). */
  readonly bandHz: readonly [number, number];
  /** Level of a babble burst at transmission level 1. */
  readonly burstLevel: number;
  /** Level of the background bed at bed level 1. */
  readonly bedLevel: number;
  /** Bed level contributed by each audible transmission on the air. */
  readonly bedPerTransmission: number;
  readonly maxBursts: number;
}

const FILE = 'chatter.json';

/** Validates the raw JSON; throws an Error naming the file and field. */
export function parseChatter(raw: unknown, file: string = FILE): ChatterData {
  const range = (value: unknown, path: string, min: number, max: number): [number, number] => {
    const arr = readArray(value, file, path);
    if (arr.length !== 2) fail(file, path, `must have 2 items [low, high], got ${arr.length}`);
    const lo = readNumber(arr[0], file, `${path}[0]`, min, max);
    return [lo, readNumber(arr[1], file, `${path}[1]`, lo, max)];
  };
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const formants = readArray(root.formantsHz, file, 'formantsHz');
  if (formants.length !== 3) fail(file, 'formantsHz', `must have 3 items, got ${formants.length}`);
  return {
    formantsHz: [
      readNumber(formants[0], file, 'formantsHz[0]', 50, 8000),
      readNumber(formants[1], file, 'formantsHz[1]', 50, 8000),
      readNumber(formants[2], file, 'formantsHz[2]', 50, 8000),
    ],
    formantQ: readNumber(root.formantQ, file, 'formantQ', 0.5, 50),
    syllableHz: range(root.syllableHz, 'syllableHz', 0.5, 20),
    bandHz: range(root.bandHz, 'bandHz', 50, 20000),
    burstLevel: readNumber(root.burstLevel, file, 'burstLevel', 0, 1),
    bedLevel: readNumber(root.bedLevel, file, 'bedLevel', 0, 1),
    bedPerTransmission: readNumber(root.bedPerTransmission, file, 'bedPerTransmission', 0, 1),
    maxBursts: Math.floor(readNumber(root.maxBursts, file, 'maxBursts', 1, 8)),
  };
}

export const CHATTER_DATA: ChatterData = parseChatter(chatterJson);
