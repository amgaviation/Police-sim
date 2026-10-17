import { describe, expect, it } from 'vitest';
import { createAudioCommands } from '../../src/audio/commands';
import { SIREN_DATA } from '../../src/audio/data';
import { AudioEngine } from '../../src/audio/engine';
import type { SirenEmitter } from '../../src/audio/math';
import type { CommandContext } from '../../src/debug/console';
import { SpeechOut } from '../../src/speech/synthesis';
import {
  fakeFactory,
  type FakeBufferSource,
  type FakeContext,
  type FakeGain,
  type FakeOscillator,
  type FakePanner,
} from './fakeAudio';

function emitter(id: number, x: number, z: number, extra: Partial<SirenEmitter> = {}): SirenEmitter {
  return { id, x, y: 1, z, tone: 'wail', horn: false, manual: false, inCabin: false, ...extra };
}

function unlocked(): { engine: AudioEngine; ctx: FakeContext } {
  const { ctx, factory } = fakeFactory();
  const engine = new AudioEngine({ contextFactory: factory });
  engine.unlock();
  return { engine, ctx };
}

/** Panner of each voice in build order. */
function panners(ctx: FakeContext): FakePanner[] {
  return ctx.nodesOf<FakePanner>('panner');
}

/** Voice output gain (the node feeding each panner). */
function voiceGains(ctx: FakeContext): FakeGain[] {
  const out: FakeGain[] = [];
  for (const p of panners(ctx)) {
    const g = ctx.nodesOf<FakeGain>('gain').find((n) => n.connections.includes(p));
    if (g) out.push(g);
  }
  return out;
}

/** Index of the voice whose panner sits at (x, z). */
function voiceAt(ctx: FakeContext, x: number, z: number): number {
  return panners(ctx).findIndex((p) => p.positionX.value === x && p.positionZ.value === z);
}

const CMD_CTX = {} as CommandContext;

describe('AudioEngine headless', () => {
  it('is unavailable and every method is a no-op without AudioContext', () => {
    const engine = new AudioEngine();
    expect(engine.available).toBe(false);
    expect(engine.unlocked).toBe(false);
    expect(() => {
      engine.unlock();
      engine.setVolumes({ master: 0.5, sfx: 0.5, radio: 0.5 });
      engine.suspend();
      engine.resume();
      engine.setListener(1, 2, 3, 0, 0, -1, 0, 1, 0);
      engine.sirens.update([emitter(1, 0, 0)], 1, 0, 0);
      engine.sirens.test('yelp');
      engine.radio.keyUp();
      engine.radio.squelchTail();
      engine.radio.static(1, 0.5);
      engine.radio.heterodyne(1);
      engine.radio.priorityTone();
      engine.radio.alertTone('hit');
      engine.radio.alertTone('offer');
      engine.radio.alertTone('statusCheck');
      engine.dispose();
    }).not.toThrow();
    expect(engine.unlocked).toBe(false);
    expect(engine.stats).toEqual({ voices: 0, active: 0 });
  });

  it('treats an explicit null factory as unavailable', () => {
    expect(new AudioEngine({ contextFactory: null }).available).toBe(false);
  });

  it('survives a throwing context constructor', () => {
    const engine = new AudioEngine({
      contextFactory: () => {
        throw new Error('no audio device');
      },
    });
    expect(engine.available).toBe(true);
    expect(() => engine.unlock()).not.toThrow();
    expect(engine.available).toBe(false);
    expect(engine.unlocked).toBe(false);
  });
});

