import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaseStore, CustodyLedger } from '../../src/evidence';
import { buildCaseView } from '../../src/investigation/caseView';
import type { DustView } from '../../src/investigation/types';
import { CameraOverlay, CaseFilePanel, FingerprintPanel, MarkerLabels } from '../../src/ui/investigation';
import { FakeEl, installFakeDocument } from './fakeDom';
import { asUi, fakeUi, key } from './helpers';

let restore: () => void = () => undefined;
beforeEach(() => {
  restore = installFakeDocument();
});
afterEach(() => {
  restore();
});

const el = (e: HTMLElement): FakeEl => e as unknown as FakeEl;

function caseView(): ReturnType<typeof buildCaseView> {
  const store = new CaseStore();
  const spec = { item: 'knife', label: 'Knife', x: 0, y: 0, z: 0, buildingId: -1, room: -1, furniture: -1, container: 'none' as const, concealed: false, ownerPersonId: 1, incriminating: true };
  const a = store.addItem(1, spec);
  a.state = 'found';
  a.foundBasis = 'plainView';
  const file = store.file(1, 'C-00001', 'Burglary');
  file.photos.push({
    id: 'P-1-1', callId: 1, sim: 0, game: 36000, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, buildingId: -1, room: -1,
    subjects: [{ kind: 'item', ref: a.id }], caption: 'Knife (Kitchen)', thumb: 'data:image/jpeg;base64,AA',
  });
  return buildCaseView(file, new CustodyLedger(), () => 'someone');
}

describe('CameraOverlay DOM', () => {
  it('draws the field of view, the case line and the caption', () => {
    const ui = fakeUi();
    const c = new CameraOverlay(asUi(ui));
    c.open({ caseLabel: 'C-00042', room: 'Kitchen', caption: 'Marker 1 — Knife (Kitchen)' }, { shutter: vi.fn(), fov: vi.fn(), close: vi.fn() });
    const root = el(c.element);
    expect(root.className).toBe('inv-camera');
    expect(root.all('inv-cam-fov')[0]?.textContent).toBe('FOV 60°');
    expect(root.all('inv-cam-place')[0]?.textContent).toBe('C-00042 · Kitchen');
    expect(root.all('inv-cam-caption')[0]?.textContent).toBe('Marker 1 — Knife (Kitchen)');
    c.onKeyDown(key('ArrowUp'));
    expect(root.all('inv-cam-fov')[0]?.textContent).toBe('FOV 55°');
    c.dispose();
  });
});

describe('CaseFilePanel DOM', () => {
  it('shows the verdict, tab counts, rows and a photo thumbnail', () => {
    const ui = fakeUi();
    const p = new CaseFilePanel(asUi(ui));
    const custody = vi.fn();
    p.open(caseView(), { custody, close: vi.fn() });
    const root = el(p.element);
    expect(root.all('inv-case-title')[0]?.textContent).toBe('C-00001 · Burglary');
    expect(root.all('inv-case-verdict')[0]?.textContent).toBe('Chain intact');
    expect(root.all('inv-tab').map((t) => t.textContent)).toEqual([
      'Items 1', 'Photos 1', 'Prints 0', 'Canvass 0', 'Custody 0', 'Consents 0', 'Statements 0',
    ]);
    expect(root.all('inv-tab inv-on')).toHaveLength(1);
    expect(root.all('inv-tab inv-on')[0]?.textContent).toBe('Items 1');
    const visible = root.all('inv-row').filter((r) => !r.hidden);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.className).toBe('inv-row inv-focus');
    // Items tab: Enter via click performs the next custody step.
    visible[0]?.click();
    expect(custody).toHaveBeenCalledWith('E-1-1', 'collect');
    // Photos tab: the thumbnail is shown.
    p.onKeyDown(key('Tab'));
    const img = root.all('inv-row-thumb')[0];
    expect(img?.hidden).toBe(false);
    expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,AA');
    // Back on the items tab the thumbnail is hidden.
    p.onKeyDown(key('Tab', false));
    p.onKeyDown(key('1'));
    expect(root.all('inv-row-thumb')[0]?.hidden).toBe(true);
    // An empty tab shows the empty line.
    p.onKeyDown(key('3'));
    expect(root.all('inv-empty')[0]?.hidden).toBe(false);
    p.dispose();
  });

  it('marks a broken chain', () => {
    const ui = fakeUi();
    const p = new CaseFilePanel(asUi(ui));
    p.open({ ...caseView(), verdict: 'Chain broken: 1 issue', chainOk: false }, { custody: vi.fn(), close: vi.fn() });
    expect(el(p.element).all('inv-case-verdict inv-bad')).toHaveLength(1);
  });
});

describe('FingerprintPanel DOM', () => {
  const view = (): DustView => ({ surface: 'metal', label: 'fridge', cursor: 5, coverage: new Array<number>(16).fill(0), quality: 0.5, overbrush: 0 });

  it('draws a 4x4 grid with the cursor and a quality bar', () => {
    const ui = fakeUi();
    const p = new FingerprintPanel(asUi(ui));
    const v = view();
    p.open(v, { move: vi.fn(), lift: vi.fn(), cancel: vi.fn() });
    const root = el(p.element);
    const cells = root.all('inv-cell');
    expect(cells).toHaveLength(16);
    expect(cells[5]?.className).toBe('inv-cell inv-cursor');
    expect(cells[0]?.className).toBe('inv-cell');
    expect(root.all('inv-dust-sub')[0]?.textContent).toBe('fridge · metal');
    expect(root.all('inv-quality-fill')[0]?.style.width).toBe('50%');
    // Coverage shows through the cell variable; over 1.0 marks over-brushing.
    v.coverage = v.coverage.map((_, i) => (i === 0 ? 0.5 : i === 1 ? 1.4 : 0));
    v.cursor = 1;
    v.quality = 0.2;
    p.update(v);
    expect(cells[0]?.props['--cov']).toBe('0.5');
    expect(cells[1]?.props['--cov']).toBe('1');
    expect(cells[1]?.className).toBe('inv-cell inv-over inv-cursor');
    expect(root.all('inv-quality-fill inv-low')).toHaveLength(1);
    p.dispose();
  });
});

describe('MarkerLabels DOM', () => {
  it('pools label elements, positions them and hides the unused', () => {
    const parent = new FakeEl();
    const labels = new MarkerLabels(parent as unknown as HTMLElement);
    labels.update([{ x: 10.4, y: 20.6, text: '1' }, { x: 30, y: 40, text: '2' }]);
    const root = parent.children[0];
    expect(root?.className).toBe('inv-labels');
    expect(root?.children).toHaveLength(2);
    expect(root?.children[0]?.textContent).toBe('1');
    expect(root?.children[0]?.style.left).toBe('10px');
    expect(root?.children[0]?.style.top).toBe('21px');
    expect(root?.children[1]?.hidden).toBe(false);
    labels.update([{ x: 1, y: 2, text: '7' }]);
    expect(root?.children).toHaveLength(2);
    expect(root?.children[1]?.hidden).toBe(true);
    expect(root?.children[0]?.textContent).toBe('7');
    labels.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
