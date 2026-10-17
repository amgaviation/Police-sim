import { describe, expect, it } from 'vitest';
import {
  createDialogueState,
  DialoguePanel,
  DIALOGUE_TABS,
  reduceDialogueKey,
  TONES,
} from '../../src/ui/dialogue/dialoguePanel';
import type { DialoguePanelState, Tone } from '../../src/ui/dialogue/types';
import { handlers, keyEvent, view } from './fixtures';

const st = (o: Partial<DialoguePanelState> = {}): DialoguePanelState => ({ ...createDialogueState('neutral'), ...o });

describe('reduceDialogueKey: talk tab', () => {
  it('picks a topic with a digit, then emits the option with the current tone', () => {
    const v = view();
    const open = reduceDialogueKey(st(), v, '2');
    expect(open.consumed).toBe(true);
    expect(open.emit).toBeNull();
    expect(open.state.topic).toBe(1);
    // The first enabled option of the topic is highlighted (the first one, 'askName', is disabled).
    expect(open.state.focus).toBe(1);
    const say = reduceDialogueKey({ ...open.state, tone: 'commanding' }, v, '2');
    expect(say.emit).toEqual({ kind: 'say', id: 'requestId', tone: 'commanding' });
    expect(say.consumed).toBe(true);
    // The topic stays open for follow-up lines.
    expect(say.state.topic).toBe(1);
    expect(say.state.focus).toBe(1);
  });

  it('does not emit disabled options but still consumes the key', () => {
    const v = view();
    const r = reduceDialogueKey(st({ topic: 1 }), v, '1');
    expect(r.emit).toBeNull();
    expect(r.consumed).toBe(true);
    expect(r.state.topic).toBe(1);
  });

  it('ignores digits past the list and topics without options', () => {
    const v = view();
    expect(reduceDialogueKey(st(), v, '9')).toMatchObject({ emit: null, consumed: true });
    expect(reduceDialogueKey(st(), v, '9').state.topic).toBe(-1);
    // Topic 3 has no options: nothing opens.
    expect(reduceDialogueKey(st(), v, '3').state.topic).toBe(-1);
    expect(reduceDialogueKey(st({ topic: 0 }), v, '5')).toMatchObject({ emit: null, consumed: true });
  });

  it('Enter acts on the highlighted row like its digit, arrows move the highlight', () => {
    const v = view();
    let s = st();
    s = reduceDialogueKey(s, v, 'ArrowDown').state;
    expect(s.focus).toBe(1);
    const open = reduceDialogueKey(s, v, 'Enter');
    expect(open.state.topic).toBe(1);
    // Options: askName (disabled), requestId, askDob. Down skips nothing here, wraps past the end.
    let o = open.state;
    expect(o.focus).toBe(1);
    o = reduceDialogueKey(o, v, 'ArrowDown').state;
    expect(o.focus).toBe(2);
    o = reduceDialogueKey(o, v, 'ArrowDown').state;
    expect(o.focus).toBe(1); // wraps over the disabled first row
    o = reduceDialogueKey(o, v, 'ArrowUp').state;
    expect(o.focus).toBe(2); // wraps back
    expect(reduceDialogueKey(o, v, 'Enter').emit).toEqual({ kind: 'say', id: 'askDob', tone: 'neutral' });
  });

  it('reaches options past nine with the arrows and Enter', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ id: `o${String(i)}`, label: `Option ${String(i)}`, enabled: true }));
    const v = view({ topics: [{ id: 't', label: 'Many', options }] });
    let s = reduceDialogueKey(st(), v, '1').state;
    for (let i = 0; i < 10; i++) s = reduceDialogueKey(s, v, 'ArrowDown').state;
    expect(s.focus).toBe(10);
    expect(reduceDialogueKey(s, v, 'Enter').emit).toEqual({ kind: 'say', id: 'o10', tone: 'neutral' });
    // A tenth digit does not exist.
    expect(reduceDialogueKey(s, v, '0').consumed).toBe(false);
  });

  it('blocks lines and actions while an answer is pending', () => {
    const v = view({ busy: true });
    expect(reduceDialogueKey(st({ topic: 0 }), v, '1')).toMatchObject({ emit: null, consumed: true });
    expect(reduceDialogueKey(st({ tab: 'actions' }), v, '2')).toMatchObject({ emit: null, consumed: true });
    // Tone, tabs, mode and close still work.
    expect(reduceDialogueKey(st(), v, 'ArrowRight').state.tone).toBe('commanding');
    expect(reduceDialogueKey(st(), v, 'Escape').emit).toEqual({ kind: 'close' });
  });
});

