/**
 * Persistent-world views of the MDT (Phase 8 §11.4): the premise history block of the Call tab and the Cases tab. Pure
 * view models plus the DOM renderers that copy them into a container; the overlay rebuilds a container only when the
 * model's key changed, so these may allocate freely.
 */
import { clearChildren, el } from '../ui';
import type { LineSeverity } from './model';
import type { MdtCaseRow, PremiseView } from './types';

/** Entries of a premise history shown at most. */
export const PREMISE_ENTRIES_MAX = 6;
/** Shown when a premise has no earlier calls. */
export const PREMISE_EMPTY = 'No prior calls at this address';

const FLAG_LABELS: Readonly<Record<string, string>> = {
  weapon: 'WEAPON',
  violence: 'VIOLENCE',
  arrest: 'ARREST',
  officerSafety: 'OFFICER SAFETY',
  drugs: 'DRUGS',
  mentalHealth: 'MENTAL HEALTH',
  repeat: 'REPEAT',
};

const FLAG_SEVERITY: Readonly<Record<string, LineSeverity>> = {
  weapon: 'alert',
  violence: 'alert',
  officerSafety: 'alert',
  arrest: 'caution',
  drugs: 'caution',
  mentalHealth: 'caution',
  repeat: 'info',
};

/** 'officerSafety' -> 'OFFICER SAFETY' for flags without a label. */
function humanizeFlag(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toUpperCase();
}

export interface PremiseChip {
  readonly flag: string;
  readonly text: string;
  readonly severity: LineSeverity;
}

export interface PremiseModel {
  readonly address: string;
  readonly chips: readonly PremiseChip[];
  /** Newest first as the feed sends them, at most `PREMISE_ENTRIES_MAX`. */
  readonly entries: readonly { readonly when: string; readonly text: string }[];
  /** Entries the feed had beyond the cap. */
  readonly more: number;
  /** The empty text when there are no entries, else ''. */
  readonly empty: string;
  /** Changes whenever what is shown changes (the overlay compares it). */
  readonly key: string;
}

/** The premise block of a call: flag chips (alert for weapon / violence / officer safety), up to 6 entries, empty text. */
export function premiseModel(view: PremiseView | null): PremiseModel {
  const flags = view?.flags ?? [];
  const entries = (view?.entries ?? []).slice(0, PREMISE_ENTRIES_MAX).map((e) => ({ when: e.when, text: e.text }));
  const chips = flags.map((flag): PremiseChip => ({ flag, text: FLAG_LABELS[flag] ?? humanizeFlag(flag), severity: FLAG_SEVERITY[flag] ?? 'none' }));
  const address = view?.address ?? '';
  return {
    address,
    chips,
    entries,
    more: Math.max(0, (view?.entries.length ?? 0) - entries.length),
    empty: entries.length === 0 ? PREMISE_EMPTY : '',
    key: `${address}\t${flags.join(',')}\t${entries.map((e) => `${e.when}|${e.text}`).join('\n')}`,
  };
}

/** The PREMISE HISTORY section element (chips, entries or the empty text). */
export function renderPremise(model: PremiseModel): HTMLElement {
  const section = el('section', { class: 'mdt-section mdt-premise', 'aria-label': 'Premise history' }, el('h3', null, 'PREMISE HISTORY'));
  if (model.address !== '') section.appendChild(el('p', { class: 'mdt-premise-address' }, model.address));
  if (model.chips.length > 0) {
    section.appendChild(el('ul', { class: 'mdt-chips', 'aria-label': 'Premise flags' },
      model.chips.map((c) => el('li', { class: `mdt-chip mdt-chip-${c.severity}` }, c.text))));
  }
  if (model.entries.length === 0) {
    section.appendChild(el('p', { class: 'mdt-hint' }, model.empty));
  } else {
    section.appendChild(el('ol', { class: 'mdt-premise-entries' },
      model.entries.map((e) => el('li', null, el('time', null, e.when), ` ${e.text}`))));
    if (model.more > 0) section.appendChild(el('p', { class: 'mdt-hint' }, `${String(model.more)} older call${model.more === 1 ? '' : 's'} not shown`));
  }
  return section;
}

// --- Cases -----------------------------------------------------------------------------------------

const STATUS_ORDER: Readonly<Record<string, number>> = { open: 0, followUp: 1, cold: 2, cleared: 3 };

const STATUS_LABELS: Readonly<Record<string, string>> = {
  open: 'OPEN',
  followUp: 'FOLLOW-UP',
  cold: 'COLD',
  cleared: 'CLEARED',
};

const STATUS_SEVERITY: Readonly<Record<string, LineSeverity>> = {
  open: 'info',
  followUp: 'caution',
  cold: 'none',
  cleared: 'none',
};

export interface CaseRow {
  readonly id: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly severity: LineSeverity;
  readonly nature: string;
  readonly opened: string;
  readonly location: string;
  readonly suspects: string;
  readonly witnesses: string;
}

export interface CasesModel {
  readonly rows: readonly CaseRow[];
  /** Cases still being worked (open + follow-up). */
  readonly active: number;
  readonly empty: string;
}

/** Cases tab: open first, then follow-up, then cold and cleared; the feed's order is kept within a status. */
export function casesModel(rows: readonly MdtCaseRow[]): CasesModel {
  const indexed = rows.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => (STATUS_ORDER[a.r.status] ?? 9) - (STATUS_ORDER[b.r.status] ?? 9) || a.i - b.i);
  const sorted = indexed.map(({ r }): CaseRow => ({
    id: r.id,
    status: r.status,
    statusLabel: STATUS_LABELS[r.status] ?? r.status.toUpperCase(),
    severity: STATUS_SEVERITY[r.status] ?? 'none',
    nature: r.nature,
    opened: r.opened,
    location: r.location,
    suspects: r.suspects === '' ? 'none' : r.suspects,
    witnesses: r.witnesses === '' ? 'none' : r.witnesses,
  }));
  return { rows: sorted, active: sorted.filter((r) => r.status === 'open' || r.status === 'followUp').length, empty: 'No cases on file' };
}

/** Replaces `container` with the "no cases feed" explanation. */
export function renderNoCases(container: HTMLElement): void {
  clearChildren(container);
  container.appendChild(el('p', { class: 'mdt-hint' }, 'No case data in this session.'));
}
