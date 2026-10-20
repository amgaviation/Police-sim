import type { IncidentEvent, IncidentLog, PursuitSampleEvent, PursuitStartEvent } from '../legal/types';

/**
 * Runtime index of one incident log. Everything here is derived from `log.events`, so a restored or merged log is re-indexed with
 * `rebuild` and nothing but the log itself is saved.
 */
export interface Rt {
  log: IncidentLog;
  /** Bumped on every change of the log (assessment and report caches are keyed on it). */
  version: number;
  /** Sim time of the last event that is not a camera change. */
  lastSim: number;
  persons: Set<number>;
  detained: Set<number>;
  /** Persons currently under arrest (cleared by a release). */
  arrested: Set<number>;
  /** Dedupe keys of indicator events. */
  indKeys: Set<string>;
  /** Building -> first entry event id. */
  entries: Map<number, number>;
  /** Item ref -> latest event that found it (frisk, search or plain view indicator). */
  found: Map<string, number>;
  /** `<personId>|<pbt|sfst>` -> latest test event. */
  tests: Map<string, { id: number; t: number }>;
  /** Person -> latest frisk / search event. */
  finds: Map<number, { id: number; t: number }>;
  /** `otherForce.seq` -> event id. */
  otherSeq: Map<number, number>;
  lastOther: number;
  /** The call's own facts (exigency, warrant, suspects) were logged. */
  callFacts: boolean;
  /** Sim time of the latest exigency event (-1 none). */
  exigencySim: number;
  /** A first detention / frisk / search / force was logged (the bodycam advisory is checked once). */
  camChecked: boolean;
  /** Person -> custody at the latest question. */
  custody: Map<number, boolean>;
  /** The open vehicle pursuit and its samples. */
  pursuit: PursuitStartEvent | null;
  samples: PursuitSampleEvent[];
  /** The force event of a scene `sidearmDrawn` that the force system's display event may refine. */
  display: { id: number; personId: number; t: number } | null;
}

const REF_AT_END = /\(([^()]+)\)$/;

export function indKey(personId: number, indicator: string, sourceEvent: number): string {
  return `${personId}|${indicator}|${sourceEvent}`;
}

/** Detail text of an observed item: the label with the item ref in brackets (the ref is recovered by `note`). */
export function itemDetail(label: string, ref: string): string {
  return `${label} (${ref})`;
}

export function newRt(log: IncidentLog): Rt {
  return {
    log, version: 0, lastSim: log.openedSim, persons: new Set(), detained: new Set(), arrested: new Set(), indKeys: new Set(),
    entries: new Map(), found: new Map(), tests: new Map(), finds: new Map(), otherSeq: new Map(), lastOther: -1, callFacts: false, exigencySim: -1,
    camChecked: false, custody: new Map(), pursuit: null, samples: [], display: null,
  };
}

/** Updates the index for an event that was just appended (or is being replayed by `rebuild`). */
export function note(rt: Rt, e: IncidentEvent): void {
  if (e.kind !== 'cam' && e.t > rt.lastSim) rt.lastSim = e.t;
  switch (e.kind) {
    case 'person':
      rt.persons.add(e.personId);
      break;
    case 'indicator': {
      rt.indKeys.add(indKey(e.personId, e.indicator, e.sourceEvent));
      if (e.source === 'call') rt.callFacts = true;
      if (e.source === 'observation') {
        const m = REF_AT_END.exec(e.detail);
        if (m?.[1]) rt.found.set(m[1], e.id);
      }
      break;
    }
    case 'detention':
      rt.detained.add(e.personId);
      rt.camChecked = true;
      break;
    case 'arrest':
      rt.arrested.add(e.personId);
      break;
    case 'release':
      rt.arrested.delete(e.personId);
      break;
    case 'entry':
      if (!rt.entries.has(e.buildingId)) rt.entries.set(e.buildingId, e.id);
      break;
    case 'frisk':
    case 'search':
      for (const it of e.found) rt.found.set(it.ref, e.id);
      rt.finds.set(e.personId, { id: e.id, t: e.t });
      rt.camChecked = true;
      break;
    case 'force':
      rt.camChecked = true;
      break;
    case 'test':
      rt.tests.set(`${e.personId}|${e.test}`, { id: e.id, t: e.t });
      break;
    case 'otherForce':
      rt.otherSeq.set(e.seq, e.id);
      rt.lastOther = e.id;
      break;
    case 'question':
      rt.custody.set(e.personId, e.custody);
      break;
    case 'exigency':
      if (e.reason === 'call') rt.callFacts = true;
      rt.exigencySim = e.t;
      break;
    case 'warrant':
      rt.callFacts = true;
      break;
    case 'advisory':
      if (e.advisory === 'activateBodycam') rt.camChecked = true;
      break;
    case 'pursuitStart':
      if (e.pursuit === 'vehicle') {
        rt.pursuit = e;
        rt.samples = [];
      }
      break;
    case 'pursuitSample':
      if (rt.pursuit) rt.samples.push(e);
      break;
    case 'pursuitEnd':
      if (rt.pursuit && rt.pursuit.personId === e.personId) rt.pursuit = null;
      break;
    default:
      break;
  }
}

/** Re-derives the whole index from the log's events. */
export function rebuild(rt: Rt): void {
  const { log } = rt;
  rt.lastSim = log.openedSim;
  rt.persons.clear();
  rt.detained.clear();
  rt.arrested.clear();
  rt.indKeys.clear();
  rt.entries.clear();
  rt.found.clear();
  rt.tests.clear();
  rt.finds.clear();
  rt.otherSeq.clear();
  rt.lastOther = -1;
  rt.callFacts = false;
  rt.exigencySim = -1;
  rt.camChecked = false;
  rt.custody.clear();
  rt.pursuit = null;
  rt.samples = [];
  rt.display = null;
  for (const e of log.events) note(rt, e);
  rt.version++;
}

/** Merges two lists sorted by (t, id). */
export function mergeSorted(a: readonly IncidentEvent[], b: readonly IncidentEvent[]): IncidentEvent[] {
  const out: IncidentEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i] as IncidentEvent;
    const y = b[j] as IncidentEvent;
    if (x.t < y.t || (x.t === y.t && x.id <= y.id)) {
      out.push(x);
      i++;
    } else {
      out.push(y);
      j++;
    }
  }
  while (i < a.length) out.push(a[i++] as IncidentEvent);
  while (j < b.length) out.push(b[j++] as IncidentEvent);
  return out;
}
