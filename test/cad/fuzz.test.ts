import { describe, expect, it } from 'vitest';
import { CadState, MAX_CLOSED_CALLS, STATUS_TRANSITIONS, isCadSave } from '../../src/cad/cadState';
import { CALL_TYPES, DISPOSITIONS } from '../../src/cad/data';
import { DOC_KINDS, DocumentValidationError, isDocumentsSave, type DocKind } from '../../src/cad/documents';
import { CALLER_KINDS, STOP_OUTCOMES, UNIT_STATUSES, REQUEST_VIAS, type Priority, type TrafficStopInfo, type UnitKind } from '../../src/cad/types';
import { createRng, type Rng } from '../../src/core/rng';
import { LOCATION, at, recordingCad, type Recorded } from './helpers';

/**
 * Invariant fuzz (Phase 9 §10): 2 000 seeded random operations on one CadState. After every operation the call and
 * unit books agree, ids stay unique and increasing, and serialize -> restore round-trips to an identical save.
 */

const OPERATIONS = 2000;
const AUTHOR = 'Officer Doe #4071';

const BASE_OPS = [
  'create', 'assign', 'assign', 'assign', 'unassign', 'status', 'status', 'status', 'note', 'close', 'close',
  'docCreate', 'docUpdate', 'docFinalize', 'docCustody', 'stopStart', 'stopUpdate', 'stopEnd', 'offer', 'link', 'priority', 'location', 'position', 'emergency', 'roster',
] as const;
type Op = (typeof BASE_OPS)[number];

/** Operation mix of the main run: calls and documents are scarce (everything else three times as likely), so the books stay small enough to round-trip after every step. */
const SPARSE = BASE_OPS.filter((op) => op !== 'create' && op !== 'docCreate');
const OPS: readonly Op[] = [...BASE_OPS, ...SPARSE, ...SPARSE];

/** Operation mix of the cap run: many calls created and closed, so that the closed-call cap is reached. */
const CALL_HEAVY: readonly Op[] = [
  'create', 'create', 'create', 'create', 'create', 'assign', 'assign', 'assign', 'unassign', 'status', 'status', 'close', 'close', 'close', 'close', 'close',
  'note', 'docCreate', 'link', 'stopStart', 'stopEnd',
];

function pick<T>(rng: Rng, list: readonly T[]): T {
  const v = list[rng.nextInt(0, list.length - 1)];
  if (v === undefined) throw new Error('pick from an empty list');
  return v;
}

interface Harness {
  cad: CadState;
  events: Recorded[];
  rng: Rng;
  callsigns: string[];
  /** Highest call id handed out so far. */
  lastCallId: number;
  /** Ids ever handed out for calls, to see that none comes back. */
  seenCallIds: Set<number>;
  sim: number;
  log: string[];
}

function build(): Harness {
  const { cad, events } = recordingCad();
  const callsigns: string[] = [];
  const kinds: UnitKind[] = ['player', 'ai', 'ai', 'ai', 'resource'];
  kinds.forEach((kind, i) => {
    const callsign = String(10 + i);
    callsigns.push(callsign);
    cad.addUnit({ callsign, kind, officer: `Officer ${i}`, beat: 'downtown', fleetIndex: kind === 'player' ? -1 : i }, at(0));
  });
  return { cad, events, rng: createRng('cad-fuzz'), callsigns, lastCallId: 0, seenCallIds: new Set(), sim: 0, log: [] };
}

/** An id that is mostly an existing call (open or closed) and sometimes one that never existed (and never will). */
function someCallId(h: Harness): number {
  const calls = h.cad.calls();
  if (calls.length === 0 || h.rng.chance(0.08)) return h.lastCallId + 1000 + h.rng.nextInt(0, 9);
  return pick(h.rng, calls).id;
}

/** Mostly an open call (the interesting target of assignments, offers and notes), else any `someCallId`. */
function openCallId(h: Harness): number {
  const open = h.cad.openCalls();
  return open.length > 0 && h.rng.chance(0.85) ? pick(h.rng, open).id : someCallId(h);
}

function stopInfo(h: Harness): TrafficStopInfo {
  return {
    callId: someCallId(h), vehicleId: h.rng.nextInt(0, 50), plate: `ABC ${h.rng.nextInt(100, 999)}`, x: h.rng.nextFloat(-100, 100), z: h.rng.nextFloat(-100, 100),
    started: at(h.sim), driverId: -1, trueDriverId: h.rng.nextInt(0, 9), plateRun: false, vinChecked: false, vinResult: '', citations: [], outcome: 'active',
  };
}

