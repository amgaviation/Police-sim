import { describe, expect, it } from 'vitest';
import { CHATTER_DATA, parseChatter } from '../../src/audio/chatterData';
import { AudioEngine } from '../../src/audio/engine';
import { RadioFx } from '../../src/audio/radioFx';
import { createAudioStats } from '../../src/audio/sirens';
import chatterJson from '../../src/data/audio/chatter.json';
import {
  fakeFactory,
  fakeGraph,
  gainsInto,
  type FakeBiquad,
  type FakeBufferSource,
  type FakeContext,
  type FakeGain,
  type FakeNode,
  type FakeOscillator,
} from './fakeAudio';

function unlocked(): { engine: AudioEngine; ctx: FakeContext; radioBus: FakeGain } {
  const { ctx, factory } = fakeFactory();
  const engine = new AudioEngine({ contextFactory: factory });
  engine.unlock();
  return { engine, ctx, radioBus: ctx.nodesOf<FakeGain>('gain')[2] as FakeGain };
}

/** Nodes created since `mark` (a `ctx.nodes.length` snapshot). */
function since(ctx: FakeContext, mark: number): FakeNode[] {
  return ctx.nodes.slice(mark);
}

describe('chatter.json', () => {
  it('validates and matches the design table', () => {
    expect(CHATTER_DATA.formantsHz).toEqual([500, 1500, 2500]);
    expect(CHATTER_DATA.maxBursts).toBe(3);
    expect(CHATTER_DATA.bedPerTransmission).toBe(0.5);
  });

  it('names the file and the dotted path on bad data', () => {
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(chatterJson)) as Record<string, unknown>;
    expect(() => parseChatter({ ...chatterJson, version: 3 })).toThrow(/chatter\.json: version/);
    expect(() => parseChatter({ ...chatterJson, formantsHz: [500, 1500] })).toThrow(/chatter\.json: formantsHz/);
    expect(() => parseChatter({ ...chatterJson, formantsHz: [500, 'x', 2500] })).toThrow(/chatter\.json: formantsHz\[1\]/);
    expect(() => parseChatter({ ...chatterJson, syllableHz: [6, 3] })).toThrow(/chatter\.json: syllableHz\[1\]/);
    expect(() => parseChatter({ ...chatterJson, bandHz: [300] })).toThrow(/chatter\.json: bandHz/);
    expect(() => parseChatter({ ...chatterJson, burstLevel: 2 })).toThrow(/chatter\.json: burstLevel/);
    expect(() => parseChatter({ ...chatterJson, maxBursts: 0 })).toThrow(/chatter\.json: maxBursts/);
    const missing = clone();
    delete missing['bedLevel'];
    expect(() => parseChatter(missing)).toThrow(/chatter\.json: bedLevel/);
    expect(() => parseChatter(chatterJson, 'x.json')).not.toThrow();
    expect(() => parseChatter({ ...chatterJson, formantQ: 0 }, 'x.json')).toThrow(/x\.json: formantQ/);
  });
});

