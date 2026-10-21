/**
 * Livery editor state and reducer (Phase 7 §12.1). Pure: every change builds a candidate document and re-validates it
 * with `parseLivery`; an invalid result keeps the previous document and only sets `errors`.
 */
import { DEFAULT_LIVERIES, canonicalLivery, importLivery, newLiveryId, parseLivery } from '../../livery';
import type { LayerType, LiveryDoc, LiveryLayer } from '../../livery';
import type { VehicleModel } from '../../vehicles/model';
import { defaultPolygon } from './polygonPad';
import type { NumberFieldSpec } from './fields';

export type EditorTab = 'paint' | 'decals' | 'lights' | 'equipment' | 'loadout' | 'library';

export const EDITOR_TABS: readonly EditorTab[] = ['paint', 'decals', 'lights', 'equipment', 'loadout', 'library'];

export const EDITOR_TAB_LABELS: Readonly<Record<EditorTab, string>> = {
  paint: 'Paint',
  decals: 'Decals',
  lights: 'Lights',
  equipment: 'Equipment',
  loadout: 'Loadout',
  library: 'Library',
};

export interface EditorState {
  doc: LiveryDoc;
  /** Index of the selected layer, -1 when there is none. */
  selected: number;
  tab: EditorTab;
  /** The draft differs from what the editor opened with. */
  dirty: boolean;
  /** Dotted-path messages of the last rejected change; empty after a valid one. */
  errors: string[];
}

export type EditorAction =
  | { kind: 'setBase'; color?: string; finish?: string }
  | { kind: 'setWrap'; wrap: LiveryDoc['wrap'] }
  | { kind: 'addLayer'; layer: LiveryLayer['type'] }
  | { kind: 'removeLayer'; index: number }
  | { kind: 'moveLayer'; index: number; dir: -1 | 1 }
  | { kind: 'select'; index: number }
  | { kind: 'updateLayer'; index: number; patch: Record<string, unknown> }
  | { kind: 'setLights'; patch: Partial<LiveryDoc['lights']> }
  | { kind: 'setEquipment'; patch: Partial<LiveryDoc['equipment']> }
  | { kind: 'setLoadout'; loadout: LiveryDoc['loadout'] }
  | { kind: 'rename'; name: string }
  | { kind: 'tab'; tab: EditorState['tab'] }
  | { kind: 'load'; doc: LiveryDoc }
  | { kind: 'import'; text: string };

/** The opening state for `doc` (a canonical copy; the first layer selected). */
export function createEditorState(doc: LiveryDoc, tab: EditorTab = 'paint'): EditorState {
  const copy = canonicalLivery(doc);
  return { doc: copy, selected: copy.layers.length > 0 ? 0 : -1, tab, dirty: false, errors: [] };
}

/** A new layer with sensible defaults: a stripe on the sides, "POLICE" text, a star shape or a checker band. */
export function newLayer(type: LiveryLayer['type']): LiveryLayer {
  switch (type) {
    case 'stripe':
      return { type: 'stripe', face: 'sides', u0: 0.04, u1: 0.96, v: 0.55, height: 0.18, angleDeg: 0, color: '#1d3f8f', reflective: false };
    case 'shape':
      return {
        type: 'shape', face: 'sides', shape: 'star', u: 0.2, v: 0.4, w: 0.18, h: 0.5, rotationDeg: 0,
        color: '#c9a646', outline: null, reflective: false, starPoints: 5,
      };
    case 'text':
      return {
        type: 'text', face: 'sides', text: 'POLICE', u: 0.55, v: 0.35, size: 0.3, color: '#1d3f8f', outline: null,
        font: 'sans', weight: 'bold', italic: false, reflective: false,
      };
    case 'checker':
      return { type: 'checker', face: 'sides', v: 0.62, height: 0.12, cells: 24, rows: 2, colors: ['#1d3f8f', '#f2f2f2'], reflective: false };
  }
}