function createDoc(h: Harness, kind: DocKind): void {
  const t = at(h.sim);
  const rng = h.rng;
  const callId = rng.chance(0.7) ? someCallId(h) : null;
  const known = h.cad.docs.list('report');
  switch (kind) {
    case 'report':
      h.cad.docs.create('report', { title: 'Report', location: LOCATION.text, narrative: 'A narrative long enough to pass the check.', callId, persons: [{ personId: rng.nextInt(0, 9), role: 'victim' }] }, t, AUTHOR);
      break;
    case 'citation':
      h.cad.docs.create('citation', { personId: rng.nextInt(0, 9), plate: 'XYZ 123', location: LOCATION.text, violations: [{ statuteId: rng.chance(0.8) ? 'TR-301' : 'XX-000', fine: rng.nextInt(50, 300), detail: '' }], callId }, t, AUTHOR);
      break;
    case 'booking':
      h.cad.docs.create('booking', { personId: rng.nextInt(0, 9), charges: [rng.chance(0.8) ? 'PC-260' : 'XX-000'], callId }, t, AUTHOR);
      break;
    case 'evidence':
      h.cad.docs.create('evidence', { description: 'A baggie', category: 'drugs', callId, custody: rng.chance(0.7) ? [{ game: t.game, action: 'collected', by: AUTHOR, note: '' }] : [] }, t, AUTHOR);
      break;
    case 'supplement':
      h.cad.docs.create('supplement', { parentId: known.length > 0 ? pick(rng, known).id : 'R-9999', narrative: 'More detail follows here.', callId }, t, AUTHOR);
      break;
  }
}

function step(h: Harness, op: Op): void {
  const { cad, rng } = h;
  const t = at(h.sim);
  const callsign = pick(rng, h.callsigns);
  switch (op) {
    case 'create': {
      const type = pick(rng, CALL_TYPES);
      const call = cad.createCall(
        { typeId: rng.chance(0.05) ? 'noSuchType' : type.id, priority: rng.nextInt(1, 4) as Priority, location: LOCATION,
          caller: { kind: pick(rng, CALLER_KINDS), name: 'Caller', phone: '555-0100', personId: rng.nextInt(-1, 9) }, narrative: 'A call.', selfInitiated: rng.chance(0.2) },
        t,
      );
      expect(call.id, 'call ids only grow').toBeGreaterThan(h.lastCallId);
      expect(h.seenCallIds.has(call.id)).toBe(false);
      h.seenCallIds.add(call.id);
      h.lastCallId = call.id;
      break;
    }
    case 'assign': cad.assign(openCallId(h), callsign, t, pick(rng, ['dispatch', 'self', 'backup'] as const)); break;
    case 'unassign': cad.unassign(callsign, t); break;
    case 'status': cad.setUnitStatus(callsign, pick(rng, UNIT_STATUSES), t, pick(rng, REQUEST_VIAS)); break;
    case 'note': cad.addNarrative(openCallId(h), 'Unit', 'A note', t); break;
    case 'close': {
      cad.closeCall(openCallId(h), pick(rng, DISPOSITIONS).id, t);
      break;
    }
    case 'docCreate': createDoc(h, pick(rng, DOC_KINDS)); break;
    case 'docUpdate': {
      const drafts = cad.docs.list().filter((d) => d.status === 'draft');
      const doc = drafts.length > 0 ? pick(rng, drafts) : null;
      if (doc && doc.kind !== 'evidence') cad.docs.update(doc.id, { callId: rng.chance(0.2) ? null : someCallId(h) }, t);
      break;
    }
    case 'docFinalize': {
      const drafts = cad.docs.list().filter((d) => d.status === 'draft');
      const doc = drafts.length > 0 ? pick(rng, drafts) : null;
      if (!doc) break;
      try {
        cad.docs.finalize(doc.id, t);
      } catch (error) {
        if (!(error instanceof DocumentValidationError)) throw error;
      }
      break;
    }
    case 'docCustody': {
      const items = cad.docs.list('evidence');
      if (items.length > 0) cad.docs.addCustody(pick(rng, items).id, { game: t.game, action: pick(rng, ['transferred', 'booked', 'released'] as const), by: AUTHOR, note: '' }, t);
      break;
    }
    case 'stopStart': cad.setTrafficStop(stopInfo(h), t); break;
    case 'stopUpdate': cad.updateTrafficStop({ outcome: pick(rng, STOP_OUTCOMES), plateRun: rng.chance(0.5), driverId: rng.nextInt(-1, 9), citations: rng.chance(0.3) ? ['CT-000001'] : [] }, t); break;
    case 'stopEnd': cad.setTrafficStop(rng.chance(0.5) ? null : { ...stopInfo(h), outcome: pick(rng, STOP_OUTCOMES) }, t); break;
    case 'offer': cad.offer(openCallId(h), rng.chance(0.2) ? null : callsign, h.sim + 30, t); break;
    case 'link': cad.linkCalls(openCallId(h), someCallId(h), t); break;
    case 'priority': cad.setPriority(openCallId(h), rng.nextInt(1, 4) as Priority, t); break;
    case 'location': cad.updateLocation(openCallId(h), { ...LOCATION, text: `${rng.nextInt(1, 999)} Elm Street` }, t); break;
    case 'position': cad.setUnitPosition(callsign, rng.nextFloat(-500, 500), rng.nextFloat(-500, 500)); break;
    case 'emergency': cad.setEmergency(callsign, rng.chance(0.5), t); break;
    case 'roster': {
      // A roster entry gone from the data since a save: the unit leaves its call, then comes back as a fresh unit.
      const unit = cad.unit(callsign);
      if (unit && cad.removeUnit(callsign)) cad.addUnit({ callsign, kind: unit.kind, officer: unit.officer, beat: unit.beat, fleetIndex: unit.fleetIndex }, t);
      break;
    }
  }
}

