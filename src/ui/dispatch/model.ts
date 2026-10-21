/**
 * Dispatch console model (Phase 8 design 12.1): the port the console talks to (local dispatcher, or the co-op net
 * room), the sorted queue / unit lists, the unit suggestions and a pure key reducer. No DOM.
 */

export type ConsolePriority = 1 | 2 | 3 | 4;

export interface ConsoleCall {
  id: number;
  number: string;
  nature: string;
  priority: ConsolePriority;
  status: 'pending' | 'active' | 'closed';
  address: string;
  district: string;
  /** Seconds since the call was created. */
  ageS: number;
  /** Callsigns assigned to the call. */
  units: readonly string[];
  x: number;
  z: number;
  /** Premise history lines (empty = no prior calls). */
  premise: readonly string[];
  notes: readonly string[];
}

export interface ConsoleUnit {
  callsign: string;
  label: string;
  status: string;
  callId: number | null;
  x: number;
  z: number;
  /** Seconds to the unit's current call; negative = unknown. */
  etaS: number;
  kind: 'ai' | 'player' | 'remote';
}

/** What the console reads and writes: implemented by the integrator for the local CAD and for the co-op room. */
export interface DispatchConsolePort {
  readonly title: string;
  readonly canCreate: boolean;
  /** Order ids the console may send (net `ORDER_KINDS`); [] = no orders. */
  readonly orders: readonly string[];
  readonly dispositions: readonly { id: string; label: string }[];
  /** Bumps whenever calls, units or notes change (the console rebuilds at most 4 Hz). */
  revision(): number;
  calls(): readonly ConsoleCall[];
  units(): readonly ConsoleUnit[];
  callTypes(): readonly { id: string; label: string }[];
  /** Score line of dispatch training ('A  92 %'), null when not scored. */
  score(): string | null;
  assign(callId: number, callsign: string): void;
  unassign(callId: number, callsign: string): void;
  setPriority(callId: number, p: ConsolePriority): void;
  note(callId: number, text: string): void;
  close(callId: number, disposition: string): void;
  create(typeId: string, priority: ConsolePriority, x: number, z: number): void;
  order(callsign: string, order: string, callId: number | null): void;
}

export interface ConsoleSel {
  callId: number | null;
  unit: string | null;
}

export interface ConsoleModel {
  title: string;
  score: string | null;
  canCreate: boolean;
  /** Open calls: priority 1 first, then the oldest first. */
  calls: ConsoleCall[];
  /** Every unit, sorted by callsign (numbers compared as numbers). */
  units: ConsoleUnit[];
  /** The resolved selection (the first call / unit when `sel` names none that exists). */
  sel: ConsoleSel;
  call: ConsoleCall | null;
  unit: ConsoleUnit | null;
  /** Callsigns to offer for the selected call (see `suggestUnits`). */
  suggestions: string[];
}

/** How many unit buttons the detail pane offers. */
export const SUGGESTION_COUNT = 3;
/** Assumed speed (m/s) to turn a distance into an ETA for units without one. */
export const ASSUMED_SPEED_MPS = 12;

/** Priority 1 first, then oldest first, then id. */
export function compareCalls(a: ConsoleCall, b: ConsoleCall): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.ageS !== b.ageS) return b.ageS - a.ageS;
  return a.id - b.id;
}

