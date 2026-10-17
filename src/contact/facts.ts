import type { EvidenceCategory } from '../cad/documents';
import type { IdentityClaim } from '../dialogue';
import type { ItemCategory, PersonFact } from '../people';
import type { PersonRecord } from '../records/person';

/** Pure helpers for the canonical fact values of design §9.5 and for rebuilding a claim from stored facts. */

/** `"FIRST LAST"` upper-case, the canonical name value. */
export function nameValue(first: string, last: string): string {
  return `${first} ${last}`.trim().toUpperCase();
}

export function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** `"M|34|182|brown"` (sex | age | height cm | hair). */
export function appearanceValue(sex: string, age: number, heightCm: number, hair: string): string {
  return `${sex}|${age}|${heightCm}|${hair.toLowerCase()}`;
}

/** Human text of an appearance value. */
export function appearanceText(value: string, approximate: boolean): string {
  const [sex, age, height, hair] = value.split('|');
  const lead = approximate ? 'about ' : '';
  return `${sex === 'F' ? 'Female' : 'Male'}, ${lead}${age ?? '?'}, ${lead}${height ?? '?'} cm, ${hair ?? '?'} hair`;
}

/** The appearance value of a record on `age`. */
export function recordAppearance(rec: PersonRecord, age: number): string {
  return appearanceValue(rec.sex, age, rec.heightCm, rec.hair);
}

/** CAD evidence category of an item category. */
export function evidenceCategoryOf(category: ItemCategory): EvidenceCategory {
  switch (category) {
    case 'weapon':
      return 'weapon';
    case 'drugs':
    case 'paraphernalia':
      return 'drugs';
    case 'document':
      return 'document';
    case 'property':
    case 'tools':
      return 'property';
    default:
      return 'other';
  }
}

/**
 * The canonical `vehicleOwner` claim value: `owner:<personId>` for "it is mine" (the claimed identity when one
 * was given) and for a true "a relative's" answer, else `other` (never compared).
 */
export function ownerClaimValue(answer: string, truthful: boolean, claimedId: number, trueId: number, ownerId: number): string {
  if (answer === 'self') return `owner:${claimedId >= 0 ? claimedId : trueId}`;
  if (answer === 'relative' && truthful && ownerId >= 0) return `owner:${ownerId}`;
  return 'other';
}

/** The latest fact of `topic` from `source`, or null. */
export function latestFact(facts: readonly PersonFact[], topic: string, source: PersonFact['source']): PersonFact | null {
  for (let i = facts.length - 1; i >= 0; i--) {
    const f = facts[i];
    if (f && f.topic === topic && f.source === source) return f;
  }
  return null;
}

/**
 * Rebuilds the identity the person gave in an incident from the stored claim and document facts (a reopened
 * contact must not give a second identity). Null when no identity claim fact exists.
 */
export function claimFromFacts(facts: readonly PersonFact[], trueId: number, rec: PersonRecord): IdentityClaim | null {
  const id = latestFact(facts, 'identity', 'claim');
  if (id === null) return null;
  const personId = Number(id.value);
  if (!Number.isInteger(personId)) return null;
  const name = latestFact(facts, 'name', 'claim');
  const dob = latestFact(facts, 'dob', 'claim');
  const address = latestFact(facts, 'address', 'claim');
  const card = latestFact(facts, 'idCard', 'document');
  const parts = (name?.display ?? '').split(' ');
  const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? '');
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const dobValue = dob ? Number(dob.value) : rec.dob;
  let kind: IdentityClaim['kind'] = 'invented';
  if (personId === trueId) kind = dobValue === rec.dob ? 'true' : 'alteredDob';
  else if (personId >= 0) kind = 'relative';
  return {
    kind,
    personId,
    first: name ? first : rec.first,
    middle: '',
    last: name ? last : rec.last,
    dob: Number.isFinite(dobValue) ? dobValue : rec.dob,
    address: address?.display ?? rec.address,
    document: card ? (kind === 'true' ? 'dl' : 'fakeId') : 'none',
    dlNumber: card?.value ?? '',
  };
}
