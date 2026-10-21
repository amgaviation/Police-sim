/** Station state (design §11.1): shift flow, armory, locker loadout, holding cells and the interview room. */
import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { ActionPanelModel, PanelOption } from '../ui/panels/actionPanel';
import { ArmoryLog, armoryItem, ARMORY_ITEMS, type ArmoryEntry } from './armory';
import { HoldingCells } from './holding';
import {
  BODYCAM_MOUNTS,
  FLASHLIGHTS,
  LOADOUT_FIELDS,
  RADIO_AUDIO,
  cycleLoadout,
  defaultLoadout,
  isLoadout,
  uniformLabel,
  type Loadout,
  type LoadoutField,
} from './locker';
import { ShiftFlow, SHIFT_STEPS, isShiftStep, type ShiftStep } from './shiftFlow';
import './events';

export type StationRequest =
  | { readonly kind: 'complete'; readonly step: ShiftStep }
  | { readonly kind: 'armory'; readonly item: string; readonly action: 'out' | 'in' }
  | { readonly kind: 'loadout'; readonly field: LoadoutField }
  | { readonly kind: 'hold'; readonly personId: number }
  | { readonly kind: 'release'; readonly personId: number }
  | { readonly kind: 'interview'; readonly personId: number | null };

export interface StationSave {
  version: 1;
  flow: ShiftStep;
  flowLog: [ShiftStep, number][];
  armory: ArmoryEntry[];
  loadout: Loadout;
  /** [cell, personId, since] */
  holding: [number, number, number][];
  interviewing: number;
  queue: StationRequest[];
}

/** Requests waiting for the next step beyond this are dropped (oldest first). */
const MAX_QUEUE = 64;
const DONE_LABEL = 'Done';
const CUSTOMIZE_LABEL = 'Uniform & gear…';
const SIGN_OUT_LOADOUT_LABEL = 'Sign out my loadout';
/** A prisoner is transferred to county after this long in a cell (sim seconds), so the cells never fill for good. */
export const HOLD_LIMIT_S = 1800;

const BODYCAM_LABELS: Readonly<Record<(typeof BODYCAM_MOUNTS)[number], string>> = { chest: 'Chest', shoulder: 'Shoulder', none: 'None' };
const AUDIO_LABELS: Readonly<Record<(typeof RADIO_AUDIO)[number], string>> = { speaker: 'Speaker', earpiece: 'Earpiece' };
const LIGHT_LABELS: Readonly<Record<(typeof FLASHLIGHTS)[number], string>> = { handheld: 'Handheld', mounted: 'Mounted' };

export class StationState {
  readonly flow = new ShiftFlow();
  readonly armory: ArmoryLog;
  readonly holding: HoldingCells;
  private current: Loadout = defaultLoadout();
  private interview = -1;
  private queue: StationRequest[] = [];
  private readonly officer: () => { name: string; badge: string };
  private readonly bus: EventBus<EventMap>;

  constructor(seed: number, officer: () => { name: string; badge: string }, bus: EventBus<EventMap>, cellCount = 3) {
    this.armory = new ArmoryLog(seed);
    this.holding = new HoldingCells(cellCount);
    this.officer = officer;
    this.bus = bus;
  }

  get loadout(): Readonly<Loadout> {
    return this.current;
  }

  /** Sets the Vest row to the officer's real gear (silent: no `station:loadout` event, so it is not echoed back to the gear). */
  setVest(on: boolean): void {
    if (this.current.vest !== on) this.current = { ...this.current, vest: on };
  }

  /** Person id in the interview room, -1 when empty. */
  get interviewing(): number {
    return this.interview;
  }

  /** Queues a request; it is applied at the start of the next `step`. */
  request(r: StationRequest): void {
    this.queue.push(r);
    if (this.queue.length > MAX_QUEUE) this.queue.shift();
  }

