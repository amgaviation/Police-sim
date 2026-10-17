import { describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '../../src/debug/console';
import { createRecordsCommands } from '../../src/records/commands';
import { RecordsDb } from '../../src/records/db';
import { dlNumberOf, vinOf } from '../../src/records/ids';
import { personIdentity } from '../../src/records/person';
import { canBeOnRoad, mountedPlate } from '../../src/records/vehicle';
import { plateOf } from '../../src/traffic/registry';
import { fakeCtx } from './helpers';

const SEED = 42;
const ctx = { print: () => undefined } as unknown as CommandContext;

function run(commands: Command[], line: string): string {
  const [name, ...args] = line.split(' ');
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`no command ${name}`);
  const out = cmd.run(args, ctx);
  if (typeof out !== 'string') throw new Error('expected text output');
  return out;
}

describe('records console commands', () => {
  const db = new RecordsDb(SEED, fakeCtx());
  const commands = createRecordsCommands({ records: () => db, seed: () => SEED });

  it('registers person, runplate, vin, dl, platestates and bolos', () => {
    expect(commands.map((c) => c.name)).toEqual(['person', 'runplate', 'vin', 'dl', 'platestates', 'bolos']);
  });

  it('shows and searches persons', () => {
    const p = personIdentity(SEED, 77);
    expect(run(commands, 'person 77')).toContain(`${p.last}, ${p.first}`.toUpperCase());
    expect(run(commands, `person ${p.last} ${p.first}`)).toMatch(/^77 |\n77 /);
    expect(run(commands, 'person Zzzz')).toContain('No persons match');
    expect(() => run(commands, 'person')).toThrow('Usage');
    expect(() => run(commands, 'person 100000')).toThrow(RangeError);
  });

  it('runs plates, VINs and DL numbers', () => {
    const plate = plateOf(SEED, 12);
    const out = run(commands, `runplate ${plate}`);
    expect(out).toContain(plate);
    expect(out).toContain('vehicle #12');
    expect(run(commands, `runplate ${plate.replace(' ', '').toLowerCase()}`)).toContain('vehicle #12');
    expect(run(commands, 'runplate ZZZ')).toContain('NO RECORD');
    expect(run(commands, `vin ${vinOf(SEED, 12)}`)).toContain(`plate ${plate}`);
    expect(run(commands, 'vin PT000')).toContain('NO RECORD');
    let id = 0;
    while (db.person(id).license.status === 'none') id++;
    expect(run(commands, `dl ${dlNumberOf(SEED, id)}`)).toContain(`#${id}`);
    expect(run(commands, 'dl D0')).toContain('NO RECORD');
  });

  it('lists cars in every plate state', () => {
    const out = run(commands, 'platestates 1');
    for (const state of ['expired', 'stolen', 'cloned', 'mismatched', 'flagged']) {
      const line = out.split('\n').find((l) => l.startsWith(state));
      expect(line, state).toMatch(/#\d+ [A-Z]{3} \d{4}/);
      const id = Number(/#(\d+)/.exec(line ?? '')?.[1]);
      expect(line).toContain(mountedPlate(SEED, id).plate);
    }
    // Every listed car can actually be on the road (none drive on their own reported-stolen plates).
    for (const seed of [SEED, 1234]) {
      const cmds = createRecordsCommands({ records: () => new RecordsDb(seed, fakeCtx()), seed: () => seed });
      const ids = [...run(cmds, 'platestates 3').matchAll(/#(\d+) [A-Z]{3} \d{4}/g)].map((m) => Number(m[1]));
      expect(ids.length).toBeGreaterThan(10);
      for (const id of ids) expect(canBeOnRoad(seed, id), `seed ${seed} #${id}`).toBe(true);
    }
    expect(() => run(commands, 'platestates 0')).toThrow('Usage');
  });

  it('lists BOLOs', () => {
    expect(run(commands, 'bolos')).toMatch(/^BOLOs 06\/01\/2026/);
  });

  it('needs a running game', () => {
    const none = createRecordsCommands({ records: () => null, seed: () => null });
    for (const line of ['person 1', 'runplate ABC 1234', 'vin X', 'dl D1234567', 'platestates', 'bolos']) {
      expect(() => run(none, line)).toThrow('No game running');
    }
  });
});
