/**
 * Keyboard focus navigation (design §7.3): the pure `nextFocusIndex`, the focusable filter and `UIRoot.moveFocus` /
 * the arrow-key fallback (arrows move focus over a menu's real controls when the menu does not handle them).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UIRoot, arrowDirection, nextFocusIndex, usesArrowKeys, type UiSoundKind } from '../../src/ui/ui';
import { Focusable, FakeElement, StubDoc, installFakeDom, keyEvent, makeMenu } from './domStub';

describe('nextFocusIndex', () => {
  it('moves forward and wraps at the end', () => {
    expect(nextFocusIndex(4, 0, 1)).toBe(1);
    expect(nextFocusIndex(4, 2, 1)).toBe(3);
    expect(nextFocusIndex(4, 3, 1)).toBe(0);
  });

  it('moves backward and wraps at the start', () => {
    expect(nextFocusIndex(4, 3, -1)).toBe(2);
    expect(nextFocusIndex(4, 1, -1)).toBe(0);
    expect(nextFocusIndex(4, 0, -1)).toBe(3);
  });

  it('starts at the first (forward) or the last (backward) when nothing has focus', () => {
    expect(nextFocusIndex(3, -1, 1)).toBe(0);
    expect(nextFocusIndex(3, -1, -1)).toBe(2);
    expect(nextFocusIndex(3, 99, 1)).toBe(0);
    expect(nextFocusIndex(3, 99, -1)).toBe(2);
    expect(nextFocusIndex(3, Number.NaN, 1)).toBe(0);
  });

  it('gives -1 for an empty list and stays put with a single control', () => {
    expect(nextFocusIndex(0, -1, 1)).toBe(-1);
    expect(nextFocusIndex(0, 0, -1)).toBe(-1);
    expect(nextFocusIndex(1, 0, 1)).toBe(0);
    expect(nextFocusIndex(1, 0, -1)).toBe(0);
  });

  it('visits every control once in a full lap in either direction', () => {
    for (const dir of [1, -1] as const) {
      const seen: number[] = [];
      let at = -1;
      for (let i = 0; i < 5; i++) {
        at = nextFocusIndex(5, at, dir);
        seen.push(at);
      }
      expect(new Set(seen).size).toBe(5);
    }
  });
});

describe('arrowDirection and usesArrowKeys', () => {
  it('maps the four arrows to a direction, other keys to 0', () => {
    expect(['ArrowDown', 'ArrowRight'].map(arrowDirection)).toEqual([1, 1]);
    expect(['ArrowUp', 'ArrowLeft'].map(arrowDirection)).toEqual([-1, -1]);
    expect(['Enter', 'Tab', 'a', ' '].map(arrowDirection)).toEqual([0, 0, 0, 0]);
  });

  it('keeps arrows for text fields, selects, textareas, sliders and editable text', () => {
    expect(usesArrowKeys({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'INPUT' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'INPUT', type: 'range' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'SELECT' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'TEXTAREA' })).toBe(true);
    expect(usesArrowKeys({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('lets arrows move focus from buttons, checkboxes, radios and plain elements', () => {
    expect(usesArrowKeys({ tagName: 'BUTTON' })).toBe(false);
    expect(usesArrowKeys({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(usesArrowKeys({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(usesArrowKeys({ tagName: 'DIV' })).toBe(false);
    expect(usesArrowKeys(null)).toBe(false);
    expect(usesArrowKeys(undefined)).toBe(false);
  });
});

describe('UIRoot focus movement', () => {
  const doc = new StubDoc();
  let undo: () => void;
  let ui: UIRoot;
  let sounds: UiSoundKind[];

  beforeEach(() => {
    undo = installFakeDom();
    (globalThis as { document?: unknown }).document = doc;
    doc.activeElement = null;
    doc.listeners['keydown'] = [];
    const root = new FakeElement('div');
    Object.defineProperty(root, 'ownerDocument', { value: doc });
    ui = new UIRoot(root as unknown as HTMLElement);
    sounds = [];
    ui.onUiSound((k) => sounds.push(k));
  });
  afterEach(() => {
    ui.dispose();
    undo();
  });

  it('moveFocus is false without a top menu or without focusable controls', () => {
    expect(ui.moveFocus(1)).toBe(false);
    const { menu } = makeMenu(doc, 'empty', 0);
    ui.push(menu);
    expect(ui.moveFocus(1)).toBe(false);
    expect(ui.moveFocus(-1)).toBe(false);
  });

  it('moveFocus walks the controls in document order, wrapping, and plays the move sound', () => {
    const { menu, el } = makeMenu(doc, 'three', 3);
    ui.push(menu);
    sounds.length = 0;
    doc.activeElement = null;
    expect(ui.moveFocus(1)).toBe(true);
    expect(doc.activeElement).toBe(el.focusables[0]);
    ui.moveFocus(1);
    ui.moveFocus(1);
    expect(doc.activeElement).toBe(el.focusables[2]);
    ui.moveFocus(1);
    expect(doc.activeElement).toBe(el.focusables[0]);
    ui.moveFocus(-1);
    expect(doc.activeElement).toBe(el.focusables[2]);
    expect(sounds).toEqual(['move', 'move', 'move', 'move', 'move']);
  });

  it('skips disabled, hidden, inert-ancestor and zero-size controls', () => {
    const { menu, el } = makeMenu(doc, 'filtered', 5);
    const [a, b, c, d, e] = el.focusables as [Focusable, Focusable, Focusable, Focusable, Focusable];
    b.disabled = true;
    c.hidden = true;
    d.rects = 0;
    e.type = 'hidden';
    ui.push(menu);
    doc.activeElement = null;
    ui.moveFocus(1);
    expect(doc.activeElement).toBe(a);
    ui.moveFocus(1); // only a is left: it keeps the focus
    expect(doc.activeElement).toBe(a);
  });

  it('closest([hidden], [inert]) hides a control too', () => {
    const { menu, el } = makeMenu(doc, 'inert', 2);
    (el.focusables[0] as Focusable).closestHit = true; // inside a hidden / inert ancestor
    ui.push(menu);
    doc.activeElement = null;
    ui.moveFocus(1);
    expect(doc.activeElement).toBe(el.focusables[1]);
  });

  it('arrows the top menu does not consume move focus and are prevented; the others pass through', () => {
    const { menu, el } = makeMenu(doc, 'arrows', 3);
    ui.push(menu);
    doc.activeElement = el.focusables[0];
    const down = keyEvent('ArrowDown', { target: el.focusables[0] });
    doc.keydown(down);
    expect(down.prevented).toBe(true);
    expect(doc.activeElement).toBe(el.focusables[1]);
    const right = keyEvent('ArrowRight', { target: el.focusables[1] });
    doc.keydown(right);
    expect(doc.activeElement).toBe(el.focusables[2]);
    const up = keyEvent('ArrowUp', { target: el.focusables[2] });
    doc.keydown(up);
    expect(doc.activeElement).toBe(el.focusables[1]);
    doc.keydown(keyEvent('ArrowLeft', { target: el.focusables[1] }));
    expect(doc.activeElement).toBe(el.focusables[0]);
    const enter = keyEvent('Enter', { target: el.focusables[0] });
    doc.keydown(enter);
    expect(enter.prevented).toBe(false);
    expect(doc.activeElement).toBe(el.focusables[0]);
    expect(menu.keys).toEqual(['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Enter']);
  });

  it('does not move focus when the menu consumed the arrow (it moves its own highlight)', () => {
    const { menu, el } = makeMenu(doc, 'own', 3);
    menu.consume = () => true;
    ui.push(menu);
    doc.activeElement = el.focusables[0];
    const down = keyEvent('ArrowDown', { target: el.focusables[0] });
    doc.keydown(down);
    expect(down.prevented).toBe(true); // consumed: default prevented, as before Phase 9
    expect(doc.activeElement).toBe(el.focusables[0]);
  });

  it('leaves arrows to text fields, selects and sliders, and ignores chords', () => {
    const { menu, el } = makeMenu(doc, 'fields', 2);
    ui.push(menu);
    doc.activeElement = el.focusables[0];
    for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'SELECT' }, { tagName: 'INPUT', type: 'range' }, { tagName: 'TEXTAREA' }]) {
      const e = keyEvent('ArrowDown', { target });
      doc.keydown(e);
      expect(e.prevented, JSON.stringify(target)).toBe(false);
      expect(doc.activeElement).toBe(el.focusables[0]);
    }
    const chord = keyEvent('ArrowDown', { target: el.focusables[0], ctrlKey: true });
    doc.keydown(chord);
    expect(chord.prevented).toBe(false);
    expect(doc.activeElement).toBe(el.focusables[0]);
  });

  it('does nothing without a menu and ignores keys typed into the HUD', () => {
    const e = keyEvent('ArrowDown');
    doc.keydown(e);
    expect(e.prevented).toBe(false);
    const { menu } = makeMenu(doc, 'x', 2);
    ui.push(menu);
    const hudKey = keyEvent('ArrowDown', { target: ui.hud });
    // the fake element's contains() is always false: emulate a HUD target
    (ui.hud as unknown as { contains: (n: unknown) => boolean }).contains = (n) => n === ui.hud;
    doc.keydown(hudKey);
    expect(hudKey.prevented).toBe(false);
    expect(menu.keys).toEqual([]);
  });
});
