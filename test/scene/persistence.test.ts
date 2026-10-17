import { describe, expect, it } from 'vitest';
import { emptySceneSave, isSceneSave, type SceneSave } from '../../src/scene/save';
import { createRng } from '../../src/core/rng';
import { at, engage, makeRig, run, spawnWhere, type SceneRig } from './helpers';

function json<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function state(r: SceneRig): unknown {
  return {
    scene: r.scene.serialize(),
    npc: r.npc.serialize(),
    people: r.people.serialize(),
    cad: r.cad.serialize(),
    dispatch: r.dispatcher.serialize(),
  };
}

/** A fresh world restored from `a` (load order: traffic, CAD, records, people, dispatcher, npc, scene). */
async function restoredFrom(a: SceneRig): Promise<SceneRig> {
  const saves = json({
    traffic: a.traffic.snapshot(),
    cad: a.cad.serialize(),
    records: a.records.serialize(),
    people: a.people.serialize(),
    dispatch: a.dispatcher.serialize(),
    npc: a.npc.serialize(),
    scene: a.scene.serialize(),
  });
  const b = await makeRig({ start: false, player: { x: a.player.x, z: a.player.z } });
  b.sim = a.sim;
  b.officer.yaw = a.officer.yaw;
  b.traffic.restore(saves.traffic);
  b.cad.restore(saves.cad);
  b.records.restore(saves.records);
  b.people.restore(saves.people);
  b.dispatcher.restore(saves.dispatch, at(a.sim));
  b.npc.restore(saves.npc);
  b.scene.restore(saves.scene, at(a.sim));
  return b;
}

describe('scene save', () => {
  it('an empty save validates and a live one round trips through JSON', async () => {
    const empty = emptySceneSave(createRng(7).stream('scene').state());
    expect(isSceneSave(empty)).toBe(true);
    expect(empty.scenarios).toEqual([]);
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    engage(r, id, 30, 3);
    r.scene.request({ kind: 'weapon' });
    const save = json(r.scene.serialize());
    expect(isSceneSave(save)).toBe(true);
    expect(save.scenarios).toHaveLength(1);
    expect(save.queue).toEqual([{ kind: 'weapon' }]);
    expect(save.scenarios[0]?.materialized).toBe(true);
  });

  it('rejects malformed blocks', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    engage(r, id, 30, 2);
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    const save = json(r.scene.serialize());
    const bad: ((s: SceneSave) => void)[] = [
      (s) => ((s as { version: number }).version = 2),
      (s) => (s.rng = { seed: 1, s: [1, 2, 3] as unknown as [number, number, number, number] }),
      (s) => ((s as { officerWeapon: string }).officerWeapon = 'bazooka'),
      (s) => (s.scenarios[0]!.actorIds = []),
      (s) => (s.scenarios[0]!.timelineIdx = 999),
      (s) => ((s.scenarios[0]!.scenario as { version: number }).version = 3),
      (s) => ((s.scenarios[0]!.scenario.anchor as { side: number }).side = 0),
      (s) => (s.scenarios[0]!.actions = [{ id: 'knock', state: 'flying' as never, dueSim: 0 }]),
      (s) => (s.scenarios.push(json(s.scenarios[0]!))),
      (s) => (s.queue = [{ kind: 'boom' } as never]),
      (s) => (s.pursuits = [{ kind: 'air', callId: 1, vehicleId: 1, actorId: 0, startedSim: 0, announced: true } as never]),
      (s) => (s.props = [{ x: 1, y: 0, z: 1, yaw: 0, kind: 0, callId: 1 }]),
      (s) => (s.closed = [{ callId: 1 } as never]),
      (s) => ((s as { eventQueue: unknown }).eventQueue = [1]),
      (s) => (s.ignored = [0]),
    ];
    for (const mutate of bad) {
      const copy = json(save);
      mutate(copy);
      expect(isSceneSave(copy)).toBe(false);
    }
    expect(isSceneSave(null)).toBe(false);
    expect(isSceneSave({})).toBe(false);
  });

  it('accepts the bare design shape (no mirror, ignored, slowTick or ack timers) and fills defaults', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 0.3);
    const save = json(r.scene.serialize()) as Record<string, unknown> & SceneSave;
    delete save.ignored;
    delete save.slowTick;
    for (const s of save.scenarios) {
      delete s.mirror;
      for (const svc of s.services) delete svc.ackDueSim;
    }
    expect(isSceneSave(save)).toBe(true);
    r.scene.restore(save, at(r.sim));
    const again = json(r.scene.serialize());
    expect(again.ignored).toEqual([]);
    expect(again.slowTick).toBe(-1);
    expect(again.scenarios[0]?.mirror).toEqual([]);
    expect(again.scenarios[0]?.services[0]?.ackDueSim).toBe(-1);
    run(r, 1);
    expect(r.scene.runtime(id)).not.toBeNull();
  });

  it('restoring an invalid block changes nothing', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    engage(r, id, 30, 2);
    const before = json(r.scene.serialize());
    r.scene.restore({ version: 9 } as unknown as SceneSave, at(r.sim));
    expect(json(r.scene.serialize())).toEqual(before);
  });
});

describe('continuation and determinism', () => {
  it('an active scene continues identically after save and load (queued request included)', async () => {
    const a = await makeRig();
    const id = spawnWhere(a, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    engage(a, id, 30, 3);
    a.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    a.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
    run(a, 0.5);
    a.scene.request({ kind: 'action', callId: id, actionId: 'canvass' });
    const b = await restoredFrom(a);
    expect(state(b)).toEqual(state(a));
    for (let i = 0; i < 40 * 60; i++) {
      run(a, 1 / 60);
      run(b, 1 / 60);
    }
    expect(state(b)).toEqual(state(a));
    // The canvass finished and the EMS request ran its course in both worlds.
    expect(a.scene.runtime(id)?.flags.has('canvassed')).toBe(true);
    expect(b.scene.runtime(id)?.flags.has('canvassed')).toBe(true);
  });

  it('the same seed and the same requests give the same scene save', async () => {
    const make = async (): Promise<unknown> => {
      const r = await makeRig();
      const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
      engage(r, id, 30, 2);
      r.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
      run(r, 1);
      r.scene.request({ kind: 'weapon' });
      r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
      run(r, 30);
      return json(r.scene.serialize());
    };
    expect(await make()).toEqual(await make());
  });

  it('scenarios of a call that is gone are dropped on restore, and adoptOpenCalls builds missing ones', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', NOT_FALSE);
    run(r, 1);
    const save = json(r.scene.serialize());
    r.cad.closeCall(id, 'cancelled', at(r.sim));
    r.scene.restore(save, at(r.sim));
    expect(r.scene.runtime(id)).toBeNull();
    // A fresh scene (a v4 save) adopts the open calls it never saw.
    const other = await makeRig();
    const call = other.dispatcher.createCall('loudParty', at(0), { x: other.player.x, z: other.player.z })!;
    const empty = emptySceneSave(createRng(1).stream('scene').state());
    other.scene.restore(empty, at(0));
    other.scene.adoptOpenCalls(at(0));
    expect(other.scene.runtime(call.id)).not.toBeNull();
    expect(other.scene.runtime(call.id)?.scenario.family).toBe('disturbance');
    // Past timeline entries are skipped rather than replayed.
    const old = other.scene.runtime(call.id)!;
    other.scene.restore(emptySceneSave(createRng(1).stream('scene').state()), at(0));
    other.scene.adoptOpenCalls({ sim: 10000, game: 0 });
    expect(other.scene.runtime(call.id)?.timelineIdx).toBe(old.scenario.timeline.length);
  });
});
