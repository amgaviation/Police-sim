import { afterEach, describe, expect, it } from 'vitest';
import type { Answer } from '../../src/court/types';
import {
  ANSWER_LABELS,
  COURT_NAME,
  CourtroomPanel,
  courtroomViewOf,
  createCourtroomState,
  firstUnanswered,
  reduceCourtKey,
  type CourtroomState,
  type CourtroomView,
} from '../../src/ui/court/courtroomPanel';
import type { Menu, UIRoot } from '../../src/ui/ui';
import { FakeNode, fakeKey, installFakeDocument } from './fakeDom';

const view = (n = 3): CourtroomView => ({
  caseId: 'CR-0003',
  title: 'Defendant: DOE, JANE',
  motions: [
    { text: 'Motion to suppress Baggie of pills — GRANTED (GS-4.2)', granted: true },
    { text: 'Motion to suppress Pistol — DENIED (incidentToArrest: GS-4.1)', granted: false },
  ],
  questions: Array.from({ length: n }, (_, i) => ({ id: `q${String(i + 1)}`, text: `Question number ${String(i + 1)}?` })),
});

/** Runs keys through the reducer from the initial state. */
function run(v: CourtroomView, keys: string[]): { state: CourtroomState; emits: unknown[]; consumed: boolean[] } {
  let state = createCourtroomState(v);
  const emits: unknown[] = [];
  const consumed: boolean[] = [];
  for (const k of keys) {
    const r = reduceCourtKey(state, v, k);
    state = r.state;
    consumed.push(r.consumed);
    if (r.emit) emits.push(r.emit);
  }
  return { state, emits, consumed };
}

describe('courtroomViewOf', () => {
  it('keeps only the ruling text and question text (no truth, report line or camera flag)', () => {
    const v = courtroomViewOf({
      id: 'CR-0001',
      personLabel: 'DOE, JANE',
      motions: [{ text: 'm', granted: true, ruleIds: ['GS-1'], dismissesCase: true }],
      questions: [{ id: 'q1', kind: 'consentGiven', text: 'Did he consent?', truth: 'yes', reportSays: 'no', eventId: 4, onCamera: true, weight: 9, pairOf: null }],
    });
    expect(v).toEqual({ caseId: 'CR-0001', title: 'Defendant: DOE, JANE', motions: [{ text: 'm', granted: true }], questions: [{ id: 'q1', text: 'Did he consent?' }] });
    expect(Object.keys(v.questions[0] ?? {}).sort()).toEqual(['id', 'text']);
    expect(courtroomViewOf({ id: 'CR-0002', personLabel: '', motions: [], questions: [] }).title).toBe('Defendant unknown');
  });
});

