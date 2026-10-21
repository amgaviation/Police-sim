import { describe, expect, it } from 'vitest';
import { vehicleRecord } from '../../src/traffic/registry';
import {
  BODY_STYLES,
  CONTROL_KINDS,
  DEFAULT_WEAR,
  TRAFFIC_MODELS,
  VEHICLE_MODELS,
  VEHICLE_ROLES,
  damageSpecFor,
  isCraft,
  loadVehicleModels,
  parseVehicleModel,
  pickModelColor,
  restHeight,
  vehicleModel,
  wheelLayout,
} from '../../src/vehicles/model';

const files = import.meta.glob<unknown>('../../src/data/vehicles/*.json', { eager: true, import: 'default' });

function patrolJson(): Record<string, unknown> {
  return structuredClone(files['../../src/data/vehicles/patrol_sedan.json']) as Record<string, unknown>;
}

/** The nine pre-Phase-6 models in their (frozen) index order: saves store these indices. */
const ORIGINAL_IDS = ['box_truck', 'city_bus', 'compact', 'hatchback', 'patrol_sedan', 'patrol_suv', 'pickup', 'sedan', 'van'];
const SERVICE_IDS = ['ambulance', 'fire_engine', 'tactical_truck', 'tow_truck'];
/** The 15 Phase 7 fleet models (listOrder 2), sorted by id as `VEHICLE_MODELS` sorts them. */
const FLEET_IDS = [
  'armored_truck',
  'command_post',
  'crime_lab',
  'k9_suv',
  'patrol_boat',
  'police_atv',
  'police_bicycle',
  'police_drone',
  'police_helicopter',
  'police_motorcycle',
  'prisoner_van',
  'supervisor_suv',
  'swat_truck',
  'traffic_sedan',
  'unmarked_sedan',
];

