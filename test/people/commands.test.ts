import { describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '../../src/debug/console';
import { createPeopleCommands } from '../../src/people';
import { displayName } from '../../src/records/person';
import { makeRig } from './helpers';

const ctx = { print: () => undefined } as unknown as CommandContext;

function run(commands: Command[], line: string): string {
  const [name, ...args] = line.split(' ');
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`no command ${name}`);
  const out = cmd.run(args, ctx);
  if (typeof out !== 'string') throw new Error('expected text output');
  return out;
}

describe('people console commands', () => {
  const rig = makeRig();
  const commands = createPeopleCommands({ people: () => rig.pop });

  it('registers who and intox', () => {
    expect(commands.map((c) => c.name)).toEqual(['who', 'intox']);
  });

  it('who shows identity, state and items', () => {
    const text = run(commands, 'who 77');
    expect(text).toContain(displayName(rig.pop.identity(77).record));
    expect(text).toContain('#77');
    expect(text).toContain('temperament');
    expect(text).toContain('state  bac');
    expect(text).toContain('items');
    expect(() => run(commands, 'who')).toThrow('Usage');
    expect(() => run(commands, 'who abc')).toThrow('Usage');
    expect(() => run(commands, 'who 100000')).toThrow(RangeError);
  });

  it('intox sets the blood alcohol', () => {
    expect(run(commands, 'intox 77 0.12')).toContain('bac 0.120');
    expect(rig.pop.intoxication(77).bac).toBeCloseTo(0.12, 9);
    expect(run(commands, 'who 77')).toContain('bac 0.120');
    expect(run(commands, 'intox 77 0.05 opioid')).toContain('drug opioid');
    expect(() => run(commands, 'intox 77')).toThrow('Usage');
    expect(() => run(commands, 'intox 77 0.9')).toThrow('Usage');
    expect(() => run(commands, 'intox 77 0.1 crack')).toThrow('Usage');
  });

  it('reports no game', () => {
    const none = createPeopleCommands({ people: () => null });
    expect(() => run(none, 'who 1')).toThrow('No game running');
  });
});
