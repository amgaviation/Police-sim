import type { Rng } from '../core/rng';
import { NAMES } from '../records/data';
import { formatDate } from '../records/calendar';
import { itemDef } from '../people/items';
import type { CarriedItem } from '../people';
import { GREET_DEMEANORS, LINE_KEYS, RESPONSES, TRUST, UTTERANCE_DATA } from './data';
import type {
  CommMode,
  ConsentKind,
  DialogueContext,
  DialogueResult,
  DialogueStatement,
  FactTopic,
  IdentityClaim,
  Intent,
  Requirement,
  SubjectMemory,
  SubjectProfile,
  Tone,
  Utterance,
} from './types';

/**
 * Utterance/response engine (design §9.2-§9.3). Pure: every random draw comes from the `Rng` argument,
 * the subject memory is copied (never mutated) and returned in the result.
 */

export { LINE_KEYS };

export const UTTERANCES: readonly Utterance[] = UTTERANCE_DATA.utterances;
export const TOPICS: readonly { id: string; label: string }[] = UTTERANCE_DATA.topics;

const BY_ID: ReadonlyMap<string, Utterance> = new Map(UTTERANCES.map((u) => [u.id, u]));

/** The utterance `id`; throws on an unknown id. */
export function utterance(id: string): Utterance {
  const u = BY_ID.get(id);
  if (!u) throw new Error(`Unknown utterance "${id}"`);
  return u;
}

// --- Tuning ------------------------------------------------------------------------

/** Seconds before the answer arrives, per communication mode. */
export const MODE_DELAY_S: Readonly<Record<CommMode, number>> = { verbal: 0, written: 4, gesture: 0, translationApp: 6, interpreter: 2 };
/** Chance the translation app garbles an exchange. */
export const APP_MISUNDERSTAND = 0.1;
/** Stress above which a hostile or evasive subject escalates. */
export const ESCALATION_STRESS = 0.85;
/** Rapport that must be gained since a denied consent before it can be asked again. */
export const CONSENT_RETRY_RAPPORT = 0.3;
const SIMPLE_INTENTS: readonly Intent[] = ['greet', 'reassure', 'release', 'warn', 'thank'];
const TEMPERAMENT_STRESS = { calm: 0.1, timid: 0.35, irritable: 0.25, volatile: 0.35 } as const;
const DEMEANOR_STRESS: Readonly<Record<string, number>> = {
  cooperative: 0,
  nervous: 0.2,
  evasive: 0.25,
  hostile: 0.3,
  distraught: 0.3,
  confused: 0.15,
  crisis: 0.3,
};
const SILENT_DEMEANORS: readonly string[] = ['unresponsive', 'animal'];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function cloneMemory(m: SubjectMemory): SubjectMemory {
  return {
    rapport: m.rapport,
    stress: m.stress,
    greeted: m.greeted,
    reasonGiven: m.reasonGiven,
    mirandized: m.mirandized,
    identity: m.identity === null ? null : { ...m.identity },
    identityRefusals: m.identityRefusals,
    lies: { ...m.lies },
    asked: { ...m.asked },
    consent: { ...m.consent },
    consentAskedAt: { ...m.consentAskedAt },
  };
}

// --- Memory ------------------------------------------------------------------------

/** Starting memory of a contact: rapport from trust, history, attitude and uniform; stress from temperament, demeanor, guilt and presence. */
export function initialMemory(subject: SubjectProfile, ctx: DialogueContext): SubjectMemory {
  const id = subject.identity;
  const p = ctx.presence;
  let rapport = ctx.history.rapport * 0.5 + (ctx.trust - 0.5) * 0.6 + id.attitude * 0.2 - (p.uniform ? 0 : 0.1) - subject.intoxication.level * 0.05;
  let stress = TEMPERAMENT_STRESS[id.temperament] + (DEMEANOR_STRESS[subject.demeanor] ?? 0.1);
  if (subject.guilty) stress += 0.1;
  if (id.wanted) stress += 0.1;
  if (p.weapon === 'sidearm') stress += 0.12;
  else if (p.weapon === 'taser') stress += 0.1;
  if (p.lights) stress += 0.03;
  stress += 0.03 * Math.min(p.backup, 3) + subject.intoxication.level * 0.1;
  rapport = clamp(rapport, -1, 1);
  return {
    rapport,
    stress: clamp(stress, 0, 1),
    greeted: false,
    reasonGiven: false,
    mirandized: false,
    identity: null,
    identityRefusals: 0,
    lies: {},
    asked: {},
    consent: {},
    consentAskedAt: {},
  };
}

