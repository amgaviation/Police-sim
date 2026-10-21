import { describe, expect, it } from 'vitest';
import {
  callsSignature,
  compareCalls,
  consoleModel,
  detailSignature,
  formatAge,
  formatEta,
  orderLabel,
  reduceConsoleKey,
  statusLabel,
  suggestUnits,
  unitsSignature,
  type ConsoleUiState,
} from '../../src/ui/dispatch/model';
import { FakePort, call, unit } from './helpers';

describe('consoleModel', () => {
  it('sorts open calls by priority, then oldest first, then id; closed calls are dropped', () => {
    const port = new FakePort();
    port.callList = [
      call(1, { priority: 3, ageS: 100 }),
      call(2, { priority: 1, ageS: 10 }),
      call(3, { priority: 3, ageS: 400 }),
      call(4, { priority: 2, ageS: 50, status: 'closed' }),
      call(5, { priority: 3, ageS: 400 }),
      call(6, { priority: 2, ageS: 5, status: 'active' }),
    ];
    const m = consoleModel(port, { callId: null, unit: null });
    expect(m.calls.map((c) => c.id)).toEqual([2, 6, 3, 5, 1]);
  });

  it('resolves the selection to the first call / unit when it names none that exists', () => {
    const port = new FakePort();
    port.callList = [call(1, { priority: 2 }), call(2, { priority: 1 })];
    port.unitList = [unit('N2'), unit('N10'), unit('N1')];
    const m = consoleModel(port, { callId: 99, unit: 'ghost' });
    expect(m.sel).toEqual({ callId: 2, unit: 'N1' });
    expect(m.units.map((u) => u.callsign)).toEqual(['N1', 'N2', 'N10']);
    const kept = consoleModel(port, { callId: 1, unit: 'N10' });
    expect(kept.call?.id).toBe(1);
    expect(kept.unit?.callsign).toBe('N10');
  });

  it('is empty-safe', () => {
    const port = new FakePort();
    const m = consoleModel(port, { callId: 3, unit: 'N1' });
    expect(m.call).toBeNull();
    expect(m.unit).toBeNull();
    expect(m.sel).toEqual({ callId: null, unit: null });
    expect(m.suggestions).toEqual([]);
  });

  it('carries the title, score and create flag of the port', () => {
    const port = new FakePort();
    port.scoreText = 'A  92 %';
    port.canCreate = false;
    const m = consoleModel(port, { callId: null, unit: null });
    expect(m.title).toBe('Dispatch');
    expect(m.score).toBe('A  92 %');
    expect(m.canCreate).toBe(false);
  });

  it('compareCalls is a total order', () => {
    const a = call(1, { priority: 1, ageS: 5 });
    const b = call(2, { priority: 1, ageS: 5 });
    expect(compareCalls(a, b)).toBeLessThan(0);
    expect(compareCalls(b, a)).toBeGreaterThan(0);
    expect(compareCalls(a, a)).toBe(0);
  });
});

describe('suggestUnits', () => {
  const c = call(1, { x: 100, z: 0 });

  it('offers available units only, nearest first by distance when there is no ETA', () => {
    const units = [
      unit('N1', { x: 500, z: 0 }),
      unit('N2', { x: 150, z: 0 }),
      unit('N3', { x: 120, z: 0, status: 'onScene' }),
      unit('N4', { x: 300, z: 0, status: 'enRoute' }),
      unit('N5', { x: 110, z: 0 }),
    ];
    expect(suggestUnits(c, units, 5)).toEqual(['N5', 'N2', 'N1']);
    expect(suggestUnits(c, units, 2)).toEqual(['N5', 'N2']);
    expect(suggestUnits(c, units, 0)).toEqual([]);
  });

  it('uses the ETA when it is known (>= 0), else distance at an assumed speed', () => {
    const units = [
      unit('N1', { x: 100, z: 0, etaS: 90 }), // close but slow to arrive
      unit('N2', { x: 2000, z: 0 }), // far, no ETA: 1900 m / 12 m/s = 158 s
      unit('N3', { x: 5000, z: 0, etaS: 20 }), // far, fast ETA
      unit('N4', { x: 100, z: 0, etaS: 0 }), // ETA 0 counts as known
    ];
    expect(suggestUnits(c, units, 4)).toEqual(['N4', 'N3', 'N1', 'N2']);
  });

  it('skips units already on the call and breaks ties by callsign', () => {
    const on = call(1, { x: 0, z: 0, units: ['N1'] });
    const units = [unit('N10'), unit('N1'), unit('N2')];
    expect(suggestUnits(on, units, 5)).toEqual(['N2', 'N10']);
  });

  it('feeds the model for the selected call', () => {
    const port = new FakePort();
    port.callList = [call(1, { x: 0, z: 0, priority: 1 })];
    port.unitList = [unit('N1', { x: 900, z: 0 }), unit('N2', { x: 10, z: 0 })];
    expect(consoleModel(port, { callId: 1, unit: null }).suggestions).toEqual(['N2', 'N1']);
  });
});