/** Throws (naming the operation) when an invariant fails: cheaper than an `expect` per fact in a 2 000-step loop. */
function must(condition: boolean, where: string, what: string): void {
  if (!condition) throw new Error(`${where}: ${what}`);
}

/** The invariants of the call, unit and document books; `where` names the operation for the failure message. */
function checkBooks(h: Harness, where: string): void {
  const { cad } = h;
  const calls = cad.calls();

  // Call ids: unique and in increasing order, numbers match.
  let prev = 0;
  for (const c of calls) {
    must(c.id > prev, where, `call ids increase (${c.id} after ${prev})`);
    must(c.id <= h.lastCallId, where, `call ${c.id} was never handed out`);
    prev = c.id;
    must(cad.call(c.id) === c, where, `call ${c.id} lookup`);
  }

  for (const c of calls) {
    must(new Set(c.units).size === c.units.length, where, `${c.number} units unique`);
    if (c.status === 'closed') {
      must(c.closed !== null && c.disposition !== null && c.offeredTo === null, where, `${c.number} close fields`);
      // A closed call keeps its units as a record, but no unit is still assigned to it.
      for (const callsign of c.units) must(cad.unit(callsign)?.callId !== c.id, where, `${callsign} still on closed ${c.number}`);
    } else {
      must(c.closed === null, where, `${c.number} open with a close time`);
      must(c.status === (c.units.length > 0 ? 'active' : 'pending'), where, `${c.number} status ${c.status} with ${c.units.length} units`);
      must(c.primary === null ? c.units.length === 0 : c.units.includes(c.primary), where, `${c.number} primary ${String(c.primary)}`);
      for (const callsign of c.units) must(cad.unit(callsign)?.callId === c.id, where, `${callsign} listed on ${c.number} but assigned elsewhere`);
    }
    must(!c.links.includes(c.id), where, `${c.number} links to itself`);
    for (const other of c.links) {
      const o = cad.call(other);
      must(o === null || o.links.includes(c.id), where, `link ${c.number} -> ${other} is not symmetric`);
    }
    for (const docId of c.documents) must(cad.docs.get(docId)?.callId === c.id, where, `${docId} listed on ${c.number} but linked elsewhere`);
  }

  // Units: a unit's call is open (and lists the unit) or null; an out-of-service unit has no call.
  for (const u of cad.units()) {
    if (u.callId === null) continue;
    const call = cad.call(u.callId);
    must(call !== null, where, `${u.callsign} is on call ${u.callId}, which does not exist`);
    must(call?.status !== 'closed', where, `${u.callsign} is on closed call ${u.callId}`);
    must(call?.units.includes(u.callsign) === true, where, `${u.callsign} is not listed on its call ${u.callId}`);
    must(u.status !== 'outOfService', where, `${u.callsign} is out of service on call ${u.callId}`);
  }

  // Documents: ids unique and per-kind increasing; call links agree.
  const seen = new Set<string>();
  for (const d of cad.docs.list()) {
    must(!seen.has(d.id), where, `document id ${d.id} twice`);
    seen.add(d.id);
    if (d.callId === null) continue;
    const call = cad.call(d.callId);
    must(call === null || call.documents.includes(d.id), where, `${d.id} is not listed on its call ${d.callId}`);
  }
  for (const kind of DOC_KINDS) {
    let last = 0;
    for (const d of cad.docs.list(kind)) {
      const n = Number(d.id.slice(d.id.indexOf('-') + 1));
      must(n > last, where, `${kind} ids increase (${d.id} after ${last})`);
      last = n;
    }
  }

}

