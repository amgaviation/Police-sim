import { describe, expect, it } from 'vitest';
import behaviorsJson from '../../src/data/npc/behaviors.json';
import densityJson from '../../src/data/npc/density.json';
import npcJson from '../../src/data/npc/npc.json';
import { BEHAVIORS, NPC_CONFIG, NPC_DENSITY, PROFILE_IDS, behavior, findBehavior, parseBehaviors, parseDensity, parseNpcConfig } from '../../src/npc/data';
import { DISTRICT_NAMES } from '../../src/world/ids';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('behaviors.json', () => {
  it('has one profile per PROFILE_IDS id (32) and nothing is out of range', () => {
    expect(PROFILE_IDS.length).toBe(32);
    for (const id of PROFILE_IDS) expect(behavior(id).id).toBe(id);
    expect(BEHAVIORS.length).toBe(32);
    for (const p of BEHAVIORS) {
      for (const k of ['compliance', 'fleeChance', 'fightChance', 'weaponDrawChance', 'surrenderPerMin', 'stress'] as const) {
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('follows the suggested values of the design', () => {
    for (const id of ['callerHelpful', 'driverCooperative', 'bystander', 'securityGuard'] as const) {
      expect(behavior(id).compliance).toBeGreaterThanOrEqual(0.85);
      expect(behavior(id).compliance).toBeLessThanOrEqual(0.95);
      expect(behavior(id).fleeChance).toBe(0);
    }
    expect(behavior('suspectHostile')).toMatchObject({ compliance: 0.35, fightChance: 0.3, demeanor: 'hostile' });
    expect(behavior('suspectArmedHostile')).toMatchObject({ compliance: 0.25, weaponDrawChance: 0.6, surrenderPerMin: 0.5 });
    expect(behavior('suspectFleeRisk')).toMatchObject({ demeanor: 'evasive', compliance: 0.45, fleeChance: 0.45, fightChance: 0.15, weaponDrawChance: 0.3, surrenderPerMin: 0.6, stress: 0.5 });
    for (const id of ['subjectUnconscious', 'subjectDeceased'] as const) {
      expect(behavior(id)).toMatchObject({ compliance: 0, startPose: 'lying', demeanor: 'unresponsive' });
    }
    for (const id of ['animalDog', 'animalAggressiveDog'] as const) expect(behavior(id).demeanor).toBe('animal');
    expect(behavior('bystander').wander).toBe(true);
    expect(behavior('crowdMember').crowd).toBe(true);
    expect(behavior('protester').crowd).toBe(true);
  });

  it('behavior() throws on an unknown id and findBehavior returns null', () => {
    expect(() => behavior('nope')).toThrow(/Unknown behaviour profile "nope"/);
    expect(findBehavior('nope')).toBeNull();
    expect(findBehavior('bystander')?.id).toBe('bystander');
  });

  it('names the file and the path of a bad field', () => {
    const bad = clone(behaviorsJson) as { profiles: Record<string, unknown>[] };
    expect(() => parseBehaviors(bad)).not.toThrow();
    bad.profiles[3]!.compliance = 1.5;
    expect(() => parseBehaviors(bad)).toThrow(/behaviors\.json: profiles\[3\]\.compliance must be in \[0, 1\], got 1\.5/);
    bad.profiles[3]!.compliance = 0.5;
    bad.profiles[4]!.demeanor = 'angry';
    expect(() => parseBehaviors(bad)).toThrow(/profiles\[4\]\.demeanor must be one of/);
    bad.profiles[4]!.demeanor = 'nervous';
    bad.profiles[5]!.surprise = 1;
    expect(() => parseBehaviors(bad)).toThrow(/profiles\[5\]\.surprise is not a known field/);
    delete bad.profiles[5]!.surprise;
    bad.profiles[6]!.id = bad.profiles[0]!.id;
    expect(() => parseBehaviors(bad)).toThrow(/duplicate profile/);
    const missing = clone(behaviorsJson) as { profiles: Record<string, unknown>[] };
    missing.profiles.pop();
    expect(() => parseBehaviors(missing)).toThrow(/missing the required profile "animalAggressiveDog"/);
    expect(() => parseBehaviors({ version: 2, profiles: [] })).toThrow(/version/);
  });
});

describe('npc.json and density.json', () => {
  it('load the design values', () => {
    expect(NPC_CONFIG.actors.max).toBe(64);
    expect(NPC_CONFIG.peds.max).toBe(160);
    expect(NPC_CONFIG.occupants.seats.length).toBe(4);
    expect(NPC_CONFIG.actors.lod).toEqual({ nearM: 60, midM: 200, nearHz: 10, midHz: 2, farHz: 0.5 });
    expect(NPC_DENSITY.perKm.length).toBe(DISTRICT_NAMES.length);
    expect(NPC_DENSITY.hourly.length).toBe(24);
    expect(NPC_DENSITY.hourly[3]).toBeLessThan(NPC_DENSITY.hourly[12] ?? 0);
    const downtown = DISTRICT_NAMES.indexOf('downtown');
    const rural = DISTRICT_NAMES.indexOf('rural');
    expect(NPC_DENSITY.perKm[downtown]).toBeGreaterThan(NPC_DENSITY.perKm[rural] ?? 0);
    expect(NPC_DENSITY.perKm[DISTRICT_NAMES.indexOf('water')]).toBe(0);
  });

  it('validators name file and path', () => {
    const cfg = clone(npcJson) as { actors: Record<string, unknown>; peds: Record<string, unknown>; occupants: Record<string, unknown> };
    expect(() => parseNpcConfig(cfg)).not.toThrow();
    cfg.actors.taserHit = 2;
    expect(() => parseNpcConfig(cfg)).toThrow(/npc\.json: actors\.taserHit must be in \[0, 1\]/);
    cfg.actors.taserHit = 0.8;
    cfg.peds.despawnRadiusM = 100;
    expect(() => parseNpcConfig(cfg)).toThrow(/npc\.json: peds\.despawnRadiusM must be > spawnRadiusM/);
    cfg.peds.despawnRadiusM = 200;
    cfg.actors.walkSpeed = [2, 1];
    expect(() => parseNpcConfig(cfg)).toThrow(/npc\.json: actors\.walkSpeed must be \[min, max\]/);
    cfg.actors.walkSpeed = [1.1, 1.5];
    cfg.occupants.seats = [[0, 0, 0]];
    expect(() => parseNpcConfig(cfg)).toThrow(/occupants\.seats\[0\] must have 2 items/);

    const d = clone(densityJson) as { perKm: Record<string, unknown>; hourly: unknown[] };
    expect(() => parseDensity(d)).not.toThrow();
    delete d.perKm.rural;
    expect(() => parseDensity(d)).toThrow(/density\.json: perKm\.rural/);
    d.perKm.rural = 2;
    d.perKm.moon = 1;
    expect(() => parseDensity(d)).toThrow(/perKm\.moon is not a district name/);
    delete d.perKm.moon;
    d.hourly.pop();
    expect(() => parseDensity(d)).toThrow(/density\.json: hourly must have at least 24 items/);
  });
});
