import { describe, expect, it } from 'vitest';
import { CadState } from '../../src/cad/cadState';
import { MDT_TABS, callDetailLines, formatAge, queueRows, tabFromKey, unitRows } from '../../src/ui/mdt';
import { addCall, addRoster, at, fixture, smallGraph } from './helpers';

describe('formatAge', () => {
  it('formats minutes and seconds, then hours', () => {
    expect(formatAge(0)).toBe('0:00');
    expect(formatAge(5)).toBe('0:05');
    expect(formatAge(65.9)).toBe('1:05');
    expect(formatAge(599)).toBe('9:59');
    expect(formatAge(3600)).toBe('1:00:00');
    expect(formatAge(3 * 3600 + 7 * 60 + 9)).toBe('3:07:09');
  });

  it('clamps negative and non-finite input', () => {
    expect(formatAge(-12)).toBe('0:00');
    expect(formatAge(Number.NaN)).toBe('0:00');
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('tabFromKey', () => {
  it('maps 1-9 to the tabs in tab-bar order', () => {
    expect(MDT_TABS).toEqual(['queue', 'call', 'units', 'map', 'person', 'vehicle', 'bolo', 'reports', 'stop', 'career', 'community', 'resources', 'command', 'cases']);
    for (let i = 0; i < 9; i++) {
      expect(tabFromKey(String(i + 1))).toBe(MDT_TABS[i]);
      expect(tabFromKey(`Digit${i + 1}`)).toBe(MDT_TABS[i]);
      expect(tabFromKey(`Numpad${i + 1}`)).toBe(MDT_TABS[i]);
    }
  });

  it('jumps to Career with 0, and reaches Community only with the arrows', () => {
    for (const k of ['0', 'Digit0', 'Numpad0']) expect(tabFromKey(k)).toBe('career');
    expect(MDT_TABS.slice(0, 9).includes('career')).toBe(false);
    for (let i = 1; i <= 9; i++) expect(tabFromKey(String(i))).not.toBe('community');
  });

  it('ignores other keys', () => {
    for (const k of ['10', 'a', 'Enter', 'F1', '', ' 1']) expect(tabFromKey(k)).toBeNull();
  });
});

describe('queueRows', () => {
  it('lists open calls P1 first, then oldest, with formatted columns', () => {
    const cad = new CadState();
    addRoster(cad);
    const a = addCall(cad, 10, 3);
    const b = addCall(cad, 20, 1, 'alarm');
    const c = addCall(cad, 5, 3);
    const d = addCall(cad, 30, 2);
    const closed = addCall(cad, 1, 1);
    cad.closeCall(closed.id, 'handled', at(2));
    const rows = queueRows(cad, 100);
    expect(rows.map((r) => r.callId)).toEqual([b.id, d.id, c.id, a.id]);
    const first = rows[0];
    expect(first).toMatchObject({
      number: b.number,
      priority: 1,
      nature: 'Alarm',
      address: '248 N Oak Street',
      caller: 'Jane Roe',
      status: 'PENDING',
      units: '-',
      age: '1:20',
      offered: false,
      mine: false,
    });
    expect(rows[3]?.age).toBe('1:30');
  });

  it('shows offers, assignment, on-scene and anonymous callers', () => {
    const cad = new CadState();
    addRoster(cad);
    const offered = addCall(cad, 0, 2);
    const mine = addCall(cad, 0, 3);
    const anon = cad.createCall(
      { typeId: 'noiseComplaint', priority: 4, location: offered.location, caller: { kind: 'anonymous', name: '', phone: '', personId: -1 }, narrative: 'Loud music' },
      at(0),
    );
    cad.offer(offered.id, '12', 60, at(1));
    cad.assign(mine.id, '12', at(1), 'self');
    cad.assign(mine.id, '21', at(1), 'backup');
    cad.setUnitStatus('21', 'onScene', at(2), 'auto');
    const rows = queueRows(cad, 10);
    const byId = new Map(rows.map((r) => [r.callId, r]));
    expect(byId.get(offered.id)).toMatchObject({ status: 'OFFERED', offered: true, mine: false });
    expect(byId.get(mine.id)).toMatchObject({ status: 'ON SCENE', units: '12,21', mine: true, offered: false });
    expect(byId.get(anon.id)?.caller).toBe('ANONYMOUS');
  });

  it('builds 100 rows well inside the 2 ms refresh budget', () => {
    const cad = new CadState();
    addRoster(cad);
    for (let i = 0; i < 100; i++) addCall(cad, i, ((i % 4) + 1) as 1 | 2 | 3 | 4);
    queueRows(cad, 500);
    const t0 = performance.now();
    const runs = 20;
    for (let i = 0; i < runs; i++) queueRows(cad, 500 + i);
    expect((performance.now() - t0) / runs).toBeLessThan(2);
    expect(queueRows(cad, 500)).toHaveLength(100);
  });
});

describe('callDetailLines', () => {
  it('includes caller, address, cross street and every narrative entry with its clock', () => {
    const cad = new CadState();
    addRoster(cad);
    const call = addCall(cad, 0, 2, 'trafficHazard', 'RP reports a mattress in lane 2.');
    cad.addNarrative(call.id, '21', 'Unit en route.', at(60));
    cad.addNarrative(call.id, 'MDT', 'Debris cleared.', at(120));
    cad.assign(call.id, '21', at(30), 'dispatch');
    const lines = callDetailLines(call);
    const text = lines.map((l) => `${l.label}|${l.text}`);
    expect(lines[0]).toMatchObject({ kind: 'title', label: call.number, text: 'P2 Traffic hazard' });
    expect(text).toContain('Caller|Jane Roe (citizen) 555-0100');
    expect(text).toContain('Address|248 N Oak Street');
    expect(text).toContain('Cross street|2nd Street');
    expect(text).toContain('District|Suburbs');
    expect(text).toContain('Units|21*');
    const narrative = lines.filter((l) => l.kind === 'narrative');
    expect(narrative.map((l) => `${l.label} ${l.text}`)).toEqual([
      '14:00 CAD: RP reports a mattress in lane 2.',
      '14:30 21: Unit en route.',
      '15:00 MDT: Debris cleared.',
      '14:15 CAD: 21 dispatched',
    ]);
    expect(text.find((t) => t.startsWith('Times|'))).toBe('Times|Created 14:00  Dispatched 14:15');
  });

  it('shows the disposition and linked documents of a closed call', () => {
    const f = fixture();
    const call = addCall(f.cad, 0, 3);
    f.cad.docs.create('report', { callId: call.id, title: 'Debris' }, at(5), 'Officer Doe #4071');
    f.cad.closeCall(call.id, 'reportTaken', at(10));
    const lines = callDetailLines(call);
    expect(lines.find((l) => l.label === 'Status')?.text).toBe('CLOSED - Report taken');
    expect(lines.filter((l) => l.kind === 'document').map((l) => l.text)).toEqual(['R-0001']);
  });
});

describe('unitRows', () => {
  it('labels statuses with ten-codes, calls, locations and time in status', () => {
    const cad = new CadState();
    addRoster(cad);
    const graph = smallGraph();
    const call = addCall(cad, 0, 2);
    cad.assign(call.id, '21', at(10), 'dispatch');
    cad.setUnitStatus('23', 'outOfService', at(20), 'auto');
    cad.setUnitPosition('21', 100, -199);
    cad.setUnitPosition('12', 5000, 5000);
    cad.setEmergency('12', true, at(30));
    const rows = unitRows(cad, graph, 70);
    expect(rows.map((r) => r.callsign)).toEqual(['12', '21', '23']);
    expect(rows[0]).toMatchObject({ player: true, status: 'available', statusLabel: '10-8 AVAILABLE', call: '-', location: 'UNKNOWN', emergency: true, since: '1:10' });
    expect(rows[1]).toMatchObject({ player: false, status: 'enRoute', call: call.number, since: '1:00' });
    expect(rows[1]?.statusLabel).toMatch(/EN ROUTE$/);
    expect(rows[1]?.location).toContain('Edge 1');
    expect(rows[2]?.statusLabel).toMatch(/^10-7 OUT OF SERVICE$/);
    // Without a sim clock the start time is shown.
    expect(unitRows(cad, graph)[2]?.since).toBe('14:10');
  });
});
