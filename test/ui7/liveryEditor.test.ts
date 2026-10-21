import { describe, expect, it } from 'vitest';
import { validateVehicleLoadout } from '../../src/gear';
import type { LoadoutValidation, VehicleLoadout } from '../../src/gear';
import { DEFAULT_LIVERIES, canonicalLivery, defaultLivery, exportLivery, parseLivery } from '../../src/livery';
import type { LiveryDoc } from '../../src/livery';
import { vehicleModel } from '../../src/vehicles/model';
import {
  LAYER_NUMBER_FIELDS,
  LiveryEditor,
  PAD_MAX_POINTS,
  PolygonPad,
  Throttle,
  addPoint,
  createEditorState,
  createOrbit,
  defaultLoadoutFor,
  documentToSave,
  duplicateDocument,
  editorCanSave,
  editorReducer,
  equipmentAvailability,
  layerLabel,
  liveryPreviewPose,
  loadoutView,
  movePoint,
  newLayer,
  orbitBy,
  padToUnit,
  pickPoint,
  removePoint,
  unitToPad,
  withRacked,
  withTrunkCount,
  type EditorState,
  type LiveryEditorHost,
  type PreviewPose,
} from '../../src/ui/livery';

const patrol = defaultLivery('patrolMarked');

function fresh(doc: LiveryDoc = patrol): EditorState {
  return createEditorState(doc);
}

function host(modelId = 'patrol_sedan', over: Partial<LiveryEditorHost> = {}): { host: LiveryEditorHost; calls: { preview: LiveryDoc[]; save: LiveryDoc[]; cancel: number; orbit: number[][]; siren: string[] } } {
  const model = vehicleModel(modelId);
  const calls = { preview: [] as LiveryDoc[], save: [] as LiveryDoc[], cancel: 0, orbit: [] as number[][], siren: [] as string[] };
  const h: LiveryEditorHost = {
    unitId: 'P-101',
    unitNumber: '101',
    dept: 'City Police',
    model,
    fleetClass: 'patrol',
    capacity: model.cargo,
    library: () => DEFAULT_LIVERIES,
    validateLoadout: (l: VehicleLoadout) => validateVehicleLoadout(l, model.cargo, 'patrol'),
    preview: (d) => calls.preview.push(d),
    save: (d) => calls.save.push(d),
    cancel: () => {
      calls.cancel++;
    },
    sirenPreview: (t) => calls.siren.push(t),
    orbit: (a, b, c) => calls.orbit.push([a, b, c]),
    ...over,
  };
  return { host: h, calls };
}

