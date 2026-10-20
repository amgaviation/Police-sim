import commendationsJson from '../data/conduct/commendations.json';
import disciplineJson from '../data/conduct/discipline.json';
import iaJson from '../data/conduct/ia.json';
import trustJson from '../data/conduct/trust.json';
import { DOCTRINES, type Doctrine, type ForceLevel, FORCE_LEVELS, type Outcome } from '../legal/types';

/**
 * Conduct data (Phase 5 design 10.1): `src/data/conduct/*.json` validated at import. Every parser failure throws
 * `Error('<file>: <dotted.path>: <problem>')`.
 */

export const IA_SEVERITIES = ['minor', 'major', 'critical'] as const;
export type IaSeverity = (typeof IA_SEVERITIES)[number];

// --- Config types ------------------------------------------------------------------------------

export const TRUST_DELTA_KEYS = [
  'lawfulArrest', 'unlawfulDetention', 'unlawfulSearch', 'unlawfulArrest', 'mirandaViolation', 'excessiveForce',
  'questionableForce', 'justifiedForce', 'injuryMultiplier', 'fatalMultiplier', 'deEscalation', 'courteousContact',
  'aggressiveLine', 'conviction', 'dismissedMisconduct', 'missedCourt', 'commendation', 'sustainedIa', 'civilSuit',
] as const;
export type TrustDeltaKey = (typeof TRUST_DELTA_KEYS)[number];

export interface TrustConfig {
  readonly min: number;
  readonly max: number;
  /** Fraction of a district's delta that every other district receives. */
  readonly spill: number;
  /** Exponential drift rate toward the baseline per game day. */
  readonly driftPerDay: number;
  readonly deltas: Readonly<Record<TrustDeltaKey, number>>;
  readonly effects: {
    /** [trust 0, trust 1]. */
    readonly errorScale: readonly [number, number];
    readonly crimeFactor: readonly [number, number];
    readonly hostilityThreshold: number;
    readonly hostilityScale: number;
  };
}

export type IaRule = { readonly id: string; readonly severity: IaSeverity; readonly minCount: number } & (
  | { readonly when: 'forceVerdict'; readonly verdict: 'justified' | 'questionable' | 'excessive' }
  | { readonly when: 'forceTool'; readonly level: ForceLevel }
  | { readonly when: 'doctrine'; readonly doctrine: Doctrine; readonly outcome: Outcome }
  | { readonly when: 'injury'; readonly minInjury: number }
  | { readonly when: 'complaint' }
);

export interface IaConfig {
  readonly complaint: { readonly base: number; readonly perAggressiveLine: number; readonly lowTrust: number; readonly max: number };
  /** Game hours after which an IA case without a statement resolves with the statement `none`. */
  readonly autoResolveH: number;
  readonly rules: readonly IaRule[];
}

export interface LadderStep {
  readonly action: 'counseling' | 'writtenReprimand' | 'suspension' | 'termination';
  /** Game hours (suspension only). */
  readonly hours: number;
}

export interface DisciplineConfig {
  readonly ladder: Readonly<Record<IaSeverity, readonly LadderStep[]>>;
  readonly civilSuit: { readonly minInjury: number; readonly base: number; readonly perInjury: number };
  readonly criminal: { readonly fatal: boolean; readonly firearmMinInjury: number };
  readonly credibility: { readonly untruthful: number; readonly sustained: number };
  /** Career points per discipline action id (missing = 0). */
  readonly points: Readonly<Record<string, number>>;
}

export interface CommendationRule {
  readonly id: string;
  readonly label: string;
  readonly points: number;
  readonly withinS?: number;
  readonly minScore?: number;
  readonly minReport?: number;
}

export interface CommendationConfig {
  readonly rules: readonly CommendationRule[];
}

export interface ConductConfigs {
  readonly trust: TrustConfig;
  readonly ia: IaConfig;
  readonly discipline: DisciplineConfig;
  readonly commendations: CommendationConfig;
}

// --- Validation helpers ------------------------------------------------------------------------

type Json = Record<string, unknown>;

