import { describe, expect, it } from 'vitest';
import { CHATTER_DATA } from '../../src/audio/chatterData';
import { AudioEngine } from '../../src/audio/engine';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { RadioPlayer, type RadioFxLike, type SpeechOutLike } from '../../src/radio/player';
import '../../src/radio/events';
import type { Transmission } from '../../src/radio/types';
import type { VoiceProfile } from '../../src/speech/profile';
import { fakeFactory, type FakeGain } from '../audio/fakeAudio';

/** A fake engine radio: records babble bursts and bed levels. */
class FakeRadio implements RadioFxLike {
  level = 1;
  readonly calls: string[] = [];
  readonly chatters: { durationS: number; level: number }[] = [];
  readonly bed: number[] = [];
  keyUp(): void {
    this.calls.push('keyUp');
  }
  squelchTail(): void {
    this.calls.push('squelch');
  }
  heterodyne(): void {
    this.calls.push('heterodyne');
  }
  priorityTone(): void {
    this.calls.push('priority');
  }
  alertTone(): void {
    this.calls.push('alert');
  }
  chatter(durationS: number, level: number): void {
    this.calls.push('chatter');
    this.chatters.push({ durationS, level });
  }
  setBed(level: number): void {
    this.bed.push(level);
  }
}

class FakeSpeech implements SpeechOutLike {
  volume = 1;
  /** What `speak` returns (false = speech disabled / unavailable / refused). */
  accept = true;
  readonly spoken: string[] = [];
  private onEnd: (() => void) | null = null;
  speak(text: string, _profile: VoiceProfile, options: { onEnd?: () => void } = {}): boolean {
    if (!this.accept) return false;
    this.spoken.push(text);
    this.onEnd = options.onEnd ?? null;
    return true;
  }
  finish(): void {
    const fn = this.onEnd;
    this.onEnd = null;
    fn?.();
  }
  cancel(): void {
    this.onEnd = null;
  }
  pause(): void {}
  resume(): void {}
}

let nextId = 1;

function tx(over: Partial<Transmission> = {}): Transmission {
  const id = nextId++;
  return {
    id,
    channel: 'dispatch',
    speaker: 'Dispatch',
    speakerKind: 'dispatcher',
    text: `line ${id}`,
    spoken: `line ${id}`,
    start: id,
    duration: 3,
    blocked: false,
    priority: false,
    kind: 'say',
    clock: '12:00',
    audible: true,
    ...over,
  };
}

function setup(): { bus: EventBus<EventMap>; radio: FakeRadio; speech: FakeSpeech; player: RadioPlayer } {
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const radio = new FakeRadio();
  const speech = new FakeSpeech();
  const player = new RadioPlayer({ bus, audio: { radio }, speech, selected: () => 'dispatch', schedule: (fn) => { fn(); return () => undefined; } });
  return { bus, radio, speech, player };
}

