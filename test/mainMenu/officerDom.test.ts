import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MainMenu, type MainMenuCharacter } from '../../src/ui/mainMenu';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';

let undo: () => void = () => undefined;
beforeAll(() => {
  undo = installFakeDom();
});
afterAll(() => undo());

describe('MainMenu "Create officer..." (DOM double)', () => {
  it('opens the creator, shows the chosen officer and starts the game with it', () => {
    const ui = fakeUi();
    const started: unknown[][] = [];
    const menu = new MainMenu(ui as unknown as UIRoot, {
      newGame: (seed, jurisdiction, character) => void started.push([seed, jurisdiction, character]),
      continueGame: () => undefined,
      openSettings: () => undefined,
    });
    const root = menu.element as unknown as FakeElement;
    const line = findAll(root, (e) => e.className.includes('officer-line'))[0];
    expect(line?.hidden).toBe(true);

    findButton(root, 'Create officer…').click();
    const creator = ui.stack.at(-1) as { id: string; element: FakeElement } | undefined;
    expect(creator?.id).toBe('character-creator');
    if (!creator) return;

    // Rename the officer and press Done.
    const first = findAll(creator.element, (e) => e.tagName === 'input' && e.attrs['type'] === 'text')[0];
    first?.fire('input', { target: { value: 'Casey' } });
    findButton(creator.element, 'Done').click();
    expect(ui.stack).not.toContain(creator);
    expect(line?.hidden).toBe(false);
    expect(line?.textContent).toBe('Officer: Casey Doe (they/them)');

    menu.seed = '12';
    findButton(root, 'New game').click();
    const chosen = started[0]?.[2] as MainMenuCharacter | undefined;
    expect(started[0]?.slice(0, 2)).toEqual([12, 'generic']);
    expect(chosen?.profile.firstName).toBe('Casey');
    expect(chosen?.gear.assignment).toBe('patrol');

    // Reopening starts from the chosen officer; cancelling keeps it.
    findButton(root, 'Create officer…').click();
    const again = ui.stack.at(-1) as { element: FakeElement } | undefined;
    expect(findAll(again?.element ?? root, (e) => e.tagName === 'input' && e.attrs['type'] === 'text')[0]?.value).toBe('Casey');
    findButton(again?.element ?? root, 'Cancel').click();
    expect(menu.character?.profile.firstName).toBe('Casey');
  });
});
