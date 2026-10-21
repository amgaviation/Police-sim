import { describe, expect, it } from 'vitest';
import { AMBIENCE_LAYERS } from '../../src/audio/ambienceData';
import { createAudioCommands } from '../../src/audio/commands';
import { AudioEngine } from '../../src/audio/engine';
import type { Command, CommandContext } from '../../src/debug/console';
import { fakeFactory, type FakeContext } from './fakeAudio';

const CTX = {} as CommandContext;

function commands(engine: AudioEngine | null): Map<string, Command> {
  const list = createAudioCommands({ audio: () => engine, speech: () => null });
  return new Map(list.map((c) => [c.name, c]));
}

function run(cmd: Command | undefined, args: string[]): string {
  if (!cmd) throw new Error('missing command');
  const out = cmd.run(args, CTX);
  if (typeof out !== 'string') throw new Error('expected text output');
  return out;
}

function engineWithContext(): { engine: AudioEngine; ctx: FakeContext } {
  const { ctx, factory } = fakeFactory();
  return { engine: new AudioEngine({ contextFactory: factory }), ctx };
}

describe('audio console commands', () => {
  it('keeps the existing commands and adds ambience and uisound', () => {
    expect([...commands(null).keys()]).toEqual(['voices', 'sirentest', 'ambience', 'uisound']);
  });

  it('ambience prints the target gains for the defaults', () => {
    const out = run(commands(null).get('ambience'), []);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Ambience: downtown 12.0 h clear');
    expect(lines).toHaveLength(1 + AMBIENCE_LAYERS.length);
    for (const id of AMBIENCE_LAYERS) expect(out).toContain(id);
    expect(out).toMatch(/traffic\s+0\.4/);
  });

  it('ambience takes a district, hour and weather', () => {
    const out = run(commands(null).get('ambience'), ['park', '6', 'clear']);
    expect(out.split('\n')[0]).toBe('Ambience: park 6.0 h clear');
    const birds = /birds\s+([\d.]+)/.exec(out);
    expect(Number(birds?.[1])).toBeCloseTo(0.168, 3);
    const rain = run(commands(null).get('ambience'), ['downtown', '12', 'rain']);
    expect(Number(/rain\s+([\d.]+)/.exec(rain)?.[1])).toBeCloseTo(0.5, 3);
    const storm = run(commands(null).get('ambience'), ['harbor', '12', 'storm']);
    expect(Number(/water\s+([\d.]+)/.exec(storm)?.[1])).toBeCloseTo(0.45, 3);
  });

  it('ambience rejects a bad hour', () => {
    expect(() => run(commands(null).get('ambience'), ['park', 'noon'])).toThrow(/Usage: ambience/);
  });

  it('uisound plays a UI sound and unlocks the engine', () => {
    const { engine, ctx } = engineWithContext();
    ctx.currentTime = 1;
    const out = run(commands(engine).get('uisound'), ['notify']);
    expect(out).toBe('UI sound: notify');
    expect(engine.unlocked).toBe(true);
    expect(ctx.created['oscillator'] ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('uisound validates the kind and reports unavailable audio', () => {
    expect(() => run(commands(null).get('uisound'), [])).toThrow(/Usage: uisound/);
    expect(() => run(commands(null).get('uisound'), ['bleep'])).toThrow(/Usage: uisound/);
    expect(run(commands(null).get('uisound'), ['select'])).toBe('Audio unavailable');
    expect(run(commands(new AudioEngine({ contextFactory: null })).get('uisound'), ['select'])).toBe('Audio unavailable');
  });
});
