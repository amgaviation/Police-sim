import { afterEach, describe, expect, it } from 'vitest';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import type { BuildingInfo } from '../../src/world/buildings';
import { findBuilding, layoutOf, makeRig, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

function doorEvents(r: Rig, action?: string): { action: string; success: boolean; door: number; by: string; x: number; z: number }[] {
  return r.events
    .filter((e) => e.topic === 'interior:door')
    .map((e) => e.payload as { action: string; success: boolean; door: number; by: string; x: number; z: number })
    .filter((p) => action === undefined || p.action === action);
}

/** A point `dist` m from the door's centre inside room `room`. */
function pointIn(layout: InteriorLayout, d: InteriorDoor, room: number, dist = 0.6): { x: number; z: number } {
  const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
  if (d.axis === 'x') return { x: d.x, z: d.z + ((r.minZ + r.maxZ) / 2 < d.z ? -dist : dist) };
  return { x: d.x + ((r.minX + r.maxX) / 2 < d.x ? -dist : dist), z: d.z };
}

/** Puts the officer inside `b`, next to door `d` (on room `room`'s side), and runs two steps. */
function standBy(r: Rig, b: BuildingInfo, layout: InteriorLayout, d: InteriorDoor, room: number): void {
  const p = pointIn(layout, d, room);
  r.sys.placeOfficerInside(b.id, { x: p.x, z: p.z, yaw: 0 });
  r.officer.x = p.x;
  r.officer.z = p.z;
  r.steps(2);
  r.events.length = 0;
}

function interiorDoor(layout: InteriorLayout, lockable: boolean): InteriorDoor {
  const d = layout.doors.find((x) => x.b >= 0 && x.kind === 'interior' && x.lockable === lockable);
  if (!d) throw new Error('no such door');
  return d;
}

function attempts(r: Rig, b: BuildingInfo, d: InteriorDoor, action: 'kick' | 'ram', n: number): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    r.sys.setDoorState(b.id, d.index, 'closed');
    r.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action });
    r.sys.step(1.1, r.officer);
    out.push(r.sys.doorState(b.id, d.index) === 'broken');
  }
  return out;
}

const rate = (xs: boolean[]): number => xs.filter(Boolean).length / xs.length;

