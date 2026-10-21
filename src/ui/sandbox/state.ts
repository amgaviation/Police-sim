/**
 * Scenario editor state (Phase 8 design 12.2): the document being edited, the selection and the operations the editor
 * canvas and panels call. Pure: no DOM, no storage. Every operation keeps the document inside the limits that
 * `parseSandboxScenario` enforces (counts, radius around the anchor); `validate` runs the full parser.
 */
import {
  SCENARIO_LIMITS,
  defaultScenarioContext,
  exportScenario,
  parseSandboxScenario,
  type SandboxScenario,
  type ScenarioContext,
} from '../../training/scenario';

export type EditorTool = 'select' | 'npc' | 'vehicle' | 'evidence' | 'call';
export type SelectionKind = 'npc' | 'vehicle' | 'evidence' | 'call';
export interface EditorSelection {
  kind: SelectionKind;
  index: number;
}

export type PlaceOptions = Record<string, string | boolean>;

const ROLE_RE = /^[a-zA-Z]{1,24}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 400;

/** A deep copy through the canonical export (unknown fields dropped). */
export function cloneScenario(s: SandboxScenario): SandboxScenario {
  return JSON.parse(exportScenario(s)) as SandboxScenario;
}

/** An empty scenario anchored at `anchor`; `id` must match `/^[a-z0-9][a-z0-9-]{1,39}$/`. */
export function blankScenario(id: string, anchor: { x: number; z: number }): SandboxScenario {
  return {
    format: 'patrol-scenario',
    version: 1,
    id,
    name: 'New scenario',
    description: '',
    anchor: { x: anchor.x, z: anchor.z },
    call: null,
    npcs: [],
    vehicles: [],
    evidence: [],
    timeOfDay: null,
    weather: null,
  };
}

/** Wraps an angle to (-pi, pi]. */
export function wrapYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  const tau = Math.PI * 2;
  let y = yaw % tau;
  if (y > Math.PI) y -= tau;
  else if (y <= -Math.PI) y += tau;
  return y;
}

function asBool(v: string | boolean | undefined): boolean {
  return v === true || v === 'true';
}

