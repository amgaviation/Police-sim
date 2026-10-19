import { describe, expect, it } from 'vitest';
import { bigRoom, clearPair, makeHarness, placeSpec, stand, yawTo, type Harness } from './harness';

interface Scene {
  h: Harness;
  itemId: string;
  room: number;
  officer: { x: number; z: number };
  item: { x: number; z: number };
}

/** An open item lying 2-4 m from an officer with a clear sight line, in the largest room. */
function scene(over: Parameters<typeof placeSpec>[1] = {}): Scene {
  const h = makeHarness();
  const room = bigRoom(h.layout);
  const pair = clearPair(h.layout, room);
  const itemId = h.sys.placeItem(placeSpec(h, { x: pair.item.x, z: pair.item.z, y: 0.1, room, ...over }));
  stand(h, pair.officer.x, pair.officer.z, room, yawTo(pair.officer.x, pair.officer.z, pair.item.x, pair.item.z));
  return { h, itemId, room, officer: pair.officer, item: pair.item };
}

function lawful(h: Harness): void {
  h.world.calls.set(42, {
    exigency: true, warrant: false, arrests: [], buildingId: h.layout.buildingId, family: 'property',
    suspectPersonId: 7, anchorX: 100, anchorZ: -200,
  });
}

describe('plain view scan', () => {
  it('flags an open, lit, visible, incriminating item when the officer is lawfully present', () => {
    const { h, itemId } = scene();
    lawful(h);
    h.run(1);
    const item = h.sys.store.item(itemId);
    expect(item?.state).toBe('found');
    expect(item?.plainView).toBe(true);
    expect(item?.foundBasis).toBe('plainView');
    expect(item?.suppressed).toBe(false);
    expect(h.of('investigation:plainView')).toHaveLength(1);
    expect(h.flashes().some((f) => f.startsWith('Plain view: Knife ('))).toBe(true);
  });

  it('does nothing without lawful presence', () => {
    const { h, itemId } = scene();
    h.run(2);
    expect(h.sys.store.item(itemId)?.state).toBe('inPlace');
    expect(h.of('investigation:plainView')).toHaveLength(0);
  });

  it('a consent to enter makes the presence lawful', () => {
    const { h, itemId } = scene();
    h.run(1);
    expect(h.sys.store.item(itemId)?.state).toBe('inPlace');
    h.sys.recordConsent({
      callId: 42, personId: 7, kind: 'entry', granted: true, valid: true, authority: true,
      buildingId: h.layout.buildingId, room: -1, vehicleId: -1, sim: h.sim, revokedSim: -1,
    });
    h.run(1);
    expect(h.sys.store.item(itemId)?.state).toBe('found');
  });

  it('needs the item to be incriminating and not concealed', () => {
    const a = scene({ incriminating: false });
    lawful(a.h);
    a.h.run(1);
    expect(a.h.sys.store.item(a.itemId)?.state).toBe('inPlace');
    const b = scene({ concealed: true, container: 'drawer' });
    lawful(b.h);
    b.h.run(1);
    expect(b.h.sys.store.item(b.itemId)?.state).toBe('inPlace');
  });

  it('needs line of sight: a wall between officer and item hides it', () => {
    const h = makeHarness();
    lawful(h);
    const centre = (i: number): { x: number; z: number } => {
      const r = (h.layout.rooms[i] as (typeof h.layout.rooms)[number]).rect;
      return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
    };
    // Two rooms whose centres are within a few metres of each other, separated by a wall or a closed door.
    let pair: [number, number] | null = null;
    for (const d of h.layout.doors) {
      if (d.b < 0) continue;
      const a = centre(d.a);
      const b = centre(d.b);
      if (Math.hypot(a.x - b.x, a.z - b.z) <= 8) {
        pair = [d.a, d.b];
        break;
      }
    }
    if (!pair) throw new Error('no adjacent rooms');
    const a = centre(pair[0]);
    const b = centre(pair[1]);
    const id = h.sys.placeItem(placeSpec(h, { x: b.x, z: b.z, y: 0.1, room: pair[1] }));
    stand(h, a.x, a.z, pair[0], yawTo(a.x, a.z, b.x, b.z));
    h.run(1);
    expect(h.sys.store.item(id)?.state).toBe('inPlace');
  });

  it('ignores items farther than ten metres', () => {
    const { h, itemId } = scene();
    lawful(h);
    const item = h.sys.store.item(itemId);
    if (!item) throw new Error('missing item');
    item.x = h.off.x + 11;
    h.run(1);
    expect(item.state).toBe('inPlace');
  });

  it('needs light: a dark room hides the item, a flashlight pointed at it shows it', () => {
    const { h, itemId, room } = scene();
    lawful(h);
    h.world.dark.add(room);
    h.run(1);
    expect(h.sys.store.item(itemId)?.state).toBe('inPlace');
    const item = h.sys.store.item(itemId);
    if (!item) throw new Error('missing item');
    // Flashlight on but pointing away.
    h.off.flashlight = true;
    const yaw = h.off.yaw;
    h.off.yaw = yaw + Math.PI;
    h.run(1);
    expect(item.state).toBe('inPlace');
    // Pointing at it, within 8 m.
    h.off.yaw = yaw;
    h.run(1);
    expect(item.state).toBe('found');
    expect(item.plainView).toBe(true);
  });

  it('a flashlight beam reaches eight metres, not nine', () => {
    const h = makeHarness();
    h.world.call = 0;
    h.world.night = 1;
    const near = h.sys.placeItem(placeSpec(h, { callId: 0, x: 7.5, z: 0, y: 0, buildingId: -1, room: -1 }));
    const far = h.sys.placeItem(placeSpec(h, { callId: 0, x: 0, z: -9, y: 0, buildingId: -1, room: -1 }));
    stand(h, 0, 0, -1, 0, -1);
    h.off.flashlight = true;
    // Facing -Z: the far item is dead ahead at 9 m, the near one is off to the side.
    h.off.yaw = yawTo(0, 0, 7.5, 0);
    h.run(1);
    expect(h.sys.store.item(near)?.state).toBe('found');
    expect(h.sys.store.item(far)?.state).toBe('inPlace');
    h.off.yaw = 0;
    h.run(1);
    expect(h.sys.store.item(far)?.state).toBe('inPlace');
  });

  it('outdoors only daylight (or a flashlight) lights an item', () => {
    const h = makeHarness();
    h.world.call = 0;
    const id = h.sys.placeItem(placeSpec(h, { callId: 0, x: 3, z: 0, y: 0, buildingId: -1, room: -1 }));
    stand(h, 0, 0, -1, yawTo(0, 0, 3, 0), -1);
    h.world.night = 1;
    h.run(1);
    expect(h.sys.store.item(id)?.state).toBe('inPlace');
    h.off.flashlight = true;
    h.run(1);
    expect(h.sys.store.item(id)?.state).toBe('found');
    // Daylight alone works as well (a second item).
    h.off.flashlight = false;
    h.world.night = 0;
    const id2 = h.sys.placeItem(placeSpec(h, { callId: 0, x: -3, z: 0, y: 0, buildingId: -1, room: -1 }));
    h.run(1);
    expect(h.sys.store.item(id2)?.state).toBe('found');
  });

  it('is lawful in the public room of an open business only', () => {
    const { h, itemId, room } = scene();
    const pub = h.layout.rooms[room];
    if (!pub) throw new Error('no room');
    // The house has no public room: open business alone does not help.
    h.world.open = true;
    h.run(1);
    expect(pub.public).toBe(false);
    expect(h.sys.store.item(itemId)?.state).toBe('inPlace');
  });

  it('does not rescan items that are already found', () => {
    const { h } = scene();
    lawful(h);
    h.run(3);
    expect(h.of('investigation:plainView')).toHaveLength(1);
  });
});