describe('editor reducer: layers', () => {
  it('adds layers of every type, selecting the new one', () => {
    let s = fresh();
    const n = s.doc.layers.length;
    for (const type of ['stripe', 'shape', 'text', 'checker'] as const) {
      s = editorReducer(s, { kind: 'addLayer', layer: type });
      expect(s.errors).toEqual([]);
      expect(s.doc.layers.at(-1)?.type).toBe(type);
      expect(s.selected).toBe(s.doc.layers.length - 1);
    }
    expect(s.doc.layers).toHaveLength(n + 4);
    expect(s.dirty).toBe(true);
  });

  it('newLayer gives valid defaults for every type', () => {
    for (const type of ['stripe', 'shape', 'text', 'checker'] as const) {
      const doc = { ...canonicalLivery(patrol), layers: [newLayer(type)] };
      expect(parseLivery(doc).ok).toBe(true);
    }
    expect(newLayer('text')).toMatchObject({ type: 'text', text: 'POLICE', face: 'sides' });
    expect(newLayer('shape')).toMatchObject({ shape: 'star', starPoints: 5 });
    expect(newLayer('stripe')).not.toBe(newLayer('stripe'));
  });

  it('moves layers up and down and follows the selection; edges are no-ops', () => {
    let s = fresh();
    const first = s.doc.layers[0];
    s = editorReducer(s, { kind: 'select', index: 0 });
    const moved = editorReducer(s, { kind: 'moveLayer', index: 0, dir: 1 });
    expect(moved.doc.layers[1]).toEqual(first);
    expect(moved.selected).toBe(1);
    expect(editorReducer(s, { kind: 'moveLayer', index: 0, dir: -1 })).toBe(s);
    const last = s.doc.layers.length - 1;
    expect(editorReducer(s, { kind: 'moveLayer', index: last, dir: 1 })).toBe(s);
  });

  it('deletes a layer and keeps the selection in range', () => {
    let s = fresh();
    const n = s.doc.layers.length;
    s = editorReducer(s, { kind: 'select', index: n - 1 });
    s = editorReducer(s, { kind: 'removeLayer', index: n - 1 });
    expect(s.doc.layers).toHaveLength(n - 1);
    expect(s.selected).toBe(n - 2);
    expect(editorReducer(s, { kind: 'removeLayer', index: 99 })).toBe(s);
    for (let i = 0; i < n; i++) s = editorReducer(s, { kind: 'removeLayer', index: 0 });
    expect(s.doc.layers).toEqual([]);
    expect(s.selected).toBe(-1);
  });

  it('updates a layer without touching the previous state', () => {
    const s = fresh();
    const before = JSON.stringify(s.doc);
    const next = editorReducer(s, { kind: 'updateLayer', index: 0, patch: { color: '#FF0000', reflective: false } });
    expect(next.errors).toEqual([]);
    expect(next.doc.layers[0]).toMatchObject({ color: '#ff0000', reflective: false });
    expect(JSON.stringify(s.doc)).toBe(before);
    expect(editorReducer(s, { kind: 'updateLayer', index: 99, patch: { color: '#000000' } })).toBe(s);
  });

  it('keeps shape-only keys in step with the shape kind', () => {
    let s = fresh();
    s = editorReducer(s, { kind: 'addLayer', layer: 'shape' });
    const i = s.doc.layers.length - 1;
    s = editorReducer(s, { kind: 'updateLayer', index: i, patch: { shape: 'polygon' } });
    expect(s.errors).toEqual([]);
    const poly = s.doc.layers[i];
    expect(poly?.type === 'shape' && poly.points?.length).toBeGreaterThanOrEqual(3);
    expect(poly?.type === 'shape' && poly.starPoints).toBeUndefined();
    s = editorReducer(s, { kind: 'updateLayer', index: i, patch: { shape: 'circle' } });
    expect(s.errors).toEqual([]);
    expect(s.doc.layers[i]).not.toHaveProperty('points');
    s = editorReducer(s, { kind: 'updateLayer', index: i, patch: { shape: 'star', starPoints: 7 } });
    expect(s.doc.layers[i]).toMatchObject({ shape: 'star', starPoints: 7 });
  });

  it('drags the other end of a stripe along instead of failing', () => {
    const s = fresh();
    const i = s.doc.layers.findIndex((l) => l.type === 'stripe');
    const next = editorReducer(s, { kind: 'updateLayer', index: i, patch: { u0: 0.99 } });
    expect(next.errors).toEqual([]);
    const stripe = next.doc.layers[i];
    expect(stripe?.type === 'stripe' && stripe.u1).toBe(1);
  });

  it('sets base, wrap, lights, equipment, loadout and name', () => {
    let s = fresh();
    s = editorReducer(s, { kind: 'setBase', color: '#112233', finish: 'matte' });
    expect(s.doc.base).toEqual({ color: '#112233', finish: 'matte' });
    s = editorReducer(s, { kind: 'setWrap', wrap: { kind: 'twoTone', colors: ['#111111', '#eeeeee'], split: 0.4 } });
    expect(s.doc.wrap?.kind).toBe('twoTone');
    s = editorReducer(s, { kind: 'setWrap', wrap: null });
    expect(s.doc.wrap).toBeNull();
    s = editorReducer(s, { kind: 'setLights', patch: { style: 'hidden', siren: 'hilo' } });
    expect(s.doc.lights).toMatchObject({ style: 'hidden', siren: 'hilo', pattern: 'alternate' });
    s = editorReducer(s, { kind: 'setEquipment', patch: { pushBar: false } });
    expect(s.doc.equipment).toEqual({ pushBar: false, spotlight: true, partition: true });
    s = editorReducer(s, { kind: 'setLoadout', loadout: { trunk: { firstAid: 2 }, rack: ['shotgun'] } });
    expect(s.doc.loadout).toEqual({ trunk: { firstAid: 2 }, rack: ['shotgun'] });
    s = editorReducer(s, { kind: 'setLoadout', loadout: null });
    expect(s.doc.loadout).toBeNull();
    s = editorReducer(s, { kind: 'rename', name: 'Night shift' });
    expect(s.doc.name).toBe('Night shift');
    expect(s.errors).toEqual([]);
  });

  it('tab and select do not mark the draft dirty', () => {
    const s = fresh();
    expect(editorReducer(s, { kind: 'tab', tab: 'lights' })).toMatchObject({ tab: 'lights', dirty: false });
    expect(editorReducer(s, { kind: 'select', index: 99 }).selected).toBe(s.doc.layers.length - 1);
    expect(editorReducer(s, { kind: 'tab', tab: 'paint' })).toBe(s);
  });
});

