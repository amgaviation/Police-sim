/**
 * Internal-affairs bodycam review (design phase 5 §12.3): maps an incident log, its assessment and an IA case into the
 * evidence review panel's `ReviewSource` and statement `ReviewFooter`. Pure apart from the media store reads.
 */
import { ruleLabel } from '../../conduct/ia';
import type { IaCase, IaStatement, IaStatementOption } from '../../conduct/types';
import { DEFAULT_RULESET_ID, getRuleset } from '../../legal';
import type {
  Determination,
  ForceRuling,
  IncidentEvent,
  IncidentLog,
  LegalAssessment,
  PursuitRuling,
} from '../../legal';
import type { MediaStore, ReviewEvent, ReviewFooter, ReviewSource } from '../../recording';

type Severity = ReviewEvent['severity'];

/** Event kinds left out of the review list: the 1 Hz pursuit samples would bury everything else. */
export const REVIEW_SKIPPED_KINDS: readonly IncidentEvent['kind'][] = ['pursuitSample'];

const TOOL_LABELS: Readonly<Record<string, string>> = {
  none: 'Presence',
  hands: 'Hands',
  ocSpray: 'OC spray',
  baton: 'Baton',
  taser: 'TASER',
  lessLethal: 'Less-lethal launcher',
  firearm: 'Firearm',
  firearmDisplay: 'Firearm drawn',
  k9: 'K9',
};

const LEVEL_LABELS: Readonly<Record<string, string>> = {
  presence: 'presence',
  verbal: 'verbal commands',
  softHands: 'soft hands',
  hardHands: 'hard hands',
  ocSpray: 'OC spray',
  baton: 'baton',
  taser: 'TASER',
  k9: 'K9',
  lessLethal: 'less-lethal',
  firearm: 'firearm',
};

const RELEASE_LABELS: Readonly<Record<string, string>> = {
  release: 'Released',
  warn: 'Released with a warning',
  citation: 'Released with a citation',
  uncuff: 'Uncuffed',
};

/** "ocSpray" -> "OC spray" style fallback for ids without a label. */
function words(id: string): string {
  const text = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Display name of a force tool id (`FORCE_TOOLS` plus the `firearmDisplay` presence tool). */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? words(tool);
}

function indicatorText(e: Extract<IncidentEvent, { kind: 'indicator' }>, labelOf: (id: string) => string): string {
  if (e.detail !== '') return e.detail;
  const label = labelOf(e.indicator);
  // "Observed speeding" -> "speeding"; "Odor of alcohol" -> "odor of alcohol"; keep acronyms as they are.
  const stripped = label.replace(/^Observed /, '');
  return /^[A-Z][a-z]/.test(stripped) ? stripped.charAt(0).toLowerCase() + stripped.slice(1) : stripped;
}

/** The review label of one event (design 12.3); `force` also needs its ruling, so it takes the assessment's rulings. */
function labelOf(e: IncidentEvent, forceByEvent: ReadonlyMap<number, ForceRuling>, indicatorLabel: (id: string) => string): string {
  switch (e.kind) {
    case 'start':
      return `Incident start: ${e.typeId}`;
    case 'person':
      return `Person: ${e.label} (${e.role})`;
    case 'indicator':
      return `Observed: ${indicatorText(e, indicatorLabel)}`;
    case 'detention':
      return `Detention (${e.how})`;
    case 'command':
      return `Command: ${e.command} — ${e.outcome}`;
    case 'question':
      return `Q: ${e.fact}${e.custody ? ' (custody)' : ''}${e.gunpoint ? ' (gunpoint)' : ''}`;
    case 'statement':
      return `A: ${e.fact} = ${e.value}`;
    case 'miranda':
      return `Miranda: ${e.result}${e.custody ? '' : ' (not in custody)'}`;
    case 'consent':
      return `Consent: ${e.consent} ${e.granted ? 'granted' : 'refused'}`;
    case 'frisk':
      return e.found.length > 0 ? `Frisk — found ${String(e.found.length)}` : 'Frisk';
    case 'search':
      return e.found.length > 0 ? `Search of ${e.target} — found ${String(e.found.length)}` : `Search of ${e.target}`;
    case 'seizure':
      return `Seized: ${e.item.label}`;
    case 'test':
      return `${e.test === 'pbt' ? 'Breath test' : 'Field sobriety test'}: ${e.result}`;
    case 'arrest':
      return e.how === 'booking' ? 'Arrest (booking)' : 'Arrest';
    case 'charges':
      return `Charges: ${e.statutes.join(', ') || 'none'}`;
    case 'release':
      return RELEASE_LABELS[e.how] ?? 'Released';
    case 'force': {
      const ruling = forceByEvent.get(e.id);
      const verdict = ruling ? ` (${ruling.verdict})` : '';
      const miss = !e.hit && e.level !== 'presence' ? ', missed' : '';
      return `${toolLabel(e.tool)} — ${e.resistance} resistance${verdict}${miss}`;
    }
    case 'otherForce': {
      const ruling = forceByEvent.get(e.id);
      return `${e.officer}: ${LEVEL_LABELS[e.level] ?? e.level} on ${e.resistance} resistance${ruling ? ` (${ruling.verdict})` : ''}`;
    }
    case 'intervene':
      return 'Intervened';
    case 'entry':
      return e.publicPlace ? 'Entered a public place' : 'Entered the building';
    case 'exigency':
      return `Exigency: ${e.reason}`;
    case 'warrant':
      return `Warrant (${e.scope})`;
    case 'service':
      return `${words(e.service)} ${e.phase}`;
    case 'pursuitStart':
      return `Pursuit begins (${e.pursuit})`;
    case 'pursuitSample':
      return `Pursuit: ${String(Math.round(e.speedMph))} mph in a ${String(Math.round(e.limitMph))}`;
    case 'pursuitEnd':
      return `Pursuit ends: ${e.reason}`;
    case 'advisory':
      return `Advisory: ${e.text}`;
    case 'cam': {
      const body = e.body ? (e.muted ? 'MUTED' : 'ON') : 'OFF';
      return `Bodycam ${body}${e.dash ? ' · Dashcam ON' : ''}`;
    }
    case 'close':
      return `Incident closed (${e.disposition})`;
  }
}

