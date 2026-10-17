import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../../src/debug/console';
import { createRadioCommands } from '../../src/radio/commands';
import type { RadioSystem } from '../../src/radio/radioSystem';
import { makeRig } from './helpers';

const ctx = {} as CommandContext;

function command(radio: RadioSystem | null) {
  const [cmd] = createRadioCommands({ radio: () => radio });
  if (!cmd) throw new Error('no command');
  return (...args: string[]) => cmd.run(args, ctx) as string;
}

describe('radio console command', () => {
  it('say, channel, scan, log', () => {
    const rig = makeRig();
    const radio = command(rig.radio);
    expect(radio('say', 'dispatch', 'all', 'units,', 'test')).toBe('Queued on dispatch');
    rig.run(5);
    expect(rig.radio.log.at(-1)?.text).toBe('all units, test');
    expect(radio('channel', 'county')).toBe('Selected county');
    expect(rig.radio.selected).toBe('county');
    expect(radio('channel')).toBe('Selected county');
    expect(radio('scan')).toBe('Scan on (dispatch, tac, fireEms)');
    const log = radio('log', '5');
    expect(log).toContain('Dispatch: all units, test');
    expect(log).toMatch(/^\d\d:\d\d dispatch/);
    expect(radio('log')).toContain('Dispatch');
  });

  it('errors', () => {
    expect(() => command(null)('scan')).toThrow('No game running');
    const radio = command(makeRig().radio);
    expect(() => radio('say', 'pager', 'hi')).toThrow(/Usage: radio say/);
    expect(() => radio('say', 'dispatch')).toThrow(/Usage: radio say/);
    expect(() => radio('channel', 'pager')).toThrow(/Unknown channel/);
    expect(() => radio('log', '0')).toThrow(/Usage: radio log/);
    expect(() => radio('dance')).toThrow(/Usage: radio/);
    expect(command(makeRig().radio)('log')).toBe('Radio log is empty');
  });
});