describe('vehicle models', () => {
  it('ships the nine generic models first, then the four service models, then the 15 fleet models, with matching indices', () => {
    expect(VEHICLE_MODELS.map((m) => m.id)).toEqual([...ORIGINAL_IDS, ...SERVICE_IDS, ...FLEET_IDS]);
    expect(VEHICLE_MODELS).toHaveLength(28);
    VEHICLE_MODELS.forEach((m, i) => {
      expect(m.index).toBe(i);
    });
  });

  it('keeps every existing model index and appends ambulance 9, fire_engine 10, tactical_truck 11, tow_truck 12', () => {
    const index = Object.fromEntries(VEHICLE_MODELS.map((m) => [m.id, m.index]));
    expect(index).toEqual({
      box_truck: 0,
      city_bus: 1,
      compact: 2,
      hatchback: 3,
      patrol_sedan: 4,
      patrol_suv: 5,
      pickup: 6,
      sedan: 7,
      van: 8,
      ambulance: 9,
      fire_engine: 10,
      tactical_truck: 11,
      tow_truck: 12,
      ...Object.fromEntries(FLEET_IDS.map((id, i) => [id, 13 + i])),
    });
    expect(ORIGINAL_IDS.every((id, i) => vehicleModel(id).index === i && vehicleModel(id).listOrder === 0)).toBe(true);
  });

  it('the service models have the service role, no traffic weight, a light bar, no equipment and listOrder 1', () => {
    expect(VEHICLE_ROLES).toEqual(['police', 'civilian', 'commercial', 'service']);
    for (const id of SERVICE_IDS) {
      const m = vehicleModel(id);
      expect(m.role).toBe('service');
      expect(m.trafficWeight).toBe(0);
      expect(m.lightbar).toBe(true);
      expect(m.listOrder).toBe(1);
      expect(m.equipment).toBeNull();
      expect(m.colors).toHaveLength(1);
      expect(TRAFFIC_MODELS).not.toContain(m);
    }
    expect(VEHICLE_MODELS.filter((m) => m.role === 'police').map((m) => m.id)).toEqual(['patrol_sedan', 'patrol_suv', ...FLEET_IDS]);
    const dims = (id: string) => {
      const m = vehicleModel(id);
      return [m.body.length, m.body.width, m.body.height, m.mass, m.colors[0]?.rgb];
    };
    expect(dims('ambulance')).toEqual([6.2, 2.2, 2.3, 4200, 0xf2f2ee]);
    expect(dims('fire_engine')).toEqual([9.5, 2.5, 2.4, 14000, 0xa3261e]);
    expect(dims('tow_truck')).toEqual([7.5, 2.3, 2.0, 7000, 0xd8a21a]);
    expect(dims('tactical_truck')).toEqual([7.8, 2.5, 2.5, 9000, 0x1c1f24]);
    expect(vehicleModel('ambulance').body.cabin).toMatchObject({ start: 0.05, end: 0.25 });
    expect(vehicleModel('fire_engine').engine.maxSpeedKmh).toBe(120);
    // the physics blocks are the templates' (van / box_truck)
    expect(vehicleModel('ambulance').suspension).toEqual(vehicleModel('van').suspension);
    expect(vehicleModel('tow_truck').brakes).toEqual(vehicleModel('box_truck').brakes);
    expect(vehicleModel('tactical_truck').engine).toEqual(vehicleModel('box_truck').engine);
  });

  it('registry model indices for ids 0..999 of seed 42 are still among the nine original models', () => {
    for (let id = 0; id < 1000; id++) {
      const rec = vehicleRecord(42, id);
      expect(rec.modelIndex).toBeLessThan(ORIGINAL_IDS.length);
      expect(ORIGINAL_IDS[rec.modelIndex]).toBe(rec.modelId);
      expect(VEHICLE_MODELS[rec.modelIndex]?.id).toBe(rec.modelId);
    }
  });

  it('sorts by (listOrder, id) and validates listOrder', () => {
    const a = patrolJson();
    const b = { ...patrolJson(), id: 'aaa_late', listOrder: 2 };
    const c = { ...patrolJson(), id: 'zzz_early' };
    const d = { ...patrolJson(), id: 'mmm_mid', listOrder: 1 };
    const models = loadVehicleModels({
      './x/patrol_sedan.json': a,
      './x/aaa_late.json': b,
      './x/zzz_early.json': c,
      './x/mmm_mid.json': d,
    });
    expect(models.map((m) => [m.id, m.index, m.listOrder])).toEqual([
      ['patrol_sedan', 0, 0],
      ['zzz_early', 1, 0],
      ['mmm_mid', 2, 1],
      ['aaa_late', 3, 2],
    ]);
    for (const bad of [-1, 1.5, '1']) {
      const json = patrolJson();
      json.listOrder = bad;
      expect(() => parseVehicleModel(json, 'bad.json')).toThrow(/^bad\.json: listOrder must be (in \[0, Infinity\]|a finite number|an integer)/);
    }
  });

  it('every shipped JSON validates on its own', () => {
    const paths = Object.keys(files);
    expect(paths).toHaveLength(28);
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
    expect(TRAFFIC_MODELS.every((m) => m.index < ORIGINAL_IDS.length)).toBe(true);
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
      [(j) => (j.role = 'pirate'), /^bad\.json: role must be one of police, civilian, commercial, service, got "pirate"$/],
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

function boatJson(): Record<string, unknown> {
  return structuredClone(files['../../src/data/vehicles/patrol_boat.json']) as Record<string, unknown>;
}
function bikeJson(): Record<string, unknown> {
  return structuredClone(files['../../src/data/vehicles/police_motorcycle.json']) as Record<string, unknown>;
}

describe('Phase 7 fleet models', () => {
  it('lists the Phase 7 body styles and control kinds', () => {
    expect(BODY_STYLES).toEqual(['sedan', 'hatchback', 'suv', 'pickup', 'van', 'truck', 'bus', 'motorcycle', 'bicycle', 'atv', 'boat', 'helicopter', 'drone']);
    expect(CONTROL_KINDS).toEqual(['car', 'bike', 'boat', 'helicopter', 'drone']);
  });

  it('the 15 new models are police units outside traffic, listed after the service models', () => {
    for (const id of FLEET_IDS) {
      const m = vehicleModel(id);
      expect(m.role, id).toBe('police');
      expect(m.listOrder, id).toBe(2);
      expect(m.trafficWeight, id).toBe(0);
      expect(m.index, id).toBeGreaterThanOrEqual(13);
      expect(TRAFFIC_MODELS).not.toContain(m);
      expect(m.colors.length, id).toBeGreaterThan(0);
    }
    expect(TRAFFIC_MODELS.every((m) => m.index < 9)).toBe(true);
  });

  it('assigns control models, body styles and wheel layouts', () => {
    const table: [string, string, string, 'four' | 'two' | 'none'][] = [
      ['patrol_sedan', 'car', 'sedan', 'four'],
      ['supervisor_suv', 'car', 'suv', 'four'],
      ['unmarked_sedan', 'car', 'sedan', 'four'],
      ['traffic_sedan', 'car', 'sedan', 'four'],
      ['k9_suv', 'car', 'suv', 'four'],
      ['police_motorcycle', 'bike', 'motorcycle', 'two'],
      ['police_bicycle', 'bike', 'bicycle', 'two'],
      ['police_atv', 'car', 'atv', 'four'],
      ['swat_truck', 'car', 'truck', 'four'],
      ['armored_truck', 'car', 'truck', 'four'],
      ['prisoner_van', 'car', 'van', 'four'],
      ['command_post', 'car', 'bus', 'four'],
      ['crime_lab', 'car', 'van', 'four'],
      ['patrol_boat', 'boat', 'boat', 'none'],
      ['police_helicopter', 'helicopter', 'helicopter', 'none'],
      ['police_drone', 'drone', 'drone', 'none'],
    ];
    for (const [id, control, style, layout] of table) {
      const m = vehicleModel(id);
      expect(m.control, id).toBe(control);
      expect(m.body.style, id).toBe(style);
      expect(wheelLayout(m), id).toBe(layout);
      expect(isCraft(m), id).toBe(layout === 'none');
      expect(m.craft !== null, id).toBe(layout === 'none');
      expect(m.bike !== null, id).toBe(control === 'bike');
    }
    expect(vehicleModel('police_bicycle').bike?.pedal).toBe(true);
    expect(vehicleModel('police_motorcycle').bike).toEqual({ uprightStiffness: 60, uprightDamping: 12, maxLeanDeg: 40, pedal: false });
    expect(vehicleModel('police_drone').craft).toMatchObject({ maxSpeedMps: 16, rangeM: 350, maxAltitudeM: 120 });
    expect(vehicleModel('patrol_boat').craft).toMatchObject({ maxSpeedMps: 18, climbMps: 0, maxAltitudeM: 0 });
  });

  it('copies the base models and applies the overrides of the design table', () => {
    const sedan = vehicleModel('patrol_sedan');
    const suv = vehicleModel('patrol_suv');
    expect(vehicleModel('supervisor_suv').body).toEqual(suv.body);
    expect(vehicleModel('supervisor_suv').equipment).toMatchObject({ partition: false, trunk: 'supervisor' });
    expect(vehicleModel('supervisor_suv').colors.map((c) => c.hex)).toEqual(['#f2f2f2']);
    expect(vehicleModel('unmarked_sedan').equipment).toEqual({ pushBumper: null, partition: true, rack: true, spotlight: true, mdt: true, trunk: 'unmarked' });
    expect(vehicleModel('unmarked_sedan').colors.map((c) => c.hex)).toEqual(['#3a3f47', '#5b6168', '#1f2a3a']);
    expect(vehicleModel('traffic_sedan').engine).toEqual({ ...sedan.engine, maxPowerKw: 280, maxSpeedKmh: 240 });
    expect(vehicleModel('traffic_sedan').patrol.radar).toBe(true);
    expect(vehicleModel('k9_suv').patrol).toEqual({ cageSeats: 0, droneBay: false, radar: false, kennel: true });
    expect(vehicleModel('swat_truck').equipment?.pushBumper).toEqual({ frontStrength: 2.5, engineShare: 0.4 });
    expect(vehicleModel('swat_truck').engine).toEqual(vehicleModel('tactical_truck').engine);
    const armored = vehicleModel('armored_truck');
    expect(armored.mass).toBe(12000);
    expect(armored.engine).toEqual({ ...vehicleModel('tactical_truck').engine, maxForce: 24000, maxPowerKw: 250, maxSpeedKmh: 110 });
    expect(armored.damage).toMatchObject({ minImpactSpeed: 4, zoneStrength: 45 });
    expect(vehicleModel('prisoner_van').patrol.cageSeats).toBe(6);
    expect(vehicleModel('prisoner_van').suspension).toEqual(vehicleModel('van').suspension);
    expect(vehicleModel('command_post').patrol.droneBay).toBe(true);
    expect(vehicleModel('command_post').body.length).toBe(10.5);
    expect(vehicleModel('crime_lab').colors[0]?.hex).toBe('#f5f5f2');
    expect(vehicleModel('police_drone').fuel).toEqual({ capacityL: 1, idleLph: 3, litersPerKWh: 0 });
    expect(vehicleModel('police_helicopter').steering).toEqual(sedan.steering);
  });

  it('cargo capacities and patrol extras follow the design', () => {
    const cargo = (id: string) => {
      const c = vehicleModel(id).cargo;
      return [c.kg, c.slots, c.rackSlots];
    };
    expect(cargo('patrol_sedan')).toEqual([150, 30, 2]);
    expect(cargo('patrol_suv')).toEqual([220, 34, 2]);
    expect(cargo('supervisor_suv')).toEqual([220, 30, 2]);
    expect(cargo('unmarked_sedan')).toEqual([150, 24, 2]);
    expect(cargo('traffic_sedan')).toEqual([150, 26, 1]);
    expect(cargo('k9_suv')).toEqual([200, 28, 1]);
    expect(cargo('police_motorcycle')).toEqual([25, 6, 0]);
    expect(cargo('police_bicycle')).toEqual([12, 4, 0]);
    expect(cargo('police_atv')).toEqual([40, 8, 0]);
    expect(cargo('swat_truck')).toEqual([900, 80, 4]);
    expect(cargo('armored_truck')).toEqual([600, 50, 4]);
    expect(cargo('prisoner_van')).toEqual([120, 16, 0]);
    expect(cargo('command_post')).toEqual([800, 80, 2]);
    expect(cargo('crime_lab')).toEqual([500, 60, 0]);
    expect(cargo('patrol_boat')).toEqual([400, 30, 2]);
    expect(cargo('police_helicopter')).toEqual([150, 12, 0]);
    expect(cargo('police_drone')).toEqual([0, 0, 0]);
    expect(cargo('sedan')).toEqual([0, 0, 0]);
    // cageSeats defaults to 1 with a partition, 0 without.
    expect(vehicleModel('patrol_sedan').patrol).toEqual({ cageSeats: 1, droneBay: false, radar: false, kennel: false });
    expect(vehicleModel('supervisor_suv').patrol.cageSeats).toBe(0);
    expect(vehicleModel('van').patrol.cageSeats).toBe(0);
  });

  it('phase 1-6 models keep their physics and gain only the defaults', () => {
    for (const id of [...ORIGINAL_IDS, ...SERVICE_IDS]) {
      const m = vehicleModel(id);
      expect(m.control, id).toBe('car');
      expect(m.craft, id).toBeNull();
      expect(m.bike, id).toBeNull();
      expect(m.rider, id).toBeNull();
      expect(m.wear, id).toEqual(DEFAULT_WEAR);
    }
    expect(vehicleModel('patrol_sedan').mass).toBe(1850);
    expect(vehicleModel('patrol_suv').engine.maxPowerKw).toBe(260);
    expect(vehicleModel('police_motorcycle').rider).toEqual({ x: 0, y: 0.1, z: 0.15, pose: 'seated' });
    expect(vehicleModel('patrol_boat').rider?.pose).toBe('stand');
  });

  it('a partial wear section keeps the defaults for the missing keys', () => {
    const json = patrolJson();
    json.wear = { oilL: 9, minTreadGrip: 0.5 };
    expect(parseVehicleModel(json, 'x.json').wear).toEqual({ ...DEFAULT_WEAR, oilL: 9, minTreadGrip: 0.5 });
  });

  it('rejects bad control, craft, bike, wear, cargo, patrol and rider sections with their paths', () => {
    const cases: [() => Record<string, unknown>, RegExp][] = [
      [() => ({ ...patrolJson(), control: 'plane' }), /^bad\.json: control must be one of car, bike, boat, helicopter, drone, got "plane"$/],
      [() => ({ ...patrolJson(), craft: boatJson().craft }), /^bad\.json: craft is only allowed for control boat, helicopter or drone, not "car"$/],
      [() => ({ ...patrolJson(), bike: bikeJson().bike }), /^bad\.json: bike is only allowed for control "bike", not "car"$/],
      [() => ({ ...patrolJson(), control: 'helicopter' }), /^bad\.json: craft is required for control "helicopter"$/],
      [() => ({ ...patrolJson(), control: 'bike' }), /^bad\.json: bike is required for control "bike"$/],
      [() => ({ ...boatJson(), bike: bikeJson().bike }), /^bad\.json: bike is only allowed for control "bike", not "boat"$/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), maxSpeedMps: 0 } }), /^bad\.json: craft\.maxSpeedMps must be in \[/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), reverseMps: -1 } }), /^bad\.json: craft\.reverseMps must be in \[0,/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), dragPerS: 6 } }), /^bad\.json: craft\.dragPerS must be in \[0, 5\], got 6$/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), tiltDeg: 50 } }), /^bad\.json: craft\.tiltDeg must be in \[0, 45\], got 50$/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), rangeM: -5 } }), /^bad\.json: craft\.rangeM must be in \[0,/],
      [() => ({ ...boatJson(), craft: { ...(boatJson().craft as object), climbMps: 'fast' } }), /^bad\.json: craft\.climbMps must be a finite number, got "fast"$/],
      [() => ({ ...boatJson(), craft: 7 }), /^bad\.json: craft must be an object, got 7$/],
      [() => ({ ...bikeJson(), bike: { ...(bikeJson().bike as object), uprightStiffness: 0 } }), /^bad\.json: bike\.uprightStiffness must be in \[/],
      [() => ({ ...bikeJson(), bike: { ...(bikeJson().bike as object), maxLeanDeg: 61 } }), /^bad\.json: bike\.maxLeanDeg must be in \[0, 60\], got 61$/],
      [() => ({ ...bikeJson(), bike: { ...(bikeJson().bike as object), pedal: 'yes' } }), /^bad\.json: bike\.pedal must be true or false, got "yes"$/],
      [() => ({ ...patrolJson(), wear: { minTreadGrip: 2 } }), /^bad\.json: wear\.minTreadGrip must be in \[0, 1\], got 2$/],
      [() => ({ ...patrolJson(), wear: { oilL: 0 } }), /^bad\.json: wear\.oilL must be in \[/],
      [() => ({ ...patrolJson(), wear: [] }), /^bad\.json: wear must be an object, got \[\]$/],
      [() => ({ ...patrolJson(), cargo: { kg: 10, slots: 1.5, rackSlots: 0 } }), /^bad\.json: cargo\.slots must be an integer, got 1\.5$/],
      [() => ({ ...patrolJson(), cargo: { kg: -1, slots: 1, rackSlots: 0 } }), /^bad\.json: cargo\.kg must be in \[0,/],
      [() => ({ ...patrolJson(), cargo: { kg: 1, slots: 1 } }), /^bad\.json: cargo\.rackSlots must be a finite number, got undefined$/],
      [() => ({ ...patrolJson(), patrol: { cageSeats: 9 } }), /^bad\.json: patrol\.cageSeats must be in \[0, 8\], got 9$/],
      [() => ({ ...patrolJson(), patrol: { cageSeats: 1.5 } }), /^bad\.json: patrol\.cageSeats must be an integer, got 1\.5$/],
      [() => ({ ...patrolJson(), patrol: { radar: 'on' } }), /^bad\.json: patrol\.radar must be true or false, got "on"$/],
      [() => ({ ...bikeJson(), rider: { x: 0, y: 0, z: 0, pose: 'lying' } }), /^bad\.json: rider\.pose must be one of seated, stand, got "lying"$/],
      [() => ({ ...bikeJson(), rider: { x: 0, y: 'a', z: 0, pose: 'stand' } }), /^bad\.json: rider\.y must be a finite number, got "a"$/],
    ];
    for (const [make, message] of cases) expect(() => parseVehicleModel(make(), 'bad.json')).toThrow(message);
  });

  it('damageSpecFor drops the front fields without the push bar', () => {
    for (const id of ['patrol_sedan', 'patrol_suv', 'swat_truck', 'armored_truck', 'supervisor_suv']) {
      const m = vehicleModel(id);
      expect(damageSpecFor(m, true)).toBe(m.damage);
      expect(m.damage.frontZoneStrength).toBeGreaterThan(0);
      const bare = damageSpecFor(m, false);
      expect(Object.keys(bare).sort()).toEqual(
        ['engineFrontShare', 'failBelow', 'minImpactSpeed', 'stallBelow', 'stallChancePerS', 'tireBurstSpeed', 'zoneStrength'],
      );
      expect(bare.zoneStrength).toBe(m.damage.zoneStrength);
      expect(m.damage.frontZoneStrength).toBeGreaterThan(bare.zoneStrength);
    }
    // Models without a bumper return their own spec either way.
    const plain = vehicleModel('sedan');
    expect(damageSpecFor(plain, true)).toEqual(plain.damage);
    expect(damageSpecFor(plain, false)).toEqual(plain.damage);
    const unmarked = vehicleModel('unmarked_sedan');
    expect(damageSpecFor(unmarked, true)).toEqual(damageSpecFor(unmarked, false));
    expect(unmarked.damage.frontZoneStrength).toBeUndefined();
  });
});