describe('reduceConsoleKey', () => {
  function setup() {
    const port = new FakePort();
    port.callList = [call(1, { priority: 1, units: ['N1'] }), call(2, { priority: 2 }), call(3, { priority: 3 })];
    port.unitList = [unit('N1', { status: 'enRoute', callId: 1 }), unit('N2'), unit('N3', { status: 'busy' })];
    const ui: ConsoleUiState = { sel: { callId: 1, unit: 'N2' }, creating: false };
    return { port, ui, model: () => consoleModel(port, ui.sel) };
  }

  it('moves the call selection with Up / Down and clamps at the ends', () => {
    const { ui, model } = setup();
    const down = reduceConsoleKey(model(), ui, 'ArrowDown');
    expect(down.consumed).toBe(true);
    expect(down.ui.sel.callId).toBe(2);
    expect(down.ui.sel.unit).toBe('N2');
    const end = reduceConsoleKey(consoleModel(setup().port, { callId: 3, unit: 'N2' }), { sel: { callId: 3, unit: 'N2' }, creating: false }, 'ArrowDown');
    expect(end.ui.sel.callId).toBe(3);
    const top = reduceConsoleKey(model(), ui, 'ArrowUp');
    expect(top.ui.sel.callId).toBe(1);
  });

  it('moves the unit selection with Left / Right', () => {
    const { ui, model } = setup();
    expect(reduceConsoleKey(model(), ui, 'ArrowRight').ui.sel.unit).toBe('N3');
    expect(reduceConsoleKey(model(), ui, 'ArrowLeft').ui.sel.unit).toBe('N1');
  });

  it('A assigns the selected available unit, or the best suggestion when none is selected', () => {
    const { port, ui, model } = setup();
    expect(reduceConsoleKey(model(), ui, 'a').action).toEqual({ kind: 'assign', callId: 1, callsign: 'N2' });
    expect(reduceConsoleKey(model(), ui, 'A').action).toEqual({ kind: 'assign', callId: 1, callsign: 'N2' });
    // A busy unit is not assigned.
    const busy: ConsoleUiState = { sel: { callId: 2, unit: 'N3' }, creating: false };
    const r = reduceConsoleKey(consoleModel(port, busy.sel), busy, 'a');
    expect(r.action).toBeNull();
    expect(r.consumed).toBe(true);
    // A unit already on the call is not assigned again.
    port.unitList = [unit('N1', { status: 'available' })];
    const on: ConsoleUiState = { sel: { callId: 1, unit: 'N1' }, creating: false };
    expect(reduceConsoleKey(consoleModel(port, on.sel), on, 'a').action).toBeNull();
  });

  it('A with no units in the list does nothing', () => {
    const port = new FakePort();
    port.callList = [call(1)];
    const ui: ConsoleUiState = { sel: { callId: 1, unit: null }, creating: false };
    expect(reduceConsoleKey(consoleModel(port, ui.sel), ui, 'a').action).toBeNull();
  });

  it('U unassigns the selected unit when it is on the call, else the first unit of the call', () => {
    const { port, ui, model } = setup();
    expect(reduceConsoleKey(model(), ui, 'u').action).toEqual({ kind: 'unassign', callId: 1, callsign: 'N1' });
    const onN1: ConsoleUiState = { sel: { callId: 1, unit: 'N1' }, creating: false };
    expect(reduceConsoleKey(model(), onN1, 'U').action).toEqual({ kind: 'unassign', callId: 1, callsign: 'N1' });
    const noUnits: ConsoleUiState = { sel: { callId: 2, unit: 'N2' }, creating: false };
    expect(reduceConsoleKey(consoleModel(port, noUnits.sel), noUnits, 'u').action).toBeNull();
  });

  it('1-4 set the priority of the selected call (not when it is already that priority)', () => {
    const { ui, model } = setup();
    expect(reduceConsoleKey(model(), ui, '3').action).toEqual({ kind: 'priority', callId: 1, priority: 3 });
    expect(reduceConsoleKey(model(), ui, '1').action).toBeNull();
    expect(reduceConsoleKey(model(), ui, '4').action).toEqual({ kind: 'priority', callId: 1, priority: 4 });
  });

  it('N asks to focus the note box; unknown keys are not consumed', () => {
    const { ui, model } = setup();
    expect(reduceConsoleKey(model(), ui, 'n').action).toEqual({ kind: 'focusNote' });
    const x = reduceConsoleKey(model(), ui, 'x');
    expect(x.consumed).toBe(false);
    expect(x.action).toBeNull();
  });

  it('C toggles create mode when the port can create; Escape cancels it, then leaves', () => {
    const { port, ui, model } = setup();
    const armed = reduceConsoleKey(model(), ui, 'c');
    expect(armed.ui.creating).toBe(true);
    const cancelled = reduceConsoleKey(model(), armed.ui, 'Escape');
    expect(cancelled.ui.creating).toBe(false);
    expect(cancelled.action).toBeNull();
    expect(reduceConsoleKey(model(), ui, 'Escape').action).toEqual({ kind: 'escape' });
    port.canCreate = false;
    expect(reduceConsoleKey(model(), ui, 'c').ui.creating).toBe(false);
  });

  it('does not modify the state it was given', () => {
    const { ui, model } = setup();
    const before = JSON.stringify(ui);
    reduceConsoleKey(model(), ui, 'ArrowDown');
    reduceConsoleKey(model(), ui, 'c');
    expect(JSON.stringify(ui)).toBe(before);
  });

  it('with no calls the call keys do nothing', () => {
    const port = new FakePort();
    port.unitList = [unit('N1')];
    const ui: ConsoleUiState = { sel: { callId: null, unit: null }, creating: false };
    const m = consoleModel(port, ui.sel);
    for (const k of ['a', 'u', '1', 'ArrowDown']) expect(reduceConsoleKey(m, ui, k).action).toBeNull();
  });
});