/**
 * Step 1 of §9.3: the effect of the officer's tone (and of `reassure`) on the memory, plus the night
 * penalty. Exported so the contact module can apply it to commands, which `respond` does not handle.
 */
export function toneEffect(mem: SubjectMemory, tone: Tone, demeanor: string, hour: number, intent: Intent): void {
  let dr = 0;
  let ds = 0;
  switch (tone) {
    case 'polite':
      dr = 0.08;
      ds = -0.03;
      break;
    case 'neutral':
      break;
    case 'commanding':
      dr = -0.02;
      ds = 0.05;
      break;
    case 'aggressive': {
      const m = demeanor === 'hostile' || demeanor === 'crisis' ? 2 : 1;
      dr = -0.12 * m;
      ds = 0.12 * m;
      break;
    }
  }
  if (intent === 'reassure') ds -= tone === 'polite' ? 0.15 * 1.5 : 0.15;
  if (hour >= 22 || hour < 5) ds += 0.02;
  mem.rapport = clamp(mem.rapport + dr, -1, 1);
  mem.stress = clamp(mem.stress + ds, 0, 1);
}

// --- Understanding -----------------------------------------------------------------

export interface Understanding {
  /** Chance the subject understands (0..1). */
  readonly p: number;
  readonly cause: 'deaf' | 'hoh' | 'foreign' | 'limited' | 'dementia' | 'none';
}

/** Chance the subject understands an utterance of `intent` in the current communication mode (§8.3 rates; questions use the "others" rates). */
export function understanding(subject: SubjectProfile, mode: CommMode, intent: Intent): Understanding {
  const id = subject.identity;
  const simple = SIMPLE_INTENTS.includes(intent);
  const aided = mode === 'written' || mode === 'interpreter' || mode === 'translationApp';
  let hearing = 1;
  if (id.hearing === 'deaf') hearing = aided ? 1 : mode === 'gesture' && simple ? 0.9 : 0;
  else if (id.hearing === 'hardOfHearing') hearing = aided ? 1 : mode === 'gesture' && simple ? 0.9 : 0.6;
  let language = 1;
  const english = id.language.english;
  if (english !== 'fluent' && mode !== 'interpreter' && mode !== 'translationApp') {
    language = english === 'none' ? (simple ? 0.6 : 0.1) : simple ? 0.8 : 0.5;
  }
  const dementia = id.dementia ? 0.5 : 1;
  const p = hearing * language * dementia;
  let cause: Understanding['cause'] = 'none';
  if (p < 1) {
    if (hearing < 1 && hearing <= language && hearing <= dementia) cause = id.hearing === 'deaf' ? 'deaf' : 'hoh';
    else if (language < 1 && language <= dementia) cause = english === 'none' ? 'foreign' : 'limited';
    else cause = 'dementia';
  }
  return { p, cause };
}

function unheardKey(cause: Understanding['cause']): string {
  switch (cause) {
    case 'deaf':
      return 'deaf.noResponse';
    case 'hoh':
      return 'hoh.repeat';
    case 'foreign':
      return 'foreign.untranslated';
    default:
      return 'limited.confused';
  }
}

/** Communication modes the officer can pick: verbal always; written and gesture for the hard of hearing; the app for non-fluent English. */
export function commModes(subject: SubjectProfile, ctx: DialogueContext): CommMode[] {
  const out: CommMode[] = ['verbal'];
  if (subject.identity.hearing !== 'normal') out.push('written', 'gesture');
  if (subject.identity.language.english !== 'fluent') out.push('translationApp');
  if (ctx.interpreterAvailable) out.push('interpreter');
  return out;
}

// --- Lying -------------------------------------------------------------------------

/** Chance the subject lies about an incriminating fact or gives a false identity (§9.3). */
export function lieChance(subject: SubjectProfile, memory: SubjectMemory): number {
  const id = subject.identity;
  const motive = subject.guilty || id.wanted;
  if (id.honesty >= 1 && !motive) return 0;
  const status = id.record.license.status;
  let l = (1 - id.honesty) * 0.8;
  if (id.wanted) l += 0.4;
  if ((status === 'suspended' || status === 'revoked' || status === 'none') && subject.inVehicle) l += 0.2;
  l -= memory.rapport * 0.2;
  l = clamp(l, 0, 0.95);
  return motive ? l : l * 0.2;
}

