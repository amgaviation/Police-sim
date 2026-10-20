import commandJson from '../data/command/command.json';
import negotiationJson from '../data/command/negotiation.json';
import { fail, readArray, readBoolean, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';
import {
  NEGOTIATION_STAGES,
  NEGOTIATION_TONES,
  type CommandConfig,
  type NegStage,
  type NegTemperament,
  type NegTone,
  type NegotiationCategory,
  type NegotiationData,
  type NegotiationOption,
  type TransportTag,
} from './types';

const LEVELS = ['incident', 'major', 'disaster'] as const;
const TRANSPORT_TAGS: readonly TransportTag[] = ['immediate', 'delayed', 'minor'];
const TEMPERAMENTS: readonly NegTemperament[] = ['calm', 'timid', 'irritable', 'volatile'];

function onlyKeys(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, 'is not a known field');
  }
}

function section(root: JsonObject, key: string, file: string, keys: readonly string[]): JsonObject {
  const o = readObject(root[key], file, key);
  onlyKeys(o, keys, file, key);
  return o;
}

function int(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function num(o: JsonObject, key: string, file: string, path: string, min: number, max: number): number {
  return readNumber(o[key], file, `${path}.${key}`, min, max);
}

/** Validates `command.json`; throws an Error naming the file and the dotted path. */
export function parseCommandConfig(raw: unknown, file = 'command.json'): CommandConfig {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'levels', 'post', 'triage', 'transport', 'fire', 'tcp', 'evac', 'inner', 'needs', 'negotiation'], file, '');

  const lv = section(root, 'levels', file, ['families', 'majorUnitsOnScene']);
  const famRaw = readObject(lv.families, file, 'levels.families');
  const families: Record<string, (typeof LEVELS)[number]> = {};
  for (const key of Object.keys(famRaw)) families[key] = readOneOf(famRaw[key], LEVELS, file, `levels.families.${key}`);

  const post = section(root, 'post', file, ['standoffM', 'autoOnArrival']);
  const tr = section(root, 'triage', file, ['roles', 'assessS', 'rangeM', 'aiAssessS', 'aiErrorRate']);
  const roles = readArray(tr.roles, file, 'triage.roles', 1).map((r, i) => readString(r, file, `triage.roles[${i}]`));

  const tp = section(root, 'transport', file, ['order', 'loadS', 'perUnit']);
  const order = readArray(tp.order, file, 'transport.order', 1).map((r, i) => readOneOf(r, TRANSPORT_TAGS, file, `transport.order[${i}]`));
  const per = readObject(tp.perUnit, file, 'transport.perUnit');
  onlyKeys(per, TRANSPORT_TAGS, file, 'transport.perUnit');

  const fire = section(root, 'fire', file, ['extricateS', 'deconS']);
  const tcp = section(root, 'tcp', file, ['radiusM', 'max', 'blockadeRadiusM']);
  const ev = section(root, 'evac', file, ['radiusM', 'buildingS', 'fireFactor', 'segments']);
  const evR = readObject(ev.radiusM, file, 'evac.radiusM');
  onlyKeys(evR, ['hazmat', 'package', 'barricade', 'default'], file, 'evac.radiusM');
  const inner = section(root, 'inner', file, ['offsetM']);
  const needs = section(root, 'needs', file, ['emsPerImmediate', 'emsPerDelayed', 'firePerTrapped', 'fireHazmat', 'maxEms', 'maxFire']);
  const ng = section(root, 'negotiation', file, [
    'startTrust', 'startAgitation', 'surrenderTrust', 'surrenderAgitation', 'surrenderTurns', 'breakdownAgitation', 'stallTurns', 'noiseSd', 'negotiatorBonus',
  ]);

  return {
    levels: { families, majorUnitsOnScene: int(lv.majorUnitsOnScene, file, 'levels.majorUnitsOnScene', 1, 100) },
    post: { standoffM: num(post, 'standoffM', file, 'post', 0, 500), autoOnArrival: readBoolean(post.autoOnArrival, file, 'post.autoOnArrival') },
    triage: {
      roles,
      assessS: num(tr, 'assessS', file, 'triage', 0, 600),
      rangeM: num(tr, 'rangeM', file, 'triage', 0.1, 50),
      aiAssessS: num(tr, 'aiAssessS', file, 'triage', 0.1, 600),
      aiErrorRate: num(tr, 'aiErrorRate', file, 'triage', 0, 1),
    },
    transport: {
      order,
      loadS: num(tp, 'loadS', file, 'transport', 0, 600),
      perUnit: {
        immediate: int(per.immediate, file, 'transport.perUnit.immediate', 1, 10),
        delayed: int(per.delayed, file, 'transport.perUnit.delayed', 1, 10),
        minor: int(per.minor, file, 'transport.perUnit.minor', 1, 10),
      },
    },
    fire: { extricateS: num(fire, 'extricateS', file, 'fire', 0.1, 3600), deconS: num(fire, 'deconS', file, 'fire', 0.1, 3600) },
    tcp: {
      radiusM: num(tcp, 'radiusM', file, 'tcp', 10, 1000),
      max: int(tcp.max, file, 'tcp.max', 1, 16),
      blockadeRadiusM: num(tcp, 'blockadeRadiusM', file, 'tcp', 0.5, 100),
    },
    evac: {
      radiusM: {
        hazmat: num(evR, 'hazmat', file, 'evac.radiusM', 10, 1000),
        package: num(evR, 'package', file, 'evac.radiusM', 10, 1000),
        barricade: num(evR, 'barricade', file, 'evac.radiusM', 10, 1000),
        default: num(evR, 'default', file, 'evac.radiusM', 10, 1000),
      },
      buildingS: num(ev, 'buildingS', file, 'evac', 0.1, 3600),
      fireFactor: num(ev, 'fireFactor', file, 'evac', 0, 20),
      segments: int(ev.segments, file, 'evac.segments', 6, 64),
    },
    inner: { offsetM: num(inner, 'offsetM', file, 'inner', 0, 100) },
    needs: {
      emsPerImmediate: num(needs, 'emsPerImmediate', file, 'needs', 0, 10),
      emsPerDelayed: num(needs, 'emsPerDelayed', file, 'needs', 0, 10),
      firePerTrapped: num(needs, 'firePerTrapped', file, 'needs', 0, 10),
      fireHazmat: int(needs.fireHazmat, file, 'needs.fireHazmat', 0, 10),
      maxEms: int(needs.maxEms, file, 'needs.maxEms', 0, 20),
      maxFire: int(needs.maxFire, file, 'needs.maxFire', 0, 20),
    },
    negotiation: {
      startTrust: num(ng, 'startTrust', file, 'negotiation', 0, 1),
      startAgitation: num(ng, 'startAgitation', file, 'negotiation', 0, 1),
      surrenderTrust: num(ng, 'surrenderTrust', file, 'negotiation', 0, 1),
      surrenderAgitation: num(ng, 'surrenderAgitation', file, 'negotiation', 0, 1),
      surrenderTurns: int(ng.surrenderTurns, file, 'negotiation.surrenderTurns', 1, 100),
      breakdownAgitation: num(ng, 'breakdownAgitation', file, 'negotiation', 0, 1),
      stallTurns: int(ng.stallTurns, file, 'negotiation.stallTurns', 1, 1000),
      noiseSd: num(ng, 'noiseSd', file, 'negotiation', 0, 1),
      negotiatorBonus: num(ng, 'negotiatorBonus', file, 'negotiation', 0, 10),
    },
  };
}