/** Structural equality of plain data (key order ignored); the fuzz loop runs it thousands of times, so no `expect`. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const rb = b as Record<string, unknown>;
  const ra = a as Record<string, unknown>;
  return ka.every((k) => Object.hasOwn(rb, k) && same(ra[k], rb[k]));
}

/** Persistence: the save is valid, its documents block is valid, and restoring it changes nothing. `json` also sends it through JSON. */
function checkRoundTrip(h: Harness, where: string, json = false): void {
  const save = h.cad.serialize();
  must(isCadSave(save), where, 'save is not valid');
  must(isDocumentsSave(save.docs), where, 'documents save is not valid');
  const copy = new CadState();
  copy.restore(json ? (JSON.parse(JSON.stringify(save)) as typeof save) : save);
  const again = copy.serialize();
  if (!same(again, save)) {
    expect(again, `${where}: serialize -> restore round trip`).toEqual(save);
    throw new Error(`${where}: serialize -> restore round trip differs`);
  }
  if (json) must(same(JSON.parse(JSON.stringify(again)), again), where, 'the save is not JSON safe');
}

function check(h: Harness, where: string): void {
  checkBooks(h, where);
  checkRoundTrip(h, where);
}

describe('CadState fuzz', () => {
  it(`keeps its invariants, round trip included, after each of ${OPERATIONS} seeded operations`, () => {
    const h = build();
    const counts = new Map<Op, number>();
    for (let i = 0; i < OPERATIONS; i++) {
      h.sim += h.rng.nextFloat(0, 5);
      const op = pick(h.rng, OPS);
      counts.set(op, (counts.get(op) ?? 0) + 1);
      step(h, op);
      check(h, `op ${i} (${op})`);
    }
    // The run exercised every operation.
    for (const op of new Set(OPS)) expect(counts.get(op) ?? 0, `operation ${op} ran`).toBeGreaterThan(10);
    expect(h.lastCallId).toBeGreaterThan(15);
    expect(h.cad.docs.count).toBeGreaterThan(15);
    expect(h.cad.docs.list().some((d) => d.status === 'final')).toBe(true);
    expect(h.cad.calls().some((c) => c.status === 'closed')).toBe(true);
    expect(h.events.filter((e) => e.topic === 'cad:unitAssigned').length).toBeGreaterThan(10);
  }, 60_000);

  it('keeps the books while the closed-call cap drops old calls, with a round trip every 50 steps', () => {
    const h = build();
    for (let i = 0; i < OPERATIONS; i++) {
      h.sim += h.rng.nextFloat(0, 5);
      step(h, pick(h.rng, CALL_HEAVY));
      checkBooks(h, `cap run op ${i}`);
      if (i % 50 === 49) checkRoundTrip(h, `cap run op ${i}`, true);
    }
    checkRoundTrip(h, 'cap run end', true);
    expect(h.lastCallId).toBeGreaterThan(MAX_CLOSED_CALLS + 100);
    expect(h.cad.calls().filter((c) => c.status === 'closed').length).toBeLessThanOrEqual(MAX_CLOSED_CALLS);
    expect(h.cad.call(1), 'the oldest closed calls were dropped by the cap').toBeNull();
  }, 60_000);

  it('only ever announces status transitions that the table allows', () => {
    const h = build();
    for (let i = 0; i < OPERATIONS; i++) {
      h.sim += h.rng.nextFloat(0, 5);
      step(h, pick(h.rng, CALL_HEAVY));
    }
    const statuses = h.events.filter((e) => e.topic === 'cad:unitStatus');
    expect(statuses.length).toBeGreaterThan(100);
    for (const e of statuses) {
      const p = e.payload as { status: (typeof UNIT_STATUSES)[number]; prev: (typeof UNIT_STATUSES)[number] };
      expect(p.status).not.toBe(p.prev);
      expect(STATUS_TRANSITIONS[p.prev], `${p.prev} -> ${p.status}`).toContain(p.status);
    }
  });

  it('is deterministic: the same seed gives the same final save', () => {
    const run = (): unknown => {
      const h = build();
      for (let i = 0; i < 600; i++) {
        h.sim += h.rng.nextFloat(0, 5);
        step(h, pick(h.rng, OPS));
      }
      return h.cad.serialize();
    };
    expect(run()).toEqual(run());
  });
});
