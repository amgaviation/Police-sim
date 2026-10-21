import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import { UiSounds, UI_SOUND_KINDS } from '../../src/audio/uiSounds';
import { UI_SOUNDS, parseUiSounds } from '../../src/audio/uiData';
import { createAudioStats } from '../../src/audio/sirens';
import uiJson from '../../src/data/audio/ui.json';
import { fakeFactory, fakeGraph, gainsInto, type FakeContext, type FakeGain, type FakeOscillator } from './fakeAudio';

function unlocked(): { engine: AudioEngine; ctx: FakeContext; ui: FakeGain } {
  const { ctx, factory } = fakeFactory();
  const engine = new AudioEngine({ contextFactory: factory });
  engine.unlock();
  return { engine, ctx, ui: ctx.nodesOf<FakeGain>('gain')[4] as FakeGain };
}

/** Oscillators of the sources created after `mark`. */
function oscsSince(ctx: FakeContext, mark: number): FakeOscillator[] {
  return ctx.nodes.slice(mark).filter((n): n is FakeOscillator => n.kind === 'oscillator');
}

describe('ui.json', () => {
  it('has 1..3 tones for each kind', () => {
    expect([...UI_SOUND_KINDS]).toEqual(['move', 'select', 'back', 'open', 'close', 'error', 'notify']);
    for (const kind of UI_SOUND_KINDS) {
      const tones = UI_SOUNDS.sounds[kind];
      expect(tones.length, kind).toBeGreaterThanOrEqual(1);
      expect(tones.length, kind).toBeLessThanOrEqual(3);
    }
    expect(UI_SOUNDS.rateLimitMs).toBe(60);
  });

  it('names the file and the dotted path on bad data', () => {
    const clone = (): { sounds: Record<string, Record<string, unknown>[]> } => JSON.parse(JSON.stringify(uiJson)) as { sounds: Record<string, Record<string, unknown>[]> };
    expect(() => parseUiSounds({ ...uiJson, version: 0 })).toThrow(/ui\.json: version/);
    expect(() => parseUiSounds({ ...uiJson, rateLimitMs: -1 })).toThrow(/ui\.json: rateLimitMs/);
    const missing = clone();
    delete missing.sounds['back'];
    expect(() => parseUiSounds(missing)).toThrow(/ui\.json: sounds\.back/);
    const unknown = clone();
    unknown.sounds['bleep'] = [{ hz: 1, toHz: 1, durS: 1, wave: 'sine', gain: 1 }];
    expect(() => parseUiSounds(unknown)).toThrow(/ui\.json: sounds\.bleep/);
    const empty = clone();
    empty.sounds['move'] = [];
    expect(() => parseUiSounds(empty)).toThrow(/ui\.json: sounds\.move/);
    const tooMany = clone();
    tooMany.sounds['move'] = Array.from({ length: 4 }, () => ({ hz: 440, toHz: 440, durS: 0.05, wave: 'sine', gain: 0.1 }));
    expect(() => parseUiSounds(tooMany)).toThrow(/ui\.json: sounds\.move/);
    const badWave = clone();
    (badWave.sounds['open']?.[1] as { wave: string }).wave = 'noise';
    expect(() => parseUiSounds(badWave)).toThrow(/ui\.json: sounds\.open\[1\]\.wave/);
    const badHz = clone();
    (badHz.sounds['select']?.[0] as { hz: number }).hz = 5;
    expect(() => parseUiSounds(badHz)).toThrow(/ui\.json: sounds\.select\[0\]\.hz/);
    expect(() => parseUiSounds(uiJson, 'mod.json')).not.toThrow();
    expect(() => parseUiSounds({ ...uiJson, version: 4 }, 'mod.json')).toThrow(/mod\.json: version/);
  });
});

