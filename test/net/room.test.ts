import { describe, expect, it } from 'vitest';
import { LIMITS, NET_UNIT_STATUSES, PROTOCOL_VERSION } from '../../src/net/protocol';
import type { ClientMsg, NetRole, NetUnitStatus, RoomEvent } from '../../src/net/protocol';
import { canTransition, RateLimiter, Room } from '../../src/net/room';
import type { HandleResult } from '../../src/net/room';

type Hello = Extract<ClientMsg, { t: 'hello' }>;
const hello = (role: NetRole, name = 'x', extra: Partial<Hello> = {}): Hello => ({
  t: 'hello', v: PROTOCOL_VERSION, name, role, room: 'r', ...extra,
});

interface Fx {
  room: Room;
  now: number;
  /** Send a message from a member id; advances the clock 100 ms first unless `at` is given. */
  send: (id: string, msg: ClientMsg, at?: number) => HandleResult;
  /** Dispatcher creates a call and returns its net id. */
  newCall: (priority?: 1 | 2 | 3 | 4) => number;
}

/** Room with patrol N1 (host) + N2, DISPATCH and S1. */
function fixture(opts: { dispatcher?: boolean; supervisor?: boolean; patrol2?: boolean } = {}): Fx {
  const room = new Room({ name: 'r', seed: 99 });
  const fx: Fx = {
    room,
    now: 1000,
    send: (id, msg, at) => {
      fx.now = at ?? fx.now + 100;
      return room.handle(id, msg, fx.now);
    },
    newCall: (priority = 3) => {
      const r = fx.send('d', callCreate({ priority }));
      expect(r.reject).toBeNull();
      const ev = r.events[0];
      if (ev?.k !== 'callCreated') throw new Error('no call');
      return ev.call.id;
    },
  };
  room.join('p1', hello('patrol', 'One'), 0);
  if (opts.patrol2 !== false) room.join('p2', hello('patrol', 'Two'), 0);
  if (opts.dispatcher !== false) room.join('d', hello('dispatcher', 'Disp'), 0);
  if (opts.supervisor !== false) room.join('s', hello('supervisor', 'Sup'), 0);
  return fx;
}

let refN = 0;
function callCreate(over: Partial<Extract<ClientMsg, { t: 'callCreate' }>> = {}): Extract<ClientMsg, { t: 'callCreate' }> {
  return {
    t: 'callCreate', ref: `ref${refN++}`, typeId: 'noise', label: 'Noise', priority: 3, x: 0, z: 0,
    address: '1 Main', narrative: 'loud', origin: 'dispatcher', ...over,
  };
}
const presence = (x: number, z: number): ClientMsg => ({ t: 'presence', x, z, heading: 0, speed: 5, driving: true });
const status = (s: NetUnitStatus, callId: number | null = null): ClientMsg => ({ t: 'unitStatus', status: s, callId });
const assign = (callId: number, unit: string): ClientMsg => ({ t: 'callAssign', callId, unit });
const unassign = (callId: number, unit: string): ClientMsg => ({ t: 'callUnassign', callId, unit });
const note = (callId: number, text = 'note'): ClientMsg => ({ t: 'callNote', callId, text });
const close = (callId: number): ClientMsg => ({ t: 'callClose', callId, disposition: 'handled' });
const order = (unit: string, o: Extract<ClientMsg, { t: 'order' }>['order'], callId: number | null = null): ClientMsg => ({
  t: 'order', unit, order: o, callId, text: '',
});

function allowed(r: HandleResult): void {
  expect(r.reject).toBeNull();
}
function denied(r: HandleResult, code: string): void {
  expect(r.reject?.code).toBe(code);
  expect(r.events).toEqual([]);
}
/** Assert that running `fn` on a rejected message changed neither the revision nor the snapshot. */
function unchanged(fx: Fx, fn: () => HandleResult, code: string): void {
  const rev = fx.room.rev;
  const snap = JSON.stringify(fx.room.snapshot);
  denied(fn(), code);
  expect(fx.room.rev).toBe(rev);
  expect(JSON.stringify(fx.room.snapshot)).toBe(snap);
}

describe('RateLimiter', () => {
  it('allows the burst then rejects and refills over time', () => {
    const rl = new RateLimiter(40, 20);
    for (let i = 0; i < 40; i++) expect(rl.take(5)).toBe(true);
    expect(rl.take(5)).toBe(false);
    expect(rl.take(30)).toBe(false); // 25 ms = 0.5 token
    expect(rl.take(55)).toBe(true); // 50 ms = 1 token
    expect(rl.take(55)).toBe(false);
    expect(rl.take(10000)).toBe(true);
    for (let i = 0; i < 39; i++) expect(rl.take(10000)).toBe(true);
    expect(rl.take(10000)).toBe(false); // capped at the capacity
  });
  it('ignores a clock that goes backwards', () => {
    const rl = new RateLimiter(2, 1);
    expect(rl.take(1000)).toBe(true);
    expect(rl.take(500)).toBe(true);
    expect(rl.take(400)).toBe(false);
  });
});