/** Chance of granting a consent (§9.3), clamped to [0, 1]. */
export function consentChance(kind: ConsentKind, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory): number {
  let p = 0.6 + 0.3 * memory.rapport - 0.2 * memory.stress;
  if (ctx.tone === 'polite') p += 0.1;
  const items = kind === 'searchVehicle' ? subject.vehicleItems : kind === 'searchPerson' ? subject.items : [];
  if (items.some(isIncriminating)) p -= 0.4;
  if ((kind === 'pbt' || kind === 'sfst') && subject.intoxication.bac > 0 && subject.intoxication.bac < 0.08) p += 0.1;
  return clamp(p, 0, 1);
}

function isIncriminating(item: CarriedItem): boolean {
  const d = itemDef(item.item);
  return d.contraband || d.statute !== null;
}

// --- Text --------------------------------------------------------------------------

/** Replaces the first two `s` of every word longer than three letters by `sh`. */
export function slur(text: string): string {
  return text.replace(/[A-Za-z']+/g, (word) => {
    if (word.length <= 3) return word;
    let n = 0;
    let out = '';
    for (const ch of word) {
      if (n < 2 && (ch === 's' || ch === 'S')) {
        out += ch === 's' ? 'sh' : 'Sh';
        n++;
      } else out += ch;
    }
    return out;
  });
}

function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? '');
}

function capitalize(text: string): string {
  const i = text.search(/[A-Za-z]/);
  if (i < 0) return text;
  const ch = text.charAt(i);
  return ch === ch.toUpperCase() ? text : text.slice(0, i) + ch.toUpperCase() + text.slice(i + 1);
}

function variants(key: string): readonly string[] {
  const v = RESPONSES.lines.get(key);
  if (!v) throw new Error(`Unknown line key "${key}"`);
  return v;
}

/** Picks a variant of `key`, fills the placeholders and slurs the text of a heavily intoxicated subject. */
function render(key: string, vars: Readonly<Record<string, string>>, level: number, rng: Rng): string {
  const text = capitalize(fill(rng.pick(variants(key)), vars));
  return level > 0.6 && !text.startsWith('(') ? slur(text) : text;
}

/** The officer's words for `u` in `tone`. */
export function officerLine(u: Utterance, tone: Tone, ctx: { officerName: string; reason: string }): string {
  return fill(u.text[tone], { officer: ctx.officerName, reason: ctx.reason });
}

/** The line a subject says after an NPC command outcome (`confused` explains why, by hearing and language). */
export function commandLine(
  outcome: 'comply' | 'refuse' | 'flee' | 'fight' | 'confused',
  subject: SubjectProfile,
  ctx: DialogueContext,
  rng: Rng,
): { lineKey: string; text: string } {
  const id = subject.identity;
  let key = `command.${outcome}`;
  if (SILENT_DEMEANORS.includes(subject.demeanor)) key = 'silent.none';
  else if (outcome === 'confused') {
    const u = understanding(subject, ctx.commMode, 'command');
    if (u.cause === 'deaf' || u.cause === 'hoh' || u.cause === 'foreign' || u.cause === 'limited') key = unheardKey(u.cause);
  }
  const vars = { language: id.language.label, officer: ctx.officerName };
  return { lineKey: key, text: render(key, vars, subject.intoxication.level, rng) };
}

// --- Availability ------------------------------------------------------------------

const REQUIREMENT_REASON: Readonly<Record<Requirement, string>> = {
  inVehicle: 'The subject is not in a vehicle',
  notInVehicle: 'The subject is in a vehicle',
  hasVehicle: 'No vehicle involved',
  onCall: 'Not on a call',
  armedSubject: 'No weapon in view',
  restrained: 'The subject is not restrained',
  notRestrained: 'The subject is restrained',
  juvenile: 'The subject is not a juvenile',
  notJuvenile: 'The subject is a juvenile',
  identityGiven: 'No identity given yet',
  notRestrainedOrAny: '',
};

/** Whether `req` holds for this subject and moment. */
export function requirementMet(req: Requirement, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory): boolean {
  switch (req) {
    case 'inVehicle':
      return subject.inVehicle;
    case 'notInVehicle':
      return !subject.inVehicle;
    case 'hasVehicle':
      return subject.inVehicle || subject.vehicleOwnerId >= 0 || subject.vehicleItems.length > 0;
    case 'onCall':
      return ctx.truth.reason !== '';
    case 'armedSubject':
      return subject.items.some((i) => i.visible && itemDef(i.item).weapon);
    case 'restrained':
      return subject.restrained;
    case 'notRestrained':
      return !subject.restrained;
    case 'juvenile':
      return subject.identity.juvenile;
    case 'notJuvenile':
      return !subject.identity.juvenile;
    case 'identityGiven':
      return memory.identity !== null;
    case 'notRestrainedOrAny':
      return true;
  }
}