describe('doors', () => {
  it('toggles, opens and closes an unlocked door and tracks revisions', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, false);
    standBy(rig, b, layout, d, d.a);
    const rev = rig.sys.doorRevision(b.id);
    const sysRev = rig.sys.revision;
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'toggle' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('open');
    expect(rig.sys.doorRevision(b.id)).toBe(rev + 1);
    expect(rig.sys.revision).toBeGreaterThan(sysRev);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'toggle' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'open' });
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'close' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');
    expect(doorEvents(rig).map((e) => e.action)).toEqual(['open', 'close', 'open', 'close']);
    expect(doorEvents(rig)[0]).toMatchObject({ door: d.index, success: true, by: 'officer' });
    expect(doorEvents(rig)[0]?.x).toBeCloseTo(d.x, 5);
  });

  it('ignores door requests from an officer who is too far or in another building', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, false);
    standBy(rig, b, layout, d, d.a);
    rig.officer.x += 5;
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'open' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');
    expect(doorEvents(rig)).toEqual([]);
  });

  it('a locked door blocks open/toggle and enter', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    expect(main.lockedAtStart).toBe(true);
    expect(rig.sys.doorState(b.id, main.index)).toBe('locked');
    // Outside the main door, building resident.
    rig.officer.x = main.exit?.x ?? 0;
    rig.officer.z = main.exit?.z ?? 0;
    rig.steps(2);
    expect(rig.sys.resident).toEqual([b.id]);
    rig.events.length = 0;
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    rig.steps(5);
    expect(rig.sys.officerBuilding).toBe(-1);
    expect(rig.sys.fade).toBe(0);
    expect(rig.events.filter((e) => e.topic === 'interior:flash').map((e) => e.payload)).toEqual([{ text: 'Locked' }]);
    expect(doorEvents(rig, 'locked')).toHaveLength(1);
    expect(doorEvents(rig, 'locked')[0]?.success).toBe(false);
    expect(rig.events.some((e) => e.topic === 'interior:transition')).toBe(false);
    // Opening from outside is refused too.
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'open' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, main.index)).toBe('locked');
    // An interior locked door.
    const inner = interiorDoor(layout, true);
    standBy(rig, b, layout, inner, inner.a);
    rig.sys.setDoorState(b.id, inner.index, 'locked');
    rig.sys.request({ kind: 'door', buildingId: b.id, door: inner.index, action: 'toggle' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, inner.index)).toBe('locked');
  });

  it('kick success follows 0.7 - 0.6 * strength with the seeded rng', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, true);
    expect(d.strength).toBeCloseTo(0.3, 5);
    standBy(rig, b, layout, d, d.a);
    const first = attempts(rig, b, d, 'kick', 400);
    expect(rate(first)).toBeGreaterThan(0.52 - 0.09);
    expect(rate(first)).toBeLessThan(0.52 + 0.09);
    // A stronger exterior door is harder (0.7 - 0.6 * 0.6 = 0.34).
    const main = layout.doors.find((x) => x.main) as InteriorDoor;
    standBy(rig, b, layout, main, main.a);
    const second = attempts(rig, b, main, 'kick', 400);
    expect(rate(second)).toBeGreaterThan(0.34 - 0.09);
    expect(rate(second)).toBeLessThan(0.34 + 0.09);
    expect(doorEvents(rig, 'breached').length).toBe(second.filter(Boolean).length);
  });

  it('is deterministic for the same seed', async () => {
    const run = async (): Promise<boolean[]> => {
      const r = await makeRig();
      try {
        const b = findBuilding('house');
        const layout = layoutOf(b);
        const d = interiorDoor(layout, true);
        standBy(r, b, layout, d, d.a);
        return attempts(r, b, d, 'kick', 60);
      } finally {
        r.dispose();
      }
    };
    const a = await run();
    expect(await run()).toEqual(a);
    expect(a.some(Boolean) && a.some((x) => !x)).toBe(true);
  });

  it('never breaches an unbreachable door (the vault)', async () => {
    rig = await makeRig();
    const b = findBuilding('bank');
    const layout = layoutOf(b);
    const vault = layout.doors.find((d) => d.strength >= 0.95);
    expect(vault).toBeDefined();
    const d = vault as InteriorDoor;
    expect(d.strength).toBe(1);
    rig.carried.ram = 1;
    standBy(rig, b, layout, d, d.a);
    expect(rate(attempts(rig, b, d, 'kick', 200))).toBe(0);
    expect(rate(attempts(rig, b, d, 'ram', 200))).toBe(0);
    expect(doorEvents(rig, 'breached')).toEqual([]);
    expect(doorEvents(rig, 'ram').every((e) => !e.success)).toBe(true);
  });

  it('a ram needs the kit item and follows 1.1 - 0.8 * strength', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((x) => x.main) as InteriorDoor;
    standBy(rig, b, layout, main, main.a);
    expect(rate(attempts(rig, b, main, 'ram', 20))).toBe(0);
    expect(doorEvents(rig, 'ram')).toEqual([]);
    expect(rig.events.some((e) => e.topic === 'interior:flash')).toBe(true);
    rig.carried.ram = 1;
    const outcomes = attempts(rig, b, main, 'ram', 400);
    const p = 1.1 - 0.8 * main.strength;
    expect(rate(outcomes)).toBeGreaterThan(p - 0.09);
    expect(rate(outcomes)).toBeLessThan(p + 0.09);
  });

  it('a breach attempt has a one second cooldown', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, true);
    standBy(rig, b, layout, d, d.a);
    for (let i = 0; i < 30; i++) {
      rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'kick' });
      rig.steps(1);
      rig.sys.setDoorState(b.id, d.index, 'closed');
    }
    expect(doorEvents(rig, 'kick')).toHaveLength(1);
    rig.steps(40);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'kick' });
    rig.steps(1);
    expect(doorEvents(rig, 'kick')).toHaveLength(2);
  });

  it('lock and unlock follow the side rules', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, true);
    expect(d.lockSide).toBeGreaterThanOrEqual(0);
    const other = d.lockSide === d.a ? d.b : d.a;
    // From the wrong side: refused.
    standBy(rig, b, layout, d, other);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');
    expect(doorEvents(rig, 'lock')).toEqual([expect.objectContaining({ success: false })]);
    // From the lock side: works, and it can be unlocked again.
    standBy(rig, b, layout, d, d.lockSide);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('locked');
    rig.officer.x = pointIn(layout, d, other).x;
    rig.officer.z = pointIn(layout, d, other).z;
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'unlock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('locked');
    rig.officer.x = pointIn(layout, d, d.lockSide).x;
    rig.officer.z = pointIn(layout, d, d.lockSide).z;
    rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action: 'unlock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, d.index)).toBe('closed');

    // A door that is not lockable cannot be locked.
    const plain = interiorDoor(layout, false);
    standBy(rig, b, layout, plain, plain.a);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: plain.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, plain.index)).toBe('closed');
  });

  it('an exterior door locks from inside only', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((x) => x.main) as InteriorDoor;
    rig.sys.setDoorState(b.id, main.index, 'closed');
    // Outside.
    rig.officer.x = main.exit?.x ?? 0;
    rig.officer.z = main.exit?.z ?? 0;
    rig.steps(2);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, main.index)).toBe('closed');
    // Inside.
    standBy(rig, b, layout, main, main.a);
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, main.index)).toBe('locked');
    // An open door has to be closed first.
    rig.sys.setDoorState(b.id, main.index, 'open');
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'lock' });
    rig.steps(1);
    expect(rig.sys.doorState(b.id, main.index)).toBe('open');
  });

  it('knock and announce emit events without changing the door', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((x) => x.main) as InteriorDoor;
    rig.officer.x = main.exit?.x ?? 0;
    rig.officer.z = main.exit?.z ?? 0;
    rig.steps(2);
    rig.events.length = 0;
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'knock' });
    rig.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'announce' });
    rig.steps(1);
    expect(doorEvents(rig).map((e) => [e.action, e.success])).toEqual([['knock', true], ['announce', true]]);
    expect(rig.sys.doorState(b.id, main.index)).toBe('locked');
  });

  it('adds and removes the panel collider as the door closes, opens and breaks', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const d = interiorDoor(layout, false);
    standBy(rig, b, layout, d, d.a);
    const count = (): number => rig?.physics.raw.colliders.len() ?? -1;
    expect(count()).toBe(rig.sys.stats.colliders);
    const closed = count();
    rig.sys.setDoorState(b.id, d.index, 'open');
    expect(count()).toBe(closed - 1);
    expect(rig.sys.stats.colliders).toBe(closed - 1);
    rig.sys.setDoorState(b.id, d.index, 'closed');
    expect(count()).toBe(closed);
    rig.sys.setDoorState(b.id, d.index, 'locked');
    expect(count()).toBe(closed);
    rig.sys.setDoorState(b.id, d.index, 'broken');
    expect(count()).toBe(closed - 1);
    rig.sys.setDoorState(b.id, d.index, 'closed');
    expect(count()).toBe(closed);
    // Scene changes are marked as such and unchanged states emit nothing.
    rig.events.length = 0;
    rig.sys.setDoorState(b.id, d.index, 'closed');
    expect(doorEvents(rig)).toEqual([]);
    rig.sys.setDoorState(b.id, d.index, 'locked');
    expect(doorEvents(rig)).toEqual([expect.objectContaining({ action: 'lock', by: 'scene', success: true })]);
  });

  it('wide doors are always open and ignore requests', async () => {
    rig = await makeRig();
    const station = rig.buildings.station();
    expect(station).not.toBeNull();
    const b = station as BuildingInfo;
    const layout = layoutOf(b);
    const wide = layout.doors.find((d) => d.kind === 'wide');
    expect(wide).toBeDefined();
    const d = wide as InteriorDoor;
    expect(rig.sys.doorState(b.id, d.index)).toBe('open');
    const p = pointIn(layout, d, d.a);
    rig.sys.placeOfficerInside(b.id, { x: p.x, z: p.z, yaw: 0 });
    rig.officer.x = p.x;
    rig.officer.z = p.z;
    rig.steps(2);
    rig.events.length = 0;
    for (const action of ['close', 'toggle', 'lock', 'kick'] as const) rig.sys.request({ kind: 'door', buildingId: b.id, door: d.index, action });
    rig.sys.setDoorState(b.id, d.index, 'locked');
    rig.steps(2);
    expect(rig.sys.doorState(b.id, d.index)).toBe('open');
    expect(doorEvents(rig)).toEqual([]);
    // No panel collider for any wide door.
    const panels = layout.doors.filter((x) => x.kind !== 'wide').length;
    expect(rig.sys.stats.colliders).toBeLessThanOrEqual(rig.physics.raw.colliders.len());
    expect(panels).toBeGreaterThan(0);
  });
});
