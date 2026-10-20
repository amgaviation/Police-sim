import { describe, expect, it, vi } from 'vitest';
import type { DustView } from '../../src/investigation/types';
import { FingerprintPanel, MarkerLabels, reduceDustKey, type DustHandlers } from '../../src/ui/investigation';
import { asUi, fakeUi, key } from './helpers';

const view: DustView = {
  surface: 'glass',
  label: 'coffee table',
  cursor: 0,
  coverage: new Array<number>(16).fill(0),
  quality: 0,
  overbrush: 0,
};

function handlers() {
  const move = vi.fn<(dir: string) => void>();
  const lift = vi.fn<() => void>();
  const cancel = vi.fn<() => void>();
  const h: DustHandlers = { move: (d) => move(d), lift: () => lift(), cancel: () => cancel() };
  return { h, move, lift, cancel };
}

describe('reduceDustKey', () => {
  it('maps arrows and WASD to moves', () => {
    expect(reduceDustKey('ArrowUp')).toEqual({ kind: 'move', dir: 'up' });
    expect(reduceDustKey('s')).toEqual({ kind: 'move', dir: 'down' });
    expect(reduceDustKey('A')).toEqual({ kind: 'move', dir: 'left' });
    expect(reduceDustKey('ArrowRight')).toEqual({ kind: 'move', dir: 'right' });
  });

  it('Space brushes, Enter lifts, Escape cancels, anything else is ignored', () => {
    expect(reduceDustKey(' ')).toEqual({ kind: 'brush' });
    expect(reduceDustKey('Enter')).toEqual({ kind: 'lift' });
    expect(reduceDustKey('Escape')).toEqual({ kind: 'cancel' });
    expect(reduceDustKey('x')).toBeNull();
    expect(reduceDustKey('Tab')).toBeNull();
  });
});

describe('FingerprintPanel (headless)', () => {
  it('is a non-pausing menu with id inv-dust', () => {
    const p = new FingerprintPanel(null);
    expect(p.id).toBe('inv-dust');
    expect(p.pausesGame).toBe(false);
  });

  it('forwards moves and brushes while Space is held, whatever the key repeat does', () => {
    const p = new FingerprintPanel(null);
    const m = handlers();
    const h = m.h;
    p.open(view, h);
    expect(p.brushing).toBe(false);
    expect(p.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(m.move).toHaveBeenCalledWith('right');
    expect(p.onKeyDown(key(' '))).toBe(true);
    expect(p.brushing).toBe(true);
    // Moving the cursor (another key's repeat) and a repeating Space leave it held until the key is released.
    p.onKeyDown(key('ArrowLeft'));
    p.onKeyDown(key(' ', true));
    expect(p.brushing).toBe(true);
    p.onKeyUp({ key: 'a' });
    expect(p.brushing).toBe(true);
    p.onKeyUp({ key: ' ' });
    expect(p.brushing).toBe(false);
  });

  it('stops brushing when it closes or lifts, and starts released when reopened', () => {
    const p = new FingerprintPanel(null);
    const m = handlers();
    p.open(view, m.h);
    p.onKeyDown(key(' '));
    p.onKeyDown(key('Enter'));
    expect(p.brushing).toBe(false);
    p.open(view, m.h);
    expect(p.brushing).toBe(false);
    p.onKeyDown(key(' '));
    p.close();
    p.open(view, m.h);
    expect(p.brushing).toBe(false);
  });

  it('Enter lifts once and closes; Escape cancels once and closes', () => {
    const lifted = new FingerprintPanel(null);
    const m = handlers();
    const h = m.h;
    lifted.open(view, h);
    lifted.onKeyDown(key('Enter'));
    lifted.onKeyDown(key('Enter'));
    expect(m.lift).toHaveBeenCalledOnce();
    expect(lifted.isOpen).toBe(false);
    const cancelled = new FingerprintPanel(null);
    const m2 = handlers();
    const h2 = m2.h;
    cancelled.open(view, h2);
    cancelled.onKeyDown(key('Escape', true));
    expect(m2.cancel).not.toHaveBeenCalled();
    cancelled.onKeyDown(key('Escape'));
    expect(m2.cancel).toHaveBeenCalledOnce();
    expect(m2.lift).not.toHaveBeenCalled();
  });

  it('being dropped from the menu stack abandons the dusting; close() is silent', () => {
    const ui = fakeUi();
    const p = new FingerprintPanel(asUi(ui));
    const m = handlers();
    const h = m.h;
    p.open(view, h);
    ui.pop(p);
    expect(m.cancel).toHaveBeenCalledOnce();
    const m2 = handlers();
    const h2 = m2.h;
    p.open(view, h2);
    p.close();
    expect(m2.cancel).not.toHaveBeenCalled();
    expect(m2.lift).not.toHaveBeenCalled();
  });

  it('ignores keys while closed or with modifiers; update is safe', () => {
    const p = new FingerprintPanel(null);
    expect(p.onKeyDown(key(' '))).toBe(false);
    const m = handlers();
    const h = m.h;
    p.open(view, h);
    expect(p.onKeyDown({ key: ' ', repeat: false, altKey: true } as KeyboardEvent)).toBe(false);
    p.update({ ...view, cursor: 5 });
    expect(p.view?.cursor).toBe(5);
    expect(p.brushing).toBe(false);
  });
});

describe('MarkerLabels (headless)', () => {
  it('counts the labels it was given and never needs a DOM', () => {
    const labels = new MarkerLabels(null);
    expect(labels.count).toBe(0);
    labels.update([{ x: 10, y: 20, text: '1' }, { x: 30, y: 40, text: '2' }]);
    expect(labels.count).toBe(2);
    labels.update([]);
    expect(labels.count).toBe(0);
    labels.dispose();
    labels.update([{ x: 1, y: 2, text: '3' }]);
    expect(labels.count).toBe(1);
  });
});
