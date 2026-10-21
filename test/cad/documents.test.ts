import { describe, expect, it } from 'vitest';
import statutesJson from '../../src/data/cad/statutes.json';
import tenCodesJson from '../../src/data/cad/tenCodes.json';
import { codeText, plateRunNarrative, statusText } from '../../src/cad/codes';
import { STATUTES, TEN_CODES, findStatute, statute } from '../../src/cad/data';
import {
  CUSTODY_ACTIONS,
  DOC_ID_FORMAT,
  DOC_KINDS,
  DocumentStore,
  DocumentValidationError,
  EVIDENCE_CATEGORIES,
  PERSON_ROLES,
  citationTotal,
  docIdNumber,
  emptyCounters,
  formatDocId,
  isCadDocument,
  isDocumentsSave,
  knownPerson,
  validateDocument,
  type CadDocument,
  type DocKind,
  type PersonRole,
} from '../../src/cad/documents';
import { UNIT_STATUSES, type PlateReadback, type RadioMode, type ReadbackSeverity } from '../../src/cad/types';
import { PERSON_POPULATION } from '../../src/records/ids';
import { at, recordingCad } from './helpers';

const AUTHOR = 'Officer Doe #4071';

function finalizeError(store: DocumentStore, id: string): string[] {
  try {
    store.finalize(id, at(99));
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentValidationError);
    expect(error).toBeInstanceOf(Error);
    return (error as DocumentValidationError).messages;
  }
  throw new Error('finalize did not throw');
}

