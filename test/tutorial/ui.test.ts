import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INACTIVE_TUTORIAL_VIEW } from '../../src/tutorial';
import { TutorialCard } from '../../src/ui/tutorial/tutorialCard';
import { TutorialDialog } from '../../src/ui/tutorial/tutorialDialog';
import type { UIRoot } from '../../src/ui/ui';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from '../ui7/fakeDom';
import { FIRST_SHIFT_BEATS, drive, makeRig } from './rig';

const label = (id: string): string => `<${id}>`;
const key = (k: string, extra: Record<string, unknown> = {}): KeyboardEvent => ({ key: k, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...extra }) as unknown as KeyboardEvent;

describe('TutorialCard (headless)', () => {
  it('builds no DOM without a parent and keeps the model', () => {
    const card = new TutorialCard(null);
    expect(card.element).toBeNull();
    const r = makeRig();
    r.runner.ack();
    r.tick();
    card.update(r.runner.view, label);
    expect(card.visible).toBe(true);
    expect(card.model).toEqual({
      visible: true,
      title: r.runner.view.step?.title,
      text: 'Walk to the patrol car in the lot and press <interact> to get in.',
      hint: 'Move with <move.forward>, <move.left>, <move.back> and <move.right>.',
      progress: 'Step 2 of 14',
    });
    card.dispose();
  });

  it('is hidden without a tutorial, on ack steps and when finished', () => {
    const card = new TutorialCard(null);
    const r = makeRig();
    card.update(r.runner.view, label); // welcome: an ack step, the dialog shows it
    expect(card.visible).toBe(false);
    card.update(INACTIVE_TUTORIAL_VIEW, label);
    expect(card.visible).toBe(false);
    drive(r, 13);
    card.update(r.runner.view, label); // done: ack step
    expect(card.visible).toBe(false);
    drive(r);
    card.update(r.runner.view, label);
    expect(card.visible).toBe(false);
    expect(card.model.text).toBe('');
  });

  it('rebuilds only when the revision changes', () => {
    const card = new TutorialCard(null);
    const r = makeRig();
    r.runner.ack();
    r.tick();
    let asked = 0;
    const counting = (id: string): string => (asked++, id);
    card.update(r.runner.view, counting);
    const first = asked;
    expect(first).toBeGreaterThan(0);
    card.update(r.runner.view, counting);
    r.tick(100);
    card.update(r.runner.view, counting);
    expect(asked).toBe(first);
    r.send('player:mode', { mode: 'driving', vehicle: 2 });
    r.tick();
    card.update(r.runner.view, counting);
    expect(asked).toBeGreaterThan(first);
    expect(card.model.progress).toBe('Step 3 of 14');
  });

  it('a different script with the same revision still rebuilds', () => {
    const card = new TutorialCard(null);
    const a = { ...INACTIVE_TUTORIAL_VIEW, active: true, scriptId: 'a', title: 'A', count: 2, revision: 0, step: { id: 's', title: 'One', text: 'x', hint: '', ack: false, skippable: true } };
    card.update(a, label);
    expect(card.model.title).toBe('One');
    card.update({ ...a, scriptId: 'b', step: { ...a.step, title: 'Two' } }, label);
    expect(card.model.title).toBe('Two');
  });
});

