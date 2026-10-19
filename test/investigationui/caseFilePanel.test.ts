import { describe, expect, it, vi } from 'vitest';
import { CaseStore, CustodyLedger } from '../../src/evidence';
import { CASE_TABS, buildCaseView, type CaseFileView } from '../../src/investigation/caseView';
import {
  CaseFilePanel,
  clampCaseState,
  createCaseFileState,
  reduceCaseKey,
  type CaseFileHandlers,
} from '../../src/ui/investigation';
import { asUi, fakeUi, key } from './helpers';

/** A file with a found item, a collected one, and a photo. */
function view(): CaseFileView {
  const store = new CaseStore();
  const spec = { item: 'knife', label: 'Knife', x: 0, y: 0, z: 0, buildingId: -1, room: -1, furniture: -1, container: 'none' as const, concealed: false, ownerPersonId: 1, incriminating: true };
  const a = store.addItem(1, spec);
  a.state = 'found';
  a.foundBasis = 'plainView';
  const b = store.addItem(1, { ...spec, label: 'Glass', item: 'brokenGlass' });
  b.state = 'collected';
  const ledger = new CustodyLedger();
  ledger.append({ itemId: b.id, action: 'collect', from: 'scene', to: 'officer:1', sim: 1, game: 36000, location: 'x', note: 'Glass' });
  const file = store.file(1, 'C-00001', 'Burglary');
  file.photos.push({
    id: 'P-1-1', callId: 1, sim: 2, game: 36060, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, buildingId: -1, room: -1,
    subjects: [], caption: 'Overview — Kitchen', thumb: 'data:image/jpeg;base64,AA',
  });
  return buildCaseView(file, ledger, () => 'someone');
}

function handlers() {
  const custody = vi.fn<(itemId: string, action: string) => void>();
  const close = vi.fn<() => void>();
  const h: CaseFileHandlers = { custody: (id, a) => custody(id, a), close: () => close() };
  return { h, custody, close };
}

describe('reduceCaseKey', () => {
  const v = view();

  it('Tab and the arrows move through the tabs and reset the highlight', () => {
    let s = { tab: 0, focus: 1 };
    s = reduceCaseKey(s, v, 'Tab').state;
    expect(s).toEqual({ tab: 1, focus: 0 });
    expect(reduceCaseKey(s, v, 'ArrowLeft').state.tab).toBe(0);
    expect(reduceCaseKey(createCaseFileState(), v, 'ArrowLeft').state.tab).toBe(CASE_TABS.length - 1);
    let t = createCaseFileState();
    for (let i = 0; i < CASE_TABS.length; i++) t = reduceCaseKey(t, v, 'Tab').state;
    expect(t.tab).toBe(0);
  });

  it('digits jump to a tab', () => {
    expect(reduceCaseKey(createCaseFileState(), v, '5').state.tab).toBe(4);
    expect(reduceCaseKey(createCaseFileState(), v, '8').consumed).toBe(false);
    expect(reduceCaseKey(createCaseFileState(), v, '0').consumed).toBe(false);
  });

  it('Up and Down move the highlight and wrap; an empty tab ignores them', () => {
    const items = v.tabs.items.length;
    expect(items).toBe(2);
    let s = createCaseFileState();
    s = reduceCaseKey(s, v, 'ArrowDown').state;
    expect(s.focus).toBe(1);
    s = reduceCaseKey(s, v, 'ArrowDown').state;
    expect(s.focus).toBe(0);
    s = reduceCaseKey(s, v, 'ArrowUp').state;
    expect(s.focus).toBe(1);
    const empty = reduceCaseKey({ tab: 2, focus: 0 }, v, 'ArrowDown');
    expect(empty.state).toEqual({ tab: 2, focus: 0 });
    expect(empty.consumed).toBe(true);
  });

  it('Enter on an item row performs its next custody step', () => {
    const first = reduceCaseKey({ tab: 0, focus: 0 }, v, 'Enter');
    expect(first.emit).toEqual({ kind: 'custody', itemId: 'E-1-1', action: 'collect' });
    const second = reduceCaseKey({ tab: 0, focus: 1 }, v, 'Enter');
    expect(second.emit).toEqual({ kind: 'custody', itemId: 'E-1-2', action: 'bag' });
  });

  it('Enter does nothing on other tabs or an empty list', () => {
    expect(reduceCaseKey({ tab: 1, focus: 0 }, v, 'Enter').emit).toBeNull();
    expect(reduceCaseKey({ tab: 4, focus: 0 }, v, 'Enter').emit).toBeNull();
    expect(reduceCaseKey({ tab: 2, focus: 0 }, v, 'Enter').emit).toBeNull();
  });

  it('Escape closes; unknown keys are not consumed', () => {
    expect(reduceCaseKey(createCaseFileState(), v, 'Escape').emit).toEqual({ kind: 'close' });
    expect(reduceCaseKey(createCaseFileState(), v, 'x')).toMatchObject({ emit: null, consumed: false });
  });

  it('clampCaseState keeps tab and focus inside a changed view', () => {
    expect(clampCaseState({ tab: 0, focus: 9 }, v)).toEqual({ tab: 0, focus: 1 });
    expect(clampCaseState({ tab: 2, focus: 5 }, v)).toEqual({ tab: 2, focus: 0 });
    expect(clampCaseState({ tab: 40, focus: 0 }, v).tab).toBe(CASE_TABS.length - 1);
    const same = { tab: 0, focus: 0 };
    expect(clampCaseState(same, v)).toBe(same);
  });
});