describe('DocumentStore', () => {
  it('numbers documents per kind', () => {
    const store = new DocumentStore();
    expect(store.create('report', {}, at(1), AUTHOR).id).toBe('R-0001');
    expect(store.create('report', {}, at(1), AUTHOR).id).toBe('R-0002');
    expect(store.create('citation', {}, at(1), AUTHOR).id).toBe('CT-000001');
    expect(store.create('booking', {}, at(1), AUTHOR).id).toBe('B-0001');
    expect(store.create('evidence', {}, at(1), AUTHOR).id).toBe('E-0001');
    expect(store.create('supplement', {}, at(1), AUTHOR).id).toBe('S-0001');
    expect(store.list().map((d) => d.id)).toEqual(['R-0001', 'R-0002', 'CT-000001', 'B-0001', 'E-0001', 'S-0001']);
    expect(store.list('report').map((d) => d.id)).toEqual(['R-0001', 'R-0002']);
    expect(formatDocId('citation', 1234567)).toBe('CT-1234567');
    expect(docIdNumber('report', 'R-0042')).toBe(42);
    expect(docIdNumber('report', 'CT-0042')).toBe(-1);
  });

  it('creates drafts with defaults and copies of the given fields', () => {
    const store = new DocumentStore();
    const persons: { personId: number; role: PersonRole }[] = [{ personId: 5, role: 'victim' }];
    const r = store.create('report', { title: 'Theft', persons, callId: 3 }, at(2), AUTHOR);
    persons.push({ personId: 6, role: 'suspect' });
    expect(r).toMatchObject({
      kind: 'report', status: 'draft', author: AUTHOR, callId: 3, title: 'Theft', location: '', narrative: '',
      offenseIds: [], vehicles: [], evidenceIds: [], occurredGame: at(2).game, created: at(2), updated: at(2),
    });
    expect(r.persons).toEqual([{ personId: 5, role: 'victim' }]);
    const c = store.create('citation', {}, at(2), AUTHOR);
    expect(c).toMatchObject({ personId: -1, vehicleId: -1, plate: '', violations: [], totalFine: 0, recordedSpeedMph: null, callId: null });
  });

  it('keeps citation totals in step with the violations', () => {
    const store = new DocumentStore();
    const c = store.create('citation', { violations: [{ statuteId: 'TR-301', fine: 150, detail: '52 in a 35' }, { statuteId: 'TR-320', fine: 120, detail: '' }] }, at(1), AUTHOR);
    expect(c.totalFine).toBe(270);
    store.update(c.id, { violations: [{ statuteId: 'TR-302', fine: 238, detail: '' }] }, at(2));
    expect(c.totalFine).toBe(238);
    expect(citationTotal([])).toBe(0);
    expect(citationTotal([{ fine: 0.1 }, { fine: 0.2 }])).toBe(0.3);
    expect(citationTotal([{ fine: 10 }, { fine: Number.NaN }])).toBe(10);
  });

  it('edits drafts only and finalizes valid documents', () => {
    const store = new DocumentStore();
    const r = store.create('report', { title: 'Collision' }, at(1), AUTHOR);
    const edited = store.update(r.id, { location: '248 N Oak Street', narrative: 'Two vehicles collided at the junction.' }, at(5));
    expect(edited).toBe(r);
    expect(r.updated).toEqual(at(5));
    store.update(r.id, { status: 'final', id: 'X', kind: 'citation', author: 'Mallory' } as never, at(6));
    expect(r).toMatchObject({ id: 'R-0001', kind: 'report', status: 'draft', author: AUTHOR });
    const fin = store.finalize(r.id, at(7));
    expect(fin.status).toBe('final');
    expect(fin.updated).toEqual(at(7));
    expect(() => store.update(r.id, { title: 'Changed' }, at(8))).toThrow(/final/);
    expect(r.title).toBe('Collision');
    expect(store.finalize(r.id, at(9)).updated).toEqual(at(7));
    expect(() => store.update('R-9999', { title: 'x' }, at(8))).toThrow(/Unknown document/);
    expect(() => store.finalize('nope', at(8))).toThrow(/Unknown document/);
  });

  it('reports every validation problem', () => {
    const store = new DocumentStore();
    const r = store.create('report', { narrative: 'too short' }, at(1), AUTHOR);
    expect(finalizeError(store, r.id)).toEqual([
      'Report needs a title', 'Report needs a location', 'Report narrative must be at least 20 characters',
    ]);
    expect(r.status).toBe('draft');

    const c = store.create('citation', { violations: [{ statuteId: 'PC-220', fine: 0, detail: '' }, { statuteId: 'ZZ-000', fine: 1, detail: '' }] }, at(1), AUTHOR);
    expect(finalizeError(store, c.id)).toEqual([
      'Citation needs a person', 'Citation needs a plate or vehicle', 'Citation violation 1: PC-220 is not citeable',
      'Citation violation 2 has unknown statute ZZ-000', 'Citation needs a location',
    ]);
    store.update(c.id, { violations: [] }, at(2));
    expect(finalizeError(store, c.id)).toContain('Citation needs at least one violation');
    store.update(c.id, { personId: 12, plate: 'ABC 1234', location: 'Oak Street at 2nd Street', violations: [{ statuteId: 'TR-301', fine: 150, detail: '' }] }, at(3));
    expect(store.finalize(c.id, at(4)).status).toBe('final');
    const byVehicle = store.create('citation', { personId: 0, vehicleId: 0, location: 'x', violations: [{ statuteId: 'TR-325', fine: 25, detail: '' }] }, at(1), AUTHOR);
    expect(validateDocument(byVehicle)).toEqual([]);
    expect(validateDocument({ ...byVehicle, personId: 99_999_999 })).toEqual(['Unknown person #99999999']);
    const rep = store.create('report', { title: 't', location: 'x', narrative: 'x'.repeat(30), persons: [{ personId: 99_999_999, role: 'witness' }] }, at(1), AUTHOR);
    expect(validateDocument(rep)).toEqual(['Unknown person #99999999']);

    const b = store.create('booking', { charges: ['TR-301'] }, at(1), AUTHOR);
    expect(finalizeError(store, b.id)).toEqual([
      'Booking needs a person', 'Booking charge TR-301 is not bookable', 'Booking needs at least one bookable charge',
    ]);
    store.update(b.id, { personId: 3, charges: ['PC-220'] }, at(2));
    expect(store.finalize(b.id, at(3)).status).toBe('final');

    const e = store.create('evidence', { category: 'jewel' as never }, at(1), AUTHOR);
    expect(finalizeError(store, e.id)).toEqual([
      'Evidence needs a description', 'Evidence needs a category', "Evidence needs a 'collected' custody entry",
    ]);

    const s = store.create('supplement', { parentId: c.id, narrative: 'short' }, at(1), AUTHOR);
    expect(finalizeError(store, s.id)).toEqual([
      'Supplement needs an existing report', 'Supplement narrative must be at least 10 characters',
    ]);
    store.update(s.id, { parentId: 'R-0001', narrative: 'Follow-up interview with the witness.' }, at(2));
    expect(store.finalize(s.id, at(3)).status).toBe('final');
    expect(validateDocument({ ...s, parentId: 'R-0420' })).toEqual([]);
    expect(validateDocument({ ...s, parentId: 'R-0420' }, () => null)).toEqual(['Supplement needs an existing report']);
  });

  it('appends evidence custody, also after the item is final', () => {
    const store = new DocumentStore();
    const e = store.create('evidence', {
      description: 'Folding knife', category: 'weapon', foundAt: 'Driver door pocket',
      custody: [{ game: 100, action: 'collected', by: AUTHOR, note: '' }],
    }, at(1), AUTHOR);
    store.update(e.id, { custody: [] }, at(2));
    expect(e.custody).toHaveLength(1);
    store.finalize(e.id, at(3));
    store.addCustody(e.id, { game: 200, action: 'booked', by: AUTHOR, note: 'Locker 4' }, at(4));
    expect(e.custody.map((c) => c.action)).toEqual(['collected', 'booked']);
    expect(e.updated).toEqual(at(4));
    expect(() => store.addCustody(e.id, { game: 1, action: 'lost' as never, by: '', note: '' }, at(5))).toThrow(/custody action/);
    const r = store.create('report', {}, at(1), AUTHOR);
    expect(() => store.addCustody(r.id, { game: 1, action: 'collected', by: '', note: '' }, at(5))).toThrow(/not an evidence/);
  });

  it('finds documents by call and emits cad:documentSaved on every change', () => {
    const { cad, events } = recordingCad();
    const call = cad.createCall({
      typeId: 'trafficStop', priority: 4, narrative: 'Stop',
      location: { x: 0, z: 0, edge: 0, text: '', street: '', cross: '', near: '', district: '' },
      caller: { kind: 'officer', name: '12', phone: '', personId: -1 },
    }, at(1));
    events.length = 0;
    const store = cad.docs;
    const c = store.create('citation', { callId: call.id, personId: 1, plate: 'ABC 1234', location: 'x', violations: [{ statuteId: 'TR-301', fine: 150, detail: '' }] }, at(2), AUTHOR);
    const e = store.create('evidence', { callId: call.id, description: 'Bag', category: 'drugs', custody: [{ game: 1, action: 'collected', by: AUTHOR, note: '' }] }, at(2), AUTHOR);
    store.create('report', { callId: 77 }, at(2), AUTHOR);
    store.update(c.id, { notes: 'Signed' }, at(3));
    store.finalize(c.id, at(4));
    store.finalize(e.id, at(4));
    store.addCustody(e.id, { game: 2, action: 'transferred', by: AUTHOR, note: '' }, at(5));
    expect(store.byCall(call.id).map((d) => d.id)).toEqual([c.id, e.id]);
    expect(store.byCall(99)).toEqual([]);
    expect(call.documents).toEqual([c.id, e.id]);
    expect(events.map((x) => x.payload)).toEqual([
      { id: c.id, kind: 'citation', final: false },
      { id: e.id, kind: 'evidence', final: false },
      { id: 'R-0001', kind: 'report', final: false },
      { id: c.id, kind: 'citation', final: false },
      { id: c.id, kind: 'citation', final: true },
      { id: e.id, kind: 'evidence', final: true },
      { id: e.id, kind: 'evidence', final: true },
    ]);
    expect(store.get(c.id)).toBe(c);
    expect(store.get('nope')).toBeNull();
  });
});

