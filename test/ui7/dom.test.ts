import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOfficerLoadout, validateVehicleLoadout, officerPreset } from '../../src/gear';
import type { VehicleLoadout } from '../../src/gear';
import { DEFAULT_LIVERIES, defaultLivery, type LiveryDoc } from '../../src/livery';
import { defaultCharacter } from '../../src/uniform';
import { CharacterCreator, type CreatorHost } from '../../src/ui/character';
import { LiveryEditor, type LiveryEditorHost } from '../../src/ui/livery';
import type { UIRoot } from '../../src/ui/ui';
import { vehicleModel } from '../../src/vehicles/model';
import { FakeElement, fakeUi, findAll, findButton, installFakeDom } from './fakeDom';

let undo: () => void = () => undefined;
beforeAll(() => {
  undo = installFakeDom();
});
afterAll(() => undo());

function liveryHost(modelId = 'patrol_sedan') {
  const model = vehicleModel(modelId);
  const calls = { preview: 0, saved: [] as LiveryDoc[], cancelled: 0, orbit: [] as number[][], siren: [] as string[] };
  const host: LiveryEditorHost = {
    unitId: 'P-101', unitNumber: '101', dept: 'City Police', model, fleetClass: 'patrol', capacity: model.cargo,
    library: () => DEFAULT_LIVERIES,
    validateLoadout: (l: VehicleLoadout) => validateVehicleLoadout(l, model.cargo, 'patrol'),
    preview: () => {
      calls.preview++;
    },
    save: (d) => calls.saved.push(d),
    cancel: () => {
      calls.cancelled++;
    },
    sirenPreview: (t) => calls.siren.push(t),
    orbit: (a, b, c) => calls.orbit.push([a, b, c]),
  };
  return { host, calls };
}

