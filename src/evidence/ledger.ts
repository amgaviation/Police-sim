/**
 * Hash-chained chain-of-custody ledger (design phase 4 §9.1). Each entry stores the hash of its predecessor, so
 * deleting, reordering or editing any entry is detected by `verifyLedger`. Per item the legal sequence is
 * collect -> bag -> tag -> transfer* -> deposit, and nothing follows a deposit. Pure: no clock, no randomness.
 */
import { hashString } from '../core/rng';

export const CUSTODY_ACTIONS = ['collect', 'bag', 'tag', 'transfer', 'deposit'] as const;
export type CustodyAction = (typeof CUSTODY_ACTIONS)[number];

/** Custodian id of an item that has not been collected yet. */
export const SCENE_CUSTODIAN = 'scene';
/** Custodian id of the evidence room (final custody). */
export const EVIDENCE_ROOM = 'evidenceRoom';
/** `prevHash` of the first entry. */
export const GENESIS_HASH = '00000000';

export interface CustodyEntry {
  /** 1, 2, 3 ... across the whole ledger. */
  readonly seq: number;
  /** `E-<callId>-<n>`. */
  readonly itemId: string;
  readonly action: CustodyAction;
  /** `'scene'` for collect; a custodian id otherwise. */
  readonly from: string;
  /** Custodian id: `officer:<badge>`, `locker:<car index>`, `evidenceRoom`. */
  readonly to: string;
  readonly sim: number;
  readonly game: number;
  /** Free text, e.g. `1420 Oak St - Kitchen`. */
  readonly location: string;
  /** Bag/tag label or transfer reason. */
  readonly note: string;
  readonly prevHash: string;
  /** 8 lowercase hex chars. */
  readonly hash: string;
}

export type ItemCustodyState = 'none' | 'collected' | 'bagged' | 'tagged' | 'deposited';

/** FNV-1a of the canonical entry string (see design §9.1), hex padded to 8. */
export function entryHash(e: Omit<CustodyEntry, 'hash'>): string {
  const text = `${e.seq}|${e.itemId}|${e.action}|${e.from}|${e.to}|${e.sim.toFixed(3)}|${e.game.toFixed(3)}|${e.location}|${e.note}|${e.prevHash}`;
  return hashString(text).toString(16).padStart(8, '0');
}

export type AppendResult = { ok: true; entry: CustodyEntry } | { ok: false; reason: string };

export interface CustodyRequest {
  itemId: string;
  action: CustodyAction;
  from: string;
  to: string;
  sim: number;
  game: number;
  location: string;
  note: string;
}

export interface LedgerIssue {
  seq: number;
  itemId: string;
  kind: 'hash' | 'chain' | 'gap' | 'order' | 'custodian' | 'time' | 'duplicate';
  text: string;
}

const NEXT_STATE: Readonly<Record<CustodyAction, ItemCustodyState>> = {
  collect: 'collected',
  bag: 'bagged',
  tag: 'tagged',
  transfer: 'tagged',
  deposit: 'deposited',
};

/** The state an item must be in for each action. */
const REQUIRED_STATE: Readonly<Record<CustodyAction, ItemCustodyState>> = {
  collect: 'none',
  bag: 'collected',
  tag: 'bagged',
  transfer: 'tagged',
  deposit: 'tagged',
};

interface Violation {
  kind: LedgerIssue['kind'];
  text: string;
}

/** The single transition rule shared by `append` and `verifyLedger`; null when the step is legal. */
function checkTransition(
  state: ItemCustodyState,
  custodian: string,
  e: { itemId: string; action: CustodyAction; from: string; to: string },
): Violation | null {
  const { itemId, action, from, to } = e;
  if (action === 'collect') {
    if (state !== 'none') return { kind: 'duplicate', text: `${itemId} was already collected` };
    if (from !== SCENE_CUSTODIAN) return { kind: 'order', text: `${itemId} must be collected from the scene, not from ${from}` };
    if (to === '' || to === SCENE_CUSTODIAN || to === EVIDENCE_ROOM) {
      return { kind: 'custodian', text: `${itemId} must be collected by an officer or locker, not "${to}"` };
    }
    return null;
  }
  if (state === 'none') return { kind: 'order', text: `cannot ${action} ${itemId} before it is collected` };
  if (state === 'deposited') return { kind: 'order', text: `cannot ${action} ${itemId}: already deposited in the evidence room` };
  if (state !== REQUIRED_STATE[action]) {
    return { kind: 'order', text: `cannot ${action} ${itemId} while it is ${state} (needs ${REQUIRED_STATE[action]})` };
  }
  if (from !== custodian) return { kind: 'custodian', text: `${action} of ${itemId} from ${from}, but ${custodian} holds it` };
  if (action === 'bag' || action === 'tag') {
    if (to !== from) return { kind: 'custodian', text: `${action} of ${itemId} must stay with ${from}, not ${to}` };
  } else if (action === 'transfer') {
    if (to === from) return { kind: 'custodian', text: `transfer of ${itemId} needs a different custodian than ${from}` };
    if (to === EVIDENCE_ROOM) return { kind: 'order', text: `${itemId} must be deposited, not transferred, to the evidence room` };
    if (to === '') return { kind: 'custodian', text: `transfer of ${itemId} needs a receiving custodian` };
  } else if (to !== EVIDENCE_ROOM) {
    return { kind: 'order', text: `${itemId} must be deposited to ${EVIDENCE_ROOM}, not ${to}` };
  }
  return null;
}