describe('reduceCourtKey', () => {
  it('starts at the rulings with nothing answered', () => {
    const s = createCourtroomState(view(2));
    expect(s).toEqual({ phase: 'motions', index: 0, answers: [null, null] });
  });

  it('motions: Enter begins the testimony, Escape closes, other keys are ignored', () => {
    const v = view();
    const s = createCourtroomState(v);
    const enter = reduceCourtKey(s, v, 'Enter');
    expect(enter.state).toEqual({ phase: 'questions', index: 0, answers: [null, null, null] });
    expect(enter.consumed).toBe(true);
    expect(enter.emit).toBeNull();
    const esc = reduceCourtKey(s, v, 'Escape');
    expect(esc.emit).toEqual({ kind: 'close' });
    expect(esc.consumed).toBe(true);
    for (const k of ['1', 'Backspace', 'x', 'ArrowDown']) {
      const r = reduceCourtKey(s, v, k);
      expect(r.consumed, k).toBe(false);
      expect(r.state).toBe(s);
      expect(r.emit).toBeNull();
    }
  });

  it('motions with no questions go straight to the review', () => {
    const v = view(0);
    const r = reduceCourtKey(createCourtroomState(v), v, 'Enter');
    expect(r.state.phase).toBe('review');
    expect(reduceCourtKey(r.state, v, 'Enter').emit).toEqual({ kind: 'submit', answers: [] });
  });

  it('questions: 1 yes, 2 no, 3 don\'t recall, each advancing; the last leads to the review', () => {
    const v = view();
    const { state } = run(v, ['Enter', '1', '2', '3']);
    expect(state).toEqual({ phase: 'review', index: 2, answers: ['yes', 'no', 'dontRecall'] });
    const mid = run(v, ['Enter', '2']);
    expect(mid.state).toEqual({ phase: 'questions', index: 1, answers: ['no', null, null] });
  });

  it('accepts Digit and Numpad key codes', () => {
    const v = view(2);
    expect(run(v, ['Enter', 'Digit1', 'Numpad3']).state.answers).toEqual(['yes', 'dontRecall']);
  });

  it('questions: Backspace returns to the previous question and an answer can be replaced', () => {
    const v = view();
    const back = run(v, ['Enter', '1', '2', 'Backspace']);
    expect(back.state).toEqual({ phase: 'questions', index: 1, answers: ['yes', 'no', null] });
    const redo = run(v, ['Enter', '1', 'Backspace', '3']);
    expect(redo.state.answers[0]).toBe('dontRecall');
    expect(redo.state.index).toBe(1);
  });

  it('questions: Backspace on the first question and Escape do nothing but are consumed (the testimony must be finished)', () => {
    const v = view();
    const r = run(v, ['Enter', 'Backspace', 'Escape']);
    expect(r.state).toEqual({ phase: 'questions', index: 0, answers: [null, null, null] });
    expect(r.consumed).toEqual([true, true, true]);
    expect(r.emits).toEqual([]);
  });

  it('questions: Enter keeps an answer already given but does not answer a fresh question', () => {
    const v = view();
    const fresh = run(v, ['Enter', 'Enter']);
    expect(fresh.state.index).toBe(0);
    expect(fresh.consumed[1]).toBe(true);
    const kept = run(v, ['Enter', '1', 'Backspace', 'Enter']);
    expect(kept.state.index).toBe(1);
    expect(kept.state.answers[0]).toBe('yes');
  });

  it('questions: unrelated keys are not consumed', () => {
    const v = view();
    const r = run(v, ['Enter', 'x', 'ArrowLeft']);
    expect(r.consumed).toEqual([true, false, false]);
  });

  it('review: Enter submits all answers in order, Backspace goes back to the last question', () => {
    const v = view();
    const done = run(v, ['Enter', '1', '2', '3', 'Enter']);
    expect(done.emits).toEqual([{ kind: 'submit', answers: ['yes', 'no', 'dontRecall'] satisfies Answer[] }]);
    const back = run(v, ['Enter', '1', '2', '3', 'Backspace']);
    expect(back.state).toEqual({ phase: 'questions', index: 2, answers: ['yes', 'no', 'dontRecall'] });
    // Re-answering the last question leads to the review again with the new answer.
    const redo = run(v, ['Enter', '1', '2', '3', 'Backspace', '1']);
    expect(redo.state).toEqual({ phase: 'review', index: 2, answers: ['yes', 'no', 'yes'] });
  });

  it('review: Escape is consumed and does nothing; a state with an unanswered question returns to it instead of submitting', () => {
    const v = view();
    const r = run(v, ['Enter', '1', '2', '3', 'Escape']);
    expect(r.state.phase).toBe('review');
    expect(r.consumed[4]).toBe(true);
    expect(r.emits).toEqual([]);
    const odd: CourtroomState = { phase: 'review', index: 2, answers: ['yes', null, 'no'] };
    const back = reduceCourtKey(odd, v, 'Enter');
    expect(back.emit).toBeNull();
    expect(back.state).toEqual({ phase: 'questions', index: 1, answers: ['yes', null, 'no'] });
    expect(firstUnanswered(['yes', null, 'no'])).toBe(1);
    expect(firstUnanswered(['yes'])).toBe(-1);
  });

  it('never mutates the state it is given', () => {
    const v = view();
    const s: CourtroomState = { phase: 'questions', index: 0, answers: [null, null, null] };
    const copy = structuredClone(s);
    reduceCourtKey(s, v, '1');
    expect(s).toEqual(copy);
  });

  it('labels the answers', () => {
    expect(ANSWER_LABELS).toEqual({ yes: 'Yes', no: 'No', dontRecall: "Don't recall" });
    expect(COURT_NAME).toBe('Superior Court — Department 3');
  });
});