/** Every utterance with whether the menu may offer it now and, when not, why. */
export function available(
  subject: SubjectProfile,
  ctx: DialogueContext,
  memory: SubjectMemory,
): { utterance: Utterance; enabled: boolean; reason: string }[] {
  const silent = SILENT_DEMEANORS.includes(subject.demeanor);
  return UTTERANCES.map((u) => {
    let reason = '';
    if (silent) reason = 'No response possible';
    else {
      for (const req of u.requires) {
        if (!requirementMet(req, subject, ctx, memory)) {
          reason = REQUIREMENT_REASON[req];
          break;
        }
      }
      const kind = u.consent;
      if (reason === '' && kind !== null) {
        const state = memory.consent[kind];
        if (state === 'granted') reason = 'Already consented';
        else if (state === 'denied' && memory.rapport < (memory.consentAskedAt[kind] ?? 0) + CONSENT_RETRY_RAPPORT) {
          reason = 'Declined; build rapport first';
        }
      }
    }
    return { utterance: u, enabled: reason === '', reason };
  });
}

// --- Identity ----------------------------------------------------------------------

const CARRIES = (items: readonly CarriedItem[], item: string): boolean => items.some((i) => i.item === item);

function claimName(c: IdentityClaim): string {
  return `${c.first} ${c.last}`;
}

function claimVars(c: IdentityClaim): Record<string, string> {
  return { first: c.first, last: c.last, dob: formatDate(c.dob) };
}

function inventDl(ctx: DialogueContext, rng: Rng): string {
  let dl = '';
  for (let i = 0; i < 6; i++) {
    let digits = '';
    for (let k = 0; k < 7; k++) digits += String(rng.nextInt(0, 9));
    dl = `D${digits}`;
    if (!ctx.directory?.dlOnFile(dl)) break;
  }
  return dl;
}

function inventAddress(rng: Rng): string {
  const streets = RESPONSES.values.get('streets') ?? [];
  return `${rng.nextInt(100, 9899)} ${rng.pick(streets)}`;
}

/** The sibling or relative whose date of birth is nearest to the subject's, when the directory knows them. */
function nearestRelative(subject: SubjectProfile, ctx: DialogueContext): { id: number; dob: number } | null {
  const dir = ctx.directory;
  if (!dir) return null;
  let best: { id: number; dob: number } | null = null;
  let bestGap = Infinity;
  for (const link of subject.identity.family) {
    if (link.relation !== 'sibling' && link.relation !== 'relative') continue;
    const p = dir.person(link.personId);
    if (!p) continue;
    const gap = Math.abs(p.dob - subject.identity.record.dob);
    if (gap < bestGap || (gap === bestGap && best !== null && link.personId < best.id)) {
      best = { id: link.personId, dob: p.dob };
      bestGap = gap;
    }
  }
  return best;
}

function relativeClaim(subject: SubjectProfile, ctx: DialogueContext, document: IdentityClaim['document'], rng: Rng): IdentityClaim | null {
  const rel = nearestRelative(subject, ctx);
  const p = rel && ctx.directory ? ctx.directory.person(rel.id) : null;
  if (!rel || !p) return null;
  const dl = document === 'fakeId' ? p.dlNumber || inventDl(ctx, rng) : '';
  return { kind: 'relative', personId: rel.id, first: p.first, middle: p.middle, last: p.last, dob: p.dob, address: p.address, document, dlNumber: dl };
}

function inventedClaim(subject: SubjectProfile, ctx: DialogueContext, document: IdentityClaim['document'], rng: Rng): IdentityClaim {
  const rec = subject.identity.record;
  const first = rng.pick(rec.sex === 'F' ? NAMES.female : NAMES.male);
  const last = rng.pick(NAMES.last);
  const mi = NAMES.middleInitials;
  const middle = mi.length > 0 ? mi.charAt(rng.nextInt(0, mi.length - 1)) : '';
  const years = rng.nextInt(1, 4);
  const sign = rng.chance(0.5) ? 1 : -1;
  const dob = rec.dob + sign * (years * 365 + rng.nextInt(-30, 30));
  const address = inventAddress(rng);
  const dl = document === 'fakeId' ? inventDl(ctx, rng) : '';
  return { kind: 'invented', personId: -1, first, middle, last, dob, address, document, dlNumber: dl };
}