// --- Phase 9 audit additions ---------------------------------------------------------------------------------------

describe('document ids (DOC_KINDS, DOC_ID_FORMAT)', () => {
  it('has a format for exactly the kinds, with distinct prefixes', () => {
    expect([...DOC_KINDS]).toEqual(['report', 'citation', 'booking', 'evidence', 'supplement']);
    expect(Object.keys(DOC_ID_FORMAT).sort()).toEqual([...DOC_KINDS].sort());
    const prefixes = DOC_KINDS.map((k) => DOC_ID_FORMAT[k].prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const k of DOC_KINDS) {
      expect(DOC_ID_FORMAT[k].prefix).toMatch(/^[A-Z]{1,2}$/);
      expect(DOC_ID_FORMAT[k].digits).toBeGreaterThanOrEqual(4);
    }
  });

  it.each(DOC_KINDS.map((k) => [k] as const))('numbers %s documents by their format', (kind: DocKind) => {
    const { prefix, digits } = DOC_ID_FORMAT[kind];
    const store = new DocumentStore();
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) ids.push(store.create(kind, {}, at(n), AUTHOR).id);
    ids.forEach((id, i) => {
      expect(id).toBe(`${prefix}-${String(i + 1).padStart(digits, '0')}`);
      expect(id).toMatch(new RegExp(`^${prefix}-\\d{${digits}}$`));
      expect(formatDocId(kind, i + 1)).toBe(id);
      expect(docIdNumber(kind, id)).toBe(i + 1);
    });
    expect(store.list(kind).map((d) => d.id)).toEqual(ids);
    expect(store.list().every((d) => d.kind === kind)).toBe(true);
  });

  it.each(DOC_KINDS.map((k) => [k] as const))('keeps the %s counter apart from the others and grows past its digits', (kind: DocKind) => {
    const { digits } = DOC_ID_FORMAT[kind];
    expect(formatDocId(kind, 10 ** digits)).toBe(`${DOC_ID_FORMAT[kind].prefix}-${10 ** digits}`);
    expect(docIdNumber(kind, formatDocId(kind, 10 ** digits))).toBe(10 ** digits);
    for (const other of DOC_KINDS) {
      if (other !== kind) expect(docIdNumber(kind, formatDocId(other, 1))).toBe(-1);
    }
    expect(docIdNumber(kind, '')).toBe(-1);
    expect(docIdNumber(kind, `${DOC_ID_FORMAT[kind].prefix}-`)).toBe(-1);
    expect(docIdNumber(kind, `${DOC_ID_FORMAT[kind].prefix}-12x`)).toBe(-1);
    expect(docIdNumber(kind, `${DOC_ID_FORMAT[kind].prefix}-0007`)).toBe(7);
  });

  it('starts every counter at zero, with a fresh object per call', () => {
    const a = emptyCounters();
    expect(a).toEqual({ report: 0, citation: 0, booking: 0, evidence: 0, supplement: 0 });
    a.report = 5;
    expect(emptyCounters().report).toBe(0);
    expect(Object.keys(a).sort()).toEqual([...DOC_KINDS].sort());
  });

  it('never lets a restored counter fall below the highest id in use', () => {
    const store = new DocumentStore();
    for (const k of DOC_KINDS) store.create(k, {}, at(1), AUTHOR);
    const save = store.serialize();
    expect(save.counters).toEqual({ report: 1, citation: 1, booking: 1, evidence: 1, supplement: 1 });
    const stale = { counters: emptyCounters(), items: save.items };
    const restored = new DocumentStore();
    restored.restore(stale);
    expect(restored.create('citation', {}, at(2), AUTHOR).id).toBe('CT-000002');
    expect(restored.create('report', {}, at(2), AUTHOR).id).toBe('R-0002');
  });
});