describe('canTransition', () => {
  const allowedMap: Record<NetUnitStatus, NetUnitStatus[]> = {
    available: ['enRoute', 'onScene', 'busy', 'outOfService'],
    enRoute: ['onScene', 'available', 'busy', 'outOfService'],
    onScene: ['busy', 'available', 'transporting', 'enRoute', 'outOfService'],
    busy: ['available', 'onScene', 'enRoute', 'outOfService'],
    transporting: ['available', 'onScene', 'outOfService'],
    outOfService: ['available'],
  };
  it('matches the table for every pair', () => {
    for (const from of NET_UNIT_STATUSES) {
      for (const to of NET_UNIT_STATUSES) {
        const expected = from === to || allowedMap[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });
  it('any -> outOfService, outOfService -> available only', () => {
    for (const from of NET_UNIT_STATUSES) expect(canTransition(from, 'outOfService')).toBe(true);
    for (const to of NET_UNIT_STATUSES) expect(canTransition('outOfService', to)).toBe(to === 'available' || to === 'outOfService');
  });
});

describe('join and leave', () => {
  it('assigns callsigns, first member is host and fixes the seed', () => {
    const room = new Room({ name: 'r', seed: 1 });
    const a = room.join('a', hello('patrol', 'A', { seed: 777 }), 0);
    expect(a.callsign).toBe('N1');
    expect(a.reject).toBeNull();
    expect(room.host).toBe('N1');
    expect(room.snapshot.seed).toBe(777);
    expect(a.events).toHaveLength(1);
    const w = a.direct[0];
    expect(w).toMatchObject({ t: 'welcome', callsign: 'N1', role: 'patrol', v: PROTOCOL_VERSION });
    const b = room.join('b', hello('patrol', 'B', { seed: 5 }), 0);
    expect(b.callsign).toBe('N2');
    expect(room.snapshot.seed).toBe(777);
    expect(room.join('c', hello('dispatcher'), 0).callsign).toBe('DISPATCH');
    expect(room.join('d', hello('supervisor'), 0).callsign).toBe('S1');
    expect(room.size).toBe(4);
    expect(room.rev).toBe(4);
    expect(room.snapshot.units.map((u) => u.callsign)).toEqual(['N1', 'N2', 'DISPATCH', 'S1']);
  });
  it('uses the room seed when the hello has none', () => {
    const room = new Room({ name: 'r', seed: 42 });
    room.join('a', hello('patrol'), 0);
    expect(room.snapshot.seed).toBe(42);
  });
  it('the welcome carries a snapshot that already includes the joiner', () => {
    const room = new Room({ name: 'r', seed: 1 });
    room.join('a', hello('patrol'), 0);
    const j = room.join('b', hello('supervisor'), 0);
    const w = j.direct[0];
    expect(w?.t).toBe('welcome');
    if (w?.t === 'welcome') {
      expect(w.snapshot.units.map((u) => u.callsign)).toEqual(['N1', 'S1']);
      expect(w.snapshot.rev).toBe(room.rev);
    }
  });
  it('role limits reject with full and leave the room unchanged', () => {
    const room = new Room({ name: 'r', seed: 1 });
    for (let i = 0; i < 4; i++) expect(room.join(`p${i}`, hello('patrol'), 0).callsign).toBe(`N${i + 1}`);
    const rev = room.rev;
    const fifth = room.join('p5', hello('patrol'), 0);
    expect(fifth.reject?.code).toBe('full');
    expect(fifth.callsign).toBeNull();
    expect(fifth.direct).toEqual([]);
    expect(room.join('d1', hello('dispatcher'), 0).callsign).toBe('DISPATCH');
    expect(room.join('d2', hello('dispatcher'), 0).reject?.code).toBe('full');
    expect(room.join('s1', hello('supervisor'), 0).callsign).toBe('S1');
    expect(room.join('s2', hello('supervisor'), 0).reject?.code).toBe('full');
    expect(room.size).toBe(6);
    expect(room.rev).toBe(rev + 2);
  });
  it('maxMembers caps the room', () => {
    const room = new Room({ name: 'r', seed: 1, maxMembers: 2 });
    room.join('a', hello('patrol'), 0);
    room.join('b', hello('patrol'), 0);
    expect(room.join('c', hello('supervisor'), 0).reject?.code).toBe('full');
  });
  it('rejects a protocol version mismatch', () => {
    const room = new Room({ name: 'r', seed: 1 });
    const r = room.join('a', { ...hello('patrol'), v: PROTOCOL_VERSION + 1 }, 0);
    expect(r.reject?.code).toBe('version');
    expect(r.callsign).toBeNull();
    expect(room.size).toBe(0);
    expect(room.rev).toBe(0);
  });
  it('rejects bad hello values and a second join of the same member', () => {
    const room = new Room({ name: 'r', seed: 1 });
    expect(room.join('a', { ...hello('patrol'), name: '' }, 0).reject?.code).toBe('invalidValue');
    expect(room.join('a', { ...hello('patrol'), role: 'boss' as NetRole }, 0).reject?.code).toBe('invalidValue');
    room.join('a', hello('patrol'), 0);
    expect(room.join('a', hello('patrol'), 0).reject?.code).toBe('illegalState');
    expect(room.size).toBe(1);
  });
  it('reuses the lowest free callsign after someone leaves', () => {
    const room = new Room({ name: 'r', seed: 1 });
    room.join('a', hello('patrol'), 0);
    room.join('b', hello('patrol'), 0);
    room.join('c', hello('patrol'), 0);
    room.leave('b');
    expect(room.join('d', hello('patrol'), 0).callsign).toBe('N2');
  });
  it('a second hello through handle is illegal', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('p1', hello('patrol')), 'illegalState');
  });
  it('unknown members are not found', () => {
    const fx = fixture();
    denied(fx.room.handle('ghost', { t: 'ping', n: 1 }, 5), 'notFound');
    expect(fx.room.leave('ghost')).toEqual([]);
  });
  it('host falls back to the oldest patrol on leave', () => {
    const room = new Room({ name: 'r', seed: 1 });
    room.join('p1', hello('patrol'), 0);
    room.join('d', hello('dispatcher'), 0);
    room.join('p2', hello('patrol'), 0);
    expect(room.host).toBe('N1');
    expect(room.leave('d')).toEqual([{ k: 'left', callsign: 'DISPATCH' }]);
    expect(room.host).toBe('N1');
    const ev2 = room.leave('p1');
    expect(ev2).toEqual([{ k: 'left', callsign: 'N1' }, { k: 'host', callsign: 'N2' }]);
    // no patrol left: the oldest remaining member hosts
    room.join('s', hello('supervisor'), 0);
    expect(room.leave('p2')).toEqual([{ k: 'left', callsign: 'N2' }, { k: 'host', callsign: 'S1' }]);
    expect(room.leave('s')).toEqual([{ k: 'left', callsign: 'S1' }]);
    expect(room.host).toBe('');
    expect(room.size).toBe(0);
  });
  it('a patrol joining a room hosted by a supervisor takes the host (only a patrol host generates calls)', () => {
    const room = new Room({ name: 'r', seed: 99 });
    room.join('s', hello('supervisor', 'Sup'), 0);
    expect(room.host).toBe('S1');
    const joined = room.join('p1', hello('patrol', 'One'), 0);
    expect(joined.callsign).toBe('N1');
    expect(joined.events.map((e) => e.k)).toEqual(['joined', 'host']);
    expect(room.host).toBe('N1');
    expect(joined.direct[0]).toMatchObject({ t: 'welcome', snapshot: { host: 'N1' } });
    expect(room.handle('p1', callCreate({ origin: 'generator' }), 5000).reject).toBeNull();
    // A second patrol does not take it over, and neither does a dispatcher.
    expect(room.join('p2', hello('patrol', 'Two'), 0).events.map((e) => e.k)).toEqual(['joined']);
    expect(room.host).toBe('N1');
  });
  it('a dispatcher hosts only until the first patrol joins', () => {
    const room = new Room({ name: 'r', seed: 99 });
    room.join('d', hello('dispatcher', 'Disp'), 0);
    expect(room.host).toBe('DISPATCH');
    room.join('p1', hello('patrol', 'One'), 0);
    expect(room.host).toBe('N1');
  });
  it('a non-host leaving emits only left', () => {
    const fx = fixture();
    expect(fx.room.leave('p2')).toEqual([{ k: 'left', callsign: 'N2' }]);
    expect(fx.room.host).toBe('N1');
  });
  it('leave unassigns the unit from its calls, promotes the primary and reverts an empty call to pending', () => {
    const fx = fixture();
    const a = fx.newCall();
    const b = fx.newCall();
    fx.send('d', assign(a, 'N1'));
    fx.send('d', assign(a, 'N2'));
    fx.send('d', assign(b, 'S1'));
    const rev = fx.room.rev;
    const ev = fx.room.leave('p1');
    expect(ev.map((e) => e.k)).toEqual(['callUnassigned', 'left', 'host']);
    expect(fx.room.rev).toBe(rev + 3);
    const calls = fx.room.snapshot.calls;
    expect(calls.find((c) => c.id === a)).toMatchObject({ units: ['N2'], primary: 'N2', status: 'active' });
    fx.room.leave('s');
    expect(fx.room.snapshot.calls.find((c) => c.id === b)).toMatchObject({ units: [], primary: null, status: 'pending' });
  });
  it('leave clears pending partner wishes and existing partnerships', () => {
    const fx = fixture();
    fx.send('p1', { t: 'partner', unit: 'N2' });
    fx.send('p2', { t: 'partner', unit: 'N1' });
    expect(fx.room.snapshot.units.find((u) => u.callsign === 'N1')?.partner).toBe('N2');
    fx.room.leave('p2');
    expect(fx.room.snapshot.units.find((u) => u.callsign === 'N1')?.partner).toBeNull();
  });
  it('stamp numbers events with the revision they produced', () => {
    const fx = fixture();
    const a = fx.newCall();
    const r = fx.send('d', assign(a, 'N1'));
    const msgs = fx.room.stamp(r.events);
    expect(msgs.map((m) => (m.t === 'event' ? m.rev : -1))).toEqual([fx.room.rev]);
    const l = fx.room.leave('p1');
    const stamped = fx.room.stamp(l);
    expect(stamped.map((m) => (m.t === 'event' ? m.rev : -1))).toEqual(
      l.map((_, i) => fx.room.rev - l.length + 1 + i),
    );
  });
});

describe('rate limits', () => {
  it('rejects the 41st message in one millisecond and refills over time', () => {
    const fx = fixture();
    for (let i = 0; i < 40; i++) allowed(fx.send('p1', { t: 'ping', n: i }, 5000));
    const r = fx.send('p1', { t: 'ping', n: 41 }, 5000);
    expect(r.reject?.code).toBe('rate');
    expect(fx.send('p1', { t: 'ping', n: 42 }, 5049).reject?.code).toBe('rate');
    allowed(fx.send('p1', { t: 'ping', n: 43 }, 5051));
    allowed(fx.send('p1', { t: 'ping', n: 44 }, 8000));
  });
  it('is per member', () => {
    const fx = fixture();
    for (let i = 0; i < 41; i++) fx.send('p1', { t: 'ping', n: i }, 5000);
    allowed(fx.send('p2', { t: 'ping', n: 1 }, 5000));
  });
  it('presence is limited to one per 80 ms', () => {
    const fx = fixture();
    allowed(fx.send('p1', presence(0, 0), 5000));
    unchanged(fx, () => fx.send('p1', presence(1, 0), 5079), 'rate');
    allowed(fx.send('p1', presence(1, 0), 5080));
  });
  it('pong replies to ping', () => {
    const fx = fixture();
    const r = fx.send('p1', { t: 'ping', n: 9 });
    expect(r.direct).toEqual([{ t: 'pong', n: 9 }]);
    expect(r.events).toEqual([]);
  });
});

describe('validation inside the room', () => {
  it('rechecks value rules for messages that skipped the parser', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('d', callCreate({ x: 9999 })), 'invalidValue');
    unchanged(fx, () => fx.send('d', callCreate({ typeId: 'bad id' })), 'invalidValue');
    unchanged(fx, () => fx.send('d', callCreate({ label: 'x'.repeat(100) })), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'presence', x: NaN, z: 0, heading: 0, speed: 0, driving: false }), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'presence', x: 0, z: 0, heading: Infinity, speed: 0, driving: false }), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'presence', x: 0, z: 0, heading: 0, speed: 500, driving: false }), 'invalidValue');
    unchanged(fx, () => fx.send('d', { t: 'callClose', callId: 1, disposition: 'bogus' as never }), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'radio', channel: 'main', text: 'a\nb' }), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'nope' } as unknown as ClientMsg), 'unknownType');
    unchanged(fx, () => fx.send('p1', { t: 'ping' } as unknown as ClientMsg), 'malformed');
  });
});

