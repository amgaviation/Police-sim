import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, Rig } from './helpers';

function tagAll(rig: Rig, ids: number[], tag: 'immediate' | 'delayed' | 'minor'): void {
  for (const id of ids) rig.sys.request({ kind: 'tag', personId: id, tag });
}

describe('ambulance shuttle', () => {
  function mci(): { rig: Rig; ids: number[] } {
    const rig = new Rig();
    rig.openCall();
    const ids = rig.victims(['victim', 'victim', 'victim', 'victim']);
    rig.run(1);
    tagAll(rig, ids, 'immediate');
    rig.run(0.5);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    return { rig, ids };
  }

  it('calls the next ambulance by itself once the first one left with a patient and more wait', () => {
    const { rig } = mci();
    rig.run(COMMAND_CONFIG.transport.loadS + 1);
    expect(rig.fakes.transported).toHaveLength(1);
    expect(rig.fakes.onScene.get('ems')).toEqual([]);
    rig.run(1);
    const asked = rig.fakes.requested.filter((r) => r.typeId === 'ems');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ callId: rig.callId, via: 'auto' });
  });

  it('is rate limited while no ambulance is on scene and stops when nobody waits', () => {
    const { rig } = mci();
    rig.run(COMMAND_CONFIG.transport.loadS + 1);
    rig.run(60);
    const n = rig.fakes.requested.filter((r) => r.typeId === 'ems').length;
    // One request every 20 s at most.
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(5);
    // An ambulance on scene: no more requests.
    rig.addUnit('MEDIC-2');
    rig.fakes.onScene.set('ems', ['MEDIC-2']);
    rig.run(1);
    const after = rig.fakes.requested.length;
    rig.run(10);
    expect(rig.fakes.requested.length).toBe(after);
  });

  it('does not ask for EMS before any patient was transported', () => {
    const rig = new Rig();
    rig.openCall();
    const ids = rig.victims(['victim', 'victim']);
    rig.run(1);
    tagAll(rig, ids, 'immediate');
    rig.run(120);
    expect(rig.fakes.requested.filter((r) => r.typeId === 'ems')).toHaveLength(0);
  });

  it('the timer survives a save and load', () => {
    const { rig } = mci();
    rig.run(COMMAND_CONFIG.transport.loadS + 2);
    const saved = rig.sys.serialize();
    expect(saved.shuttleT).toBeGreaterThan(0);
    const clone = JSON.parse(JSON.stringify(saved)) as typeof saved;
    expect(clone.shuttleT).toBe(saved.shuttleT);
  });
});