function fail(file: string, path: string, problem: string): never {
  throw new Error(`${file}: ${path === '' ? '(root)' : path}: ${problem}`);
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function obj(v: unknown, file: string, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(file, path, `must be an object, got ${show(v)}`);
  return v as Json;
}

function str(v: unknown, file: string, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(file, path, `must be a non-empty string, got ${show(v)}`);
  return v;
}

function num(v: unknown, file: string, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(file, path, `must be a finite number, got ${show(v)}`);
  if (v < min || v > max) fail(file, path, `must be in [${min}, ${max}], got ${v}`);
  return v;
}

function oneOf<T extends string>(v: unknown, options: readonly T[], file: string, path: string): T {
  if (typeof v !== 'string' || !(options as readonly string[]).includes(v)) {
    fail(file, path, `must be one of ${options.join(', ')}, got ${show(v)}`);
  }
  return v as T;
}

function arr(v: unknown, file: string, path: string, minLength = 0): unknown[] {
  if (!Array.isArray(v)) fail(file, path, `must be an array, got ${show(v)}`);
  if (v.length < minLength) fail(file, path, `must have at least ${minLength} items, got ${v.length}`);
  return v;
}

function version(r: Json, file: string): void {
  if (r.version !== 1) fail(file, 'version', `must be 1, got ${show(r.version)}`);
}

function pair(v: unknown, file: string, path: string, min: number, max: number): readonly [number, number] {
  const a = arr(v, file, path);
  if (a.length !== 2) fail(file, path, `must have exactly 2 numbers, got ${a.length}`);
  return [num(a[0], file, `${path}[0]`, min, max), num(a[1], file, `${path}[1]`, min, max)];
}

// --- Parsers -----------------------------------------------------------------------------------

/** Parses `trust.json`. */
export function parseTrustConfig(raw: unknown, file = 'trust.json'): TrustConfig {
  const r = obj(raw, file, '');
  version(r, file);
  const min = num(r.min, file, 'min', 0, 1);
  const max = num(r.max, file, 'max', 0, 1);
  if (min >= max) fail(file, 'max', `must be greater than min (${min}), got ${max}`);
  const d = obj(r.deltas, file, 'deltas');
  const deltas = {} as Record<TrustDeltaKey, number>;
  for (const k of TRUST_DELTA_KEYS) deltas[k] = num(d[k], file, `deltas.${k}`, -10, 10);
  for (const k of Object.keys(d)) if (!(TRUST_DELTA_KEYS as readonly string[]).includes(k)) fail(file, `deltas.${k}`, 'is not a known delta');
  const e = obj(r.effects, file, 'effects');
  return {
    min,
    max,
    spill: num(r.spill, file, 'spill', 0, 1),
    driftPerDay: num(r.driftPerDay, file, 'driftPerDay', 0, 10),
    deltas,
    effects: {
      errorScale: pair(e.errorScale, file, 'effects.errorScale', 0, 100),
      crimeFactor: pair(e.crimeFactor, file, 'effects.crimeFactor', 0, 100),
      hostilityThreshold: num(e.hostilityThreshold, file, 'effects.hostilityThreshold', 0, 1),
      hostilityScale: num(e.hostilityScale, file, 'effects.hostilityScale', 0, 100),
    },
  };
}

const OUTCOMES = ['lawful', 'unlawful', 'questionable'] as const;
const FORCE_VERDICTS = ['justified', 'questionable', 'excessive'] as const;
const WHEN = ['forceVerdict', 'forceTool', 'doctrine', 'injury', 'complaint'] as const;

/** Parses `ia.json`. */
export function parseIaConfig(raw: unknown, file = 'ia.json'): IaConfig {
  const r = obj(raw, file, '');
  version(r, file);
  const c = obj(r.complaint, file, 'complaint');
  const ids = new Set<string>();
  const rules = arr(r.rules, file, 'rules', 1).map((v, i): IaRule => {
    const path = `rules[${i}]`;
    const o = obj(v, file, path);
    const id = str(o.id, file, `${path}.id`);
    if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    ids.add(id);
    const base = {
      id,
      severity: oneOf(o.severity, IA_SEVERITIES, file, `${path}.severity`),
      minCount: o.minCount === undefined ? 1 : num(o.minCount, file, `${path}.minCount`, 1, 1000),
    };
    const when = oneOf(o.when, WHEN, file, `${path}.when`);
    switch (when) {
      case 'forceVerdict':
        return { ...base, when, verdict: oneOf(o.verdict, FORCE_VERDICTS, file, `${path}.verdict`) };
      case 'forceTool':
        return { ...base, when, level: oneOf(o.level, FORCE_LEVELS, file, `${path}.level`) };
      case 'doctrine':
        return { ...base, when, doctrine: oneOf(o.doctrine, DOCTRINES, file, `${path}.doctrine`), outcome: oneOf(o.outcome, OUTCOMES, file, `${path}.outcome`) };
      case 'injury':
        return { ...base, when, minInjury: num(o.minInjury, file, `${path}.minInjury`, 0, 1) };
      case 'complaint':
        return { ...base, when };
    }
  });
  return {
    complaint: {
      base: num(c.base, file, 'complaint.base', 0, 1),
      perAggressiveLine: num(c.perAggressiveLine, file, 'complaint.perAggressiveLine', 0, 1),
      lowTrust: num(c.lowTrust, file, 'complaint.lowTrust', 0, 10),
      max: num(c.max, file, 'complaint.max', 0, 1),
    },
    autoResolveH: num(r.autoResolveH, file, 'autoResolveH', 0, 24 * 365),
    rules,
  };
}

const LADDER_ACTIONS = ['counseling', 'writtenReprimand', 'suspension', 'termination'] as const;

function parseStep(v: unknown, file: string, path: string): LadderStep {
  const s = str(v, file, path);
  const [name, hours, ...rest] = s.split(':');
  const action = oneOf(name, LADDER_ACTIONS, file, path);
  if (rest.length > 0) fail(file, path, `has too many ':' parts, got ${show(s)}`);
  if (action === 'suspension') {
    const h = Number(hours);
    if (hours === undefined || hours === '' || !Number.isFinite(h) || h <= 0) fail(file, path, `suspension needs hours like "suspension:8", got ${show(s)}`);
    return { action, hours: h };
  }
  if (hours !== undefined) fail(file, path, `only suspension takes hours, got ${show(s)}`);
  return { action, hours: 0 };
}

/** Parses `discipline.json`. */
export function parseDisciplineConfig(raw: unknown, file = 'discipline.json'): DisciplineConfig {
  const r = obj(raw, file, '');
  version(r, file);
  const l = obj(r.ladder, file, 'ladder');
  const ladder = {} as Record<IaSeverity, readonly LadderStep[]>;
  for (const s of IA_SEVERITIES) ladder[s] = arr(l[s], file, `ladder.${s}`, 1).map((v, i) => parseStep(v, file, `ladder.${s}[${i}]`));
  const cs = obj(r.civilSuit, file, 'civilSuit');
  const cr = obj(r.criminal, file, 'criminal');
  if (typeof cr.fatal !== 'boolean') fail(file, 'criminal.fatal', `must be true or false, got ${show(cr.fatal)}`);
  const cd = obj(r.credibility, file, 'credibility');
  const p = obj(r.points, file, 'points');
  const points: Record<string, number> = {};
  for (const k of Object.keys(p)) points[k] = num(p[k], file, `points.${k}`, -1000, 1000);
  return {
    ladder,
    civilSuit: {
      minInjury: num(cs.minInjury, file, 'civilSuit.minInjury', 0, 1),
      base: num(cs.base, file, 'civilSuit.base', 0),
      perInjury: num(cs.perInjury, file, 'civilSuit.perInjury', 0),
    },
    criminal: { fatal: cr.fatal, firearmMinInjury: num(cr.firearmMinInjury, file, 'criminal.firearmMinInjury', 0, 1) },
    credibility: {
      untruthful: num(cd.untruthful, file, 'credibility.untruthful', -1, 0),
      sustained: num(cd.sustained, file, 'credibility.sustained', -1, 0),
    },
    points,
  };
}

/** Parses `commendations.json`. */
export function parseCommendationConfig(raw: unknown, file = 'commendations.json'): CommendationConfig {
  const r = obj(raw, file, '');
  version(r, file);
  const ids = new Set<string>();
  const rules = arr(r.rules, file, 'rules', 1).map((v, i): CommendationRule => {
    const path = `rules[${i}]`;
    const o = obj(v, file, path);
    const id = str(o.id, file, `${path}.id`);
    if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    ids.add(id);
    const rule: { -readonly [K in keyof CommendationRule]: CommendationRule[K] } = {
      id,
      label: str(o.label, file, `${path}.label`),
      points: num(o.points, file, `${path}.points`, 0, 1000),
    };
    if (o.withinS !== undefined) rule.withinS = num(o.withinS, file, `${path}.withinS`, 0, 36000);
    if (o.minScore !== undefined) rule.minScore = num(o.minScore, file, `${path}.minScore`, 0, 100);
    if (o.minReport !== undefined) rule.minReport = num(o.minReport, file, `${path}.minReport`, 0, 100);
    return rule;
  });
  return { rules };
}

// --- Loaded tables -----------------------------------------------------------------------------

export const TRUST_CONFIG: TrustConfig = parseTrustConfig(trustJson);
export const IA_CONFIG: IaConfig = parseIaConfig(iaJson);
export const DISCIPLINE_CONFIG: DisciplineConfig = parseDisciplineConfig(disciplineJson);
export const COMMENDATION_CONFIG: CommendationConfig = parseCommendationConfig(commendationsJson);

/** The shipped configuration set. */
export const CONDUCT_CONFIGS: ConductConfigs = {
  trust: TRUST_CONFIG,
  ia: IA_CONFIG,
  discipline: DISCIPLINE_CONFIG,
  commendations: COMMENDATION_CONFIG,
};

/** The commendation rule with `id`, or undefined. */
export function commendationRule(cfg: CommendationConfig, id: string): CommendationRule | undefined {
  return cfg.rules.find((r) => r.id === id);
}
