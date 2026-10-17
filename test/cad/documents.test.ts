import { describe, expect, it } from 'vitest';
import {
  DocumentStore,
  DocumentValidationError,
  citationTotal,
  docIdNumber,
  formatDocId,
  validateDocument,
  type PersonRole,
} from '../../src/cad/documents';
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
