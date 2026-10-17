import { describe, expect, it } from 'vitest';
import type { VoiceProfile } from '../../src/speech/profile';
import { voiceProfileFor } from '../../src/speech/profile';
import { RadioPlayer, type RadioFxLike, type SpeechOutLike } from '../../src/radio/player';
import { makeRig, PLAYER, type Rig } from './helpers';

class FakeFx implements RadioFxLike {
  readonly calls: string[] = [];
  keyUp(): void {
    this.calls.push('keyUp');
  }
  squelchTail(): void {
    this.calls.push('squelch');
  }
  heterodyne(d: number): void {
    this.calls.push(`heterodyne:${d.toFixed(2)}`);
  }
  priorityTone(): void {
    this.calls.push('priority');
  }
  alertTone(kind: 'hit' | 'offer' | 'statusCheck'): void {
    this.calls.push(`alert:${kind}`);
  }
}

class FakeSpeech implements SpeechOutLike {
  volume = 1;
  readonly spoken: { text: string; profile: VoiceProfile; dispatcher: boolean; volume: number }[] = [];
  readonly calls: string[] = [];
  private onEnd: (() => void) | null = null;
  speak(text: string, profile: VoiceProfile, options: { dispatcher?: boolean; onEnd?: () => void } = {}): boolean {
    this.spoken.push({ text, profile, dispatcher: options.dispatcher === true, volume: this.volume });
    this.onEnd = options.onEnd ?? null;
    return true;
  }
  /** The engine finished the current utterance. */
  finish(): void {
    const fn = this.onEnd;
    this.onEnd = null;
    fn?.();
  }
  cancel(): void {
    this.calls.push('cancel');
    this.onEnd = null;
  }
  pause(): void {
    this.calls.push('pause');
  }
  resume(): void {
    this.calls.push('resume');
  }
}

function setup(): { rig: Rig; fx: FakeFx; speech: FakeSpeech; player: RadioPlayer } {
  const rig = makeRig();
  const fx = new FakeFx();
  const speech = new FakeSpeech();
  const player = new RadioPlayer({ bus: rig.bus, audio: { radio: fx }, speech });
  return { rig, fx, speech, player };
}

describe('RadioPlayer', () => {
  it('plays audible transmissions: key up, speech with the speaker profile, squelch at the end', () => {
    const { rig, fx, speech } = setup();
    rig.radio.say('dispatch', '12, 10-4.');
    rig.run(0.1);
    expect(fx.calls).toEqual(['keyUp']);
    expect(speech.spoken).toEqual([{ text: 'twelve, ten four.', profile: voiceProfileFor('Dispatch', 'dispatcher'), dispatcher: true, volume: 1 }]);
    rig.run(5);
    expect(fx.calls).toEqual(['keyUp', 'squelch']);
  });

  it('ignores inaudible channels', () => {
    const { rig, fx, speech } = setup();
    rig.radio.say('county', 'County 14, 10-8.');
    rig.run(5);
    expect(fx.calls).toEqual([]);
    expect(speech.spoken).toEqual([]);
  });

  it('scanned channels play at scanVolume; one utterance at a time', () => {
    const { rig, speech } = setup();
    rig.radio.toggleScan();
    rig.radio.say('tac', 'scanned line one');
    rig.radio.say('fireEms', 'scanned line two');
    rig.run(0.1);
    expect(speech.spoken).toHaveLength(1);
    expect(speech.spoken[0]?.volume).toBeCloseTo(0.7, 10);
    expect(speech.volume).toBe(1);
    // A selected-channel transmission pre-empts the scanned utterance.
    rig.radio.say('dispatch', 'selected channel traffic');
    rig.run(0.1);
    expect(speech.calls).toEqual(['cancel']);
    expect(speech.spoken.map((s) => s.text)).toEqual(['scanned line one', 'selected channel traffic']);
    // While the selected one speaks, newer scanned traffic is captions only.
    rig.radio.say('tac', 'another scanned');
    rig.run(2.5);
    expect(rig.radio.log.some((t) => t.text === 'another scanned')).toBe(true);
    expect(speech.spoken).toHaveLength(2);
    speech.finish();
    rig.radio.say('fireEms', 'after it finished');
    rig.run(4);
    expect(speech.spoken.at(-1)?.text).toBe('after it finished');
  });

  it('blocked: cancels speech and plays a heterodyne for the overlap', () => {
    const { rig, fx, speech } = setup();
    rig.radio.say('dispatch', 'a long dispatcher message that is still going when the unit keys up');
    rig.run(0.5);
    rig.radio.playerRequest({ kind: 'status', status: 'available' }, 'radio');
    rig.run(0.05);
    expect(speech.calls).toContain('cancel');
    const het = fx.calls.find((c) => c.startsWith('heterodyne:'));
    expect(het).toBeDefined();
    const overlap = Number(het?.split(':')[1]);
    // the player's line (~2.6 s) ends before the dispatcher's
    expect(overlap).toBeGreaterThan(2);
    expect(overlap).toBeLessThan(3.5);
    expect(speech.spoken).toHaveLength(1);
  });

  it('tones by kind and priority', () => {
    const { rig, fx } = setup();
    rig.bus.emit('dispatch:plateResult', {
      callsign: PLAYER,
      via: 'radio',
      vehicleId: 1,
      readback: { plate: 'ABC 1234', found: true, description: 'x', owner: 'y', ownerPersonId: 1, hits: ['STOLEN'], severity: 'alert' },
    });
    rig.run(12);
    rig.bus.emit('dispatch:offer', { callId: 99, callsign: PLAYER, expired: false });
    rig.run(12);
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 1, escalated: false, location: '' });
    rig.run(12);
    rig.bus.emit('dispatch:statusCheck', { callsign: PLAYER, attempt: 2, escalated: false, location: '' });
    rig.run(12);
    rig.bus.emit('dispatch:emergency', { callsign: PLAYER, active: true, units: [], location: '' });
    rig.run(20);
    expect(fx.calls.filter((c) => c !== 'keyUp' && c !== 'squelch')).toEqual([
      'alert:hit',
      'alert:offer',
      'alert:statusCheck',
      'alert:statusCheck',
      'priority',
    ]);
  });

  it('pauses and resumes speech; dispose unsubscribes', () => {
    const { rig, speech, player, fx } = setup();
    player.setPaused(true);
    player.setPaused(true);
    player.setPaused(false);
    expect(speech.calls).toEqual(['pause', 'resume']);
    player.dispose();
    rig.radio.say('dispatch', 'nobody hears this');
    rig.run(5);
    expect(fx.calls).toEqual([]);
  });

  it('subtitle-only when TTS refuses', () => {
    const { rig, speech, player } = setup();
    speech.speak = (text, profile) => {
      speech.spoken.push({ text, profile, dispatcher: false, volume: 1 });
      return false;
    };
    rig.radio.say('dispatch', 'one');
    rig.run(3);
    expect(player.speaking).toBe(-1);
    rig.radio.say('dispatch', 'two');
    rig.run(3);
    expect(speech.spoken.map((s) => s.text)).toEqual(['one', 'two']);
  });
});
