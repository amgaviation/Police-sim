import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modRef } from '../../src/mods/combine';
import type { StoredMod } from '../../src/mods/store';
import { ModManager, type ModManagerHost, type ModStoreLike } from '../../src/ui/mods/modManager';
import type { UIRoot } from '../../src/ui/ui';
import { bundle, fakeContext } from '../mods/helpers';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

let undo: () => void = () => undefined;
beforeAll(() => {
  undo = installFakeDom();
});
afterAll(() => undo());

function stored(id: string): StoredMod {
  const b = bundle(id, {});
  return { id, bundle: b, ref: modRef(b), size: 100, installedAt: 0 };
}

describe('ModManager (DOM double)', () => {
  it('shows the rows, the safe-mode notice, the boot errors and the active refs', async () => {
    const mods = [stored('a-mod'), stored('b-mod')];
    let order = ['b-mod'];
    let reloads = 0;
    const store: ModStoreLike = {
      list: () => Promise.resolve(mods),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      enabled: () => order,
      setEnabled: (ids) => void (order = [...ids]),
    };
    const host: ModManagerHost = {
      store,
      context: () => fakeContext(),
      active: () => [{ id: 'b-mod', modVersion: '1.0.0', hash: mods[1]?.ref.hash ?? '' }],
      bootErrors: () => ['a-mod: callTypes[0].id: duplicate'],
      safeMode: () => true,
      reload: () => void reloads++,
      close: () => undefined,
    };
    const ui = fakeUi();
    const mm = new ModManager(ui as unknown as UIRoot, host);
    await mm.open();
    expect(ui.stack).toContain(mm);
    const root = mm.element as unknown as FakeElement;
    const notice = findAll(root, (e) => e.className.includes('mm-notice'))[0];
    expect(notice?.hidden).toBe(false);
    expect(notice?.textContent).toMatch(/disabled after a failed start/i);
    expect(findAll(root, (e) => e.className.includes('mm-row'))).toHaveLength(2);
    expect(root.textContent).toContain('a-mod: callTypes[0].id: duplicate');
    expect(root.textContent).toContain('Active now: b-mod 1.0.0');
    expect(root.textContent).toContain('#1 active');

    const boxes = findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'checkbox');
    expect(boxes).toHaveLength(2);
    // Tick a-mod (listed second, disabled): it joins the load order.
    const aBox = boxes.find((b) => b.attrs['aria-label'] === 'Enable a-mod');
    if (!aBox) throw new Error('no checkbox');
    aBox.fire('change', { target: { checked: true } });
    expect(mm.enabledOrder).toEqual(['b-mod', 'a-mod']);

    findButton(root, 'Save & reload').click();
    expect(order).toEqual(['b-mod', 'a-mod']);
    expect(reloads).toBe(1);
  });

  it('shows a plain message with no mods', async () => {
    const store: ModStoreLike = {
      list: () => Promise.resolve([]),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      enabled: () => [],
      setEnabled: () => undefined,
    };
    const mm = new ModManager(fakeUi() as unknown as UIRoot, {
      store,
      context: () => fakeContext(),
      active: () => [],
      bootErrors: () => [],
      safeMode: () => false,
      reload: () => undefined,
      close: () => undefined,
    });
    await mm.open();
    const root = mm.element as unknown as FakeElement;
    expect(root.textContent).toContain('No mods installed.');
    expect(root.textContent).toContain('No mods are active in this session.');
    expect(findAll(root, (e) => e.className.includes('mm-notice'))[0]?.hidden).toBe(true);
  });
});