  /**
   * Fixed step (order -670): releases prisoners held for `HOLD_LIMIT_S`, applies the queued requests in order and emits
   * the `station:*` events.
   */
  step(_dt: number, t: { sim: number; game: number }): void {
    for (let due = this.holding.dueFor(t.sim, HOLD_LIMIT_S, this.interview); due >= 0; due = this.holding.dueFor(t.sim, HOLD_LIMIT_S, this.interview)) {
      this.release(due);
    }
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (const r of pending) this.apply(r, t);
  }

  // --- Panels ----------------------------------------------------------------------------------

  /**
   * Locker rows: Uniform, Vest, Bodycam mount, Radio audio, Flashlight, Done (index 5 completes the locker step), then
   * 'Uniform & gear...' (index 6, detail 'Customize'; opens the uniform and gear editor).
   */
  lockerModel(): ActionPanelModel {
    const l = this.current;
    return {
      title: 'Locker',
      subtitle: 'Choose your gear',
      options: [
        { label: 'Uniform', detail: uniformLabel(l) },
        { label: 'Vest', detail: l.vest ? 'On' : 'Off' },
        { label: 'Bodycam mount', detail: BODYCAM_LABELS[l.bodycamMount] },
        { label: 'Radio audio', detail: AUDIO_LABELS[l.radioAudio] },
        { label: 'Flashlight', detail: LIGHT_LABELS[l.flashlight] },
        { label: DONE_LABEL },
        { label: CUSTOMIZE_LABEL, detail: 'Customize' },
      ],
      footer: 'Enter changes the option · Done finishes · Esc close',
    };
  }

  /** Queues the row's request; returns 'customize' (nothing queued) for the 'Uniform & gear...' row, else null. */
  lockerSelect(index: number): 'customize' | null {
    const field = LOADOUT_FIELDS[index];
    if (field !== undefined) this.request({ kind: 'loadout', field });
    else if (index === LOADOUT_FIELDS.length) this.request({ kind: 'complete', step: 'locker' });
    else if (index === LOADOUT_FIELDS.length + 1) return 'customize';
    return null;
  }

  /**
   * Armory rows: one per item ('Sign out Duty pistol (SA-1042)' or 'Return Duty pistol (SA-1042)'), then Done
   * (index `ARMORY_ITEMS.length`, enabled once the sidearm is out), then 'Sign out my loadout' (index
   * `ARMORY_ITEMS.length + 1`): enabled while at least one of `loadoutItems` (armory item ids of the officer's gear) is not
   * out, disabled ('Nothing to sign out') otherwise or without `loadoutItems`.
   */
  armoryModel(loadoutItems?: readonly string[]): ActionPanelModel {
    const options: PanelOption[] = ARMORY_ITEMS.map((d) => {
      const out = this.armory.has(d.id);
      return { label: `${out ? 'Return' : 'Sign out'} ${d.label} (${this.armory.serial(d.id)})`, detail: out ? 'Out' : 'In' };
    });
    const sidearm = this.armory.has('sidearm');
    options.push(sidearm ? { label: DONE_LABEL } : { label: DONE_LABEL, detail: 'Sign out a duty pistol first', enabled: false });
    const pending = this.pendingLoadout(loadoutItems);
    options.push(
      pending.length > 0
        ? { label: SIGN_OUT_LOADOUT_LABEL, detail: `${String(pending.length)} items` }
        : { label: SIGN_OUT_LOADOUT_LABEL, detail: 'Nothing to sign out', enabled: false },
    );
    return {
      title: 'Armory',
      subtitle: this.armory.out().length === 0 ? 'Nothing signed out' : `${String(this.armory.out().length)} signed out`,
      options,
      footer: 'Enter signs out or returns · Esc close',
    };
  }

  /** The loadout row queues a sign-out for every loadout item not yet out, in `ARMORY_ITEMS` order. */
  armorySelect(index: number, loadoutItems?: readonly string[]): void {
    const def = ARMORY_ITEMS[index];
    if (def !== undefined) {
      this.request({ kind: 'armory', item: def.id, action: this.armory.has(def.id) ? 'in' : 'out' });
    } else if (index === ARMORY_ITEMS.length && this.armory.has('sidearm')) {
      this.request({ kind: 'complete', step: 'armory' });
    } else if (index === ARMORY_ITEMS.length + 1) {
      for (const item of this.pendingLoadout(loadoutItems)) this.request({ kind: 'armory', item, action: 'out' });
    }
  }

