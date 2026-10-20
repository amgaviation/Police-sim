import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, Rig, actor } from './helpers';

/** A barricade with a subject in the house and a held hostage; an ambulance on scene. */
function standoff(): Rig {
  const rig = new Rig({ family: 'barricade', flags: [] });
  rig.openCall('barricadedSubject');
  rig.fakes.participants.push({ role: 'subject', personId: 300, actorId: 60, injured: false, deceased: false });
  rig.fakes.participants.push({ role: 'hostage', personId: 301, actorId: 61, injured: true, deceased: false });
  rig.fakes.actors.set(60, actor(60, 300, 'subject', rig.incident.x + 3, rig.incident.z));
  rig.fakes.actors.set(61, actor(61, 301, 'hostage', rig.incident.x + 31.5, rig.incident.z));
  rig.sys.request({ kind: 'establish' });
  rig.run(1);
  rig.addUnit('MEDIC-1');
  rig.fakes.onScene.set('ems', ['MEDIC-1']);
  return rig;
}

describe('EMS on a scene with a free subject', () => {
  it('does not tag or transport a held hostage while the subject is at large', () => {
    const rig = standoff();
    rig.run(COMMAND_CONFIG.triage.aiAssessS + COMMAND_CONFIG.transport.loadS + 60);
    expect(rig.fakes.transported).toEqual([]);
    expect(rig.sys.board().victims.every((v) => v.tag === null && !v.transported)).toBe(true);
  });

  it('works the patients once the subject is in custody', () => {
    const rig = standoff();
    rig.run(30);
    expect(rig.fakes.transported).toEqual([]);
    rig.fakes.flags.add('custody:subject');
    rig.run(COMMAND_CONFIG.triage.aiAssessS * 2 + COMMAND_CONFIG.transport.loadS + 5);
    expect(rig.fakes.transported).toHaveLength(1);
  });

  it('a mass-casualty scene is worked at once', () => {
    const rig = new Rig();
    rig.openCall();
    const ids = rig.victims(['victim', 'victim']);
    rig.sys.request({ kind: 'establish' });
    rig.run(1);
    rig.addUnit('MEDIC-1');
    rig.fakes.onScene.set('ems', ['MEDIC-1']);
    rig.run(COMMAND_CONFIG.triage.aiAssessS + 1);
    expect(rig.sys.board().victims.some((v) => v.tag !== null)).toBe(true);
    expect(ids).toHaveLength(2);
  });
});
