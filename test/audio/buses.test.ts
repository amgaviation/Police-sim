import { describe, expect, it } from 'vitest';
import { AUDIO_BUSES, AudioEngine } from '../../src/audio/engine';
import { createAudioStats } from '../../src/audio/sirens';
import { fakeFactory, type FakeContext, type FakeGain } from './fakeAudio';

function unlocked(): { engine: AudioEngine; ctx: FakeContext; buses: Record<(typeof AUDIO_BUSES)[number], FakeGain> } {
  const { ctx, factory } = fakeFactory();
  const engine = new AudioEngine({ contextFactory: factory });
  engine.unlock();
  const g = ctx.nodesOf<FakeGain>('gain');
  const buses = { master: g[0], sfx: g[1], radio: g[2], ambience: g[3], ui: g[4] } as Record<(typeof AUDIO_BUSES)[number], FakeGain>;
  return { engine, ctx, buses };
}

describe('audio buses', () => {
  it('lists the five buses in graph order', () => {
    expect([...AUDIO_BUSES]).toEqual(['master', 'sfx', 'radio', 'ambience', 'ui']);
  });

  it('wires destination <- master <- { sfx, radio, ambience, ui }', () => {
    const { ctx, buses } = unlocked();
    expect(buses.master.connections).toEqual([ctx.destination]);
    for (const name of ['sfx', 'radio', 'ambience', 'ui'] as const) expect(buses[name].connections, name).toEqual([buses.master]);
  });

  it('puts each module on its own bus', () => {
    const { engine, ctx, buses } = unlocked();
    const into = (bus: FakeGain): FakeGain[] => ctx.nodesOf<FakeGain>('gain').filter((g) => g.connections.includes(bus));
    const panners = ctx.nodesOf('panner');
    // sirens, driven engine and traffic engines: panners into sfx
    expect(panners.every((p) => p.connections.includes(buses.sfx))).toBe(true);
    // radio: the babble bed gain; ambience: post low-pass; ui: none until played
    expect(into(buses.radio)).toHaveLength(1);
    expect(ctx.nodesOf('biquad').some((b) => b.connections.includes(buses.ambience))).toBe(true);
    expect(into(buses.ui)).toHaveLength(0);
    engine.ui.play('select');
    expect(into(buses.ui)).toHaveLength(1);
    engine.radio.keyUp();
    expect(into(buses.radio).length).toBeGreaterThan(1);
  });

  it('applies each bus its own volume', () => {
    const { engine, buses } = unlocked();
    engine.setVolumes({ master: 0.1, sfx: 0.2, radio: 0.3, ambience: 0.4, ui: 0.5 });
    expect(buses.master.gain.target).toBe(0.1);
    expect(buses.sfx.gain.target).toBe(0.2);
    expect(buses.radio.gain.target).toBe(0.3);
    expect(buses.ambience.gain.target).toBe(0.4);
    expect(buses.ui.gain.target).toBe(0.5);
    for (const b of Object.values(buses)) expect(b.gain.events.at(-1)?.kind).toBe('setTargetAtTime');
  });

  it('master 0 silences everything', () => {
    const { engine, buses } = unlocked();
    engine.setVolumes({ master: 0, sfx: 1, radio: 1, ambience: 1, ui: 1 });
    expect(buses.master.gain.target).toBe(0);
    // every other bus feeds only the master, so nothing reaches the destination
    for (const name of ['sfx', 'radio', 'ambience', 'ui'] as const) expect(buses[name].connections).toEqual([buses.master]);
  });

  it('clamps values outside 0..1 and non-finite values', () => {
    const { engine, buses } = unlocked();
    engine.setVolumes({ master: 3, sfx: -2, radio: Number.NaN, ambience: Number.POSITIVE_INFINITY, ui: 1.5 });
    expect(buses.master.gain.target).toBe(1);
    expect(buses.sfx.gain.target).toBe(0);
    expect(buses.radio.gain.target).toBe(0);
    expect(buses.ambience.gain.target).toBe(0);
    expect(buses.ui.gain.target).toBe(1);
  });

  it('a missing ambience / ui (an older caller) defaults to 1', () => {
    const { engine, buses } = unlocked();
    engine.setVolumes({ master: 0.5, sfx: 0.5, radio: 0.5, ambience: 0.2, ui: 0.2 });
    engine.setVolumes({ master: 0.5, sfx: 0.5, radio: 0.5 });
    expect(buses.ambience.gain.target).toBe(1);
    expect(buses.ui.gain.target).toBe(1);
    engine.setVolumes({ master: 0.5, sfx: 0.5, radio: 0.5, ambience: undefined, ui: 0.3 });
    expect(buses.ambience.gain.target).toBe(1);
    expect(buses.ui.gain.target).toBe(0.3);
  });

  it('applies volumes set before unlock to all five buses', () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    engine.setVolumes({ master: 0.25, sfx: 0.5, radio: 0.75, ambience: 0.35, ui: 0.45 });
    engine.unlock();
    expect(ctx.nodesOf<FakeGain>('gain').slice(0, 5).map((g) => g.gain.value)).toEqual([0.25, 0.5, 0.75, 0.35, 0.45]);
  });

  it('pause mutes sfx, radio and ambience (tau 0.03), keeps master and ui, and resume restores', () => {
    const { engine, ctx, buses } = unlocked();
    engine.setVolumes({ master: 0.8, sfx: 0.9, radio: 0.7, ambience: 0.6, ui: 0.5 });
    engine.suspend();
    expect(buses.sfx.gain.target).toBe(0);
    expect(buses.radio.gain.target).toBe(0);
    expect(buses.ambience.gain.target).toBe(0);
    expect(buses.ui.gain.target).toBe(0.5);
    expect(buses.master.gain.target).toBe(0.8);
    expect(ctx.state).toBe('running');
    expect(ctx.suspendCalls).toBe(0);
    engine.resume();
    expect([buses.sfx.gain.target, buses.radio.gain.target, buses.ambience.gain.target]).toEqual([0.9, 0.7, 0.6]);
  });

  it('suspend before unlock builds the world buses muted', () => {
    const { ctx, factory } = fakeFactory();
    const engine = new AudioEngine({ contextFactory: factory });
    engine.setVolumes({ master: 0.8, sfx: 1, radio: 1, ambience: 1, ui: 0.6 });
    engine.suspend();
    engine.unlock();
    expect(ctx.state).toBe('running');
    expect(ctx.nodesOf<FakeGain>('gain').slice(0, 5).map((g) => g.gain.value)).toEqual([0.8, 0, 0, 0, 0.6]);
  });
});

