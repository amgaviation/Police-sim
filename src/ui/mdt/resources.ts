/**
 * Resources tab of the MDT (design phase 6 §12.3): pure view models, the worker ETA board state with stale-result
 * discard, and the DOM renderer of the board. The overlay rebuilds the tab only when the resources revision (or the CAD)
 * changed, so these functions may allocate freely.
 */
import type { CadCall } from '../../cad/types';
import type { ResourceStatus, ResourceUnitView } from '../../resources/types';
import { clearChildren, el } from '../ui';
import { formatEta } from './model';
import type { MdtEtaRow, MdtResourceType } from './types';

/** Status words of the unit list. */
const STATUS_WORDS: Readonly<Record<ResourceStatus, string>> = {
  available: 'AVAILABLE',
  turnout: 'TURNOUT',
  enRoute: 'EN ROUTE',
  onScene: 'ON SCENE',
  transporting: 'TRANSPORTING',
  returning: 'RETURNING',
  outOfService: 'OUT OF SERVICE',
};

/** One requestable type of the left list. */
export interface ResourceTypeRow {
  readonly id: string;
  /** Row number as typed ('1'..); '' past nine. */
  readonly n: string;
  readonly label: string;
  readonly resolves: string;
  /** 'patrol' for dispatcher-handled backup, 'unit' for resource units (the `send` kind). */
  readonly via: string;
}

/** One unit of the right list. */
export interface ResourceUnitRow {
  readonly callsign: string;
  readonly type: string;
  readonly status: ResourceStatus;
  readonly statusLabel: string;
  /** Call number or '-'. */
  readonly call: string;
  /** 'm:ss' or ''. */
  readonly eta: string;
}

/** One row of the ETA board table. */
export interface EtaBoardRow {
  readonly callsign: string;
  readonly label: string;
  readonly eta: string;
}

/** The requestable types in menu order, numbered for the keyboard. */
export function resourceTypeRows(types: readonly MdtResourceType[]): ResourceTypeRow[] {
  return types.map((t, i) => ({
    id: t.id,
    n: i < 9 ? String(i + 1) : '',
    label: t.label,
    resolves: t.resolves,
    via: t.send === 'resource' ? 'unit' : 'patrol',
  }));
}

/** The live units, sorted so units that are doing something come first (stable otherwise), with their call number. */
export function resourceUnitRows(units: readonly ResourceUnitView[], callNumber: (callId: number) => string | null): ResourceUnitRow[] {
  const rows = units.map((u) => ({
    callsign: u.callsign,
    type: u.label,
    status: u.status,
    statusLabel: STATUS_WORDS[u.status] ?? u.status.toUpperCase(),
    call: u.callId > 0 ? (callNumber(u.callId) ?? '-') : '-',
    eta: formatEta(u.etaS),
  }));
  const busy = (r: ResourceUnitRow): number => (r.status === 'available' || r.status === 'outOfService' ? 1 : 0);
  return rows.map((r, i) => ({ r, i })).sort((a, b) => busy(a.r) - busy(b.r) || a.i - b.i).map((x) => x.r);
}

/** Footer line: where a request from this tab goes. */
export function requestTargetText(playerCall: Pick<CadCall, 'number'> | null): string {
  return playerCall ? `Requests go to ${playerCall.number}` : 'Requests go to a new officer-assist call';
}

/** The board rows sorted by ETA (unknown last). */
export function etaBoardRows(rows: readonly MdtEtaRow[]): EtaBoardRow[] {
  const key = (r: MdtEtaRow): number => (Number.isFinite(r.etaS) && r.etaS >= 0 ? r.etaS : Number.POSITIVE_INFINITY);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => key(a.r) - key(b.r) || a.i - b.i)
    .map(({ r }) => ({ callsign: r.callsign, label: r.label, eta: formatEta(r.etaS) || '-' }));
}

export type EtaBoardStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/**
 * State of the worker ETA board. A result is shown only when it answers the latest request for the call that is still
 * selected: `select(callId)` with a different call (or a new `request`) discards whatever is in flight or shown.
 */
export class EtaBoardState {
  private statusValue: EtaBoardStatus = 'idle';
  private callValue = -1;
  private rowsValue: readonly EtaBoardRow[] = [];
  private token = 0;
  private revisionValue = 0;

  get status(): EtaBoardStatus {
    return this.statusValue;
  }

  /** The call the board (or the pending request) is for, -1 none. */
  get callId(): number {
    return this.callValue;
  }

  get rows(): readonly EtaBoardRow[] {
    return this.rowsValue;
  }

  /** Bumps whenever the shown board changes (a rebuild key). */
  get revision(): number {
    return this.revisionValue;
  }

  /** The selected call changed: forget a board or a pending request made for another call. */
  select(callId: number): void {
    // An idle board has nothing to forget (and must not bump the revision: the overlay calls this on every refresh).
    if (this.callValue === callId || this.statusValue === 'idle') return;
    this.reset();
  }

  /** Forgets the board and ignores any pending result. */
  reset(): void {
    this.token++;
    this.callValue = -1;
    this.statusValue = 'idle';
    this.rowsValue = [];
    this.revisionValue++;
  }

  /** Starts a fetch for `callId`; the result lands only if nothing else happened meanwhile. */
  request(callId: number, fetch: (callId: number) => Promise<readonly MdtEtaRow[]>): void {
    const mine = ++this.token;
    this.callValue = callId;
    this.statusValue = 'loading';
    this.rowsValue = [];
    this.revisionValue++;
    let promise: Promise<readonly MdtEtaRow[]>;
    try {
      promise = fetch(callId);
    } catch {
      this.statusValue = 'unavailable';
      this.revisionValue++;
      return;
    }
    promise.then(
      (rows) => {
        if (mine !== this.token) return;
        this.rowsValue = etaBoardRows(rows);
        this.statusValue = rows.length > 0 ? 'ready' : 'unavailable';
        this.revisionValue++;
      },
      () => {
        if (mine !== this.token) return;
        this.statusValue = 'unavailable';
        this.revisionValue++;
      },
    );
  }
}

/** Text above the ETA board table for the board's state. */
export function etaBoardMessage(state: EtaBoardState): string {
  switch (state.status) {
    case 'idle':
      return 'ETA BOARD: every unit type to the selected call, from the routing worker.';
    case 'loading':
      return 'Working out routes...';
    case 'unavailable':
      return 'ETA board unavailable.';
    case 'ready':
      return `ETA to the call from each unit's base (${String(state.rows.length)} units)`;
  }
}

/** Replaces `container`'s content with the board table (or its message). */
export function renderEtaBoard(container: HTMLElement, state: EtaBoardState): void {
  clearChildren(container);
  container.appendChild(el('p', { class: 'mdt-hint' }, etaBoardMessage(state)));
  if (state.status !== 'ready') return;
  const body = el('tbody');
  for (const r of state.rows) body.appendChild(el('tr', null, el('td', { class: 'mdt-c-num' }, r.callsign), el('td', null, r.label), el('td', { class: 'mdt-c-num' }, r.eta)));
  container.appendChild(
    el('table', { class: 'mdt-list mdt-eta-board', 'aria-label': 'ETA board' }, el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Unit'), el('th', { scope: 'col' }, 'Type'), el('th', { scope: 'col' }, 'ETA'))), body),
  );
}
