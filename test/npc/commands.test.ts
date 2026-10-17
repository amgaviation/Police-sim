import { afterAll, describe, expect, it } from 'vitest';
import { createNpcCommands } from '../../src/npc/commands';
import type { Command, CommandContext } from '../../src/debug/console';
import { DOWNTOWN, cityOf, makeRig, spec, spotIn, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

const fake = {} as CommandContext;

/** Runs a command and returns its text (these commands are synchronous). */
function text(cmd: Command, args: string[]): string {
  const out = cmd.run(args, fake);
  return typeof out === 'string' ? out : '';
}

function find(cmds: ReturnType<typeof createNpcCommands>, name: string): Command {
  const c = cmds.find((x) => x.name === name);
  if (!c) throw new Error(`no command ${name}`);
  return c;
}

describe('console commands', () => {
  it('peds stats | density | clear and actors', async () => {
    const r = await makeRig({ x: P.x, z: P.z });
    rigs.push(r);
    const cmds = createNpcCommands({ npc: () => r.npc });
    expect(cmds.map((c) => c.name)).toEqual(['peds', 'actors']);
    const peds = find(cmds, 'peds');
    r.run(600);
    const stats = text(peds, ['stats']);
    expect(stats).toMatch(/^peds \d+ \(target \d+, density x1\) {2}actors 0 {2}occupants \d+/);
    expect(text(peds, [])).toBe(stats);
    expect(text(peds, ['density', '0'])).toBe('Pedestrian density x0');
    expect(r.npc.density).toBe(0);
    const cleared = text(peds, ['clear']);
    expect(cleared).toMatch(/^Removed \d+ pedestrians$/);
    r.run(1);
    expect(r.npc.stats.peds).toBe(0);
    expect(() => peds.run(['density'], fake)).toThrow(/Usage: peds density/);
    expect(() => peds.run(['density', '-1'], fake)).toThrow(/Usage: peds density/);
    expect(() => peds.run(['density', 'abc'], fake)).toThrow(/Usage: peds density/);
    expect(() => peds.run(['wat'], fake)).toThrow(/Usage: peds/);

    const actors = find(cmds, 'actors');
    expect(text(actors, [])).toBe('No actors');
    const id = r.npc.spawnActor(spec(5001, P.x + 4, P.z, { role: 'witness' }));
    r.npc.spawnActor(spec(5002, P.x + 5, P.z, { profile: 'subjectUnconscious', role: 'victim' }));
    const out = text(actors, []);
    expect(out.split('\n').length).toBe(2);
    expect(out).toContain(`#${id}  witness  call 7  person 5001  suspectCalm  idle`);
    expect(out).toContain('victim');
    expect(out).toContain('lying');
  });

  it('say so when no game is running', () => {
    const cmds = createNpcCommands({ npc: () => null });
    expect(() => find(cmds, 'peds').run(['stats'], fake)).toThrow(/No game running/);
    expect(() => find(cmds, 'actors').run([], fake)).toThrow(/No game running/);
  });
});
