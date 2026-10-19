/** Case file view model (design phase 4 §10.4): plain rows of text for the CaseFilePanel. Pure. */
import {
  verifyLedger,
  type CaseFile,
  type CustodyAction,
  type CustodyLedger,
  type EvidenceItem,
  type ItemCustodyState,
  type SearchBasis,
} from '../evidence';

export const CASE_TABS = ['items', 'photos', 'prints', 'canvass', 'custody', 'consents', 'statements'] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export const CASE_TAB_LABELS: Readonly<Record<CaseTab, string>> = {
  items: 'Items',
  photos: 'Photos',
  prints: 'Prints',
  canvass: 'Canvass',
  custody: 'Custody',
  consents: 'Consents',
  statements: 'Statements',
};

export interface CaseRow {
  /** Item id, photo id, '#<seq>' ... */
  readonly id: string;
  readonly text: string;
  readonly detail: string;
  /** Photo thumbnail data URL when the shutter press has one. */
  readonly thumb: string | null;
  /** Evidence item of the row (items tab), else null. */
  readonly itemId: string | null;
  /** The custody step Enter performs on this row, null when none is possible. */
  readonly next: CustodyAction | null;
}

export interface CaseFileView {
  readonly callId: number;
  readonly incident: string;
  readonly title: string;
  /** 'Chain intact' or a description of the first custody issue. */
  readonly verdict: string;
  readonly chainOk: boolean;
  readonly tabs: Readonly<Record<CaseTab, readonly CaseRow[]>>;
}

const BASIS_LABEL: Readonly<Record<SearchBasis, string>> = {
  plainView: 'plain view',
  consent: 'consent',
  warrant: 'warrant',
  incidentToArrest: 'incident to arrest',
  exigency: 'exigency',
  protectiveSweep: 'protective sweep',
  publicArea: 'public area',
};

const CANVASS_LABEL: Readonly<Record<CaseFile['canvass'][number]['result'], string>> = {
  noAnswer: 'No answer',
  nothingSeen: 'Saw nothing',
  sawSomething: 'Saw something',
  refused: 'Declined to talk',
};

/** 'HH:MM' of a game-seconds timestamp. */
export function clockText(game: number): string {
  const day = ((Math.floor(game) % 86400) + 86400) % 86400;
  const h = Math.floor(day / 3600);
  const m = Math.floor((day % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Status text and next custody step of a found or collected item. */
export function itemStatus(item: EvidenceItem, state: ItemCustodyState, custodian: string): { text: string; next: CustodyAction | null } {
  let text: string;
  let next: CustodyAction | null;
  if (item.state === 'found') {
    text = `Found (${item.foundBasis === null ? 'no lawful basis' : BASIS_LABEL[item.foundBasis]})`;
    next = 'collect';
  } else if (state === 'bagged') {
    text = 'Bagged';
    next = 'tag';
  } else if (state === 'tagged') {
    text = custodian === '' ? 'Tagged' : `Tagged (${custodian})`;
    next = 'deposit';
  } else if (state === 'deposited') {
    text = 'Deposited';
    next = null;
  } else {
    text = 'Collected';
    next = 'bag';
  }
  return { text: item.suppressed ? `${text} · SUPPRESSED` : text, next };
}

/** Builds the view of one case file; `describePerson` names a person id. */
export function buildCaseView(file: CaseFile, ledger: CustodyLedger, describePerson: (personId: number) => string): CaseFileView {
  const items: CaseRow[] = [];
  for (const it of file.items) {
    if (it.state === 'inPlace') continue;
    const st = itemStatus(it, ledger.state(it.id), ledger.custodian(it.id));
    items.push({
      id: it.id,
      text: `${it.markerNo > 0 ? `#${String(it.markerNo)} ` : ''}${it.label}`,
      detail: st.text,
      thumb: null,
      itemId: it.id,
      next: st.next,
    });
  }
  const photos: CaseRow[] = file.photos.map((p) => ({
    id: p.id,
    text: p.caption,
    detail: `${clockText(p.game)} · ${String(p.subjects.length)} subject${p.subjects.length === 1 ? '' : 's'}`,
    thumb: p.thumb,
    itemId: null,
    next: null,
  }));
  const prints: CaseRow[] = file.prints.map((p) => ({
    id: p.id,
    text: `Latent print · quality ${String(Math.round(p.quality * 100))}%`,
    detail: p.personId >= 0 ? describePerson(p.personId) : 'Unknown',
    thumb: null,
    itemId: p.itemId,
    next: null,
  }));
  const canvass: CaseRow[] = file.canvass.map((c, i) => ({
    id: `canvass-${String(i)}`,
    text: c.text,
    detail: CANVASS_LABEL[c.result],
    thumb: null,
    itemId: null,
    next: null,
  }));
  const prefix = `E-${String(file.callId)}-`;
  const custody: CaseRow[] = [];
  for (const e of ledger.entries()) {
    if (!e.itemId.startsWith(prefix)) continue;
    custody.push({
      id: `#${String(e.seq)}`,
      text: `#${String(e.seq)} ${e.action.toUpperCase()} ${e.itemId}`,
      detail: `${e.from} → ${e.to} · ${clockText(e.game)}`,
      thumb: null,
      itemId: e.itemId,
      next: null,
    });
  }
  const consents: CaseRow[] = file.consents.map((c) => {
    const flags: string[] = [c.granted ? 'granted' : 'declined'];
    if (c.granted && !c.valid) flags.push('not freely given');
    if (c.granted && !c.authority) flags.push('no authority');
    if (c.revokedSim >= 0) flags.push('revoked');
    return {
      id: `consent-${String(c.id)}`,
      text: `${c.kind} · ${flags.join(', ')}`,
      detail: c.personId >= 0 ? describePerson(c.personId) : '',
      thumb: null,
      itemId: null,
      next: null,
    };
  });
  const statements: CaseRow[] = file.statements.map((s, i) => ({
    id: `statement-${String(i)}`,
    text: `${s.role}: ${s.text}`,
    detail: s.personId >= 0 ? describePerson(s.personId) : '',
    thumb: null,
    itemId: null,
    next: null,
  }));
  const verdict = verifyLedger(ledger.entries());
  const first = verdict.issues[0];
  return {
    callId: file.callId,
    incident: file.incident,
    title: file.title,
    verdict: first === undefined ? 'Chain intact' : `Chain broken: ${String(verdict.issues.length)} issue${verdict.issues.length === 1 ? '' : 's'} (${first.text})`,
    chainOk: verdict.ok,
    tabs: { items, photos, prints, canvass, custody, consents, statements },
  };
}
