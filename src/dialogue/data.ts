import mirandaJson from '../data/dialogue/miranda.json';
import responsesJson from '../data/dialogue/responses.json';
import rulesJson from '../data/dialogue/rules.json';
import toolsJson from '../data/dialogue/tools.json';
import trustJson from '../data/dialogue/trust.json';
import utterancesJson from '../data/dialogue/utterances.json';
import { modOverlay } from '../mods/registry';
import { FACT_SOURCES, type FactSource } from '../people';
import {
  fail,
  readArray,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import {
  CONSENT_KINDS,
  FACT_TOPICS,
  INTENTS,
  NPC_COMMANDS,
  REQUIREMENTS,
  TONES,
  type ConsentKind,
  type FactTopic,
  type Intent,
  type Requirement,
  type Tone,
  type Utterance,
} from './types';

/**
 * Validated dialogue tables (design §4.5). Every parser throws an Error naming the file and the
 * dotted field path, e.g. `utterances.json: utterances[3].text.polite must be a non-empty string`.
 */

// --- Line keys ---------------------------------------------------------------------

/** Demeanors that have a greeting line (`unresponsive` and `animal` answer `silent.none`). */
export const GREET_DEMEANORS = ['cooperative', 'nervous', 'evasive', 'hostile', 'distraught', 'confused', 'crisis'] as const;

/** Every line key `respond` and `commandLine` can produce. */
export const LINE_KEYS: readonly string[] = [
  ...GREET_DEMEANORS.map((d) => `greet.${d}`),
  'reason.accept',
  'reason.argue',
  'requestId.handDl',
  'requestId.handFake',
  'requestId.noDlTrue',
  'requestId.lieVerbal',
  'requestId.refuse',
  'requestId.juvenile',
  'identity.repeat',
  'askName.say',
  'askDob.say',
  'ask.truth',
  'ask.lie',
  'ask.refuse',
  'ask.confused',
  'drinking.no',
  'drinking.some',
  'drinking.yes',
  'consent.grant',
  'consent.deny',
  'consent.confused',
  'consent.needGuardian',
  'reassure.ok',
  'miranda.ack',
  'miranda.waive',
  'miranda.invoke',
  'miranda.confused',
  'miranda.silent',
  'release.ok',
  'warn.ok',
  'thank.ok',
  'deaf.noResponse',
  'hoh.repeat',
  'foreign.untranslated',
  'foreign.misunderstood',
  'limited.confused',
  'dementia.confused',
  'silent.none',
  'escalate.flee',
  'escalate.fight',
  'command.comply',
  'command.refuse',
  'command.flee',
  'command.fight',
  'command.confused',
];

// --- Shared helpers ----------------------------------------------------------------

function checkPlaceholders(text: string, allowed: readonly string[], file: string, path: string): void {
  for (const m of text.matchAll(/\{([A-Za-z]*)\}/g)) {
    const name = m[1] ?? '';
    if (!allowed.includes(name)) fail(file, path, `uses the unknown placeholder {${name}} (allowed: ${allowed.join(', ')})`);
  }
}

function readText(value: unknown, allowed: readonly string[], file: string, path: string): string {
  const text = readString(value, file, path);
  checkPlaceholders(text, allowed, file, path);
  return text;
}

// --- utterances.json ---------------------------------------------------------------

export interface TopicDef {
  readonly id: string;
  readonly label: string;
}

export interface UtteranceData {
  readonly topics: readonly TopicDef[];
  readonly utterances: readonly Utterance[];
}

const UTTERANCES_FILE = 'utterances.json';
const OFFICER_PLACEHOLDERS = ['officer', 'reason'] as const;

export function parseUtterances(json: unknown, file = UTTERANCES_FILE): UtteranceData {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const topics = readArray(r.topics, file, 'topics', 1).map((t, i) => {
    const o = readObject(t, file, `topics[${i}]`);
    return { id: readString(o.id, file, `topics[${i}].id`), label: readString(o.label, file, `topics[${i}].label`) };
  });
  const topicIds = new Set<string>();
  for (const [i, t] of topics.entries()) {
    if (topicIds.has(t.id)) fail(file, `topics[${i}].id`, `duplicates the topic "${t.id}"`);
    topicIds.add(t.id);
  }
  const seen = new Set<string>();
  const utterances = readArray(r.utterances, file, 'utterances', 1).map((e, i): Utterance => {
    const p = `utterances[${i}]`;
    const o = readObject(e, file, p);
    const id = readString(o.id, file, `${p}.id`);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicates the utterance "${id}"`);
    seen.add(id);
    const topic = readString(o.topic, file, `${p}.topic`);
    if (!topicIds.has(topic)) fail(file, `${p}.topic`, `must be a declared topic, got "${topic}"`);
    const intent: Intent = readOneOf(o.intent, INTENTS, file, `${p}.intent`);
    const fact: FactTopic | null = o.fact === undefined ? null : readOneOf(o.fact, FACT_TOPICS, file, `${p}.fact`);
    const consent: ConsentKind | null = o.consent === undefined ? null : readOneOf(o.consent, CONSENT_KINDS, file, `${p}.consent`);
    const command: string | null = o.command === undefined ? null : readOneOf(o.command, NPC_COMMANDS, file, `${p}.command`);
    if (intent === 'ask' && fact === null) fail(file, `${p}.fact`, 'is required for intent "ask"');
    if (intent !== 'ask' && fact !== null) fail(file, `${p}.fact`, 'is only allowed for intent "ask"');
    if (intent === 'consent' && consent === null) fail(file, `${p}.consent`, 'is required for intent "consent"');
    if (intent !== 'consent' && consent !== null) fail(file, `${p}.consent`, 'is only allowed for intent "consent"');
    if (intent === 'command' && command === null) fail(file, `${p}.command`, 'is required for intent "command"');
    if (intent !== 'command' && command !== null) fail(file, `${p}.command`, 'is only allowed for intent "command"');
    const requires: Requirement[] =
      o.requires === undefined
        ? []
        : readArray(o.requires, file, `${p}.requires`).map((q, k) => readOneOf(q, REQUIREMENTS, file, `${p}.requires[${k}]`));
    const t = readObject(o.text, file, `${p}.text`);
    for (const key of Object.keys(t)) readOneOf(key, TONES, file, `${p}.text.${key}`);
    const text = {} as Record<Tone, string>;
    for (const tone of TONES) text[tone] = readText(t[tone], OFFICER_PLACEHOLDERS, file, `${p}.text.${tone}`);
    return { id, topic, intent, fact, consent, command, requires, text };
  });
  return { topics, utterances };
}

// --- responses.json ----------------------------------------------------------------

export interface ResponsesData {
  /** Line key -> 2..4 variants. */
  readonly lines: ReadonlyMap<string, readonly string[]>;
  /** Free-value lists (`destination`, `origin`, `account`, `suspectWhereabouts`, `streets`). */
  readonly values: ReadonlyMap<string, readonly string[]>;
  /** Display phrase per fact topic and value (`vehicleContents.item` has `{item}`). */
  readonly answers: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const RESPONSES_FILE = 'responses.json';
const LINE_PLACEHOLDERS = ['first', 'last', 'dob', 'value', 'language', 'officer'] as const;
export const VALUE_LISTS = ['destination', 'origin', 'account', 'suspectWhereabouts', 'streets'] as const;
/** Fact topics with a display phrase table: their values and the keys each table must have. */
export const ANSWER_KEYS: Readonly<Record<string, readonly string[]>> = {
  drinking: ['no', 'some', 'yes'],
  drugs: ['no', 'yes'],
  weapons: ['no', 'yes'],
  injured: ['no', 'yes'],
  vehicleContents: ['nothing', 'item'],
  vehicleOwner: ['self', 'relative', 'friend'],
};

export function parseResponses(json: unknown, file = RESPONSES_FILE): ResponsesData {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const rawLines = readObject(r.lines, file, 'lines');
  const lines = new Map<string, readonly string[]>();
  for (const key of Object.keys(rawLines)) {
    const arr = readArray(rawLines[key], file, `lines.${key}`, 1);
    if (arr.length > 4) fail(file, `lines.${key}`, `must have at most 4 variants, got ${arr.length}`);
    lines.set(key, arr.map((l, i) => readText(l, LINE_PLACEHOLDERS, file, `lines.${key}[${i}]`)));
  }
  for (const key of LINE_KEYS) {
    const variants = lines.get(key);
    if (!variants) fail(file, `lines.${key}`, 'is missing');
    if (variants.length < 2 && !key.startsWith('silent.')) fail(file, `lines.${key}`, `must have 2..4 variants, got ${variants.length}`);
  }
  const rawValues = readObject(r.values, file, 'values');
  const values = new Map<string, readonly string[]>();
  for (const key of VALUE_LISTS) {
    values.set(key, readArray(rawValues[key], file, `values.${key}`, 2).map((v, i) => readString(v, file, `values.${key}[${i}]`)));
  }
  const rawAnswers = readObject(r.answers, file, 'answers');
  const answers = new Map<string, ReadonlyMap<string, string>>();
  for (const [topic, keys] of Object.entries(ANSWER_KEYS)) {
    const o = readObject(rawAnswers[topic], file, `answers.${topic}`);
    const table = new Map<string, string>();
    for (const k of keys) table.set(k, readText(o[k], ['item'], file, `answers.${topic}.${k}`));
    answers.set(topic, table);
  }
  return { lines, values, answers };
}

// --- trust.json --------------------------------------------------------------------

const TRUST_FILE = 'trust.json';
export const DISTRICTS = ['downtown', 'suburbs', 'industrial', 'rural', 'campus', 'hospital', 'airport', 'harbor', 'park', 'highway', 'water'] as const;

/** Neighbourhood trust per district (placeholder until Phase 5), 0..1. */
export function parseTrust(json: unknown, file = TRUST_FILE): ReadonlyMap<string, number> {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const d = readObject(r.districts, file, 'districts');
  const out = new Map<string, number>();
  for (const k of Object.keys(d)) out.set(readOneOf(k, DISTRICTS, file, `districts.${k}`), readNumber(d[k], file, `districts.${k}`, 0, 1));
  for (const k of DISTRICTS) if (!out.has(k)) fail(file, `districts.${k}`, 'is missing');
  return out;
}

// --- miranda.json ------------------------------------------------------------------

/** Waiver model of a Miranda recital (design Phase 5 §7.2): see `waiveChance`. */
export interface MirandaData {
  readonly waiveBase: number;
  readonly priorPenalty: number;
  readonly intoxBonus: number;
  readonly stressPenalty: number;
  readonly hostilePenalty: number;
}

const MIRANDA_FILE = 'miranda.json';

export function parseMiranda(json: unknown, file = MIRANDA_FILE): MirandaData {
  const r = readObject(json, file, '');
  readVersion(r, file);
  return {
    waiveBase: readNumber(r.waiveBase, file, 'waiveBase', 0, 1),
    priorPenalty: readNumber(r.priorPenalty, file, 'priorPenalty', 0, 1),
    intoxBonus: readNumber(r.intoxBonus, file, 'intoxBonus', 0, 1),
    stressPenalty: readNumber(r.stressPenalty, file, 'stressPenalty', 0, 1),
    hostilePenalty: readNumber(r.hostilePenalty, file, 'hostilePenalty', 0, 1),
  };
}

// --- rules.json --------------------------------------------------------------------

export const COMPARATORS = ['equal', 'denial', 'appearance', 'idCard', 'notOnFile'] as const;
export type Comparator = (typeof COMPARATORS)[number];
export type InconsistencySeverity = 'caution' | 'alert';

export interface InconsistencyRule {
  readonly id: string;
  readonly topic: FactTopic;
  readonly a: FactSource;
  readonly b: FactSource;
  readonly compare: Comparator;
  readonly severity: InconsistencySeverity;
  readonly text: string;
}

const RULES_FILE = 'rules.json';
const RULE_PLACEHOLDERS = ['a', 'b', 'aDetail', 'bDetail'] as const;

/** The rules every build must ship (design §4.5): id, topic, a, b, compare, severity. */
export const REQUIRED_RULES: readonly (readonly [string, FactTopic, FactSource, FactSource, Comparator, InconsistencySeverity])[] = [
  ['nameVsId', 'name', 'claim', 'document', 'equal', 'alert'],
  ['dobVsId', 'dob', 'claim', 'document', 'equal', 'alert'],
  ['nameNotOnFile', 'name', 'claim', 'record', 'notOnFile', 'alert'],
  ['dobVsRecord', 'dob', 'claim', 'record', 'equal', 'alert'],
  ['idNotOnFile', 'idCard', 'document', 'record', 'idCard', 'alert'],
  ['appearanceVsRecord', 'appearance', 'observation', 'record', 'appearance', 'caution'],
  ['addressVsRecord', 'address', 'claim', 'record', 'equal', 'caution'],
  ['storyDestination', 'destination', 'claim', 'claim', 'equal', 'caution'],
  ['storyOrigin', 'origin', 'claim', 'claim', 'equal', 'caution'],
  ['storyAccount', 'account', 'claim', 'claim', 'equal', 'caution'],
  ['drinkingDenial', 'drinking', 'claim', 'evidence', 'denial', 'alert'],
  ['drugsDenial', 'drugs', 'claim', 'evidence', 'denial', 'alert'],
  ['weaponsDenial', 'weapons', 'claim', 'evidence', 'denial', 'alert'],
  ['contentsDenial', 'vehicleContents', 'claim', 'evidence', 'denial', 'alert'],
  ['ownerVsRecord', 'vehicleOwner', 'claim', 'record', 'equal', 'caution'],
  ['identityVsBooking', 'identity', 'claim', 'booking', 'equal', 'alert'],
];

export function parseRules(json: unknown, file = RULES_FILE): InconsistencyRule[] {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const seen = new Set<string>();
  const rules = readArray(r.rules, file, 'rules', 1).map((e, i): InconsistencyRule => {
    const p = `rules[${i}]`;
    const o = readObject(e, file, p);
    const id = readString(o.id, file, `${p}.id`);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicates the rule "${id}"`);
    seen.add(id);
    return {
      id,
      topic: readOneOf(o.topic, FACT_TOPICS, file, `${p}.topic`),
      a: readOneOf(o.a, FACT_SOURCES, file, `${p}.a`),
      b: readOneOf(o.b, FACT_SOURCES, file, `${p}.b`),
      compare: readOneOf(o.compare, COMPARATORS, file, `${p}.compare`),
      severity: readOneOf(o.severity, ['caution', 'alert'] as const, file, `${p}.severity`),
      text: readText(o.text, RULE_PLACEHOLDERS, file, `${p}.text`),
    };
  });
  for (const [id, topic, a, b, compare, severity] of REQUIRED_RULES) {
    const rule = rules.find((x) => x.id === id);
    if (!rule) fail(file, 'rules', `is missing the required rule "${id}"`);
    const want = { topic, a, b, compare, severity };
    for (const k of Object.keys(want) as (keyof typeof want)[]) {
      if (rule[k] !== want[k]) fail(file, `rules(${id}).${k}`, `must be "${want[k]}", got "${rule[k]}"`);
    }
  }
  return rules;
}