describe('AudioEngine with a fake context', () => {
  it('builds the graph once on unlock and resumes the suspended context', () => {
    const { ctx, factory } = fakeFactory();
    let made = 0;
    const engine = new AudioEngine({
      contextFactory: () => {
        made++;
        return factory();
      },
    });
    expect(engine.unlocked).toBe(false);
    expect(ctx.totalCreated).toBe(0);
    engine.unlock();
    expect(engine.unlocked).toBe(true);
    expect(ctx.resumeCalls).toBe(1);
    const created = { ...ctx.created };
    const voices = SIREN_DATA.voices;
    const hornCount = SIREN_DATA.horn.freqsHz.length;
    expect(created['panner']).toBe(voices);
    expect(created['oscillator']).toBe(voices * (2 + hornCount));
    expect(created['waveShaper']).toBe(voices);
    expect(created['biquad']).toBe(voices);
    expect(created['gain']).toBe(3 + voices * 4);
    expect(created['buffer']).toBe(1);
    expect(engine.stats.voices).toBe(voices);

    engine.unlock();
    engine.unlock();
    expect(made).toBe(1);
    expect(ctx.created).toEqual(created);
    expect(ctx.resumeCalls).toBe(1);
  });

  it('configures the siren voices from sirens.json', () => {
    const { ctx } = unlocked();
    for (const p of panners(ctx)) {
      expect(p.panningModel).toBe('equalpower');
      expect(p.distanceModel).toBe('inverse');
      expect(p.refDistance).toBe(SIREN_DATA.panner.refDistance);
      expect(p.rolloffFactor).toBe(SIREN_DATA.panner.rolloff);
      expect(p.maxDistance).toBe(SIREN_DATA.panner.maxDistance);
    }
    const oscs = ctx.nodesOf<FakeOscillator>('oscillator');
    expect(oscs.every((o) => o.started !== null)).toBe(true);
    expect(oscs.filter((o) => o.type === 'sawtooth').length).toBeGreaterThanOrEqual(SIREN_DATA.voices * 2);
    // LFO depth gains feed an oscillator frequency param.
    const lfoDepths = ctx.nodesOf<FakeGain>('gain').filter((g) => oscs.some((o) => g.connections.includes(o.frequency)));
    expect(lfoDepths).toHaveLength(SIREN_DATA.voices);
  });

  it('swallows a rejected resume', async () => {
    const { ctx, factory } = fakeFactory();
    ctx.rejectResume = true;
    const engine = new AudioEngine({ contextFactory: factory });
    expect(() => engine.unlock()).not.toThrow();
    await Promise.resolve();
    expect(engine.unlocked).toBe(true);
  });

  it('applies volumes to the master, sfx and radio buses', () => {
    const { engine, ctx } = unlocked();
    const [master, sfx, radio] = ctx.nodesOf<FakeGain>('gain');
    expect(master?.connections).toContain(ctx.destination);
    expect(sfx?.connections).toContain(master);
    expect(radio?.connections).toContain(master);
    expect(master?.gain.value).toBe(0.8);
    engine.setVolumes({ master: 0.3, sfx: 0.6, radio: 2 });
    expect(master?.gain.target).toBe(0.3);
    expect(sfx?.gain.target).toBe(0.6);
    expect(radio?.gain.target).toBe(1);
    engine.setVolumes({ master: Number.NaN, sfx: -1, radio: 0.5 });
    expect(master?.gain.target).toBe(0);
    expect(sfx?.gain.target).toBe(0);
  });

  it('applies volumes set before unlock', () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    engine.setVolumes({ master: 0.25, sfx: 0.5, radio: 0.75 });
    engine.unlock();
    const [master, sfx, radio] = ctx.nodesOf<FakeGain>('gain');
    expect([master?.gain.value, sfx?.gain.value, radio?.gain.value]).toEqual([0.25, 0.5, 0.75]);
  });

  it('suspends and resumes with the pause state', () => {
    const { engine, ctx } = unlocked();
    expect(ctx.state).toBe('running');
    engine.suspend();
    expect(ctx.state).toBe('suspended');
    engine.unlock();
    expect(ctx.state).toBe('suspended');
    engine.resume();
    expect(ctx.state).toBe('running');
  });

  it('writes the listener pose', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(1, 2, 3, 0, 0, 1, 0, 1, 0);
    const l = ctx.listener;
    expect([l.positionX.value, l.positionY.value, l.positionZ.value]).toEqual([1, 2, 3]);
    expect([l.forwardX.value, l.forwardY.value, l.forwardZ.value]).toEqual([0, 0, 1]);
    expect([l.upX.value, l.upY.value, l.upZ.value]).toEqual([0, 1, 0]);
  });

  it('creates zero nodes over 1000 siren updates', () => {
    const { engine, ctx } = unlocked();
    const list: SirenEmitter[] = [];
    for (let i = 0; i < 10; i++) list.push(emitter(100 + i, i * 30, 0, { tone: (['wail', 'yelp', 'phaser', 'hilo'] as const)[i % 4] }));
    const before = ctx.totalCreated;
    for (let f = 0; f < 1000; f++) {
      ctx.currentTime = f / 60;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e) continue;
        e.x = ((i * 30 + f * 3) % 900) - 100;
        e.horn = (f + i) % 50 < 10;
        e.manual = i === 3 && f % 200 < 100;
        e.inCabin = i === 0;
      }
      engine.setListener(0, 1, 0, 0, 0, -1, 0, 1, 0);
      engine.sirens.update(list, list.length, 0, 0);
    }
    expect(ctx.totalCreated).toBe(before);
    expect(engine.stats.active).toBeLessThanOrEqual(SIREN_DATA.voices);
  });

  it('keeps a voice on its emitter while selected (sticky assignment)', () => {
    const { engine, ctx } = unlocked();
    const a = emitter(1, 100, 0);
    const b = emitter(2, 200, 0);
    engine.sirens.update([a, b], 2, 0, 0);
    expect(engine.stats.active).toBe(2);
    const va = voiceAt(ctx, 100, 0);
    const vb = voiceAt(ctx, 200, 0);
    expect(va).toBeGreaterThanOrEqual(0);
    expect(vb).toBeGreaterThanOrEqual(0);
    // Order and distance change: same voices follow the same emitters.
    a.x = 300;
    b.x = 50;
    engine.sirens.update([b, a], 2, 0, 0);
    expect(voiceAt(ctx, 300, 0)).toBe(va);
    expect(voiceAt(ctx, 50, 0)).toBe(vb);
  });

  it('gives voices to the nearest emitters and fades out the rest', () => {
    const { engine, ctx } = unlocked();
    const list = [emitter(1, 10, 0), emitter(2, 20, 0), emitter(3, 30, 0), emitter(4, 40, 0), emitter(5, 50, 0)];
    engine.sirens.update(list, list.length, 0, 0);
    expect(engine.stats.active).toBe(4);
    expect(voiceAt(ctx, 50, 0)).toBe(-1);
    const gains = voiceGains(ctx);
    expect(gains.every((g) => g.gain.target === SIREN_DATA.voice.gain)).toBe(true);
    // Emitter 1 goes silent: its voice fades and the far emitter takes a voice.
    const v1 = voiceAt(ctx, 10, 0);
    const first = list[0];
    if (first) first.tone = null;
    engine.sirens.update(list, list.length, 0, 0);
    expect(engine.stats.active).toBe(4);
    expect(voiceAt(ctx, 50, 0)).toBe(v1);
    // Everything silent: all voices fade to 0.
    for (const e of list) e.tone = null;
    engine.sirens.update(list, list.length, 0, 0);
    expect(engine.stats.active).toBe(0);
    expect(gains.every((g) => g.gain.target === 0)).toBe(true);
  });

  it('ignores emitters beyond maxAudibleM', () => {
    const { engine } = unlocked();
    engine.sirens.update([emitter(1, SIREN_DATA.maxAudibleM + 1, 0)], 1, 0, 0);
    expect(engine.stats.active).toBe(0);
  });

  it('places in-cabin voices at the listener with cabin gain and lowpass', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(500, 2, -40, 0, 0, -1, 0, 1, 0);
    engine.sirens.update([emitter(7, 9999, 9999, { inCabin: true })], 1, 500, -40);
    expect(engine.stats.active).toBe(1);
    const v = voiceAt(ctx, 500, -40);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(panners(ctx)[v]?.positionY.value).toBe(2);
    expect(voiceGains(ctx)[v]?.gain.target).toBeCloseTo(SIREN_DATA.voice.gain * SIREN_DATA.cabin.gain);
    const lowpasses = ctx.nodesOf<{ frequency: { target: number } } & FakeGain>('biquad');
    expect(lowpasses[v]?.frequency.target).toBe(SIREN_DATA.cabin.lowpassHz);
  });

  it('retunes the LFO on tone changes and winds the manual siren', () => {
    const { engine, ctx } = unlocked();
    const e = emitter(1, 10, 0, { tone: 'yelp' });
    engine.sirens.update([e], 1, 0, 0);
    const oscs = ctx.nodesOf<FakeOscillator>('oscillator');
    const yelp = SIREN_DATA.tones.yelp;
    const lfo = oscs.find((o) => o.frequency.target === 1 / yelp.periodS);
    expect(lfo?.type).toBe(yelp.shape);
    e.tone = 'hilo';
    engine.sirens.update([e], 1, 0, 0);
    expect(oscs.some((o) => o.type === 'square' && o.frequency.target === 1 / SIREN_DATA.tones.hilo.periodS)).toBe(true);
    e.tone = null;
    e.manual = true;
    engine.sirens.update([e], 1, 0, 0);
    expect(oscs.some((o) => o.frequency.target === SIREN_DATA.manual.maxHz)).toBe(true);
    e.manual = false;
    engine.sirens.update([e], 1, 0, 0);
    expect(oscs.some((o) => o.frequency.target === SIREN_DATA.manual.minHz)).toBe(true);
    expect(engine.stats.active).toBe(0);
  });

  it('gates the air horn', () => {
    const { engine, ctx } = unlocked();
    const e = emitter(1, 10, 0, { tone: null, horn: true });
    engine.sirens.update([e], 1, 0, 0);
    const hornGates = ctx
      .nodesOf<FakeGain>('gain')
      .filter((g) => ctx.nodesOf<FakeOscillator>('oscillator').some((o) => o.connections.includes(g) && o.frequency.value === SIREN_DATA.horn.freqsHz[0]));
    expect(hornGates.some((g) => g.gain.target > 0)).toBe(true);
    e.horn = false;
    e.tone = 'wail';
    engine.sirens.update([e], 1, 0, 0);
    expect(hornGates.every((g) => g.gain.target === 0)).toBe(true);
  });

  it('plays the console siren test in the cabin for its duration', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(5, 1, 5, 0, 0, -1, 0, 1, 0);
    engine.sirens.test('phaser', 3);
    engine.sirens.update([], 0, 5, 5);
    expect(engine.stats.active).toBe(1);
    ctx.currentTime = 3.5;
    engine.sirens.update([], 0, 5, 5);
    expect(engine.stats.active).toBe(0);
  });

  it('schedules short sources for every radio effect on the radio bus', () => {
    const { engine, ctx } = unlocked();
    const radioBus = ctx.nodesOf<FakeGain>('gain')[2];
    const count = (): number => ctx.totalCreated;
    const sources = (): number => (ctx.created['oscillator'] ?? 0) + (ctx.created['bufferSource'] ?? 0);
    const cases: [string, () => void, number][] = [
      ['keyUp', () => engine.radio.keyUp(), 2],
      ['squelchTail', () => engine.radio.squelchTail(), 1],
      ['static', () => engine.radio.static(0.5, 0.3), 1],
      ['heterodyne', () => engine.radio.heterodyne(0.8), 3],
      ['priorityTone', () => engine.radio.priorityTone(), 6],
      ['hit', () => engine.radio.alertTone('hit'), 3],
      ['offer', () => engine.radio.alertTone('offer'), 2],
      ['statusCheck', () => engine.radio.alertTone('statusCheck'), 2],
    ];
    for (const [name, fn, expected] of cases) {
      const before = count();
      const srcBefore = sources();
      fn();
      expect(count(), name).toBeGreaterThan(before);
      expect(sources() - srcBefore, name).toBe(expected);
    }
    const scheduled = [...ctx.nodesOf<FakeOscillator>('oscillator'), ...ctx.nodesOf<FakeBufferSource>('bufferSource')].filter(
      (s) => s.stoppedAt !== null,
    );
    expect(scheduled.length).toBe(20);
    for (const s of scheduled) {
      expect(s.started).not.toBeNull();
      expect(s.stoppedAt).toBeGreaterThan(s.started?.when ?? Infinity);
      expect(s.onended).toBeTypeOf('function');
      s.onended?.();
    }
    // onended disconnects every effect envelope from the radio bus.
    const envs = ctx.nodesOf<FakeGain>('gain').filter((g) => g.connections.includes(radioBus));
    expect(envs.length).toBe(0);
    const priority = ctx
      .nodesOf<FakeOscillator>('oscillator')
      .filter((o) => o.frequency.value === 1400 || o.frequency.value === 850)
      .map((o) => o.frequency.value);
    expect(priority.slice(0, 6)).toEqual([1400, 850, 1400, 850, 1400, 850]);
  });

  it('routes radio effects through the radio bus', () => {
    const { engine, ctx } = unlocked();
    const radioBus = ctx.nodesOf<FakeGain>('gain')[2];
    engine.radio.static(0.2, 0.2);
    const env = ctx.nodesOf<FakeGain>('gain').at(-1);
    expect(env?.connections).toContain(radioBus);
    expect(env?.gain.events.some((ev) => ev.kind === 'linearRamp' && ev.value === 0.2)).toBe(true);
  });

  it('tolerates silly effect arguments', () => {
    const { engine } = unlocked();
    expect(() => {
      engine.radio.static(Number.NaN, Number.POSITIVE_INFINITY);
      engine.radio.static(-1, -1);
      engine.radio.heterodyne(1e9);
    }).not.toThrow();
  });

  it('disposes: closes the context and becomes inert', () => {
    const { engine, ctx } = unlocked();
    engine.dispose();
    expect(ctx.closeCalls).toBe(1);
    expect(engine.available).toBe(false);
    expect(engine.unlocked).toBe(false);
    const before = ctx.totalCreated;
    engine.unlock();
    engine.radio.keyUp();
    engine.sirens.update([emitter(1, 1, 1)], 1, 0, 0);
    expect(ctx.totalCreated).toBe(before);
    engine.dispose();
    expect(ctx.closeCalls).toBe(1);
  });
});

