import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatchConsole, CONSOLE_TICK_MS } from '../../src/ui/dispatch/console';
import { MARKER_PICK_PX, frameView, pickMarker, priorityColorKey, unitColorKey } from '../../src/ui/dispatch/map';
import { RoadCache, windowCovers, windowFor, windowOffset } from '../../src/ui/dispatch/roads';
import type { MapView } from '../../src/ui/mdt/map';
import type { RoadGraph } from '../../src/world/roadGraph';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';
import { FakePort, call, unit } from './helpers';

const graph = { edges: [] } as unknown as RoadGraph;

function key(k: string, extra: Record<string, unknown> = {}): KeyboardEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, target: null, ...extra } as unknown as KeyboardEvent;
}

function portWith(): FakePort {
  const port = new FakePort();
  port.callList = [call(1, { priority: 1, nature: 'Robbery', x: 100, z: 100, units: ['N1'], status: 'active' }), call(2, { priority: 3, nature: 'Noise' })];
  port.unitList = [unit('N1', { status: 'enRoute', callId: 1, x: 50, z: 50 }), unit('N2', { x: 90, z: 90 })];
  return port;
}

describe('DispatchConsole (headless)', () => {
  it('constructs without a DOM and runs keys through the port', () => {
    const port = portWith();
    let left = 0;
    const c = new DispatchConsole(null, port, graph, () => void left++);
    expect(c.id).toBe('dispatch-console');
    expect(c.pausesGame).toBe(false);
    c.open();
    expect(c.isOpen).toBe(true);
    expect(c.model.sel).toEqual({ callId: 1, unit: 'N1' });
    c.onKeyDown(key('ArrowDown'));
    expect(c.uiState.sel.callId).toBe(2);
    c.onKeyDown(key('ArrowRight'));
    expect(c.uiState.sel.unit).toBe('N2');
    expect(c.onKeyDown(key('a'))).toBe(true);
    expect(port.log.assign).toEqual([[2, 'N2']]);
    expect(c.statusLine).toBe('Assigned N2 to 25-0002');
    c.onKeyDown(key('1'));
    expect(port.log.priority).toEqual([[2, 1]]);
    c.onKeyDown(key('Escape'));
    expect(left).toBe(1);
    c.close();
    expect(c.isOpen).toBe(false);
    expect(c.onKeyDown(key('a'))).toBe(false);
  });

  it('ignores keys with modifiers and typing targets (Escape only leaves the field)', () => {
    const port = portWith();
    const c = new DispatchConsole(null, port, graph, () => undefined);
    c.open();
    expect(c.onKeyDown(key('a', { ctrlKey: true }))).toBe(false);
    let blurred = 0;
    const input = { tagName: 'INPUT', blur: () => void blurred++ };
    expect(c.onKeyDown(key('a', { target: input }))).toBe(false);
    expect(c.onKeyDown(key('Escape', { target: input }))).toBe(true);
    expect(blurred).toBe(1);
    expect(port.log.assign).toHaveLength(0);
  });

  it('unassigns and closes through the port, and C arms create mode', () => {
    const port = portWith();
    const c = new DispatchConsole(null, port, graph, () => undefined);
    c.open();
    c.handleKey('u');
    expect(port.log.unassign).toEqual([[1, 'N1']]);
    expect(c.handleKey('c')).toBe(true);
    expect(c.uiState.creating).toBe(true);
    expect(c.handleKey('Escape')).toBe(true);
    expect(c.uiState.creating).toBe(false);
  });

  it('rebuilds at most every 250 ms and only follows the model', () => {
    const port = portWith();
    const c = new DispatchConsole(null, port, graph, () => undefined);
    c.open();
    expect(c.model.calls).toHaveLength(2);
    port.callList = [...port.callList, call(3, { priority: 2 })];
    port.rev++;
    c.update(1000);
    expect(c.model.calls).toHaveLength(3);
    port.callList = [call(9)];
    c.update(1000 + CONSOLE_TICK_MS - 1);
    expect(c.model.calls).toHaveLength(3);
    c.update(1000 + CONSOLE_TICK_MS);
    expect(c.model.calls.map((x) => x.id)).toEqual([9]);
    expect(c.model.sel.callId).toBe(9);
  });
});

