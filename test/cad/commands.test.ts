import { describe, expect, it } from 'vitest';
import type { CadState } from '../../src/cad/cadState';
import { callDetail, clockOf, createCadCommands, parseCallId } from '../../src/cad/commands';
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

describe('callDetail', () => {
  it('describes a pending call with its narrative and no units', () => {
    const { cad } = recordingCad();
    const call = cad.createCall(newCall('alarm', 2, 'Front door alarm.'), at(0));
    const lines = callDetail(call);
    expect(lines[0]).toBe('C-00001 P2 Alarm (alarm)');
    expect(lines[1]).toBe('Status: pending');
    expect(lines[2]).toBe('Location: 248 N Oak Street (200 block of N Oak Street), Suburbs');
    expect(lines[3]).toBe('Caller: Jane Roe [citizen] 555-0100');
    expect(lines[4]).toBe('Units: -');
    expect(lines[5]).toMatch(/^Created \d\d:\d\d$/);
    expect(lines[6]).toMatch(/^ {2}\d\d:\d\d CAD: Front door alarm\.$/);
    expect(lines).toHaveLength(7);
  });

  it('shows self-initiated calls, the primary unit, an offer, times and documents', () => {
    const { cad } = recordingCad();
    addRoster(cad);
    const call = cad.createCall({ ...newCall('trafficHazard'), selfInitiated: true, caller: { kind: 'anonymous', name: '', phone: '', personId: -1 } }, at(0));
    cad.offer(call.id, '23', 30, at(1));
    expect(callDetail(call).join('\n')).toContain('self-initiated');
    expect(callDetail(call).join('\n')).toContain('Caller: - [anonymous]');
    expect(callDetail(call).join('\n')).toContain('offered to 23');
    cad.assign(call.id, '21', at(2), 'dispatch');
    cad.assign(call.id, '12', at(3), 'backup');
    cad.setUnitStatus('21', 'onScene', at(5), 'radio');
    cad.docs.create('report', { callId: call.id, title: 'Debris' }, at(6), 'Officer Doe');
    cad.closeCall(call.id, 'reportTaken', at(9));
    const text = callDetail(call).join('\n');
    expect(text).toContain('Status: closed - Report taken');
    expect(text).toContain('Units: 21, 12 (primary 21)');
    expect(text).toMatch(/Created \d\d:\d\d, dispatched \d\d:\d\d, on scene \d\d:\d\d, closed \d\d:\d\d/);
    expect(text).toContain('Documents: R-0001');
    expect(text).toMatch(/\d\d:\d\d CAD: 21 on scene/);
  });
});