describe('audio commands', () => {
  it('sirentest validates its argument and no-ops headless', async () => {
    const engine = new AudioEngine();
    const cmds = createAudioCommands({ audio: () => engine, speech: () => null });
    const sirentest = cmds.find((c) => c.name === 'sirentest');
    expect(sirentest).toBeDefined();
    expect(() => sirentest?.run(['bogus'], CMD_CTX)).toThrow(/Usage/);
    expect(await sirentest?.run(['wail'], CMD_CTX)).toBe('Audio unavailable');
  });

  it('sirentest unlocks and plays on the engine', async () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    const cmds = createAudioCommands({ audio: () => engine, speech: () => null });
    const sirentest = cmds.find((c) => c.name === 'sirentest');
    expect(await sirentest?.run(['horn'], CMD_CTX)).toMatch(/horn/);
    expect(engine.unlocked).toBe(true);
    engine.sirens.update([], 0, 0, 0);
    expect(engine.stats.active).toBe(1);
    await sirentest?.run(['off'], CMD_CTX);
    engine.sirens.update([], 0, 0, 0);
    expect(engine.stats.active).toBe(0);
    expect(ctx.state).toBe('running');
  });

  it('voices reports unavailable synthesis', async () => {
    const cmds = createAudioCommands({ audio: () => null, speech: () => null });
    expect(await cmds.find((c) => c.name === 'voices')?.run([], CMD_CTX)).toMatch(/unavailable/);
  });
});

describe('voices command', () => {
  it('lists voices with local/remote marks', async () => {
    const synth = {
      speak: () => undefined,
      cancel: () => undefined,
      pause: () => undefined,
      resume: () => undefined,
      getVoices: () => [
        { name: 'Alpha', lang: 'en-US', localService: true },
        { name: 'Beta', lang: 'fr-FR', localService: false },
      ],
    };
    const speech = new SpeechOut({ synth, utteranceFactory: (text) => ({ text, voice: null, lang: '', pitch: 1, rate: 1, volume: 1, onend: null, onerror: null }) });
    const cmds = createAudioCommands({ audio: () => null, speech: () => speech });
    const text = await cmds.find((c) => c.name === 'voices')?.run([], CMD_CTX);
    expect(text).toContain('local   en-US  Alpha');
    expect(text).toContain('remote  fr-FR  Beta  (not in pool)');
  });
});
