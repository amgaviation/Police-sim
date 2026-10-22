/**
 * Phase 9 review: a gamepad-only player has no key for the MDT, the scene panel and the other openers, so the pause menu lists
 * them as buttons. Each button closes the pause menu first and then runs the same opener as its key.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PauseMenu, type PausePanel } from '../../src/game/pauseMenu';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

let undoDom: () => void = () => undefined;
beforeAll(() => {
  undoDom = installFakeDom();
});
afterAll(() => undoDom());

function make(panels: readonly PausePanel[]) {
  const ui = fakeUi();
  const menu = new PauseMenu(ui as unknown as UIRoot, {
    resume: () => undefined,
    quickSave: () => undefined,
    openSettings: () => undefined,
    quitToTitle: () => undefined,
    panels,
  });
  return { ui, menu, root: menu.element as unknown as FakeElement };
}

describe('pause menu panel buttons', () => {
  it('lists every panel as a button, and a click closes the pause menu before opening the panel', () => {
    const log: string[] = [];
    const labels = ['MDT', 'Scene actions', 'Investigation tools', 'Partner commands', 'Backup officers', 'Fleet / garage'];
    const { ui, menu, root } = make(
      labels.map((label) => ({
        label,
        open: () => log.push(`${label}:${ui.stack.length}`),
      })),
    );
    menu.open();
    expect(ui.stack).toContain(menu);
    for (const label of labels) expect(findButton(root, label).hidden, label).toBe(false);
    findButton(root, 'Scene actions').click();
    expect(ui.stack).not.toContain(menu);
    expect(log).toEqual(['Scene actions:0']);
  });

  it('hides a button whose panel is unavailable, and re-evaluates it on every open', () => {
    let coop = false;
    const { menu, root } = make([
      { label: 'MDT', open: () => undefined },
      { label: 'Co-op panel', open: () => undefined, available: () => coop },
    ]);
    menu.open();
    expect(findButton(root, 'Co-op panel').hidden).toBe(true);
    expect(findButton(root, 'MDT').hidden).toBe(false);
    menu.close();
    coop = true;
    menu.open();
    expect(findButton(root, 'Co-op panel').hidden).toBe(false);
  });

  it('adds nothing when no panels are given', () => {
    const { root } = make([]);
    const buttons = findAll(root, (e) => e.tagName === 'button').map((b) => b.textContent);
    expect(buttons).toEqual(['Resume', 'Quick save', 'Settings', 'Quit to title']);
  });
});