describe('editor reducer: validation', () => {
  it('keeps the previous document and reports the path of an invalid update', () => {
    const s = fresh();
    const bad = editorReducer(s, { kind: 'updateLayer', index: 0, patch: { u0: 0.9, u1: 0.5 } });
    expect(bad.doc).toBe(s.doc);
    expect(bad.errors.some((e) => e.startsWith('layers[0].u1'))).toBe(true);
    expect(editorCanSave(bad)).toBe(false);
    const ok = editorReducer(bad, { kind: 'updateLayer', index: 0, patch: { u0: 0.1, u1: 0.9 } });
    expect(ok.errors).toEqual([]);
    expect(editorCanSave(ok)).toBe(true);
  });

  it('rejects a bad colour, a long text, a bad name and a 33rd layer', () => {
    let s = fresh();
    const textIndex = s.doc.layers.findIndex((l) => l.type === 'text');
    const color = editorReducer(s, { kind: 'updateLayer', index: 0, patch: { color: 'red' } });
    expect(color.errors[0]).toContain('layers[0].color');
    const text = editorReducer(s, { kind: 'updateLayer', index: textIndex, patch: { text: 'x'.repeat(25) } });
    expect(text.errors[0]).toContain(`layers[${String(textIndex)}].text`);
    const name = editorReducer(s, { kind: 'rename', name: '' });
    expect(name.errors[0]).toContain('name');
    expect(name.doc).toBe(s.doc);
    while (s.doc.layers.length < 32) s = editorReducer(s, { kind: 'addLayer', layer: 'stripe' });
    const full = editorReducer(s, { kind: 'addLayer', layer: 'stripe' });
    expect(full.doc.layers).toHaveLength(32);
    expect(full.errors[0]).toContain('layers');
  });

  it('every slider range keeps the document valid at both ends', () => {
    for (const type of ['stripe', 'shape', 'text', 'checker'] as const) {
      for (const spec of LAYER_NUMBER_FIELDS[type]) {
        for (const value of [spec.min, spec.max]) {
          let s = createEditorState({ ...canonicalLivery(patrol), layers: [newLayer(type)] });
          s = editorReducer(s, { kind: 'updateLayer', index: 0, patch: { [spec.key]: value } });
          expect(s.errors, `${type}.${spec.key}=${String(value)}`).toEqual([]);
        }
      }
    }
  });
});