describe('presence', () => {
  it('stores own position for patrol and supervisor, forbidden for the dispatcher', () => {
    const fx = fixture();
    const rev = fx.room.rev;
    allowed(fx.send('p1', presence(10, 20)));
    allowed(fx.send('s', presence(-5, 5)));
    expect(fx.room.rev).toBe(rev); // presence emits no events
    unchanged(fx, () => fx.send('d', presence(0, 0)), 'forbidden');
    const p = fx.room.presence();
    expect(p.t).toBe('presence');
    if (p.t === 'presence') {
      expect(p.units.map((u) => u.callsign)).toEqual(['N1', 'S1']);
      expect(p.units[0]).toMatchObject({ x: 10, z: 20, speed: 5, driving: true });
    }
  });
  it('rejects a teleport but accepts plausible movement', () => {
    const fx = fixture();
    allowed(fx.send('p1', presence(0, 0), 10000));
    unchanged(fx, () => fx.send('p1', presence(3000, 0), 10100), 'invalidValue');
    allowed(fx.send('p1', presence(8, 0), 10200)); // 8 m in 200 ms: under the 50 m floor
    allowed(fx.send('p1', presence(80, 0), 11200)); // 72 m in 1 s: under 90 m/s
    unchanged(fx, () => fx.send('p1', presence(480, 0), 11300), 'invalidValue'); // 400 m in 100 ms
    allowed(fx.send('p1', presence(600, 0), 20000)); // 520 m, but after an 8.8 s gap
    expect(fx.room.presence()).toMatchObject({ units: [{ callsign: 'N1', x: 600, z: 0 }] });
  });
  it('rejects a sustained speed over the limit made of small steps (45 m every 100 ms is 450 m/s)', () => {
    const fx = fixture();
    allowed(fx.send('p1', presence(0, 0), 20000));
    let rejected = 0;
    for (let i = 1; i <= 20; i++) {
      const r = fx.send('p1', presence(45 * i, 0), 20000 + 100 * i);
      if (r.reject !== null) rejected++;
    }
    expect(rejected).toBeGreaterThan(15);
    // The unit never got far from where it was last accepted.
    const p = fx.room.presence();
    expect(p.t === 'presence' && (p.units.find((u) => u.callsign === 'N1')?.x ?? 0)).toBeLessThan(120);
  });
  it('accepts a legal 80 m/s run and the jitter of a single step', () => {
    const fx = fixture();
    allowed(fx.send('p1', presence(0, 0), 30000));
    for (let i = 1; i <= 20; i++) allowed(fx.send('p1', presence(8 * i, 0), 30000 + 100 * i)); // 80 m/s
    allowed(fx.send('p1', presence(160 + 12, 0), 32100)); // 12 m in 100 ms: within the slack
  });
  it('rejects positions outside the world', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('p1', presence(LIMITS.worldHalf + 1, 0)), 'invalidValue');
  });
});