function alteredDobClaim(subject: SubjectProfile, document: IdentityClaim['document'], rng: Rng, ctx: DialogueContext): IdentityClaim {
  const rec = subject.identity.record;
  const years = rng.nextInt(1, 5);
  const sign = rng.chance(0.5) ? 1 : -1;
  const dob = rec.dob + sign * (years * 365 + rng.nextInt(-30, 30));
  const dl = document === 'fakeId' ? rec.license.number || inventDl(ctx, rng) : '';
  return { kind: 'alteredDob', personId: subject.personId, first: rec.first, middle: rec.middle, last: rec.last, dob, address: rec.address, document, dlNumber: dl };
}

function trueClaim(subject: SubjectProfile, ctx: DialogueContext, document: IdentityClaim['document']): IdentityClaim {
  const rec = subject.identity.record;
  const dl = document === 'dl' ? rec.license.number || ctx.directory?.person(subject.personId)?.dlNumber || '' : '';
  return { kind: 'true', personId: subject.personId, first: rec.first, middle: rec.middle, last: rec.last, dob: rec.dob, address: rec.address, document, dlNumber: dl };
}

/** A lie about who they are: a carried fake ID (relative or invented), else 50% relative, 30% invented, 20% altered DOB. */
function falseClaim(subject: SubjectProfile, ctx: DialogueContext, rng: Rng, useFake: boolean): IdentityClaim {
  if (useFake && CARRIES(subject.items, 'fakeId')) {
    return relativeClaim(subject, ctx, 'fakeId', rng) ?? inventedClaim(subject, ctx, 'fakeId', rng);
  }
  const u = rng.next();
  if (u < 0.5) return relativeClaim(subject, ctx, 'none', rng) ?? inventedClaim(subject, ctx, 'none', rng);
  if (u < 0.8) return inventedClaim(subject, ctx, 'none', rng);
  return alteredDobClaim(subject, 'none', rng, ctx);
}

/** The claim a subject who gave a verbal identity hands over as a document when pressed, or null. */
function upgradedClaim(subject: SubjectProfile, ctx: DialogueContext, claim: IdentityClaim, rng: Rng): IdentityClaim | null {
  if (claim.document !== 'none') return null;
  if (claim.kind === 'true') {
    return CARRIES(subject.items, 'driversLicense') ? trueClaim(subject, ctx, 'dl') : null;
  }
  if (!CARRIES(subject.items, 'fakeId')) return null;
  let dl = '';
  if (claim.kind === 'relative') dl = ctx.directory?.person(claim.personId)?.dlNumber ?? '';
  else if (claim.kind === 'alteredDob') dl = subject.identity.record.license.number;
  if (dl === '') dl = inventDl(ctx, rng);
  return { ...claim, document: 'fakeId', dlNumber: dl };
}

function identityStatement(fact: FactTopic, claim: IdentityClaim, subject: SubjectProfile): DialogueStatement {
  const rec = subject.identity.record;
  switch (fact) {
    case 'name':
      return {
        fact,
        value: claimName(claim).toUpperCase(),
        display: claimName(claim),
        truthful: claim.personId === subject.personId,
        confused: false,
      };
    case 'dob':
      return { fact, value: String(claim.dob), display: formatDate(claim.dob), truthful: claim.dob === rec.dob, confused: false };
    default:
      return {
        fact: 'identity',
        value: String(claim.personId),
        display: `${claimName(claim)}, ${formatDate(claim.dob)}`,
        truthful: claim.kind === 'true',
        confused: false,
      };
  }
}

// --- Intent handling ---------------------------------------------------------------

interface Outcome {
  key: string;
  vars: Record<string, string>;
  statement: DialogueStatement | null;
  identity: IdentityClaim | null;
  consent: DialogueResult['consent'];
}

function plain(key: string, vars: Record<string, string> = {}): Outcome {
  return { key, vars, statement: null, identity: null, consent: null };
}

