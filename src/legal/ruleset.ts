import {
  DOCTRINES,
  FORCE_LEVELS,
  INCIDENT_EVENT_KINDS,
  INDICATORS,
  OFFENSES,
  RESISTANCE_LEVELS,
  type ForceLevel,
  type IndicatorDef,
  type Offense,
  type OffenseDef,
  type Resistance,
  type RuleDef,
  type Ruleset,
} from './types';

/**
 * Jurisdiction rulesets (design §5.1): `src/data/legal/rulesets/*.json` validated at import. Every parser failure throws
 * `Error('<file>: <dotted.path>: <problem>')`.
 */

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

function bool(v: unknown, file: string, path: string): boolean {
  if (typeof v !== 'boolean') fail(file, path, `must be true or false, got ${show(v)}`);
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

function strList<T extends string = string>(v: unknown, file: string, path: string, allowed?: readonly T[]): T[] {
  return arr(v, file, path).map((x, i) => (allowed ? oneOf(x, allowed, file, `${path}[${i}]`) : (str(x, file, `${path}[${i}]`) as T)));
}

/** Parses and validates one ruleset file. */
export function parseRuleset(raw: unknown, file: string): Ruleset {
  const root = obj(raw, file, '');
  if (root.version !== 1) fail(file, 'version', `must be 1, got ${show(root.version)}`);
  const id = str(root.id, file, 'id');
  const name = str(root.name, file, 'name');
  const description = str(root.description, file, 'description');

  const ruleIds = new Set<string>();
  const rules: RuleDef[] = arr(root.rules, file, 'rules', 1).map((v, i) => {
    const path = `rules[${i}]`;
    const o = obj(v, file, path);
    const rid = str(o.id, file, `${path}.id`);
    if (ruleIds.has(rid)) fail(file, `${path}.id`, `duplicates ${show(rid)}`);
    ruleIds.add(rid);
    return {
      id: rid,
      doctrine: oneOf(o.doctrine, DOCTRINES, file, `${path}.doctrine`),
      title: str(o.title, file, `${path}.title`),
      cite: str(o.cite, file, `${path}.cite`),
      text: str(o.text, file, `${path}.text`),
    };
  });
  const rid = (v: unknown, path: string): string => {
    const s = str(v, file, path);
    if (!ruleIds.has(s)) fail(file, path, `references unknown rule id ${show(s)}`);
    return s;
  };

  const indObj = obj(root.indicators, file, 'indicators');
  for (const key of Object.keys(indObj)) {
    if (!(INDICATORS as readonly string[]).includes(key)) fail(file, `indicators.${key}`, 'is not a known indicator');
  }
  const indicators: Record<string, IndicatorDef> = {};
  for (const key of INDICATORS) {
    const path = `indicators.${key}`;
    if (indObj[key] === undefined) fail(file, path, 'is missing');
    const o = obj(indObj[key], file, path);
    indicators[key] = {
      label: str(o.label, file, `${path}.label`),
      offense: oneOf(o.offense, OFFENSES, file, `${path}.offense`),
      rs: num(o.rs, file, `${path}.rs`, 0),
      pc: num(o.pc, file, `${path}.pc`, 0),
      armed: num(o.armed, file, `${path}.armed`, 0),
    };
  }

  const offObj = obj(root.offenses, file, 'offenses');
  const offenses = {} as Record<Offense, OffenseDef>;
  for (const key of OFFENSES) {
    const path = `offenses.${key}`;
    if (offObj[key] === undefined) fail(file, path, 'is missing');
    const o = obj(offObj[key], file, path);
    offenses[key] = {
      label: str(o.label, file, `${path}.label`),
      severity: num(o.severity, file, `${path}.severity`, 0),
      arrestable: bool(o.arrestable, file, `${path}.arrestable`),
      vehicleEvidence: bool(o.vehicleEvidence, file, `${path}.vehicleEvidence`),
    };
  }

  const offenseMap = (v: unknown, path: string): Record<string, Offense> => {
    const o = obj(v, file, path);
    const out: Record<string, Offense> = {};
    for (const [k, val] of Object.entries(o)) out[k] = oneOf(val, OFFENSES, file, `${path}.${k}`);
    return out;
  };
  const familyOffense = offenseMap(root.familyOffense, 'familyOffense');
  const statuteOffense = offenseMap(root.statuteOffense, 'statuteOffense');

  const th = obj(root.thresholds, file, 'thresholds');
  const thresholds = {
    rs: num(th.rs, file, 'thresholds.rs', 1e-9),
    pc: num(th.pc, file, 'thresholds.pc', 1e-9),
    armed: num(th.armed, file, 'thresholds.armed', 1e-9),
  };

  const de = obj(root.detention, file, 'detention');
  const detention = {
    ruleId: rid(de.ruleId, 'detention.ruleId'),
    attenuating: strList(de.attenuating, file, 'detention.attenuating', INDICATORS),
  };

  const fr = obj(root.frisk, file, 'frisk');
  const frisk = {
    ruleId: rid(fr.ruleId, 'frisk.ruleId'),
    scopeRuleId: rid(fr.scopeRuleId, 'frisk.scopeRuleId'),
    plainFeel: bool(fr.plainFeel, file, 'frisk.plainFeel'),
    plainFeelCategories: strList(fr.plainFeelCategories, file, 'frisk.plainFeelCategories'),
  };

  const ar = obj(root.arrest, file, 'arrest');
  const arrest = { ruleId: rid(ar.ruleId, 'arrest.ruleId'), warrantRuleId: rid(ar.warrantRuleId, 'arrest.warrantRuleId') };

  const si = obj(root.sita, file, 'sita');
  const sita = {
    ruleId: rid(si.ruleId, 'sita.ruleId'),
    vehicleRuleId: rid(si.vehicleRuleId, 'sita.vehicleRuleId'),
    windowS: num(si.windowS, file, 'sita.windowS', 0),
    preArrestS: num(si.preArrestS, file, 'sita.preArrestS', 0),
    vehicle: oneOf(si.vehicle, ['broad', 'gant'] as const, file, 'sita.vehicle'),
  };

  const au = obj(root.automobile, file, 'automobile');
  const automobile = { enabled: bool(au.enabled, file, 'automobile.enabled'), ruleId: rid(au.ruleId, 'automobile.ruleId') };

  const co = obj(root.consent, file, 'consent');
  const consent = {
    ruleId: rid(co.ruleId, 'consent.ruleId'),
    scopeRuleId: rid(co.scopeRuleId, 'consent.scopeRuleId'),
    coercionRuleId: rid(co.coercionRuleId, 'consent.coercionRuleId'),
    coercedByWeaponDrawn: bool(co.coercedByWeaponDrawn, file, 'consent.coercedByWeaponDrawn'),
    maxAggressiveLines: num(co.maxAggressiveLines, file, 'consent.maxAggressiveLines', 0),
  };

  const ex = obj(root.exigency, file, 'exigency');
  const exigency = { ruleId: rid(ex.ruleId, 'exigency.ruleId'), windowS: num(ex.windowS, file, 'exigency.windowS', 0) };
  const entry = { ruleId: rid(obj(root.entry, file, 'entry').ruleId, 'entry.ruleId') };
  const pr = obj(root.premises, file, 'premises');
  const premises = {
    protectiveSweepRuleId: rid(pr.protectiveSweepRuleId, 'premises.protectiveSweepRuleId'),
    plainViewRuleId: rid(pr.plainViewRuleId, 'premises.plainViewRuleId'),
  };
  const te = obj(root.test, file, 'test');
  const test = { ruleId: rid(te.ruleId, 'test.ruleId'), impliedAfterArrest: bool(te.impliedAfterArrest, file, 'test.impliedAfterArrest') };

  const mi = obj(root.miranda, file, 'miranda');
  const miranda = {
    ruleId: rid(mi.ruleId, 'miranda.ruleId'),
    invocationRuleId: rid(mi.invocationRuleId, 'miranda.invocationRuleId'),
    custodyIncludesGunpoint: bool(mi.custodyIncludesGunpoint, file, 'miranda.custodyIncludesGunpoint'),
    incriminatingFacts: strList(mi.incriminatingFacts, file, 'miranda.incriminatingFacts'),
    responseWindowS: num(mi.responseWindowS, file, 'miranda.responseWindowS', 0),
  };

  const fo = obj(root.force, file, 'force');
  const lvObj = obj(fo.levels, file, 'force.levels');
  const levels = {} as Record<ForceLevel, number>;
  let prev = 0;
  for (const lv of FORCE_LEVELS) {
    const v = num(lvObj[lv], file, `force.levels.${lv}`, 0);
    if (v < prev) fail(file, `force.levels.${lv}`, `must not be lower than the previous level (${prev}), got ${v}`);
    levels[lv] = prev = v;
  }
  const mxObj = obj(fo.maxByResistance, file, 'force.maxByResistance');
  const maxByResistance = {} as Record<Resistance, number>;
  for (const r of RESISTANCE_LEVELS) maxByResistance[r] = num(mxObj[r], file, `force.maxByResistance.${r}`, 0);
  const ta = obj(fo.taser, file, 'force.taser');
  const force = {
    ruleId: rid(fo.ruleId, 'force.ruleId'),
    restrainedRuleId: rid(fo.restrainedRuleId, 'force.restrainedRuleId'),
    lethalRuleId: rid(fo.lethalRuleId, 'force.lethalRuleId'),
    displayRuleId: rid(fo.displayRuleId, 'force.displayRuleId'),
    levels,
    maxByResistance,
    displayFirearmMin: oneOf(fo.displayFirearmMin, RESISTANCE_LEVELS, file, 'force.displayFirearmMin'),
    taser: {
      maxCycles: num(ta.maxCycles, file, 'force.taser.maxCycles', 1),
      cycleRuleId: rid(ta.cycleRuleId, 'force.taser.cycleRuleId'),
      riskFactors: strList(ta.riskFactors, file, 'force.taser.riskFactors'),
      riskAllowedAt: oneOf(ta.riskAllowedAt, RESISTANCE_LEVELS, file, 'force.taser.riskAllowedAt'),
      riskRuleId: rid(ta.riskRuleId, 'force.taser.riskRuleId'),
    },
  };

  const iv = obj(root.intervene, file, 'intervene');
  const intervene = {
    ruleId: rid(iv.ruleId, 'intervene.ruleId'),
    windowS: num(iv.windowS, file, 'intervene.windowS', 0),
    radiusM: num(iv.radiusM, file, 'intervene.radiusM', 0),
  };

  const pu = obj(root.pursuit, file, 'pursuit');
  const moObj = obj(pu.maxOverLimitMph, file, 'pursuit.maxOverLimitMph');
  if (moObj.default === undefined) fail(file, 'pursuit.maxOverLimitMph.default', 'is missing');
  const maxOverLimitMph: Record<string, number> = {};
  for (const [k, v] of Object.entries(moObj)) maxOverLimitMph[k] = num(v, file, `pursuit.maxOverLimitMph.${k}`, 0);
  const pursuit = {
    ruleId: rid(pu.ruleId, 'pursuit.ruleId'),
    speedRuleId: rid(pu.speedRuleId, 'pursuit.speedRuleId'),
    terminateRuleId: rid(pu.terminateRuleId, 'pursuit.terminateRuleId'),
    equipmentRuleId: rid(pu.equipmentRuleId, 'pursuit.equipmentRuleId'),
    allowedOffenses: strList(pu.allowedOffenses, file, 'pursuit.allowedOffenses', OFFENSES),
    maxOverLimitMph,
    maxOverS: num(pu.maxOverS, file, 'pursuit.maxOverS', 0),
    wetFactor: num(pu.wetFactor, file, 'pursuit.wetFactor', 0.01, 1),
    nightFactor: num(pu.nightFactor, file, 'pursuit.nightFactor', 0.01, 1),
    requireLightsSiren: bool(pu.requireLightsSiren, file, 'pursuit.requireLightsSiren'),
    maxDurationS: num(pu.maxDurationS, file, 'pursuit.maxDurationS', 1),
    terminateGraceS: num(pu.terminateGraceS, file, 'pursuit.terminateGraceS', 0),
  };

  const rc = obj(root.recording, file, 'recording');
  const recording = {
    ruleId: rid(rc.ruleId, 'recording.ruleId'),
    muteRuleId: rid(rc.muteRuleId, 'recording.muteRuleId'),
    activationGraceS: num(rc.activationGraceS, file, 'recording.activationGraceS', 0),
    requiredFor: strList(rc.requiredFor, file, 'recording.requiredFor', INCIDENT_EVENT_KINDS),
    dashCounts: strList(rc.dashCounts, file, 'recording.dashCounts', INCIDENT_EVENT_KINDS),
  };

  const ev = obj(root.evidence, file, 'evidence');
  const evidence = {
    exclusionRuleId: rid(ev.exclusionRuleId, 'evidence.exclusionRuleId'),
    fruitRuleId: rid(ev.fruitRuleId, 'evidence.fruitRuleId'),
    inevitableDiscovery: bool(ev.inevitableDiscovery, file, 'evidence.inevitableDiscovery'),
    inevitableRuleId: rid(ev.inevitableRuleId, 'evidence.inevitableRuleId'),
  };

  return {
    version: 1, id, name, description, rules, indicators, offenses, familyOffense, statuteOffense, thresholds, detention,
    frisk, arrest, sita, automobile, consent, exigency, entry, premises, test, miranda, force, intervene, pursuit, recording,
    evidence,
  };
}

// --- Registry ------------------------------------------------------------------------------

export const DEFAULT_RULESET_ID = 'generic';

function loadRulesets(): Map<string, Ruleset> {
  const files = import.meta.glob<unknown>('../data/legal/rulesets/*.json', { eager: true, import: 'default' });
  const map = new Map<string, Ruleset>();
  for (const path of Object.keys(files).sort()) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const rs = parseRuleset(files[path], file);
    const stem = file.replace(/\.json$/, '');
    if (rs.id !== stem) fail(file, 'id', `must equal the file name ${show(stem)}, got ${show(rs.id)}`);
    map.set(rs.id, rs);
  }
  if (!map.has(DEFAULT_RULESET_ID)) throw new Error(`rulesets: missing the default ruleset ${DEFAULT_RULESET_ID}`);
  return map;
}

/** Every ruleset file, sorted by path, keyed by id (= file stem). */
export const RULESETS: ReadonlyMap<string, Ruleset> = loadRulesets();

/** Ruleset ids, sorted. */
export function rulesetIds(): string[] {
  return [...RULESETS.keys()].sort();
}

/** The ruleset with `id`; an unknown id yields the default. */
export function getRuleset(id: string): Ruleset {
  const rs = RULESETS.get(id) ?? RULESETS.get(DEFAULT_RULESET_ID);
  if (!rs) throw new Error('rulesets: no default ruleset');
  return rs;
}

/** The rule `id` of `rs`; throws on an unknown id. */
export function ruleOf(rs: Ruleset, id: string): RuleDef {
  const rule = rs.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`${rs.id}: unknown rule id ${show(id)}`);
  return rule;
}

/** "GS-4.1 Gen. Crim. Proc. § 4.1 — Search incident to arrest". */
export function citation(rs: Ruleset, id: string): string {
  const rule = ruleOf(rs, id);
  return `${rule.id} ${rule.cite} — ${rule.title}`;
}
