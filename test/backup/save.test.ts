import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { emptyBackupSave, isBackupSave, type BackupSave } from '../../src/backup/save';
import { clearOrder } from '../../src/backup/swat';
import { generateInterior } from '../../src/interior/generate';
import { ACTOR_STATE } from '../../src/npc/types';
import { cityBuildings, indexFor, SEED as CITY_SEED } from '../interior/helpers';
import { DT, NO_MISTAKES, Rig, SEED, START_FATIGUE, START_STRESS, findCallsigns, prepare } from './helpers';

const CLEAN = findCallsigns(3, SEED, START_STRESS, START_FATIGUE, NO_MISTAKES);
const STRESSED = findCallsigns(1, SEED, 0.9, 0.9, (r) => r.lateCallout && r.poorPosition)[0] as string;

/** A busy scene: cover, secondary and standby officers, a passenger who flees, a weapon, posts, SWAT. */
function busy(): Rig {
  const rig = new Rig();
  rig.openCall();
  rig.ctx.contactPersonId = 101;
  rig.npc.add({ id: 1, personId: 101, role: 'subject', x: 0, z: -3 });
  rig.npc.add({ id: 2, personId: 102, role: 'passenger', x: 5, z: -1 });
  rig.npc.outcome = 'flee';
  prepare(rig, STRESSED, 0.9, 0.9);
  rig.unitOnScene(STRESSED, 12, 6, 0);
  rig.unitOnScene(CLEAN[0] as string, 14, 6, 0);
  rig.unitOnScene(CLEAN[1] as string, 16, 6, 0);
  return rig;
}

/** Same inputs every step: the runner runs, the weapon comes out at 9 s, a post is staffed at 14 s. */
function drive(rig: Rig, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const runner = rig.npc.actors.get(2)!;
    if (runner.state === ACTOR_STATE.flee) runner.x += 2.5 * DT;
    if (i === 60 * 9) rig.npc.actors.get(1)!.weaponDrawn = true;
    if (i === 60 * 14) rig.sys.staffPost({ id: 'in1', x: 25, z: 10, yaw: 0, kind: 'inner' });
    rig.step();
  }
}

const fingerprint = (rig: Rig): string => JSON.stringify([rig.sys.serialize(), rig.events, Array.from(rig.sys.view.x), Array.from(rig.sys.view.z), Array.from(rig.sys.view.pose), rig.sys.view.count]);

describe('determinism', () => {
  it('two 1500-step runs are identical', () => {
    const a = busy();
    const b = busy();
    drive(a, 0, 1500);
    drive(b, 0, 1500);
    expect(fingerprint(a)).toBe(fingerprint(b));
    // and something actually happened
    expect(a.events.length).toBeGreaterThan(5);
    expect(a.of('backup:custody').length).toBe(1);
  });

  it('two SWAT runs are identical', () => {
    const run = (): string => {
      const rig = swatScene();
      rig.sys.request({ kind: 'swat', callId: rig.callId, command: 'stack', plan: { tempo: 'dynamic' } });
      for (let i = 0; i < 1500; i++) {
        rig.step();
        if (i === 60 * 12) rig.sys.request({ kind: 'swat', callId: rig.callId, command: 'clear' });
      }
      return fingerprint(rig);
    };
    expect(run()).toBe(run());
  });
});

