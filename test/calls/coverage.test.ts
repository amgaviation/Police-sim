import { describe, expect, it } from 'vitest';
import { CALL_TYPES, findCallType } from '../../src/cad/data';
import { familyForType } from '../../src/calls/catalog';
import { REQUIRED_TYPES } from './expected';

describe('required call types (design 18)', () => {
  it('has every requirement type as a CAD call type', () => {
    for (const id of REQUIRED_TYPES) expect(findCallType(id), id).not.toBeNull();
  });

  it('maps every requirement type to a scene family except the officer calls', () => {
    for (const id of REQUIRED_TYPES) expect(familyForType(id), id).not.toBeNull();
    expect(familyForType('officerAssist')).toBeNull();
    expect(familyForType('officerEmergency')).toBeNull();
    expect(familyForType('officerWelfare')).toBeNull();
  });

  it('keeps the generator weights sane (generated types have a positive weight; pursuit and contact are manual)', () => {
    for (const t of CALL_TYPES) if (t.generated) expect(t.weight, t.id).toBeGreaterThan(0);
    for (const id of ['vehiclePursuit', 'footPursuit', 'pedestrianStop', 'fieldInterview', 'funeralEscort']) {
      const t = findCallType(id);
      expect(t?.generated, id).toBe(false);
      expect(t?.weight, id).toBe(0);
    }
    expect(CALL_TYPES.filter((t) => t.generated).length).toBeGreaterThan(150);
  });

  it('uses the tens codes the design lists for pursuit and shots fired', () => {
    expect(findCallType('vehiclePursuit')?.codeKey).toBe('pursuit');
    expect(findCallType('shotsFired')?.codeKey).toBe('shotsFired');
    expect(findCallType('driveByShooting')?.codeKey).toBe('shotsFired');
    expect(findCallType('overdose')?.codeKey).toBe('ems');
    expect(findCallType('injuryCollision')?.codeKey).toBe('collision');
  });

  it('keeps the design locations of the special types', () => {
    expect(findCallType('personOnLedge')?.location).toBe('poi:harbor');
    expect(findCallType('gasDriveOff')?.location).toBe('poi:fuel');
    expect(findCallType('trespassSchoolGrounds')?.location).toBe('poi:school');
    expect(findCallType('schoolThreat')?.location).toBe('poi:school');
    expect(findCallType('parkingLotCollision')?.location).toBe('block');
    expect(findCallType('bombThreat')?.location).toBe('block');
  });
});
