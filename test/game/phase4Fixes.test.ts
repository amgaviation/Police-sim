import { beforeAll, describe, expect, it } from 'vitest';
import type { InteriorLayout } from '../../src/interior/types';
import type { ActorInfo } from '../../src/npc';
import { initRapier } from '../../src/physics/physics';
import type { BuildingInfo } from '../../src/world/buildings';
import { Harness } from './harness';

const SEED = 4242;

beforeAll(async () => {
  await initRapier();
});

const blank = (): ActorInfo => ({
  id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
  armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
});

const inside = (l: InteriorLayout, id: string, x: number, z: number): boolean =>
  l.furniture.some((f) => f.id === id && x > f.minX && x < f.maxX && z > f.minZ && z < f.maxZ);

describe('interview room', () => {
  it('seats the interviewee across the table, not inside it', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    session.station.request({ kind: 'hold', personId: 9000 });
    h.step(session, 2);
    session.station.request({ kind: 'interview', personId: 9000 });
    h.step(session, 2);
    const st = session.buildings.station()!;
    const layout = session.interiors.layout(st.id)!;
    const id = session.npc.actorOfPerson(9000);
    expect(id).toBeGreaterThan(0);
    const a = session.npc.actor(id, blank())!;
    expect(inside(layout, 'interviewTable', a.x, a.z)).toBe(false);
    const table = layout.furniture.find((f) => f.id === 'interviewTable')!;
    const stand = layout.points.find((p) => p.kind === 'interview')!;
    // The table lies between the officer's stand point and the interviewee.
    const toTable = Math.hypot(table.x - stand.x, table.z - stand.z);
    const toActor = Math.hypot(a.x - stand.x, a.z - stand.z);
    expect(toActor).toBeGreaterThan(toTable + 0.3);
    h.dispose();
  });
});

describe('canvass', () => {
  it('walks an ambient occupant out to the door and back home', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    const out: BuildingInfo[] = [];
    const at = session.playerPosition({ x: 0, z: 0 });
    session.buildings.near(at.x, at.z, 600, out);
    let tested = 0;
    for (const b of out) {
      if (b.kind !== 'house' && b.kind !== 'apartment') continue;
      const layout = session.interiors.layout(b.id);
      const exit = layout?.doors.find((d) => d.main)?.exit;
      if (!layout || !exit) continue;
      session.teleport(exit.x, exit.z, exit.yaw + Math.PI);
      h.step(session, 40);
      const ids: number[] = [];
      session.npc.actorsInBuilding(b.id, ids);
      const occupant = ids.map((i) => session.npc.actor(i, blank())!).find((a) => a.role === 'resident' || a.role === 'staff' || a.role === 'bystander');
      if (!occupant) continue;
      const home = { x: occupant.x, z: occupant.z };
      const spawn = (session as unknown as { spawnCanvassResident(b: number, p: number, c: number, r: 'witness' | 'resident'): number });
      const id = spawn.spawnCanvassResident(b.id, occupant.personId, 0, 'resident');
      if (id === 0) continue;
      expect(id).toBe(occupant.id);
      const a = session.npc.actor(id, blank())!;
      expect(a.building).toBe(-1);
      expect(Math.hypot(a.x - exit.x, a.z - exit.z)).toBeLessThan(0.5);
      // After the stay the occupant is home again.
      h.step(session, 60 * 130);
      const back = session.npc.actor(id, blank());
      expect(back).not.toBeNull();
      expect(back?.building).toBe(b.id);
      expect(Math.hypot((back?.x ?? 0) - home.x, (back?.z ?? 0) - home.z)).toBeLessThan(6);
      tested++;
      break;
    }
    expect(tested).toBe(1);
    h.dispose();
  }, 120_000);
});

describe('shout', () => {
  it('sends a voiceShout sound from the officer, indoors and out', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 30);
    const heard: { source: string; building: number }[] = [];
    h.bus.on('tactical:sound', (e) => heard.push({ source: e.kind, building: e.building }));
    session.shout();
    h.step(session, 2);
    expect(heard.filter((e) => e.source === 'voiceShout')).toEqual([{ source: 'voiceShout', building: session.officerBuilding }]);
    expect(session.officerBuilding).toBeGreaterThanOrEqual(0);
    h.dispose();
  });
});

describe('trunk locker', () => {
  it('is empty away from a patrol car trunk', () => {
    const h = new Harness(undefined, undefined, true);
    const session = h.start(SEED, true);
    h.step(session, 10);
    expect(session.trunkLocker()).toBe('');
    h.dispose();
  });
});