describe('permission matrix', () => {
  it('presence / unitStatus: own unit for patrol and supervisor, forbidden for the dispatcher', () => {
    const fx = fixture();
    allowed(fx.send('p1', presence(0, 0)));
    allowed(fx.send('s', presence(0, 0)));
    denied(fx.send('d', presence(0, 0)), 'forbidden');
    allowed(fx.send('p1', status('busy')));
    allowed(fx.send('s', status('busy')));
    denied(fx.send('d', status('busy')), 'forbidden');
  });

  it('callCreate: patrol officer calls within 150 m of own presence', () => {
    const fx = fixture();
    const noPos = fx.send('p1', callCreate({ origin: 'officer' }));
    denied(noPos, 'illegalState');
    allowed(fx.send('p1', presence(100, 100)));
    const r = fx.send('p1', callCreate({ origin: 'officer', x: 200, z: 100 }));
    allowed(r);
    expect(r.events[0]).toMatchObject({ k: 'callCreated', call: { origin: 'officer', createdBy: 'N1', status: 'pending' } });
    unchanged(fx, () => fx.send('p1', callCreate({ origin: 'officer', x: 100 + 151, z: 100 })), 'invalidValue');
  });
  it('callCreate: patrol cannot use the dispatcher origin; dispatcher / supervisor only dispatcher origin', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('p1', callCreate({ origin: 'dispatcher' })), 'forbidden');
    allowed(fx.send('d', callCreate({ origin: 'dispatcher' })));
    allowed(fx.send('s', callCreate({ origin: 'dispatcher' })));
    for (const id of ['d', 's']) {
      unchanged(fx, () => fx.send(id, callCreate({ origin: 'officer' })), 'forbidden');
      unchanged(fx, () => fx.send(id, callCreate({ origin: 'generator' })), 'forbidden');
    }
  });
  it('callCreate: generator calls only from the host, with no dispatcher, one per 10 s', () => {
    const fx = fixture();
    // a dispatcher is present
    unchanged(fx, () => fx.send('p1', callCreate({ origin: 'generator' })), 'forbidden');
    fx.room.leave('d');
    unchanged(fx, () => fx.send('p2', callCreate({ origin: 'generator' })), 'forbidden'); // not the host
    allowed(fx.send('p1', callCreate({ origin: 'generator' }), 20000));
    unchanged(fx, () => fx.send('p1', callCreate({ origin: 'generator' }), 29000), 'rate');
    allowed(fx.send('p1', callCreate({ origin: 'generator' }), 30000));
  });

  it('callAssign / callUnassign: patrol only themselves, dispatcher and supervisor any unit but DISPATCH', () => {
    const fx = fixture();
    const c = fx.newCall();
    unchanged(fx, () => fx.send('p1', assign(c, 'N2')), 'forbidden');
    unchanged(fx, () => fx.send('p1', assign(c, 'DISPATCH')), 'forbidden');
    allowed(fx.send('p1', assign(c, 'N1')));
    allowed(fx.send('d', assign(c, 'N2')));
    unchanged(fx, () => fx.send('d', assign(c, 'DISPATCH')), 'forbidden');
    unchanged(fx, () => fx.send('s', assign(c, 'DISPATCH')), 'forbidden');
    allowed(fx.send('s', assign(c, 'S1')));
    unchanged(fx, () => fx.send('p2', unassign(c, 'N1')), 'forbidden');
    allowed(fx.send('p2', unassign(c, 'N2')));
    allowed(fx.send('d', unassign(c, 'N1')));
    allowed(fx.send('s', unassign(c, 'S1')));
    unchanged(fx, () => fx.send('d', assign(c, 'N9')), 'notFound');
  });

  it('callPriority: forbidden for patrol, allowed for dispatcher and supervisor', () => {
    const fx = fixture();
    const c = fx.newCall(3);
    fx.send('d', assign(c, 'N1'));
    unchanged(fx, () => fx.send('p1', { t: 'callPriority', callId: c, priority: 1 }), 'forbidden');
    const r = fx.send('d', { t: 'callPriority', callId: c, priority: 1 });
    expect(r.events).toEqual([{ k: 'callPriority', callId: c, priority: 1 }]);
    allowed(fx.send('s', { t: 'callPriority', callId: c, priority: 2 }));
    expect(fx.room.snapshot.calls[0]?.priority).toBe(2);
  });

  it('callNote: patrol only on a call it is assigned to', () => {
    const fx = fixture();
    const c = fx.newCall();
    fx.send('d', assign(c, 'N1'));
    unchanged(fx, () => fx.send('p2', note(c)), 'forbidden');
    const r = fx.send('p1', note(c, 'on scene'));
    expect(r.events[0]).toMatchObject({ k: 'callNote', callId: c, note: { by: 'N1', text: 'on scene' } });
    allowed(fx.send('d', note(c)));
    allowed(fx.send('s', note(c)));
    expect(fx.room.snapshot.calls[0]?.notes).toHaveLength(3);
  });

  it('callClose: patrol primary or any assigned unit; dispatcher and supervisor always', () => {
    const fx = fixture();
    const a = fx.newCall();
    fx.send('d', assign(a, 'N1'));
    fx.send('d', assign(a, 'S1'));
    unchanged(fx, () => fx.send('p2', close(a)), 'forbidden');
    allowed(fx.send('s', close(a)));
    const b = fx.newCall();
    fx.send('d', assign(b, 'N1'));
    fx.send('d', assign(b, 'N2'));
    allowed(fx.send('p2', close(b))); // assigned, not primary
    const c = fx.newCall();
    fx.send('d', assign(c, 'N1'));
    allowed(fx.send('p1', close(c))); // primary
    const d = fx.newCall();
    allowed(fx.send('d', close(d)));
    const e = fx.newCall();
    unchanged(fx, () => fx.send('p1', close(e)), 'forbidden'); // unassigned patrol
  });

  it('order: forbidden for patrol, respond only for the dispatcher, everything for the supervisor', () => {
    const fx = fixture();
    const c = fx.newCall();
    unchanged(fx, () => fx.send('p1', order('N2', 'respond', c)), 'forbidden');
    const r = fx.send('d', order('N1', 'respond', c));
    expect(r.events).toEqual([{ k: 'order', to: 'N1', from: 'DISPATCH', order: 'respond', callId: c, text: '' }]);
    for (const k of ['returnToStation', 'terminatePursuit', 'code4', 'backup'] as const) {
      unchanged(fx, () => fx.send('d', order('N1', k)), 'forbidden');
      allowed(fx.send('s', order('N1', k)));
    }
    allowed(fx.send('s', order('N1', 'respond', c)));
  });
  it('order: target and call must exist, respond needs a call, nobody orders the dispatcher', () => {
    const fx = fixture();
    const c = fx.newCall();
    unchanged(fx, () => fx.send('s', order('N9', 'code4')), 'notFound');
    unchanged(fx, () => fx.send('s', order('N1', 'backup', 999)), 'notFound');
    unchanged(fx, () => fx.send('s', order('N1', 'respond')), 'invalidValue');
    unchanged(fx, () => fx.send('s', order('DISPATCH', 'code4')), 'forbidden');
    fx.send('d', close(c));
    unchanged(fx, () => fx.send('s', order('N1', 'respond', c)), 'illegalState');
  });

  it('partner: patrol to patrol only; pairs when both asked each other', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('d', { t: 'partner', unit: 'N1' }), 'forbidden');
    unchanged(fx, () => fx.send('s', { t: 'partner', unit: 'N1' }), 'forbidden');
    unchanged(fx, () => fx.send('p1', { t: 'partner', unit: 'S1' }), 'forbidden');
    unchanged(fx, () => fx.send('p1', { t: 'partner', unit: 'DISPATCH' }), 'forbidden');
    unchanged(fx, () => fx.send('p1', { t: 'partner', unit: 'N1' }), 'invalidValue');
    unchanged(fx, () => fx.send('p1', { t: 'partner', unit: 'N7' }), 'notFound');
    const rev = fx.room.rev;
    const first = fx.send('p1', { t: 'partner', unit: 'N2' });
    expect(first.events).toEqual([]);
    expect(fx.room.rev).toBe(rev);
    const second = fx.send('p2', { t: 'partner', unit: 'N1' });
    expect(second.events).toEqual([{ k: 'partnered', a: 'N1', b: 'N2' }]);
    const units = fx.room.snapshot.units;
    expect(units.find((u) => u.callsign === 'N1')?.partner).toBe('N2');
    expect(units.find((u) => u.callsign === 'N2')?.partner).toBe('N1');
    unchanged(fx, () => fx.send('p1', { t: 'partner', unit: 'N2' }), 'illegalState');
  });
  it('partner: a pending wish does not pair with a different request', () => {
    const fx = fixture();
    fx.room.join('p3', hello('patrol'), 0);
    fx.send('p1', { t: 'partner', unit: 'N2' });
    const r = fx.send('p3', { t: 'partner', unit: 'N1' });
    expect(r.events).toEqual([]);
    expect(fx.room.snapshot.units.every((u) => u.partner === null)).toBe(true);
  });

  it('radio: every role', () => {
    const fx = fixture();
    for (const id of ['p1', 'd', 's']) {
      const r = fx.send(id, { t: 'radio', channel: 'tac', text: 'hello' });
      expect(r.events[0]).toMatchObject({ k: 'radio', channel: 'tac', text: 'hello' });
    }
  });
});

