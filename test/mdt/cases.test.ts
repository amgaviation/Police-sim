import { afterEach, describe, expect, it } from 'vitest';
import { MDT_TABS, MDT_TAB_LABELS, MdtOverlay, casesModel, tabFromKey, tabKeyLabel, type MdtCaseRow, type MdtDeps } from '../../src/ui/mdt';
import { careerModel, careerSummarySection } from '../../src/ui/mdt/career';
import { FakeNode, installFakeDocument } from '../courtui/fakeDom';
import { renderCareer } from '../../src/ui/mdt';
import { at, fixture } from './helpers';
import { careerView } from './phase5';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

function row(id: string, status: string, over: Partial<MdtCaseRow> = {}): MdtCaseRow {
  return { id, status, nature: 'Burglary', opened: '05/01/2025 21:00', location: '12 Elm Street', suspects: 'Doe, John', witnesses: 'Roe, Jane', ...over };
}

describe('Cases tab registration', () => {
  it('is appended last, labelled Cases, arrow-reachable and keeps the digit mapping', () => {
    expect(MDT_TABS.at(-1)).toBe('cases');
    expect(MDT_TAB_LABELS.cases).toBe('Cases');
    expect(tabKeyLabel('cases')).toBe('');
    expect(tabKeyLabel('career')).toBe('0');
    expect(tabFromKey('0')).toBe('career');
    for (let i = 1; i <= 9; i++) expect(tabFromKey(String(i))).toBe(MDT_TABS[i - 1]);
    expect(MDT_TABS.indexOf('cases')).toBeGreaterThanOrEqual(9);
  });
});

describe('casesModel', () => {
  it('puts open first, then follow-up, then cold and cleared; the feed order is kept within a status', () => {
    const m = casesModel([
      row('K-5', 'cleared'), row('K-4', 'cold'), row('K-3', 'followUp'), row('K-2', 'open'), row('K-1', 'followUp'), row('K-0', 'open'),
    ]);
    expect(m.rows.map((r) => r.id)).toEqual(['K-2', 'K-0', 'K-3', 'K-1', 'K-4', 'K-5']);
    expect(m.rows.map((r) => r.statusLabel)).toEqual(['OPEN', 'OPEN', 'FOLLOW-UP', 'FOLLOW-UP', 'COLD', 'CLEARED']);
    expect(m.active).toBe(4);
    expect(m.rows[2]?.severity).toBe('caution');
    expect(m.rows[0]?.severity).toBe('info');
    expect(m.rows[4]?.severity).toBe('none');
  });

  it('shows none for missing suspects and witnesses and tolerates unknown statuses', () => {
    const m = casesModel([row('K-1', 'open', { suspects: '', witnesses: '' }), row('K-2', 'weird')]);
    expect(m.rows[0]).toMatchObject({ suspects: 'none', witnesses: 'none' });
    expect(m.rows[1]).toMatchObject({ statusLabel: 'WEIRD', severity: 'none' });
    expect(casesModel([])).toMatchObject({ rows: [], active: 0, empty: 'No cases on file' });
  });

  it('does not change the input', () => {
    const input = [row('K-2', 'cold'), row('K-1', 'open')];
    casesModel(input);
    expect(input.map((r) => r.id)).toEqual(['K-2', 'K-1']);
  });
});

describe('MdtOverlay Cases tab (headless)', () => {
  it('builds the model from deps.cases and refreshes only on a new revision', () => {
    const f = fixture();
    let rev = 1;
    let rows = [row('K-2', 'cold'), row('K-1', 'open')];
    let reads = 0;
    const deps: MdtDeps = { ...f.deps, cases: { revision: () => rev, rows: () => { reads++; return rows; } } };
    const mdt = new MdtOverlay(null, deps);
    mdt.open('cases');
    expect(mdt.casesModelShown).toBeNull();
    mdt.update(1000);
    expect(mdt.casesModelShown?.rows.map((r) => r.id)).toEqual(['K-1', 'K-2']);
    expect(reads).toBe(1);
    mdt.update(2000);
    mdt.update(3000);
    expect(reads).toBe(1); // same revision: nothing re-read
    rev = 2;
    rows = [...rows, row('K-3', 'followUp')];
    mdt.update(4000);
    expect(mdt.casesModelShown?.rows.map((r) => r.id)).toEqual(['K-1', 'K-3', 'K-2']);
    expect(reads).toBe(2);
  });

  it('has no model without the feed', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('cases');
    mdt.update(1000);
    expect(mdt.casesModelShown).toBeNull();
    expect(mdt.tab).toBe('cases');
  });

  it('is reached with the arrows (Command -> Cases -> Queue)', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('command');
    const arrow = (k: string): KeyboardEvent => ({ key: k, target: null, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} }) as unknown as KeyboardEvent;
    expect(mdt.onKeyDown(arrow('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('cases');
    expect(mdt.onKeyDown(arrow('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('queue');
  });
});

describe('CAREER section of the Career tab', () => {
  const lines = [
    { label: 'Stage', text: 'Probation · 3 shifts left' },
    { label: 'Rank', text: 'Officer' },
    { label: 'Fatigue', text: '42 %' },
  ];

  it('is the first section of careerModel and absent without a summary', () => {
    const plain = careerModel(careerView(), [], at(0));
    expect(plain.sections[0]?.id).toBe('duty');
    const m = careerModel(careerView(), [], at(0), { summary: lines });
    expect(m.sections[0]).toMatchObject({ id: 'career', title: 'CAREER' });
    expect(m.sections[0]?.lines.map((l) => `${l.label}=${l.text}`)).toEqual(['Stage=Probation · 3 shifts left', 'Rank=Officer', 'Fatigue=42 %']);
    expect(m.sections[1]?.id).toBe('duty');
    expect(m.sections).toHaveLength(plain.sections.length + 1);
  });

  it('renders as the first section (fake DOM)', () => {
    restore = installFakeDocument();
    const c = new FakeNode('DIV');
    renderCareer(c as unknown as HTMLElement, { sections: [careerSummarySection(lines)] }, { attend: () => undefined, review: () => undefined });
    expect(c.tag('h3')[0]?.textContent).toBe('CAREER');
    expect(c.textContent).toContain('Probation · 3 shifts left');
  });

  it('the overlay builds it from deps.careerSummary, with or without the conduct career feed', () => {
    const f = fixture();
    const withoutCareer = new MdtOverlay(null, { ...f.deps, careerSummary: () => lines });
    withoutCareer.open('career');
    withoutCareer.update(1000);
    expect(withoutCareer.careerSections?.sections.map((s) => s.id)).toEqual(['career']);
    const none = new MdtOverlay(null, f.deps);
    none.open('career');
    none.update(1000);
    expect(none.careerSections).toBeNull();
    const withCareer = new MdtOverlay(null, {
      ...f.deps,
      careerSummary: () => lines,
      career: {
        revision: () => 1, view: () => careerView(), cases: () => [], canAttend: () => false, attend: () => undefined, openIa: () => undefined,
        jurisdiction: () => ({ id: 'generic', name: 'Generic State Code' }), now: () => at(0),
      },
    });
    withCareer.open('career');
    withCareer.update(1000);
    expect(withCareer.careerSections?.sections[0]?.id).toBe('career');
    expect(withCareer.careerSections?.sections[1]?.id).toBe('duty');
  });
});