describe('DispatchConsole (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  function open() {
    const port = portWith();
    port.scoreText = 'B  85 %';
    const ui = fakeUi();
    let left = 0;
    const c = new DispatchConsole(ui as unknown as UIRoot, port, graph, () => void left++);
    c.open();
    const root = c.element as unknown as FakeElement;
    return { port, ui, c, root, left: () => left };
  }

  it('pushes onto the menu stack and lists the queue and the units', () => {
    const { ui, c, root } = open();
    expect(ui.stack).toContain(c);
    const rows = findAll(root, (e) => e.className.includes('dc-row'));
    expect(rows).toHaveLength(4); // 2 calls + 2 units
    expect(rows[0]?.textContent).toContain('Robbery');
    expect(rows[0]?.attrs['aria-pressed']).toBe('true');
    expect(findAll(root, (e) => e.className.includes('dc-score'))[0]?.textContent).toBe('B  85 %');
    c.close();
    expect(ui.stack).not.toContain(c);
  });

  it('selects a call by clicking its row and assigns from a suggestion button', () => {
    const { port, root, c } = open();
    const noise = findAll(root, (e) => e.className.includes('dc-row') && e.textContent.includes('Noise'))[0];
    noise?.click();
    expect(c.uiState.sel.callId).toBe(2);
    findButton(root, 'Assign N2').click();
    expect(port.log.assign).toEqual([[2, 'N2']]);
  });

  it('adds a note and closes the call with the picked disposition', () => {
    const { port, root } = open();
    const input = findAll(root, (e) => e.className.includes('dc-note-input'))[0];
    if (!input) throw new Error('no note input');
    input.value = '  gate code 4411 ';
    findButton(root, 'Add note').click();
    expect(port.log.note).toEqual([[1, 'gate code 4411']]);
    expect(input.value).toBe('');
    const select = findAll(root, (e) => e.tagName === 'select' && e.attrs['aria-label'] === 'Disposition')[0];
    if (select) select.value = 'cancelled';
    findButton(root, 'Close call').click();
    expect(port.log.close).toEqual([[1, 'cancelled']]);
  });

  it('sends an order to the selected unit', () => {
    const { port, root } = open();
    findButton(root, 'Return to station').click();
    expect(port.log.order).toEqual([['N1', 'returnToStation', 1]]);
  });

  it('creates a call at the map click while in create mode', () => {
    const { port, root, c } = open();
    const canvas = findAll(root, (e) => e.tagName === 'canvas')[0];
    if (!canvas) throw new Error('no canvas');
    canvas.width = 720;
    canvas.height = 440;
    // Not creating: a click on empty ground does nothing.
    canvas.fire('pointerdown', { clientX: 5, clientY: 5, pointerId: 1 });
    canvas.fire('pointerup', { clientX: 5, clientY: 5, pointerId: 1 });
    expect(port.log.create).toHaveLength(0);
    c.handleKey('c');
    expect(c.uiState.creating).toBe(true);
    canvas.fire('pointerdown', { clientX: 360, clientY: 220, pointerId: 1 });
    canvas.fire('pointerup', { clientX: 360, clientY: 220, pointerId: 1 });
    expect(port.log.create).toHaveLength(1);
    expect(port.log.create[0]?.[0]).toBe('noise');
    expect(port.log.create[0]?.[1]).toBe(3);
    expect(c.uiState.creating).toBe(false);
  });

  it('hides the create row when the port cannot create', () => {
    const port = portWith();
    port.canCreate = false;
    const c = new DispatchConsole(fakeUi() as unknown as UIRoot, port, graph, () => undefined);
    c.open();
    const row = findAll(c.element as unknown as FakeElement, (e) => e.className.includes('dc-create'))[0];
    expect(row?.hidden).toBe(true);
  });

  it('rebuilds the lists on a revision change and keeps them when nothing displayed changed', () => {
    const { port, c, root } = open();
    const before = findAll(root, (e) => e.className.includes('dc-row'))[0];
    port.rev++;
    c.update(5000);
    const same = findAll(root, (e) => e.className.includes('dc-row'))[0];
    expect(same).toBe(before); // identical signature: DOM kept (focus is not lost)
    port.callList = [...port.callList, call(7, { priority: 2, nature: 'Fight' })];
    port.rev++;
    c.update(6000);
    expect(findAll(root, (e) => e.className.includes('dc-row') && e.textContent.includes('Fight'))).toHaveLength(1);
  });

  it('Close (Esc) calls onEscape', () => {
    const { root, left } = open();
    findButton(root, 'Close (Esc)').click();
    expect(left()).toBe(1);
  });
});