function readStrings(value: unknown, file: string, path: string, minLength: number): string[] {
  return readArray(value, file, path, minLength).map((s, i) => readString(s, file, `${path}[${i}]`));
}

function readOption(value: unknown, file: string, path: string): NegotiationOption {
  const o = readObject(value, file, path);
  onlyKeys(o, ['id', 'text', 'trust', 'agitation', 'stages', 'minTrust'], file, path);
  const stages = readArray(o.stages, file, `${path}.stages`, 1).map((s, i) => readOneOf<NegStage>(s, NEGOTIATION_STAGES, file, `${path}.stages[${i}]`));
  const minTrust = o.minTrust === undefined ? undefined : readNumber(o.minTrust, file, `${path}.minTrust`, 0, 1);
  return {
    id: readString(o.id, file, `${path}.id`),
    text: readString(o.text, file, `${path}.text`),
    trust: num(o, 'trust', file, path, -1, 1),
    agitation: num(o, 'agitation', file, path, -1, 1),
    stages,
    ...(minTrust !== undefined ? { minTrust } : {}),
  };
}

function record<K extends string>(value: unknown, keys: readonly K[], file: string, path: string, min: number, max: number): Record<K, number> {
  const o = readObject(value, file, path);
  onlyKeys(o, keys, file, path);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = readNumber(o[k], file, `${path}.${k}`, min, max);
  return out;
}

