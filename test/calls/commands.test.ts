import { describe, expect, it } from 'vitest';
import { createCallsCommands } from '../../src/calls/commands';

describe('catalog console command', () => {
  const [catalog] = createCallsCommands();
  const run = (...args: string[]): string => {
    const out = catalog?.run(args, { console: undefined as never, print: () => undefined });
    return typeof out === 'string' ? out : '';
  };

  it('prints stats, families and one type', () => {
    expect(catalog?.name).toBe('catalog');
    expect(run('stats')).toContain('163 Phase 3 call types');
    expect(run('stats')).toContain('27 families');
    expect(run('families').split('\n')).toHaveLength(27);
    expect(run('families')).toMatch(/domestic\s+7 types/);
    expect(run('type', 'domesticDisturbance')).toContain('family domestic');
    expect(run('type', 'domesticDisturbance')).toContain('Branches: verbal 4');
    expect(run('type', 'noiseComplaint')).toContain('Phase 2 type');
    expect(run('type', 'nope')).toContain('No scene family');
    expect(run('type')).toContain('Usage');
    expect(run()).toContain('Usage');
  });
});