describe('state rules', () => {
  it('calls must exist and closed calls are immutable', () => {
    const fx = fixture();
    unchanged(fx, () => fx.send('d', assign(99, 'N1')), 'notFound');
    unchanged(fx, () => fx.send('d', unassign(99, 'N1')), 'notFound');
    unchanged(fx, () => fx.send('d', { t: 'callPriority', callId: 99, priority: 1 }), 'notFound');
    unchanged(fx, () => fx.send('d', note(99)), 'notFound');
    unchanged(fx, () => fx.send('d', close(99)), 'notFound');
    unchanged(fx, () => fx.send('p1', status('enRoute', 99)), 'notFound');
    const c = fx.newCall();
    fx.send('d', assign(c, 'N1'));
    allowed(fx.send('d', close(c)));
    unchanged(fx, () => fx.send('d', assign(c, 'N2')), 'illegalState');
    unchanged(fx, () => fx.send('d', unassign(c, 'N1')), 'illegalState');
    unchanged(fx, () => fx.send('d', { t: 'callPriority', callId: c, priority: 1 }), 'illegalState');
    unchanged(fx, () => fx.send('d', note(c)), 'illegalState');
    unchanged(fx, () => fx.send('p1', note(c)), 'illegalState');
    unchanged(fx, () => fx.send('d', close(c)), 'illegalState');
    unchanged(fx, () => fx.send('p1', status('enRoute', c)), 'illegalState');
  });
  it('assigning twice or unassigning a unit that is not assigned is illegal', () => {
    const fx = fixture();
    const c = fx.newCall();
    allowed(fx.send('d', assign(c, 'N1')));
    unchanged(fx, () => fx.send('d', assign(c, 'N1')), 'illegalState');
    unchanged(fx, () => fx.send('d', unassign(c, 'N2')), 'illegalState');
  });
  it('first assignment makes the unit primary and the call active; later units are not primary', () => {
    const fx = fixture();
    const c = fx.newCall();
    expect(fx.room.snapshot.calls[0]?.status).toBe('pending');
    expect(fx.send('d', assign(c, 'N2')).events).toEqual([{ k: 'callAssigned', callId: c, callsign: 'N2', primary: 'N2' }]);
    expect(fx.send('d', assign(c, 'N1')).events).toEqual([{ k: 'callAssigned', callId: c, callsign: 'N1', primary: 'N2' }]);
    expect(fx.room.snapshot.calls[0]).toMatchObject({ status: 'active', primary: 'N2', units: ['N2', 'N1'] });
    // removing the primary promotes the next unit
    fx.send('d', unassign(c, 'N2'));
    expect(fx.room.snapshot.calls[0]).toMatchObject({ primary: 'N1', units: ['N1'], status: 'active' });
    fx.send('d', unassign(c, 'N1'));
    expect(fx.room.snapshot.calls[0]).toMatchObject({ primary: null, units: [], status: 'pending' });
  });
  it('assigning a unit to a second call first unassigns it from the first', () => {
    const fx = fixture();
    const a = fx.newCall();
    const b = fx.newCall();
    fx.send('d', assign(a, 'N1'));
    fx.send('p1', status('enRoute', a));
    const r = fx.send('d', assign(b, 'N1'));
    expect(r.events).toEqual([
      { k: 'callUnassigned', callId: a, callsign: 'N1' },
      { k: 'unitStatus', callsign: 'N1', status: 'available', callId: null },
      { k: 'callAssigned', callId: b, callsign: 'N1', primary: 'N1' },
    ]);
    const snap = fx.room.snapshot;
    expect(snap.calls.find((c) => c.id === a)).toMatchObject({ units: [], status: 'pending' });
    expect(snap.calls.find((c) => c.id === b)).toMatchObject({ units: ['N1'], primary: 'N1' });
    expect(snap.units.find((u) => u.callsign === 'N1')).toMatchObject({ callId: b, status: 'available' });
  });
  it('unassigning an enRoute unit makes it available', () => {
    const fx = fixture();
    const c = fx.newCall();
    fx.send('d', assign(c, 'N1'));
    fx.send('p1', status('enRoute', c));
    const r = fx.send('d', unassign(c, 'N1'));
    expect(r.events.map((e) => e.k)).toEqual(['callUnassigned', 'unitStatus']);
    expect(fx.room.snapshot.units.find((u) => u.callsign === 'N1')).toMatchObject({ status: 'available', callId: null });
  });
  it('closing a call releases its units and records the disposition', () => {
    const fx = fixture();
    const c = fx.newCall();
    fx.send('d', assign(c, 'N1'));
    fx.send('d', assign(c, 'N2'));
    fx.send('p1', status('onScene', c));
    fx.send('p2', status('busy', c));
    const r = fx.send('d', close(c));
    expect(r.events).toEqual([
      { k: 'callClosed', callId: c, disposition: 'handled' },
      { k: 'unitStatus', callsign: 'N1', status: 'available', callId: null },
      { k: 'unitStatus', callsign: 'N2', status: 'busy', callId: null },
    ]);
    const snap = fx.room.snapshot;
    expect(snap.calls[0]).toMatchObject({ status: 'closed', disposition: 'handled' });
    expect(snap.units.find((u) => u.callsign === 'N2')).toMatchObject({ status: 'busy', callId: null });
  });
  it('limits open calls', () => {
    const fx = fixture();
    for (let i = 0; i < LIMITS.maxOpenCalls; i++) fx.newCall();
    unchanged(fx, () => fx.send('d', callCreate()), 'illegalState');
    fx.send('d', close(1));
    allowed(fx.send('d', callCreate()));
  });
  it('limits notes per call', () => {
    const fx = fixture();
    const c = fx.newCall();
    for (let i = 0; i < LIMITS.notesPerCall; i++) allowed(fx.send('d', note(c, `n${i}`)));
    unchanged(fx, () => fx.send('d', note(c)), 'illegalState');
  });
  it('unit status follows the transition table and call rules', () => {
    const fx = fixture();
    const c = fx.newCall();
    unchanged(fx, () => fx.send('p1', status('enRoute')), 'illegalState'); // needs a call
    unchanged(fx, () => fx.send('p1', status('onScene')), 'illegalState');
    unchanged(fx, () => fx.send('p1', status('transporting')), 'illegalState'); // available -> transporting
    unchanged(fx, () => fx.send('p1', status('enRoute', c)), 'illegalState'); // not assigned
    fx.send('d', assign(c, 'N1'));
    unchanged(fx, () => fx.send('p2', status('enRoute', c)), 'illegalState'); // other unit not assigned
    const en = fx.send('p1', status('enRoute', c));
    expect(en.events).toEqual([{ k: 'unitStatus', callsign: 'N1', status: 'enRoute', callId: c }]);
    allowed(fx.send('p1', status('onScene', c)));
    allowed(fx.send('p1', status('transporting', c)));
    unchanged(fx, () => fx.send('p1', status('busy')), 'illegalState'); // transporting -> busy
    allowed(fx.send('p1', status('outOfService')));
    unchanged(fx, () => fx.send('p1', status('busy')), 'illegalState'); // outOfService -> available only
    allowed(fx.send('p1', status('available')));
  });
  it('re-sending the same status and call is a no-op without an event', () => {
    const fx = fixture();
    allowed(fx.send('p1', status('busy')));
    const rev = fx.room.rev;
    const r = fx.send('p1', status('busy'));
    expect(r.reject).toBeNull();
    expect(r.events).toEqual([]);
    expect(fx.room.rev).toBe(rev);
  });
});

