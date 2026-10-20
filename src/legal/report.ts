import { createRng } from '../core/rng';
import reportJson from '../data/legal/report.json';
import {
  CONSENT_KINDS,
  INDICATORS,
  OFFENSES,
  RESISTANCE_LEVELS,
  type ConsentKind,
  type IncidentEvent,
  type IncidentLog,
  type LegalAssessment,
  type Offense,
  type ReportChoice,
  type Ruleset,
  type SearchTarget,
} from './types';

/**
 * Report statements of fact (design §5.9): the true facts of an incident, plausible false facts and conclusions for the
 * officer to tick in the MDT report. Deterministic: distractors are drawn from `createRng(seed).stream('report:' + key)`.
 */

const TEMPLATE_IDS = [
  'indicator', 'action.frisk', 'action.search', 'consent', 'miranda', 'resistance', 'arrest', 'pc', 'seize', 'intervene', 'cam',
] as const;

interface ReportData {
  templates: Record<string, string>;
  words: Record<string, Record<string, string>>;
}

function parseReportData(raw: unknown, file: string): ReportData {
  const fail = (path: string, problem: string): never => {
    throw new Error(`${file}: ${path}: ${problem}`);
  };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) return fail('(root)', 'must be an object');
  if (raw.version !== 1) fail('version', 'must be 1');
  const readStrings = (v: unknown, path: string, keys: readonly string[]): Record<string, string> => {
    if (!isObj(v)) return fail(path, 'must be an object');
    const out: Record<string, string> = {};
    for (const key of keys) {
      const val = v[key];
      if (typeof val !== 'string' || val.length === 0) fail(`${path}.${key}`, 'must be a non-empty string');
      out[key] = val as string;
    }
    return out;
  };
  const templates = readStrings(raw.templates, 'templates', TEMPLATE_IDS);
  if (!isObj(raw.words)) return fail('words', 'must be an object');
  const words: Record<string, Record<string, string>> = {
    resistance: readStrings(raw.words.resistance, 'words.resistance', RESISTANCE_LEVELS),
    tool: {},
    target: readStrings(raw.words.target, 'words.target', ['person', 'vehicle', 'premises', 'room', 'container']),
    consent: readStrings(raw.words.consent, 'words.consent', CONSENT_KINDS),
  };
  const tool = raw.words.tool;
  if (!isObj(tool)) return fail('words.tool', 'must be an object');
  for (const [k, v] of Object.entries(tool)) {
    if (typeof v !== 'string' || v.length === 0) fail(`words.tool.${k}`, 'must be a non-empty string');
    (words.tool as Record<string, string>)[k] = v as string;
  }
  return { templates, words };
}

const DATA: ReportData = parseReportData(reportJson, 'report.json');

function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Search target -> the consent kind that covers it. */
const TARGET_CONSENT: Readonly<Record<SearchTarget, ConsentKind>> = {
  person: 'searchPerson', vehicle: 'searchVehicle', premises: 'searchPremises', room: 'searchRoom', container: 'searchPremises',
};