describe('TutorialCard (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  it('is a polite status region in the HUD that starts hidden', () => {
    const hud = new FakeElement('div');
    const card = new TutorialCard(hud as unknown as HTMLElement);
    const root = card.element as unknown as FakeElement;
    expect(hud.children).toContain(root);
    expect(root.attrs['role']).toBe('status');
    expect(root.attrs['aria-live']).toBe('polite');
    expect(root.className).toBe('tut-card');
    expect(root.hidden).toBe(true);
    expect(findAll(root, (e) => e.tagName === 'button' || e.tagName === 'input')).toHaveLength(0); // never takes input
  });

  it('shows the title, text, hint and progress and hides again', () => {
    const hud = new FakeElement('div');
    const card = new TutorialCard(hud as unknown as HTMLElement);
    const root = card.element as unknown as FakeElement;
    const r = makeRig();
    r.runner.ack();
    r.tick();
    card.update(r.runner.view, label);
    expect(root.hidden).toBe(false);
    const text = (cls: string): FakeElement => findAll(root, (e) => e.className === cls)[0] as FakeElement;
    expect(text('tut-title').textContent).toBe(r.runner.view.step?.title);
    expect(text('tut-text').textContent).toContain('<interact>');
    expect(text('tut-hint').textContent).toContain('<move.forward>');
    expect(text('tut-hint').hidden).toBe(false);
    expect(text('tut-step').textContent).toBe('Step 2 of 14');
    // the takeCall step has a hint too; trafficStop has none
    const late = makeRig();
    drive(late, 9);
    expect(late.runner.view.step?.id).toBe('trafficStop');
    card.update(late.runner.view, label);
    expect(text('tut-hint').hidden).toBe(true);
    expect(text('tut-hint').textContent).toBe('');
    r.runner.end();
    r.tick();
    card.update(r.runner.view, label);
    expect(root.hidden).toBe(true);
    card.dispose();
    expect(hud.children).not.toContain(root);
  });
});

describe('TutorialDialog (headless)', () => {
  function setup() {
    const calls: string[] = [];
    const dialog = new TutorialDialog(null, { ack: () => void calls.push('ack'), end: () => void calls.push('end') });
    return { dialog, calls };
  }

  it('opens for an ack step once per index and keeps its text', () => {
    const { dialog } = setup();
    const r = makeRig();
    expect(dialog.id).toBe('tutorial-dialog');
    expect(dialog.pausesGame).toBe(true);
    expect(dialog.isOpen).toBe(false);
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(true);
    expect(dialog.content.title).toBe('Your first shift');
    expect(dialog.content.text).toContain('<menu.toggle>');
  });

  it('Continue acks and closes at once; the same step does not reopen', () => {
    const { dialog, calls } = setup();
    const r = makeRig();
    dialog.sync(r.runner.view, label);
    dialog.proceed();
    expect(calls).toEqual(['ack']);
    expect(dialog.isOpen).toBe(false);
    dialog.sync(r.runner.view, label); // the runner has not stepped yet
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(false);
    expect(calls).toEqual(['ack']);
    // the paused-then-resumed loop: ack applies, the next step is not an ack step
    r.runner.ack();
    r.tick();
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(false);
  });

  it('End tutorial ends and closes', () => {
    const { dialog, calls } = setup();
    const r = makeRig();
    dialog.sync(r.runner.view, label);
    dialog.endTutorial();
    expect(calls).toEqual(['end']);
    expect(dialog.isOpen).toBe(false);
    dialog.endTutorial();
    dialog.proceed();
    expect(calls).toEqual(['end']);
  });

  it('opens again for the final ack step and for a restarted tutorial', () => {
    const { dialog } = setup();
    const r = makeRig();
    dialog.sync(r.runner.view, label);
    dialog.proceed();
    drive(r, 13);
    r.tick();
    expect(r.runner.view.step?.id).toBe('done');
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(true);
    expect(dialog.content.title).toBe('That is the job');
    dialog.sync(INACTIVE_TUTORIAL_VIEW, label);
    expect(dialog.isOpen).toBe(false);
    const again = makeRig();
    dialog.sync(again.runner.view, label);
    expect(dialog.isOpen).toBe(true);
    expect(dialog.content.title).toBe('Your first shift');
  });

  it('closes when the view stops being an ack step (tutorial ended elsewhere)', () => {
    const { dialog } = setup();
    const r = makeRig();
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(true);
    r.runner.end();
    r.tick();
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(false);
  });

  it('never opens for a non-ack step', () => {
    const { dialog } = setup();
    const r = makeRig();
    r.runner.ack();
    r.tick();
    dialog.sync(r.runner.view, label);
    expect(dialog.isOpen).toBe(false);
    for (const beat of FIRST_SHIFT_BEATS.slice(1, 12)) {
      beat.run(r, 700);
      dialog.sync(r.runner.view, label);
      expect(dialog.isOpen, beat.id).toBe(false);
    }
  });

  describe('keys', () => {
    it('Enter and Escape are Continue (consumed); nothing ends the tutorial', () => {
      for (const k of ['Enter', 'Escape']) {
        const { dialog, calls } = setup();
        dialog.sync(makeRig().runner.view, label);
        expect(dialog.onKeyDown(key(k))).toBe(true);
        expect(calls).toEqual(['ack']);
        expect(dialog.isOpen).toBe(false);
      }
    });

    it('other keys, modified keys and a closed dialog are not consumed', () => {
      const { dialog, calls } = setup();
      expect(dialog.onKeyDown(key('Enter'))).toBe(false); // closed
      dialog.sync(makeRig().runner.view, label);
      expect(dialog.onKeyDown(key('a'))).toBe(false);
      expect(dialog.onKeyDown(key(' '))).toBe(false);
      expect(dialog.onKeyDown(key('Enter', { ctrlKey: true }))).toBe(false);
      expect(dialog.onKeyDown(key('Escape', { altKey: true }))).toBe(false);
      expect(calls).toEqual([]);
      expect(dialog.isOpen).toBe(true);
    });

    it('a held key does not ack twice, and Enter on a focused button is left to the button', () => {
      const { dialog, calls } = setup();
      dialog.sync(makeRig().runner.view, label);
      expect(dialog.onKeyDown(key('Enter', { repeat: true }))).toBe(true);
      expect(calls).toEqual([]);
      expect(dialog.onKeyDown(key('Enter', { target: { tagName: 'BUTTON' } }))).toBe(false);
      expect(dialog.onKeyDown(key('Enter', { target: { tagName: 'DIV' } }))).toBe(true);
      expect(calls).toEqual(['ack']);
    });
  });
});