interface ItemInfo {
  state: ItemCustodyState;
  custodian: string;
  entries: CustodyEntry[];
}

/** Append-only custody ledger with per-item state tracking. */
export class CustodyLedger {
  private readonly list: CustodyEntry[] = [];
  private readonly items = new Map<string, ItemInfo>();

  /** Trusts `entries` (use `verifyLedger` to check them). */
  constructor(entries: readonly CustodyEntry[] = []) {
    for (const e of entries) this.record({ ...e });
  }

  /** Validates the transition, fills seq / prevHash / hash and appends. */
  append(e: CustodyRequest): AppendResult {
    if (e.itemId === '' || e.itemId.includes('|')) return { ok: false, reason: 'item id must be non-empty and contain no "|"' };
    if (e.from.includes('|') || e.to.includes('|')) return { ok: false, reason: 'custodian ids may not contain "|"' };
    if (!Number.isFinite(e.sim) || !Number.isFinite(e.game)) return { ok: false, reason: 'entry time must be finite' };
    const last = this.list[this.list.length - 1];
    if (last && e.sim < last.sim) {
      return { ok: false, reason: `time cannot go backwards (${e.sim.toFixed(3)} s is before the last entry at ${last.sim.toFixed(3)} s)` };
    }
    const info = this.items.get(e.itemId);
    const violation = checkTransition(info?.state ?? 'none', info?.custodian ?? '', e);
    if (violation) return { ok: false, reason: violation.text };
    const body = {
      seq: this.list.length + 1,
      itemId: e.itemId,
      action: e.action,
      from: e.from,
      to: e.to,
      sim: e.sim,
      game: e.game,
      location: e.location.replaceAll('|', '/'),
      note: e.note.replaceAll('|', '/'),
      prevHash: last ? last.hash : GENESIS_HASH,
    };
    const entry: CustodyEntry = { ...body, hash: entryHash(body) };
    this.record(entry);
    return { ok: true, entry };
  }

  entries(): readonly CustodyEntry[] {
    return this.list;
  }

  itemEntries(itemId: string): readonly CustodyEntry[] {
    return this.items.get(itemId)?.entries ?? [];
  }

  state(itemId: string): ItemCustodyState {
    return this.items.get(itemId)?.state ?? 'none';
  }

  /** Current custodian id; `''` before collect. */
  custodian(itemId: string): string {
    return this.items.get(itemId)?.custodian ?? '';
  }

  /** True when collect, bag, tag and deposit are all present (the item reached the evidence room). */
  complete(itemId: string): boolean {
    const actions = this.itemEntries(itemId).map((x) => x.action);
    return ['collect', 'bag', 'tag', 'deposit'].every((a) => actions.includes(a as CustodyAction));
  }

  serialize(): CustodyEntry[] {
    return this.list.map((e) => ({ ...e }));
  }

  private record(e: CustodyEntry): void {
    this.list.push(e);
    let info = this.items.get(e.itemId);
    if (!info) {
      info = { state: 'none', custodian: '', entries: [] };
      this.items.set(e.itemId, info);
    }
    info.entries.push(e);
    info.state = NEXT_STATE[e.action];
    info.custodian = e.to;
  }
}

/** Re-checks every entry: sequence, hash chain, stored hashes, legal transitions and time order. */
export function verifyLedger(entries: readonly CustodyEntry[]): { ok: boolean; issues: LedgerIssue[] } {
  const issues: LedgerIssue[] = [];
  const items = new Map<string, { state: ItemCustodyState; custodian: string }>();
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  let prevSim = -Infinity;
  for (const e of entries) {
    const add = (kind: LedgerIssue['kind'], text: string): void => {
      issues.push({ seq: e.seq, itemId: e.itemId, kind, text });
    };
    if (e.seq !== prevSeq + 1) add('gap', `sequence jumps from ${prevSeq} to ${e.seq}`);
    if (e.prevHash !== prevHash) add('chain', `previous hash ${e.prevHash} does not match ${prevHash}`);
    const { hash: stored, ...body } = e;
    const expected = entryHash(body);
    if (stored !== expected) add('hash', `stored hash ${stored} but contents hash to ${expected}`);
    if (e.sim < prevSim) add('time', `time goes backwards (${e.sim.toFixed(3)} s after ${prevSim.toFixed(3)} s)`);
    const info = items.get(e.itemId) ?? { state: 'none' as ItemCustodyState, custodian: '' };
    const violation = checkTransition(info.state, info.custodian, e);
    if (violation) add(violation.kind, violation.text);
    items.set(e.itemId, { state: NEXT_STATE[e.action], custodian: e.to });
    prevHash = stored;
    prevSeq = e.seq;
    prevSim = Math.max(prevSim, e.sim);
  }
  return { ok: issues.length === 0, issues };
}