// --- tools.json --------------------------------------------------------------------

export const SFST_TESTS = ['hgn', 'walkTurn', 'oneLeg'] as const;
export type SfstTestId = (typeof SFST_TESTS)[number];
export const SFST_KEYS = ['a', 'd', 'w', 'space'] as const;
export type SfstKey = (typeof SFST_KEYS)[number];

export interface SfstTestDef {
  readonly id: SfstTestId;
  readonly short: string;
  readonly label: string;
  readonly prompts: number;
  readonly maxClues: number;
  readonly threshold: number;
  readonly bacStart: number;
  readonly bacSpan: number;
  readonly instruction: string;
  readonly keys: readonly SfstKey[];
}

export interface ToolsData {
  readonly pbt: { readonly noiseSd: number; readonly round: number; readonly minReportable: number };
  readonly sfst: {
    readonly promptWindowS: number;
    readonly promptGapS: number;
    readonly minHitShare: number;
    /** In the fixed order hgn, walkTurn, oneLeg. */
    readonly tests: readonly SfstTestDef[];
    /** Drug kind -> test id -> extra clues. */
    readonly drugClues: ReadonlyMap<string, ReadonlyMap<SfstTestId, number>>;
    readonly diabeticChance: number;
    readonly diabeticClues: ReadonlyMap<SfstTestId, number>;
    readonly clueSd: number;
  };
  readonly frisk: { readonly weaponFindBase: number; readonly concealmentFactor: number; readonly largeItemFind: number };
  readonly search: { readonly findBase: number; readonly concealmentFactor: number };
  readonly visual: { readonly revealBelowConcealment: number };
  readonly odor: { readonly alcoholBac: number; readonly distanceM: number };
}