  /** Armory item ids of `loadoutItems` that are not signed out yet, in `ARMORY_ITEMS` order. */
  private pendingLoadout(loadoutItems: readonly string[] | undefined): string[] {
    if (loadoutItems === undefined) return [];
    return ARMORY_ITEMS.filter((d) => loadoutItems.includes(d.id) && !this.armory.has(d.id)).map((d) => d.id);
  }

  /**
   * Interview rows: one 'Bring in <name>' per person held in the cells, then 'End interview' (enabled while someone
   * is in the room). `names` maps a person id to the display name.
   */
  interviewModel(names: (personId: number) => string): ActionPanelModel {
    const held = this.holding.occupants();
    const options: PanelOption[] = held.map((o) => ({
      label: `Bring in ${names(o.personId)}`,
      detail: `Cell ${String(o.cell + 1)}`,
      enabled: o.personId !== this.interview,
    }));
    options.push(this.interview >= 0 ? { label: 'End interview' } : { label: 'End interview', enabled: false });
    return {
      title: 'Interview room',
      subtitle: this.interview >= 0 ? `Interviewing ${names(this.interview)}` : held.length === 0 ? 'Nobody is being held' : 'Choose who to bring in',
      options,
      footer: 'Enter selects · Esc close',
    };
  }

  interviewSelect(index: number): void {
    const held = this.holding.occupants();
    const o = held[index];
    if (o !== undefined) this.request({ kind: 'interview', personId: o.personId });
    else if (index === held.length) this.request({ kind: 'interview', personId: null });
  }

  /** Which duty weapons are signed out (the scene's weapon gate). */
  weaponsAvailable(): { sidearm: boolean; taser: boolean } {
    let sidearm = false;
    let taser = false;
    for (const d of ARMORY_ITEMS) {
      if (!this.armory.has(d.id)) continue;
      if (d.weapon === 'sidearm') sidearm = true;
      else if (d.weapon === 'taser') taser = true;
    }
    return { sidearm, taser };
  }

  // --- Save ------------------------------------------------------------------------------------

  serialize(): StationSave {
    return {
      version: 1,
      flow: this.flow.step,
      flowLog: this.flow.log.map(([s, t]) => [s, t]),
      armory: this.armory.entries().map((e) => ({ ...e })),
      loadout: { ...this.current },
      holding: this.holding.occupants().map((o) => [o.cell, o.personId, o.since]),
      interviewing: this.interview,
      queue: this.queue.map((r) => ({ ...r })),
    };
  }

  restore(s: StationSave): void {
    this.flow.restore(s.flow, s.flowLog);
    this.armory.restore(s.armory);
    this.current = { ...s.loadout };
    this.holding.restore(s.holding);
    this.interview = s.interviewing;
    this.queue = s.queue.map((r) => ({ ...r }));
  }

  // --- Internals -------------------------------------------------------------------------------

  private apply(r: StationRequest, t: { sim: number; game: number }): void {
    switch (r.kind) {
      case 'complete':
        if (this.flow.complete(r.step, t.sim)) this.bus.emit('station:step', { step: this.flow.step });
        break;
      case 'armory': {
        const who = this.officer().badge;
        const entry =
          r.action === 'out' ? this.armory.signOut(r.item, who, t.sim, t.game) : this.armory.signIn(r.item, who, t.sim, t.game);
        if (entry === null) break;
        this.bus.emit('station:armory', { entry });
        // The armory step is done once the duty pistol is signed out.
        if (entry.action === 'out' && entry.item === 'sidearm' && this.flow.complete('armory', t.sim)) {
          this.bus.emit('station:step', { step: this.flow.step });
        }
        break;
      }
      case 'loadout':
        this.current = cycleLoadout(this.current, r.field);
        this.bus.emit('station:loadout', { loadout: { ...this.current } });
        break;
      case 'hold': {
        if (this.holding.cellOf(r.personId) >= 0) break;
        // Every cell taken: the longest-held prisoner (not the one being interviewed) goes to county to make room.
        if (this.holding.full) {
          const oldest = this.holding.oldest(this.interview);
          if (oldest >= 0) this.release(oldest);
        }
        const cell = this.holding.place(r.personId, t.sim);
        if (cell >= 0) this.bus.emit('station:holding', { personId: r.personId, cell, placed: true });
        break;
      }
      case 'release':
        this.release(r.personId);
        break;
      case 'interview':
        this.setInterview(r.personId ?? -1);
        break;
    }
  }

