import { describe, expect, it } from 'vitest';
import type { CadTime } from '../../src/cad/types';
import type { Command, CommandContext } from '../../src/debug/console';
import { createDispatchCommands } from '../../src/dispatch/commands';
import { at, eventsOf, makeHarness, quietConfig, step } from './helpers';

const ctx = { print: () => undefined } as unknown as CommandContext;

function run(commands: Command[], ...args: string[]): string {
  const cmd = commands.find((c) => c.name === 'dispatch');
  if (!cmd) throw new Error('no dispatch command');
  const out = cmd.run(args, ctx);
  if (typeof out !== 'string') throw new Error('no text');
  return out;
}

describe('dispatch commands', () => {
  it('throws without a game', () => {
    const commands = createDispatchCommands({ dispatcher: () => null, now: () => null, playerPosition: () => null });
    expect(() => run(commands, 'stats')).toThrow(/no game running/);
  });

  it('creates calls, requests backup / emergency, shows stats and units', async () => {
    const h = await makeHarness({ config: quietConfig(), inPoliceVehicle: false });
    const commands = createDispatchCommands({
      dispatcher: () => h.dispatcher,
      now: (): CadTime => at(h.sim),
      playerPosition: () => ({ x: h.player.x, z: h.player.z }),
    });
    expect(run(commands)).toMatch(/^Usage: dispatch/);
    expect(run(commands, 'call', 'nope')).toMatch(/types: trafficHazard/);
    expect(run(commands, 'call', 'alarm')).toMatch(/^C-00001 P\d Alarm at \d+ /);
    expect(run(commands, 'call', 'welfareCheck', 'here')).toMatch(/^C-00002 P\d Welfare check/);
    const here = h.cad.call(2);
    expect(Math.hypot((here?.location.x ?? 0) - h.player.x, (here?.location.z ?? 0) - h.player.z)).toBeLessThan(1);
    step(h);
    expect(run(commands, 'stats')).toBe('Generated 0, open 2, AI units busy 3');
    expect(run(commands, 'backup', '5')).toMatch(/Usage/);
    expect(run(commands, 'backup', '2')).toBe('Backup code 2 requested');
    expect(run(commands, 'emergency')).toBe('Emergency button pressed');
    step(h);
    expect(eventsOf(h, 'dispatch:backup')).toHaveLength(1);
    expect(eventsOf(h, 'dispatch:emergency')).toHaveLength(1);
    const units = run(commands, 'units').split('\n');
    expect(units).toHaveLength(6);
    expect(units[0]).toMatch(/^21 +fleet {2}0 /);
  });
});