describe('CaseFilePanel (headless)', () => {
  it('is a non-pausing menu with id inv-case', () => {
    const p = new CaseFilePanel(null);
    expect(p.id).toBe('inv-case');
    expect(p.pausesGame).toBe(false);
    expect(p.isOpen).toBe(false);
    expect(p.view).toBeNull();
  });

  it('Enter runs the custody handler once per press, not on key repeat', () => {
    const p = new CaseFilePanel(null);
    const m = handlers();
    const h = m.h;
    p.open(view(), h);
    expect(p.onKeyDown(key('Enter'))).toBe(true);
    expect(m.custody).toHaveBeenCalledWith('E-1-1', 'collect');
    p.onKeyDown(key('Enter', true));
    expect(m.custody).toHaveBeenCalledOnce();
  });

  it('keeps the selection across updates and clamps it when rows disappear', () => {
    const p = new CaseFilePanel(null);
    p.open(view(), handlers().h);
    p.onKeyDown(key('ArrowDown'));
    expect(p.state.focus).toBe(1);
    p.update(view());
    expect(p.state.focus).toBe(1);
    const small = view();
    p.update({ ...small, tabs: { ...small.tabs, items: small.tabs.items.slice(0, 1) } });
    expect(p.state.focus).toBe(0);
  });

  it('Escape closes through the handler; close() is silent; closed panels ignore keys', () => {
    const p = new CaseFilePanel(null);
    const m = handlers();
    const h = m.h;
    p.open(view(), h);
    expect(p.onKeyDown(key('Escape'))).toBe(true);
    expect(m.close).toHaveBeenCalledOnce();
    expect(p.isOpen).toBe(false);
    expect(p.onKeyDown(key('Enter'))).toBe(false);
    const m2 = handlers();
    const h2 = m2.h;
    p.open(view(), h2);
    p.close();
    expect(m2.close).not.toHaveBeenCalled();
  });

  it('is dropped cleanly from the menu stack', () => {
    const ui = fakeUi();
    const p = new CaseFilePanel(asUi(ui));
    const m = handlers();
    const h = m.h;
    p.open(view(), h);
    expect(ui.menus).toEqual([p]);
    ui.pop(p);
    expect(p.isOpen).toBe(false);
    expect(m.close).toHaveBeenCalledOnce();
  });

  it('update on a closed panel is ignored', () => {
    const p = new CaseFilePanel(null);
    p.update(view());
    expect(p.view).toBeNull();
  });
});