function identityOutcome(topic: 'identity' | 'name' | 'dob', subject: SubjectProfile, ctx: DialogueContext, mem: SubjectMemory, rng: Rng): Outcome {
  const speakKey = topic === 'identity' ? 'identity.repeat' : topic === 'name' ? 'askName.say' : 'askDob.say';
  const existing = mem.identity;
  if (existing) {
    if (topic === 'identity') {
      const up = upgradedClaim(subject, ctx, existing, rng);
      if (up) {
        mem.identity = up;
        return {
          key: up.document === 'dl' ? 'requestId.handDl' : 'requestId.handFake',
          vars: claimVars(up),
          statement: identityStatement('identity', up, subject),
          identity: up,
          consent: null,
        };
      }
    }
    return { key: speakKey, vars: claimVars(existing), statement: identityStatement(topic, existing, subject), identity: null, consent: null };
  }
  const hostile = subject.demeanor === 'hostile';
  const refuseP = clamp((hostile ? 0.5 : 0.1) - mem.rapport * 0.3, 0, 0.95);
  const stays = mem.identityRefusals >= 2 && mem.rapport < 0;
  if (stays || rng.chance(refuseP)) {
    mem.identityRefusals += 1;
    return plain(topic === 'identity' ? 'requestId.refuse' : 'ask.refuse');
  }
  const lies = rng.chance(lieChance(subject, mem));
  let claim: IdentityClaim;
  let key: string;
  if (lies) {
    claim = falseClaim(subject, ctx, rng, topic === 'identity');
    key = topic !== 'identity' ? speakKey : claim.document === 'fakeId' ? 'requestId.handFake' : 'requestId.lieVerbal';
  } else if (topic === 'identity') {
    const hasDl = CARRIES(subject.items, 'driversLicense');
    claim = trueClaim(subject, ctx, hasDl ? 'dl' : 'none');
    key = hasDl ? 'requestId.handDl' : subject.identity.juvenile ? 'requestId.juvenile' : 'requestId.noDlTrue';
  } else {
    claim = trueClaim(subject, ctx, 'none');
    key = speakKey;
  }
  mem.identity = claim;
  return { key, vars: claimVars(claim), statement: identityStatement(topic, claim, subject), identity: claim, consent: null };
}

// --- Facts -------------------------------------------------------------------------

function listValues(name: string): readonly string[] {
  return RESPONSES.values.get(name) ?? [];
}

function firstContrabandVehicleItem(subject: SubjectProfile): CarriedItem | null {
  for (const it of subject.vehicleItems) {
    const d = itemDef(it.item);
    if (d.contraband || d.weapon || d.category === 'alcohol') return it;
  }
  return null;
}

/** The true answer for `fact` (what an honest subject would say). */
export function truthFor(fact: FactTopic, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory): string {
  const id = subject.identity;
  switch (fact) {
    case 'destination':
    case 'origin':
    case 'account':
    case 'suspectWhereabouts':
      return ctx.truth[fact];
    case 'drinking': {
      const bac = subject.intoxication.bac;
      return bac >= 0.05 ? 'yes' : bac >= 0.02 ? 'some' : 'no';
    }
    case 'drugs':
      return subject.intoxication.drug !== 'none' || subject.items.some((i) => itemDef(i.item).category === 'drugs') ? 'yes' : 'no';
    case 'weapons':
      return subject.items.some((i) => itemDef(i.item).weapon) ? 'yes' : 'no';
    case 'vehicleContents': {
      const it = firstContrabandVehicleItem(subject);
      return it === null ? 'nothing' : `item:${it.item}`;
    }
    case 'vehicleOwner':
      if (subject.vehicleOwnerId === subject.personId) return 'self';
      return subject.vehicleOwnerId >= 0 && id.family.some((l) => l.personId === subject.vehicleOwnerId) ? 'relative' : 'friend';
    case 'address':
      return memory.identity ? memory.identity.address : id.record.address;
    case 'injured':
      return subject.injured ? 'yes' : 'no';
    default:
      return '';
  }
}

function displayOf(fact: FactTopic, value: string): string {
  const table = RESPONSES.answers.get(fact);
  if (!table) return value;
  if (fact === 'vehicleContents') {
    if (value === 'nothing') return table.get('nothing') ?? value;
    const id = value.startsWith('item:') ? value.slice(5) : value;
    let label = id;
    try {
      label = itemDef(id).label.toLowerCase();
    } catch {
      /* unknown item id: show it raw */
    }
    return (table.get('item') ?? '{item}').replace('{item}', label);
  }
  return table.get(value) ?? value;
}

function isIncriminatingFact(fact: FactTopic, truth: string): boolean {
  switch (fact) {
    case 'drinking':
      return truth !== 'no';
    case 'drugs':
    case 'weapons':
      return truth === 'yes';
    case 'vehicleContents':
      return truth !== 'nothing';
    case 'vehicleOwner':
      return truth !== 'self';
    case 'destination':
    case 'origin':
    case 'account':
      return true;
    default:
      return false;
  }
}