const TOOLS_FILE = 'tools.json';
const DRUGS_WITH_CLUES = ['cannabis', 'stimulant', 'opioid', 'depressant'] as const;

function clueTable(value: unknown, file: string, path: string): Map<SfstTestId, number> {
  const o = readObject(value, file, path);
  const out = new Map<SfstTestId, number>();
  for (const k of Object.keys(o)) out.set(readOneOf(k, SFST_TESTS, file, `${path}.${k}`), readNumber(o[k], file, `${path}.${k}`, 0, 8));
  return out;
}

export function parseTools(json: unknown, file = TOOLS_FILE): ToolsData {
  const r = readObject(json, file, '');
  readVersion(r, file);
  const sub = (key: string): JsonObject => readObject(r[key], file, key);
  const pbt = sub('pbt');
  const sfst = sub('sfst');
  const frisk = sub('frisk');
  const search = sub('search');
  const visual = sub('visual');
  const odor = sub('odor');
  const testRows = readArray(sfst.tests, file, 'sfst.tests');
  if (testRows.length !== SFST_TESTS.length) fail(file, 'sfst.tests', `must have ${SFST_TESTS.length} tests (${SFST_TESTS.join(', ')}), got ${testRows.length}`);
  const tests = testRows.map((e, i): SfstTestDef => {
    const p = `sfst.tests[${i}]`;
    const o = readObject(e, file, p);
    const id = readOneOf(o.id, SFST_TESTS, file, `${p}.id`);
    if (id !== SFST_TESTS[i]) fail(file, `${p}.id`, `must be "${SFST_TESTS[i]}" (fixed order), got "${id}"`);
    const prompts = readNumber(o.prompts, file, `${p}.prompts`, 1, 40);
    const maxClues = readNumber(o.maxClues, file, `${p}.maxClues`, 1, 20);
    const threshold = readNumber(o.threshold, file, `${p}.threshold`, 1, maxClues);
    const keys = readArray(o.keys, file, `${p}.keys`, 1).map((k, j) => readOneOf(k, SFST_KEYS, file, `${p}.keys[${j}]`));
    return {
      id,
      short: readString(o.short, file, `${p}.short`),
      label: readString(o.label, file, `${p}.label`),
      prompts,
      maxClues,
      threshold,
      bacStart: readNumber(o.bacStart, file, `${p}.bacStart`, 0, 0.4),
      bacSpan: readNumber(o.bacSpan, file, `${p}.bacSpan`, 0.001, 0.4),
      instruction: readString(o.instruction, file, `${p}.instruction`),
      keys,
    };
  });
  const rawDrug = readObject(sfst.drugClues, file, 'sfst.drugClues');
  const drugClues = new Map<string, ReadonlyMap<SfstTestId, number>>();
  for (const k of Object.keys(rawDrug)) {
    readOneOf(k, DRUGS_WITH_CLUES, file, `sfst.drugClues.${k}`);
    drugClues.set(k, clueTable(rawDrug[k], file, `sfst.drugClues.${k}`));
  }
  return {
    pbt: {
      noiseSd: readNumber(pbt.noiseSd, file, 'pbt.noiseSd', 0, 0.1),
      round: readNumber(pbt.round, file, 'pbt.round', 0.0001, 0.1),
      minReportable: readNumber(pbt.minReportable, file, 'pbt.minReportable', 0, 0.1),
    },
    sfst: {
      promptWindowS: readNumber(sfst.promptWindowS, file, 'sfst.promptWindowS', 0.1, 30),
      promptGapS: readNumber(sfst.promptGapS, file, 'sfst.promptGapS', 0, 30),
      minHitShare: readNumber(sfst.minHitShare, file, 'sfst.minHitShare', 0, 1),
      tests,
      drugClues,
      diabeticChance: readNumber(sfst.diabeticChance, file, 'sfst.diabeticChance', 0, 1),
      diabeticClues: clueTable(sfst.diabeticClues, file, 'sfst.diabeticClues'),
      clueSd: readNumber(sfst.clueSd, file, 'sfst.clueSd', 0, 5),
    },
    frisk: {
      weaponFindBase: readNumber(frisk.weaponFindBase, file, 'frisk.weaponFindBase', 0, 1),
      concealmentFactor: readNumber(frisk.concealmentFactor, file, 'frisk.concealmentFactor', 0, 1),
      largeItemFind: readNumber(frisk.largeItemFind, file, 'frisk.largeItemFind', 0, 1),
    },
    search: {
      findBase: readNumber(search.findBase, file, 'search.findBase', 0, 1),
      concealmentFactor: readNumber(search.concealmentFactor, file, 'search.concealmentFactor', 0, 1),
    },
    visual: { revealBelowConcealment: readNumber(visual.revealBelowConcealment, file, 'visual.revealBelowConcealment', 0, 1) },
    odor: {
      alcoholBac: readNumber(odor.alcoholBac, file, 'odor.alcoholBac', 0, 0.4),
      distanceM: readNumber(odor.distanceM, file, 'odor.distanceM', 0, 50),
    },
  };
}

// --- Loaded tables -----------------------------------------------------------------

export const UTTERANCE_DATA: UtteranceData = parseUtterances(utterancesJson);
export const RESPONSES: ResponsesData = parseResponses(responsesJson);
/** Baselines of `trust.json`; an active mod's `districts[d].trustBaseline` replaces the district's value. */
function loadTrust(): ReadonlyMap<string, number> {
  const trust = new Map(parseTrust(trustJson));
  for (const [district, patch] of Object.entries(modOverlay().districts)) {
    if (patch.trustBaseline !== undefined && trust.has(district)) trust.set(district, patch.trustBaseline);
  }
  return trust;
}

export const TRUST: ReadonlyMap<string, number> = loadTrust();
export const MIRANDA: MirandaData = parseMiranda(mirandaJson);
export const RULES: readonly InconsistencyRule[] = parseRules(rulesJson);
export const TOOLS: ToolsData = parseTools(toolsJson);