describe('audio engine stats and budget', () => {
  it('starts with zeroed stats and exposes the new members', () => {
    const engine = new AudioEngine({ contextFactory: null });
    expect(engine.stats).toEqual(createAudioStats());
    expect(engine.stats).toEqual({ voices: 0, active: 0, engine: 0, traffic: 0, ambienceLayers: 0, uiPlaying: 0, chatter: 0 });
    expect(engine.vehicles).toBeDefined();
    expect(engine.ambience).toBeDefined();
    expect(engine.ui).toBeDefined();
  });

  it('reports the engine, traffic, ambience layers, ui and chatter in one stats object', () => {
    const { engine, ctx } = unlocked();
    engine.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0);
    engine.vehicles.update(
      { active: true, profile: 'car', rpm: 2000, throttle: 0.5, running: true, speed: 5, groundSpeed: 5, brake: 0, handbrake: false, absActive: false, surface: 0, airborne: false, inCabin: false, x: 0, y: 0, z: 0 },
      [{ id: 1, x: 10, y: 0, z: 0, speed: 8 }],
      1,
    );
    engine.ambience.update({ district: 'downtown', hour: 12, weather: 'clear', rain: 0, wind: 0, indoor: false, inCabin: false }, 0.016);
    engine.ui.play('select');
    engine.radio.chatter(1, 1);
    ctx.currentTime = 0;
    expect(engine.stats.voices).toBeGreaterThan(0);
    expect(engine.stats.engine).toBe(1);
    expect(engine.stats.traffic).toBe(1);
    expect(engine.stats.ambienceLayers).toBeGreaterThan(0);
    expect(engine.stats.uiPlaying).toBe(1);
    expect(engine.stats.chatter).toBe(1);
    engine.dispose();
    expect(engine.stats.voices).toBe(0);
    expect(engine.stats.engine).toBe(0);
    expect(engine.stats.traffic).toBe(0);
    expect(engine.stats.ambienceLayers).toBe(0);
    expect(engine.stats.chatter).toBe(0);
  });

  it('keeps the steady graph within 120 nodes', () => {
    const { ctx } = unlocked();
    const nodes = ctx.totalCreated - (ctx.created['buffer'] ?? 0);
    expect(nodes).toBeLessThanOrEqual(120);
  });

  it('creates no nodes over 1000 frames of every per-frame update', () => {
    const { engine, ctx } = unlocked();
    const driven = { active: true, profile: 'car' as const, rpm: 2000, throttle: 0.5, running: true, speed: 5, groundSpeed: 9, brake: 0, handbrake: false, absActive: false, surface: 2, airborne: false, inCabin: false, x: 0, y: 0, z: 0 };
    const cars = [{ id: 1, x: 10, y: 0, z: 0, speed: 8 }, { id: 2, x: -20, y: 0, z: 5, speed: 12 }];
    // storm: no bird chirps (single-use sources are the only nodes the bed may create later)
    const amb = { district: 'downtown', hour: 12, weather: 'storm', rain: 0, wind: 0, indoor: false, inCabin: false };
    // Warm up one frame so lazily created single-use sources (none expected here) are excluded.
    engine.vehicles.update(driven, cars, 2);
    const before = ctx.totalCreated;
    for (let f = 0; f < 1000; f++) {
      ctx.currentTime = f / 60;
      driven.rpm = 1000 + (f % 300) * 10;
      driven.inCabin = f % 200 < 100;
      driven.surface = f % 6;
      amb.hour = (f / 40) % 24;
      amb.indoor = f % 500 < 100;
      const first = cars[0];
      if (first) first.x = (f % 100) - 20;
      engine.setListener(0, 0, 0, 0, 0, -1, 0, 1, 0);
      engine.setListenerVelocity(f % 10, 0, 0);
      engine.vehicles.update(driven, cars, 2);
      engine.ambience.update(amb, 1 / 60);
    }
    expect(ctx.totalCreated).toBe(before);
  });
});
