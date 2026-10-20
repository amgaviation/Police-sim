import { describe, expect, it } from 'vitest';
import { PURSUIT_CONFIG } from '../../src/pursuit/data';
import { classifyContact, pitPolicy } from '../../src/pursuit/pit';
import type { CarPose, PursuitConfig } from '../../src/pursuit/types';
import { MPH } from '../../src/world/constants';

const HL = 2.3;
const HW = 0.9;

/** Suspect at the origin facing -Z. */
function suspect(mph: number, yaw = 0): CarPose {
  return { x: 0, z: 0, yaw, speed: mph * MPH, halfLength: HL, halfWidth: HW };
}

/** A police car whose front centre sits at (fx, fz) with the given yaw and speed. */
function police(fx: number, fz: number, yaw: number, mph: number): CarPose {
  const x = fx + Math.sin(yaw) * HL;
  const z = fz + Math.cos(yaw) * HL;
  return { x, z, yaw, speed: mph * MPH, halfLength: HL, halfWidth: HW };
}

describe('classifyContact', () => {
  it('classifies a textbook rear-quarter push on the right side as a PIT with dir +1', () => {
    const r = classifyContact(police(0.6, 1.84, 0, 38), suspect(35));
    expect(r.kind).toBe('pit');
    expect(r.dir).toBe(1);
    expect(r.reasons).toEqual([]);
    expect(r.relMph).toBeCloseTo(3, 5);
  });

  it('classifies the left rear quarter as a PIT with dir -1', () => {
    const r = classifyContact(police(-0.6, 1.84, 0, 36), suspect(35));
    expect(r.kind).toBe('pit');
    expect(r.dir).toBe(-1);
  });

  it('accepts a push at a small angle and rejects a large one', () => {
    const small = classifyContact(police(0.6, 1.84, (20 * Math.PI) / 180, 38), suspect(35));
    expect(small.kind).toBe('pit');
    const big = classifyContact(police(0.6, 1.84, (50 * Math.PI) / 180, 38), suspect(35));
    expect(big.kind).not.toBe('pit');
    expect(big.reasons).toContain('Headings not aligned');
  });

  it('classifies a T-bone at speed as a ram, not a PIT', () => {
    // The police car faces +X and hits the suspect's left side amidships, both doing 30 mph.
    const r = classifyContact(police(-HW, 0, -Math.PI / 2, 30), suspect(30));
    expect(r.kind).toBe('ram');
    expect(r.relMph).toBeCloseTo(30 * Math.SQRT2, 3);
    expect(r.reasons).toContain('Contact not at the rear quarter');
    expect(r.reasons).toContain('Headings not aligned');
  });

  it('classifies a head-on contact as a ram', () => {
    const r = classifyContact(police(0, -HL, Math.PI, 30), suspect(30));
    expect(r.kind).toBe('ram');
    expect(r.relMph).toBeCloseTo(60, 5);
  });

  it('refuses a PIT on a suspect that is too fast and says why', () => {
    const r = classifyContact(police(0.6, 1.84, 0, 62), suspect(60));
    expect(r.kind).toBe('bump');
    expect(r.reasons).toEqual(['Suspect above 45 mph']);
  });

  it('refuses a PIT on a suspect that is too slow: a low-speed rear tap is a bump', () => {
    const r = classifyContact(police(0.6, 1.84, 0, 12), suspect(10));
    expect(r.kind).toBe('bump');
    expect(r.reasons).toEqual(['Suspect below 20 mph']);
  });

  it('refuses a push that is too centred or too far forward', () => {
    expect(classifyContact(police(0.1, 1.84, 0, 36), suspect(35)).reasons).toEqual(['Contact too close to the centreline']);
    expect(classifyContact(police(0.6, 0.2, 0, 36), suspect(35)).reasons).toEqual(['Contact not at the rear quarter']);
  });

  it('refuses a push with a high closing speed (bump below ramMph, ram at it)', () => {
    const bump = classifyContact(police(0.6, 1.84, 0, 55), suspect(35));
    expect(bump.kind).toBe('bump');
    expect(bump.reasons).toEqual(['Closing speed too high']);
    const ram = classifyContact(police(0.6, 1.84, 0, 61), suspect(35));
    expect(ram.kind).toBe('ram');
  });

  it('is none when the cars are nowhere near each other', () => {
    expect(classifyContact(police(30, 40, 0, 35), suspect(35)).kind).toBe('none');
  });

  it('follows the tuning', () => {
    const cfg: PursuitConfig = { ...PURSUIT_CONFIG, pit: { ...PURSUIT_CONFIG.pit, maxMph: 70 } };
    expect(classifyContact(police(0.6, 1.84, 0, 62), suspect(60), cfg).kind).toBe('pit');
  });
});

describe('pitPolicy', () => {
  const ok = { speedMph: 35, offense: 'violent', authorized: true, modelId: 'sedan', district: 'suburbs', wet: false };

  it('is within policy when every condition holds', () => {
    expect(pitPolicy(ok)).toEqual({ verdict: 'withinPolicy', reasons: [] });
  });

  it('flags speed above maxMph', () => {
    const r = pitPolicy({ ...ok, speedMph: 46 });
    expect(r.verdict).toBe('outsidePolicy');
    expect(r.reasons).toEqual(['speed above 45 mph']);
    expect(pitPolicy({ ...ok, speedMph: 45 }).verdict).toBe('withinPolicy');
  });

  it('flags an offense that does not allow a PIT, or an unknown one', () => {
    expect(pitPolicy({ ...ok, offense: 'traffic' }).reasons).toEqual(['offense does not allow a PIT']);
    expect(pitPolicy({ ...ok, offense: null }).reasons).toEqual(['offense does not allow a PIT']);
    for (const offense of PURSUIT_CONFIG.pit.allowedOffenses) expect(pitPolicy({ ...ok, offense }).verdict).toBe('withinPolicy');
  });

  it('requires the supervisor authorization', () => {
    expect(pitPolicy({ ...ok, authorized: false }).reasons).toEqual(['no supervisor authorization']);
    const open: PursuitConfig = { ...PURSUIT_CONFIG, pit: { ...PURSUIT_CONFIG.pit, requiresAuthorization: false } };
    expect(pitPolicy({ ...ok, authorized: false }, open).verdict).toBe('withinPolicy');
  });

  it('forbids buses and box trucks', () => {
    expect(pitPolicy({ ...ok, modelId: 'city_bus' }).reasons).toEqual(['vehicle type not allowed']);
    expect(pitPolicy({ ...ok, modelId: 'box_truck' }).reasons).toEqual(['vehicle type not allowed']);
  });

  it('forbids a wet road in downtown or campus only', () => {
    expect(pitPolicy({ ...ok, wet: true, district: 'downtown' }).reasons).toEqual(['wet road in a congested district']);
    expect(pitPolicy({ ...ok, wet: true, district: 'campus' }).verdict).toBe('outsidePolicy');
    expect(pitPolicy({ ...ok, wet: true, district: 'suburbs' }).verdict).toBe('withinPolicy');
    expect(pitPolicy({ ...ok, wet: false, district: 'downtown' }).verdict).toBe('withinPolicy');
  });

  it('lists every violated condition', () => {
    const r = pitPolicy({ speedMph: 60, offense: 'traffic', authorized: false, modelId: 'city_bus', district: 'downtown', wet: true });
    expect(r.reasons).toHaveLength(5);
  });
});
