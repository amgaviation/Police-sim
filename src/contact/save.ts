import { COMM_MODES, type DialogueResult, type IdentityClaim, type SubjectMemory } from '../dialogue';
import { isSfstSave } from '../dialogue';
import type { ContactSave, ContactSaveEntry, ContactTarget } from './types';

/** Structural validators of the contact save (design §10.2). */

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function num(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function int(x: unknown): x is number {
  return num(x) && Number.isInteger(x);
}

function str(x: unknown): x is string {
  return typeof x === 'string';
}

function strMap(x: unknown): boolean {
  return isObj(x) && Object.values(x).every(str);
}

function numMap(x: unknown): boolean {
  return isObj(x) && Object.values(x).every(num);
}

function isClaim(x: unknown): x is IdentityClaim {
  return (
    isObj(x) &&
    (x.kind === 'true' || x.kind === 'relative' || x.kind === 'invented' || x.kind === 'alteredDob') &&
    int(x.personId) &&
    str(x.first) &&
    str(x.middle) &&
    str(x.last) &&
    num(x.dob) &&
    str(x.address) &&
    (x.document === 'dl' || x.document === 'fakeId' || x.document === 'none') &&
    str(x.dlNumber)
  );
}

function isConsentMap(x: unknown): boolean {
  return isObj(x) && Object.values(x).every((v) => v === 'granted' || v === 'denied');
}

export function isMemory(x: unknown): x is SubjectMemory {
  return (
    isObj(x) &&
    num(x.rapport) &&
    num(x.stress) &&
    typeof x.greeted === 'boolean' &&
    typeof x.reasonGiven === 'boolean' &&
    typeof x.mirandized === 'boolean' &&
    (x.miranda === undefined || x.miranda === 'waived' || x.miranda === 'invoked' || x.miranda === 'misunderstood') &&
    (x.identity === null || isClaim(x.identity)) &&
    int(x.identityRefusals) &&
    strMap(x.lies) &&
    numMap(x.asked) &&
    isConsentMap(x.consent) &&
    numMap(x.consentAskedAt)
  );
}

function isResult(x: unknown): x is DialogueResult {
  if (!isObj(x)) return false;
  const st = x.statement;
  const co = x.consent;
  return (
    str(x.lineKey) &&
    str(x.text) &&
    num(x.delayS) &&
    typeof x.understood === 'boolean' &&
    (st === null ||
      (isObj(st) && str(st.fact) && str(st.value) && str(st.display) && typeof st.truthful === 'boolean' && typeof st.confused === 'boolean')) &&
    (x.identity === null || isClaim(x.identity)) &&
    (co === null || (isObj(co) && str(co.kind) && typeof co.granted === 'boolean' && typeof co.valid === 'boolean')) &&
    (x.escalate === null || x.escalate === 'flee' || x.escalate === 'fight') &&
    typeof x.calmed === 'boolean' &&
    (x.miranda === undefined || x.miranda === 'waived' || x.miranda === 'invoked' || x.miranda === 'misunderstood') &&
    isMemory(x.memory)
  );
}

function isTarget(x: unknown): x is ContactTarget {
  if (!isObj(x)) return false;
  if (x.kind === 'actor') return int(x.actorId);
  if (x.kind === 'ped') return int(x.slot);
  return x.kind === 'occupant' && int(x.vehicleId) && int(x.seat);
}

function isTruth(x: unknown): boolean {
  return isObj(x) && str(x.destination) && str(x.origin) && str(x.account) && str(x.suspectWhereabouts) && str(x.reason);
}

function isEntry(x: unknown): x is ContactSaveEntry {
  if (!isObj(x)) return false;
  return (
    int(x.id) &&
    x.id > 0 &&
    int(x.personId) &&
    x.personId >= 0 &&
    str(x.incident) &&
    int(x.callId) &&
    str(x.role) &&
    isTarget(x.target) &&
    int(x.actorId) &&
    (COMM_MODES as readonly unknown[]).includes(x.commMode) &&
    isMemory(x.memory) &&
    Array.isArray(x.transcript) &&
    x.transcript.every(
      (l) => isObj(l) && int(l.id) && (l.speaker === 'officer' || l.speaker === 'subject' || l.speaker === 'system') && str(l.text),
    ) &&
    int(x.nextLine) &&
    Array.isArray(x.pending) &&
    x.pending.every((p) => isObj(p) && num(p.dueSim) && isResult(p.result)) &&
    (x.sfst === null || isSfstSave(x.sfst)) &&
    num(x.guardianNotifiedAt) &&
    isTruth(x.truth) &&
    typeof x.guilty === 'boolean' &&
    int(x.vehicleId) &&
    typeof x.stop === 'boolean' &&
    typeof x.appTranslation === 'boolean' &&
    (x.flags === undefined || (Array.isArray(x.flags) && x.flags.every(str))) &&
    (x.found === undefined || (Array.isArray(x.found) && x.found.every(str))) &&
    (x.lastSim === undefined || num(x.lastSim))
  );
}

function isRngState(x: unknown): boolean {
  return isObj(x) && int(x.seed) && Array.isArray(x.s) && x.s.length === 4 && x.s.every((v) => int(v) && v >= 0 && v < 4294967296);
}

/** Is `x` shaped like a `ContactSave`? Entries are checked fully; the optional fields default when absent. */
export function isContactSave(x: unknown): x is ContactSave {
  if (!isObj(x) || x.version !== 1) return false;
  if (!int(x.nextId) || x.nextId < 1 || !int(x.active) || !Array.isArray(x.contacts) || !x.contacts.every(isEntry)) return false;
  const ids = new Set<number>();
  const persons = new Set<number>();
  for (const e of x.contacts) {
    if (ids.has(e.id) || persons.has(e.personId) || e.id >= x.nextId) return false;
    ids.add(e.id);
    persons.add(e.personId);
  }
  return (x.step === undefined || int(x.step)) && (x.rng === undefined || isRngState(x.rng));
}

/** A save with no conversations. */
export function emptyContactSave(): ContactSave {
  return { version: 1, nextId: 1, active: -1, contacts: [] };
}