describe('reduceDialogueKey: tone, tabs, modes', () => {
  it('cycles the tone with Left and Right and wraps', () => {
    const v = view();
    expect(TONES).toEqual(['polite', 'neutral', 'commanding', 'aggressive']);
    const tones: Tone[] = [];
    let s = st({ tone: 'polite' });
    for (let i = 0; i < 5; i++) {
      s = reduceDialogueKey(s, v, 'ArrowRight').state;
      tones.push(s.tone);
    }
    expect(tones).toEqual(['neutral', 'commanding', 'aggressive', 'polite', 'neutral']);
    expect(reduceDialogueKey(st({ tone: 'polite' }), v, 'ArrowLeft').state.tone).toBe('aggressive');
    expect(reduceDialogueKey(st({ tone: 'aggressive' }), v, 'ArrowRight').state.tone).toBe('polite');
  });

  it('Tab goes talk -> actions -> notes -> talk and resets the topic', () => {
    const v = view();
    let s = st({ topic: 1, focus: 2 });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = reduceDialogueKey(s, v, 'Tab');
      expect(r.consumed).toBe(true);
      expect(r.emit).toBeNull();
      s = r.state;
      seen.push(s.tab);
      expect(s.topic).toBe(-1);
    }
    expect(seen).toEqual(['actions', 'notes', 'talk', 'actions']);
    expect(DIALOGUE_TABS).toEqual(['talk', 'actions', 'notes']);
  });

  it('highlights the first enabled action when switching to the actions tab', () => {
    const r = reduceDialogueKey(st(), view(), 'Tab');
    expect(r.state.tab).toBe('actions');
    expect(r.state.focus).toBe(1);
  });

  it('emits actions on the actions tab and skips disabled ones', () => {
    const v = view();
    const tab = st({ tab: 'actions', focus: 1 });
    expect(reduceDialogueKey(tab, v, '1').emit).toBeNull();
    expect(reduceDialogueKey(tab, v, '2').emit).toEqual({ kind: 'action', id: 'cuff' });
    expect(reduceDialogueKey(tab, v, '3').emit).toEqual({ kind: 'action', id: 'release' });
    expect(reduceDialogueKey(tab, v, 'Enter').emit).toEqual({ kind: 'action', id: 'cuff' });
    // Down skips the disabled first action when wrapping.
    expect(reduceDialogueKey({ ...tab, focus: 2 }, v, 'ArrowDown').state.focus).toBe(1);
  });

  it('does nothing on the notes tab but swallows the digits', () => {
    const v = view();
    const notes = st({ tab: 'notes' });
    for (const k of ['1', 'Enter', 'ArrowDown']) {
      const r = reduceDialogueKey(notes, v, k);
      expect(r.emit, k).toBeNull();
      expect(r.consumed, k).toBe(true);
      expect(r.state, k).toBe(notes);
    }
  });

  it('M cycles the communication mode through the offered modes', () => {
    const v = view({ commMode: 'verbal', commModes: ['verbal', 'written', 'gesture'] });
    expect(reduceDialogueKey(st(), v, 'm').emit).toEqual({ kind: 'mode', mode: 'written' });
    expect(reduceDialogueKey(st(), v, 'M').emit).toEqual({ kind: 'mode', mode: 'written' });
    const last = view({ commMode: 'gesture', commModes: ['verbal', 'written', 'gesture'] });
    expect(reduceDialogueKey(st(), last, 'm').emit).toEqual({ kind: 'mode', mode: 'verbal' });
    // One mode only: nothing to switch to, but the key is still taken.
    expect(reduceDialogueKey(st(), view(), 'm')).toMatchObject({ emit: null, consumed: true });
    // A current mode that is not in the list starts at the first one.
    const odd = view({ commMode: 'interpreter', commModes: ['verbal', 'written'] });
    expect(reduceDialogueKey(st(), odd, 'm').emit).toEqual({ kind: 'mode', mode: 'verbal' });
  });
});

describe('reduceDialogueKey: back and close', () => {
  it('Backspace and Escape go back from an option list, focusing the topic left', () => {
    const v = view();
    for (const key of ['Backspace', 'Escape']) {
      const r = reduceDialogueKey(st({ topic: 1, focus: 2 }), v, key);
      expect(r.emit, key).toBeNull();
      expect(r.consumed, key).toBe(true);
      expect(r.state.topic, key).toBe(-1);
      expect(r.state.focus, key).toBe(1);
    }
  });

  it('Escape closes from the topic list and from the other tabs', () => {
    const v = view();
    expect(reduceDialogueKey(st(), v, 'Escape')).toMatchObject({ emit: { kind: 'close' }, consumed: true });
    expect(reduceDialogueKey(st({ tab: 'actions' }), v, 'Escape').emit).toEqual({ kind: 'close' });
    expect(reduceDialogueKey(st({ tab: 'notes' }), v, 'Escape').emit).toEqual({ kind: 'close' });
  });

  it('Backspace outside an option list is not consumed', () => {
    const r = reduceDialogueKey(st(), view(), 'Backspace');
    expect(r.consumed).toBe(false);
    expect(r.emit).toBeNull();
  });

  it('leaves other keys alone', () => {
    const s = st();
    for (const k of ['w', 'a', ' ', 'F5', 'Shift', '0', 'x']) {
      const r = reduceDialogueKey(s, view(), k);
      expect(r.consumed, k).toBe(false);
      expect(r.emit, k).toBeNull();
      expect(r.state, k).toBe(s);
    }
  });
});

