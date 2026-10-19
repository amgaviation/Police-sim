import { afterAll, describe, expect, it } from 'vitest';
import { isNpcSave } from '../../src/npc/save';
import { ACTOR_STATE, type NpcSave } from '../../src/npc/types';
import { DOWNTOWN, StubNav, cityOf, info, makeRig, spec, spotIn, type NpcRig } from './helpers';

const rigs: NpcRig[] = [];
const P = (() => {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  return p;
})();
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

async function rig(): Promise<NpcRig> {
  const r = await makeRig({ x: P.x, z: P.z, density: 0 });
  rigs.push(r);
  r.run(1);
  return r;
}

describe('NpcSave with interiors', () => {
  it('a save without building, aware and hideSpot (a v5 save) restores outdoors with no awareness', async () => {
    const a = await rig();
    a.npc.spawnActor(spec(6000, P.x + 20, P.z, { profile: 'callerHelpful' }));
    a.npc.spawnActor(spec(6001, P.x + 22, P.z, { profile: 'callerHelpful' }));
    const save = JSON.parse(JSON.stringify(a.npc.serialize())) as NpcSave;
    for (const s of save.actors) {
      expect('building' in s).toBe(false);
      delete s.building;
      delete s.aware;
      delete s.hideSpot;
    }
    expect(isNpcSave(save)).toBe(true);
    const b = await rig();
    b.npc.restore(save);
    const out = info();
    const ids: number[] = [];
    b.npc.actorIds(ids);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      b.npc.actor(id, out);
      expect(out.building).toBe(-1);
      expect(out.aware).toBe(0);
      expect(out.hidden).toBe(false);
    }
    b.run(2);
    expect(b.npc.view.y[0]).toBe(0);
  });

  it('building, awareness and hiding spot round trip through JSON', async () => {
    const a = await rig();
    a.npc.setIndoorNav(new StubNav());
    const inn = a.npc.spawnActor(spec(6010, P.x + 20, P.z, { profile: 'callerHelpful', building: 7 }));
    a.npc.stimulate(inn, 'sound', 0.5, P.x, P.z);
    const nav = new StubNav();
    nav.hideIndex = 4;
    nav.hidePose = { x: P.x + 24, z: P.z, yaw: 0 };
    a.npc.setIndoorNav(nav);
    const hider = a.npc.spawnActor(spec(6011, P.x + 21, P.z, { profile: 'callerHelpful', building: 7 }));
    a.npc.forceState(hider, 'flee');
    const save = JSON.parse(JSON.stringify(a.npc.serialize())) as NpcSave;
    expect(isNpcSave(save)).toBe(true);
    const sa = save.actors.find((s) => s.personId === 6010);
    expect(sa?.building).toBe(7);
    expect(sa?.aware).toBeCloseTo(0.5, 6);
    expect(sa?.hideSpot).toBeUndefined();
    const sh = save.actors.find((s) => s.personId === 6011);
    expect(sh?.hideSpot).toBe(4);
    expect(sh?.state).toBe(ACTOR_STATE.hide);

    const b = await rig();
    b.npc.restore(save);
    b.run(2);
    const out = info();
    b.npc.actor(b.npc.actorOfPerson(6010), out);
    expect(out.building).toBe(7);
    expect(out.aware).toBeGreaterThan(0.4);
    expect(b.npc.view.y[0]).toBe(-40);
    // The alert level is rebuilt: crossing the alert line again does not re-raise alert, crossing awareAt does.
    b.npc.stimulate(b.npc.actorOfPerson(6010), 'sound', 0.1, P.x, P.z);
    expect(b.events['npc:aware']).toHaveLength(0);
    b.npc.stimulate(b.npc.actorOfPerson(6010), 'sound', 0.5, P.x, P.z);
    expect(b.events['npc:aware']?.map((e) => e.level)).toEqual(['aware']);
    // The restored hider gives its spot back when revealed.
    const nav2 = new StubNav();
    b.npc.setIndoorNav(nav2);
    b.npc.reveal(b.npc.actorOfPerson(6011));
    expect(nav2.released).toEqual([{ building: 7, index: 4 }]);
  });

  it('rejects malformed interior fields', async () => {
    const a = await rig();
    a.npc.spawnActor(spec(6020, P.x + 20, P.z, { profile: 'callerHelpful' }));
    const base = JSON.parse(JSON.stringify(a.npc.serialize())) as NpcSave;
    const bad = (patch: Record<string, unknown>): boolean => {
      const copy = JSON.parse(JSON.stringify(base)) as NpcSave;
      Object.assign(copy.actors[0] as object, patch);
      return isNpcSave(copy);
    };
    expect(bad({ building: 3, aware: 0.2, hideSpot: 1 })).toBe(true);
    expect(bad({ building: -2 })).toBe(false);
    expect(bad({ building: 1.5 })).toBe(false);
    expect(bad({ aware: 'x' })).toBe(false);
    expect(bad({ hideSpot: 0.5 })).toBe(false);
  });
});
