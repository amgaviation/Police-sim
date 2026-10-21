/**
 * UI sounds (design §7.3): `UiSoundEmitter` (pure) and the sounds UIRoot raises: 'open' on push, 'close' on pop, 'move' on a
 * focus move, 'select' on a click on a button / checkbox / radio / select inside the menu layer, anything else through
 * `sound()`. The audio module listens through `onUiSound` (integrator wiring).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UIRoot, UiSoundEmitter, type UiSoundKind } from '../../src/ui/ui';
import { FakeElement, StubDoc, installFakeDom, makeMenu } from './domStub';

const KINDS: readonly UiSoundKind[] = ['move', 'select', 'back', 'open', 'close', 'error', 'notify'];

describe('UiSoundEmitter', () => {
  it('delivers every kind to every listener in subscription order', () => {
    const e = new UiSoundEmitter();
    const a: UiSoundKind[] = [];
    const b: string[] = [];
    e.on((k) => a.push(k));
    e.on((k) => b.push(`b:${k}`));
    for (const k of KINDS) e.emit(k);
    expect(a).toEqual([...KINDS]);
    expect(b).toEqual(KINDS.map((k) => `b:${k}`));
  });

  it('unsubscribes, and clear() drops everyone', () => {
    const e = new UiSoundEmitter();
    const got: UiSoundKind[] = [];
    const off = e.on((k) => got.push(k));
    e.emit('open');
    off();
    off();
    e.emit('close');
    expect(got).toEqual(['open']);
    e.on((k) => got.push(k));
    e.clear();
    e.emit('error');
    expect(got).toEqual(['open']);
  });

  it('survives a listener that unsubscribes itself while being called', () => {
    const e = new UiSoundEmitter();
    const got: string[] = [];
    const off = e.on(() => {
      got.push('once');
      off();
    });
    e.on(() => got.push('second'));
    e.emit('move');
    e.emit('move');
    expect(got).toEqual(['once', 'second', 'second']);
  });
});

describe('UIRoot sounds', () => {
  const doc = new StubDoc();
  let undo: () => void;
  let ui: UIRoot;
  let sounds: UiSoundKind[];
  let layer: FakeElement;

  beforeEach(() => {
    undo = installFakeDom();
    (globalThis as { document?: unknown }).document = doc;
    doc.activeElement = null;
    doc.listeners['keydown'] = [];
    const root = new FakeElement('div');
    Object.defineProperty(root, 'ownerDocument', { value: doc });
    ui = new UIRoot(root as unknown as HTMLElement);
    layer = root.children[1] as FakeElement; // .ui-menus
    sounds = [];
    ui.onUiSound((k) => sounds.push(k));
  });
  afterEach(() => {
    ui.dispose();
    undo();
  });

  it("plays 'open' on push and 'close' on pop", () => {
    const { menu } = makeMenu(doc, 'a');
    ui.push(menu);
    expect(sounds).toEqual(['open']);
    ui.pop(menu);
    expect(sounds).toEqual(['open', 'close']);
    ui.pop(menu); // not open: nothing
    expect(sounds).toEqual(['open', 'close']);
  });

  it('plays a sound for a menu that replaces another and for closeAll', () => {
    const a = makeMenu(doc, 'a').menu;
    const b = makeMenu(doc, 'b').menu;
    ui.push(a);
    ui.replace(b);
    expect(sounds).toEqual(['open', 'close', 'open']);
    sounds.length = 0;
    ui.closeAll();
    expect(sounds).toEqual(['close']);
  });

  it("plays 'select' for clicks on buttons, role=button, checkboxes, radios and selects inside the menu layer", () => {
    const hit = { closest: () => ({}) };
    const miss = { closest: () => null };
    layer.fire('click', { target: hit });
    layer.fire('click', { target: hit });
    layer.fire('click', { target: miss });
    layer.fire('click', { target: {} });
    layer.fire('click', { target: null });
    expect(sounds).toEqual(['select', 'select']);
  });

  it('asks for the right selector', () => {
    const asked: string[] = [];
    layer.fire('click', { target: { closest: (s: string) => (asked.push(s), null) } });
    expect(asked).toHaveLength(1);
    for (const part of ['button', '[role="button"]', 'input[type="checkbox"]', 'input[type="radio"]', 'select']) expect(asked[0]).toContain(part);
  });

  it('sound() plays any kind through the listeners; the unsubscribe silences one listener only', () => {
    const second: UiSoundKind[] = [];
    const off = ui.onUiSound((k) => second.push(k));
    for (const k of KINDS) ui.sound(k);
    expect(sounds).toEqual([...KINDS]);
    expect(second).toEqual([...KINDS]);
    off();
    ui.sound('error');
    expect(second).toHaveLength(KINDS.length);
    expect(sounds.at(-1)).toBe('error');
  });

  it('is silent after dispose', () => {
    ui.dispose();
    ui.sound('notify');
    expect(sounds).toEqual([]);
  });
});