describe('editor reducer: import, export and load', () => {
  it('exports and imports every default into an equal document', () => {
    for (const d of DEFAULT_LIVERIES) {
      const s = editorReducer(fresh(), { kind: 'import', text: exportLivery(d) });
      expect(s.errors, d.id).toEqual([]);
      expect(s.doc).toEqual(canonicalLivery(d));
    }
  });

  it('reports errors for junk and keeps the document', () => {
    const s = fresh();
    const junk = editorReducer(s, { kind: 'import', text: 'not json {' });
    expect(junk.doc).toBe(s.doc);
    expect(junk.errors).toEqual(['file: not valid JSON']);
    const wrong = editorReducer(s, { kind: 'import', text: JSON.stringify({ format: 'nope' }) });
    expect(wrong.errors.length).toBeGreaterThan(0);
    expect(wrong.doc).toBe(s.doc);
    const big = editorReducer(s, { kind: 'import', text: ' '.repeat(70000) });
    expect(big.errors).toEqual(['file: larger than 64 KiB']);
  });

  it('loads a library entry and rejects an invalid document', () => {
    const s = fresh();
    const other = defaultLivery('trafficMarked');
    const loaded = editorReducer(s, { kind: 'load', doc: other });
    expect(loaded.doc).toEqual(canonicalLivery(other));
    expect(loaded.dirty).toBe(true);
    const bad = editorReducer(s, { kind: 'load', doc: { ...other, id: 'bad id!' } });
    expect(bad.doc).toBe(s.doc);
    expect(bad.errors[0]).toContain('id');
  });

  it('saves a default livery under a new id and keeps a custom id', () => {
    const copy = documentToSave(patrol, ['mine']);
    expect(copy.id).not.toBe(patrol.id);
    expect(DEFAULT_LIVERIES.some((d) => d.id === copy.id)).toBe(false);
    expect(parseLivery(copy).ok).toBe(true);
    const custom = { ...canonicalLivery(patrol), id: 'mine' };
    expect(documentToSave(custom, ['mine'])).toBe(custom);
    const dup = duplicateDocument(custom, ['mine']);
    expect(dup.id).toBe('mine-2');
    expect(dup.name).toBe(`${custom.name} copy`);
  });

  it('labels layers for the list', () => {
    expect(layerLabel(newLayer('text'))).toContain('"POLICE"');
    expect(layerLabel(newLayer('shape'))).toContain('star');
    expect(layerLabel(newLayer('stripe'))).toContain('Stripe');
    expect(layerLabel(newLayer('checker'))).toContain('Checker');
  });
});

describe('equipment availability per model', () => {
  it('enables the parts the model has', () => {
    expect(equipmentAvailability(vehicleModel('patrol_sedan'))).toMatchObject({
      pushBar: { enabled: true, hint: '' },
      spotlight: { enabled: true },
      partition: { enabled: true },
    });
    const unmarked = equipmentAvailability(vehicleModel('unmarked_sedan'));
    expect(unmarked.pushBar.enabled).toBe(false);
    expect(unmarked.pushBar.hint).toContain('push');
    expect(unmarked.partition.enabled).toBe(true);
    const van = equipmentAvailability(vehicleModel('prisoner_van'));
    expect([van.pushBar.enabled, van.spotlight.enabled, van.partition.enabled]).toEqual([false, false, true]);
  });

  it('disables everything on a motorcycle, a bicycle and a drone', () => {
    for (const id of ['police_motorcycle', 'police_bicycle', 'police_drone']) {
      const a = equipmentAvailability(vehicleModel(id));
      for (const part of [a.pushBar, a.spotlight, a.partition]) {
        expect(part.enabled, id).toBe(false);
        expect(part.hint).not.toBe('');
      }
    }
    expect(equipmentAvailability(vehicleModel('patrol_boat')).spotlight.enabled).toBe(true);
  });
});