describe('LiveryEditor DOM', () => {
  it('builds the panel, switches every tab and saves', () => {
    const ui = fakeUi();
    const { host, calls } = liveryHost();
    const editor = new LiveryEditor(ui as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    const root = editor.element as unknown as FakeElement;
    expect(root.className).toBe('livery-root');
    editor.open();
    expect(ui.isOpen(editor)).toBe(true);
    for (const tab of ['Paint', 'Decals', 'Lights', 'Equipment', 'Loadout', 'Library', 'Paint']) {
      findButton(root, tab).click();
      expect(findAll(root, (e) => e.className === 'livery-body')[0]?.children.length).toBeGreaterThan(0);
    }
    expect(calls.preview).toBeGreaterThanOrEqual(1);
    findButton(root, 'Save').click();
    expect(calls.saved).toHaveLength(1);
    expect(ui.isOpen(editor)).toBe(false);
  });

  it('adds, moves and deletes decals through the buttons and edits a field', () => {
    const { host } = liveryHost();
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    const root = editor.element as unknown as FakeElement;
    findButton(root, 'Decals').click();
    const before = editor.state.doc.layers.length;
    findButton(root, '+ Stripe').click();
    expect(editor.state.doc.layers).toHaveLength(before + 1);
    expect(editor.state.selected).toBe(before);
    findButton(root, '+ Text').click();
    findButton(root, '+ Shape').click();
    findButton(root, '+ Checker').click();
    expect(editor.state.doc.layers).toHaveLength(before + 4);
    // A slider moves the selected layer's field and reports an accepted change.
    const sliders = findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'range');
    expect(sliders.length).toBeGreaterThan(2);
    sliders[0]?.fire('input', { target: { value: '0.6' } });
    expect(editor.state.errors).toEqual([]);
    findButton(root, 'Delete').click();
    expect(editor.state.doc.layers).toHaveLength(before + 3);
    // Moving the first layer down swaps it with the second.
    const first = editor.state.doc.layers[0];
    findAll(root, (e) => e.tagName === 'button' && e.textContent === '↓')[0]?.click();
    expect(editor.state.doc.layers[1]).toEqual(first);
  });

  it('shows the polygon pad for a polygon shape and edits the points', () => {
    const { host } = liveryHost();
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    const root = editor.element as unknown as FakeElement;
    findButton(root, 'Decals').click();
    findButton(root, '+ Shape').click();
    editor.dispatch({ kind: 'updateLayer', index: editor.state.selected, patch: { shape: 'polygon' } });
    const pad = findAll(root, (e) => e.tagName === 'canvas' && e.className === 'livery-pad')[0];
    expect(pad).toBeDefined();
    pad?.fire('pointerdown', { button: 0, clientX: 100, clientY: 180, pointerId: 1 });
    pad?.fire('pointerup');
    const layer = editor.state.doc.layers[editor.state.selected];
    expect(layer?.type === 'shape' && layer.points?.length).toBe(5);
  });

  it('disables the equipment the model lacks, with a hint', () => {
    const { host } = liveryHost('police_motorcycle');
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('motorMarked'));
    const root = editor.element as unknown as FakeElement;
    findButton(root, 'Equipment').click();
    const boxes = findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'checkbox');
    expect(boxes).toHaveLength(3);
    expect(boxes.every((b) => b.disabled)).toBe(true);
    expect(findAll(root, (e) => e.className === 'livery-hint').length).toBe(3);
  });

  it('exports through a temporary link and revokes the URL', () => {
    const { host } = liveryHost();
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    const urls: string[] = [];
    const revoked: string[] = [];
    const g = globalThis as unknown as { URL: { createObjectURL?: unknown; revokeObjectURL?: unknown } };
    const saved = { c: g.URL.createObjectURL, r: g.URL.revokeObjectURL };
    g.URL.createObjectURL = (b: unknown): string => {
      expect((b as Blob).type).toBe('application/json');
      urls.push('blob:x');
      return 'blob:x';
    };
    g.URL.revokeObjectURL = (u: string): void => void revoked.push(u);
    try {
      const root = editor.element as unknown as FakeElement;
      findButton(root, 'Library').click();
      findButton(root, 'Export').click();
    } finally {
      g.URL.createObjectURL = saved.c;
      g.URL.revokeObjectURL = saved.r;
    }
    expect(urls).toEqual(['blob:x']);
    expect(revoked).toEqual(['blob:x']);
  });

  it('orbits with a drag and the wheel, and Escape cancels', () => {
    const { host, calls } = liveryHost();
    const ui = fakeUi();
    const editor = new LiveryEditor(ui as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    editor.open();
    const orbit = findAll(editor.element as unknown as FakeElement, (e) => e.className === 'livery-orbit')[0];
    orbit?.fire('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
    orbit?.fire('pointermove', { clientX: 60, clientY: 30 });
    orbit?.fire('pointerup');
    orbit?.fire('pointermove', { clientX: 90, clientY: 90 });
    orbit?.fire('wheel', { deltaY: 100 });
    expect(calls.orbit).toHaveLength(2);
    expect(calls.orbit[0]?.[0]).toBeCloseTo(0.4, 6);
    expect(calls.orbit[1]).toEqual([0, 0, expect.closeTo(0.1, 6)]);
    expect(editor.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(calls.cancelled).toBe(1);
    expect(ui.isOpen(editor)).toBe(false);
  });

  it('lists errors and disables Save after a rejected change', () => {
    const { host } = liveryHost();
    const editor = new LiveryEditor(fakeUi() as unknown as UIRoot, host, defaultLivery('patrolMarked'));
    const root = editor.element as unknown as FakeElement;
    const name = findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'text')[0];
    name?.fire('input', { target: { value: '' } });
    const errors = findAll(root, (e) => e.className === 'livery-errors')[0];
    expect(errors?.hidden).toBe(false);
    expect(errors?.textContent).toContain('name');
    expect(findButton(root, 'Save').disabled).toBe(true);
    name?.fire('input', { target: { value: 'Okay' } });
    expect(errors?.hidden).toBe(true);
    expect(findButton(root, 'Save').disabled).toBe(false);
  });
});

function creatorHost(): { host: CreatorHost; done: unknown[]; cancelled: number } {
  const log = { done: [] as unknown[], cancelled: 0 };
  const host: CreatorHost = {
    mode: 'newGame',
    validateGear: (l, extra) => validateOfficerLoadout(l, { extraVestSlots: extra }),
    done: (p, g) => log.done.push([p, g]),
    cancel: () => {
      log.cancelled++;
    },
  };
  return { host, get done() { return log.done; }, get cancelled() { return log.cancelled; } };
}

