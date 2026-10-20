import type { Rng } from '../core/rng';
import { getRuleset } from '../legal/ruleset';
import { CAM, RESISTANCE_LEVELS, type ConsentKind, type IncidentEvent } from '../legal/types';
import { COURT_CONFIG, QUESTIONS, type CourtConfig } from './data';
import type { Answer, CrossExamInput, CrossExamQuestion, TestimonyResult } from './types';

/**
 * Cross-examination (design 11.2): questions are generated from the incident log, its legal assessment and the
 * officer's report assertions; the answers are scored against the same facts. Pure and deterministic: the only
 * randomness is the order, drawn from the injected `Rng` (the app passes `createRng(seed).stream('court:' + caseId)`).
 */

interface Candidate {
  /** Sort / dedupe key: `kind:eventId`, or `kind:choiceId` for report-based questions. */
  key: string;
  q: Omit<CrossExamQuestion, 'id'>;
  /** The statement form of the question, for a later `repeat`. */
  restated: string;
}

/** Search target -> the consent kinds that cover it. */
const COVERING: Readonly<Record<string, readonly ConsentKind[]>> = {
  frisk: ['searchPerson'],
  person: ['searchPerson'],
  vehicle: ['searchVehicle'],
  premises: ['searchPremises'],
  container: ['searchPremises'],
  room: ['searchRoom', 'searchPremises'],
};

function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

function label(group: keyof typeof QUESTIONS.labels, key: string): string {
  return QUESTIONS.labels[group][key] ?? key;
}

