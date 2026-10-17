import { describe, expect, it } from 'vitest';
import {
  TRAFFIC_MODELS,
  VEHICLE_MODELS,
  loadVehicleModels,
  parseVehicleModel,
  pickModelColor,
  restHeight,
  vehicleModel,
} from '../../src/vehicles/model';

const files = import.meta.glob<unknown>('../../src/data/vehicles/*.json', { eager: true, import: 'default' });

function patrolJson(): Record<string, unknown> {
  return structuredClone(files['../../src/data/vehicles/patrol_sedan.json']) as Record<string, unknown>;
}

describe('vehicle models', () => {
  it('ships the nine generic models, sorted by id with matching indices', () => {
    expect(VEHICLE_MODELS.map((m) => m.id)).toEqual([
      'box_truck',
      'city_bus',
      'compact',
      'hatchback',
      'patrol_sedan',
      'patrol_suv',
      'pickup',
      'sedan',
      'van',
    ]);
    VEHICLE_MODELS.forEach((m, i) => {
      expect(m.index).toBe(i);
    });
  });

  it('every shipped JSON validates on its own', () => {
    const paths = Object.keys(files);
    expect(paths).toHaveLength(9);
    for (const path of paths) {
      expect(() => parseVehicleModel(files[path], path)).not.toThrow();
    }
  });

  it('patrol models never spawn in traffic, carry a light bar and black/white paint', () => {
    for (const id of ['patrol_sedan', 'patrol_suv']) {
      const m = vehicleModel(id);
      expect(m.role).toBe('police');
      expect(m.trafficWeight).toBe(0);
      expect(m.lightbar).toBe(true);
      expect(m.colors.map((c) => c.rgb).sort((a, b) => a - b)).toEqual([0x16181d, 0xf2f2f2]);
      expect(TRAFFIC_MODELS).not.toContain(m);
    }
    expect(TRAFFIC_MODELS.length).toBe(7);
    expect(TRAFFIC_MODELS.every((m) => m.trafficWeight > 0 && !m.lightbar)).toBe(true);
  });

  it('vehicleModel throws on unknown ids; restHeight is clearance + half the body height', () => {
    expect(() => vehicleModel('spaceship')).toThrow(/Unknown vehicle model "spaceship"/);
    const m = vehicleModel('patrol_sedan');
    expect(restHeight(m)).toBeCloseTo(0.32 + 1.15 / 2, 10);
  });

  it('pickModelColor follows the weights', () => {
    const m = vehicleModel('patrol_sedan'); // black x3, white x1
    expect(pickModelColor(m, 0)).toBe(0x16181d);
    expect(pickModelColor(m, 0.74)).toBe(0x16181d);
    expect(pickModelColor(m, 0.76)).toBe(0xf2f2f2);
    expect(pickModelColor(m, 0.999999)).toBe(0xf2f2f2);
  });

  it('rejects bad data with an error naming the file and field', () => {
    const cases: [(j: Record<string, unknown>) => void, RegExp][] = [
      [(j) => (j.version = 2), /^bad\.json: version must be 1, got 2$/],
      [(j) => (j.role = 'pirate'), /^bad\.json: role must be one of police, civilian, commercial, got "pirate"$/],
      [(j) => ((j.brakes as Record<string, unknown>).frontBias = 1.4), /^bad\.json: brakes\.frontBias must be in \[0, 1\], got 1\.4$/],
      [(j) => ((j.engine as Record<string, unknown>).gearRatios = []), /^bad\.json: engine\.gearRatios must have at least 1 items/],
      [(j) => (j.colors = [{ hex: 'red', weight: 1 }]), /^bad\.json: colors\[0\]\.hex must be a "#rrggbb" colour, got "red"$/],
      [(j) => delete j.tires, /^bad\.json: tires must be an object, got undefined$/],
      [(j) => ((j.body as Record<string, unknown>).wheelbase = 9), /^bad\.json: body\.wheelbase must be shorter than body\.length/],
      [(j) => (j.lightbar = 'yes'), /^bad\.json: lightbar must be true or false, got "yes"$/],
      [(j) => (j.equipment = 'full'), /^bad\.json: equipment must be an object, got "full"$/],
      [(j) => ((j.equipment as Record<string, unknown>).pushBumper = 5), /^bad\.json: equipment\.pushBumper must be an object, got 5$/],
      [
        (j) => (((j.equipment as Record<string, unknown>).pushBumper as Record<string, unknown>).engineShare = 2),
        /^bad\.json: equipment\.pushBumper\.engineShare must be in \[0, 1\], got 2$/,
      ],
      [(j) => ((j.equipment as Record<string, unknown>).rack = 'yes'), /^bad\.json: equipment\.rack must be true or false, got "yes"$/],
      [(j) => ((j.equipment as Record<string, unknown>).trunk = 3), /^bad\.json: equipment\.trunk must be a non-empty string, got 3$/],
    ];
    for (const [mutate, message] of cases) {
      const json = patrolJson();
      mutate(json);
      expect(() => parseVehicleModel(json, 'bad.json')).toThrow(message);
    }
    expect(() => parseVehicleModel(null, 'bad.json')).toThrow(/^bad\.json: must be an object, got null$/);
  });

  it('requires the id to match the file name', () => {
    expect(() => loadVehicleModels({ './x/renamed.json': patrolJson() })).toThrow(/renamed\.json: id must match the file name/);
  });

  it('patrol models parse their equipment and fold the push bumper into the damage spec', () => {
    for (const id of ['patrol_sedan', 'patrol_suv']) {
      const m = vehicleModel(id);
      expect(m.equipment).toEqual({
        pushBumper: { frontStrength: 1.8, engineShare: 0.5 },
        partition: true,
        rack: true,
        spotlight: true,
        mdt: true,
        trunk: 'patrol',
      });
      expect(m.damage.frontZoneStrength).toBeCloseTo(m.damage.zoneStrength * 1.8, 10);
      expect(m.damage.frontEngineShare).toBeCloseTo(m.damage.engineFrontShare * 0.5, 10);
    }
  });

  it('models without the section have no equipment and no front damage fields', () => {
    for (const m of VEHICLE_MODELS.filter((x) => x.role !== 'police')) {
      expect(m.equipment).toBeNull();
      expect('frontZoneStrength' in m.damage).toBe(false);
      expect('frontEngineShare' in m.damage).toBe(false);
    }
    const json = patrolJson();
    const eq = json.equipment as Record<string, unknown>;
    delete eq.pushBumper;
    eq.trunk = null;
    const m = parseVehicleModel(json, 'x.json');
    expect(m.equipment?.pushBumper).toBeNull();
    expect(m.equipment?.trunk).toBeNull();
    expect('frontZoneStrength' in m.damage).toBe(false);
  });
});