describe('RadioPlayer chatter', () => {
  it('babbles for an audible transmission that is not spoken, after the key-up', () => {
    const { bus, radio, speech } = setup();
    speech.accept = false;
    const t = tx({ duration: 2.5 });
    bus.emit('radio:start', { tx: t });
    expect(radio.chatters).toEqual([{ durationS: 2.5, level: 1 }]);
    expect(radio.calls).toEqual(['keyUp', 'chatter']);
    expect(radio.level).toBe(1);
  });

  it('does not babble over a spoken transmission', () => {
    const { bus, radio, speech } = setup();
    bus.emit('radio:start', { tx: tx() });
    expect(speech.spoken).toHaveLength(1);
    expect(radio.chatters).toHaveLength(0);
  });

  it('babbles at half level for a scanned channel', () => {
    const { bus, radio, speech } = setup();
    speech.accept = false;
    bus.emit('radio:start', { tx: tx({ channel: 'tac', duration: 4 }) });
    expect(radio.chatters).toEqual([{ durationS: 4, level: 0.5 }]);
  });

  it('babbles for a scanned transmission while another is being spoken', () => {
    const { bus, radio, speech } = setup();
    bus.emit('radio:start', { tx: tx() });
    expect(radio.chatters).toHaveLength(0);
    bus.emit('radio:start', { tx: tx({ channel: 'tac', duration: 2 }) });
    expect(speech.spoken).toHaveLength(1);
    expect(radio.chatters).toEqual([{ durationS: 2, level: 0.5 }]);
    // A second selected-channel line while the first is spoken is captions only: babble at full level.
    bus.emit('radio:start', { tx: tx({ duration: 1.5 }) });
    expect(radio.chatters.at(-1)).toEqual({ durationS: 1.5, level: 1 });
  });

  it('babbles after the alert tone when the speech engine refuses the line', () => {
    const { bus, radio, speech } = setup();
    speech.accept = false;
    bus.emit('radio:start', { tx: tx({ priority: true, duration: 4 }) });
    expect(radio.calls).toEqual(['priority', 'keyUp', 'chatter']);
    expect(radio.chatters[0]?.durationS).toBeCloseTo(4 - 0.75, 10);
  });

  it('does not babble for inaudible or blocked transmissions', () => {
    const { bus, radio, speech } = setup();
    speech.accept = false;
    bus.emit('radio:start', { tx: tx({ audible: false }) });
    bus.emit('radio:start', { tx: tx({ blocked: true }) });
    expect(radio.chatters).toHaveLength(0);
  });

  it('keeps the bed level in step with the audible transmissions on the air', () => {
    const { bus, radio } = setup();
    const per = CHATTER_DATA.bedPerTransmission;
    const a = tx();
    const b = tx({ channel: 'tac' });
    const hidden = tx({ audible: false });
    bus.emit('radio:start', { tx: a });
    bus.emit('radio:start', { tx: hidden });
    expect(radio.bed.at(-1)).toBeCloseTo(per, 10);
    bus.emit('radio:start', { tx: b });
    expect(radio.bed.at(-1)).toBeCloseTo(Math.min(1, 2 * per), 10);
    bus.emit('radio:end', { id: a.id, blocked: false });
    expect(radio.bed.at(-1)).toBeCloseTo(per, 10);
    // An inaudible end changes nothing; a repeated end never goes below the count.
    bus.emit('radio:end', { id: hidden.id, blocked: false });
    bus.emit('radio:end', { id: a.id, blocked: false });
    expect(radio.bed.at(-1)).toBeCloseTo(per, 10);
    bus.emit('radio:end', { id: b.id, blocked: false });
    expect(radio.bed.at(-1)).toBe(0);
  });

  it('a blocked transmission leaves the bed count once, even when its end follows', () => {
    const { bus, radio } = setup();
    const per = CHATTER_DATA.bedPerTransmission;
    const a = tx();
    const b = tx({ channel: 'tac' });
    bus.emit('radio:start', { tx: a });
    bus.emit('radio:start', { tx: b });
    bus.emit('radio:blocked', { ids: [a.id], channel: 'dispatch' });
    expect(radio.bed.at(-1)).toBeCloseTo(per, 10);
    bus.emit('radio:end', { id: a.id, blocked: true });
    expect(radio.bed.at(-1)).toBeCloseTo(per, 10);
    bus.emit('radio:end', { id: b.id, blocked: false });
    expect(radio.bed.at(-1)).toBe(0);
  });

  it('caps the bed level at 1', () => {
    const { bus, radio } = setup();
    for (let i = 0; i < 5; i++) bus.emit('radio:start', { tx: tx({ channel: 'tac' }) });
    expect(Math.max(...radio.bed)).toBe(1);
  });

  it('reset and dispose clear the bed', () => {
    const { bus, radio, player } = setup();
    bus.emit('radio:start', { tx: tx() });
    expect(radio.bed.at(-1)).toBeGreaterThan(0);
    player.reset();
    expect(radio.bed.at(-1)).toBe(0);
    // The forgotten transmission's end no longer touches the bed.
    const before = radio.bed.length;
    bus.emit('radio:start', { tx: tx() });
    player.dispose();
    expect(radio.bed.length).toBeGreaterThan(before);
    expect(radio.bed.at(-1)).toBe(0);
  });

  it('works with a radio that has no chatter or bed (older fakes)', () => {
    const bus = new EventBus<EventMap>((topic, error) => {
      throw new Error(`${topic}: ${String(error)}`);
    });
    const speech = new FakeSpeech();
    speech.accept = false;
    const radio: RadioFxLike = { level: 1, keyUp() {}, squelchTail() {}, heterodyne() {}, priorityTone() {}, alertTone() {} };
    const player = new RadioPlayer({ bus, audio: { radio }, speech, selected: () => 'dispatch' });
    expect(() => {
      bus.emit('radio:start', { tx: tx() });
      player.reset();
      player.dispose();
    }).not.toThrow();
  });
});

describe('RadioPlayer with the real audio engine (fake Web Audio context)', () => {
  it('babbles on the radio bus for a transmission nobody speaks and keeps a bed while it is on the air', () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    engine.unlock();
    const bus = new EventBus<EventMap>((topic, error) => {
      throw new Error(`${topic}: ${String(error)}`);
    });
    const speech = new FakeSpeech();
    speech.accept = false;
    const player = new RadioPlayer({ bus, audio: engine, speech, selected: () => 'dispatch' });
    const radioBus = ctx.nodesOf<FakeGain>('gain')[2] as FakeGain;
    const bed = ctx.nodesOf<FakeGain>('gain').find((g) => g.connections.includes(radioBus)) as FakeGain;
    expect(bed.gain.target).toBe(0);
    const t = tx({ duration: 2 });
    const sourcesBefore = ctx.created['bufferSource'] ?? 0;
    bus.emit('radio:start', { tx: t });
    expect(engine.stats.chatter).toBe(1);
    // key-up click + static + one babble source
    expect((ctx.created['bufferSource'] ?? 0) - sourcesBefore).toBe(3);
    expect(bed.gain.target).toBeCloseTo(CHATTER_DATA.bedPerTransmission * CHATTER_DATA.bedLevel, 12);
    bus.emit('radio:end', { id: t.id, blocked: false });
    expect(bed.gain.target).toBe(0);
    player.dispose();
  });
});
