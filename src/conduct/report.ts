import { CAM, type IncidentLog, type ReportChoice } from '../legal/types';
import type { ReportGrade, ReportLetter } from './types';

const MAX_MISSING = 5;

/** Is the camera recording unmuted at this event? */
function onCam(cam: number): boolean {
  return (cam & CAM.body) !== 0 && (cam & CAM.muted) === 0;
}

/** Did the body camera record the matter a claim is about? A distractor (no event) counts when most of the person's events were. */
function recorded(c: ReportChoice, log: IncidentLog): boolean {
  if (c.eventId >= 0) {
    const e = log.events.find((x) => x.id === c.eventId);
    return e !== undefined && onCam(e.cam);
  }
  let total = 0;
  let cam = 0;
  for (const e of log.events) {
    if (c.personId >= 0 && e.personId !== c.personId) continue;
    total++;
    if (onCam(e.cam)) cam++;
  }
  return total > 0 && cam * 2 >= total;
}

function letterOf(score: number): ReportLetter {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

/**
 * Grades the statements of fact the officer asserted (design 10.2). Completeness is the share of key true facts
 * asserted; a false claim is a contradiction (heavier when the unmuted bodycam recorded the truth); two assertions of
 * one exclusive group are one contradiction; an unsupported claim costs less.
 */
export function gradeReport(
  choices: readonly ReportChoice[], assertions: readonly string[], log: IncidentLog, docId: string, game: number,
): ReportGrade {
  const asserted = new Set(assertions);
  const keyTrue = choices.filter((c) => c.key && c.truth === 'true');
  const hit = keyTrue.filter((c) => asserted.has(c.id)).length;
  const chosen = choices.filter((c) => asserted.has(c.id));
  // With no key facts, a report earns full completeness only by asserting something true: a blank report scores nothing.
  const completeness = keyTrue.length === 0 ? (chosen.some((c) => c.truth === 'true') ? 1 : 0) : hit / keyTrue.length;

  const contradictions: ReportGrade['contradictions'] = [];
  const consumed = new Set<string>();

  const groups = new Map<string, ReportChoice[]>();
  for (const c of chosen) {
    if (c.group === null) continue;
    const list = groups.get(c.group);
    if (list) list.push(c);
    else groups.set(c.group, [c]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const c of list) consumed.add(c.id);
    contradictions.push({ text: list.map((c) => c.text).join(' / '), onCamera: list.some((c) => recorded(c, log)) });
  }
  for (const c of chosen) {
    if (c.truth === 'false' && !consumed.has(c.id)) contradictions.push({ text: c.text, onCamera: recorded(c, log) });
  }

  const unsupported = chosen.filter((c) => c.truth === 'unsupported').map((c) => c.text);
  const onCameraCount = contradictions.filter((c) => c.onCamera).length;
  const offCameraCount = contradictions.length - onCameraCount;
  const raw = 100 * completeness - 12 * offCameraCount - 20 * onCameraCount - 10 * unsupported.length;
  const score = Math.min(100, Math.max(0, Math.round(raw)));
  return {
    docId,
    key: log.key,
    score,
    letter: letterOf(score),
    completeness,
    missing: keyTrue.filter((c) => !asserted.has(c.id)).slice(0, MAX_MISSING).map((c) => c.text),
    contradictions,
    unsupported,
    game,
  };
}
