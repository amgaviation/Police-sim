import type { Command } from '../debug/console';
import type { SpeechOut } from '../speech/synthesis';
import { AMBIENCE_DATA, AMBIENCE_LAYERS } from './ambienceData';
import { ambienceGains } from './ambienceMath';
import { SIREN_TONES } from './data';
import type { AudioEngine } from './engine';
import type { SirenTestKind } from './sirens';
import { UI_SOUND_KINDS } from './uiData';

/** Debug console commands of the audio module: voices, sirentest, ambience, uisound. */

const TEST_KINDS: readonly string[] = [...SIREN_TONES, 'horn', 'off'];
/** Length of a `sirentest` (s). */
const SIREN_TEST_S = 3;
/** Defaults of `ambience`. */
const DEFAULT_DISTRICT = 'downtown';
const DEFAULT_HOUR = 12;
const DEFAULT_WEATHER = 'clear';

export function createAudioCommands(deps: { audio(): AudioEngine | null; speech(): SpeechOut | null }): Command[] {
  return [
    {
      name: 'voices',
      description: 'List the text-to-speech voices (local = on-device, remote = network service)',
      run() {
        const speech = deps.speech();
        if (!speech?.available) return 'Speech synthesis unavailable';
        const voices = speech.voiceInfo();
        if (voices.length === 0) return 'No voices reported yet (they may still be loading)';
        const pool = new Set(speech.voicePool());
        return voices
          .map((v) => `${v.local ? 'local ' : 'remote'}  ${v.lang.padEnd(6)} ${v.name}${pool.has(v.name) ? '' : '  (not in pool)'}`)
          .join('\n');
      },
    },
    {
      name: 'sirentest',
      description: 'Play a siren tone or the air horn in the cabin for 3 s',
      usage: '<wail|yelp|phaser|hilo|horn|off>',
      run(args) {
        const kind = args[0];
        if (kind === undefined || !TEST_KINDS.includes(kind)) throw new Error('Usage: sirentest <wail|yelp|phaser|hilo|horn|off>');
        const audio = deps.audio();
        if (!audio?.available) return 'Audio unavailable';
        audio.unlock();
        audio.sirens.test(kind === 'off' ? null : (kind as SirenTestKind), SIREN_TEST_S);
        return kind === 'off' ? 'Siren test stopped' : `Siren test: ${kind} for ${SIREN_TEST_S} s`;
      },
    },
    {
      name: 'ambience',
      description: 'Print the target ambience layer gains for a district, hour and weather (outdoors, no rain or wind)',
      usage: '[district hour weather]',
      run(args) {
        const hour = args[1] === undefined ? DEFAULT_HOUR : Number(args[1]);
        if (!Number.isFinite(hour)) throw new Error('Usage: ambience [district hour weather]');
        const district = args[0] ?? DEFAULT_DISTRICT;
        const weather = args[2] ?? DEFAULT_WEATHER;
        const out = new Float32Array(AMBIENCE_DATA.layers.length);
        ambienceGains({ district, hour, weather, rain: weather === 'rain' || weather === 'storm' ? 1 : 0, wind: 0, indoor: false, inCabin: false }, AMBIENCE_DATA, out);
        const lines = AMBIENCE_LAYERS.map((id, i) => `${id.padEnd(9)} ${(out[i] ?? 0).toFixed(3)}`);
        return [`Ambience: ${district} ${hour.toFixed(1)} h ${weather}`, ...lines].join('\n');
      },
    },
    {
      name: 'uisound',
      description: 'Play a UI sound',
      usage: `<${UI_SOUND_KINDS.join('|')}>`,
      run(args) {
        const kind = args[0];
        if (kind === undefined || !(UI_SOUND_KINDS as readonly string[]).includes(kind)) throw new Error(`Usage: uisound <${UI_SOUND_KINDS.join('|')}>`);
        const audio = deps.audio();
        if (!audio?.available) return 'Audio unavailable';
        audio.unlock();
        audio.ui.play(kind);
        return `UI sound: ${kind}`;
      },
    },
  ];
}
