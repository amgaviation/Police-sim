import { fail, readArray, readBoolean, readNumber, readObject, readOneOf, readString, readVersion } from '../vehicles/json';
import type { JsonObject } from '../vehicles/json';
import firstShiftJson from '../data/tutorial/firstShift.json';
import {
  TUTORIAL_ACTIONS,
  TUTORIAL_PROBES,
  TUTORIAL_TOPICS,
  type TutorialAction,
  type TutorialEventMatch,
  type TutorialScript,
  type TutorialStep,
  type TutorialUntil,
} from './types';

function parseWhere(raw: unknown, file: string, path: string): Record<string, string | number | boolean> {
  const obj = readObject(raw, file, path);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === '') fail(file, path, 'has an empty key');
    if (typeof value === 'number' && !Number.isFinite(value)) fail(file, `${path}.${key}`, `must be a finite number, got ${String(value)}`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      fail(file, `${path}.${key}`, `must be a string, number or boolean, got ${JSON.stringify(value)}`);
    }
    out[key] = value;
  }
  return out;
}

function parseMatch(raw: unknown, file: string, path: string): TutorialEventMatch {
  const o = readObject(raw, file, path);
  const topic = readOneOf(o.topic, TUTORIAL_TOPICS, file, `${path}.topic`);
  if (o.where === undefined) return { topic };
  return { topic, where: parseWhere(o.where, file, `${path}.where`) };
}

function parseUntil(raw: unknown, file: string, path: string): TutorialUntil {
  const o = readObject(raw, file, path);
  const kinds = ['ack', 'any', 'probe'].filter((k) => o[k] !== undefined);
  if (kinds.length !== 1) fail(file, path, `must have exactly one of ack, any, probe, got ${kinds.length === 0 ? 'none' : kinds.join(', ')}`);
  if (o.ack !== undefined) {
    if (o.ack !== true) fail(file, `${path}.ack`, `must be true, got ${JSON.stringify(o.ack)}`);
    return { ack: true };
  }
  if (o.any !== undefined) {
    const list = readArray(o.any, file, `${path}.any`, 1);
    return { any: list.map((m, i) => parseMatch(m, file, `${path}.any.${i}`)) };
  }
  const probe = readOneOf(o.probe, TUTORIAL_PROBES, file, `${path}.probe`);
  if (o.gte === undefined && o.lte === undefined) fail(file, path, 'a probe needs gte or lte');
  const out: { probe: typeof probe; gte?: number; lte?: number } = { probe };
  if (o.gte !== undefined) out.gte = readNumber(o.gte, file, `${path}.gte`);
  if (o.lte !== undefined) out.lte = readNumber(o.lte, file, `${path}.lte`);
  return out;
}

function parseAction(raw: unknown, file: string, path: string): TutorialAction {
  const o = readObject(raw, file, path);
  const name = readOneOf(o.do, TUTORIAL_ACTIONS, file, `${path}.do`);
  if (name === 'flash') return { do: 'flash', text: readString(o.text, file, `${path}.text`) };
  const typeId = readString(o.typeId, file, `${path}.typeId`);
  const minM = readNumber(o.minM, file, `${path}.minM`, 0);
  const maxM = readNumber(o.maxM, file, `${path}.maxM`, 0);
  if (minM > maxM) fail(file, `${path}.minM`, `must not exceed maxM (${maxM}), got ${minM}`);
  return { do: 'createCall', typeId, minM, maxM };
}

function parseStep(raw: unknown, file: string, path: string): TutorialStep {
  const o: JsonObject = readObject(raw, file, path);
  const step: TutorialStep = {
    id: readString(o.id, file, `${path}.id`),
    title: readString(o.title, file, `${path}.title`),
    text: readString(o.text, file, `${path}.text`),
    until: parseUntil(o.until, file, `${path}.until`),
  };
  if (o.hint !== undefined) step.hint = readString(o.hint, file, `${path}.hint`);
  if (o.enter !== undefined) step.enter = readArray(o.enter, file, `${path}.enter`).map((a, i) => parseAction(a, file, `${path}.enter.${i}`));
  if (o.skippable !== undefined) step.skippable = readBoolean(o.skippable, file, `${path}.skippable`);
  return step;
}

/**
 * Validates a tutorial script. Throws an Error naming `file` and the dotted path: unknown topic / probe / action, an empty
 * step list, a duplicate step id, a `where` value other than string / number / boolean, `createCall` with minM > maxM and
 * an empty `any` list.
 */
export function parseTutorialScript(raw: unknown, file: string): TutorialScript {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const id = readString(root.id, file, 'id');
  const title = readString(root.title, file, 'title');
  const list = readArray(root.steps, file, 'steps', 1);
  const seen = new Set<string>();
  const steps = list.map((s, i) => {
    const step = parseStep(s, file, `steps.${i}`);
    if (seen.has(step.id)) fail(file, `steps.${i}.id`, `duplicates the step id "${step.id}"`);
    seen.add(step.id);
    return step;
  });
  return { version: 1, id, title, steps };
}

/** The shipped scripts, keyed by id. */
export const TUTORIAL_SCRIPTS: Readonly<Record<string, TutorialScript>> = (() => {
  const scripts: Record<string, TutorialScript> = {};
  for (const [file, raw] of [['firstShift.json', firstShiftJson as unknown]] as const) {
    const script = parseTutorialScript(raw, file);
    scripts[script.id] = script;
  }
  return scripts;
})();

/** The script with this id, or undefined. */
export function getTutorialScript(id: string): TutorialScript | undefined {
  return Object.hasOwn(TUTORIAL_SCRIPTS, id) ? TUTORIAL_SCRIPTS[id] : undefined;
}