describe('vocabularies of documents', () => {
  it('lists the person roles, evidence categories and custody actions', () => {
    expect([...PERSON_ROLES]).toEqual(['victim', 'suspect', 'witness', 'reportingParty', 'involved']);
    expect([...EVIDENCE_CATEGORIES]).toEqual(['property', 'drugs', 'weapon', 'document', 'digital', 'other']);
    expect([...CUSTODY_ACTIONS]).toEqual(['collected', 'transferred', 'booked', 'released']);
  });

  it('accepts every person role on a report and every category and custody action on evidence', () => {
    for (const role of PERSON_ROLES) {
      const doc = { ...validDocs().report, persons: [{ personId: 3, role }] };
      expect(isCadDocument(doc), role).toBe(true);
    }
    for (const category of EVIDENCE_CATEGORIES) expect(isCadDocument({ ...validDocs().evidence, category }), category).toBe(true);
    for (const action of CUSTODY_ACTIONS) {
      expect(isCadDocument({ ...validDocs().evidence, custody: [{ game: 1, action, by: AUTHOR, note: '' }] }), action).toBe(true);
    }
  });

  it('refuses a person role, category or custody action that is not listed', () => {
    expect(isCadDocument({ ...validDocs().report, persons: [{ personId: 3, role: 'bystander' }] })).toBe(false);
    expect(isCadDocument({ ...validDocs().evidence, category: 'food' })).toBe(false);
    expect(isCadDocument({ ...validDocs().evidence, custody: [{ game: 1, action: 'lost', by: AUTHOR, note: '' }] })).toBe(false);
  });

  it('validates evidence categories and the collected entry', () => {
    const store = new DocumentStore();
    const e = store.create('evidence', { description: 'Knife', category: 'weapon' }, at(1), AUTHOR);
    expect(validateDocument(e)).toEqual(["Evidence needs a 'collected' custody entry"]);
    store.addCustody(e.id, { game: 5, action: 'collected', by: AUTHOR, note: '' }, at(2));
    expect(validateDocument(e)).toEqual([]);
    for (const action of CUSTODY_ACTIONS) store.addCustody(e.id, { game: 6, action, by: AUTHOR, note: '' }, at(3));
    expect(e.custody.map((c) => c.action)).toEqual(['collected', ...CUSTODY_ACTIONS]);
    expect(() => store.addCustody(e.id, { game: 6, action: 'lost' as 'booked', by: AUTHOR, note: '' }, at(3))).toThrow(/Unknown custody action/);
    expect(validateDocument({ ...e, category: 'food' as 'drugs' })).toContain('Evidence needs a category');
  });

  it('knows the people of the records population', () => {
    expect(knownPerson(0)).toBe(true);
    expect(knownPerson(PERSON_POPULATION - 1)).toBe(true);
    expect(knownPerson(PERSON_POPULATION)).toBe(false);
    expect(knownPerson(-1)).toBe(false);
    expect(knownPerson(1.5)).toBe(false);
    expect(knownPerson(Number.NaN)).toBe(false);
    expect(knownPerson(Infinity)).toBe(false);
  });
});

