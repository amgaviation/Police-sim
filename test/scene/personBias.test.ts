import { describe, expect, it } from 'vitest';
import { hashString } from '../../src/core/rng';
import { DISTRICT_NAMES } from '../../src/world/ids';
import { at, makeRig, run, type SceneRig } from './helpers';

const TYPES = ['burglaryInProgress', 'armedRobbery', 'wantedSubject', 'warrantService', 'noiseComplaint', 'fightInProgress', 'impairedDriver'];

function spawn(r: SceneRig, typeId: string): number {
  const id = r.scene.spawnCall(typeId, at(r.sim), { x: r.player.x, z: r.player.z }, []);
  if (id === 0) throw new Error(`no call for ${typeId}`);
  return id;
}

function people(r: SceneRig, id: number): [string, number][] {
  return r.scene.runtime(id)?.scenario.participants.map((p): [string, number] => [p.role, p.personId]) ?? [];
}

/** Spawns every type in order on a fresh rig and returns the participants of each call. */
async function baseline(setup?: (r: SceneRig) => void): Promise<{ rig: SceneRig; ids: number[]; text: string }> {
  const rig = await makeRig();
  setup?.(rig);
  const ids = TYPES.map((t) => spawn(rig, t));
  run(rig, 2);
  return { rig, ids, text: ids.map((id) => JSON.stringify(people(rig, id))).join('|') };
}

describe('scene person bias', () => {
  it('no bias is identical to Phase 7 (hash recorded before the hook existed)', async () => {
    const { text } = await baseline();
    expect([hashString(text), text.length]).toEqual([497835530, 354]);
  });

  it('a bias that returns -1, or an unfit or invalid id, falls through to the normal pick without changing it', async () => {
    const plain = await baseline();
    const none = await baseline((r) => r.scene.setPersonBias(() => -1));
    expect(none.text).toBe(plain.text);
    let asked = 0;
    const unfit = await baseline((r) =>
      r.scene.setPersonBias((_callId, _district, fits) => {
        asked++;
        for (let pid = 0; pid < 20000; pid++) if (!fits(pid)) return pid;
        return -1;
      }),
    );
    expect(asked).toBeGreaterThan(0);
    expect(unfit.text).toBe(plain.text);
    for (const bad of [Number.NaN, 1e9, 0.5]) {
      const r = await baseline((rig) => rig.scene.setPersonBias(() => bad));
      expect(r.text).toBe(plain.text);
    }
  });

  it('a fitting id from the bias is used for a warrant role, with the call id and district', async () => {
    const rig = await makeRig();
    const asked: { callId: number; district: string }[] = [];
    const given = new Set<number>();
    rig.scene.setPersonBias((callId, district, fits, draw) => {
      asked.push({ callId, district });
      const u = draw();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      for (let pid = 0; pid < 100000; pid++) {
        if (!given.has(pid) && fits(pid)) {
          given.add(pid);
          return pid;
        }
      }
      return -1;
    });
    const id = spawn(rig, 'wantedSubject');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0]?.callId).toBe(id);
    const call = rig.cad.call(id)!;
    expect(asked[0]?.district).toBe(DISTRICT_NAMES[rig.city.districtAt(call.location.x, call.location.z)]);
    const subject = people(rig, id).find(([role]) => role === 'subject');
    expect(subject).toBeDefined();
    expect(given.has(subject![1])).toBe(true);
    // The designated person has a warrant, as the role demands.
    expect(rig.records.peekPerson(subject![1]).warrants.length).toBeGreaterThan(0);
  });

  it('a bias is used for a risk role (an offender with no warrant)', async () => {
    const rig = await makeRig();
    const picked: number[] = [];
    rig.scene.setPersonBias((_callId, _district, fits) => {
      for (let pid = 50000; pid < 100000; pid++) {
        if (!picked.includes(pid) && fits(pid)) {
          picked.push(pid);
          return pid;
        }
      }
      return -1;
    });
    const id = spawn(rig, 'armedRobbery');
    expect(picked.length).toBeGreaterThan(0);
    const ids = people(rig, id).map(([, p]) => p);
    for (const p of picked) expect(ids).toContain(p);
  });

  it('is ignored for roles without risk or warrant', async () => {
    const rig = await makeRig();
    const asked: number[] = [];
    rig.scene.setPersonBias((callId) => {
      asked.push(callId);
      return 4242;
    });
    const quiet = spawn(rig, 'noiseComplaint');
    const welfare = spawn(rig, 'welfareCheck');
    expect(asked.filter((c) => c === quiet || c === welfare)).toEqual([]);
    expect(people(rig, quiet).map(([, p]) => p)).not.toContain(4242);
    expect(people(rig, welfare).map(([, p]) => p)).not.toContain(4242);
  });

  it('setPersonBias(null) removes the hook', async () => {
    const plain = await baseline();
    const removed = await baseline((r) => {
      r.scene.setPersonBias(() => 7);
      r.scene.setPersonBias(null);
    });
    expect(removed.text).toBe(plain.text);
  });
});