/** Raises an event's severity (bad beats warn beats info). */
function raise(map: Map<number, Severity>, id: number, severity: Severity): void {
  if (severity === 'info') return;
  if (severity === 'bad' || map.get(id) !== 'bad') map.set(id, severity);
}

function determinationSeverity(d: Determination): Severity {
  return d.outcome === 'unlawful' ? 'bad' : d.outcome === 'questionable' ? 'warn' : 'info';
}

function forceSeverity(f: ForceRuling): Severity {
  return f.verdict === 'excessive' ? 'bad' : f.verdict === 'questionable' ? 'warn' : 'info';
}

function pursuitSeverity(p: PursuitRuling): Severity {
  return p.outcome === 'unlawful' ? 'bad' : p.outcome === 'questionable' ? 'warn' : 'info';
}

/** Severity per event id: bad for an unlawful determination or an excessive ruling, warn for a questionable one. */
function severities(a: LegalAssessment | null): Map<number, Severity> {
  const map = new Map<number, Severity>();
  if (!a) return map;
  for (const d of a.determinations) {
    const s = determinationSeverity(d);
    for (const id of d.eventIds.length > 0 ? d.eventIds : [d.eventId]) raise(map, id, s);
  }
  for (const f of a.force) raise(map, f.eventId, forceSeverity(f));
  for (const p of a.pursuits) raise(map, p.startEventId, pursuitSeverity(p));
  return map;
}

/**
 * The review list of an incident: one entry per event (pursuit samples excluded) with a plain-language label, the
 * camera bits of the event, and a severity from the assessment: `bad` for an event with an unlawful determination or an
 * excessive force ruling, `warn` for a questionable one, `info` otherwise. Without an assessment everything is `info`.
 */
export function reviewEventsOf(log: IncidentLog, a: LegalAssessment | null): ReviewEvent[] {
  const rs = getRuleset(a?.rulesetId ?? DEFAULT_RULESET_ID);
  const forceByEvent = new Map<number, ForceRuling>();
  for (const f of a?.force ?? []) forceByEvent.set(f.eventId, f);
  const sev = severities(a);
  const indicatorLabel = (id: string): string => rs.indicators[id]?.label ?? words(id);
  const out: ReviewEvent[] = [];
  for (const e of log.events) {
    if (REVIEW_SKIPPED_KINDS.includes(e.kind)) continue;
    out.push({ id: e.id, t: e.t, label: labelOf(e, forceByEvent, indicatorLabel), kind: e.kind, severity: sev.get(e.id) ?? 'info', cam: e.cam });
  }
  return out;
}

/**
 * The review source of an IA case: the incident's events, spanning its first event to its close, with the snapshots of
 * the incident from the media store. Events an IA trigger is about are at least `warn`. Pass the incident's assessment to
 * colour the list; without it only the trigger events stand out.
 */
export function iaReviewSource(log: IncidentLog, c: IaCase, media: MediaStore, tag: string, a: LegalAssessment | null = null): ReviewSource {
  const events = reviewEventsOf(log, a);
  const flagged = new Set<number>();
  for (const t of c.triggers) for (const id of t.eventIds) flagged.add(id);
  for (const e of events) if (e.severity === 'info' && flagged.has(e.id)) e.severity = 'warn';
  const first = log.events[0]?.t ?? log.openedSim;
  const last = log.events[log.events.length - 1]?.t ?? first;
  const t0 = Math.min(first, log.openedSim);
  const t1 = Math.max(last, log.closedSim, t0 + 1);
  return {
    title: `${c.id} · ${log.key}`,
    t0,
    t1,
    events,
    snapshots: () => media.list(tag, log.key),
    image: (key) => media.get(key),
  };
}

const FINDING_TEXT: Readonly<Record<string, string>> = {
  exonerated: 'Exonerated',
  unfounded: 'Unfounded',
  notSustained: 'Not sustained',
  sustained: 'Sustained',
};

/**
 * The statement step under the review: the case and its reasons, then the numbered statement options. After a pick (or
 * when the case already has a statement or is closed) the options are gone and the lines show the outcome. `submit` gets
 * the chosen option's statement once.
 */
export function iaReviewFooter(c: IaCase, options: readonly IaStatementOption[], submit: (s: IaStatement) => void): ReviewFooter {
  let picked: IaStatementOption | null = null;
  const done = (): boolean => picked !== null || c.statement !== null || c.status !== 'open';
  return {
    lines: () => {
      const lines = [`Internal affairs ${c.id} (${c.severity})`, `Concerns: ${c.triggers.map((t) => ruleLabel(t.rule)).join(', ') || 'a complaint'}`];
      if (c.finding !== null) lines.push(`Finding: ${FINDING_TEXT[c.finding] ?? c.finding}`);
      else if (picked !== null) lines.push(`Your statement was recorded: ${picked.text}`);
      else if (c.statement !== null) lines.push('Your statement is on file.');
      else if (c.status !== 'open') lines.push('This case is closed.');
      else lines.push('Review the footage, then give your statement:');
      return lines;
    },
    options: () => (done() ? [] : options.map((o) => o.text)),
    pick: (index) => {
      if (done()) return;
      const option = options[index];
      if (!option) return;
      picked = option;
      submit(option.statement);
    },
  };
}