describe('RadioFx.chatter', () => {
  it('is a no-op without an unlocked context and never throws', () => {
    const fx = new RadioFx();
    expect(() => {
      fx.chatter(1, 1);
      fx.setBed(1);
      fx.detach();
    }).not.toThrow();
    const engine = new AudioEngine({ contextFactory: null });
    expect(() => {
      engine.radio.chatter(2, 1);
      engine.radio.setBed(0.5);
    }).not.toThrow();
  });

  it('builds a formant babble chain on the radio bus and cleans it up on onended', () => {
    const { engine, ctx, radioBus } = unlocked();
    const mark = ctx.nodes.length;
    engine.radio.chatter(1.5, 1);
    const made = since(ctx, mark);
    const src = made.find((n) => n.kind === 'bufferSource') as FakeBufferSource;
    const biquads = made.filter((n) => n.kind === 'biquad') as FakeBiquad[];
    const lfo = made.find((n) => n.kind === 'oscillator') as FakeOscillator;
    expect(src.loop).toBe(true);
    expect(src.started).not.toBeNull();
    expect(src.stoppedAt).toBeGreaterThan(src.started?.when ?? Infinity);
    expect(lfo.type).toBe('square');
    // three formants plus a band limit
    const formants = biquads.filter((b) => b.type === 'bandpass' && CHATTER_DATA.formantsHz.includes(b.frequency.value));
    expect(formants.map((b) => b.frequency.value).sort((a, b) => a - b)).toEqual([...CHATTER_DATA.formantsHz]);
    for (const f of formants) expect(f.Q.value).toBe(CHATTER_DATA.formantQ);
    // the syllable rate comes from the data range
    expect(lfo.frequency.value).toBeGreaterThanOrEqual(CHATTER_DATA.syllableHz[0]);
    expect(lfo.frequency.value).toBeLessThanOrEqual(CHATTER_DATA.syllableHz[1]);
    // the burst envelope feeds the radio bus at burstLevel
    const env = made.find((n) => n.kind === 'gain' && n.connections.includes(radioBus)) as FakeGain;
    expect(env).toBeDefined();
    expect(env.gain.events.some((e) => e.kind === 'linearRamp' && Math.abs(e.value - CHATTER_DATA.burstLevel) < 1e-12)).toBe(true);
    expect(engine.stats.chatter).toBe(1);
    // end of the source: every node of the burst is disconnected
    expect(src.onended).toBeTypeOf('function');
    src.onended?.();
    for (const n of made) expect(n.disconnected, n.kind).toBeGreaterThan(0);
    expect(engine.stats.chatter).toBe(0);
    // idempotent
    src.onended?.();
    expect(engine.stats.chatter).toBe(0);
  });

  it('scales the burst by level and by the radio fx level', () => {
    const { engine, ctx, radioBus } = unlocked();
    const levelOf = (): number => {
      const env = gainsInto(ctx, radioBus).at(-1) as FakeGain;
      return env.gain.events.find((e) => e.kind === 'linearRamp')?.value ?? -1;
    };
    engine.radio.chatter(1, 0.5);
    expect(levelOf()).toBeCloseTo(CHATTER_DATA.burstLevel * 0.5, 12);
    engine.radio.level = 0.5;
    engine.radio.chatter(1, 1);
    expect(levelOf()).toBeCloseTo(CHATTER_DATA.burstLevel * 0.5, 12);
    engine.radio.level = 1;
    // silly arguments: level 0 / NaN make no burst, a NaN or huge duration is clamped
    const before = ctx.totalCreated;
    engine.radio.chatter(1, 0);
    engine.radio.chatter(1, Number.NaN);
    expect(ctx.totalCreated).toBe(before);
    expect(() => {
      engine.radio.chatter(Number.NaN, 1);
      engine.radio.chatter(1e9, 1);
      engine.radio.chatter(-5, 1);
    }).not.toThrow();
  });

  it('keeps at most maxBursts alive and cuts the oldest', () => {
    const { engine, ctx } = unlocked();
    const max = CHATTER_DATA.maxBursts;
    const sources: FakeBufferSource[] = [];
    for (let i = 0; i < max + 2; i++) {
      const before = ctx.nodesOf<FakeBufferSource>('bufferSource').length;
      engine.radio.chatter(5, 1);
      sources.push(ctx.nodesOf<FakeBufferSource>('bufferSource')[before] as FakeBufferSource);
      expect(engine.stats.chatter).toBe(Math.min(i + 1, max));
    }
    // the two oldest were cut: stopped almost at once instead of after 5 s
    for (const s of sources.slice(0, 2)) expect(s.stoppedAt).toBeLessThan(1);
    for (const s of sources.slice(2)) expect(s.stoppedAt).toBeGreaterThan(5);
    // a cut source's late onended does not disturb the count
    sources[0]?.onended?.();
    expect(engine.stats.chatter).toBe(max);
    sources[4]?.onended?.();
    expect(engine.stats.chatter).toBe(max - 1);
  });

  it('draws the syllable rate from the seeded stream (same sequence on a fresh engine)', () => {
    const rates = (): number[] => {
      const { engine, ctx } = unlocked();
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        engine.radio.chatter(0.5, 1);
        out.push((ctx.nodesOf<FakeOscillator>('oscillator').at(-1) as FakeOscillator).frequency.value);
      }
      return out;
    };
    const a = rates();
    expect(a).toEqual(rates());
    expect(new Set(a).size).toBeGreaterThan(1);
  });

  it('detach disconnects live bursts', () => {
    const { engine, ctx } = unlocked();
    const mark = ctx.nodes.length;
    engine.radio.chatter(2, 1);
    const made = since(ctx, mark);
    engine.dispose();
    for (const n of made) expect(n.disconnected, n.kind).toBeGreaterThan(0);
    expect(engine.stats.chatter).toBe(0);
  });
});

describe('RadioFx bed', () => {
  it('is built once at attach and survives bursts', () => {
    const { ctx, ac, out, noise } = fakeGraph();
    const stats = createAudioStats();
    const fx = new RadioFx(stats);
    const before = ctx.totalCreated;
    fx.attach(ac, out as unknown as AudioNode, noise);
    const built = ctx.totalCreated - before;
    expect(built).toBeGreaterThan(5);
    // one babble chain: one source, one square LFO, three formants + band limit
    expect(ctx.created['bufferSource']).toBe(1);
    expect(ctx.nodesOf<FakeOscillator>('oscillator').filter((o) => o.type === 'square')).toHaveLength(1);
    const bedGains = gainsInto(ctx, out);
    expect(bedGains).toHaveLength(1);
    fx.setBed(1);
    fx.setBed(0.5);
    fx.keyUp();
    expect(ctx.created['bufferSource']).toBe(3); // bed + key-up click + key-up static
    expect(gainsInto(ctx, out).length).toBeGreaterThanOrEqual(1);
  });

  it('glides to level x bedLevel (tau 0.3 s) and clamps', () => {
    const { engine, ctx, radioBus } = unlocked();
    const bed = gainsInto(ctx, radioBus)[0] as FakeGain;
    expect(bed.gain.target).toBe(0);
    engine.radio.setBed(0.5);
    expect(bed.gain.target).toBeCloseTo(0.5 * CHATTER_DATA.bedLevel, 12);
    expect(bed.gain.events.at(-1)?.kind).toBe('setTargetAtTime');
    engine.radio.setBed(7);
    expect(bed.gain.target).toBeCloseTo(CHATTER_DATA.bedLevel, 12);
    engine.radio.setBed(-1);
    expect(bed.gain.target).toBe(0);
    engine.radio.setBed(Number.NaN);
    expect(bed.gain.target).toBe(0);
  });

  it('applies a level set before unlock when the graph is built', () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    engine.radio.setBed(1);
    engine.unlock();
    const radioBus = ctx.nodesOf<FakeGain>('gain')[2] as FakeGain;
    expect(gainsInto(ctx, radioBus)[0]?.gain.value).toBeCloseTo(CHATTER_DATA.bedLevel, 12);
  });

  it('follows the radio bus volume (the bed is under the radio bus)', () => {
    const { engine, ctx, radioBus } = unlocked();
    engine.setVolumes({ master: 1, sfx: 1, radio: 0, ambience: 1, ui: 1 });
    expect(radioBus.gain.target).toBe(0);
    expect(gainsInto(ctx, radioBus).length).toBeGreaterThanOrEqual(1);
  });
});