  /** Frees the person's cell (`station:holding` with `placed` false); a prisoner in the interview room leaves it. */
  private release(personId: number): void {
    const cell = this.holding.cellOf(personId);
    if (!this.holding.remove(personId)) return;
    this.bus.emit('station:holding', { personId, cell, placed: false });
    if (this.interview === personId) this.setInterview(-1);
  }

  private setInterview(personId: number): void {
    if (personId === this.interview) return;
    this.interview = personId;
    this.bus.emit('station:interview', { personId });
  }
}

// --- Save helpers --------------------------------------------------------------------------------

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isStationRequest(x: unknown): x is StationRequest {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  switch (o['kind']) {
    case 'complete':
      return isShiftStep(o['step']);
    case 'armory':
      return typeof o['item'] === 'string' && armoryItem(o['item']) !== undefined && (o['action'] === 'out' || o['action'] === 'in');
    case 'loadout':
      return (LOADOUT_FIELDS as readonly unknown[]).includes(o['field']);
    case 'hold':
    case 'release':
      return isNum(o['personId']);
    case 'interview':
      return o['personId'] === null || isNum(o['personId']);
    default:
      return false;
  }
}

function isArmoryEntry(x: unknown): x is ArmoryEntry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    isNum(o['seq']) &&
    typeof o['item'] === 'string' &&
    armoryItem(o['item']) !== undefined &&
    typeof o['serial'] === 'string' &&
    (o['action'] === 'out' || o['action'] === 'in') &&
    typeof o['officer'] === 'string' &&
    isNum(o['sim']) &&
    isNum(o['game'])
  );
}

/** Structural check of a saved station state. */
export function isStationSave(x: unknown): x is StationSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o['version'] !== 1 || !isShiftStep(o['flow']) || !isLoadout(o['loadout']) || !isNum(o['interviewing'])) return false;
  const log = o['flowLog'];
  if (!Array.isArray(log) || !log.every((e) => Array.isArray(e) && e.length === 2 && isShiftStep(e[0]) && isNum(e[1]))) return false;
  const armory = o['armory'];
  if (!Array.isArray(armory) || !armory.every(isArmoryEntry)) return false;
  const holding = o['holding'];
  if (!Array.isArray(holding) || !holding.every((e) => Array.isArray(e) && e.length === 3 && e.every(isNum))) return false;
  const queue = o['queue'];
  return Array.isArray(queue) && queue.every(isStationRequest);
}

/** A fresh shift: at the locker, nothing signed out, the default loadout. */
export function newShiftStationSave(): StationSave {
  return { version: 1, flow: 'locker', flowLog: [], armory: [], loadout: defaultLoadout(), holding: [], interviewing: -1, queue: [] };
}

/**
 * Station state for a save from before Phase 4: already on patrol with the duty pistol and the conducted energy device
 * signed out to `badge` at sim 0 (serials are re-derived from the seed when the state is restored).
 */
export function migratedStationSave(badge: string): StationSave {
  const entry = (seq: number, item: string): ArmoryEntry => ({ seq, item, serial: '', action: 'out', officer: badge, sim: 0, game: 0 });
  return {
    version: 1,
    flow: 'onPatrol',
    flowLog: SHIFT_STEPS.slice(0, -1).map((s): [ShiftStep, number] => [s, 0]),
    armory: [entry(0, 'sidearm'), entry(1, 'taser')],
    loadout: defaultLoadout(),
    holding: [],
    interviewing: -1,
    queue: [],
  };
}