function asText(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export class EditorState {
  private readonly scenario: SandboxScenario;
  private sel: EditorSelection | null = null;
  private rev = 0;

  /** The document is copied: the caller's object is never modified. */
  constructor(doc: SandboxScenario) {
    this.scenario = cloneScenario(doc);
  }

  get doc(): SandboxScenario {
    return this.scenario;
  }

  get selected(): EditorSelection | null {
    return this.sel;
  }

  /** Bumps on every change of the document or the selection (the editor repaints on it). */
  get revision(): number {
    return this.rev;
  }

  /** Distance from the anchor, in metres. */
  private fromAnchor(x: number, z: number): number {
    return Math.hypot(x - this.scenario.anchor.x, z - this.scenario.anchor.z);
  }

  private touch(): void {
    this.rev++;
  }

  /**
   * Adds an object of `tool` at (x, z) and selects it; returns an error text (nothing added) or null. Options by tool:
   * npc `{ profile, role, weapon, hidden, yaw }`, vehicle `{ modelId }`, evidence `{ item, concealed }`, call `{ typeId,
   * priority }` (the call sits at the anchor, so x and z are ignored).
   */
  place(tool: EditorTool, x: number, z: number, opts: PlaceOptions = {}): string | null {
    const s = this.scenario;
    if (tool === 'select') return 'Pick a tool to place something';
    if (tool === 'call') {
      const typeId = asText(opts['typeId']);
      if (typeId === '') return 'Pick a call type';
      const p = Number(opts['priority']);
      this.setCall(typeId, p === 1 || p === 2 || p === 3 || p === 4 ? p : (s.call?.priority ?? 3));
      return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) return 'Position is not a number';
    const d = this.fromAnchor(x, z);
    if (d > SCENARIO_LIMITS.radiusM) {
      return `Too far from the anchor (${String(Math.round(d))} m; the limit is ${String(SCENARIO_LIMITS.radiusM)} m)`;
    }
    const yaw = wrapYaw(Number(opts['yaw'] ?? 0));
    if (tool === 'npc') {
      if (s.npcs.length >= SCENARIO_LIMITS.npcs) return `At most ${String(SCENARIO_LIMITS.npcs)} people`;
      const profile = asText(opts['profile']);
      if (profile === '') return 'Pick a behaviour profile';
      const role = asText(opts['role']) === '' ? 'bystander' : asText(opts['role']);
      if (!ROLE_RE.test(role)) return 'Role must be 1 to 24 letters';
      const weapon = asText(opts['weapon']);
      s.npcs.push({ x, z, yaw, profile, role, weapon: weapon === '' ? null : weapon, hidden: asBool(opts['hidden']) });
      this.sel = { kind: 'npc', index: s.npcs.length - 1 };
    } else if (tool === 'vehicle') {
      if (s.vehicles.length >= SCENARIO_LIMITS.vehicles) return `At most ${String(SCENARIO_LIMITS.vehicles)} vehicles`;
      const modelId = asText(opts['modelId']);
      if (modelId === '') return 'Pick a vehicle model';
      s.vehicles.push({ modelId, x, z, yaw });
      this.sel = { kind: 'vehicle', index: s.vehicles.length - 1 };
    } else {
      if (s.evidence.length >= SCENARIO_LIMITS.evidence) return `At most ${String(SCENARIO_LIMITS.evidence)} evidence items`;
      const item = asText(opts['item']);
      if (item === '') return 'Pick an item';
      s.evidence.push({ item, x, z, concealed: asBool(opts['concealed']) });
      this.sel = { kind: 'evidence', index: s.evidence.length - 1 };
    }
    this.touch();
    return null;
  }

  /** Moves the selected object; a position beyond the radius is pulled back onto the circle. The call cannot move. */
  move(x: number, z: number): void {
    const sel = this.sel;
    if (!sel || sel.kind === 'call' || !Number.isFinite(x) || !Number.isFinite(z)) return;
    const a = this.scenario.anchor;
    let nx = x;
    let nz = z;
    const d = this.fromAnchor(x, z);
    if (d > SCENARIO_LIMITS.radiusM) {
      const k = SCENARIO_LIMITS.radiusM / d;
      nx = a.x + (x - a.x) * k;
      nz = a.z + (z - a.z) * k;
    }
    const o = this.objectAt(sel);
    if (!o) return;
    o.x = nx;
    o.z = nz;
    this.touch();
  }

  /** Turns the selected person or vehicle by `deltaYaw` radians. */
  rotate(deltaYaw: number): void {
    const sel = this.sel;
    if (!sel || (sel.kind !== 'npc' && sel.kind !== 'vehicle') || !Number.isFinite(deltaYaw)) return;
    const o = sel.kind === 'npc' ? this.scenario.npcs[sel.index] : this.scenario.vehicles[sel.index];
    if (!o) return;
    o.yaw = wrapYaw(o.yaw + deltaYaw);
    this.touch();
  }

  /** Removes the selected object (the call: clears it) and clears the selection. */
  remove(): void {
    const sel = this.sel;
    if (!sel) return;
    const s = this.scenario;
    if (sel.kind === 'npc') s.npcs.splice(sel.index, 1);
    else if (sel.kind === 'vehicle') s.vehicles.splice(sel.index, 1);
    else if (sel.kind === 'evidence') s.evidence.splice(sel.index, 1);
    else s.call = null;
    this.sel = null;
    this.touch();
  }

  /** Selects the object nearest (x, z) within `radius` metres (null when none); people win ties, then vehicles, evidence, the call. */
  select(x: number, z: number, radius: number): void {
    const s = this.scenario;
    let best = null as EditorSelection | null;
    let bestD = radius;
    const consider = (kind: SelectionKind, index: number, ox: number, oz: number): void => {
      const d = Math.hypot(ox - x, oz - z);
      if (d <= bestD && (best === null || d < bestD)) {
        bestD = d;
        best = { kind, index };
      }
    };
    s.npcs.forEach((o, i) => consider('npc', i, o.x, o.z));
    s.vehicles.forEach((o, i) => consider('vehicle', i, o.x, o.z));
    s.evidence.forEach((o, i) => consider('evidence', i, o.x, o.z));
    if (s.call) consider('call', 0, s.anchor.x, s.anchor.z);
    const changed = best?.kind !== this.sel?.kind || best?.index !== this.sel?.index;
    this.sel = best;
    if (changed) this.touch();
  }

  /** Selects by kind and index (the list in the side panel). */
  selectIndex(kind: SelectionKind, index: number): void {
    const s = this.scenario;
    const ok =
      (kind === 'npc' && index >= 0 && index < s.npcs.length) ||
      (kind === 'vehicle' && index >= 0 && index < s.vehicles.length) ||
      (kind === 'evidence' && index >= 0 && index < s.evidence.length) ||
      (kind === 'call' && s.call !== null && index === 0);
    this.sel = ok ? { kind, index } : null;
    this.touch();
  }

  /** Edits the properties of the selected person (profile, role, weapon, hidden) or evidence item (item, concealed) or vehicle (modelId). */
  setProps(opts: PlaceOptions): string | null {
    const sel = this.sel;
    if (!sel) return 'Nothing selected';
    const s = this.scenario;
    if (sel.kind === 'npc') {
      const n = s.npcs[sel.index];
      if (!n) return 'Nothing selected';
      if (opts['profile'] !== undefined) {
        const v = asText(opts['profile']);
        if (v === '') return 'Pick a behaviour profile';
        n.profile = v;
      }
      if (opts['role'] !== undefined) {
        const v = asText(opts['role']);
        if (!ROLE_RE.test(v)) return 'Role must be 1 to 24 letters';
        n.role = v;
      }
      if (opts['weapon'] !== undefined) n.weapon = asText(opts['weapon']) === '' ? null : asText(opts['weapon']);
      if (opts['hidden'] !== undefined) n.hidden = asBool(opts['hidden']);
    } else if (sel.kind === 'vehicle') {
      const v = s.vehicles[sel.index];
      if (!v) return 'Nothing selected';
      if (opts['modelId'] !== undefined) {
        const m = asText(opts['modelId']);
        if (m === '') return 'Pick a vehicle model';
        v.modelId = m;
      }
    } else if (sel.kind === 'evidence') {
      const e = s.evidence[sel.index];
      if (!e) return 'Nothing selected';
      if (opts['item'] !== undefined) {
        const i = asText(opts['item']);
        if (i === '') return 'Pick an item';
        e.item = i;
      }
      if (opts['concealed'] !== undefined) e.concealed = asBool(opts['concealed']);
    } else {
      return 'The call has no properties here; use the call controls';
    }
    this.touch();
    return null;
  }

  /** Name (<= 60 characters) and description (<= 400); longer text is cut. */
  setMeta(name: string, description: string): void {
    this.scenario.name = name.slice(0, NAME_MAX);
    this.scenario.description = description.slice(0, DESCRIPTION_MAX);
    this.touch();
  }

  /** Changes the scenario id (the library key and the export file name); returns an error text or null. */
  setId(id: string): string | null {
    if (!ID_RE.test(id)) return 'Id: lowercase letters, digits and dashes, 2 to 40 characters, starting with a letter or digit';
    this.scenario.id = id;
    this.touch();
    return null;
  }

  /** The call that starts the scenario (null = none) and its priority. */
  setCall(typeId: string | null, priority: 1 | 2 | 3 | 4): void {
    this.scenario.call = typeId === null || typeId === '' ? null : { typeId, priority };
    if (this.scenario.call === null && this.sel?.kind === 'call') this.sel = null;
    this.touch();
  }

  /** Hour of day 0..23 (null = leave the time alone) and a weather kind (null = leave it). */
  setEnvironment(hour: number | null, weather: string | null): void {
    this.scenario.timeOfDay = hour === null || !Number.isFinite(hour) ? null : Math.min(23, Math.max(0, Math.floor(hour)));
    this.scenario.weather = weather === null || weather === '' ? null : weather;
    this.touch();
  }

  /** Every problem `parseSandboxScenario` finds (empty = the scenario can be saved, exported and run). */
  validate(ctx: ScenarioContext = defaultScenarioContext()): string[] {
    const r = parseSandboxScenario(JSON.parse(exportScenario(this.scenario)), ctx);
    return r.ok ? [] : r.errors;
  }

  /** Canonical JSON of the document. */
  exportJson(): string {
    return exportScenario(this.scenario);
  }

  private objectAt(sel: EditorSelection): { x: number; z: number } | undefined {
    const s = this.scenario;
    if (sel.kind === 'npc') return s.npcs[sel.index];
    if (sel.kind === 'vehicle') return s.vehicles[sel.index];
    if (sel.kind === 'evidence') return s.evidence[sel.index];
    return undefined;
  }
}
