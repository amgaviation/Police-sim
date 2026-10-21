import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BEAT_CRIME_FACTOR } from '../../src/game/phase8';
import { CoopSession, NetConsolePort } from '../../src/game/coop';
import { startNewGame } from '../../src/game/session';
import { NetClient, PROTOCOL_VERSION, Room, encode, parseClientMsg } from '../../src/net';
import type { ClientMsg, ServerMsg } from '../../src/net';
import type { WebSocketLike } from '../../src/net/client';
import { initRapier } from '../../src/physics/physics';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

let harness: Harness | null = null;
afterEach(() => {
  harness?.dispose();
  harness = null;
});

function fresh(): Harness {
  harness = new Harness(city, undefined, true);
  return harness;
}

/** A WebSocket whose other end is a real `Room`, synchronously. */
class FakeSocket implements WebSocketLike {
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private readonly room: Room;
  private readonly clock: { now: number };
  constructor(room: Room, clock: { now: number }) {
    this.room = room;
    this.clock = clock;
  }
  send(data: string): void {
    const parsed = parseClientMsg(data);
    if (!parsed.ok) return;
    const msg: ClientMsg = parsed.msg;
    this.clock.now += 100;
    if (msg.t === 'hello') {
      const res = this.room.join('me', msg, this.clock.now);
      for (const m of res.direct) this.deliver(m);
      for (const m of this.room.stamp(res.events)) this.deliver(m);
      return;
    }
    const res = this.room.handle('me', msg, this.clock.now);
    if (res.reject) this.deliver({ t: 'reject', ref: msg.t, code: res.reject.code, reason: res.reject.reason });
    for (const m of res.direct) this.deliver(m);
    for (const m of this.room.stamp(res.events)) this.deliver(m);
  }
  close(): void {
    this.readyState = 3;
  }
  deliver(msg: ServerMsg): void {
    this.onmessage?.({ data: encode(msg) });
  }
}

function join(session: ReturnType<typeof startNewGame>, role: 'patrol' | 'dispatcher'): { coop: CoopSession; room: Room; socket: FakeSocket } {
  const room = new Room({ name: 'r', seed: SEED });
  const socket = new FakeSocket(room, { now: 1000 });
  const client = new NetClient(() => socket);
  client.connect('ws://test', { t: 'hello', v: PROTOCOL_VERSION, name: 'One', role, room: 'r', seed: SEED });
  socket.onopen?.({});
  const coop = new CoopSession(session, client, { flash: () => undefined, disconnected: () => undefined });
  return { coop, room, socket };
}

describe('Phase 8 round 2: court verdict bridge', () => {
  it('a traffic citation verdict leaves the offender custody alone', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    const person = 300;
    s.court.request({ kind: 'open', docId: 'C-1', docKind: 'citation', personId: person, personLabel: 'Test', callId: -1, statutes: ['TR-301'] });
    h.step(s, 2);
    const c = s.court.cases().find((x) => x.docKind === 'citation');
    if (!c) throw new Error('no citation case');
    s.phase8.world.request({ kind: 'arrest', personId: person, district: 'downtown', callNumber: 'C-1', x: 0, z: 0, game: s.now().game, offenseClass: 'felony', juvenile: false, priors: 0 });
    h.step(s, 2);
    expect(s.phase8.world.offender(person)?.custody).toBe('jailed');
    s.bus.emit('court:verdict', { caseId: c.id, key: c.key, verdict: 'dismissed', reason: 'dismissed', credibilityDelta: 0, impeached: false, missed: false });
    h.step(s, 2);
    expect(s.phase8.world.offender(person)?.custody).toBe('jailed');
  }, 120_000);
});

describe('Phase 8 round 2: the awarded beat and the specialty unit class', () => {
  it('the bid beat raises the crime factor of its own district only', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    const beat = s.phase8.career.view.slot.beat;
    const other = beat === 'downtown' ? 'suburbs' : 'downtown';
    const gen = s.dispatcher.generator;
    const inBeat = gen.multiplier(0, beat);
    const outside = gen.multiplier(0, other);
    expect(BEAT_CRIME_FACTOR).toBeGreaterThan(1);
    expect(inBeat / outside).toBeGreaterThan(1);
  }, 120_000);

  it('entering a unit of another class than the specialty flashes once; patrol assignments never do', () => {
    const h = fresh();
    const s = h.attach(startNewGame(h.ctx, SEED, {}));
    expect(s.phase8.checkUnitClass('traffic')).toBe(false);
    s.phase8.career.restore({ ...s.phase8.career.serialize(), assignment: 'traffic' });
    s.bus.emit('career:stage', { stage: 'patrol', rank: 'officer', assignment: 'traffic' });
    expect(s.phase8.checkUnitClass('patrol')).toBe(true);
    expect(s.phase8.checkUnitClass('patrol')).toBe(false);
    expect(s.phase8.checkUnitClass('traffic')).toBe(false);
  }, 120_000);
});

describe('Phase 8 round 2: co-op', () => {
  it('a call the local officer opened (traffic stop) is assigned and on scene in the room too', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    const { coop, room } = join(session, 'patrol');
    coop.update(0);
    h.step(session, 2);
    coop.update(100);
    session.cad.setUnitStatus(session.dispatcher.playerCallsign, 'available', session.now(), 'auto');
    coop.update(200);
    const at = session.playerPosition({ x: 0, z: 0 });
    session.dispatcher.openSelfInitiated('trafficStop', 4, { x: at.x + 5, z: at.z + 5 }, 'Stop', session.now());
    h.step(session, 2);
    coop.update(600);
    h.step(session, 2);
    coop.update(900);
    const call = room.snapshot.calls.find((c) => c.origin === 'officer');
    expect(call?.units).toContain('N1');
    const mine = room.snapshot.units.find((u) => u.callsign === 'N1');
    expect(mine?.callId).toBe(call?.id);
    expect(mine?.status).toBe('onScene');
    expect(coop.rejections).toEqual([]);
  }, 120_000);

  it('the dispatcher client is the call source and the console shows address, district, premise and age', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    const { coop, room } = join(session, 'dispatcher');
    coop.update(0);
    // A dispatcher turns the local generator on (the room's call source).
    let created = false;
    for (let i = 0; i < 400 && !created; i++) {
      h.step(session, 30);
      coop.update(1000 + i * 100);
      created = room.snapshot.calls.some((c) => c.origin === 'generator');
    }
    expect(created).toBe(true);
    const net = room.snapshot.calls.find((c) => c.origin === 'generator');
    if (!net) throw new Error('no call');
    expect(net.address).not.toMatch(/^-?\d+, -?\d+$/);
    const port = new NetConsolePort(coop, () => 0);
    port.create('noiseComplaint', 3, at(session).x, at(session).z);
    const rows = port.calls();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.address).not.toMatch(/^-?\d+, -?\d+$/);
      expect(r.district).not.toBe('');
    }
  }, 120_000);

  it('the console call age counts from the local clock, not the server wall clock', () => {
    const h = fresh();
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    const { coop } = join(session, 'dispatcher');
    coop.update(0);
    const port = new NetConsolePort(coop, () => 95000);
    port.create('noiseComplaint', 3, at(session).x, at(session).z);
    coop.update(1000);
    expect(port.calls()).toHaveLength(1);
    // Server createdAtMs is a wall-clock time near 1e3 here; the age is measured on the local clock from first sight.
    expect(port.calls()[0]?.ageS).toBeCloseTo(94, 5);
  }, 120_000);
});

function at(s: ReturnType<typeof startNewGame>): { x: number; z: number } {
  return s.playerPosition({ x: 0, z: 0 });
}
