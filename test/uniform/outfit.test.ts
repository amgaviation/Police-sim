import { describe, expect, it } from 'vitest';
import { UNIFORM_DATA } from '../../src/uniform/data';
import { aiOutfitSpec, buildOutfit, defaultOutfitSpec, uniformAllowed } from '../../src/uniform/outfit';
import { ATTACH, CARRIER_IDS, COLD_IDS, HAIR_STYLES, HAT_IDS, MAX_OUTFIT_BOXES, RANK_IDS, SKIN_SHINS, UNIFORM_CLASSES } from '../../src/uniform/types';
import type { AccessoryBox, OutfitSpec, RankId, UniformClass } from '../../src/uniform/types';

function build(spec: OutfitSpec, rank: RankId = 'officer') {
  return buildOutfit(spec, { lastName: 'Doe', rank });
}

function sized(boxes: readonly AccessoryBox[], sx: number, sy: number, sz: number): AccessoryBox[] {
  return boxes.filter((b) => b.sx === sx && b.sy === sy && b.sz === sz);
}

function isColor(c: number): boolean {
  return Number.isInteger(c) && c >= 0 && c <= 0xffffff;
}

describe('buildOutfit', () => {
  it('is deterministic', () => {
    for (const u of UNIFORM_CLASSES) {
      const spec = defaultOutfitSpec(u);
      expect(build(spec, 'captain')).toEqual(build(spec, 'captain'));
    }
  });

  it('builds the id from the spec', () => {
    const spec = defaultOutfitSpec('classB');
    expect(build(spec, 'sergeant').id).toBe('classB/default/default/none/short/sergeant/true');
  });

  it('uses the class colours from the data, or the override', () => {
    for (const cls of UNIFORM_DATA.classes) {
      const o = build(defaultOutfitSpec(cls.id));
      expect(o.top).toBe(cls.top);
      expect(o.bottom).toBe(cls.bottom);
    }
    const spec = defaultOutfitSpec('classB');
    spec.colors = { top: 0x112233, bottom: 0x445566 };
    const o = build(spec);
    expect([o.top, o.bottom]).toEqual([0x112233, 0x445566]);
  });

  it('draws rank insignia: sergeant 6 chevrons, lieutenant 2 bars, chief 6 stars', () => {
    const spec = defaultOutfitSpec('classB');
    const arm = (b: AccessoryBox) => b.attach === ATTACH.leftArm || b.attach === ATTACH.rightArm;
    const sergeant = build(spec, 'sergeant').boxes;
    expect(sized(sergeant, 0.012, 0.02, 0.08).filter(arm)).toHaveLength(6);
    expect(sized(build(spec, 'corporal').boxes, 0.012, 0.02, 0.08)).toHaveLength(4);
    expect(sized(build(spec, 'officer').boxes, 0.012, 0.02, 0.08)).toHaveLength(0);
    expect(sized(build(spec, 'lieutenant').boxes, 0.04, 0.012, 0.012)).toHaveLength(2);
    expect(sized(build(spec, 'captain').boxes, 0.04, 0.012, 0.012)).toHaveLength(4);
    expect(sized(build(spec, 'chief').boxes, 0.025, 0.025, 0.012)).toHaveLength(6);
  });

  it('helmets and bald heads hide hair', () => {
    for (const hat of ['motorHelmet', 'bikeHelmet', 'tacticalHelmet'] as const) {
      const spec = defaultOutfitSpec('classB');
      spec.hat = hat;
      spec.hairStyle = 'long';
      const o = build(spec);
      expect(o.hideHair).toBe(true);
      expect(o.boxes.some((b) => b.attach === ATTACH.head && b.z > 0.09 && b.y < 0.15 && b.sx === 0.22)).toBe(false);
    }
    expect(build(defaultOutfitSpec('swat')).hideHair).toBe(true);
    const bald = defaultOutfitSpec('classB');
    bald.hairStyle = 'bald';
    expect(build(bald).hideHair).toBe(true);
    expect(build(defaultOutfitSpec('classB')).hideHair).toBe(false);
    const cap = defaultOutfitSpec('classB');
    cap.hat = 'ballCap';
    expect(build(cap).hideHair).toBe(false);
  });

  it('adds hair volume for long styles only without a covering hat', () => {
    const spec = defaultOutfitSpec('classB');
    spec.hairStyle = 'braids';
    const hairBoxes = (o: ReturnType<typeof build>) => sized(o.boxes, 0.04, 0.2, 0.04);
    expect(hairBoxes(build(spec))).toHaveLength(2);
    spec.hat = 'peakedCap';
    expect(hairBoxes(build(spec))).toHaveLength(0);
  });

  it('detective has no name plate and the badge on the belt (pelvis frame)', () => {
    const o = build(defaultOutfitSpec('detective'));
    expect(o.boxes.filter((b) => b.sy === 0.02 && b.sz === 0.01 && b.attach === ATTACH.torso)).toHaveLength(0);
    const badge = UNIFORM_DATA.department.badge.metal;
    const badges = o.boxes.filter((b) => b.color === badge && b.sx === 0.06 && b.sy === 0.07);
    expect(badges).toHaveLength(1);
    expect(badges[0]?.attach).toBe(ATTACH.pelvis);
    // Other classes: badge on the chest, plate present.
    const b = build(defaultOutfitSpec('classB'));
    expect(b.boxes.filter((x) => x.sx === 0.06 && x.sy === 0.07 && x.attach === ATTACH.torso)).toHaveLength(1);
    expect(b.boxes.filter((x) => x.sy === 0.02 && x.sz === 0.01 && x.attach === ATTACH.torso)).toHaveLength(1);
    const noPlate = defaultOutfitSpec('classB');
    noPlate.namePlate = false;
    expect(build(noPlate).boxes.filter((x) => x.sy === 0.02 && x.sz === 0.01 && x.attach === ATTACH.torso)).toHaveLength(0);
  });

  it('bike shows bare shins, motor wears tall boots, others trousers', () => {
    expect(build(defaultOutfitSpec('bike')).shins).toBe(SKIN_SHINS);
    expect(build(defaultOutfitSpec('classB')).shins).toBeNull();
    const motor = build(defaultOutfitSpec('motor'));
    expect(motor.shins).toBeNull();
    const boots = motor.boxes.filter((b) => b.attach === ATTACH.leftShin || b.attach === ATTACH.rightShin);
    expect(boots).toHaveLength(2);
    expect(boots.every((b) => b.sy === 0.3)).toBe(true);
  });

  it('a cold layer replaces the class jacket and carrier', () => {
    const spec = defaultOutfitSpec('motor');
    const plain = build(spec);
    spec.cold = 'parka';
    const parka = build(spec);
    expect(parka.top).toBe(plain.top);
    expect(parka.boxes.some((b) => b.attach === ATTACH.head && b.sx === 0.26)).toBe(true);
    expect(parka.boxes.filter((b) => b.attach === ATTACH.torso && b.sy === 0.64)).toHaveLength(1);
    expect(parka.boxes.filter((b) => b.attach === ATTACH.torso && b.sy === 0.62)).toHaveLength(0);
  });

  it('keeps every colour an int in 0..0xffffff', () => {
    for (const u of UNIFORM_CLASSES) {
      for (const cold of COLD_IDS) {
        const spec = defaultOutfitSpec(u);
        spec.cold = cold;
        const o = build(spec, 'chief');
        expect(isColor(o.top) && isColor(o.bottom)).toBe(true);
        expect(o.boxes.every((b) => isColor(b.color))).toBe(true);
      }
    }
  });

  it('stays within the box limit for every combination', () => {
    let count = 0;
    let max = 0;
    for (const uniform of UNIFORM_CLASSES) {
      for (const hat of [...HAT_IDS, 'default'] as const) {
        for (const carrier of [...CARRIER_IDS, 'default'] as const) {
          for (const cold of COLD_IDS) {
            for (const hairStyle of HAIR_STYLES) {
              for (const rank of RANK_IDS) {
                const spec = defaultOutfitSpec(uniform);
                Object.assign(spec, { hat, carrier, cold, hairStyle });
                const o = build(spec, rank);
                max = Math.max(max, o.boxes.length);
                count++;
                expect(o.boxes.length).toBeLessThanOrEqual(MAX_OUTFIT_BOXES);
              }
            }
          }
        }
      }
    }
    expect(count).toBe(7 * 10 * 5 * 4 * 8 * 6);
    expect(max).toBeGreaterThan(18);
  });

  it('sets the tie, badge and plate in front of thicker layers', () => {
    const spec = defaultOutfitSpec('classA');
    const o = build(spec);
    const jacket = o.boxes.find((b) => b.sx === 0.44 && b.sy === 0.62);
    const tie = o.boxes.find((b) => b.sx === 0.05 && b.sy === 0.3);
    expect(jacket).toBeDefined();
    expect(tie).toBeDefined();
    expect((tie?.z ?? 0) - (tie?.sz ?? 0) / 2).toBeLessThan(-(jacket?.sz ?? 0) / 2);
  });
});