describe('CourtroomPanel (headless)', () => {
  function panel(): { panel: CourtroomPanel; submits: { caseId: string; answers: readonly Answer[] }[] } {
    const submits: { caseId: string; answers: readonly Answer[] }[] = [];
    return { panel: new CourtroomPanel(null, (caseId, answers) => submits.push({ caseId, answers })), submits };
  }

  it('constructs without a DOM as a pausing menu and ignores keys while closed', () => {
    const { panel: p } = panel();
    expect(p.id).toBe('courtroom');
    expect(p.pausesGame).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(p.canLeave).toBe(false);
    expect(p.onKeyDown(fakeKey('Enter'))).toBe(false);
    expect(p.press('Enter')).toBe(false);
  });

  it('walks the hearing and submits once', () => {
    const { panel: p, submits } = panel();
    p.open(view());
    expect(p.isOpen).toBe(true);
    expect(p.canLeave).toBe(true);
    expect(p.state.phase).toBe('motions');
    expect(p.onKeyDown(fakeKey('Enter'))).toBe(true);
    expect(p.canLeave).toBe(false);
    for (const k of ['1', '2', '3']) p.onKeyDown(fakeKey(k));
    expect(p.state.phase).toBe('review');
    expect(submits).toEqual([]);
    expect(p.onKeyDown(fakeKey('Enter'))).toBe(true);
    expect(submits).toEqual([{ caseId: 'CR-0003', answers: ['yes', 'no', 'dontRecall'] }]);
    expect(p.isOpen).toBe(false);
    expect(p.press('Enter')).toBe(false); // closed: nothing more is submitted
    expect(submits).toHaveLength(1);
  });

  it('Escape in the rulings closes without submitting; once begun it cannot leave', () => {
    const a = panel();
    a.panel.open(view());
    expect(a.panel.onKeyDown(fakeKey('Escape'))).toBe(true);
    expect(a.panel.isOpen).toBe(false);
    expect(a.submits).toEqual([]);

    const b = panel();
    b.panel.open(view());
    b.panel.onKeyDown(fakeKey('Enter'));
    expect(b.panel.onKeyDown(fakeKey('Escape'))).toBe(true);
    expect(b.panel.isOpen).toBe(true);
    expect(b.submits).toEqual([]);
  });

  it('a held key does not answer several questions and modifier chords pass through', () => {
    const { panel: p } = panel();
    p.open(view());
    p.onKeyDown(fakeKey('Enter'));
    expect(p.onKeyDown(fakeKey('1', { repeat: true }))).toBe(true);
    expect(p.state.answers[0]).toBeNull();
    expect(p.onKeyDown(fakeKey('1', { ctrlKey: true }))).toBe(false);
    expect(p.state.answers[0]).toBeNull();
    expect(p.onKeyDown(fakeKey('1'))).toBe(true);
    expect(p.state.answers[0]).toBe('yes');
  });

  it('reopening starts again at the rulings and close() does not submit', () => {
    const { panel: p, submits } = panel();
    p.open(view());
    p.press('Enter');
    p.press('1');
    p.open(view(2));
    expect(p.state).toEqual({ phase: 'motions', index: 0, answers: [null, null] });
    p.close();
    expect(p.isOpen).toBe(false);
    expect(submits).toEqual([]);
    p.close(); // idempotent
    p.dispose();
  });

  it('a hearing with no questions submits an empty testimony', () => {
    const { panel: p, submits } = panel();
    p.open(view(0));
    p.press('Enter');
    p.press('Enter');
    expect(submits).toEqual([{ caseId: 'CR-0003', answers: [] }]);
  });
});

