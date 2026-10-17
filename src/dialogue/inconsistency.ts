import type { PersonFact } from '../people';
import { RULES as LOADED_RULES, type InconsistencyRule } from './data';

/**
 * Lie-detection engine (design §9.5). Pure: the only input is the list of facts the player has
 * discovered about one person. Undiscovered truth is never an input, so it can never appear.
 */

export type { InconsistencyRule } from './data';
export const RULES: readonly InconsistencyRule[] = LOADED_RULES;

/** A fact the player knows (the people module's `PersonFact`). */
export type KnownFact = PersonFact;

export interface Inconsistency {
  /** `ruleId:factA:factB`, stable across calls. */
  readonly key: string;
  readonly ruleId: string;
  readonly topic: string;
  readonly factA: number;
  readonly factB: number;
  readonly text: string;
  readonly severity: 'caution' | 'alert';
}

/** Values that mean "nothing found" for a denial comparison. */
const ABSENT = new Set(['', 'NO', 'NOTHING', 'NONE']);
const HAIR_FADED = new Set(['gray', 'grey', 'bald']);

function norm(value: string): string {
  return value.trim().toUpperCase();
}

interface Look {
  readonly sex: string;
  readonly age: number;
  readonly height: number;
  readonly hair: string;
}

/** Parses `"M|34|182|brown"` (sex | age | height cm | hair). */
function parseLook(value: string): Look | null {
  const parts = value.split('|');
  if (parts.length !== 4) return null;
  const age = Number(parts[1]);
  const height = Number(parts[2]);
  if (!Number.isFinite(age) || !Number.isFinite(height)) return null;
  return { sex: (parts[0] ?? '').trim().toUpperCase(), age, height, hair: (parts[3] ?? '').trim().toLowerCase() };
}

function looksDiffer(a: Look, b: Look): boolean {
  if (a.sex !== b.sex) return true;
  if (Math.abs(a.age - b.age) > 10) return true;
  if (Math.abs(a.height - b.height) > 12) return true;
  if (a.hair !== b.hair) {
    const faded = (HAIR_FADED.has(a.hair) || HAIR_FADED.has(b.hair)) && Math.max(a.age, b.age) >= 45;
    return !faded;
  }
  return false;
}

/** The document name fact that `idCard` compares an `onFile:NAME` record against: the latest one of the same incident. */
function documentName(a: PersonFact, facts: readonly PersonFact[]): string | null {
  let best: PersonFact | null = null;
  for (const f of facts) {
    if (f.incident === a.incident && f.topic === 'name' && f.source === 'document' && (best === null || f.id > best.id)) best = f;
  }
  return best === null ? null : norm(best.value);
}

/**
 * True when facts `a` (the rule's first source) and `b` (the second) contradict under `rule`. `facts`
 * (the whole input) is only read by `idCard`, which needs the document's name fact.
 */
export function compareFacts(rule: InconsistencyRule, a: PersonFact, b: PersonFact, facts: readonly PersonFact[] = []): boolean {
  switch (rule.compare) {
    case 'equal': {
      const x = norm(a.value);
      const y = norm(b.value);
      if (x === 'OTHER' || y === 'OTHER') return false;
      return x !== y;
    }
    case 'denial': {
      const x = norm(a.value);
      const y = norm(b.value);
      if ((x === 'NO' || x === 'NOTHING') && !ABSENT.has(y)) return true;
      return x === 'SOME' && y === 'HEAVY';
    }
    case 'appearance': {
      const x = parseLook(a.value);
      const y = parseLook(b.value);
      return x !== null && y !== null && looksDiffer(x, y);
    }
    case 'idCard': {
      const y = norm(b.value);
      if (y === 'NOTONFILE') return true;
      if (!y.startsWith('ONFILE:')) return false;
      const doc = documentName(a, facts);
      return doc !== null && y.slice('ONFILE:'.length).trim() !== doc;
    }
    case 'notOnFile':
      return norm(b.value) === 'NOTONFILE';
  }
}

function formatText(rule: InconsistencyRule, a: PersonFact, b: PersonFact): string {
  const vars: Readonly<Record<string, string>> = { a: a.display, b: b.display, aDetail: a.detail, bDetail: b.detail };
  return rule.text.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? '');
}

function make(rule: InconsistencyRule, a: PersonFact, b: PersonFact): Inconsistency {
  return { key: `${rule.id}:${a.id}:${b.id}`, ruleId: rule.id, topic: rule.topic, factA: a.id, factB: b.id, text: formatText(rule, a, b), severity: rule.severity };
}

/**
 * Every contradiction among `facts` (facts of ONE person; facts of different incidents are never paired).
 * Claim-versus-claim rules compare each claim with the previous one of the same topic; other rules pair every
 * fact of the first source with every fact of the second. Sorted by the later fact's id, then by key.
 */
export function findInconsistencies(facts: readonly PersonFact[], rules: readonly InconsistencyRule[] = RULES): Inconsistency[] {
  const out: Inconsistency[] = [];
  const byIncident = new Map<string, PersonFact[]>();
  for (const f of facts) {
    let list = byIncident.get(f.incident);
    if (!list) byIncident.set(f.incident, (list = []));
    list.push(f);
  }
  for (const group of byIncident.values()) {
    group.sort((x, y) => x.id - y.id);
    for (const rule of rules) {
      if (rule.a === rule.b) {
        let prev: PersonFact | null = null;
        for (const f of group) {
          if (f.topic !== rule.topic || f.source !== rule.a || norm(f.value) === 'OTHER') continue;
          if (prev !== null && compareFacts(rule, prev, f, group)) out.push(make(rule, prev, f));
          prev = f;
        }
        continue;
      }
      for (const fa of group) {
        if (fa.topic !== rule.topic || fa.source !== rule.a) continue;
        for (const fb of group) {
          if (fb.topic !== rule.topic || fb.source !== rule.b) continue;
          if (compareFacts(rule, fa, fb, group)) out.push(make(rule, fa, fb));
        }
      }
    }
  }
  out.sort((x, y) => {
    const lx = Math.max(x.factA, x.factB);
    const ly = Math.max(y.factA, y.factB);
    return lx !== ly ? lx - ly : x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
  return out;
}