/** Numeric controls of each layer type: slider bounds that always give a valid document. */
export const LAYER_NUMBER_FIELDS: Readonly<Record<LayerType, readonly NumberFieldSpec[]>> = {
  stripe: [
    { key: 'u0', label: 'Start', min: 0, max: 0.99, step: 0.01 },
    { key: 'u1', label: 'End', min: 0.01, max: 1, step: 0.01 },
    { key: 'v', label: 'Height position', min: 0, max: 1, step: 0.01 },
    { key: 'height', label: 'Thickness', min: 0.01, max: 1, step: 0.01 },
    { key: 'angleDeg', label: 'Angle', min: -45, max: 45, step: 1 },
  ],
  shape: [
    { key: 'u', label: 'Position x', min: 0, max: 1, step: 0.01 },
    { key: 'v', label: 'Position y', min: 0, max: 1, step: 0.01 },
    { key: 'w', label: 'Width', min: 0.01, max: 1, step: 0.01 },
    { key: 'h', label: 'Height', min: 0.01, max: 1, step: 0.01 },
    { key: 'rotationDeg', label: 'Rotation', min: -180, max: 180, step: 1 },
  ],
  text: [
    { key: 'u', label: 'Position x', min: 0, max: 1, step: 0.01 },
    { key: 'v', label: 'Position y', min: 0, max: 1, step: 0.01 },
    { key: 'size', label: 'Size', min: 0.05, max: 1, step: 0.01 },
  ],
  checker: [
    { key: 'v', label: 'Height position', min: 0, max: 1, step: 0.01 },
    { key: 'height', label: 'Thickness', min: 0.01, max: 1, step: 0.01 },
    { key: 'cells', label: 'Cells', min: 2, max: 40, step: 1 },
    { key: 'rows', label: 'Rows', min: 1, max: 3, step: 1 },
  ],
};

/** The star-points slider of a `star` shape. */
export const STAR_POINTS_FIELD: NumberFieldSpec = { key: 'starPoints', label: 'Points', min: 3, max: 12, step: 1 };

const LAYER_ICONS: Readonly<Record<LayerType, string>> = { stripe: '▬', shape: '★', text: 'T', checker: '▦' };