describe('UiSounds', () => {
  it('is a no-op before unlock and without Web Audio', () => {
    expect(() => new UiSounds().play('select')).not.toThrow();
    const engine = new AudioEngine({ contextFactory: null });
    expect(() => {
      engine.ui.play('select');
      engine.ui.play('nonsense');
    }).not.toThrow();
    const { ctx, factory } = fakeFactory();
    const locked = new AudioEngine({ contextFactory: factory });
    locked.ui.play('open');
    expect(ctx.totalCreated).toBe(0);
  });

  it.each(UI_SOUND_KINDS.map((k) => [k]))('%s schedules its tones on the ui bus', (kind) => {
    const { engine, ctx, ui } = unlocked();
    const tones = UI_SOUNDS.sounds[kind];
    const mark = ctx.nodes.length;
    ctx.currentTime = 1;
    engine.ui.play(kind);
    const oscs = oscsSince(ctx, mark);
    expect(oscs).toHaveLength(tones.length);
    const envs = gainsInto(ctx, ui);
    expect(envs).toHaveLength(tones.length);
    let t = 1 + 0.005;
    tones.forEach((tone, i) => {
      const osc = oscs[i] as FakeOscillator;
      expect(osc.type).toBe(tone.wave);
      const set = osc.frequency.events.find((e) => e.kind === 'setValueAtTime');
      const ramp = osc.frequency.events.find((e) => e.kind === 'exponentialRamp');
      expect(set?.value).toBe(tone.hz);
      expect(set?.time).toBeCloseTo(t, 9);
      expect(ramp?.value).toBe(tone.toHz);
      expect(ramp?.time).toBeCloseTo(t + tone.durS, 9);
      expect(osc.started?.when).toBeCloseTo(t, 9);
      expect(osc.stoppedAt).toBeGreaterThan(t + tone.durS);
      expect(osc.connections[0]).toBe(envs[i]);
      expect(envs[i]?.gain.events.some((e) => e.kind === 'linearRamp' && e.value === tone.gain)).toBe(true);
      t += tone.durS;
    });
  });

  it('uses the listed frequencies (spot checks against the design table)', () => {
    const { engine, ctx } = unlocked();
    engine.ui.play('select');
    const osc = ctx.nodesOf<FakeOscillator>('oscillator').at(-1) as FakeOscillator;
    expect(osc.frequency.events.map((e) => e.value)).toEqual([660, 990]);
    ctx.currentTime = 1;
    engine.ui.play('notify');
    const two = ctx.nodesOf<FakeOscillator>('oscillator').slice(-2);
    expect(two.map((o) => o.frequency.events[0]?.value)).toEqual([1320, 1760]);
  });

  it('drops the same kind within the rate limit (context time) but not after, nor other kinds', () => {
    const { engine, ctx } = unlocked();
    const count = (): number => ctx.created['oscillator'] ?? 0;
    const base = count();
    ctx.currentTime = 10;
    engine.ui.play('move');
    expect(count() - base).toBe(1);
    engine.ui.play('move');
    expect(count() - base).toBe(1);
    ctx.currentTime = 10.059;
    engine.ui.play('move');
    expect(count() - base).toBe(1);
    // another kind is not limited
    engine.ui.play('select');
    expect(count() - base).toBe(2);
    ctx.currentTime = 10.061;
    engine.ui.play('move');
    expect(count() - base).toBe(3);
    // a dropped call does not extend the window
    ctx.currentTime = 10.1;
    engine.ui.play('move');
    expect(count() - base).toBe(3);
    ctx.currentTime = 10.122;
    engine.ui.play('move');
    expect(count() - base).toBe(4);
  });

  it('ignores unknown kinds', () => {
    const { engine, ctx } = unlocked();
    const before = ctx.totalCreated;
    for (const kind of ['', 'bleep', 'MOVE', 'constructor', '__proto__', 'toString']) engine.ui.play(kind);
    expect(ctx.totalCreated).toBe(before);
    expect(engine.stats.uiPlaying).toBe(0);
  });

  it('counts the playing tones and cleans up on onended', () => {
    const { engine, ctx } = unlocked();
    const mark = ctx.nodes.length;
    engine.ui.play('open');
    expect(engine.stats.uiPlaying).toBe(2);
    const oscs = oscsSince(ctx, mark);
    for (const o of oscs) o.onended?.();
    expect(engine.stats.uiPlaying).toBe(0);
    for (const n of ctx.nodes.slice(mark)) expect(n.disconnected, n.kind).toBeGreaterThan(0);
  });

  it('never throws, even when the context misbehaves', () => {
    const { ctx, ac, out } = fakeGraph();
    const ui = new UiSounds(createAudioStats());
    ui.attach(ac, out as unknown as AudioNode);
    (ctx as unknown as { createOscillator: () => never }).createOscillator = () => {
      throw new Error('boom');
    };
    expect(() => ui.play('select')).not.toThrow();
  });

  it('detach silences it again', () => {
    const { ctx, ac, out } = fakeGraph();
    const ui = new UiSounds();
    ui.attach(ac, out as unknown as AudioNode);
    ui.detach();
    const before = ctx.totalCreated;
    ui.play('select');
    expect(ctx.totalCreated).toBe(before);
  });

  it('the ui bus volume 0 sets the bus target 0; pause keeps the ui bus at its volume', () => {
    const { engine, ui } = unlocked();
    engine.setVolumes({ master: 1, sfx: 1, radio: 1, ambience: 1, ui: 0 });
    expect(ui.gain.target).toBe(0);
    engine.setVolumes({ master: 1, sfx: 1, radio: 1, ambience: 1, ui: 0.6 });
    engine.suspend();
    expect(ui.gain.target).toBe(0.6);
    engine.resume();
    expect(ui.gain.target).toBe(0.6);
  });

  it('sounds still play while the engine is suspended', () => {
    const { engine, ctx } = unlocked();
    engine.suspend();
    const before = ctx.created['oscillator'] ?? 0;
    ctx.currentTime = 5;
    engine.ui.play('open');
    expect(ctx.created['oscillator']).toBe(before + 2);
  });
});
