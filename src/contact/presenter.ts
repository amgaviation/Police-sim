import { formatClockTime } from '../records/calendar';
import { TOPICS, type Inconsistency, type Tone, type Utterance } from '../dialogue';
import type { PersonFact, Statement } from '../people';
import type { DialogueOptionView, DialogueTopicView, DialogueView, NoteLine, TranscriptLine } from '../ui/dialogue/types';
import type { ContactActionId } from './types';

/**
 * Presenter helpers (design §10.4): turn what the player has DISCOVERED into the `DialogueView` text. Nothing
 * here receives hidden truth (statement truthfulness, undiscovered items, traits): only claims, facts and
 * observations the player already has.
 */

export const ACTION_LABELS: Readonly<Record<ContactActionId, string>> = {
  frisk: 'Frisk (pat down)',
  searchPerson: 'Search person',
  searchVehicle: 'Search vehicle',
  visualCheck: 'Look into vehicle',
  pbt: 'Breath test (PBT)',
  sfst: 'Field sobriety tests',
  checkId: 'Examine ID card',
  runName: 'Run name',
  runId: 'Run ID number',
  runPlate: 'Run plate',
  checkVin: 'Check VIN',
  cuff: 'Handcuff',
  uncuff: 'Remove handcuffs',
  escort: 'Escort',
  stopEscort: 'Stop escorting',
  release: 'Release',
  warnRelease: 'Warn and release',
  writeCitation: 'Write citation',
  notifyGuardian: 'Notify guardian',
  useTranslationApp: 'Use translation app',
  requestInterpreter: 'Request interpreter',
  seize: 'Seize found items',
};

export const FACT_LABELS: Readonly<Record<string, string>> = {
  name: 'Name',
  dob: 'Date of birth',
  address: 'Address',
  identity: 'Identity',
  idCard: 'ID card',
  appearance: 'Appearance',
  destination: 'Destination',
  origin: 'Coming from',
  account: 'Account',
  drinking: 'Drinking',
  drugs: 'Drugs',
  weapons: 'Weapons',
  vehicleContents: 'Vehicle contents',
  vehicleOwner: 'Vehicle owner',
  injured: 'Injured',
  suspectWhereabouts: 'Suspect location',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  claim: 'said',
  document: 'ID card',
  record: 'records',
  evidence: 'evidence',
  observation: 'observed',
  booking: 'booking',
};

const DEMEANOR_CUES: Readonly<Record<string, string>> = {
  cooperative: 'Calm',
  nervous: 'Nervous',
  evasive: 'Evasive',
  hostile: 'Hostile',
  distraught: 'Distraught',
  confused: 'Confused',
  crisis: 'In crisis',
  unresponsive: 'Unresponsive',
  animal: '',
};

/** Observable cue for a behaviour demeanor ('' when there is none). */
export function demeanorCue(demeanor: string): string {
  return DEMEANOR_CUES[demeanor] ?? '';
}

/** `"{time} {fact}: {display}"`. */
export function statementNote(s: Statement): NoteLine {
  return { text: `${formatClockTime(s.game)} ${FACT_LABELS[s.fact] ?? s.fact}: ${s.text}`, severity: 'info' };
}

/** A discovered fact; evidence is flagged as a caution. */
export function factNote(f: PersonFact): NoteLine {
  const label = FACT_LABELS[f.topic] ?? f.topic;
  const source = SOURCE_LABELS[f.source] ?? f.source;
  const detail = f.detail === '' ? '' : ` - ${f.detail}`;
  return { text: `${formatClockTime(f.game)} ${label} (${source}): ${f.display}${detail}`, severity: f.source === 'evidence' ? 'caution' : 'info' };
}

export function inconsistencyNote(i: Inconsistency): NoteLine {
  return { text: i.text, severity: i.severity };
}

/** Groups utterances by topic in the order of `TOPICS`; option labels are the officer's words in `tone`. */
export function groupTopics(
  list: readonly { utterance: Utterance; enabled: boolean; reason: string }[],
  label: (u: Utterance, tone: Tone) => string,
  tone: Tone,
): DialogueTopicView[] {
  const out: DialogueTopicView[] = [];
  for (const topic of TOPICS) {
    const options: DialogueOptionView[] = [];
    for (const entry of list) {
      if (entry.utterance.topic !== topic.id) continue;
      const base = { id: entry.utterance.id, label: label(entry.utterance, tone), enabled: entry.enabled };
      options.push(entry.reason === '' ? base : { ...base, hint: entry.reason });
    }
    out.push({ id: topic.id, label: topic.label, options });
  }
  return out;
}

/** `"Unknown male, ~35"` for an unidentified person, else the name they gave; the role follows in parentheses. */
export function titleOf(claimedName: string | null, sex: 'M' | 'F', roughAge: number, role: string): string {
  const base = claimedName !== null && claimedName.trim() !== '' ? claimedName : `Unknown ${sex === 'F' ? 'female' : 'male'}, ~${roughAge}`;
  const r = role === '' ? '' : role.charAt(0).toUpperCase() + role.slice(1);
  return r === '' ? base : `${base} (${r})`;
}

/** Subtitle chips joined with a middle dot. */
export function subtitleOf(parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join(' · ');
}

export interface ViewParts {
  readonly contactId: number;
  readonly title: string;
  readonly subtitle: string;
  readonly tone: DialogueView['tone'];
  readonly commMode: DialogueView['commMode'];
  readonly commModes: DialogueView['commModes'];
  readonly topics: readonly DialogueTopicView[];
  readonly actions: readonly DialogueOptionView[];
  readonly transcript: readonly TranscriptLine[];
  readonly statements: readonly NoteLine[];
  readonly facts: readonly NoteLine[];
  readonly inconsistencies: readonly NoteLine[];
  readonly busy: boolean;
}

export function buildView(p: ViewParts): DialogueView {
  return {
    contactId: p.contactId,
    title: p.title,
    subtitle: p.subtitle,
    tone: p.tone,
    commMode: p.commMode,
    commModes: p.commModes,
    topics: p.topics,
    actions: p.actions,
    transcript: p.transcript,
    statements: p.statements,
    facts: p.facts,
    inconsistencies: p.inconsistencies,
    busy: p.busy,
  };
}
