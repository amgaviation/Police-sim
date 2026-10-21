import { describe, expect, it } from 'vitest';
import { CoopMirror } from '../../src/net/mirror';
import type { MirrorPort } from '../../src/net/mirror';
import type { NetCall, NetUnit, RoomEvent, RoomSnapshot } from '../../src/net/protocol';

type Rec = [string, ...unknown[]];

/** Port that records every call and hands out local ids from 100. */
function fakePort(): { port: MirrorPort; log: Rec[]; units: Map<string, NetUnit> } {
  const log: Rec[] = [];
  const units = new Map<string, NetUnit>();
  let nextLocal = 100;
  const port: MirrorPort = {
    createCall: (c) => {
      log.push(['createCall', c.id, c.label]);
      return nextLocal++;
    },
    assign: (id, cs, self) => log.push(['assign', id, cs, self]),
    unassign: (id, cs, self) => log.push(['unassign', id, cs, self]),
    setPriority: (id, p) => log.push(['setPriority', id, p]),
    addNote: (id, by, text) => log.push(['addNote', id, by, text]),
    close: (id, d) => log.push(['close', id, d]),
    upsertUnit: (u) => {
      log.push(['upsertUnit', u.callsign, u.status, u.callId, u.x, u.z, u.partner]);
      units.set(u.callsign, { ...u });
    },
    removeUnit: (cs) => log.push(['removeUnit', cs]),
    order: (o) => log.push(['order', o.to, o.order, o.callId]),
    radio: (from, ch, text) => log.push(['radio', from, ch, text]),
  };
  return { port, log, units };
}

const unit = (callsign: string, over: Partial<NetUnit> = {}): NetUnit => ({
  callsign, role: callsign.startsWith('N') ? 'patrol' : callsign === 'S1' ? 'supervisor' : 'dispatcher', name: callsign,
  status: 'available', callId: null, x: 0, z: 0, heading: 0, speed: 0, driving: false, partner: null, ...over,
});
const call = (id: number, over: Partial<NetCall> = {}): NetCall => ({
  id, ref: `ref${id}`, typeId: 'noise', label: `Call ${id}`, priority: 3, x: 1, z: 2, address: 'a', narrative: 'n',
  status: 'pending', units: [], primary: null, notes: [], createdBy: 'DISPATCH', origin: 'dispatcher', createdAtMs: 0,
  disposition: null, ...over,
});
const snap = (units: NetUnit[], calls: NetCall[]): RoomSnapshot => ({ room: 'r', seed: 1, rev: 5, host: 'N1', units, calls });

describe('CoopMirror snapshot', () => {
  it('creates open calls with their assignments and notes, and only remote units', () => {
    const { port, log } = fakePort();
    const m = new CoopMirror('N1');
    m.applySnapshot(
      snap(
        [unit('N1'), unit('N2', { x: 5 }), unit('DISPATCH')],
        [
          call(1, { status: 'active', units: ['N1', 'N2'], primary: 'N1', notes: [{ by: 'N2', text: 'hi', atMs: 1 }] }),
          call(2, { status: 'closed', disposition: 'handled' }),
          call(3),
        ],
      ),
      port,
    );
    expect(log).toEqual([
      ['upsertUnit', 'N2', 'available', null, 5, 0, null],
      ['upsertUnit', 'DISPATCH', 'available', null, 0, 0, null],
      ['createCall', 1, 'Call 1'],
      ['assign', 100, 'N1', true],
      ['assign', 100, 'N2', false],
      ['addNote', 100, 'N2', 'hi'],
      ['createCall', 3, 'Call 3'],
    ]);
    expect(m.localIdOf(1)).toBe(100);
    expect(m.localIdOf(3)).toBe(101);
    expect(m.localIdOf(2)).toBe(-1); // closed and never mirrored
    expect(m.netIdOf(101)).toBe(3);
    expect(m.netIdOf(555)).toBe(-1);
  });
  it('maps an own proposal by ref instead of creating a duplicate', () => {
    const { port, log } = fakePort();
    const m = new CoopMirror('N1');
    m.expectOwn('ref1', 7);
    m.applySnapshot(snap([unit('N1')], [call(1, { createdBy: 'N1', origin: 'officer', status: 'active', units: ['N1'], primary: 'N1' })]), port);
    expect(log).toEqual([['assign', 7, 'N1', true]]);
    expect(m.localIdOf(1)).toBe(7);
    expect(m.netIdOf(7)).toBe(1);
  });
  it('re-applying a snapshot reconciles instead of duplicating', () => {
    const { port, log } = fakePort();
    const m = new CoopMirror('N1');
    m.applySnapshot(snap([unit('N2')], [call(1, { units: ['N2'], primary: 'N2', status: 'active' })]), port);
    log.length = 0;
    m.applySnapshot(
      snap([unit('N3')], [call(1, { units: ['N3'], primary: 'N3', status: 'active', priority: 1, notes: [{ by: 'N3', text: 'x', atMs: 1 }] })]),
      port,
    );
    expect(log).toEqual([
      ['upsertUnit', 'N3', 'available', null, 0, 0, null],
      ['removeUnit', 'N2'],
      ['setPriority', 100, 1],
      ['unassign', 100, 'N2', false],
      ['assign', 100, 'N3', false],
      ['addNote', 100, 'N3', 'x'],
    ]);
    log.length = 0;
    m.applySnapshot(snap([unit('N3')], [call(1, { status: 'closed', disposition: 'unfounded', units: ['N3'], priority: 1, notes: [{ by: 'N3', text: 'x', atMs: 1 }] })]), port);
    expect(log).toEqual([['upsertUnit', 'N3', 'available', null, 0, 0, null], ['close', 100, 'unfounded']]);
  });
});