function compareUnits(a: ConsoleUnit, b: ConsoleUnit): number {
  const byName = a.callsign.localeCompare(b.callsign, 'en', { numeric: true });
  return byName !== 0 ? byName : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** Available units not on the call, nearest first: by ETA when the unit has one (>= 0), else by distance / 12 m/s. Ties: callsign. */
export function suggestUnits(call: ConsoleCall, units: readonly ConsoleUnit[], n: number): string[] {
  const scored: { callsign: string; score: number }[] = [];
  for (const u of units) {
    if (u.status !== 'available' || call.units.includes(u.callsign)) continue;
    const score = u.etaS >= 0 ? u.etaS : Math.hypot(u.x - call.x, u.z - call.z) / ASSUMED_SPEED_MPS;
    scored.push({ callsign: u.callsign, score });
  }
  scored.sort((a, b) => a.score - b.score || a.callsign.localeCompare(b.callsign, 'en', { numeric: true }));
  return scored.slice(0, Math.max(0, n)).map((s) => s.callsign);
}

/** Builds the model from the port: open calls sorted, units sorted, the selection resolved, suggestions for the selected call. */
export function consoleModel(port: DispatchConsolePort, sel: Readonly<ConsoleSel>): ConsoleModel {
  const calls = port.calls().filter((c) => c.status !== 'closed').sort(compareCalls);
  const units = [...port.units()].sort(compareUnits);
  const call = calls.find((c) => c.id === sel.callId) ?? calls[0] ?? null;
  const unit = units.find((u) => u.callsign === sel.unit) ?? units[0] ?? null;
  return {
    title: port.title,
    score: port.score(),
    canCreate: port.canCreate,
    calls,
    units,
    sel: { callId: call?.id ?? null, unit: unit?.callsign ?? null },
    call,
    unit,
    suggestions: call ? suggestUnits(call, units, SUGGESTION_COUNT) : [],
  };
}

/** '4:07' for 247 seconds; negative or non-finite input reads '0:00'. */
export function formatAge(s: number): string {
  const total = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const m = Math.floor(total / 60);
  return `${String(m)}:${String(total % 60).padStart(2, '0')}`;
}

/** 'ETA 1:20', or '' when unknown. */
export function formatEta(etaS: number): string {
  return etaS >= 0 ? `ETA ${formatAge(etaS)}` : '';
}

/** 'returnToStation' -> 'Return to station'. */
export function orderLabel(order: string): string {
  const words = order.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 'enRoute' -> 'en route'. */
export function statusLabel(status: string): string {
  return status.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** One signature string per list: the console rebuilds a list only when it changes (keeps keyboard focus stable). */
export function callsSignature(calls: readonly ConsoleCall[], selected: number | null): string {
  return `${String(selected)}|${calls.map((c) => `${String(c.id)}:${String(c.priority)}:${c.status}:${c.nature}:${c.units.join(',')}`).join(';')}`;
}

export function unitsSignature(units: readonly ConsoleUnit[], selected: string | null): string {
  return `${String(selected)}|${units
    .map((u) => `${u.callsign}:${u.status}:${String(u.callId)}:${u.etaS >= 0 ? String(Math.floor(u.etaS)) : '-'}:${u.kind}`)
    .join(';')}`;
}

export function detailSignature(m: Readonly<ConsoleModel>): string {
  const c = m.call;
  if (!c) return `none|${String(m.unit?.callsign)}`;
  return [
    c.id,
    c.number,
    c.nature,
    c.priority,
    c.status,
    c.address,
    c.district,
    c.units.join(','),
    c.premise.join('\n'),
    c.notes.join('\n'),
    m.suggestions.join(','),
    m.unit?.callsign ?? '',
    m.unit?.status ?? '',
  ].join('|');
}

// --- Keys -------------------------------------------------------------------------------------------------

export interface ConsoleUiState {
  sel: ConsoleSel;
  /** `C` was pressed: the next map click places a call. */
  creating: boolean;
}

export type ConsoleAction =
  | { kind: 'assign'; callId: number; callsign: string }
  | { kind: 'unassign'; callId: number; callsign: string }
  | { kind: 'priority'; callId: number; priority: ConsolePriority }
  | { kind: 'focusNote' }
  | { kind: 'escape' };

export interface ConsoleKeyResult {
  ui: ConsoleUiState;
  action: ConsoleAction | null;
  consumed: boolean;
}

function step<T>(list: readonly T[], index: number, delta: number): number {
  if (list.length === 0) return -1;
  return Math.min(list.length - 1, Math.max(0, (index < 0 ? 0 : index) + delta));
}

/**
 * Pure key handling (design 12.1): Up / Down select the call, Left / Right the unit, A assigns the selected unit (else the
 * best suggestion) to the selected call, U unassigns, 1-4 set the priority, N focuses the note box, C arms "create"
 * (next map click), Escape cancels creating or asks to leave. `key` is `KeyboardEvent.key`.
 */
export function reduceConsoleKey(model: Readonly<ConsoleModel>, ui: Readonly<ConsoleUiState>, key: string): ConsoleKeyResult {
  const keep = (action: ConsoleAction | null = null): ConsoleKeyResult => ({ ui: { ...ui, sel: { ...ui.sel } }, action, consumed: true });
  const next = (patch: Partial<ConsoleUiState> & { sel?: ConsoleSel }): ConsoleKeyResult => ({
    ui: { ...ui, ...patch, sel: patch.sel ?? { ...ui.sel } },
    action: null,
    consumed: true,
  });
  const call = model.call;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      const at = model.calls.findIndex((c) => c.id === model.sel.callId);
      const i = step(model.calls, at, key === 'ArrowDown' ? 1 : -1);
      return next({ sel: { callId: model.calls[i]?.id ?? null, unit: model.sel.unit } });
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const at = model.units.findIndex((u) => u.callsign === model.sel.unit);
      const i = step(model.units, at, key === 'ArrowRight' ? 1 : -1);
      return next({ sel: { callId: model.sel.callId, unit: model.units[i]?.callsign ?? null } });
    }
    case 'a':
    case 'A': {
      if (!call) return keep();
      const unit = model.unit;
      const callsign = unit ? (unit.status === 'available' && !call.units.includes(unit.callsign) ? unit.callsign : null) : (model.suggestions[0] ?? null);
      return callsign === null ? keep() : keep({ kind: 'assign', callId: call.id, callsign });
    }
    case 'u':
    case 'U': {
      if (!call) return keep();
      const unit = model.unit;
      const callsign = unit && call.units.includes(unit.callsign) ? unit.callsign : (call.units[0] ?? null);
      return callsign === null ? keep() : keep({ kind: 'unassign', callId: call.id, callsign });
    }
    case '1':
    case '2':
    case '3':
    case '4': {
      const priority = Number(key) as ConsolePriority;
      return call && call.priority !== priority ? keep({ kind: 'priority', callId: call.id, priority }) : keep();
    }
    case 'n':
    case 'N':
      return keep({ kind: 'focusNote' });
    case 'c':
    case 'C':
      return model.canCreate ? next({ creating: !ui.creating }) : keep();
    case 'Escape':
      return ui.creating ? next({ creating: false }) : keep({ kind: 'escape' });
    default:
      return { ui: { ...ui, sel: { ...ui.sel } }, action: null, consumed: false };
  }
}
