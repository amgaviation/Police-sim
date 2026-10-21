import uiJson from '../data/audio/ui.json';
import { fail, readArray, readNumber, readObject, readOneOf, readVersion } from '../vehicles/json';
import { LFO_SHAPES, type LfoShape } from './data';

/** Typed, validated view of `src/data/audio/ui.json` (phase 9 design §5.3). */

export const UI_SOUND_KINDS = ['move', 'select', 'back', 'open', 'close', 'error', 'notify'] as const;
export type UiSoundName = (typeof UI_SOUND_KINDS)[number];

/** One tone of a UI sound: a short enveloped oscillator gliding from `hz` to `toHz`. */
export interface UiTone {
  readonly hz: number;
  readonly toHz: number;
  readonly durS: number;
  readonly wave: LfoShape;
  readonly gain: number;
}

export interface UiSoundData {
  /** The same kind within this many ms of audio time is dropped. */
  readonly rateLimitMs: number;
  /** 1..3 tones per kind, played back to back. */
  readonly sounds: Readonly<Record<UiSoundName, readonly UiTone[]>>;
}

const FILE = 'ui.json';

/** Validates the raw JSON; throws an Error naming the file and field. */
export function parseUiSounds(raw: unknown, file: string = FILE): UiSoundData {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const soundsObj = readObject(root.sounds, file, 'sounds');
  for (const key of Object.keys(soundsObj)) {
    if (!(UI_SOUND_KINDS as readonly string[]).includes(key)) fail(file, `sounds.${key}`, `unknown sound kind, expected one of ${UI_SOUND_KINDS.join(', ')}`);
  }
  const sounds = {} as Record<UiSoundName, readonly UiTone[]>;
  for (const kind of UI_SOUND_KINDS) {
    const path = `sounds.${kind}`;
    const tones = readArray(soundsObj[kind], file, path, 1);
    if (tones.length > 3) fail(file, path, `must have 1..3 tones, got ${tones.length}`);
    sounds[kind] = tones.map((t, i): UiTone => {
      const tp = `${path}[${i}]`;
      const o = readObject(t, file, tp);
      return {
        hz: readNumber(o.hz, file, `${tp}.hz`, 20, 20000),
        toHz: readNumber(o.toHz, file, `${tp}.toHz`, 20, 20000),
        durS: readNumber(o.durS, file, `${tp}.durS`, 0.005, 2),
        wave: readOneOf<LfoShape>(o.wave, LFO_SHAPES, file, `${tp}.wave`),
        gain: readNumber(o.gain, file, `${tp}.gain`, 0, 1),
      };
    });
  }
  return { rateLimitMs: readNumber(root.rateLimitMs, file, 'rateLimitMs', 0, 1000), sounds };
}

export const UI_SOUNDS: UiSoundData = parseUiSounds(uiJson);
