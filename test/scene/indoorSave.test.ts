/* The fixtures break the shipped JSON files on purpose, so they are mutated as untyped objects. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { describe, expect, it } from 'vitest';
import sceneJson from '../../src/data/scene/scene.json';
import { SCENE_CONFIG, parseSceneConfig } from '../../src/scene/data';
import { isCallOutcome, isSceneSave, type SceneSave } from '../../src/scene/save';
import type { CallOutcome } from '../../src/scene/types';
import { at, eventsOf, run } from './helpers';
import { makeIndoorRig, materialize, spawnBound } from './indoorHelpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe('scene.json indoor section', () => {
  it('is parsed, optional, and strict', () => {
    expect(SCENE_CONFIG.indoor).toEqual({ bindRadiusM: 60, knockAnswerS: [4, 10], noAnswerExigencyS: 60, canvassHits: 2 });
    const old = clone(sceneJson) as Json;
    delete old.indoor;
    expect(parseSceneConfig(old).indoor).toEqual(SCENE_CONFIG.indoor);
    const bad = clone(sceneJson) as Json;
    bad.indoor.knockAnswerS = [10, 4];
    expect(() => parseSceneConfig(bad)).toThrow(/scene\.json: indoor\.knockAnswerS/);
    const unknown = clone(sceneJson) as Json;
    unknown.indoor.mystery = 1;
    expect(() => parseSceneConfig(unknown)).toThrow(/indoor\.mystery/);
    const zero = clone(sceneJson) as Json;
    zero.indoor.bindRadiusM = 0;
    expect(() => parseSceneConfig(zero)).toThrow(/indoor\.bindRadiusM/);
  });
});

describe('scene save validation', () => {
  it('accepts a Phase 3 save (no building fields) and the new optional fields, rejects malformed ones', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', ['house', 'apartment']);
    materialize(r, id, 1);
    const save = clone(r.scene.serialize());
    expect(isSceneSave(save)).toBe(true);
    const entry = save.scenarios.find((s) => s.scenario.callId === id)!;
    expect(entry.buildingId).toBe(rt.buildingId);

    const phase3 = clone(save);
    for (const s of phase3.scenarios) {
      delete s.buildingId;
      delete s.hideSpots;
      delete s.knockedSim;
      delete s.answerDueSim;
      delete s.arrests;
    }
    expect(isSceneSave(phase3)).toBe(true);

    const mutate = (edit: (s: SceneSave) => void): boolean => {
      const copy = clone(save);
      edit(copy);
      return isSceneSave(copy);
    };
    const first = (s: SceneSave): NonNullable<SceneSave['scenarios'][number]> => s.scenarios.find((x) => x.scenario.callId === id)!;
    expect(mutate((s) => { first(s).buildingId = 1.5; })).toBe(false);
    expect(mutate((s) => { first(s).buildingId = -2; })).toBe(false);
    expect(mutate((s) => { first(s).hideSpots = [0]; })).toBe(false);
    expect(mutate((s) => { first(s).knockedSim = 'x' as unknown as number; })).toBe(false);
    expect(mutate((s) => { first(s).arrests = [{ personId: 1, buildingId: 2, room: 3 } as never]; })).toBe(false);
    expect(mutate((s) => { first(s).arrests = [{ personId: 1, buildingId: 2, room: 3, sim: 4 }]; })).toBe(true);
  });

  it('a restored Phase 3 scenario is outdoors (building -1) with empty indoor state', async () => {
    const r = await makeIndoorRig();
    const { id } = spawnBound(r, 'domesticDisturbance', ['house', 'apartment']);
    const save = clone(r.scene.serialize());
    for (const s of save.scenarios) {
      delete s.buildingId;
      delete s.hideSpots;
    }
    r.scene.restore(save, at(r.sim));
    const rt = r.scene.runtime(id)!;
    expect(rt.buildingId).toBe(-1);
    expect(rt.hideSpots.every((h) => h === -1)).toBe(true);
    expect(rt.arrests).toEqual([]);
    expect(rt.knockedSim).toBe(-1);
  });
});

describe('call outcome', () => {
  it('records the building, the entry basis and the case summary of a bound call', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', ['house', 'apartment'], (x) => x.scenario.participants.some((p) => p.role === 'victim'));
    materialize(r, id, 1);
    r.officer.building = rt.buildingId;
    run(r, 1);
    r.officer.building = -1;
    r.scene.request({ kind: 'clear', callId: id, disposition: 'handled' });
    run(r, 2);
    const outs = eventsOf<{ outcome: CallOutcome }>(r, 'scene:outcome').map((e) => e.outcome).filter((o) => o.callId === id);
    expect(outs).toHaveLength(1);
    const o = outs[0]!;
    expect(o.buildingId).toBe(rt.buildingId);
    expect(o.entry).toBe('none');
    expect(o.case).toMatchObject({ custodyComplete: false, bodycam: false });
    expect(o.case?.items).toBeGreaterThanOrEqual(0);
    expect(isCallOutcome(clone(o))).toBe(true);
    expect(isCallOutcome({ ...clone(o), buildingId: 'x' })).toBe(false);
    expect(isCallOutcome({ ...clone(o), entry: 5 })).toBe(false);
    expect(isCallOutcome({ ...clone(o), case: { items: 1 } })).toBe(false);
    expect(r.evidence.removed).toContain(id);
  });

  it('an outdoor call without the Phase 4 ports has the Phase 3 outcome shape', async () => {
    const r = await makeIndoorRig({ evidence: false });
    const id = r.scene.spawnCall('injuryCollision', at(r.sim), { x: r.player.x, z: r.player.z });
    materialize(r, id, 1);
    r.scene.request({ kind: 'clear', callId: id, disposition: 'handled' });
    run(r, 2);
    const o = eventsOf<{ outcome: CallOutcome }>(r, 'scene:outcome').map((e) => e.outcome).find((x) => x.callId === id)!;
    expect(o).toBeDefined();
    expect('buildingId' in o).toBe(false);
    expect('entry' in o).toBe(false);
    expect('case' in o).toBe(false);
  });
});