describe('TutorialDialog (DOM double)', () => {
  let undo: () => void = () => undefined;
  beforeAll(() => {
    undo = installFakeDom();
  });
  afterAll(() => undo());

  it('is a dialog with an autofocused Continue and an End tutorial button, pushed on the menu stack', () => {
    const ui = fakeUi();
    const calls: string[] = [];
    const dialog = new TutorialDialog(ui as unknown as UIRoot, { ack: () => void calls.push('ack'), end: () => void calls.push('end') });
    const root = dialog.element as unknown as FakeElement;
    expect(root.attrs['role']).toBe('dialog');
    expect(findButton(root, 'Continue').attrs['autofocus']).toBeDefined();
    expect(findButton(root, 'Continue').className).toContain('primary');
    const r = makeRig();
    dialog.sync(r.runner.view, label);
    expect(ui.stack).toEqual([dialog]);
    expect(root.textContent).toContain('Your first shift');
    expect(root.textContent).toContain('<menu.toggle>');
    findButton(root, 'Continue').click();
    expect(calls).toEqual(['ack']);
    expect(ui.stack).toEqual([]);
  });

  it('End tutorial pops the dialog and ends; dispose removes the element', () => {
    const ui = fakeUi();
    const calls: string[] = [];
    const dialog = new TutorialDialog(ui as unknown as UIRoot, { ack: () => void calls.push('ack'), end: () => void calls.push('end') });
    const root = dialog.element as unknown as FakeElement;
    dialog.sync(makeRig().runner.view, label);
    findButton(root, 'End tutorial').click();
    expect(calls).toEqual(['end']);
    expect(ui.stack).toEqual([]);
    const holder = new FakeElement('div');
    holder.appendChild(root);
    dialog.dispose();
    expect(holder.children).toHaveLength(0);
  });
});
