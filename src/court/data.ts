import courtJson from '../data/court/court.json';
import questionsJson from '../data/court/questions.json';
import { RESISTANCE_LEVELS, SEARCH_TARGETS } from '../legal/types';

/**
 * Court data (Phase 5 design 11.1): `src/data/court/*.json` validated at import. Every parser failure throws
 * `Error('<file>: <dotted.path>: <problem>')`.
 */

export interface CourtConfig {
  readonly plea: { readonly base: number; readonly strongBonus: number };
  /** Probability a cited person contests (the citation is otherwise paid). */
  readonly citationContest: number;
  /** [min, max] game hours between the case being opened and the hearing. */
  readonly delayH: readonly [number, number];
  /** [open, close] court hours (game clock hours); a hearing starts in [open, close). */
  readonly hours: readonly [number, number];
  readonly windowBeforeMin: number;
  readonly windowAfterMin: number;
  readonly reminderMin: number;
  readonly maxQuestions: number;
  readonly credibility: {
    readonly consistent: number;
    readonly evasive: number;
    readonly reportMismatch: number;
    readonly contradictOffCam: number;
    readonly impeachOnCam: number;
    readonly selfInconsistent: number;
  };
  readonly testimony: {
    readonly base: number;
    readonly consistent: number;
    readonly impeached: number;
    readonly contradiction: number;
    readonly evasive: number;
    readonly selfInconsistent: number;
  };
  readonly conviction: {
    readonly base: number;
    readonly strength: number;
    readonly testimony: number;
    readonly report: number;
    readonly missedFactor: number;
    /** Report score (0..100) assumed when the incident has no graded report. */
    readonly noReportGrade: number;
  };
}

export const QUESTION_TEMPLATE_KINDS = ['resistanceAt', 'consentGiven', 'mirandaBefore', 'camDuring', 'reportAssertion', 'omission'] as const;
export type QuestionTemplateKind = (typeof QUESTION_TEMPLATE_KINDS)[number];

export interface QuestionData {
  readonly templates: Readonly<Record<QuestionTemplateKind | 'repeat', string>>;
  /** The statement form of each question, substituted into the `repeat` template. */
  readonly restatements: Readonly<Record<QuestionTemplateKind, string>>;
  readonly labels: {
    readonly resistance: Readonly<Record<string, string>>;
    readonly tool: Readonly<Record<string, string>>;
    readonly search: Readonly<Record<string, string>>;
    readonly fact: Readonly<Record<string, string>>;
    readonly action: Readonly<Record<string, string>>;
  };
}

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

function num(v: unknown, file: string, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(file, path, `must be a finite number, got ${show(v)}`);
  if (v < min || v > max) fail(file, path, `must be in [${min}, ${max}], got ${v}`);
  return v;
}

function pair(v: unknown, file: string, path: string, min: number, max: number): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) fail(file, path, `must be a [low, high] array, got ${show(v)}`);
  const lo = num(v[0], file, `${path}[0]`, min, max);
  const hi = num(v[1], file, `${path}[1]`, min, max);
  if (hi < lo) fail(file, path, `high must not be below low, got ${show(v)}`);
  return [lo, hi];
}

function str(v: unknown, file: string, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(file, path, `must be a non-empty string, got ${show(v)}`);
  return v;
}