describe('loadout tab', () => {
  it('shows the default loadout, then an edited one', () => {
    const { host: h } = host();
    const editor = new LiveryEditor(null, h, patrol);
    const view = editor.loadout;
    expect(view.isDefault).toBe(true);
    expect(view.loadout).toEqual(defaultLoadoutFor(h.model));
    expect(view.rows.find((r) => r.id === 'flares')?.count).toBeGreaterThan(0);
    expect(view.weight.cap).toBe(h.model.cargo.kg);
    expect(view.rack.filter((r) => r.checked).length).toBeLessThanOrEqual(h.model.cargo.rackSlots);
    editor.dispatch({ kind: 'setLoadout', loadout: withTrunkCount(view.loadout, 'flares', 3) });
    const edited = editor.loadout;
    expect(edited.isDefault).toBe(false);
    expect(edited.rows.find((r) => r.id === 'flares')?.count).toBe(3);
    editor.dispatch({ kind: 'setLoadout', loadout: null });
    expect(editor.loadout.isDefault).toBe(true);
  });

  it('surfaces the host validation messages and blocks Save on errors', () => {
    const bad: LoadoutValidation = {
      ok: false,
      errors: [{ code: 'cargoWeight', item: null, message: 'Trunk is too heavy: 180 / 150 kg' }],
      warnings: [{ code: 'cargoSlots', item: null, message: 'Trunk is nearly full' }],
      weightKg: 180,
      capacityKg: 150,
      slots: { belt: { used: 0, cap: 0 }, vest: { used: 0, cap: 0 }, body: { used: 0, cap: 0 }, longGun: { used: 1, cap: 2 }, carry: { used: 28, cap: 30 } },
    };
    const { host: h } = host('patrol_sedan', { validateLoadout: () => bad });
    const editor = new LiveryEditor(null, h, patrol);
    const view = editor.loadout;
    expect(view.errors).toEqual(['Trunk is too heavy: 180 / 150 kg']);
    expect(view.warnings).toEqual(['Trunk is nearly full']);
    expect(view.weight).toMatchObject({ used: 180, cap: 150, over: true, fraction: 1 });
    expect(view.slots).toMatchObject({ used: 28, cap: 30, over: false });
    expect(view.rackSlots).toMatchObject({ used: 1, cap: 2 });
    expect(view.ok).toBe(false);
    // The default loadout needs no check; an own invalid one blocks Save.
    expect(editor.canSave).toBe(true);
    editor.dispatch({ kind: 'setLoadout', loadout: { trunk: { flares: 1 }, rack: [] } });
    expect(editor.canSave).toBe(false);
    expect(editor.save()).toBe(false);
  });

  it('counts and rack boxes respect their limits', () => {
    const l: VehicleLoadout = { trunk: { flares: 2 }, rack: ['shotgun'] };
    expect(withTrunkCount(l, 'flares', 0).trunk).toEqual({});
    expect(withTrunkCount(l, 'flares', 500).trunk.flares).toBe(99);
    expect(withTrunkCount(l, 'cone', -3).trunk).toEqual({ flares: 2 });
    expect(withTrunkCount(l, 'cone', Number.NaN).trunk).toEqual({ flares: 2 });
    expect(withRacked(l, 'rifle', true, 1).rack).toEqual(['shotgun']);
    expect(withRacked(l, 'rifle', true, 2).rack).toEqual(['shotgun', 'rifle']);
    expect(withRacked(l, 'shotgun', false, 2).rack).toEqual([]);
    const model = vehicleModel('patrol_sedan');
    const view = loadoutView({ trunk: {}, rack: ['shotgun', 'rifle'] }, validateVehicleLoadout({ trunk: {}, rack: ['shotgun', 'rifle'] }, model.cargo, 'patrol'), model.cargo, false);
    expect(view.rack.find((r) => r.id === 'lessLethal')).toMatchObject({ checked: false, enabled: false });
  });
});