describe('save and restore', () => {
  it('round-trips through JSON and passes the validator', () => {
    const rig = busy();
    drive(rig, 0, 60 * 20);
    const s = rig.sys.serialize();
    expect(s.officers.length).toBe(3);
    expect(s.version).toBe(1);
    expect(isBackupSave(s)).toBe(true);
    const copy = JSON.parse(JSON.stringify(s)) as BackupSave;
    expect(isBackupSave(copy)).toBe(true);
    expect(copy).toEqual(s);
    const twin = busy();
    drive(twin, 0, 60 * 20);
    twin.sys.restore(copy);
    expect(twin.sys.serialize()).toEqual(s);
  });

  it('a restored system continues exactly like the original', () => {
    const a = busy();
    const b = busy();
    drive(a, 0, 60 * 16);
    drive(b, 0, 60 * 16);
    b.sys.restore(JSON.parse(JSON.stringify(a.sys.serialize())) as BackupSave);
    drive(a, 60 * 16, 1500);
    drive(b, 60 * 16, 1500);
    expect(JSON.stringify(b.sys.serialize())).toBe(JSON.stringify(a.sys.serialize()));
    expect(JSON.stringify(b.events.slice(-12))).toBe(JSON.stringify(a.events.slice(-12)));
    expect(Array.from(b.sys.view.x)).toEqual(Array.from(a.sys.view.x));
    expect(b.sys.officers().map((o) => o.state)).toEqual(a.sys.officers().map((o) => o.state));
  });

  it('restores the rng stream so later picks match', () => {
    const a = busy();
    drive(a, 0, 60 * 10);
    const s = a.sys.serialize();
    const probe = createRng(1);
    probe.restore(s.rng);
    expect(probe.next()).toBe(a.rng.next());
  });

  it('saves pending callouts, posts and queued requests', () => {
    const rig = busy();
    drive(rig, 0, 60 * 14 + 5);
    rig.sys.request({ kind: 'command', callsign: 'all', command: 'standby' });
    const s = rig.sys.serialize();
    expect(s.requests).toEqual([{ kind: 'command', callsign: 'all', command: 'standby' }]);
    expect(s.officers.some((o) => o.post !== null)).toBe(true);
    expect(s.officers.some((o) => o.calledOut.length > 0)).toBe(true);
    expect(isBackupSave(JSON.parse(JSON.stringify(s)))).toBe(true);
    // a pending callout survives
    const rig2 = busy();
    drive(rig2, 0, 60 * 9 + 20);
    const s2 = rig2.sys.serialize();
    expect(s2.pendingCallouts.length).toBeGreaterThan(0);
    const twin = busy();
    drive(twin, 0, 60 * 9 + 20);
    twin.sys.restore(JSON.parse(JSON.stringify(s2)) as BackupSave);
    drive(twin, 60 * 9 + 20, 60 * 14);
    drive(rig2, 60 * 9 + 20, 60 * 14);
    expect(twin.of('backup:callout')).toEqual(rig2.of('backup:callout'));
  });

  it('restoring an empty save clears everything', () => {
    const rig = busy();
    drive(rig, 0, 60 * 10);
    rig.sys.restore(emptyBackupSave(rig.rng.state()));
    expect(rig.sys.officers().length).toBe(0);
    expect(rig.sys.view.count).toBe(0);
    expect(rig.sys.onFoot(STRESSED)).toBe(false);
  });
});

function swatScene(): Rig {
  const index = indexFor();
  const info = cityBuildings(index, 3).find((b) => b.kind === 'house')!;
  const layout = generateInterior(CITY_SEED, info)!;
  const rig = new Rig({ seed: 3 });
  rig.openCall();
  rig.buildings.set(info.id, { minX: info.minX, minZ: info.minZ, maxX: info.maxX, maxZ: info.maxZ, door: info.door });
  rig.interiors.layouts.set(info.id, layout);
  rig.callBuildingId = info.id;
  rig.swatCount = 1;
  rig.ctx.x = info.door.x;
  rig.ctx.z = info.door.z;
  rig.unitOnScene('TAC-1', info.door.x + 5, info.door.z + 20, 0, 'resource');
  const main = layout.doors.find((d) => d.main)!;
  const order = clearOrder(layout, main.a);
  const r = layout.rooms[order[order.length - 1]!]!.rect;
  rig.npc.add({ id: 7, personId: 555, role: 'subject', building: info.id, x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2, state: ACTOR_STATE.armed, weaponDrawn: true });
  return rig;
}

