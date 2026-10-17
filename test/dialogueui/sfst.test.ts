import { describe, expect, it } from 'vitest';
import { SfstPanel, sfstKeyName } from '../../src/ui/dialogue/sfstPanel';
import { keyEvent, sfst } from './fixtures';

describe('sfstKeyName', () => {
  it('maps Space, A, D and W (any case) and the arrows', () => {
    expect(sfstKeyName({ key: ' ', code: 'Space' })).toBe('space');
    expect(sfstKeyName({ key: 'Spacebar', code: '' })).toBe('space');
    expect(sfstKeyName({ key: 'a', code: 'KeyA' })).toBe('a');
    expect(sfstKeyName({ key: 'A', code: 'KeyA' })).toBe('a');
    expect(sfstKeyName({ key: 'ArrowLeft', code: 'ArrowLeft' })).toBe('a');
    expect(sfstKeyName({ key: 'd', code: 'KeyD' })).toBe('d');
    expect(sfstKeyName({ key: 'ArrowRight', code: 'ArrowRight' })).toBe('d');
    expect(sfstKeyName({ key: 'W', code: 'KeyW' })).toBe('w');
    expect(sfstKeyName({ key: 'ArrowUp', code: 'ArrowUp' })).toBe('w');
  });

  it('follows the printed key on other layouts and falls back to the Space code', () => {
    // AZERTY: the key labelled A is the physical KeyQ.
    expect(sfstKeyName({ key: 'a', code: 'KeyQ' })).toBe('a');
    expect(sfstKeyName({ key: 'Unidentified', code: 'Space' })).toBe('space');
  });

  it('returns null for everything else', () => {
    for (const e of [
      { key: 'x', code: 'KeyX' },
      { key: 'Enter', code: 'Enter' },
      { key: 'Escape', code: 'Escape' },
      { key: 'ArrowDown', code: 'ArrowDown' },
      { key: '1', code: 'Digit1' },
      { key: 'Shift', code: 'ShiftLeft' },
    ]) {
      expect(sfstKeyName(e), e.key).toBeNull();
    }
  });
});

describe('SfstPanel (headless)', () => {
  it('constructs without a UIRoot or document', () => {
    const p = new SfstPanel(null);
    expect(p.id).toBe('sfst');
    expect(p.pausesGame).toBe(false);
    expect(p.isOpen).toBe(false);
    expect(p.view).toBeNull();
    expect(p.onKeyDown(keyEvent(' '))).toBe(false);
    p.update(sfst());
    p.close();
    p.dispose();
  });

  it('sends test keys to the handler and swallows only those', () => {
    const p = new SfstPanel(null);
    const keys: string[] = [];
    let closed = 0;
    p.open(sfst(), { key: (k) => keys.push(k), close: () => closed++ });
    expect(p.isOpen).toBe(true);
    expect(p.onKeyDown(keyEvent(' ', { code: 'Space' }))).toBe(true);
    expect(p.onKeyDown(keyEvent('a'))).toBe(true);
    expect(p.onKeyDown(keyEvent('d'))).toBe(true);
    expect(p.onKeyDown(keyEvent('w'))).toBe(true);
    expect(p.onKeyDown(keyEvent('x'))).toBe(false);
    expect(keys).toEqual(['space', 'a', 'd', 'w']);
    expect(closed).toBe(0);
  });

  it('does not repeat keys and ignores them once the test is finished', () => {
    const p = new SfstPanel(null);
    const keys: string[] = [];
    p.open(sfst(), { key: (k) => keys.push(k), close: () => undefined });
    expect(p.onKeyDown(keyEvent('a', { repeat: true }))).toBe(true);
    expect(keys).toEqual([]);
    p.update(sfst({ finished: true, summary: ['Pass'] }));
    expect(p.onKeyDown(keyEvent('a'))).toBe(true);
    expect(keys).toEqual([]);
    expect(p.view?.finished).toBe(true);
  });

  it('Escape closes and tells the app; close() by the app does not', () => {
    const p = new SfstPanel(null);
    let closed = 0;
    p.open(sfst(), { key: () => undefined, close: () => closed++ });
    expect(p.onKeyDown(keyEvent('Escape'))).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(closed).toBe(1);
    p.open(sfst(), { key: () => undefined, close: () => closed++ });
    p.close();
    expect(closed).toBe(1);
    expect(p.isOpen).toBe(false);
  });

  it('ignores modified keys', () => {
    const p = new SfstPanel(null);
    const keys: string[] = [];
    p.open(sfst(), { key: (k) => keys.push(k), close: () => undefined });
    expect(p.onKeyDown(keyEvent('a', { ctrlKey: true }))).toBe(false);
    expect(keys).toEqual([]);
  });
});