function byKey(a: Candidate, b: Candidate): number {
  return b.q.weight - a.q.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function invert(v: 'yes' | 'no'): 'yes' | 'no' {
  return v === 'yes' ? 'no' : 'yes';
}

/** Is a truthful 'yes'/'no' answer: unmuted body camera bit set. */
function recorded(cam: number): boolean {
  return (cam & CAM.body) !== 0 && (cam & CAM.muted) === 0;
}

/**
 * Generates at most `cfg.maxQuestions` questions for `input.personId`. Candidate kinds: resistanceAt, consentGiven,
 * mirandaBefore, camDuring, reportAssertion and omission (the last two only when a report was filed); the
 * `maxQuestions - 1` heaviest are kept, shuffled with `rng`, and with four or more a `repeat` of the heaviest is appended.
 */
export function generateCrossExam(input: CrossExamInput, rng: Rng, cfg: CourtConfig = COURT_CONFIG): CrossExamQuestion[] {
  const { log, assessment, choices, personId } = input;
  const asserted = input.assertions === null ? null : new Set(input.assertions);
  const assertions = input.assertions ?? [];
  const rs = getRuleset(assessment.rulesetId);
  const T = QUESTIONS.templates;
  const R = QUESTIONS.restatements;
  const byId = new Map<number, IncidentEvent>();
  for (const e of log.events) byId.set(e.id, e);
  const onCamera = (eventId: number): boolean => {
    const e = byId.get(eventId);
    return e !== undefined && recorded(e.cam);
  };
  const out: Candidate[] = [];

  // Custody state of the person, walked in event order (the engine's rule: cuffed detention / arrest until release).
  let custody = false;
  const advisedBefore: number[] = [];
  const askedFacts = new Set<string>();

  for (const e of log.events) {
    if (e.personId !== personId) continue;
    switch (e.kind) {
      case 'detention':
        if (e.how === 'cuffed') custody = true;
        break;
      case 'release':
        custody = false;
        break;
      case 'miranda':
        if (e.result === 'waived' || e.result === 'invoked') advisedBefore.push(e.id);
        break;
      case 'question': {
        const custodial = custody || e.custody || (rs.miranda.custodyIncludesGunpoint && e.gunpoint);
        if (!custodial || !rs.miranda.incriminatingFacts.includes(e.fact) || askedFacts.has(e.fact)) break;
        askedFacts.add(e.fact);
        const yes = advisedBefore.length > 0;
        const vars = { fact: label('fact', e.fact) };
        out.push({
          key: `mirandaBefore:${e.id}`,
          restated: fill(R.mirandaBefore, vars),
          q: {
            kind: 'mirandaBefore', text: fill(T.mirandaBefore, vars), truth: yes ? 'yes' : 'no',
            reportSays: asserted !== null && asserted.has(`miranda:${personId}`) ? 'yes' : null,
            eventId: e.id, onCamera: recorded(e.cam), weight: 2.5, pairOf: null,
          },
        });
        break;
      }
      case 'arrest':
        custody = true;
        break;
      default: break;
    }
  }

  const consents = log.events.filter((e) => e.kind === 'consent' && e.granted && e.valid);
  for (const e of log.events) {
    if (e.personId !== personId) continue;
    if (e.kind === 'force' && e.level !== 'presence') {
      // The level the report asserted (res:<eventId>:<level>), else the logged resistance.
      const prefix = `res:${e.id}:`;
      const claimed = assertions.find((a) => a.startsWith(prefix) && (RESISTANCE_LEVELS as readonly string[]).includes(a.slice(prefix.length)));
      const level = claimed !== undefined ? claimed.slice(prefix.length) : e.resistance;
      const ruling = assessment.force.find((f) => f.eventId === e.id && !f.other);
      const vars = { level: label('resistance', level), tool: label('tool', e.tool) };
      out.push({
        key: `resistanceAt:${e.id}`,
        restated: fill(R.resistanceAt, vars),
        q: {
          kind: 'resistanceAt', text: fill(T.resistanceAt, vars), truth: level === e.resistance ? 'yes' : 'no',
          reportSays: claimed !== undefined ? 'yes' : null, eventId: e.id, onCamera: recorded(e.cam),
          weight: 3 + (ruling !== undefined && ruling.verdict !== 'justified' ? 2 : 0), pairOf: null,
        },
      });
    }
    if (e.kind === 'frisk' || e.kind === 'search') {
      const target = e.kind === 'frisk' ? 'frisk' : e.target;
      const kinds = COVERING[target] ?? [];
      const building = e.kind === 'search' ? e.buildingId : -1;
      const shared = target === 'premises' || target === 'room' || target === 'container';
      const given = consents.some(
        (c) => c.kind === 'consent' && c.id < e.id && kinds.includes(c.consent) && (c.personId === personId || (shared && building >= 0 && c.buildingId === building)),
      );
      const unlawful = assessment.determinations.some((d) => d.eventId === e.id && (d.doctrine === 'search' || d.doctrine === 'frisk') && d.outcome === 'unlawful');
      const reportSays = asserted !== null && kinds.some((k) => asserted.has(`consent:${k}:${personId}`)) ? 'yes' : null;
      const searchVars = { search: label('search', target) };
      out.push({
        key: `consentGiven:${e.id}`,
        restated: fill(R.consentGiven, searchVars),
        q: {
          kind: 'consentGiven', text: fill(T.consentGiven, searchVars), truth: given ? 'yes' : 'no', reportSays,
          eventId: e.id, onCamera: recorded(e.cam), weight: unlawful ? 3 : 1.5, pairOf: null,
        },
      });
    }
    if (e.kind === 'frisk' || e.kind === 'search' || e.kind === 'force' || e.kind === 'arrest') {
      const action =
        e.kind === 'search' ? fill(label('action', 'search'), { search: label('search', e.target) }) : label('action', e.kind);
      const vars = { action };
      const rec = recorded(e.cam);
      out.push({
        key: `camDuring:${e.id}`,
        restated: fill(R.camDuring, vars),
        q: {
          kind: 'camDuring', text: fill(T.camDuring, vars), truth: rec ? 'yes' : 'no',
          reportSays: asserted !== null && asserted.has('cam:full') ? 'yes' : null, eventId: e.id, onCamera: rec, weight: 1.5, pairOf: null,
        },
      });
    }
  }

  if (asserted !== null) {
    let trueTaken = 0;
    for (const c of choices) {
      if (c.personId !== personId) continue;
      const text = c.text.replace(/\.$/, '');
      if (asserted.has(c.id)) {
        if (c.truth !== 'true') {
          out.push({
            key: `reportAssertion:${c.id}`, restated: fill(R.reportAssertion, { text }),
            q: {
              kind: 'reportAssertion', text: fill(T.reportAssertion, { text: c.text }), truth: 'no', reportSays: 'yes',
              eventId: c.eventId, onCamera: onCamera(c.eventId), weight: 2, pairOf: null,
            },
          });
        } else if (trueTaken < 2) {
          trueTaken++;
          out.push({
            key: `reportAssertion:${c.id}`, restated: fill(R.reportAssertion, { text }),
            q: {
              kind: 'reportAssertion', text: fill(T.reportAssertion, { text: c.text }), truth: 'yes', reportSays: 'yes',
              eventId: c.eventId, onCamera: onCamera(c.eventId), weight: 0.5, pairOf: null,
            },
          });
        }
      } else if (c.key && c.truth === 'true') {
        out.push({
          key: `omission:${c.id}`, restated: fill(R.omission, { text }),
          q: {
            kind: 'omission', text: fill(T.omission, { text: c.text }), truth: 'yes', reportSays: 'no',
            eventId: c.eventId, onCamera: onCamera(c.eventId), weight: 1, pairOf: null,
          },
        });
      }
    }
  }

  out.sort(byKey);
  const seen = new Set<string>();
  const unique = out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
  const kept = unique.slice(0, Math.max(1, cfg.maxQuestions - 1));
  const top = kept[0];
  const shuffled = rng.shuffle(kept.slice());
  const questions: CrossExamQuestion[] = shuffled.map((c, i) => ({ id: `q${i + 1}`, ...c.q }));
  if (top !== undefined && kept.length >= 4) {
    const pair = questions[shuffled.indexOf(top)];
    if (pair !== undefined) {
      questions.push({
        id: `q${questions.length + 1}`, kind: 'repeat', text: fill(T.repeat, { restated: top.restated }),
        truth: invert(pair.truth), reportSays: pair.reportSays === null ? null : invert(pair.reportSays),
        eventId: pair.eventId, onCamera: pair.onCamera, weight: pair.weight, pairOf: pair.id,
      });
    }
  }
  return questions;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Scores the officer's answers (design 11.2). Per question: "don't recall" is evasive; the true answer is consistent
 * (and a report mismatch when the report says otherwise); a false answer is a contradiction, an impeachment when the
 * event is on unmuted bodycam. A `repeat` answered like its pair is self-inconsistent. Missing answers count as
 * "don't recall". `contradictions` counts only the off-camera ones: impeachments are counted separately.
 */
export function scoreTestimony(qs: readonly CrossExamQuestion[], answers: readonly Answer[], cfg: CourtConfig = COURT_CONFIG): TestimonyResult {
  const r: TestimonyResult = {
    credibilityDelta: 0, score: 0, consistent: 0, impeached: 0, contradictions: 0, evasive: 0, selfInconsistent: 0,
    reportMismatches: 0, notes: [],
  };
  const answerOf = new Map<string, Answer>();
  qs.forEach((q, i) => answerOf.set(q.id, answers[i] ?? 'dontRecall'));
  for (const q of qs) {
    const a = answerOf.get(q.id) ?? 'dontRecall';
    if (a === 'dontRecall') {
      r.evasive++;
      r.notes.push(`Could not recall on ${q.id}`);
    } else if (a === q.truth) {
      r.consistent++;
      if (q.reportSays !== null && a !== q.reportSays) {
        r.reportMismatches++;
        r.notes.push(`Testimony differs from the filed report on ${q.id}`);
      }
    } else if (q.onCamera) {
      r.impeached++;
      r.notes.push(`Impeached by bodycam footage on ${q.id}`);
    } else {
      r.contradictions++;
      r.notes.push(`Contradicted the incident record on ${q.id}`);
    }
    if (q.kind === 'repeat' && q.pairOf !== null) {
      const first = answerOf.get(q.pairOf);
      if ((a === 'yes' || a === 'no') && first === a) {
        r.selfInconsistent++;
        r.notes.push(`Contradicted own testimony on ${q.pairOf} and ${q.id}`);
      }
    }
  }
  const c = cfg.credibility;
  const t = cfg.testimony;
  r.credibilityDelta = round(
    r.consistent * c.consistent + r.evasive * c.evasive + r.reportMismatches * c.reportMismatch + r.contradictions * c.contradictOffCam +
      r.impeached * c.impeachOnCam + r.selfInconsistent * c.selfInconsistent,
  );
  r.score = round(
    Math.max(0, Math.min(1, t.base + r.consistent * t.consistent + r.impeached * t.impeached + r.contradictions * t.contradiction +
      r.evasive * t.evasive + r.selfInconsistent * t.selfInconsistent)),
  );
  return r;
}