describe('CoopMirror events', () => {
  function start(self = 'N1'): { m: CoopMirror; port: MirrorPort; log: Rec[]; units: Map<string, NetUnit> } {
    const f = fakePort();
    const m = new CoopMirror(self);
    m.applySnapshot(snap([unit('N1'), unit('N2'), unit('DISPATCH')], []), f.port);
    f.log.length = 0;
    return { m, ...f };
  }
  it('mirrors a call lifecycle with self / remote flags', () => {
    const { m, port, log } = start();
    const evs: RoomEvent[] = [
      { k: 'callCreated', call: call(1) },
      { k: 'callAssigned', callId: 1, callsign: 'N2', primary: 'N2' },
      { k: 'callAssigned', callId: 1, callsign: 'N1', primary: 'N2' },
      { k: 'callPriority', callId: 1, priority: 1 },
      { k: 'callNote', callId: 1, note: { by: 'DISPATCH', text: 'update', atMs: 5 } },
      { k: 'callUnassigned', callId: 1, callsign: 'N2' },
      { k: 'callClosed', callId: 1, disposition: 'arrestMade' },
    ];
    for (const e of evs) m.applyEvent(e, port);
    expect(log).toEqual([
      ['createCall', 1, 'Call 1'],
      ['assign', 100, 'N2', false],
      ['assign', 100, 'N1', true],
      ['setPriority', 100, 1],
      ['addNote', 100, 'DISPATCH', 'update'],
      ['unassign', 100, 'N2', false],
      ['close', 100, 'arrestMade'],
    ]);
  });
  it('own proposals are mapped by ref, not created again', () => {
    const { m, port, log } = start();
    m.expectOwn('mine', 42);
    m.applyEvent({ k: 'callCreated', call: call(9, { ref: 'mine', createdBy: 'N1', origin: 'officer' }) }, port);
    expect(log).toEqual([]);
    expect(m.localIdOf(9)).toBe(42);
    expect(m.netIdOf(42)).toBe(9);
    m.applyEvent({ k: 'callAssigned', callId: 9, callsign: 'N1', primary: 'N1' }, port);
    expect(log).toEqual([['assign', 42, 'N1', true]]);
    // the same ref from somebody else is a different call
    m.expectOwn('shared', 43);
    m.applyEvent({ k: 'callCreated', call: call(10, { ref: 'shared', createdBy: 'N2' }) }, port);
    expect(log[1]).toEqual(['createCall', 10, 'Call 10']);
    // a duplicate callCreated is ignored
    m.applyEvent({ k: 'callCreated', call: call(10, { ref: 'shared', createdBy: 'N2' }) }, port);
    expect(log).toHaveLength(2);
  });
  it('ignores events for unknown or closed calls', () => {
    const { m, port, log } = start();
    m.applyEvent({ k: 'callAssigned', callId: 77, callsign: 'N2', primary: 'N2' }, port);
    m.applyEvent({ k: 'callUnassigned', callId: 77, callsign: 'N2' }, port);
    m.applyEvent({ k: 'callPriority', callId: 77, priority: 2 }, port);
    m.applyEvent({ k: 'callNote', callId: 77, note: { by: 'N2', text: 'x', atMs: 1 } }, port);
    m.applyEvent({ k: 'callClosed', callId: 77, disposition: 'handled' }, port);
    expect(log).toEqual([]);
    m.applyEvent({ k: 'callCreated', call: call(1) }, port);
    m.applyEvent({ k: 'callClosed', callId: 1, disposition: 'handled' }, port);
    log.length = 0;
    m.applyEvent({ k: 'callNote', callId: 1, note: { by: 'N2', text: 'late', atMs: 1 } }, port);
    m.applyEvent({ k: 'callClosed', callId: 1, disposition: 'handled' }, port);
    expect(log).toEqual([]);
    expect(m.localIdOf(77)).toBe(-1);
  });
  it('tracks remote units: join, status, partner, leave; never self', () => {
    const { m, port, log, units } = start();
    m.applyEvent({ k: 'joined', unit: unit('N3') }, port);
    m.applyEvent({ k: 'joined', unit: unit('N1') }, port); // self
    m.applyEvent({ k: 'unitStatus', callsign: 'N3', status: 'enRoute', callId: 4 }, port);
    m.applyEvent({ k: 'unitStatus', callsign: 'N1', status: 'busy', callId: null }, port); // self
    m.applyEvent({ k: 'unitStatus', callsign: 'N9', status: 'busy', callId: null }, port); // unknown
    m.applyEvent({ k: 'partnered', a: 'N1', b: 'N2' }, port);
    m.applyEvent({ k: 'host', callsign: 'N2' }, port);
    m.applyEvent({ k: 'left', callsign: 'N3' }, port);
    expect(log).toEqual([
      ['upsertUnit', 'N3', 'available', null, 0, 0, null],
      ['upsertUnit', 'N3', 'enRoute', 4, 0, 0, null],
      ['upsertUnit', 'N2', 'available', null, 0, 0, 'N1'],
      ['removeUnit', 'N3'],
    ]);
    expect(units.has('N1')).toBe(false);
  });
  it('keeps a remote unit callId in step with assignments and closure', () => {
    const { m, port, log } = start();
    m.applyEvent({ k: 'callCreated', call: call(1) }, port);
    m.applyEvent({ k: 'callAssigned', callId: 1, callsign: 'N2', primary: 'N2' }, port);
    m.applyEvent({ k: 'unitStatus', callsign: 'N2', status: 'enRoute', callId: 1 }, port);
    m.applyEvent({ k: 'callClosed', callId: 1, disposition: 'handled' }, port);
    m.applyEvent({ k: 'unitStatus', callsign: 'N2', status: 'available', callId: null }, port);
    const upserts = log.filter((l) => l[0] === 'upsertUnit');
    expect(upserts).toEqual([
      ['upsertUnit', 'N2', 'enRoute', 1, 0, 0, null],
      ['upsertUnit', 'N2', 'available', null, 0, 0, null],
    ]);
  });
  it('delivers only orders addressed to self; radio always', () => {
    const { m, port, log } = start();
    m.applyEvent({ k: 'order', to: 'N2', from: 'S1', order: 'code4', callId: null, text: '' }, port);
    m.applyEvent({ k: 'order', to: 'N1', from: 'S1', order: 'respond', callId: 3, text: 'go' }, port);
    m.applyEvent({ k: 'radio', from: 'N2', channel: 'tac', text: 'copy' }, port);
    expect(log).toEqual([['order', 'N1', 'respond', 3], ['radio', 'N2', 'tac', 'copy']]);
  });
});

describe('CoopMirror presence', () => {
  it('moves known remote units, ignores self and unknown callsigns', () => {
    const f = fakePort();
    const m = new CoopMirror('N1');
    m.applySnapshot(snap([unit('N1'), unit('N2')], []), f.port);
    f.log.length = 0;
    m.applyPresence(
      [
        { callsign: 'N1', x: 9, z: 9, heading: 0, speed: 0, driving: false },
        { callsign: 'N2', x: 50, z: -20, heading: 1, speed: 12, driving: true },
        { callsign: 'N7', x: 1, z: 1, heading: 0, speed: 0, driving: false },
      ],
      f.port,
    );
    expect(f.log).toEqual([['upsertUnit', 'N2', 'available', null, 50, -20, null]]);
    expect(f.units.get('N2')).toMatchObject({ heading: 1, speed: 12, driving: true });
  });
});
