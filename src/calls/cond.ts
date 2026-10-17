/**
 * Condition language (design §4.2) and the flag vocabulary (§11.3): evaluation, atom listing and the
 * disjunctive normal form used by the reachability check. Pure; no catalog dependency.
 */
import type { Cond } from './types';

/** Flags set at build time by a branch's `flags` (besides `injury:<role>` / `deceased:<role>`). */
export const BRANCH_FLAG_NAMES: readonly string[] = [
  'hitAndRun', 'medicalEmergency', 'fraudSuspected', 'suspectFled', 'misidentified', 'roadHazard', 'hazmat', 'package',
  'abandoned', 'fight', 'k9Needed', 'sceneEvidence',
];

/** Scene and contact flags without an argument (action and service `sets` come on top, per family). */
export const SCENE_FLAG_NAMES: readonly string[] = [
  'arrived', 'escalated', 'deescalated', 'vehicleStopped', 'pursuit', 'pursuitLost', 'pursuitEnded', 'shotsFired', 'attacked',
  'forceUsed', 'report', 'cited', 'crowdDispersed', 'guardianNotified', 'bacOver', 'sfstFail', 'weaponFound', 'contrabandFound',
];

/** Flags with a person-role argument: `<prefix>:<role>`. */
export const ROLE_FLAG_PREFIXES: readonly string[] = [
  'role', 'juvenile', 'injury', 'deceased', 'citation', 'left', 'found', 'near', 'revealed', 'contacted', 'statement',
  'identified', 'falseIdentity', 'custody', 'caged', 'warned', 'released', 'searched', 'frisked', 'pbt', 'sfst', 'calmed',
  'fled', 'escaped', 'caught', 'detained', 'weaponDrawn', 'transported',
];

/** Roles the variants add to a scenario (`swatting`, `ambush`); their flags are valid in every family. */
export const VARIANT_ROLES: readonly string[] = ['resident', 'ambusher'];

interface ParsedAtom {
  readonly name: string;
  readonly negated: boolean;
}

function parseAtom(atom: string): ParsedAtom {
  return atom.startsWith('!') ? { name: atom.slice(1), negated: true } : { name: atom, negated: false };
}

/** Evaluates a condition over a set of flags. */
export function evalCond(c: Cond, flags: ReadonlySet<string>): boolean {
  if (typeof c === 'string') {
    const { name, negated } = parseAtom(c);
    const value = name === 'true' || flags.has(name);
    return negated ? !value : value;
  }
  if ('all' in c) {
    for (const child of c.all) if (!evalCond(child, flags)) return false;
    return true;
  }
  if ('any' in c) {
    for (const child of c.any) if (evalCond(child, flags)) return true;
    return false;
  }
  return !evalCond(c.not, flags);
}

/** Distinct flag names used by a condition, in first-use order, without `!` and without `true`. */
export function condAtoms(c: Cond): string[] {
  const out: string[] = [];
  const walk = (x: Cond): void => {
    if (typeof x === 'string') {
      const { name } = parseAtom(x);
      if (name !== 'true' && !out.includes(name)) out.push(name);
    } else if ('all' in x) {
      x.all.forEach(walk);
    } else if ('any' in x) {
      x.any.forEach(walk);
    } else {
      walk(x.not);
    }
  };
  walk(c);
  return out;
}

/** A conjunction of positive and negated atoms. */
export interface Term {
  readonly pos: readonly string[];
  readonly neg: readonly string[];
}

/** Guard against pathological conditions. */
const MAX_TERMS = 512;

function andTerms(a: readonly Term[], b: readonly Term[]): Term[] {
  const out: Term[] = [];
  for (const x of a) {
    for (const y of b) {
      const pos = [...new Set([...x.pos, ...y.pos])];
      const neg = [...new Set([...x.neg, ...y.neg])];
      if (pos.some((p) => neg.includes(p))) continue;
      out.push({ pos, neg });
      if (out.length > MAX_TERMS) throw new Error('Condition expands to too many terms');
    }
  }
  return out;
}

function dnf(c: Cond, negate: boolean): Term[] {
  if (typeof c === 'string') {
    const { name, negated } = parseAtom(c);
    const neg = negate !== negated;
    if (name === 'true') return neg ? [] : [{ pos: [], neg: [] }];
    return [neg ? { pos: [], neg: [name] } : { pos: [name], neg: [] }];
  }
  if ('not' in c) return dnf(c.not, !negate);
  const children = 'all' in c ? c.all : c.any;
  // De Morgan: a negated `all` is an `any` of negations and vice versa.
  const conjunctive = 'all' in c !== negate;
  if (conjunctive) {
    let acc: Term[] = [{ pos: [], neg: [] }];
    for (const child of children) acc = andTerms(acc, dnf(child, negate));
    return acc;
  }
  const out: Term[] = [];
  for (const child of children) out.push(...dnf(child, negate));
  if (out.length > MAX_TERMS) throw new Error('Condition expands to too many terms');
  return out;
}

/** Disjunctive normal form: the condition holds when any term holds (no terms = never). */
export function toDnf(c: Cond): Term[] {
  return dnf(c, false);
}