describe('SWAT save', () => {
  it('restores the team phase, plan, rooms and operator positions and finishes the same way', () => {
    const a = swatScene();
    const b = swatScene();
    for (const rig of [a, b]) {
      rig.sys.request({ kind: 'swat', callId: rig.callId, command: 'stack', plan: { tempo: 'dynamic', lessLethal: true } });
      rig.step(60 * 40);
      rig.sys.request({ kind: 'swat', callId: rig.callId, command: 'clear' });
      rig.step(60 * 7);
    }
    expect(a.sys.swatPhase(a.callId)).toBe('clearing');
    const s = a.sys.serialize();
    expect(s.swat).not.toBeNull();
    expect(s.swat!.phase).toBe('clearing');
    expect(s.swat!.rooms.length).toBeGreaterThan(1);
    expect(s.swat!.ops.length).toBe(4);
    expect(s.swat!.plan).toEqual({ entry: 'front', tempo: 'dynamic', lessLethal: true });
    expect(isBackupSave(JSON.parse(JSON.stringify(s)))).toBe(true);
    b.sys.restore(JSON.parse(JSON.stringify(s)) as BackupSave);
    expect(b.sys.serialize().swat).toEqual(s.swat);
    expect(b.sys.view.count).toBe(12);
    a.step(60 * 100);
    b.step(60 * 100);
    expect(a.sys.swatPhase(a.callId)).toBe('done');
    expect(b.sys.swatPhase(b.callId)).toBe('done');
    const lines = (r: Rig): string[] => r.of<{ text: string }>('backup:swat').map((e) => e.text);
    expect(lines(b).slice(-6)).toEqual(lines(a).slice(-6));
    expect(b.of('backup:custody')).toEqual(a.of('backup:custody'));
  });
});

describe('isBackupSave', () => {
  const base = (): BackupSave => busyAfter();
  function busyAfter(): BackupSave {
    const rig = busy();
    drive(rig, 0, 60 * 10);
    return rig.sys.serialize();
  }

  it('accepts an empty save', () => {
    expect(isBackupSave(emptyBackupSave(createRng(1).state()))).toBe(true);
  });

  it('rejects malformed input', () => {
    const ok = base();
    expect(isBackupSave(ok)).toBe(true);
    type Loose = { officers: Record<string, unknown>[] } & Record<string, unknown>;
    const bad = (mutate: (s: Loose) => void): boolean => {
      const s = JSON.parse(JSON.stringify(ok)) as Loose;
      mutate(s);
      return isBackupSave(s);
    };
    expect(isBackupSave(null)).toBe(false);
    expect(isBackupSave({})).toBe(false);
    expect(bad((s) => { s.version = 2; })).toBe(false);
    expect(bad((s) => { s.rng = { seed: 1 }; })).toBe(false);
    expect(bad((s) => { s.officers = {} as never; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.fsm = { state: 'flying', role: 'cover', timer: 0 }; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.fsm = { state: 'cover', role: 'boss', timer: 0 }; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.mistakes = [true, false]; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.sideSign = 0; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.x = Number.NaN; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.calledOut = [[1, 2, 3]]; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.post = { id: 'p' }; })).toBe(false);
    expect(bad((s) => { s.officers[0]!.rt = { goal: [1, 2] }; })).toBe(false);
    expect(bad((s) => { s.pendingCallouts = [{ callsign: 'x' }]; })).toBe(false);
    expect(bad((s) => { s.requests = [{ kind: 'dance' }]; })).toBe(false);
    expect(bad((s) => { s.requests = [{ kind: 'command', callsign: 'x', command: 'sit' }]; })).toBe(false);
    expect(bad((s) => { s.swat = { callId: 1 }; })).toBe(false);
    expect(bad((s) => { delete s.officers[0]!.rt; })).toBe(true);
  });

  it('restores a hand-made save without the runtime block', () => {
    const rig = busy();
    drive(rig, 0, 60 * 10);
    const s = JSON.parse(JSON.stringify(rig.sys.serialize())) as BackupSave;
    for (const o of s.officers) delete o.rt;
    expect(isBackupSave(s)).toBe(true);
    const twin = busy();
    twin.sys.restore(s);
    twin.step(60 * 5);
    expect(twin.sys.officers().length).toBe(3);
  });
});