function byId(a: ReportChoice, b: ReportChoice): number {
  return a.personId - b.personId || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

interface Episode { root: IncidentEvent; ids: number[]; officer: string; personId: number; lastT: number }

/** Builds the statements-of-fact checklist for `log` (design §5.9). Output is sorted by person, then id. */
export function buildReportChoices(log: IncidentLog, assessment: LegalAssessment, rs: Ruleset, seed: number): ReportChoice[] {
  const rng = createRng(seed).stream('report:' + log.key);
  const out: ReportChoice[] = [];
  const events = log.events;

  // --- Gather -------------------------------------------------------------------------------
  const labels = new Map<number, string>();
  const order: number[] = [];
  const seen = (pid: number): void => {
    if (pid >= 0 && !order.includes(pid)) order.push(pid);
  };
  for (const p of log.people) {
    labels.set(p.personId, p.label);
    seen(p.personId);
  }
  for (const e of events) {
    seen(e.personId);
    if (e.kind === 'person') labels.set(e.personId, e.label);
  }
  const name = (pid: number): string => labels.get(pid) ?? (pid < 0 ? 'the vehicle' : `person ${pid}`);

  const indicators = new Map<number, Map<string, number>>();
  const subjects = new Set<number>();
  const arrestEvent = new Map<number, number>();
  const friskedBy = new Set<number>();
  const vehicleSearched = new Set<number>();
  const searchTargets = new Map<number, Set<SearchTarget>>();
  const grantedConsents = new Map<number, Set<ConsentKind>>();
  const firstCustodialQuestion = new Map<number, number>();
  const advised = new Map<number, number[]>();
  const custody = new Map<number, boolean>();
  const episodes: Episode[] = [];
  const intervened = new Set<number>();

  for (const e of events) {
    switch (e.kind) {
      case 'indicator': {
        let m = indicators.get(e.personId);
        if (!m) indicators.set(e.personId, (m = new Map<string, number>()));
        if (!m.has(e.indicator)) m.set(e.indicator, e.id);
        break;
      }
      case 'detention':
        subjects.add(e.personId);
        if (e.how === 'cuffed') custody.set(e.personId, true);
        break;
      case 'arrest':
        subjects.add(e.personId);
        custody.set(e.personId, true);
        if (!arrestEvent.has(e.personId)) arrestEvent.set(e.personId, e.id);
        break;
      case 'release': custody.set(e.personId, false); break;
      case 'frisk': subjects.add(e.personId); friskedBy.add(e.personId); break;
      case 'search': {
        subjects.add(e.personId);
        if (e.target === 'vehicle') vehicleSearched.add(e.personId);
        let t = searchTargets.get(e.personId);
        if (!t) searchTargets.set(e.personId, (t = new Set<SearchTarget>()));
        t.add(e.target);
        break;
      }
      case 'consent': {
        subjects.add(e.personId);
        if (e.granted) {
          let k = grantedConsents.get(e.personId);
          if (!k) grantedConsents.set(e.personId, (k = new Set<ConsentKind>()));
          k.add(e.consent);
        }
        break;
      }
      case 'test':
      case 'force':
        subjects.add(e.personId);
        break;
      case 'miranda': {
        subjects.add(e.personId);
        if (e.result === 'waived' || e.result === 'invoked') {
          const list = advised.get(e.personId) ?? [];
          list.push(e.id);
          advised.set(e.personId, list);
        }
        break;
      }
      case 'question': {
        subjects.add(e.personId);
        const custodial = custody.get(e.personId) === true || e.custody || (rs.miranda.custodyIncludesGunpoint && e.gunpoint);
        if (custodial && rs.miranda.incriminatingFacts.includes(e.fact) && !firstCustodialQuestion.has(e.personId)) {
          firstCustodialQuestion.set(e.personId, e.id);
        }
        break;
      }
      case 'otherForce': {
        const ep = episodes.find((x) => x.officer === e.officer && x.personId === e.personId && e.t - x.lastT <= 10);
        if (ep) {
          ep.ids.push(e.id);
          ep.lastT = e.t;
        } else episodes.push({ root: e, ids: [e.id], officer: e.officer, personId: e.personId, lastT: e.t });
        break;
      }
      case 'intervene': intervened.add(e.otherEvent); break;
      default: break;
    }
  }

  const indicatorOffense = (id: string): Offense | null => {
    const def = rs.indicators[id];
    if (!def) return null;
    return id === 'callSuspect' ? (rs.familyOffense[log.family] ?? def.offense) : def.offense;
  };
  const familyOffense = rs.familyOffense[log.family] ?? null;
  const arrestedOrFrisked = (pid: number): boolean => arrestEvent.has(pid) || friskedBy.has(pid);
  const anyArrestedOrFrisked = arrestEvent.size > 0 || friskedBy.size > 0;
  const T = DATA.templates;
  const W = DATA.words;
  const word = (group: string, key: string): string => W[group]?.[key] ?? key;
  const tpl = (id: (typeof TEMPLATE_IDS)[number]): string => T[id] ?? '';

  const push = (c: ReportChoice): void => {
    out.push(c);
  };

  // --- Indicators ---------------------------------------------------------------------------
  const indicatorPersons = [-1, ...order];
  for (const pid of indicatorPersons) {
    const own = indicators.get(pid);
    if (own) {
      for (const [ind, eventId] of own) {
        const def = rs.indicators[ind];
        if (!def) continue;
        push({
          id: `ind:${ind}:${pid}`, group: null, personId: pid, truth: 'true', eventId,
          key: (def.pc > 0 || def.armed > 0) && (pid === -1 ? anyArrestedOrFrisked : arrestedOrFrisked(pid)),
          text: fill(tpl('indicator'), { person: name(pid), indicator: def.label }),
        });
      }
    }
    if (pid < 0 || !subjects.has(pid)) continue;
    const had = new Set<string>([...(own?.keys() ?? []), ...(indicators.get(-1)?.keys() ?? [])]);
    const offenses = new Set<Offense>();
    if (familyOffense) offenses.add(familyOffense);
    for (const ind of own?.keys() ?? []) {
      const o = indicatorOffense(ind);
      if (o) offenses.add(o);
    }
    const candidates = INDICATORS.filter((i) => !had.has(i) && offenses.has(indicatorOffense(i) as Offense)).sort();
    rng.shuffle(candidates);
    for (const ind of candidates.slice(0, 2)) {
      const def = rs.indicators[ind];
      if (!def) continue;
      push({
        id: `ind:${ind}:${pid}`, group: null, personId: pid, truth: 'false', eventId: -1, key: false,
        text: fill(tpl('indicator'), { person: name(pid), indicator: def.label }),
      });
    }
  }

  // --- Actions, consents, miranda -----------------------------------------------------------
  for (const e of events) {
    if (e.kind === 'frisk') {
      push({ id: `frisk:${e.id}`, group: null, personId: e.personId, truth: 'true', key: true, eventId: e.id, text: fill(tpl('action.frisk'), { person: name(e.personId) }) });
    } else if (e.kind === 'search') {
      push({
        id: `search:${e.id}`, group: null, personId: e.personId, truth: 'true', key: true, eventId: e.id,
        text: fill(tpl('action.search'), { person: name(e.personId), target: word('target', e.target) }),
      });
    } else if (e.kind === 'seizure') {
      push({ id: `seize:${e.id}`, group: null, personId: e.personId, truth: 'true', key: true, eventId: e.id, text: fill(tpl('seize'), { person: name(e.personId), item: e.item.label }) });
    }
  }
  for (const pid of order) {
    if (!subjects.has(pid)) continue;
    if (!friskedBy.has(pid)) {
      push({ id: `frisk:x:${pid}`, group: null, personId: pid, truth: 'false', key: false, eventId: -1, text: fill(tpl('action.frisk'), { person: name(pid) }) });
    } else if (!vehicleSearched.has(pid)) {
      push({ id: `search:x:${pid}`, group: null, personId: pid, truth: 'false', key: false, eventId: -1, text: fill(tpl('action.search'), { person: name(pid), target: word('target', 'vehicle') }) });
    }

    // Consent: the granted ones (key when a search or entry relied on it) and one never granted.
    const granted = grantedConsents.get(pid) ?? new Set<ConsentKind>();
    const relied = assessment.determinations.some((d) => d.basis === 'consent' && (d.personId === pid || d.doctrine === 'entry'));
    for (const e of events) {
      if (e.kind !== 'consent' || e.personId !== pid || !e.granted) continue;
      const id = `consent:${e.consent}:${pid}`;
      if (out.some((c) => c.id === id)) continue;
      push({ id, group: null, personId: pid, truth: 'true', key: relied, eventId: e.id, text: fill(tpl('consent'), { person: name(pid), consent: word('consent', e.consent) }) });
    }
    const never = CONSENT_KINDS.filter((k) => !granted.has(k)).sort();
    rng.shuffle(never);
    let pick: ConsentKind | undefined;
    for (const target of searchTargets.get(pid) ?? []) {
      const k = TARGET_CONSENT[target];
      if (!granted.has(k)) { pick = k; break; }
    }
    pick = pick ?? never[0];
    if (pick) {
      push({ id: `consent:${pick}:${pid}`, group: null, personId: pid, truth: 'false', key: false, eventId: -1, text: fill(tpl('consent'), { person: name(pid), consent: word('consent', pick) }) });
    }
  }
  for (const [pid, qid] of firstCustodialQuestion) {
    const truth = (advised.get(pid) ?? []).some((id) => id < qid);
    push({ id: `miranda:${pid}`, group: null, personId: pid, truth: truth ? 'true' : 'false', key: truth, eventId: qid, text: fill(tpl('miranda'), { person: name(pid) }) });
  }

  // --- Force --------------------------------------------------------------------------------
  for (const e of events) {
    if (e.kind !== 'force' || e.level === 'presence') continue;
    for (const level of RESISTANCE_LEVELS) {
      push({
        id: `res:${e.id}:${level}`, group: `res:${e.id}`, personId: e.personId, truth: level === e.resistance ? 'true' : 'false',
        key: level === e.resistance, eventId: e.id,
        text: fill(tpl('resistance'), { person: name(e.personId), level: word('resistance', level), tool: word('tool', e.tool) }),
      });
    }
  }

  // --- Arrest and probable cause ------------------------------------------------------------
  for (const [pid, eventId] of arrestEvent) {
    push({ id: `arrest:${pid}`, group: null, personId: pid, truth: 'true', key: true, eventId, text: fill(tpl('arrest'), { person: name(pid) }) });
    const pa = assessment.persons.find((x) => x.personId === pid);
    if (!pa) continue;
    const candidates = new Set<Offense>();
    for (const ind of indicators.get(pid)?.keys() ?? []) {
      const o = indicatorOffense(ind);
      if (o) candidates.add(o);
    }
    const sorted = OFFENSES.filter((o) => candidates.has(o) && o !== pa.arrestOffense).sort();
    let list: Offense[];
    if (pa.arrestOffense !== null) {
      rng.shuffle(sorted);
      list = [pa.arrestOffense, ...sorted.slice(0, 1)];
    } else {
      list = sorted.sort((a, b) => (pa.pcAtArrest[b] ?? 0) - (pa.pcAtArrest[a] ?? 0) || (a < b ? -1 : 1)).slice(0, 2);
    }
    for (const o of list) {
      const supported = (pa.pcAtArrest[o] ?? 0) >= rs.thresholds.pc;
      push({
        id: `pc:${pid}:${o}`, group: null, personId: pid, truth: supported ? 'true' : 'unsupported', eventId,
        key: supported && o === pa.arrestOffense,
        text: fill(tpl('pc'), { person: name(pid), offense: rs.offenses[o].label }),
      });
    }
  }

  // --- Duty to intervene, camera ------------------------------------------------------------
  for (const ep of episodes) {
    const did = ep.ids.some((id) => intervened.has(id));
    push({
      id: `intervene:${ep.root.id}`, group: null, personId: ep.personId, truth: did ? 'true' : 'false', key: did, eventId: ep.root.id,
      text: fill(tpl('intervene'), { person: name(ep.personId), officer: ep.officer }),
    });
  }
  const recordingProblem = assessment.determinations.some((d) => d.doctrine === 'recording');
  push({ id: 'cam:full', group: null, personId: -1, truth: recordingProblem ? 'false' : 'true', key: false, eventId: -1, text: tpl('cam') });

  return out.sort(byId);
}
