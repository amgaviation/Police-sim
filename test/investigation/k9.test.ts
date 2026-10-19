import { describe, expect, it } from 'vitest';
import { K9_FIRST_ROOM_S, K9_ROOM_S, k9Sweep } from '../../src/evidence';
import { reachableRooms } from '../../src/interior/nav';
import { unitHash } from '../../src/records/hash';
import { BODY } from '../../src/render/people/pose';
import { k9Duration } from '../../src/investigation/k9run';
import { SEED, makeHarness, nightstands, placeSpec, stand, type Harness } from './harness';

const K9_SALT = 0x6b39;

function roomCentre(h: Harness, room: number): { x: number; z: number } {
  const r = (h.layout.rooms[room] as (typeof h.layout.rooms)[number]).rect;
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
}

/** A call id whose first target (the hidden person) is surely smelled (u < 0.95). */
function alertingCall(): number {
  for (let c = 1; c < 500; c++) if (unitHash(SEED, K9_SALT, c * 64) < 0.9) return c;
  throw new Error('no call id');
}

function hiddenInBedroom(h: Harness): number {
  const bedroom = h.layout.rooms.find((r) => r.kind === 'bedroom');
  if (!bedroom) throw new Error('no bedroom');
  const c = roomCentre(h, bedroom.index);
  h.world.hidden = [{ actorId: 77, x: c.x, z: c.z }];
  return bedroom.index;
}

function expectedAlertTime(h: Harness, callId: number): number {
  const door = h.layout.doors.find((d) => d.main);
  const order = reachableRooms(h.layout, door?.a ?? 0, () => true, []).slice();
  const bedroom = h.layout.rooms.find((r) => r.kind === 'bedroom');
  const c = roomCentre(h, bedroom?.index ?? 0);
  const alerts = k9Sweep(order, [{ kind: 'person', ref: '77', room: bedroom?.index ?? 0, x: c.x, z: c.z, scent: 'person' }], (i) =>
    unitHash(SEED, K9_SALT, callId * 64 + i),
  );
  const t = alerts[0]?.atS;
  if (t === undefined) throw new Error('no alert');
  return t;
}

describe('K9 sweep', () => {
  it('alerts on a hidden person at the room visit time and emits the person alert and a radio line', () => {
    const h = makeHarness();
    const callId = alertingCall();
    h.world.call = callId;
    const room = hiddenInBedroom(h);
    stand(h, 100, -207.5, -1, 0, -1);
    h.sys.startK9(callId);
    const at = expectedAlertTime(h, callId);
    expect(at).toBeGreaterThanOrEqual(K9_FIRST_ROOM_S);
    expect((at - K9_FIRST_ROOM_S) % K9_ROOM_S).toBe(0);
    h.run(at - 0.5);
    expect(h.of('investigation:k9Alert')).toHaveLength(0);
    h.run(1);
    const alerts = h.of('investigation:k9Alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ callId, kind: 'person', actorId: 77, room, itemId: '' });
    const label = h.layout.rooms[room]?.label.toLowerCase() ?? '';
    expect(alerts[0]?.payload['text']).toBe(`K9 has an indication in the ${label}.`);
    expect(h.of('investigation:radio')[0]?.payload['text']).toBe(`K9 has an indication in the ${label}.`);
    expect(h.sys.store.get(callId)?.k9.some((n) => n.text.includes('person'))).toBe(true);
  });

  it('flags a concealed item the dog smells and records a case note', () => {
    const h = makeHarness();
    const stands = nightstands(h.layout);
    const f = stands[0];
    if (!f) throw new Error('no nightstand');
    // A firearm is smelled with probability 0.6: find a call id where target 0 alerts.
    let callId = -1;
    for (let c = 1; c < 500 && callId < 0; c++) if (unitHash(SEED, K9_SALT, c * 64) < 0.5) callId = c;
    h.world.call = callId;
    const id = h.sys.placeItem(
      placeSpec(h, { callId, item: 'handgun', label: 'Handgun', x: f.x, z: f.z, y: 0.45, room: f.room, furniture: f.index, container: 'drawer', concealed: true }),
    );
    h.sys.startK9(callId);
    h.run(k9Duration(h.layout.rooms.length) + 1);
    const item = h.sys.store.item(id);
    expect(item?.k9Alert).toBe(true);
    expect(item?.state).toBe('inPlace');
    const ev = h.of('investigation:k9Alert')[0];
    expect(ev?.payload).toMatchObject({ kind: 'item', itemId: id, actorId: 0 });
    expect(h.sys.store.get(callId)?.k9.some((n) => n.text.includes('handgun'))).toBe(true);
  });

  it('shows the dog and its handler while the sweep runs and removes them afterwards', () => {
    const h = makeHarness();
    const callId = alertingCall();
    h.world.call = callId;
    hiddenInBedroom(h);
    stand(h, 100, -207.5, -1, 0, -1);
    expect(h.sys.dog.count).toBe(0);
    h.sys.startK9(callId);
    expect(h.sys.dog.count).toBe(2);
    expect(h.sys.dog.body[0]).toBe(BODY.dog);
    expect(h.sys.dog.body[1]).toBe(BODY.human);
    h.run(10);
    for (let i = 0; i < 2; i++) {
      expect(Number.isFinite(h.sys.dog.x[i])).toBe(true);
      expect(h.sys.dog.y[i]).toBe(-40);
      expect(h.sys.dog.x[i]).toBeGreaterThan(h.layout.rect.minX - 1);
      expect(h.sys.dog.x[i]).toBeLessThan(h.layout.rect.maxX + 1);
    }
    h.run(k9Duration(h.layout.rooms.length));
    expect(h.sys.dog.count).toBe(0);
    expect(h.sys.store.get(callId)?.k9.at(-1)?.text).toBe('K9 sweep complete.');
  });

  it('is deterministic for a call and ignores a second start while searching', () => {
    const run = (): string[] => {
      const h = makeHarness();
      const callId = alertingCall();
      h.world.call = callId;
      hiddenInBedroom(h);
      h.sys.startK9(callId);
      h.sys.startK9(callId);
      h.run(k9Duration(h.layout.rooms.length) + 1);
      return h.of('investigation:k9Alert').map((e) => JSON.stringify(e.payload));
    };
    const a = run();
    expect(a).toEqual(run());
    expect(a.length).toBeGreaterThan(0);
  });

  it('sweeps outdoors around the anchor for a call without a building', () => {
    const h = makeHarness();
    let found = -1;
    for (let c = 1; c < 500 && found < 0; c++) if (unitHash(SEED, K9_SALT, c * 64) < 0.9) found = c;
    h.world.call = found;
    h.world.calls.set(found, {
      exigency: false, warrant: false, arrests: [], buildingId: -1, family: 'inProgress',
      suspectPersonId: 7, anchorX: 50, anchorZ: 60,
    });
    h.world.hidden = [{ actorId: 5, x: 52, z: 61 }];
    stand(h, 48, 58, -1, 0, -1);
    h.sys.startK9(found);
    expect(Math.hypot((h.sys.dog.x[0] ?? 0) - 50, (h.sys.dog.z[0] ?? 0) - 60)).toBeCloseTo(6, 3);
    h.run(k9Duration(1) + 1);
    const alert = h.of('investigation:k9Alert')[0];
    expect(alert?.payload).toMatchObject({ kind: 'person', actorId: 5, room: -1, text: 'K9 has an indication nearby.' });
  });
});