/** A valid document of every kind, as plain JSON (what a save holds). */
function validDocs(): Record<DocKind, Record<string, unknown>> {
  const store = new DocumentStore();
  const report = store.create(
    'report',
    {
      title: 'Theft from vehicle', offenseIds: ['PC-250'], location: '248 N Oak Street', occurredGame: 51000,
      persons: [{ personId: 3, role: 'victim' }, { personId: 4, role: 'suspect' }], vehicles: [{ vehicleId: 9, plate: 'ABC 123', role: 'suspect' }],
      narrative: 'Arrived and found the window broken.', evidenceIds: ['E-0001'], callId: 5,
    },
    at(1), AUTHOR,
  );
  const citation = store.create(
    'citation',
    { personId: 3, vehicleId: 9, plate: 'ABC 123', location: '248 N Oak Street', violations: [{ statuteId: 'TR-301', fine: 150, detail: '52 in a 35' }], recordedSpeedMph: 52, limitMph: 35, notes: 'n', callId: 5 },
    at(2), AUTHOR,
  );
  const booking = store.create('booking', { personId: 4, charges: ['PC-260'], arrestedGame: 51100, arrestLocation: 'Main Street', property: 'Wallet', notes: 'n', callId: 5 }, at(3), AUTHOR);
  const evidence = store.create(
    'evidence',
    { description: 'Baggie', category: 'drugs', foundAt: 'Glovebox', custody: [{ game: 51200, action: 'collected', by: AUTHOR, note: 'bagged' }], callId: null },
    at(4), AUTHOR,
  );
  const supplement = store.create('supplement', { parentId: report.id, narrative: 'The suspect was identified later.', callId: 5 }, at(5), AUTHOR);
  const plain = (d: CadDocument): Record<string, unknown> => JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  return { report: plain(report), citation: plain(citation), booking: plain(booking), evidence: plain(evidence), supplement: plain(supplement) };
}

