import { describe, expect, it } from 'vitest';
import type { CadState } from '../../src/cad/cadState';
import { clockOf, createCadCommands, parseCallId } from '../../src/cad/commands';
import type { Command, CommandContext } from '../../src/debug/console';
import { addRoster, at, newCall, recordingCad } from './helpers';

const ctx = { print: () => undefined } as unknown as CommandContext;

function run(commands: Command[], name: string, ...args: string[]): string {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`no command ${name}`);
  const out = cmd.run(args, ctx);
  if (typeof out !== 'string') throw new Error(`${name} returned no text`);
  return out;
}

describe('cad commands', () => {
  it('reports when there is no CAD', () => {
    const commands = createCadCommands({ cad: () => null });
    expect(commands.map((c) => c.name)).toEqual(['calls', 'call', 'units', 'docs']);
    for (const c of commands) expect(run(commands, c.name)).toMatch(/No CAD/);
  });

  it('lists calls, units and documents', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall(newCall('alarm', 2, 'Front door alarm.'), at(1));
    cad.assign(call.id, '21', at(2), 'dispatch');
    cad.docs.create('report', { callId: call.id, title: 'Alarm' }, at(3), 'Officer Doe');
    const commands = createCadCommands({ cad: (): CadState => cad });

    expect(run(commands, 'calls')).toContain('C-00001 P2 Alarm');
    const detail = run(commands, 'call', 'C-00001');
    expect(detail).toContain('Front door alarm.');
    expect(detail).toContain('primary 21');
    expect(run(commands, 'call', '1')).toBe(detail);
    expect(run(commands, 'call', '7')).toMatch(/No call/);
    expect(run(commands, 'call')).toMatch(/Usage/);
    const units = run(commands, 'units');
    expect(units).toContain('10-76 EN ROUTE');
    expect(units).toContain('C-00001');
    expect(run(commands, 'docs')).toContain('R-0001');
    expect(run(commands, 'docs', 'citation')).toBe('No documents.');
    expect(run(commands, 'docs', 'memo')).toMatch(/Unknown kind/);
    cad.closeCall(call.id, 'unfounded', at(4));
    expect(run(commands, 'calls')).toBe('No open calls.');
    expect(run(commands, 'call', '1')).toContain('Unfounded');
  });

  it('parses call ids and clocks', () => {
    expect(parseCallId('C-00042')).toBe(42);
    expect(parseCallId('c42')).toBe(42);
    expect(parseCallId('42')).toBe(42);
    expect(parseCallId('0')).toBeNull();
    expect(parseCallId('x')).toBeNull();
    expect(clockOf(14 * 3600 + 32 * 60 + 5)).toBe('14:32');
    expect(clockOf(86400 + 60)).toBe('00:01');
  });
});