describe('console map helpers', () => {
  it('frames every open call and unit, never closer than 1 px per metre', () => {
    const calls = [call(1, { x: -400, z: 0 }), call(2, { x: 400, z: 0, status: 'closed' }), call(3, { x: 200, z: 100 })];
    const units = [unit('N1', { x: 0, z: 300 })];
    const v = frameView(720, 440, calls, units);
    expect(v.cx).toBeCloseTo(-100, 5);
    expect(v.cz).toBeCloseTo(150, 5);
    expect(v.scale).toBeLessThanOrEqual(1);
    const tight = frameView(720, 440, [call(1, { x: 10, z: 10 })], []);
    expect(tight.scale).toBe(1);
    const empty = frameView(720, 440, [], []);
    expect(empty.cx).toBe(0);
    expect(empty.scale).toBeGreaterThan(0);
  });

  const view: MapView = { cx: 0, cz: 0, scale: 1, width: 200, height: 200 };

  it('picks the nearest marker within the radius; calls win ties, units win when strictly nearer', () => {
    const calls = [call(1, { x: 0, z: 0 }), call(2, { x: 50, z: 0, status: 'closed' })];
    const units = [unit('N1', { x: 0, z: 0 }), unit('N2', { x: 5, z: 0 })];
    // Pixel (100, 100) is the world origin.
    expect(pickMarker(view, calls, units, 100, 100)).toEqual({ kind: 'call', id: 1 });
    expect(pickMarker(view, calls, units, 105, 100)).toEqual({ kind: 'unit', callsign: 'N2' });
    expect(pickMarker(view, calls, units, 150, 100)).toBeNull(); // the closed call is not pickable
    expect(pickMarker(view, calls, units, 100 + MARKER_PICK_PX + 5, 100)).toBeNull();
  });

  it('maps priorities and statuses to semantic colours', () => {
    expect(priorityColorKey(1)).toBe('p1');
    expect(priorityColorKey(4)).toBe('p4');
    expect(priorityColorKey(9)).toBe('p4');
    expect(unitColorKey('available')).toBe('ok');
    expect(unitColorKey('enRoute')).toBe('caution');
    expect(unitColorKey('busy')).toBe('unitBusy');
    expect(unitColorKey('whatever')).toBe('accent');
  });
});

describe('road cache window', () => {
  const view: MapView = { cx: 100, cz: -50, scale: 2, width: 300, height: 200 };

  it('doubles the viewport and covers the view it was made for', () => {
    const w = windowFor(view);
    expect(w.width).toBe(600);
    expect(w.height).toBe(400);
    expect(w.scale).toBe(2);
    expect(windowCovers(w, view)).toBe(true);
    const out = windowOffset(w, view, { x: 0, y: 0 });
    expect(out.x).toBeCloseTo(-150, 6);
    expect(out.y).toBeCloseTo(-100, 6);
  });

  it('stops covering after a zoom change or a pan beyond the margin, and caps the canvas size', () => {
    const w = windowFor(view);
    expect(windowCovers(w, { ...view, scale: 3 })).toBe(false);
    expect(windowCovers(w, { ...view, cx: view.cx + 40 })).toBe(true);
    expect(windowCovers(w, { ...view, cx: view.cx + 400 })).toBe(false);
    const big = windowFor({ ...view, width: 5000, height: 5000 }, 2048);
    expect(big.width).toBe(2048);
    expect(big.height).toBe(2048);
  });

  it('draws nothing without a DOM and tolerates an empty graph with one', () => {
    const cache = new RoadCache(graph);
    expect(cache.ensure(view)).toBeNull();
    const undo = installFakeDom();
    try {
      const a = cache.ensure(view);
      expect(a).not.toBeNull();
      cache.ensure(view);
      expect(cache.builds).toBe(1);
      cache.ensure({ ...view, scale: 3 });
      expect(cache.builds).toBe(2);
      cache.invalidate();
      cache.ensure({ ...view, scale: 3 });
      expect(cache.builds).toBe(3);
    } finally {
      undo();
    }
  });
});