describe('formatting and signatures', () => {
  it('formats ages as m:ss and ETAs', () => {
    expect(formatAge(0)).toBe('0:00');
    expect(formatAge(59.9)).toBe('0:59');
    expect(formatAge(247)).toBe('4:07');
    expect(formatAge(-5)).toBe('0:00');
    expect(formatAge(Number.NaN)).toBe('0:00');
    expect(formatEta(80)).toBe('ETA 1:20');
    expect(formatEta(-1)).toBe('');
  });

  it('labels orders and statuses', () => {
    expect(orderLabel('returnToStation')).toBe('Return to station');
    expect(orderLabel('code4')).toBe('Code4');
    expect(orderLabel('respond')).toBe('Respond');
    expect(statusLabel('enRoute')).toBe('en route');
    expect(statusLabel('outOfService')).toBe('out of service');
  });

  it('changes a signature only when something displayed changes', () => {
    const a = [call(1, { ageS: 10 })];
    const b = [call(1, { ageS: 99 })];
    expect(callsSignature(a, 1)).toBe(callsSignature(b, 1));
    expect(callsSignature(a, 1)).not.toBe(callsSignature(a, null));
    expect(callsSignature(a, 1)).not.toBe(callsSignature([call(1, { priority: 1 })], 1));
    const u1 = [unit('N1', { x: 0 })];
    const u2 = [unit('N1', { x: 500 })];
    expect(unitsSignature(u1, 'N1')).toBe(unitsSignature(u2, 'N1'));
    expect(unitsSignature(u1, 'N1')).not.toBe(unitsSignature([unit('N1', { status: 'busy' })], 'N1'));
    const port = new FakePort();
    port.callList = [call(1)];
    const m1 = consoleModel(port, { callId: 1, unit: null });
    port.callList = [call(1, { notes: ['hello'] })];
    expect(detailSignature(consoleModel(port, { callId: 1, unit: null }))).not.toBe(detailSignature(m1));
  });
});
