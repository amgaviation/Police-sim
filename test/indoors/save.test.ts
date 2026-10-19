import { afterEach, describe, expect, it } from 'vitest';
import { MAX_OVERRIDES, emptyInteriorSave, isInteriorSave, type InteriorSave } from '../../src/indoors';
import type { InteriorDoor } from '../../src/interior/types';
import { createRng } from '../../src/core/rng';
import { findBuilding, layoutOf, makeRig, SEED, type Rig } from './helpers';

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.dispose();
});
async function rigOf(): Promise<Rig> {
  const r = await makeRig();
  rigs.push(r);
  return r;
}

const json = (s: InteriorSave): InteriorSave => JSON.parse(JSON.stringify(s)) as InteriorSave;

describe('interior save', () => {
  it('emptyInteriorSave is valid and outdoors; malformed blocks are rejected', () => {
    const empty = emptyInteriorSave(createRng(SEED).stream('interior').state());
    expect(isInteriorSave(empty)).toBe(true);
    expect(empty).toMatchObject({ version: 1, officerBuilding: -1, doors: [], lights: [], queue: [], spawned: [], pending: null, fade: 0, kickCooldown: 0 });
    expect(isInteriorSave(json(empty))).toBe(true);
    const bad: unknown[] = [
      null, 5, {}, { ...empty, version: 2 }, { ...empty, rng: { seed: 1, s: [1, 2, 3] } }, { ...empty, officerBuilding: -2 },
      { ...empty, doors: [[1, 2, 7]] }, { ...empty, doors: [[1, 2]] }, { ...empty, lights: [[1, 2, 2]] },
      { ...empty, kickCooldown: -1 }, { ...empty, fade: 2 }, { ...empty, pending: { kind: 'enter' } },
      { ...empty, pending: { kind: 'sneak', buildingId: 1, door: 0, phase: 0, t: 0 } },
      { ...empty, queue: [{ kind: 'door', buildingId: 1, door: 0, action: 'explode' }] },
      { ...empty, queue: [{ kind: 'nope' }] }, { ...empty, spawned: [[1, ['a']]] },
      { ...empty, doors: Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => [i, 0, 1]) },
    ];
    for (const x of bad) expect(isInteriorSave(x)).toBe(false);
    const good = { ...empty, pending: { kind: 'exit', buildingId: 3, door: 1, phase: 2, t: 0.1 }, queue: [{ kind: 'switch', buildingId: 3, room: 1 }], spawned: [[3, [4, 5]]] };
    expect(isInteriorSave(good)).toBe(true);
  });

  it('a save taken mid-transition with overrides and a queue continues identically after restore', async () => {
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    const inner = layout.doors.find((d) => d.b >= 0 && d.lockable) as InteriorDoor;
    const lightRoom = layout.rooms.find((r) => r.light !== null)?.index ?? 0;

    const a = await rigOf();
    a.officer.x = main.exit?.x ?? 0;
    a.officer.z = main.exit?.z ?? 0;
    a.steps(2);
    a.sys.setDoorState(b.id, main.index, 'closed');
    a.sys.setDoorState(b.id, inner.index, 'locked');
    a.sys.setRoomLight(b.id, lightRoom, true);
    a.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    a.steps(7);
    expect(a.sys.fade).toBeGreaterThan(0);
    expect(a.sys.fade).toBeLessThan(1);
    // Queued, not yet applied.
    a.sys.request({ kind: 'door', buildingId: b.id, door: main.index, action: 'knock' });
    a.sys.request({ kind: 'switch', buildingId: b.id, room: lightRoom });
    const save = json(a.sys.serialize());
    expect(isInteriorSave(save)).toBe(true);
    expect(save.pending).toMatchObject({ kind: 'enter', buildingId: b.id, door: main.index, phase: 0 });
    expect(save.queue).toHaveLength(2);
    expect(save.doors).toContainEqual([b.id, inner.index, 2]);
    expect(save.lights).toContainEqual([b.id, lightRoom, 1]);
    expect(save.officerBuilding).toBe(-1);

    const c = await rigOf();
    c.sys.restore(save);
    // The pending building is resident at once, with its colliders.
    expect(c.sys.resident).toEqual([b.id]);
    expect(c.physics.raw.colliders.len()).toBe(c.sys.stats.colliders);
    expect(c.sys.fade).toBe(a.sys.fade);
    expect(c.sys.doorState(b.id, inner.index)).toBe('locked');
    expect(c.sys.roomLit(b.id, lightRoom)).toBe(true);
    expect(c.sys.serialize()).toEqual(save);

    a.events.length = 0;
    c.events.length = 0;
    c.officer.x = a.officer.x;
    c.officer.z = a.officer.z;
    const fades: [number[], number[]] = [[], []];
    for (let i = 0; i < 50; i++) {
      a.steps(1);
      c.steps(1);
      fades[0].push(a.sys.fade);
      fades[1].push(c.sys.fade);
    }
    expect(fades[1]).toEqual(fades[0]);
    expect(c.events).toEqual(a.events);
    expect(c.sys.officerBuilding).toBe(b.id);
    expect(a.sys.officerBuilding).toBe(b.id);
    expect(c.sys.serialize()).toEqual(a.sys.serialize());

    // The rng state travels: breach outcomes agree attempt by attempt.
    const standing = { x: inner.x, z: inner.z + 0.4 };
    for (const r of [a, c]) {
      r.officer.x = standing.x;
      r.officer.z = standing.z;
    }
    const outcomes = (r: Rig): boolean[] => {
      const out: boolean[] = [];
      for (let i = 0; i < 40; i++) {
        r.sys.setDoorState(b.id, inner.index, 'closed');
        r.sys.request({ kind: 'door', buildingId: b.id, door: inner.index, action: 'kick' });
        r.sys.step(1.1, r.officer);
        out.push(r.sys.doorState(b.id, inner.index) === 'broken');
      }
      return out;
    };
    const oa = outcomes(a);
    expect(outcomes(c)).toEqual(oa);
    expect(oa.some(Boolean) && oa.some((x) => !x)).toBe(true);
    expect(c.sys.serialize()).toEqual(a.sys.serialize());
  });

  it('a save taken indoors restores the officer building resident without spawning anyone', async () => {
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const a = await rigOf();
    a.time.now = 22 * 3600;
    a.sys.placeOfficerInside(b.id, layout.entry);
    a.steps(3);
    expect(a.occupants.spawned.length).toBeGreaterThan(0);
    const save = json(a.sys.serialize());
    expect(save.officerBuilding).toBe(b.id);
    expect(save.spawned).toEqual([[b.id, a.occupants.spawned.map((_, i) => i + 1)]]);

    const c = await rigOf();
    c.time.now = 22 * 3600;
    c.sys.restore(save);
    expect(c.sys.officerBuilding).toBe(b.id);
    expect(c.sys.resident).toEqual([b.id]);
    expect(c.physics.raw.colliders.len()).toBe(a.physics.raw.colliders.len());
    c.steps(60);
    expect(c.occupants.spawned).toEqual([]);
    // Leaving unloads the restored ambient actors.
    c.officer.x = 1e6;
    c.officer.z = 1e6;
    c.sys.placeOfficerInside(b.id, layout.entry);
    expect(c.sys.serialize().spawned).toEqual(save.spawned);
    c.sys.restore({ ...save, officerBuilding: -1, spawned: save.spawned });
    c.steps(20);
    expect(c.occupants.removed.length).toBe(a.occupants.spawned.length);
  });

  it('restoring an empty save clears every override and the officer level', async () => {
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const a = await rigOf();
    a.sys.placeOfficerInside(b.id, layout.entry);
    a.sys.setDoorState(b.id, 1, 'broken');
    a.sys.setRoomLight(b.id, 0, true);
    a.sys.restore(emptyInteriorSave(createRng(SEED).stream('interior').state()));
    expect(a.sys.officerBuilding).toBe(-1);
    expect(a.sys.resident).toEqual([]);
    expect(a.physics.raw.colliders.len()).toBe(0);
    expect(a.sys.doorState(b.id, 1)).toBe('closed');
    expect(a.sys.serialize().doors).toEqual([]);
    expect(a.sys.serialize().lights).toEqual([]);
  });

  it('caps door and light overrides at 2000, oldest first, keeping the officer building', async () => {
    const a = await rigOf();
    const home = findBuilding('house');
    const homeLayout = layoutOf(home);
    a.sys.placeOfficerInside(home.id, homeLayout.entry);
    // Oldest override belongs to the officer's building.
    a.sys.setDoorState(home.id, 0, 'locked');
    a.sys.setRoomLight(home.id, 0, true);
    let n = 0;
    for (let block = 0; block < 1500 && n < MAX_OVERRIDES + 150; block++) {
      for (let local = 0; local < 40 && n < MAX_OVERRIDES + 150; local++) {
        const id = block * 256 + local;
        if (id === home.id) continue;
        const l = a.sys.layout(id);
        if (l === null || l.doors[0]?.kind === 'wide') continue;
        a.sys.setDoorState(id, 0, 'broken');
        a.sys.setRoomLight(id, 0, true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(MAX_OVERRIDES);
    const save = a.sys.serialize();
    expect(save.doors.length).toBe(MAX_OVERRIDES);
    expect(save.lights.length).toBe(MAX_OVERRIDES);
    expect(save.doors).toContainEqual([home.id, 0, 2]);
    expect(save.lights).toContainEqual([home.id, 0, 1]);
    expect(isInteriorSave(json(save))).toBe(true);
  });
});
