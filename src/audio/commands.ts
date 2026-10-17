import type { Command } from '../debug/console';
import type { SpeechOut } from '../speech/synthesis';
import { SIREN_TONES } from './data';
import type { AudioEngine } from './engine';
import type { SirenTestKind } from './sirens';

/** Debug console commands of the audio module: voices, sirentest. */

const TEST_KINDS: readonly string[] = [...SIREN_TONES, 'horn', 'off'];
/** Length of a `sirentest` (s). */
const SIREN_TEST_S = 3;

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
  ];
}