/** A lie about `fact` that differs from the truth and from every value in `exclude`; null when none exists. */
function pickLie(fact: FactTopic, truth: string, exclude: readonly string[], rng: Rng, first: boolean): string | null {
  let options: readonly string[];
  switch (fact) {
    case 'drinking':
      options = ['no', 'some'];
      break;
    case 'drugs':
    case 'weapons':
      options = ['no'];
      break;
    case 'vehicleContents':
      options = ['nothing'];
      break;
    case 'vehicleOwner':
      options = first ? ['self'] : ['self', 'relative', 'friend'];
      break;
    default:
      options = listValues(fact);
  }
  const left = options.filter((o) => o !== truth && !exclude.includes(o));
  if (left.length === 0) return null;
  if (fact === 'drinking' && left.length === 2) return rng.chance(0.7) ? 'no' : 'some';
  return rng.pick(left);
}

function confusedValue(fact: FactTopic, rng: Rng): string {
  switch (fact) {
    case 'drinking':
      return rng.pick(['no', 'some', 'yes']);
    case 'drugs':
    case 'weapons':
    case 'injured':
      return rng.pick(['no', 'yes']);
    case 'vehicleContents':
      return 'nothing';
    case 'vehicleOwner':
      return rng.pick(['self', 'relative', 'friend']);
    case 'address':
      return inventAddress(rng);
    default:
      return rng.pick(listValues(fact));
  }
}

function askOutcome(fact: FactTopic, subject: SubjectProfile, ctx: DialogueContext, mem: SubjectMemory, rng: Rng): Outcome {
  const truth = truthFor(fact, subject, ctx, mem);
  const hostile = subject.demeanor === 'hostile';
  const refuseP = clamp(0.15 + (hostile ? 0.3 : 0) - mem.rapport * 0.2, 0, 0.9);
  if (rng.chance(refuseP)) return plain('ask.refuse');
  const answered = mem.asked[fact] ?? 0;
  mem.asked[fact] = answered + 1;
  const lineFor = (value: string, kind: 'truth' | 'lie'): string => (fact === 'drinking' ? `drinking.${value}` : `ask.${kind}`);
  const state = (value: string, confused: boolean): Outcome => {
    const display = displayOf(fact, value);
    const truthful = value === truth;
    return {
      key: confused ? 'ask.confused' : lineFor(value, truthful ? 'truth' : 'lie'),
      vars: { value: display },
      statement: { fact, value, display, truthful, confused },
      identity: null,
      consent: null,
    };
  };
  if (subject.identity.dementia && rng.chance(0.5)) return state(confusedValue(fact, rng), true);
  let value = truth;
  const motive = subject.guilty || subject.identity.wanted;
  if (motive && isIncriminatingFact(fact, truth)) {
    const prior = mem.lies[fact];
    if (prior !== undefined) {
      value = prior;
      if (rng.chance(0.3 + 0.3 * mem.stress)) {
        const alt = pickLie(fact, truth, [prior], rng, false);
        if (alt !== null) value = alt;
      }
    } else if (answered === 0 && rng.chance(lieChance(subject, mem))) {
      value = pickLie(fact, truth, [], rng, true) ?? truth;
    }
    if (value !== truth) mem.lies[fact] = value;
  }
  return state(value, false);
}

// --- Consent -----------------------------------------------------------------------

function consentOutcome(kind: ConsentKind, subject: SubjectProfile, ctx: DialogueContext, mem: SubjectMemory, rng: Rng): Outcome {
  if (subject.identity.dementia) return { ...plain('consent.confused'), consent: { kind, granted: false, valid: false } };
  if (subject.identity.juvenile && !ctx.guardianPresent) return { ...plain('consent.needGuardian'), consent: { kind, granted: false, valid: false } };
  const prev = mem.consent[kind];
  if (prev === 'granted') return { ...plain('consent.grant'), consent: { kind, granted: true, valid: true } };
  if (prev === 'denied' && mem.rapport < (mem.consentAskedAt[kind] ?? 0) + CONSENT_RETRY_RAPPORT) {
    return { ...plain('consent.deny'), consent: { kind, granted: false, valid: true } };
  }
  const granted = rng.chance(consentChance(kind, subject, ctx, mem));
  mem.consent[kind] = granted ? 'granted' : 'denied';
  mem.consentAskedAt[kind] = mem.rapport;
  return { ...plain(granted ? 'consent.grant' : 'consent.deny'), consent: { kind, granted, valid: true } };
}

// --- respond -----------------------------------------------------------------------

function finish(
  key: string,
  text: string,
  delayS: number,
  understood: boolean,
  mem: SubjectMemory,
  extra: Partial<Pick<DialogueResult, 'statement' | 'identity' | 'consent' | 'escalate' | 'calmed'>> = {},
): DialogueResult {
  return {
    lineKey: key,
    text,
    delayS,
    understood,
    statement: extra.statement ?? null,
    identity: extra.identity ?? null,
    consent: extra.consent ?? null,
    escalate: extra.escalate ?? null,
    calmed: extra.calmed ?? false,
    memory: mem,
  };
}

