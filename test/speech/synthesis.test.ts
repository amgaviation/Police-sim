import { describe, expect, it, vi } from 'vitest';
import { voiceProfileFor, type VoiceProfile } from '../../src/speech/profile';
import { SpeechOut, type SpeechSynthesisLike, type UtteranceLike, type VoiceLike } from '../../src/speech/synthesis';

class FakeUtterance implements UtteranceLike {
  text: string;
  voice: VoiceLike | null = null;
  lang = '';
  pitch = 1;
  rate = 1;
  volume = 1;
  onend: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

class FakeSynth implements SpeechSynthesisLike {
  voices: VoiceLike[] = [];
  spoken: UtteranceLike[] = [];
  calls: string[] = [];
  throwOnSpeak = false;
  private listeners: (() => void)[] = [];
  speak(u: UtteranceLike): void {
    if (this.throwOnSpeak) throw new Error('refused');
    this.spoken.push(u);
  }
  cancel(): void {
    this.calls.push('cancel');
  }
  pause(): void {
    this.calls.push('pause');
  }
  resume(): void {
    this.calls.push('resume');
  }
  getVoices(): readonly VoiceLike[] {
    return this.voices;
  }
  addEventListener(_type: 'voiceschanged', fn: () => void): void {
    this.listeners.push(fn);
  }
  removeEventListener(_type: 'voiceschanged', fn: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  fireVoicesChanged(): void {
    for (const l of this.listeners) l();
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

const v = (name: string, lang: string, localService: boolean): VoiceLike => ({ name, lang, localService });

const VOICES = [
  v('Zed Remote', 'en-US', false),
  v('Bravo Local', 'en-GB', true),
  v('Deutsch', 'de-DE', true),
  v('Alpha Local', 'en-US', true),
  v('Alpha Remote', 'en-AU', false),
  v('Francais', 'fr-FR', false),
];

function make(voices: VoiceLike[] = VOICES): { synth: FakeSynth; out: SpeechOut } {
  const synth = new FakeSynth();
  synth.voices = voices;
  const out = new SpeechOut({ synth, utteranceFactory: (t) => new FakeUtterance(t) });
  return { synth, out };
}

const PROFILE: VoiceProfile = { pitch: 1.1, rate: 0.97, voiceIndex: 0 };

describe('SpeechOut', () => {
  it('is unavailable headless: speak returns false and ends at once', () => {
    const out = new SpeechOut();
    expect(out.available).toBe(false);
    const onEnd = vi.fn();
    expect(out.speak('Twelve, copy.', PROFILE, { onEnd })).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(() => {
      out.cancel();
      out.pause();
      out.resume();
      out.dispose();
    }).not.toThrow();
    expect(out.voiceNames()).toEqual([]);
    expect(new SpeechOut({ synth: null }).available).toBe(false);
  });

  it('builds the pool from English voices, local first then by name', () => {
    const { out } = make();
    expect(out.voicePool()).toEqual(['Alpha Local', 'Bravo Local', 'Alpha Remote', 'Zed Remote']);
    expect(out.voiceNames()).toEqual(VOICES.map((x) => x.name));
  });

  it('falls back to all voices when none is English', () => {
    const { out } = make([v('Francais', 'fr-FR', false), v('Deutsch', 'de-DE', true)]);
    expect(out.voicePool()).toEqual(['Deutsch', 'Francais']);
  });

  it('picks pool[voiceIndex % pool.length]', () => {
    const { synth, out } = make();
    for (let i = 0; i < 8; i++) out.speak('x', { pitch: 1, rate: 1, voiceIndex: i });
    expect(synth.spoken.map((u) => u.voice?.name)).toEqual([
      'Alpha Local',
      'Bravo Local',
      'Alpha Remote',
      'Zed Remote',
      'Alpha Local',
      'Bravo Local',
      'Alpha Remote',
      'Zed Remote',
    ]);
    const u = synth.spoken[0];
    expect(u?.lang).toBe('en-US');
  });

  it('applies profile and volume to the utterance', () => {
    const { synth, out } = make();
    out.volume = 0.4;
    const p = voiceProfileFor('23', 'officer');
    out.speak('Twenty-three, en route.', p);
    const u = synth.spoken[0];
    expect(u?.pitch).toBe(p.pitch);
    expect(u?.rate).toBe(p.rate);
    expect(u?.volume).toBe(0.4);
    out.volume = 7;
    out.speak('again', p);
    expect(synth.spoken[1]?.volume).toBe(1);
  });

  it('uses preferredVoice for the dispatcher only, when it exists', () => {
    const { synth, out } = make();
    out.preferredVoice = 'Deutsch';
    out.speak('Dispatch', PROFILE, { dispatcher: true });
    out.speak('Officer', PROFILE);
    expect(synth.spoken[0]?.voice?.name).toBe('Deutsch');
    expect(synth.spoken[1]?.voice?.name).toBe('Alpha Local');
    out.preferredVoice = 'Missing Voice';
    out.speak('Dispatch', { ...PROFILE, voiceIndex: 1 }, { dispatcher: true });
    expect(synth.spoken[2]?.voice?.name).toBe('Bravo Local');
  });

  it('speaks with the browser default voice when no voices are known', () => {
    const { synth, out } = make([]);
    expect(out.speak('hello', PROFILE)).toBe(true);
    expect(synth.spoken[0]?.voice).toBeNull();
    expect(synth.spoken[0]?.lang).toBe('en-US');
  });

  it('refreshes voices on voiceschanged', () => {
    const { synth, out } = make([]);
    expect(out.voicePool()).toEqual([]);
    synth.voices = [v('Late Voice', 'en-US', true)];
    synth.fireVoicesChanged();
    expect(out.voicePool()).toEqual(['Late Voice']);
    out.speak('x', PROFILE);
    expect(synth.spoken[0]?.voice?.name).toBe('Late Voice');
    out.dispose();
    expect(synth.listenerCount).toBe(0);
  });

  it('returns false and ends at once when disabled or the text is empty', () => {
    const { synth, out } = make();
    out.enabled = false;
    const onEnd = vi.fn();
    expect(out.speak('Twelve', PROFILE, { onEnd })).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    out.enabled = true;
    expect(out.speak('   ', PROFILE, { onEnd })).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(synth.spoken).toHaveLength(0);
  });

  it('calls onEnd once on end or error', () => {
    const { synth, out } = make();
    const a = vi.fn();
    const b = vi.fn();
    out.speak('one', PROFILE, { onEnd: a });
    out.speak('two', PROFILE, { onEnd: b });
    expect(a).not.toHaveBeenCalled();
    synth.spoken[0]?.onend?.({});
    synth.spoken[0]?.onerror?.({});
    synth.spoken[1]?.onerror?.({ error: 'interrupted' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('survives a refusing engine and a throwing callback', () => {
    const { synth, out } = make();
    synth.throwOnSpeak = true;
    const onEnd = vi.fn(() => {
      throw new Error('callback');
    });
    expect(out.speak('x', PROFILE, { onEnd })).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('passes cancel, pause and resume through', () => {
    const { synth, out } = make();
    out.cancel();
    out.pause();
    out.resume();
    expect(synth.calls).toEqual(['cancel', 'pause', 'resume']);
  });

  it('lists voice info with local/remote flags', () => {
    const { out } = make([v('A', 'en-US', true), v('B', 'en-GB', false)]);
    expect(out.voiceInfo()).toEqual([
      { name: 'A', lang: 'en-US', local: true },
      { name: 'B', lang: 'en-GB', local: false },
    ]);
  });
});
