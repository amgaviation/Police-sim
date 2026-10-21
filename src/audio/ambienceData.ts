import ambienceJson from '../data/audio/ambience.json';
import { WEATHER_KINDS } from '../environment/weather';
import { fail, readArray, readNumber, readObject, readOneOf, readVersion } from '../vehicles/json';
import { DISTRICT_NAMES } from '../world/ids';

/** Typed, validated view of `src/data/audio/ambience.json` (phase 9 design §5.3). */

export const AMBIENCE_LAYERS = ['traffic', 'hum', 'wind', 'rain', 'birds', 'crickets', 'water'] as const;
export type AmbienceLayerId = (typeof AMBIENCE_LAYERS)[number];

export const AMBIENCE_SOURCES = ['noise', 'hum', 'chirps', 'crickets'] as const;
export type AmbienceSource = (typeof AMBIENCE_SOURCES)[number];

export const AMBIENCE_DRIVES = ['none', 'rain', 'wind'] as const;
export type AmbienceDrive = (typeof AMBIENCE_DRIVES)[number];

export const AMBIENCE_FILTERS = ['lowpass', 'bandpass', 'highpass'] as const;

export interface AmbienceFilter {
  readonly type: (typeof AMBIENCE_FILTERS)[number];
  readonly hz: number;
  readonly q: number;
}

export interface AmbienceLayer {
  readonly id: AmbienceLayerId;
  readonly source: AmbienceSource;
  /** Noise sources: the layer filter. */
  readonly filter: AmbienceFilter | null;
  /** Hum and cricket tone (Hz); 0 otherwise. */
  readonly hz: number;
  /** Cricket amplitude-modulation rate (Hz); 0 otherwise. */
  readonly amHz: number;
  /** Noise layer amplitude LFO rate (Hz, depth 0.5); 0 = none. */
  readonly lfoHz: number;
  /** Chirp events per second at full level; 0 otherwise. */
  readonly ratePerS: number;
  readonly gain: number;
  readonly drive: AmbienceDrive;
  /** Factor per district name; `*` is the default for unlisted districts (absent `*` = 0). Null-prototype record. */
  readonly district: Readonly<Record<string, number>>;
  /** 24 factors, one per whole game hour (`"flat"` in the JSON = all 1). */
  readonly hours: readonly number[];
  /** Factor per weather kind; an absent kind = 1. Null-prototype record. */
  readonly weather: Readonly<Record<string, number>>;
  /** Factor applied while the listener is indoors. */
  readonly indoor: number;
}

export interface AmbienceData {
  readonly indoorLowpassHz: number;
  readonly cabinLowpassHz: number;
  readonly cabinFactor: number;
  /** One layer per `AMBIENCE_LAYERS` id, in that order. */
  readonly layers: readonly AmbienceLayer[];
}

const FILE = 'ambience.json';

/** Validates the raw JSON; throws an Error naming the file and field. */
export function parseAmbience(raw: unknown, file: string = FILE): AmbienceData {
  const num = (v: unknown, path: string, min: number, max: number): number => readNumber(v, file, path, min, max);

  const readFactors = (value: unknown, path: string, allowed: readonly string[], star: boolean): Record<string, number> => {
    const o = readObject(value, file, path);
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const key of Object.keys(o)) {
      if (!(star && key === '*') && !allowed.includes(key)) {
        fail(file, `${path}.${key}`, `unknown key, expected one of ${(star ? ['*', ...allowed] : allowed).join(', ')}`);
      }
      out[key] = num(o[key], `${path}.${key}`, 0, 10);
    }
    return out;
  };

  const readHours = (value: unknown, path: string): number[] => {
    if (value === 'flat') return new Array<number>(24).fill(1);
    const arr = readArray(value, file, path);
    if (arr.length !== 24) fail(file, path, `must be "flat" or have 24 items, got ${arr.length}`);
    return arr.map((v, i) => num(v, `${path}[${i}]`, 0, 10));
  };

  const readLayer = (value: unknown, index: number): AmbienceLayer => {
    const path = `layers[${index}]`;
    const o = readObject(value, file, path);
    const expected = AMBIENCE_LAYERS[index];
    const id = readOneOf<AmbienceLayerId>(o.id, AMBIENCE_LAYERS, file, `${path}.id`);
    if (id !== expected) fail(file, `${path}.id`, `must be "${String(expected)}" (layers follow the AMBIENCE_LAYERS order), got "${id}"`);
    const source = readOneOf<AmbienceSource>(o.source, AMBIENCE_SOURCES, file, `${path}.source`);
    let filter: AmbienceFilter | null = null;
    if (source === 'noise') {
      const f = readObject(o.filter, file, `${path}.filter`);
      filter = {
        type: readOneOf(f.type, AMBIENCE_FILTERS, file, `${path}.filter.type`),
        hz: num(f.hz, `${path}.filter.hz`, 20, 20000),
        q: num(f.q, `${path}.filter.q`, 0.1, 50),
      };
    }
    const needsHz = source === 'hum' || source === 'crickets';
    const hz = needsHz ? num(o.hz, `${path}.hz`, 20, 20000) : 0;
    const amHz = source === 'crickets' ? num(o.amHz, `${path}.amHz`, 0.1, 200) : 0;
    const ratePerS = source === 'chirps' ? num(o.ratePerS, `${path}.ratePerS`, 0, 20) : 0;
    const lfoHz = source === 'noise' && o.lfoHz !== undefined ? num(o.lfoHz, `${path}.lfoHz`, 0, 20) : 0;
    return {
      id,
      source,
      filter,
      hz,
      amHz,
      lfoHz,
      ratePerS,
      gain: num(o.gain, `${path}.gain`, 0, 1),
      drive: readOneOf<AmbienceDrive>(o.drive, AMBIENCE_DRIVES, file, `${path}.drive`),
      district: readFactors(o.district, `${path}.district`, DISTRICT_NAMES, true),
      hours: readHours(o.hours, `${path}.hours`),
      weather: readFactors(o.weather, `${path}.weather`, WEATHER_KINDS, false),
      indoor: num(o.indoor, `${path}.indoor`, 0, 10),
    };
  };

  const root = readObject(raw, file, '');
  readVersion(root, file);
  const layersRaw = readArray(root.layers, file, 'layers', AMBIENCE_LAYERS.length);
  if (layersRaw.length !== AMBIENCE_LAYERS.length) {
    fail(file, 'layers', `must have exactly ${AMBIENCE_LAYERS.length} items (${AMBIENCE_LAYERS.join(', ')}), got ${layersRaw.length}`);
  }
  return {
    indoorLowpassHz: num(root.indoorLowpassHz, 'indoorLowpassHz', 50, 20000),
    cabinLowpassHz: num(root.cabinLowpassHz, 'cabinLowpassHz', 50, 20000),
    cabinFactor: num(root.cabinFactor, 'cabinFactor', 0, 1),
    layers: layersRaw.map((l, i) => readLayer(l, i)),
  };
}

export const AMBIENCE_DATA: AmbienceData = parseAmbience(ambienceJson);
