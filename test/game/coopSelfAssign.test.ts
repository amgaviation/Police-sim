import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CoopSession } from '../../src/game/coop';
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

describe('co-op self assignment', () => {
  it('a patrol that takes a call is en route in the room too, with no rejection', () => {
    const h = new Harness(city, undefined, true);
    harness = h;
    const session = h.attach(startNewGame(h.ctx, SEED, {}));
    const room = new Room({ name: 'r', seed: SEED });
    const clock = { now: 1000 };
    const socket = new FakeSocket(room, clock);
    const client = new NetClient(() => socket);
    client.connect('ws://test', { t: 'hello', v: PROTOCOL_VERSION, name: 'One', role: 'patrol', room: 'r', seed: SEED });
    socket.onopen?.({});
    const flashes: string[] = [];
    const coop = new CoopSession(session, client, { flash: (t) => flashes.push(t), disconnected: () => undefined });
    expect(coop.self).toBe('N1');
    // Let the room's echo of the start-up status reach the mirror before the test changes anything.
    coop.update(0);
    h.step(session, 2);
    coop.update(100);
    // The dispatcher of the room opens a call; the local CAD mirrors it.
    room.join('d', { t: 'hello', v: PROTOCOL_VERSION, name: 'Disp', role: 'dispatcher', room: 'r' }, 0);
    const created = room.handle(
      'd', { t: 'callCreate', ref: 'x1', typeId: 'noiseComplaint', label: 'Noise', priority: 3, x: city.spawn.x + 30, z: city.spawn.z + 30, address: '1 Main', narrative: 'loud', origin: 'dispatcher' }, 2000,
    );
    for (const m of room.stamp(created.events)) socket.deliver(m);
    coop.update(0);
    h.step(session, 2);
    const local = session.cad.calls().find((c) => c.status !== 'closed' && c.units.length === 0);
    if (!local) throw new Error('the call was not mirrored');

    // 10-8: on duty, available.
    session.cad.setUnitStatus(session.dispatcher.playerCallsign, 'available', session.now(), 'auto');
    coop.update(500);
    session.dispatcher.request(session.dispatcher.playerCallsign, { kind: 'selfAssign', callId: local.id }, 'auto');
    h.step(session, 5);
    coop.update(1000);
    h.step(session, 2);
    coop.update(2000);

    expect(session.cad.unit(session.dispatcher.playerCallsign)?.status).toBe('enRoute');
    expect(coop.rejections).toEqual([]);
    const mine = room.snapshot.units.find((u) => u.callsign === 'N1');
    expect(mine?.status).toBe('enRoute');
    expect(mine?.callId).not.toBeNull();
    expect(room.snapshot.calls.find((c) => c.id === mine?.callId)?.units).toContain('N1');
  }, 120_000);
});
