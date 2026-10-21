import { afterEach, describe, expect, it } from 'vitest';
import { MdtOverlay, PREMISE_EMPTY, PREMISE_ENTRIES_MAX, premiseModel, renderPremise, type MdtDeps, type PremiseView } from '../../src/ui/mdt';
import { FakeNode, installFakeDocument } from '../courtui/fakeDom';
import { addCall, fixture } from './helpers';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function view(over: Partial<PremiseView> = {}): PremiseView {
  return {
    address: '248 N Oak Street',
    flags: ['weapon', 'repeat', 'drugs'],
    entries: [
      { when: '05/02/2025 22:10', text: 'Disturbance · cleared by arrest' },
      { when: '04/28/2025 03:40', text: 'Alarm · false alarm' },
    ],
    ...over,
  };
}

describe('premiseModel', () => {
  it('shows alert chips for weapon, violence and officer safety, caution for the rest', () => {
    const m = premiseModel(view({ flags: ['weapon', 'violence', 'officerSafety', 'arrest', 'drugs', 'mentalHealth', 'repeat'] }));
    expect(m.chips.map((c) => `${c.text}:${c.severity}`)).toEqual([
      'WEAPON:alert', 'VIOLENCE:alert', 'OFFICER SAFETY:alert', 'ARREST:caution', 'DRUGS:caution', 'MENTAL HEALTH:caution', 'REPEAT:info',
    ]);
    expect(m.address).toBe('248 N Oak Street');
  });

  it('humanizes a flag it has no label for', () => {
    expect(premiseModel(view({ flags: ['newFlagKind'] })).chips).toEqual([{ flag: 'newFlagKind', text: 'NEW FLAG KIND', severity: 'none' }]);
  });

  it('shows at most 6 entries and says how many more there are', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({ when: `t${String(i)}`, text: `call ${String(i)}` }));
    const m = premiseModel(view({ entries }));
    expect(PREMISE_ENTRIES_MAX).toBe(6);
    expect(m.entries).toHaveLength(6);
    expect(m.entries[0]?.text).toBe('call 0');
    expect(m.more).toBe(3);
    expect(m.empty).toBe('');
    expect(premiseModel(view({ entries: entries.slice(0, 6) })).more).toBe(0);
  });

  it('says there are no prior calls for an empty or missing history', () => {
    expect(PREMISE_EMPTY).toBe('No prior calls at this address');
    expect(premiseModel(view({ entries: [], flags: [] }))).toMatchObject({ entries: [], chips: [], empty: PREMISE_EMPTY });
    expect(premiseModel(null)).toMatchObject({ address: '', entries: [], chips: [], empty: PREMISE_EMPTY });
  });

  it('has a key that changes with the content', () => {
    const a = premiseModel(view()).key;
    expect(premiseModel(view()).key).toBe(a);
    expect(premiseModel(view({ flags: ['weapon'] })).key).not.toBe(a);
    expect(premiseModel(view({ entries: [] })).key).not.toBe(a);
    expect(premiseModel(null).key).not.toBe(a);
  });
});

describe('renderPremise (fake DOM)', () => {
  it('renders the heading, address, chips with severity classes and the entries', () => {
    restore = installFakeDocument();
    const section = renderPremise(premiseModel(view())) as unknown as FakeNode;
    expect(section.tagName).toBe('SECTION');
    expect(section.attrs['aria-label']).toBe('Premise history');
    expect(section.tag('h3')[0]?.textContent).toBe('PREMISE HISTORY');
    expect(section.all('mdt-premise-address')[0]?.textContent).toBe('248 N Oak Street');
    const chips = section.tag('li').filter((n) => n.className.includes('mdt-chip'));
    expect(chips.map((c) => c.textContent)).toEqual(['WEAPON', 'REPEAT', 'DRUGS']);
    expect(chips[0]?.className).toBe('mdt-chip mdt-chip-alert');
    expect(chips[1]?.className).toBe('mdt-chip mdt-chip-info');
    expect(section.all('mdt-premise-entries')[0]?.tag('li').map((li) => li.textContent)).toEqual([
      '05/02/2025 22:10 Disturbance · cleared by arrest',
      '04/28/2025 03:40 Alarm · false alarm',
    ]);
  });

  it('renders the empty text without entries and a note for entries beyond the cap', () => {
    restore = installFakeDocument();
    const empty = renderPremise(premiseModel(view({ entries: [], flags: [] }))) as unknown as FakeNode;
    expect(empty.textContent).toContain('No prior calls at this address');
    expect(empty.tag('ol')).toHaveLength(0);
    const many = renderPremise(premiseModel(view({ entries: Array.from({ length: 7 }, (_, i) => ({ when: 'w', text: String(i) })) }))) as unknown as FakeNode;
    expect(many.all('mdt-premise-entries')[0]?.tag('li')).toHaveLength(6);
    expect(many.textContent).toContain('1 older call not shown');
  });
});

describe('MdtOverlay premise feed (headless)', () => {
  it('builds the premise model of the shown call from deps.premise', () => {
    const f = fixture();
    const asked: number[] = [];
    const deps: MdtDeps = {
      ...f.deps,
      premise: (callId) => {
        asked.push(callId);
        return view();
      },
    };
    const call = addCall(f.cad, 1, 2);
    const mdt = new MdtOverlay(null, deps);
    mdt.open('call');
    mdt.selectCall(call.id);
    mdt.update(1000);
    expect(mdt.premiseModelShown?.chips.map((c) => c.text)).toEqual(['WEAPON', 'REPEAT', 'DRUGS']);
    expect(asked).toContain(call.id);
  });

  it('has no premise model without the feed or without a call, and an empty one when the feed has no data', () => {
    const f = fixture();
    const call = addCall(f.cad, 1, 2);
    const plain = new MdtOverlay(null, f.deps);
    plain.open('call');
    plain.selectCall(call.id);
    plain.update(1000);
    expect(plain.premiseModelShown).toBeNull();
    const nodata = new MdtOverlay(null, { ...f.deps, premise: () => null });
    nodata.open('call');
    nodata.selectCall(call.id);
    nodata.update(1000);
    expect(nodata.premiseModelShown?.empty).toBe(PREMISE_EMPTY);
    const nocall = new MdtOverlay(null, { ...f.deps, premise: () => view() });
    nocall.open('call');
    nocall.update(1000);
    expect(nocall.premiseModelShown).toBeNull();
  });
});
