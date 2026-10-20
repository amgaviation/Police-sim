import { describe, expect, it } from 'vitest';
import { PLATE_FLAG, canBeOnRoad, generateRegistration, mountedPlate } from '../../src/records/vehicle';
import { hasGeneratedWarrant } from '../../src/records/person';
import { isTextField, MDT_REFRESH_MS, MdtOverlay, parseClock } from '../../src/ui/mdt';
import { parseDob } from '../../src/ui/mdt/overlay';
import { epochDayFromYmd } from '../../src/records/calendar';
import type { PlateSummary } from '../../src/records/db';
import { addCall, at, fixture, key, SEED, startStop } from './helpers';

const input = { tagName: 'INPUT', type: 'text' };
const textarea = { tagName: 'TEXTAREA' };
const checkbox = { tagName: 'INPUT', type: 'checkbox' };

describe('isTextField', () => {
  it('treats inputs, textareas, selects and editable content as text fields', () => {
    expect(isTextField(input)).toBe(true);
    expect(isTextField({ tagName: 'input', type: 'number' })).toBe(true);
    expect(isTextField(textarea)).toBe(true);
    expect(isTextField({ tagName: 'SELECT' })).toBe(true);
    expect(isTextField({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextField(checkbox)).toBe(false);
    expect(isTextField({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe('MdtOverlay (headless)', () => {
  it('constructs without a DOM and opens, updates and closes', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    expect(mdt.id).toBe('mdt');
    expect(mdt.pausesGame).toBe(false);
    expect(mdt.isOpen).toBe(false);
    mdt.update(0);
    expect(mdt.refreshes).toBe(0); // nothing while closed
    mdt.open('units');
    expect(mdt.isOpen).toBe(true);
    expect(mdt.tab).toBe('units');
    mdt.update(1000);
    expect(mdt.refreshes).toBe(1);
    mdt.close();
    expect(mdt.isOpen).toBe(false);
    mdt.update(5000);
    expect(mdt.refreshes).toBe(1);
    mdt.dispose();
  });

  it('refreshes at most 4 Hz and only when the CAD revision or the tab changed', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open();
    mdt.update(1000);
    expect(mdt.refreshes).toBe(1);
    mdt.update(1000 + MDT_REFRESH_MS / 2);
    mdt.update(1000 + MDT_REFRESH_MS * 2);
    expect(mdt.refreshes).toBe(1); // unchanged
    addCall(f.cad, 1, 2);
    mdt.update(1000 + MDT_REFRESH_MS * 2 + 10); // throttled
    expect(mdt.refreshes).toBe(1);
    mdt.update(1000 + MDT_REFRESH_MS * 3);
    expect(mdt.refreshes).toBe(2);
    // AVL changes refresh only the Units and Map tabs.
    f.cad.setUnitPosition('21', 10, 10);
    mdt.update(1000 + MDT_REFRESH_MS * 4);
    expect(mdt.refreshes).toBe(2);
    mdt.setTab('map');
    mdt.update(1000 + MDT_REFRESH_MS * 4 + 1);
    expect(mdt.refreshes).toBe(3);
    f.cad.setUnitPosition('21', 20, 10);
    mdt.update(1000 + MDT_REFRESH_MS * 6);
    expect(mdt.refreshes).toBe(4);
    // BOLO tab: a new query refreshes it.
    mdt.setTab('bolo');
    mdt.update(3000);
    expect(mdt.refreshes).toBe(5);
    f.records.runPlate('ABC1234');
    mdt.update(3000 + MDT_REFRESH_MS);
    expect(mdt.refreshes).toBe(6);
  });

  it('Escape closes, digits switch tabs when not editing and are ignored while typing', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    expect(mdt.onKeyDown(key('1'))).toBe(false); // closed
    mdt.open();
    expect(mdt.onKeyDown(key('5'))).toBe(true);
    expect(mdt.tab).toBe('person');
    expect(mdt.onKeyDown(key('9', checkbox))).toBe(true);
    expect(mdt.tab).toBe('stop');
    expect(mdt.onKeyDown(key('3', input))).toBe(false);
    expect(mdt.onKeyDown(key('3', textarea))).toBe(false);
    expect(mdt.tab).toBe('stop');
    expect(mdt.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('career'); // Phase 5 tabs follow Stop
    expect(mdt.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('community');
    expect(mdt.onKeyDown(key('ArrowRight'))).toBe(true);
    expect(mdt.tab).toBe('queue');
    expect(mdt.onKeyDown(key('ArrowLeft'))).toBe(true);
    expect(mdt.tab).toBe('community');
    expect(mdt.onKeyDown(key('0'))).toBe(true);
    expect(mdt.tab).toBe('career');
    expect(mdt.onKeyDown(key('ArrowLeft'))).toBe(true);
    expect(mdt.tab).toBe('stop');
    expect(mdt.onKeyDown(key('ArrowLeft', input))).toBe(false);
    expect(mdt.onKeyDown({ ...key('2'), ctrlKey: true })).toBe(false);
    expect(mdt.onKeyDown(key('x'))).toBe(false);
    expect(mdt.onKeyDown(key('Escape', input))).toBe(true);
    expect(mdt.isOpen).toBe(false);
  });

  it('Escape cancels an open form before closing', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('queue');
    mdt.openForm('report');
    expect(mdt.editing).toBe(true);
    expect(mdt.tab).toBe('reports');
    expect(mdt.onKeyDown(key('Escape', textarea))).toBe(true);
    expect(mdt.editing).toBe(false);
    expect(mdt.isOpen).toBe(true);
    expect(mdt.onKeyDown(key('Escape'))).toBe(true);
    expect(mdt.isOpen).toBe(false);
  });

  it('Escape on another tab closes the MDT and keeps the open form', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('reports');
    mdt.openForm('report');
    mdt.setTab('person');
    expect(mdt.onKeyDown(key('Escape', input))).toBe(true);
    expect(mdt.isOpen).toBe(false);
    expect(mdt.editing).toBe(true);
    expect(mdt.formKind).toBe('report');
    mdt.open();
    expect(mdt.tab).toBe('person');
    mdt.setTab('reports');
    expect(mdt.onKeyDown(key('Escape', input))).toBe(true);
    expect(mdt.editing).toBe(false);
    expect(mdt.isOpen).toBe(true);
  });

  it('saves an open form as a draft before another form or a document replaces it', () => {
    const f = fixture();
    startStop(f, 123);
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('reports');
    mdt.openForm('report', { callId: null, title: 'Found property', location: 'Oak', occurredGame: 0, narrative: 'Bicycle found' });
    expect(mdt.writeCitation()).toBe(true);
    expect(mdt.formKind).toBe('citation');
    const reports = f.cad.docs.list('report');
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ status: 'draft', title: 'Found property', narrative: 'Bicycle found' });
    // Viewing a document also keeps the open citation as a draft.
    mdt.viewDocument(reports[0]?.id ?? '');
    expect(mdt.editing).toBe(false);
    expect(f.cad.docs.list('citation').length).toBe(1);
  });

  it('shows dispatcher refusals of MDT requests', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('queue');
    mdt.acceptCall(1);
    expect(mdt.message).toBe('Accept sent');
    mdt.notify('No call offered', false);
    expect(mdt.message).toBe('Refused: No call offered');
    expect(mdt.messageIsError).toBe(true);
    mdt.notify('10-4', true);
    expect(mdt.message).toBe('10-4');
    expect(mdt.messageIsError).toBe(false);
  });

  it('reports MDT plate runs like dispatcher runs (deps.plateRun)', () => {
    const f = fixture();
    const runs: { vehicleId: number; readback: PlateSummary }[] = [];
    const mdt = new MdtOverlay(null, { ...f.deps, plateRun: (vehicleId, readback) => runs.push({ vehicleId, readback }) });
    const plate = mountedPlate(SEED, 77).plate;
    mdt.runPlate(plate, 77);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ vehicleId: 77, readback: { plate, found: true } });
  });

  it('refuses malformed DOBs and report times instead of ignoring them', () => {
    expect(parseDob('13/45/1990')).toBeUndefined();
    expect(parseDob('02/30/1990')).toBeUndefined();
    expect(parseDob('02/28/1990')).toBe(epochDayFromYmd(1990, 2, 28));
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('person');
    const before = f.records.queryLog.length;
    expect(mdt.searchPersonFields({ last: 'Smith', first: '', dob: '13/45/1990', dl: '' })).toBeNull();
    expect(mdt.message).toBe('DOB must be MM/DD/YYYY');
    expect(f.records.queryLog.length).toBe(before);
    expect(mdt.searchPersonFields({ last: 'Smith', first: '', dob: '', dl: '' })).not.toBeNull();
    // Report time: HH:MM only, nearest day to the call time.
    const day = 86400;
    expect(parseClock('9.30', 10 * 3600)).toBeNull();
    expect(parseClock('25:10', 10 * 3600)).toBeNull();
    expect(parseClock('930', 10 * 3600)).toBeNull();
    expect(parseClock('09:30', day + 10 * 3600)).toBe(day + 9.5 * 3600);
    expect(parseClock('00:20', day + 23.5 * 3600)).toBe(2 * day + 1200);
    expect(parseClock('23:50', 2 * day + 600)).toBe(day + 23 * 3600 + 50 * 60);
  });

  it('sends CAD changes through deps.request', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const call = addCall(f.cad, 0, 2);
    mdt.acceptCall(call.id);
    mdt.declineCall(call.id);
    mdt.selfAssign(call.id);
    mdt.setStatus('onScene');
    mdt.clearCall(call.id, 'handled');
    expect(mdt.addNarrative(call.id, '   ')).toBe(false);
    expect(mdt.addNarrative(call.id, ' Area checked ')).toBe(true);
    mdt.wantsCheck(42);
    mdt.wantsCheck(-1);
    mdt.releaseStop();
    expect(f.requests).toEqual([
      { kind: 'acceptCall', callId: call.id },
      { kind: 'declineCall', callId: call.id },
      { kind: 'selfAssign', callId: call.id },
      { kind: 'status', status: 'onScene' },
      { kind: 'clearCall', callId: call.id, disposition: 'handled' },
      { kind: 'narrative', callId: call.id, text: 'Area checked' },
      { kind: 'runPerson', personId: 42 },
      { kind: 'stopContact', action: 'release' },
    ]);
    // Nothing was changed directly.
    expect(f.cad.call(call.id)?.status).toBe('pending');
  });

  it('runs records queries directly, with the observed car for the stop vehicle', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const v = 777;
    const stop = startStop(f, v);
    const r = mdt.runStopVehicle();
    expect(r?.plate).toBe(stop.plate);
    expect(r?.observed).not.toBeNull();
    expect(f.records.queryLog.at(-1)).toMatchObject({ kind: 'plate', gameSeconds: at(0).game });
    const vin = mdt.runVehicleQuery(generateRegistration(SEED, v).vin);
    expect(vin && 'vin' in vin && vin.found).toBe(true);
    const plate = mdt.runVehicleQuery(generateRegistration(SEED, 5).plate.toLowerCase());
    expect(plate && 'plate' in plate && plate.registration?.vehicleId).toBe(5);
    expect(mdt.runTarget()).toBeNull();
    expect(mdt.message).toBe('No target vehicle');
    let licensed = 321;
    while (f.records.person(licensed).license.number === '') licensed++;
    const results = mdt.searchPersons({ dl: f.records.person(licensed).license.number });
    expect(results.map((p) => p.personId)).toEqual([licensed]);
    expect(mdt.personId).toBe(licensed);
    expect(mdt.tab).toBe('person');
    expect(mdt.searchPersons({ first: 'JOHN' })).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('records a Stop-tab plate run in CAD (survives a new overlay) and ignores an ended stop', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const stop = startStop(f, 777);
    mdt.runStopVehicle();
    expect(f.cad.trafficStop?.plateRun).toBe(true);
    expect(f.cad.call(stop.callId)?.narrative.at(-1)?.text).toMatch(new RegExp(`^Plate ${stop.plate}`));
    const fresh = new MdtOverlay(null, f.deps);
    fresh.openForm('citation');
    expect(fresh.formKind).toBe('citation');
    // The stop ends: later citations are not prefilled from it and the stop actions are refused.
    f.cad.updateTrafficStop({ outcome: 'released' }, at(1));
    f.cad.closeCall(stop.callId, 'handled', at(1));
    const after = new MdtOverlay(null, f.deps);
    after.openForm('citation');
    const r = after.submitForm(false);
    expect(r.doc?.kind === 'citation' && r.doc.plate).toBe('');
    expect(r.doc?.callId).toBeNull();
    expect(after.runStopVehicle()).toBeNull();
    expect(after.message).toBe('No active traffic stop');
  });

  it('refuses to show a person outside the population', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('queue');
    expect(() => mdt.showPerson(99_999_999)).not.toThrow();
    expect(mdt.message).toBe('Unknown person #99999999');
    expect(mdt.tab).toBe('queue');
    expect(mdt.personId).toBe(-1);
  });

  it('issues a citation prefilled from the stop (create + finalize)', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    f.state.violations = { speeding: 1 };
    f.state.speed = { speedMph: 48, limitMph: 30 };
    const v = 1500;
    const stop = startStop(f, v, { driverId: 4321 });
    mdt.open('stop');
    mdt.writeCitation();
    expect(mdt.tab).toBe('reports');
    expect(mdt.formKind).toBe('citation');
    const r = mdt.submitForm(true);
    expect(r.errors).toEqual([]);
    const doc = r.doc;
    expect(doc?.kind).toBe('citation');
    if (doc?.kind !== 'citation') return;
    expect(doc).toMatchObject({
      id: 'CT-000001', status: 'final', author: 'Officer Doe #4071', callId: stop.callId, personId: 4321,
      plate: stop.plate, vehicleId: v, location: '400 S Elm Street', recordedSpeedMph: 48, limitMph: 30, totalFine: 150,
    });
    expect(doc.violations).toEqual([{ statuteId: 'TR-301', fine: 150, detail: '48 mph in a 30 mph zone' }]);
    expect(mdt.editing).toBe(false);
    expect(mdt.message).toBe('CT-000001 issued');
  });

  it('keeps an invalid citation as a draft and reports the validation messages', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open();
    mdt.openForm('citation', { location: '' });
    const r = mdt.submitForm(true);
    expect(r.errors).toContain('Citation needs at least one violation');
    expect(r.errors).toContain('Citation needs a person');
    expect(r.doc?.status).toBe('draft');
    expect(mdt.editing).toBe(true);
  });

  it('completes a booking only at the station with the prisoner', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const wanted = (() => {
      for (let i = 0; i < 100000; i++) if (hasGeneratedWarrant(SEED, i)) return i;
      return -1;
    })();
    f.state.prisoner = wanted;
    mdt.open();
    mdt.openForm('booking');
    let r = mdt.submitForm(true);
    expect(r.errors[0]).toMatch(/station/);
    expect(r.doc).toMatchObject({ kind: 'booking', status: 'draft', personId: wanted, charges: ['PC-220'] });
    expect(f.completed).toEqual([]);
    f.state.atStation = true;
    r = mdt.submitForm(true);
    expect(r.errors).toEqual([]);
    expect(r.doc?.status).toBe('final');
    expect(f.completed).toEqual(['B-0001']);
  });

  it('logs evidence with a collected custody entry and links supplements to final reports', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const ev = mdt.saveDocument('evidence', { description: 'Pocket knife', category: 'weapon', foundAt: 'Front seat' }, true);
    expect(ev.errors).toEqual([]);
    expect(ev.doc?.kind === 'evidence' && ev.doc.custody).toEqual([{ game: at(0).game, action: 'collected', by: 'Officer Doe #4071', note: '' }]);
    const report = mdt.saveDocument('report', { title: 'Theft', location: '248 N Oak Street', narrative: 'Victim reported a stolen bicycle from the porch.', evidenceIds: ['E-0001'] }, true);
    expect(report.doc?.status).toBe('final');
    const bad = mdt.saveDocument('supplement', { parentId: 'R-0099', narrative: 'Follow-up with witness.' }, true);
    expect(bad.errors).toContain('Supplement needs an existing report');
    const sup = mdt.saveDocument('supplement', { parentId: 'R-0001', narrative: 'Follow-up with witness.' }, true, bad.doc?.id ?? null);
    expect(sup.errors).toEqual([]);
    expect(sup.doc).toMatchObject({ id: 'S-0001', status: 'final', parentId: 'R-0001' });
    mdt.viewDocument('R-0001');
    expect(mdt.tab).toBe('reports');
  });

  it('prefills a report from the player call', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const call = addCall(f.cad, 0, 3);
    f.cad.assign(call.id, '12', at(1), 'self');
    mdt.openForm('report');
    const r = mdt.submitForm(false);
    expect(r.doc).toMatchObject({
      kind: 'report', status: 'draft', callId: call.id, title: 'Traffic hazard', location: '248 N Oak Street',
      persons: [{ personId: 77, role: 'reportingParty' }],
    });
    expect(f.cad.call(call.id)?.documents).toEqual(['R-0001']);
    // A draft stays open (headless forms close after saving).
    expect(mdt.message).toBe('R-0001 saved as draft');
  });

  it('runs a typed stop plate against the stop car, so a mismatched plate is caught and citable', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    let v = 0;
    while (mountedPlate(SEED, v).anomaly !== 'mismatched' || !canBeOnRoad(SEED, v)) v++;
    const stop = startStop(f, v, { vinChecked: true });
    const r = mdt.runVehicleQuery(stop.plate.replace(' ', '').toLowerCase());
    expect(r && 'plate' in r ? r.flags & PLATE_FLAG.mismatched : 0).toBeTruthy();
    expect(r && 'plate' in r ? r.hits.some((h) => h.kind === 'mismatch') : false).toBe(true);
    expect(f.cad.trafficStop?.plateRun).toBe(true);
    mdt.openForm('citation');
    const doc = mdt.submitForm(false).doc;
    expect(doc?.kind === 'citation' ? doc.violations.map((x) => x.detail) : []).toContain('Plate run: cloned');
  });

  it("does not show an earlier stop's plate run for a new stop of a car with the same plate", () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    let v = 0;
    while (mountedPlate(SEED, v).anomaly !== 'mismatched' || !f.records.registration(mountedPlate(SEED, v).plateVehicleId).expired) v++;
    const donor = mountedPlate(SEED, v).plateVehicleId;
    const first = startStop(f, donor);
    expect(mdt.runStopVehicle()?.flags).toBeTruthy();
    f.cad.updateTrafficStop({ outcome: 'released' }, at(1));
    f.cad.closeCall(first.callId, 'handled', at(1));
    const second = startStop(f, v);
    expect(second.plate).toBe(first.plate);
    mdt.openForm('citation');
    const doc = mdt.submitForm(false).doc;
    // Not run on this stop: no plate issues prefilled from the first car's run.
    expect(doc?.kind === 'citation' ? doc.violations.filter((x) => x.detail.startsWith('Plate run')) : null).toEqual([]);
  });

  it("does not link a new document to the queue's auto-selected call", () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const call = addCall(f.cad, 0, 2);
    f.cad.assign(call.id, '21', at(0), 'dispatch');
    mdt.open('queue');
    mdt.update(1000);
    expect(mdt.selectedCallId).toBe(call.id);
    for (const kind of ['citation', 'report', 'evidence'] as const) {
      mdt.open('queue');
      mdt.openForm(kind);
      const doc = mdt.submitForm(false).doc;
      expect(doc?.callId, kind).toBeNull();
    }
    expect(f.cad.call(call.id)?.documents).toEqual([]);
  });

  it('keeps an open form as a draft on flushDraft and dispose', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.openForm('report', { callId: null, title: 'Found property', location: '1 Main Street', occurredGame: 0, narrative: 'A long narrative' });
    expect(mdt.flushDraft()).toBe(true);
    const doc = f.cad.docs.get('R-0001');
    expect(doc?.status).toBe('draft');
    expect(doc?.kind === 'report' ? doc.narrative : '').toBe('A long narrative');
    expect(mdt.flushDraft()).toBe(true);
    expect(f.cad.docs.get('R-0002')).toBeNull();
    const other = new MdtOverlay(null, f.deps);
    other.openForm('evidence', { callId: null, foundAt: '2 Main Street', description: 'Wallet' });
    other.dispose();
    expect(f.cad.docs.list('evidence').length).toBe(1);
  });

  it('remembers the selected call and the stop vehicle is the stop plate', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    const call = addCall(f.cad, 0, 1);
    mdt.selectCall(call.id);
    expect(mdt.selectedCallId).toBe(call.id);
    const v = 2024;
    startStop(f, v);
    expect(mountedPlate(SEED, v).plate).toBe(f.cad.trafficStop?.plate);
  });
});