describe('DialoguePanel (headless)', () => {
  it('constructs without a UIRoot or document', () => {
    const p = new DialoguePanel(null);
    expect(p.id).toBe('dialogue');
    expect(p.pausesGame).toBe(false);
    expect(p.isOpen).toBe(false);
    expect(p.element).toBeDefined();
    expect(p.onKeyDown(keyEvent('1'))).toBe(false);
    p.update(view());
    p.close();
    p.dispose();
  });

  it('opens with the view tone and routes keys to the handlers', () => {
    const p = new DialoguePanel(null);
    const { handlers: h, calls } = handlers();
    p.open(view({ tone: 'polite', commModes: ['verbal', 'written'] }), h);
    expect(p.isOpen).toBe(true);
    expect(p.state).toEqual({ tab: 'talk', topic: -1, tone: 'polite', focus: 0 });
    expect(p.onKeyDown(keyEvent('2'))).toBe(true);
    expect(p.state.topic).toBe(1);
    expect(p.onKeyDown(keyEvent('ArrowRight'))).toBe(true);
    expect(p.state.tone).toBe('neutral');
    expect(p.onKeyDown(keyEvent('3'))).toBe(true);
    expect(calls.say).toEqual([['askDob', 'neutral']]);
    expect(p.onKeyDown(keyEvent('m'))).toBe(true);
    expect(calls.mode).toEqual(['written']);
    expect(p.onKeyDown(keyEvent('Tab'))).toBe(true);
    expect(p.onKeyDown(keyEvent('3'))).toBe(true);
    expect(calls.action).toEqual(['release']);
    expect(calls.close).toBe(0);
  });

  it('Escape closes the panel and tells the app once; close() by the app does not', () => {
    const p = new DialoguePanel(null);
    const a = handlers();
    p.open(view(), a.handlers);
    expect(p.onKeyDown(keyEvent('Escape'))).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(a.calls.close).toBe(1);
    expect(p.onKeyDown(keyEvent('Escape'))).toBe(false);
    const b = handlers();
    p.open(view(), b.handlers);
    p.close();
    expect(p.isOpen).toBe(false);
    expect(b.calls.close).toBe(0);
  });

  it('does not repeat lines on a held key but repeats navigation', () => {
    const p = new DialoguePanel(null);
    const { handlers: h, calls } = handlers();
    p.open(view(), h);
    p.onKeyDown(keyEvent('1'));
    expect(p.onKeyDown(keyEvent('1', { repeat: true }))).toBe(true);
    expect(calls.say).toEqual([]);
    p.onKeyDown(keyEvent('1'));
    expect(calls.say).toEqual([['greet', 'neutral']]);
    expect(p.onKeyDown(keyEvent('ArrowDown', { repeat: true }))).toBe(true);
    expect(p.state.focus).toBe(1);
  });

  it('ignores keys with ctrl, alt or meta held', () => {
    const p = new DialoguePanel(null);
    p.open(view(), handlers().handlers);
    for (const mod of ['ctrlKey', 'altKey', 'metaKey'] as const) {
      expect(p.onKeyDown(keyEvent('1', { [mod]: true }))).toBe(false);
    }
    expect(p.state.topic).toBe(-1);
  });

  it('keeps the selection on update, adopts a changed tone, resets for a new contact', () => {
    const p = new DialoguePanel(null);
    p.open(view({ tone: 'neutral' }), handlers().handlers);
    p.onKeyDown(keyEvent('ArrowRight'));
    p.onKeyDown(keyEvent('2'));
    expect(p.state).toMatchObject({ topic: 1, tone: 'commanding' });
    p.update(view({ tone: 'neutral', title: 'Updated' }));
    expect(p.state).toMatchObject({ topic: 1, tone: 'commanding' });
    p.update(view({ tone: 'polite' }));
    expect(p.state.tone).toBe('polite');
    p.update(view({ contactId: 2, tone: 'aggressive' }));
    expect(p.state).toEqual({ tab: 'talk', topic: -1, tone: 'aggressive', focus: 0 });
  });

  it('clamps the state when the topics shrink', () => {
    const p = new DialoguePanel(null);
    p.open(view(), handlers().handlers);
    p.onKeyDown(keyEvent('2'));
    p.update(view({ topics: [{ id: 'only', label: 'Only', options: [{ id: 'x', label: 'X', enabled: true }] }] }));
    expect(p.state.topic).toBe(-1);
    expect(p.state.focus).toBeLessThanOrEqual(0);
  });

  it('ignores updates while closed', () => {
    const p = new DialoguePanel(null);
    p.update(view());
    expect(p.isOpen).toBe(false);
  });
});