describe('LiveryEditor (headless)', () => {
  it('constructs, previews on open and on every accepted change', () => {
    const { host: h, calls } = host();
    const editor = new LiveryEditor(null, h, patrol);
    expect(editor.id).toBe('livery-editor');
    expect(editor.pausesGame).toBe(true);
    expect(editor.element).toBeDefined();
    editor.open();
    expect(calls.preview).toHaveLength(1);
    editor.dispatch({ kind: 'setBase', color: '#ff00ff' });
    expect(editor.state.doc.base.color).toBe('#ff00ff');
    expect(calls.preview.length).toBeGreaterThanOrEqual(1);
    editor.dispose();
  });

  it('saves a default under a new id, then closes; cancel restores', () => {
    const { host: h, calls } = host();
    const editor = new LiveryEditor(null, h, patrol);
    editor.dispatch({ kind: 'rename', name: 'Night shift' });
    expect(editor.save()).toBe(true);
    expect(calls.save).toHaveLength(1);
    expect(calls.save[0]?.id).toBe('Night-shift');
    expect(calls.save[0]?.name).toBe('Night shift');
    editor.cancel();
    expect(calls.cancel).toBe(1);
  });

  it('refuses to save while a change is rejected', () => {
    const { host: h, calls } = host();
    const editor = new LiveryEditor(null, h, patrol);
    editor.dispatch({ kind: 'rename', name: '' });
    expect(editor.canSave).toBe(false);
    expect(editor.save()).toBe(false);
    expect(calls.save).toEqual([]);
  });

  it('exports text that imports back to an equal draft, and renames an imported id already in the library', () => {
    const { host: h } = host();
    const editor = new LiveryEditor(null, h, patrol);
    const text = editor.exportText();
    expect(text).toBe(exportLivery(editor.state.doc));
    editor.dispatch({ kind: 'setBase', color: '#123456' });
    const next = editor.importText(text);
    expect(next.errors).toEqual([]);
    expect(next.doc.base.color).toBe(patrol.base.color);
    // patrolMarked is in the (default) library, so the imported draft got a free id.
    expect(next.doc.id).not.toBe('patrolMarked');
    expect(parseLivery(next.doc).ok).toBe(true);
    expect(editor.importText('junk').errors).toEqual(['file: not valid JSON']);
  });

  it('Escape cancels once open', () => {
    const { host: h, calls } = host();
    const editor = new LiveryEditor(null, h, patrol);
    expect(editor.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(false);
    editor.open();
    expect(editor.onKeyDown({ key: 'Enter' } as KeyboardEvent)).toBe(false);
    expect(editor.onKeyDown({ key: 'Escape' } as KeyboardEvent)).toBe(true);
    expect(calls.cancel).toBe(1);
    expect(editor.isOpen).toBe(false);
  });
});

describe('preview throttle', () => {
  function rig(): { t: Throttle<number>; fired: number[]; advance: (ms: number) => void } {
    let now = 1000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const fired: number[] = [];
    const t = new Throttle<number>((v) => fired.push(v), 100, () => now, {
      set: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clear: (h) => {
        const i = timers.findIndex((x) => x.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    return {
      t,
      fired,
      advance(ms) {
        now += ms;
        for (const timer of timers.filter((x) => x.at <= now)) {
          timers.splice(timers.indexOf(timer), 1);
          timer.fn();
        }
      },
    };
  }

  it('fires the first value at once and the last of a burst after 100 ms', () => {
    const { t, fired, advance } = rig();
    t.push(1);
    t.push(2);
    t.push(3);
    expect(fired).toEqual([1]);
    advance(99);
    expect(fired).toEqual([1]);
    advance(1);
    expect(fired).toEqual([1, 3]);
    advance(500);
    t.push(4);
    expect(fired).toEqual([1, 3, 4]);
  });

  it('flush fires the pending value and cancel drops it', () => {
    const { t, fired, advance } = rig();
    t.push(1);
    t.push(2);
    t.flush();
    expect(fired).toEqual([1, 2]);
    advance(200);
    t.push(3);
    t.push(4);
    t.cancel();
    advance(1000);
    expect(fired).toEqual([1, 2, 3]);
  });
});

describe('polygon pad maths', () => {
  it('maps pixels to [-1, 1] and back', () => {
    expect(padToUnit(0, 0)).toEqual([-1, -1]);
    expect(padToUnit(100, 100)).toEqual([0, 0]);
    expect(padToUnit(200, 200)).toEqual([1, 1]);
    expect(padToUnit(-50, 400)).toEqual([-1, 1]);
    expect(unitToPad([0, 0])).toEqual([100, 100]);
    expect(unitToPad(padToUnit(50, 150))).toEqual([50, 150]);
  });

  it('adds up to 24 points', () => {
    let pts: [number, number][] = [];
    for (let i = 0; i < 30; i++) pts = addPoint(pts, [i / 40, 0]);
    expect(pts).toHaveLength(PAD_MAX_POINTS);
    expect(PAD_MAX_POINTS).toBe(24);
    const before = [[0, 0]] as [number, number][];
    expect(addPoint(before, [1, 1])).not.toBe(before);
    expect(before).toHaveLength(1);
  });

  it('picks the nearest point within the radius, moves and deletes', () => {
    const pts: [number, number][] = [[-0.5, -0.5], [0.5, 0.5], [0, 0.9]];
    expect(pickPoint(pts, 50, 50)).toBe(0);
    expect(pickPoint(pts, 153, 148)).toBe(1);
    expect(pickPoint(pts, 100, 100)).toBe(-1);
    expect(movePoint(pts, 2, [0, 0])[2]).toEqual([0, 0]);
    expect(movePoint(pts, 9, [0, 0])).toEqual(pts);
    expect(removePoint(pts, 1)).toHaveLength(2);
    expect(removePoint(pts, 1, 3)).toHaveLength(3);
    expect(removePoint(pts, -1)).toHaveLength(3);
  });

  it('PolygonPad adds on click, drags, and deletes on right-click (headless pointer logic)', () => {
    const seen: [number, number][][] = [];
    const pad = new PolygonPad({ points: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]], minPoints: 3, onChange: (p) => seen.push(p) });
    // Click an empty spot: a point is added and dragged; the change is emitted on release.
    pad.down(100, 190, 0);
    pad.move(100, 180);
    expect(seen).toHaveLength(0);
    pad.up();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(4);
    expect(seen[0]?.[3]).toEqual([0, 0.8]);
    // Drag an existing point.
    pad.down(50, 50, 0);
    pad.move(20, 20);
    pad.up();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.[0]).toEqual([-0.8, -0.8]);
    // A click on a point without moving it emits nothing.
    pad.down(150, 50, 0);
    pad.up();
    expect(seen).toHaveLength(2);
    // Right-click deletes, but never below the minimum.
    pad.down(180, 50, 2);
    expect(seen).toHaveLength(2);
    pad.down(100, 180, 2);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toHaveLength(3);
    pad.down(20, 20, 2);
    expect(seen).toHaveLength(3);
  });
});

describe('preview pose', () => {
  const dims = { length: 4.8, width: 1.9, height: 1.5 };
  const target = { x: 10, y: 0, z: -5, yaw: 0 };
  const out: PreviewPose = { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0 };

  it('looks at the middle of the body from behind at yaw 0 and level pitch', () => {
    liveryPreviewPose(target, dims, 0, 0, 1, out);
    expect(out.lookX).toBe(10);
    expect(out.lookZ).toBe(-5);
    expect(out.lookY).toBeGreaterThan(0.5);
    expect(out.y).toBeCloseTo(out.lookY, 6);
    expect(out.x).toBeCloseTo(10, 6);
    expect(out.z).toBeGreaterThan(-5);
  });

  it('keeps the distance proportional to the zoom, and follows the vehicle heading', () => {
    const dist = (p: PreviewPose): number => Math.hypot(p.x - p.lookX, p.y - p.lookY, p.z - p.lookZ);
    const a = { ...liveryPreviewPose(target, dims, 0.7, 0.4, 1, out) };
    const d1 = dist(a);
    const d2 = dist(liveryPreviewPose(target, dims, 0.7, 0.4, 2, out));
    expect(d2).toBeCloseTo(d1 * 2, 6);
    const rotated = liveryPreviewPose({ ...target, yaw: Math.PI / 2 }, dims, 0, 0, 1, out);
    expect(rotated.x).toBeGreaterThan(10);
    expect(Math.abs(rotated.z + 5)).toBeLessThan(1e-6);
    liveryPreviewPose(target, dims, 0, 1, 1, out);
    expect(out.y).toBeGreaterThan(out.lookY);
  });

  it('returns the object it was given and allocates nothing else', () => {
    expect(liveryPreviewPose(target, dims, 1, 0.2, 1, out)).toBe(out);
  });

  it('orbitBy clamps pitch and zoom and wraps the yaw', () => {
    const o = createOrbit();
    orbitBy(o, 0, 10, 10);
    expect(o.pitch).toBeLessThan(1.4);
    expect(o.zoom).toBe(2.5);
    orbitBy(o, 0, -10, -10);
    expect(o.pitch).toBeLessThan(0);
    expect(o.zoom).toBe(0.5);
    orbitBy(o, 7, 0, 0);
    expect(Math.abs(o.yaw)).toBeLessThanOrEqual(Math.PI);
  });
});
