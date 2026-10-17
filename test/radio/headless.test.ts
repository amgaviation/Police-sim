import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { InputManager } from '../../src/input/input';
import { RadioController } from '../../src/radio/controller';
import { RadioPlayer } from '../../src/radio/player';
import { SpeechIn } from '../../src/speech/recognition';
import { SpeechOut } from '../../src/speech/synthesis';
import { makeRig } from './helpers';

describe('presentation with the real (headless) engine types', () => {
  it('RadioPlayer and RadioController run as no-ops without Web Audio / Web Speech', () => {
    const rig = makeRig();
    const audio = new AudioEngine({ contextFactory: null });
    const speech = new SpeechOut({ synth: null });
    const speechIn = new SpeechIn({ factory: null });
    const input = new InputManager();
    const player = new RadioPlayer({ bus: rig.bus, audio, speech });
    const ctl = new RadioController({ input, radio: rig.radio, speechIn });
    rig.radio.say('dispatch', '12, 10-4.');
    rig.run(4);
    const s = ctl.update(1 / 60, true, {
      mode: 'tenCode', hasTarget: false, hasStop: false, pendingOffer: false, onCall: false, emergency: false, fallbackPlate: null,
    });
    expect(s.voice).toBe('unavailable');
    expect(s.menu).toBeNull();
    expect(rig.radio.log).toHaveLength(1);
    player.setPaused(true);
    player.dispose();
    ctl.dispose();
    rig.radio.dispose();
    audio.dispose();
  });
});