/** Values of the wrong type for a field holding `value` (all of them invalid for every guard used by documents). */
function wrongTypes(value: unknown, nullable = false): unknown[] {
  if (nullable) return wrongTypes(value).filter((v) => v !== null);
  if (typeof value === 'string') return [42, null, ['x'], {}, true];
  if (typeof value === 'number') return ['1', null, Number.NaN, Infinity, {}, []];
  if (value === null) return ['x', {}, [], true];
  if (Array.isArray(value)) return ['x', null, {}, 42];
  return ['x', 42, null, []];
}

/** Fields whose type is `number | null`: null is a valid value for them. */
const NULLABLE: ReadonlySet<string> = new Set(['callId', 'recordedSpeedMph', 'limitMph']);

describe('isCadDocument', () => {
  const docs = validDocs();

  it.each(DOC_KINDS.map((k) => [k] as const))('accepts a valid %s, also after a JSON round trip', (kind: DocKind) => {
    const doc = docs[kind];
    expect(doc?.kind).toBe(kind);
    expect(isCadDocument(doc)).toBe(true);
    expect(isCadDocument(JSON.parse(JSON.stringify(doc)))).toBe(true);
    expect(isCadDocument({ ...doc, status: 'final' })).toBe(true);
    expect(isCadDocument({ ...doc, callId: null })).toBe(true);
  });

  it.each(DOC_KINDS.map((k) => [k] as const))('rejects a %s with any field missing or of the wrong type', (kind: DocKind) => {
    const doc = docs[kind];
    expect(Object.keys(doc).length).toBeGreaterThanOrEqual(9);
    for (const key of Object.keys(doc)) {
      const without = { ...doc };
      delete without[key];
      expect(isCadDocument(without), `${kind} without ${key}`).toBe(false);
      for (const bad of wrongTypes(doc[key], NULLABLE.has(key))) expect(isCadDocument({ ...doc, [key]: bad }), `${kind}.${key} = ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('rejects an unknown kind, an unknown status, non-integer ids and non-objects', () => {
    const report = docs.report;
    expect(isCadDocument({ ...report, kind: 'memo' })).toBe(false);
    expect(isCadDocument({ ...report, status: 'archived' })).toBe(false);
    expect(isCadDocument({ ...report, callId: 1.5 })).toBe(false);
    expect(isCadDocument({ ...report, created: { sim: 1 } })).toBe(false);
    expect(isCadDocument({ ...report, updated: { sim: 1, game: Number.NaN } })).toBe(false);
    expect(isCadDocument({ ...docs.citation, personId: 1.5 })).toBe(false);
    expect(isCadDocument({ ...docs.citation, recordedSpeedMph: 'fast' })).toBe(false);
    expect(isCadDocument({ ...docs.citation, limitMph: null, recordedSpeedMph: null })).toBe(true);
    for (const x of [null, undefined, 3, 'R-0001', [], [report], true]) expect(isCadDocument(x)).toBe(false);
  });

  it('rejects each missing or mistyped field of the nested entries', () => {
    const report = docs.report as { persons: Record<string, unknown>[]; vehicles: Record<string, unknown>[] } & Record<string, unknown>;
    const nested: [string, Record<string, unknown>, string, Record<string, unknown>[]][] = [
      ['report', report, 'persons', report.persons],
      ['report', report, 'vehicles', report.vehicles],
      ['citation', docs.citation, 'violations', (docs.citation as { violations: Record<string, unknown>[] }).violations],
      ['evidence', docs.evidence, 'custody', (docs.evidence as { custody: Record<string, unknown>[] }).custody],
    ];
    for (const [name, doc, list, entries] of nested) {
      const entry = entries[0] as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        const without = { ...entry };
        delete without[key];
        expect(isCadDocument({ ...doc, [list]: [without] }), `${name}.${list}[0] without ${key}`).toBe(false);
        for (const bad of wrongTypes(entry[key])) expect(isCadDocument({ ...doc, [list]: [{ ...entry, [key]: bad }] }), `${name}.${list}[0].${key}`).toBe(false);
      }
      expect(isCadDocument({ ...doc, [list]: [entry, 'x'] }), `${name}.${list} with a bad item`).toBe(false);
      expect(isCadDocument({ ...doc, [list]: [] }), `${name}.${list} empty`).toBe(true);
    }
    expect(isCadDocument({ ...report, offenseIds: ['PC-250', 3] })).toBe(false);
    expect(isCadDocument({ ...report, evidenceIds: [1] })).toBe(false);
    expect(isCadDocument({ ...docs.booking, charges: ['PC-260', null] })).toBe(false);
    expect(isCadDocument({ ...report, persons: [{ personId: 1.5, role: 'victim' }] })).toBe(false);
  });
});

describe('isDocumentsSave', () => {
  function save(): { counters: Record<string, unknown>; items: Record<string, unknown>[] } {
    const docs = validDocs();
    return { counters: { report: 1, citation: 1, booking: 1, evidence: 1, supplement: 1 }, items: DOC_KINDS.map((k) => docs[k]) };
  }

  it('accepts an empty save, a full save and the output of a store', () => {
    expect(isDocumentsSave({ counters: emptyCounters(), items: [] })).toBe(true);
    expect(isDocumentsSave(save())).toBe(true);
    const store = new DocumentStore();
    for (const k of DOC_KINDS) store.create(k, {}, at(1), AUTHOR);
    expect(isDocumentsSave(store.serialize())).toBe(true);
    expect(isDocumentsSave(JSON.parse(JSON.stringify(store.serialize())))).toBe(true);
  });

  it('rejects a missing, negative, fractional or mistyped counter of any kind', () => {
    for (const kind of DOC_KINDS) {
      const missing = save();
      delete missing.counters[kind];
      expect(isDocumentsSave(missing), `${kind} missing`).toBe(false);
      for (const bad of [-1, 1.5, '1', null, Number.NaN]) {
        const s = save();
        s.counters[kind] = bad;
        expect(isDocumentsSave(s), `${kind} = ${String(bad)}`).toBe(false);
      }
    }
  });

  it('rejects duplicate ids, an invalid item, wrong containers and non-objects', () => {
    const dup = save();
    dup.items.push({ ...(dup.items[0] as Record<string, unknown>) });
    expect(isDocumentsSave(dup)).toBe(false);
    const bad = save();
    bad.items.push({ kind: 'report' });
    expect(isDocumentsSave(bad)).toBe(false);
    expect(isDocumentsSave({ counters: emptyCounters(), items: {} })).toBe(false);
    expect(isDocumentsSave({ counters: [], items: [] })).toBe(false);
    expect(isDocumentsSave({ items: [] })).toBe(false);
    expect(isDocumentsSave({ counters: emptyCounters() })).toBe(false);
    for (const x of [null, undefined, 1, 'x', []]) expect(isDocumentsSave(x)).toBe(false);
  });
});

describe('statutes (findStatute)', () => {
  const rows = (statutesJson as { statutes: { id: string; title: string; class: string; fine: number; citeable: boolean; bookable: boolean }[] }).statutes;

  it('finds every statute of statutes.json with its fields', () => {
    expect(rows.length).toBeGreaterThanOrEqual(46);
    for (const row of rows) {
      const s = findStatute(row.id);
      expect(s, row.id).not.toBeNull();
      expect(s).toMatchObject({ id: row.id, title: row.title, cls: row.class, fine: row.fine, citeable: row.citeable, bookable: row.bookable });
      expect(statute(row.id)).toBe(s);
    }
    expect(STATUTES.map((x) => x.id)).toEqual(expect.arrayContaining(rows.map((r) => r.id)));
  });

  it('returns null for an unknown id and does not look into the prototype', () => {
    for (const id of ['XX-000', 'TR-999', '', 'tr-301', ' TR-301', 'TR-301 ', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(findStatute(id), JSON.stringify(id)).toBeNull();
    }
    expect(() => statute('XX-000')).toThrow(/XX-000/);
  });

  it('lets validation use it: unknown, non-citeable and non-bookable statutes keep a document from being finalized', () => {
    const store = new DocumentStore();
    const warrant = rows.find((r) => !r.citeable && r.bookable);
    const infraction = rows.find((r) => r.citeable && !r.bookable);
    expect(warrant && infraction).toBeTruthy();
    const c = store.create('citation', { personId: 1, plate: 'A', location: 'x', violations: [{ statuteId: 'XX-000', fine: 1, detail: '' }, { statuteId: warrant?.id ?? '', fine: 1, detail: '' }] }, at(1), AUTHOR);
    expect(validateDocument(c).join('|')).toMatch(/unknown statute XX-000.*not citeable/);
    const b = store.create('booking', { personId: 1, charges: ['XX-000', infraction?.id ?? ''] }, at(1), AUTHOR);
    expect(validateDocument(b).join('|')).toMatch(/XX-000 is unknown.*not bookable.*at least one bookable/);
  });
});

describe('ten-code texts (codeText)', () => {
  const MODES: readonly RadioMode[] = ['tenCode', 'plain'];
  const keys = Object.keys((tenCodesJson as { codes: Record<string, unknown> }).codes);

  it('gives the text of every key of tenCodes.json in both radio modes', () => {
    expect(keys.length).toBeGreaterThanOrEqual(17);
    expect(Object.keys(TEN_CODES.codes)).toEqual(keys);
    const json = (tenCodesJson as { codes: Record<string, { code: string; plain: string }> }).codes;
    for (const key of keys) {
      const row = json[key];
      expect(codeText(key, 'tenCode'), key).toBe(row?.code);
      expect(codeText(key, 'plain'), key).toBe(row?.plain);
      for (const mode of MODES) expect(codeText(key, mode).length, `${key} ${mode}`).toBeGreaterThan(0);
    }
  });

  it('differs between the modes for the keys that have a number', () => {
    expect(codeText('available', 'tenCode')).not.toBe(codeText('available', 'plain'));
    expect(codeText('ack', 'tenCode')).toBe((tenCodesJson as { codes: { ack: { code: string } } }).codes.ack.code);
  });

  it('gives the text of every unit status in both modes through its code key', () => {
    for (const status of UNIT_STATUSES) {
      for (const mode of MODES) expect(statusText(status, mode)).toBe(codeText(TEN_CODES.statusKeys[status], mode));
    }
  });

  it('throws on an unknown key, also for names on the prototype', () => {
    for (const key of ['', 'nope', 'Available', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      for (const mode of MODES) expect(() => codeText(key, mode), JSON.stringify(key)).toThrow(/Unknown ten-code key/);
    }
  });
});

describe('plate run narrative (plateRunNarrative)', () => {
  const base: PlateReadback = {
    plate: 'ABC 1234', found: true, description: '2019 black sedan', owner: 'DOE, JOHN', ownerPersonId: 7, hits: [], severity: 'clear',
  };
  const SEVERITIES: readonly ReadbackSeverity[] = ['clear', 'caution', 'alert'];
  const HITS: Record<ReadbackSeverity, readonly string[]> = {
    clear: [], caution: ['REGISTRATION EXPIRED'], alert: ['STOLEN VEHICLE', 'OWNER WANTED'],
  };

  it.each(SEVERITIES.map((s) => [s] as const))('writes a %s readback with its hits', (severity: ReadbackSeverity) => {
    const hits = HITS[severity];
    const text = plateRunNarrative({ ...base, severity, hits });
    expect(text.startsWith('Plate ABC 1234: 2019 BLACK SEDAN, RO DOE, JOHN')).toBe(true);
    if (hits.length === 0) expect(text).toBe('Plate ABC 1234: 2019 BLACK SEDAN, RO DOE, JOHN');
    else expect(text).toBe(`Plate ABC 1234: 2019 BLACK SEDAN, RO DOE, JOHN - ${hits.join('; ')}`);
  });

  it.each(SEVERITIES.map((s) => [s] as const))('writes a %s readback of a plate with no record', (severity: ReadbackSeverity) => {
    expect(plateRunNarrative({ ...base, found: false, severity, hits: HITS[severity], description: '', owner: '' })).toBe('Plate ABC 1234: NO RECORD');
  });

  it('upper-cases the description only and keeps the plate as typed', () => {
    expect(plateRunNarrative({ ...base, plate: 'xyz 9', description: 'red pickup' })).toBe('Plate xyz 9: RED PICKUP, RO DOE, JOHN');
  });
});