/** Row label of a layer in the list: icon, what it is and the face. */
export function layerLabel(layer: LiveryLayer): string {
  const icon = LAYER_ICONS[layer.type];
  switch (layer.type) {
    case 'stripe':
      return `${icon} Stripe · ${layer.face}`;
    case 'shape':
      return `${icon} Shape ${layer.shape} · ${layer.face}`;
    case 'text':
      return `${icon} "${layer.text}" · ${layer.face}`;
    case 'checker':
      return `${icon} Checker · ${layer.face}`;
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** Applies a patch to one layer: `undefined` deletes a key, `type` is ignored, shape-only keys follow the shape. */
function patchLayer(layer: LiveryLayer, patch: Record<string, unknown>): LiveryLayer {
  const next: Record<string, unknown> = { ...(layer as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'type') continue;
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  if (next['type'] === 'shape') {
    if (next['shape'] !== 'star') delete next['starPoints'];
    if (next['shape'] !== 'polygon') delete next['points'];
    else if (next['points'] === undefined) next['points'] = defaultPolygon();
  }
  // A single stripe end moved past the other one drags it along instead of failing (both in one patch is the caller's call).
  if (next['type'] === 'stripe') {
    const hasU0 = 'u0' in patch;
    const hasU1 = 'u1' in patch;
    const u0 = next['u0'];
    const u1 = next['u1'];
    if (typeof u0 === 'number' && typeof u1 === 'number' && u0 >= u1) {
      if (hasU0 && !hasU1) next['u1'] = Math.min(1, u0 + 0.01);
      else if (hasU1 && !hasU0) next['u0'] = Math.max(0, u1 - 0.01);
    }
  }
  return next as unknown as LiveryLayer;
}

function accept(s: EditorState, candidate: unknown, extra: Partial<EditorState> = {}): EditorState {
  const r = parseLivery(candidate);
  if (!r.ok) return { ...s, errors: r.errors };
  const selected = Math.max(-1, Math.min(extra.selected ?? s.selected, r.livery.layers.length - 1));
  return { ...s, ...extra, selected, doc: r.livery, dirty: true, errors: [] };
}

function loaded(s: EditorState, doc: LiveryDoc): EditorState {
  return { ...s, doc, selected: doc.layers.length > 0 ? 0 : -1, dirty: true, errors: [] };
}

/** Pure reducer (see the module comment). An unknown layer index leaves the state unchanged. */
export function editorReducer(s: EditorState, a: EditorAction): EditorState {
  const base = (): LiveryDoc => canonicalLivery(s.doc);
  switch (a.kind) {
    case 'tab':
      return s.tab === a.tab ? s : { ...s, tab: a.tab };
    case 'select': {
      const index = Math.min(Math.max(Math.trunc(a.index), -1), s.doc.layers.length - 1);
      return index === s.selected ? s : { ...s, selected: index };
    }
    case 'setBase': {
      const d = base();
      if (a.color !== undefined) d.base.color = a.color;
      if (a.finish !== undefined) (d.base as { finish: string }).finish = a.finish;
      return accept(s, d);
    }
    case 'setWrap': {
      const d = base();
      d.wrap = a.wrap;
      return accept(s, d);
    }
    case 'addLayer': {
      const d = base();
      d.layers.push(newLayer(a.layer));
      return accept(s, d, { selected: d.layers.length - 1 });
    }
    case 'removeLayer': {
      if (a.index < 0 || a.index >= s.doc.layers.length) return s;
      const d = base();
      d.layers.splice(a.index, 1);
      return accept(s, d, { selected: s.selected > a.index ? s.selected - 1 : s.selected });
    }
    case 'moveLayer': {
      const to = a.index + a.dir;
      if (a.index < 0 || a.index >= s.doc.layers.length || to < 0 || to >= s.doc.layers.length) return s;
      const d = base();
      const [moved] = d.layers.splice(a.index, 1);
      if (!moved) return s;
      d.layers.splice(to, 0, moved);
      return accept(s, d, { selected: s.selected === a.index ? to : s.selected === to ? a.index : s.selected });
    }
    case 'updateLayer': {
      const layer = s.doc.layers[a.index];
      if (!layer) return s;
      const d = base();
      d.layers[a.index] = patchLayer(d.layers[a.index] as LiveryLayer, a.patch);
      return accept(s, d, { selected: a.index });
    }
    case 'setLights':
      return accept(s, { ...base(), lights: { ...s.doc.lights, ...a.patch } });
    case 'setEquipment':
      return accept(s, { ...base(), equipment: { ...s.doc.equipment, ...a.patch } });
    case 'setLoadout':
      return accept(s, { ...base(), loadout: a.loadout === null ? null : clone(a.loadout) });
    case 'rename':
      return accept(s, { ...base(), name: a.name });
    case 'load': {
      const r = parseLivery(a.doc);
      return r.ok ? loaded(s, r.livery) : { ...s, errors: r.errors };
    }
    case 'import': {
      const r = importLivery(a.text);
      return r.ok ? loaded(s, r.livery) : { ...s, errors: r.errors };
    }
  }
}

/** Save is possible while the last change was accepted. */
export function editorCanSave(s: EditorState): boolean {
  return s.errors.length === 0;
}

const DEFAULT_IDS: readonly string[] = DEFAULT_LIVERIES.map((l) => l.id);

/**
 * The document to store on Save: a default livery is never overwritten, it is saved as a new one named after the
 * draft (a free id derived from `taken` and the default ids); any other id keeps its slot in the library.
 */
export function documentToSave(doc: LiveryDoc, taken: readonly string[]): LiveryDoc {
  if (!DEFAULT_IDS.includes(doc.id)) return doc;
  const copy = canonicalLivery(doc);
  copy.id = newLiveryId(doc.name, [...DEFAULT_IDS, ...taken]);
  return copy;
}

/** A copy of `doc` as a new library entry ("Name copy", a free id). */
export function duplicateDocument(doc: LiveryDoc, taken: readonly string[]): LiveryDoc {
  const copy = canonicalLivery(doc);
  copy.id = newLiveryId(doc.id, [...DEFAULT_IDS, ...taken]);
  copy.name = `${doc.name} copy`.slice(0, 40);
  return copy;
}

// --- Equipment ----------------------------------------------------------------------------------

export interface EquipmentOption {
  enabled: boolean;
  /** Why it is disabled; '' when enabled. */
  hint: string;
}

/** Which equipment checkboxes the model can take (push bumper, spotlight and partition mounts). */
export function equipmentAvailability(model: VehicleModel): Record<'pushBar' | 'spotlight' | 'partition', EquipmentOption> {
  const eq = model.equipment;
  return {
    pushBar: eq?.pushBumper == null ? { enabled: false, hint: 'This vehicle has no push-bar mount.' } : { enabled: true, hint: '' },
    spotlight: !eq?.spotlight ? { enabled: false, hint: 'This vehicle has no spotlight mount.' } : { enabled: true, hint: '' },
    partition: !eq?.partition ? { enabled: false, hint: 'This vehicle has no prisoner partition.' } : { enabled: true, hint: '' },
  };
}