describe('CourtroomPanel (fake DOM)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  function fakeUi(): { ui: UIRoot; stack: Menu[] } {
    const stack: Menu[] = [];
    const ui = {
      isOpen: (m: Menu) => stack.includes(m),
      push: (m: Menu) => stack.push(m),
      pop: (m?: Menu) => {
        const t = m ?? stack[stack.length - 1];
        if (!t) return;
        stack.splice(stack.indexOf(t), 1);
        t.onHide?.();
      },
    } as unknown as UIRoot;
    return { ui, stack };
  }

  it('renders the bench, the rulings, one question at a time and the review, and pushes itself on the menu stack', () => {
    restore = installFakeDocument();
    const { ui, stack } = fakeUi();
    const submits: { caseId: string; answers: readonly Answer[] }[] = [];
    const p = new CourtroomPanel(ui, (caseId, answers) => submits.push({ caseId, answers }));
    const root = p.element as unknown as FakeNode;
    p.open(view());
    expect(stack).toEqual([p]);
    expect(root.all('crt-bench')[0]?.textContent).toBe('Superior Court — Department 3');
    expect(root.all('crt-case')[0]?.textContent).toBe('CR-0003 · Defendant: DOE, JANE');
    const motions = root.all('crt-motion');
    expect(motions).toHaveLength(2);
    expect(motions[0]?.className).toContain('crt-granted');
    expect(motions[0]?.textContent).toContain('GRANTED');
    expect(motions[1]?.textContent).toContain('DENIED');

    p.press('Enter');
    expect(root.all('crt-qcount')[0]?.textContent).toBe('Q 1 / 3');
    expect(root.all('crt-question')[0]?.textContent).toBe('Question number 1?');
    expect(root.all('crt-step')).toHaveLength(3);
    expect(root.all('crt-step-current')).toHaveLength(1);
    // The answer buttons press the same keys.
    const buttons = root.all('crt-answers')[0]?.children ?? [];
    expect(buttons.map((b) => b.textContent)).toEqual(['1  Yes', '2  No', '3  Don\'t recall']);
    buttons[1]?.fire('click');
    expect(root.all('crt-qcount')[0]?.textContent).toBe('Q 2 / 3');
    expect(root.all('crt-step-done')).toHaveLength(1);

    p.press('1');
    p.press('3');
    const rows = root.all('crt-review-row');
    expect(rows.map((r) => r.all('crt-review-a')[0]?.textContent)).toEqual(['No', 'Yes', "Don't recall"]);
    root.all('crt-primary')[0]?.fire('click');
    expect(submits).toEqual([{ caseId: 'CR-0003', answers: ['no', 'yes', 'dontRecall'] }]);
    expect(stack).toEqual([]);
    expect(p.isOpen).toBe(false);
  });

  it('shows a message when no motions were argued and shows the hint of each phase', () => {
    restore = installFakeDocument();
    const { ui } = fakeUi();
    const p = new CourtroomPanel(ui, () => undefined);
    const root = p.element as unknown as FakeNode;
    p.open({ caseId: 'CR-0009', title: 'Defendant: ROE', motions: [], questions: [{ id: 'q1', text: 'One?' }] });
    expect(root.all('crt-empty')[0]?.textContent).toBe('No motions were argued.');
    expect(root.all('crt-hint')[0]?.textContent).toContain('Esc leave');
    p.press('Enter');
    expect(root.all('crt-hint')[0]?.textContent).toContain("Don't recall");
    p.press('2');
    expect(root.all('crt-hint')[0]?.textContent).toContain('Enter submit');
  });

  it('leaves the stack when the UI pops it from outside', () => {
    restore = installFakeDocument();
    const { ui, stack } = fakeUi();
    const p = new CourtroomPanel(ui, () => undefined);
    p.open(view());
    ui.pop(p);
    expect(stack).toEqual([]);
    expect(p.isOpen).toBe(false);
  });
});