describe('snapshot', () => {
  it('reflects a sequence of operations and counts one revision per event', () => {
    const fx = fixture();
    const rev0 = fx.room.rev;
    expect(rev0).toBe(4);
    const a = fx.newCall(2);
    const b = fx.newCall(4);
    fx.send('d', assign(a, 'N1')); // +1
    fx.send('p1', status('enRoute', a)); // +1
    fx.send('d', note(a, 'caller on the line')); // +1
    fx.send('d', { t: 'callPriority', callId: b, priority: 1 }); // +1
    fx.send('d', close(b)); // +1
    fx.send('p1', { t: 'radio', channel: 'main', text: 'en route' }); // +1
    expect(fx.room.rev).toBe(rev0 + 2 + 6);
    const snap = fx.room.snapshot;
    expect(snap).toMatchObject({ room: 'r', seed: 99, rev: fx.room.rev, host: 'N1' });
    expect(snap.calls.map((c) => [c.id, c.status])).toEqual([[a, 'active'], [b, 'closed']]);
    expect(snap.calls[0]).toMatchObject({ priority: 2, units: ['N1'], primary: 'N1', createdBy: 'DISPATCH' });
    expect(snap.calls[0]?.notes[0]).toMatchObject({ by: 'DISPATCH', text: 'caller on the line' });
    expect(snap.calls[1]).toMatchObject({ priority: 1, disposition: 'handled' });
    expect(snap.units.find((u) => u.callsign === 'N1')).toMatchObject({ status: 'enRoute', callId: a });
  });
  it('keeps open calls and only the last closedKept closed calls', () => {
    const fx = fixture();
    const open = fx.newCall();
    const ids: number[] = [];
    for (let i = 0; i < LIMITS.closedKept + 5; i++) {
      const id = fx.newCall();
      ids.push(id);
      fx.send('d', close(id));
    }
    const snap = fx.room.snapshot;
    const closed = snap.calls.filter((c) => c.status === 'closed');
    expect(closed).toHaveLength(LIMITS.closedKept);
    expect(closed.map((c) => c.id)).toEqual(ids.slice(5));
    expect(snap.calls[0]?.id).toBe(open);
    expect(snap.calls).toHaveLength(LIMITS.closedKept + 1);
  });
  it('returns copies: mutating a snapshot or an event does not change the room', () => {
    const fx = fixture();
    const r = fx.send('d', callCreate());
    const ev = r.events[0];
    if (ev?.k !== 'callCreated') throw new Error('expected callCreated');
    ev.call.label = 'tampered';
    const snap = fx.room.snapshot;
    snap.calls[0]!.label = 'tampered';
    snap.units[0]!.name = 'tampered';
    expect(fx.room.snapshot.calls[0]?.label).toBe('Noise');
    expect(fx.room.snapshot.units[0]?.name).toBe('One');
  });
  it('joined events carry the unit and a rejected message never changes the revision', () => {
    const room = new Room({ name: 'r', seed: 1 });
    const j = room.join('a', hello('patrol', 'Ann'), 0);
    const ev: RoomEvent | undefined = j.events[0];
    expect(ev).toMatchObject({ k: 'joined', unit: { callsign: 'N1', name: 'Ann', status: 'available' } });
    const rev = room.rev;
    room.handle('a', { t: 'callPriority', callId: 1, priority: 1 }, 5);
    expect(room.rev).toBe(rev);
  });
});