/** Validates `negotiation.json` (the negotiation dialogue content); throws an Error naming the file and the dotted path. */
export function parseNegotiationData(raw: unknown, file = 'negotiation.json'): NegotiationData {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'categories', 'replies', 'toneFactor', 'stageTrust', 'subject'], file, '');

  const ids = new Set<string>();
  const categories: NegotiationCategory[] = readArray(root.categories, file, 'categories', 1).map((c, i) => {
    const path = `categories[${i}]`;
    const o = readObject(c, file, path);
    onlyKeys(o, ['id', 'label', 'options'], file, path);
    const options = readArray(o.options, file, `${path}.options`, 1).map((x, j) => {
      const opt = readOption(x, file, `${path}.options[${j}]`);
      if (ids.has(opt.id)) fail(file, `${path}.options[${j}].id`, `duplicate option id ${opt.id}`);
      ids.add(opt.id);
      return opt;
    });
    return { id: readString(o.id, file, `${path}.id`), label: readString(o.label, file, `${path}.label`), options };
  });

  const rep = readObject(root.replies, file, 'replies');
  onlyKeys(rep, ['calm', 'neutral', 'agitated', 'surrender', 'breakdown'], file, 'replies');
  const subj = readObject(root.subject, file, 'subject');
  onlyKeys(subj, ['temperament', 'hostage', 'intoxicated', 'crisis'], file, 'subject');

  return {
    categories,
    replies: {
      calm: readStrings(rep.calm, file, 'replies.calm', 1),
      neutral: readStrings(rep.neutral, file, 'replies.neutral', 1),
      agitated: readStrings(rep.agitated, file, 'replies.agitated', 1),
      surrender: readStrings(rep.surrender, file, 'replies.surrender', 1),
      breakdown: readStrings(rep.breakdown, file, 'replies.breakdown', 1),
    },
    toneFactor: record<NegTone>(root.toneFactor, NEGOTIATION_TONES, file, 'toneFactor', 0, 5),
    stageTrust: record<NegStage>(root.stageTrust, NEGOTIATION_STAGES, file, 'stageTrust', 0, 1),
    subject: {
      temperament: record<NegTemperament>(subj.temperament, TEMPERAMENTS, file, 'subject.temperament', -1, 1),
      hostage: num(subj, 'hostage', file, 'subject', -1, 1),
      intoxicated: num(subj, 'intoxicated', file, 'subject', -1, 1),
      crisis: num(subj, 'crisis', file, 'subject', -1, 1),
    },
  };
}

/** The shipped command configuration. */
export const COMMAND_CONFIG: CommandConfig = parseCommandConfig(commandJson, 'command.json');
/** The shipped negotiation dialogue content. */
export const NEGOTIATION_DATA: NegotiationData = parseNegotiationData(negotiationJson, 'negotiation.json');