/** Parses and validates `court.json`. */
export function parseCourtConfig(raw: unknown, file = 'court.json'): CourtConfig {
  const root = obj(raw, file, '');
  if (root.version !== 1) fail(file, 'version', `must be 1, got ${show(root.version)}`);
  const plea = obj(root.plea, file, 'plea');
  const cred = obj(root.credibility, file, 'credibility');
  const test = obj(root.testimony, file, 'testimony');
  const conv = obj(root.conviction, file, 'conviction');
  const hours = pair(root.hours, file, 'hours', 0, 24);
  if (hours[1] <= hours[0]) fail(file, 'hours', 'court must open before it closes');
  const maxQuestions = num(root.maxQuestions, file, 'maxQuestions', 2, 20);
  if (!Number.isInteger(maxQuestions)) fail(file, 'maxQuestions', `must be an integer, got ${maxQuestions}`);
  return {
    plea: { base: num(plea.base, file, 'plea.base', 0, 1), strongBonus: num(plea.strongBonus, file, 'plea.strongBonus', 0, 1) },
    citationContest: num(root.citationContest, file, 'citationContest', 0, 1),
    delayH: pair(root.delayH, file, 'delayH', 0, 24 * 30),
    hours,
    windowBeforeMin: num(root.windowBeforeMin, file, 'windowBeforeMin', 0, 24 * 60),
    windowAfterMin: num(root.windowAfterMin, file, 'windowAfterMin', 0, 24 * 60),
    reminderMin: num(root.reminderMin, file, 'reminderMin', 0, 24 * 60),
    maxQuestions,
    credibility: {
      consistent: num(cred.consistent, file, 'credibility.consistent', -1, 1),
      evasive: num(cred.evasive, file, 'credibility.evasive', -1, 1),
      reportMismatch: num(cred.reportMismatch, file, 'credibility.reportMismatch', -1, 1),
      contradictOffCam: num(cred.contradictOffCam, file, 'credibility.contradictOffCam', -1, 1),
      impeachOnCam: num(cred.impeachOnCam, file, 'credibility.impeachOnCam', -1, 1),
      selfInconsistent: num(cred.selfInconsistent, file, 'credibility.selfInconsistent', -1, 1),
    },
    testimony: {
      base: num(test.base, file, 'testimony.base', 0, 1),
      consistent: num(test.consistent, file, 'testimony.consistent', -1, 1),
      impeached: num(test.impeached, file, 'testimony.impeached', -1, 1),
      contradiction: num(test.contradiction, file, 'testimony.contradiction', -1, 1),
      evasive: num(test.evasive, file, 'testimony.evasive', -1, 1),
      selfInconsistent: num(test.selfInconsistent, file, 'testimony.selfInconsistent', -1, 1),
    },
    conviction: {
      base: num(conv.base, file, 'conviction.base', 0, 1),
      strength: num(conv.strength, file, 'conviction.strength', 0, 1),
      testimony: num(conv.testimony, file, 'conviction.testimony', 0, 1),
      report: num(conv.report, file, 'conviction.report', 0, 1),
      missedFactor: num(conv.missedFactor, file, 'conviction.missedFactor', 0, 1),
      noReportGrade: num(conv.noReportGrade, file, 'conviction.noReportGrade', 0, 100),
    },
  };
}

/** Placeholders each template must contain (the question builder substitutes them). */
const REQUIRED_SLOTS: Readonly<Record<QuestionTemplateKind | 'repeat', readonly string[]>> = {
  resistanceAt: ['level', 'tool'],
  consentGiven: ['search'],
  mirandaBefore: ['fact'],
  camDuring: ['action'],
  reportAssertion: ['text'],
  omission: ['text'],
  repeat: ['restated'],
};

function strings(v: unknown, file: string, path: string, required: readonly string[]): Record<string, string> {
  const o = obj(v, file, path);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) out[k] = str(val, file, `${path}.${k}`);
  for (const k of required) if (out[k] === undefined) fail(file, `${path}.${k}`, 'is required');
  return out;
}

function checkSlots(text: string, slots: readonly string[], file: string, path: string): void {
  for (const slot of slots) if (!text.includes(`{${slot}}`)) fail(file, path, `must contain {${slot}}`);
}

/** Parses and validates `questions.json`. */
export function parseQuestions(raw: unknown, file = 'questions.json'): QuestionData {
  const root = obj(raw, file, '');
  if (root.version !== 1) fail(file, 'version', `must be 1, got ${show(root.version)}`);
  const templates = strings(root.templates, file, 'templates', [...QUESTION_TEMPLATE_KINDS, 'repeat']);
  for (const [k, slots] of Object.entries(REQUIRED_SLOTS)) checkSlots(templates[k] as string, slots, file, `templates.${k}`);
  const restatements = strings(root.restatements, file, 'restatements', QUESTION_TEMPLATE_KINDS);
  for (const kind of QUESTION_TEMPLATE_KINDS) checkSlots(restatements[kind] as string, REQUIRED_SLOTS[kind], file, `restatements.${kind}`);
  const labels = obj(root.labels, file, 'labels');
  return {
    templates: templates as QuestionData['templates'],
    restatements: restatements as QuestionData['restatements'],
    labels: {
      resistance: strings(labels.resistance, file, 'labels.resistance', RESISTANCE_LEVELS),
      tool: strings(labels.tool, file, 'labels.tool', ['none', 'hands', 'ocSpray', 'baton', 'taser', 'lessLethal', 'firearm', 'firearmDisplay', 'k9']),
      search: strings(labels.search, file, 'labels.search', ['frisk', ...SEARCH_TARGETS]),
      fact: strings(labels.fact, file, 'labels.fact', []),
      action: strings(labels.action, file, 'labels.action', ['frisk', 'search', 'force', 'arrest']),
    },
  };
}

/** The validated `court.json`. */
export const COURT_CONFIG: CourtConfig = parseCourtConfig(courtJson, 'court.json');

/** The validated `questions.json`. */
export const QUESTIONS: QuestionData = parseQuestions(questionsJson, 'questions.json');
