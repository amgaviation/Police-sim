import { describe, expect, it } from 'vitest';
import {
  BODY,
  FIGURE_FLAG,
  HELD,
  POSE,
  PROP,
  PROP_BY_NAME,
  createHumanoidSource,
  createLimbPose,
  createPropSource,
  limbPose,
  type LimbPose,
} from '../../src/render/people/pose';

const out = (): LimbPose => createLimbPose();
const HALF_PI = Math.PI / 2;

describe('pose constants', () => {
  it('match the design table', () => {
    expect(POSE).toEqual({ stand: 0, walk: 1, run: 2, handsUp: 3, kneel: 4, prone: 5, cuffed: 6, seated: 7, aim: 8, fight: 9, lying: 10, sit: 11 });
    expect(HELD).toEqual({ none: 0, knife: 1, handgun: 2, bottle: 3, phone: 4, taser: 5, sidearm: 6 });
    expect(BODY).toEqual({ human: 0, dog: 1 });
    expect(FIGURE_FLAG).toEqual({ highlight: 1, hidden: 2 });
    expect(PROP).toEqual({ cone: 1, flare: 2, tape: 3, marker: 4, bottle: 5, bag: 6, knife: 7, handgun: 8, package: 9, casing: 10, glass: 11, note: 12 });
  });

  it('PROP_BY_NAME maps names to ids and knows nothing else', () => {
    for (const [name, id] of Object.entries(PROP)) expect(PROP_BY_NAME[name]).toBe(id);
    expect(PROP_BY_NAME['cone']).toBe(1);
    expect(PROP_BY_NAME['nope']).toBeUndefined();
    expect(Reflect.get(PROP_BY_NAME, 'toString')).toBeUndefined();
  });

  it('pose ids are unique', () => {
    const ids = Object.values(POSE);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('limbPose', () => {
  it('stands with every angle zero', () => {
    const p = limbPose(POSE.stand, 0.3, 0, out());
    for (const [k, v] of Object.entries(p)) expect(v, k).toBe(0);
  });

  it('walks with mirrored legs and arms opposite the same-side leg', () => {
    for (const g of [0, 0.1, 0.25, 0.4, 0.5, 0.75, 0.93, 1.25]) {
      const p = limbPose(POSE.walk, g, 1.4, out());
      expect(p.rightLeg).toBeCloseTo(-p.leftLeg, 10);
      expect(p.rightArm).toBeCloseTo(-p.leftArm, 10);
      // Half a cycle later the legs have swapped.
      const q = limbPose(POSE.walk, g + 0.5, 1.4, out());
      expect(q.leftLeg).toBeCloseTo(p.rightLeg, 10);
      expect(q.rightLeg).toBeCloseTo(p.leftLeg, 10);
      // Legs use the hip-extension sign (negative = thigh forward), arms positive = forward: same numeric sign
      // means opposite physical swing.
      expect(Math.sign(p.leftArm)).toBe(Math.sign(p.leftLeg));
    }
  });

  it('reaches the walk and run amplitudes at a quarter cycle', () => {
    const w = limbPose(POSE.walk, 0.25, 1.4, out());
    expect(w.leftLeg).toBeCloseTo(0.45, 10);
    expect(w.leftArm).toBeCloseTo(0.35, 10);
    const r = limbPose(POSE.run, 0.25, 5, out());
    expect(r.leftLeg).toBeCloseTo(0.9, 10);
    expect(r.leftArm).toBeCloseTo(0.8, 10);
    expect(r.torsoPitch).toBeCloseTo(0.15, 10);
  });

  it('uses the fractional part of the gait', () => {
    const a = limbPose(POSE.walk, 0.2, 1.4, out());
    const b = limbPose(POSE.walk, 7.2, 1.4, out());
    expect(b.leftLeg).toBeCloseTo(a.leftLeg, 5);
  });

  it('does not swing limbs while standing still in a walking pose', () => {
    const p = limbPose(POSE.walk, 0.25, 0, out());
    expect(p.leftLeg).toBe(0);
    expect(p.leftArm).toBe(0);
  });

  it('raises both arms straight up for hands up, slightly out', () => {
    const p = limbPose(POSE.handsUp, 0, 0, out());
    // Arm hanging from the shoulder points along (0, -cos(pitch)): above the head when the pitch is past pi/2.
    for (const pitch of [p.leftArm, p.rightArm]) expect(-Math.cos(pitch)).toBeGreaterThan(0.99);
    expect(p.leftArmOut).toBeGreaterThan(0);
    expect(p.leftArmOut).toBe(p.rightArmOut);
    expect(p.leftArm).toBe(p.rightArm);
  });

  it('lays prone figures face down and lying figures face up, hips near the ground', () => {
    const prone = limbPose(POSE.prone, 0, 0, out());
    const lying = limbPose(POSE.lying, 0, 0, out());
    expect(prone.bodyPitch).toBeCloseTo(HALF_PI, 10);
    expect(lying.bodyPitch).toBeCloseTo(-HALF_PI, 10);
    // Standing hip height 0.85 m minus the drop is the hip pivot height: 0.12 m above the ground.
    expect(0.85 - prone.drop).toBeCloseTo(0.12, 10);
    expect(0.85 - lying.drop).toBeCloseTo(0.12, 10);
  });

  it('kneels on the knees: thighs vertical, shins folded back', () => {
    const p = limbPose(POSE.kneel, 0, 0, out());
    expect(p.leftKnee).toBeCloseTo(HALF_PI, 10);
    expect(p.rightKnee).toBeCloseTo(HALF_PI, 10);
    expect(p.leftLeg).toBe(0);
    expect(p.drop).toBeGreaterThan(0.3);
  });

  it('seats with the thighs forward and the knees bent, sit slightly lower', () => {
    const seated = limbPose(POSE.seated, 0, 0, out());
    const sit = limbPose(POSE.sit, 0, 0, out());
    expect(seated.leftLeg).toBeCloseTo(-HALF_PI, 10);
    expect(seated.rightKnee).toBeCloseTo(HALF_PI, 10);
    expect(seated.drop).toBeCloseTo(0.45, 10);
    expect(sit.drop).toBeCloseTo(0.5, 10);
    expect(sit.leftLeg).toBe(seated.leftLeg);
  });

  it('puts cuffed arms back and inward', () => {
    const p = limbPose(POSE.cuffed, 0, 0, out());
    expect(p.leftArm).toBeCloseTo(-0.5, 10);
    expect(p.rightArm).toBeCloseTo(-0.5, 10);
    expect(p.leftArmOut).toBeLessThan(0);
    expect(p.rightArmOut).toBeLessThan(0);
  });

  it('aims with the right arm forward and alternates the fight arms', () => {
    const aim = limbPose(POSE.aim, 0, 0, out());
    expect(aim.rightArm).toBeCloseTo(HALF_PI, 10);
    const a = limbPose(POSE.fight, 0.25, 0, out());
    const b = limbPose(POSE.fight, 0.75, 0, out());
    expect(a.leftArm).toBeGreaterThan(a.rightArm);
    expect(b.rightArm).toBeGreaterThan(b.leftArm);
    expect(Math.max(a.leftArm, a.rightArm)).toBeCloseTo(0.9, 10);
  });

  it('resets every field on each call and returns the same object', () => {
    const p = out();
    limbPose(POSE.prone, 0, 0, p);
    expect(limbPose(POSE.stand, 0, 0, p)).toBe(p);
    expect(p.bodyPitch).toBe(0);
    expect(p.drop).toBe(0);
    expect(p.headPitch).toBe(0);
  });

  it('is allocation free (same object, finite numbers for every pose)', () => {
    const p = out();
    for (const pose of Object.values(POSE)) {
      for (let g = 0; g < 2; g += 0.17) {
        limbPose(pose, g, 2, p);
        for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe('sources', () => {
  it('creates humanoid sources with defaults for height and build', () => {
    const s = createHumanoidSource(5);
    expect(s.count).toBe(0);
    expect(s.x.length).toBe(5);
    expect(s.anchor).toBeInstanceOf(Int32Array);
    expect(s.hair).toBeInstanceOf(Uint32Array);
    expect(s.height[3]).toBeCloseTo(1.75);
    expect(s.build[4]).toBe(1);
    s.count = 2;
    expect(s.count).toBe(2);
  });

  it('creates prop sources', () => {
    const s = createPropSource(3);
    expect(s.kind.length).toBe(3);
    expect(s.count).toBe(0);
    expect(createPropSource(-4).x.length).toBe(0);
  });
});