describe('aiOutfitSpec', () => {
  it('is deterministic for the same inputs', () => {
    for (const role of ['patrol', 'supervisor', 'swat', 'detective'] as const) {
      expect(aiOutfitSpec(42, 'A-12', role, 15)).toEqual(aiOutfitSpec(42, 'A-12', role, 15));
    }
  });

  it('varies across callsigns and seeds', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const spec = aiOutfitSpec(7, `A-${i}`, 'patrol', 15);
      ids.add(JSON.stringify(spec));
      expect(() => build(spec)).not.toThrow();
    }
    expect(ids.size).toBeGreaterThanOrEqual(2);
    const seeds = new Set<string>();
    for (let s = 1; s <= 20; s++) seeds.add(JSON.stringify(aiOutfitSpec(s, 'A-1', 'patrol', 15)));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it('follows the role rules', () => {
    expect(aiOutfitSpec(1, 'x', 'swat', 15).uniform).toBe('swat');
    expect(aiOutfitSpec(1, 'x', 'detective', 15).uniform).toBe('detective');
    const sup = aiOutfitSpec(1, 'x', 'supervisor', 15);
    expect([sup.uniform, sup.hat]).toEqual(['classB', 'peakedCap']);
    const classes = new Set<UniformClass>();
    const hats = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = aiOutfitSpec(3, `P-${i}`, 'patrol', 15);
      classes.add(p.uniform);
      hats.add(p.hat);
      expect(p.cold).toBe('none');
    }
    expect([...classes].sort()).toEqual(['classB', 'tactical']);
    expect([...hats].sort()).toEqual(['ballCap', 'none', 'peakedCap']);
  });

  it('wears a jacket below 8 degrees C', () => {
    expect(aiOutfitSpec(1, 'x', 'patrol', 7.9).cold).toBe('jacket');
    expect(aiOutfitSpec(1, 'x', 'patrol', 8).cold).toBe('none');
    expect(aiOutfitSpec(1, 'x', 'swat', -5).cold).toBe('jacket');
  });

  it('keeps the same hair and class draws whatever the cold or role', () => {
    const a = aiOutfitSpec(9, 'K', 'patrol', 20);
    const b = aiOutfitSpec(9, 'K', 'patrol', 0);
    expect([a.hairStyle, a.hairColor, a.hat]).toEqual([b.hairStyle, b.hairColor, b.hat]);
    expect(UNIFORM_DATA.hairColors).toContain(a.hairColor);
  });
});

describe('defaultOutfitSpec and uniformAllowed', () => {
  it('defaults to class B with the department patch and badge, as copies', () => {
    const a = defaultOutfitSpec();
    expect(a.uniform).toBe('classB');
    expect(a.patch).toEqual(UNIFORM_DATA.department.patch);
    expect(a.badge).toEqual(UNIFORM_DATA.department.badge);
    a.patch.text = 'X';
    expect(defaultOutfitSpec().patch.text).toBe('CITY POLICE');
  });

  it('applies the vehicle policy', () => {
    expect(uniformAllowed('motor', 'motor')).toBe(true);
    expect(uniformAllowed('classB', 'motor')).toBe(false);
    expect(uniformAllowed('bike', 'bicycle')).toBe(true);
    expect(uniformAllowed('classA', 'bicycle')).toBe(false);
    expect(uniformAllowed('tactical', 'swat')).toBe(true);
    expect(uniformAllowed('classA', 'swat')).toBe(false);
    expect(uniformAllowed('classA', 'patrol')).toBe(true);
    expect(uniformAllowed('swat', 'unknownClass')).toBe(true);
  });
});