/**
 * Answers one officer utterance (§9.3): tone effect, understanding gate and delay, escalation, then the
 * intent. The memory is copied; the updated copy is `result.memory`. `command` utterances are not handled
 * here (use `commandLine`): they return an empty result with the tone effect applied.
 */
export function respond(u: Utterance, subject: SubjectProfile, ctx: DialogueContext, memory: SubjectMemory, rng: Rng): DialogueResult {
  const mem = cloneMemory(memory);
  const demeanor = subject.demeanor;
  const level = subject.intoxication.level;
  const language = subject.identity.language.label;
  const baseVars = { language, officer: ctx.officerName };
  const delayS = MODE_DELAY_S[ctx.commMode];
  if (u.intent === 'command') {
    toneEffect(mem, ctx.tone, demeanor, ctx.hour, u.intent);
    return finish('', '', 0, true, mem);
  }
  if (SILENT_DEMEANORS.includes(demeanor)) {
    return finish('silent.none', render('silent.none', baseVars, 0, rng), 0, false, mem);
  }

  // 1. Tone.
  toneEffect(mem, ctx.tone, demeanor, ctx.hour, u.intent);

  // 2. Understanding gate and delay.
  const g = understanding(subject, ctx.commMode, u.intent);
  if (g.p < 1 && !rng.chance(g.p)) {
    const key = unheardKey(g.cause);
    return finish(key, render(key, baseVars, level, rng), delayS, false, mem);
  }
  if (ctx.commMode === 'translationApp' && rng.chance(APP_MISUNDERSTAND)) {
    return finish('foreign.misunderstood', render('foreign.misunderstood', baseVars, level, rng), delayS, false, mem);
  }

  // 4 (evaluated before the intent: it depends only on the tone-adjusted memory). Escalation.
  if (mem.stress > ESCALATION_STRESS && (demeanor === 'hostile' || demeanor === 'evasive')) {
    const escalate = demeanor === 'hostile' && !rng.chance(0.5) ? 'fight' : 'flee';
    const key = `escalate.${escalate}`;
    return finish(key, render(key, baseVars, level, rng), delayS, true, mem, { escalate });
  }
  const calmed = demeanor === 'crisis' && mem.stress < 0.25 && mem.rapport > 0.3;

  // 3. Intent.
  let out: Outcome;
  switch (u.intent) {
    case 'greet':
      mem.greeted = true;
      out = plain(`greet.${(GREET_DEMEANORS as readonly string[]).includes(demeanor) ? demeanor : 'cooperative'}`);
      break;
    case 'explainReason':
      mem.reasonGiven = true;
      out = plain(subject.identity.attitude < -0.3 || mem.stress > 0.6 ? 'reason.argue' : 'reason.accept');
      break;
    case 'requestId':
      out = identityOutcome('identity', subject, ctx, mem, rng);
      break;
    case 'askName':
      out = identityOutcome('name', subject, ctx, mem, rng);
      break;
    case 'askDob':
      out = identityOutcome('dob', subject, ctx, mem, rng);
      break;
    case 'ask': {
      const fact = u.fact;
      if (fact === 'name') out = identityOutcome('name', subject, ctx, mem, rng);
      else if (fact === 'dob') out = identityOutcome('dob', subject, ctx, mem, rng);
      else if (fact === 'identity') out = identityOutcome('identity', subject, ctx, mem, rng);
      else if (fact === null || fact === 'idCard' || fact === 'appearance') out = plain('ask.refuse');
      else out = askOutcome(fact, subject, ctx, mem, rng);
      break;
    }
    case 'consent':
      out = u.consent === null ? plain('ask.refuse') : consentOutcome(u.consent, subject, ctx, mem, rng);
      break;
    case 'reassure':
      out = plain('reassure.ok');
      break;
    case 'miranda':
      mem.mirandized = true;
      out = plain('miranda.ack');
      break;
    case 'release':
      out = plain('release.ok');
      break;
    case 'warn':
      out = plain('warn.ok');
      break;
    case 'thank':
      out = plain('thank.ok');
      break;
  }

  // 5. Text.
  const text = render(out.key, { ...baseVars, ...out.vars }, level, rng);
  return finish(out.key, text, delayS, true, mem, { statement: out.statement, identity: out.identity, consent: out.consent, calmed });
}

/** Neighbourhood trust (0..1) of a district; 0.5 for an unknown one. */
export function trustOf(district: string): number {
  return TRUST.get(district) ?? 0.5;
}