describe('CharacterCreator DOM', () => {
  const start = (): { profile: ReturnType<typeof defaultCharacter>; gear: ReturnType<typeof officerPreset> } => ({ profile: defaultCharacter(), gear: officerPreset('patrolStandard') });

  it('renders every tab and draws the sketch', () => {
    const rig = creatorHost();
    const c = new CharacterCreator(fakeUi() as unknown as UIRoot, rig.host, start());
    const root = c.element as unknown as FakeElement;
    for (const tab of ['Identity', 'Body', 'Uniform', 'Badge & patch', 'Gear', 'Identity']) {
      findButton(root, tab).click();
      expect(findAll(root, (e) => e.className === 'char-body')[0]?.children.length).toBeGreaterThan(0);
    }
    const sketch = findAll(root, (e) => e.className === 'char-sketch')[0];
    expect(sketch?.ctxCalls.filter((n) => n === 'fillRect').length).toBeGreaterThan(10);
  });

  it('switches pronouns, shows the sample and the custom fields', () => {
    const c = new CharacterCreator(fakeUi() as unknown as UIRoot, creatorHost().host, start());
    const root = c.element as unknown as FakeElement;
    findButton(root, 'she / her').click();
    expect(c.state.profile.pronouns.id).toBe('she');
    expect(findAll(root, (e) => e.className === 'char-sample')[0]?.textContent).toContain('she is down');
    findButton(root, 'custom').click();
    expect(findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'text')).toHaveLength(3 + 5);
  });

  it('typing an invalid name disables Done; fixing it hands the profile over', () => {
    const rig = creatorHost();
    const ui = fakeUi();
    const c = new CharacterCreator(ui as unknown as UIRoot, rig.host, start());
    c.open();
    const root = c.element as unknown as FakeElement;
    const first = findAll(root, (e) => e.tagName === 'input' && e.attrs['type'] === 'text')[0];
    first?.fire('input', { target: { value: '' } });
    expect(findButton(root, 'Done').disabled).toBe(true);
    first?.fire('input', { target: { value: 'Pat' } });
    expect(findButton(root, 'Done').disabled).toBe(false);
    findButton(root, 'Done').click();
    expect(rig.done).toHaveLength(1);
    expect(ui.isOpen(c)).toBe(false);
  });

  it('gear tab: adding and removing items updates the warnings', () => {
    const c = new CharacterCreator(fakeUi() as unknown as UIRoot, creatorHost().host, start());
    const root = c.element as unknown as FakeElement;
    findButton(root, 'Gear').click();
    expect(findAll(root, (e) => e.className.includes('livery-msg-error'))).toHaveLength(0);
    c.dispatch({ kind: 'setItem', id: 'ballisticVest', count: 0 });
    expect(findAll(root, (e) => e.className.includes('livery-msg-error')).length).toBeGreaterThan(0);
    expect(c.canDone).toBe(true);
  });

  it('badge and patch tab draws both emblems and shows the polygon pad for a polygon badge', () => {
    const c = new CharacterCreator(fakeUi() as unknown as UIRoot, creatorHost().host, start());
    const root = c.element as unknown as FakeElement;
    findButton(root, 'Badge & patch').click();
    const emblems = findAll(root, (e) => e.className === 'char-emblem');
    expect(emblems).toHaveLength(2);
    expect(emblems.every((e) => e.ctxCalls.includes('fill'))).toBe(true);
    c.dispatch({ kind: 'setBadge', patch: { shape: 'polygon' } });
    expect(findAll(root, (e) => e.className === 'livery-pad')).toHaveLength(1);
  });

  it('Cancel calls the host once', () => {
    const rig = creatorHost();
    const c = new CharacterCreator(fakeUi() as unknown as UIRoot, rig.host, start());
    c.open();
    findButton(c.element as unknown as FakeElement, 'Cancel').click();
    expect(rig.cancelled).toBe(1);
  });
});
