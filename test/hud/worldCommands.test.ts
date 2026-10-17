import { beforeAll, describe, expect, it } from 'vitest';
import type { Command, CommandContext } from '../../src/debug/console';
import {
  createWorldCommands,
  nearestPoi,
  normalizePlate,
  parseClock,
  type WorldCommandDeps,
} from '../../src/debug/worldCommands';
import { Environment } from '../../src/environment/environment';
import type { VehicleTelemetry } from '../../src/vehicles/drivableVehicle';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { telemetry } from './fixtures';

let city: City;

beforeAll(() => {
  city = generateCity(12345);
});

const ctx = {} as CommandContext;

interface Harness {
  deps: WorldCommandDeps;
  env: Environment;
  calls: string[];
  route: { value: Float32Array | null };
  player: { x: number; z: number };
  tel: VehicleTelemetry;
  inVehicle: { value: boolean };
  run(line: string): string;
}

function harness(): Harness {
  const env = new Environment(7);
  const calls: string[] = [];
  const route = { value: null as Float32Array | null };
  const player = { x: city.spawn.x, z: city.spawn.z };
  const tel = telemetry({ fuelL: 10, fuelFraction: 10 / 70 });
  const inVehicle = { value: true };
  const deps: WorldCommandDeps = {
    city: () => city,
    playerPosition: () => player,
    environment: () => env,
    teleport: (x, z) => {
      calls.push(`teleport ${x.toFixed(1)} ${z.toFixed(1)}`);
      player.x = x;
      player.z = z;
    },
    setRoute: (polyline) => {
      route.value = polyline;
    },
    vehicle: () =>
      inVehicle.value
        ? {
            telemetry: tel,
            refuel: () => {
              tel.fuelL = 70;
              calls.push('refuel');
            },
            repair: () => calls.push('repair'),
          }
        : null,
    spawnVehicle: (id) => calls.push(`spawn ${id}`),
    trafficStats: () => ({ active: 42, proxies: 7, spawned: 100, despawned: 58 }),
    clearTraffic: () => calls.push('clearTraffic'),
    setTrafficDensity: (scale) => calls.push(`density ${String(scale)}`),
    trafficCars: (limit) =>
      [
        {
          vehicleId: 17,
          plate: 'ABC 1234',
          modelId: 'sedan',
          distance: 42.4,
          speedMph: 31.2,
          crashed: false,
          violations: { speeding: 2, redLight: 1 },
          flags: ['stolen'],
        },
        { vehicleId: 9, plate: 'XYZ 0001', modelId: 'van', distance: 80, speedMph: 0, crashed: true, violations: {}, flags: [] },
      ].slice(0, limit),
    lookupPlate: (plate) => (plate === 'ABC 1234' ? { id: 17, plate, modelId: 'sedan', stolen: false, tendencies: { speeding: true } } : null),
    chunkStats: () => ({ loaded: 30, inFlight: 2, lod0: 9, lod1: 21 }),
  };
  const commands = new Map<string, Command>(createWorldCommands(deps).map((c) => [c.name, c]));
  const run = (line: string): string => {
    const [name = '', ...args] = line.split(' ');
    const command = commands.get(name);
    if (!command) throw new Error(`no command ${name}`);
    const result = command.run(args, ctx);
    if (typeof result !== 'string' && result !== undefined) throw new Error('unexpected async result');
    return result ?? '';
  };
  return { deps, env, calls, route, player, tel, inVehicle, run };
}

describe('helpers', () => {
  it('parses clock times', () => {
    expect(parseClock('07:30')).toBe(7.5);
    expect(parseClock('0:00')).toBe(0);
    expect(parseClock('24:00')).toBe(24);
    expect(parseClock('24:01')).toBeNull();
    expect(parseClock('12:60')).toBeNull();
    expect(parseClock('noon')).toBeNull();
  });

  it('normalizes plates', () => {
    expect(normalizePlate('abc 1234')).toBe('ABC 1234');
    expect(normalizePlate('ABC1234')).toBe('ABC 1234');
    expect(normalizePlate('AB 1234')).toBeNull();
    expect(normalizePlate('ABC 12345')).toBeNull();
  });

  it('finds the nearest POI of a kind', () => {
    const station = nearestPoi(city, 'station', 0, 0);
    expect(station?.kind).toBe('station');
    expect(nearestPoi({ ...city, pois: [] }, 'fuel', 0, 0)).toBeNull();
  });
});

describe('createWorldCommands', () => {
  it('provides the Phase 1 command set', () => {
    const names = createWorldCommands(harness().deps).map((c) => c.name);
    expect(names).toEqual(['time', 'weather', 'tp', 'route', 'road', 'car', 'traffic', 'plate', 'chunks']);
  });

  it('time prints the clock and sets it through setTimeOfDay', () => {
    const h = harness();
    expect(h.run('time')).toMatch(/^time [A-Z][a-z]{2} \d\d:\d\d$/);
    expect(h.run('time 21:15')).toMatch(/ 21:15$/);
    expect(h.env.time.hour).toBeCloseTo(21.25, 5);
    expect(() => h.run('time 25:00')).toThrow(/Usage: time/);
    expect(() => h.run('time soon')).toThrow(/Usage: time/);
  });

  it('weather validates kinds and intensities and returns to auto', () => {
    const h = harness();
    expect(h.run('weather')).toMatch(/^weather \w+/);
    expect(h.run('weather fog 0.5')).toMatch(/^weather fog intensity 0.50/);
    expect(h.env.serialize().override).toEqual({ kind: 'fog', intensity: 0.5 });
    expect(h.run('weather snow')).toMatch(/^weather snow intensity 1.00/);
    expect(() => h.run('weather hail')).toThrow(/kinds: clear, cloudy/);
    expect(() => h.run('weather rain 2')).toThrow(/intensity/);
    h.run('weather auto');
    expect(h.env.serialize().override).toBeNull();
  });

  it('tp accepts coordinates and POI kinds', () => {
    const h = harness();
    expect(h.run('tp 100 -250')).toBe('Teleported to (100, -250)');
    expect(h.calls).toEqual(['teleport 100.0 -250.0']);
    const out = h.run('tp station');
    const station = nearestPoi(city, 'station', 100, -250);
    expect(out).toContain(`station "${station?.name ?? ''}"`);
    expect(h.player).toEqual({ x: station?.entrance.x, z: station?.entrance.z });
    expect(() => h.run('tp 100')).toThrow(/Usage: tp/);
    expect(() => h.run('tp nowhere')).toThrow(/Usage: tp/);
    expect(() => h.run('tp 99999 0')).toThrow(/outside the world/);
  });

  it('tp to a district lands on a road of the nearest cell of that type', () => {
    const h = harness();
    const out = h.run('tp downtown');
    expect(out).toMatch(/^Teleported to downtown \(-?\d+, -?\d+\) on .+/);
    expect(city.districtAt(h.player.x, h.player.z)).toBe(0);
    const hit = city.graph.nearestEdge(h.player.x, h.player.z, 1, { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
    expect(hit?.distance ?? Infinity).toBeLessThan(0.5);
    // POI kinds that are also district names keep going to the POI.
    expect(h.run('tp hospital')).toMatch(/^Teleported to hospital "/);
    expect(h.run('tp rural')).toMatch(/^Teleported to rural/);
  });

  it('route plots a polyline to a POI and prints length, ETA and time', () => {
    const h = harness();
    const out = h.run('route hospital');
    expect(out).toMatch(/^Route to hospital ".+": \d+\.\d\d km, ETA \d+\.\d min \(computed in \d+\.\d\d ms\)$/);
    expect(h.route.value).toBeInstanceOf(Float32Array);
    expect(h.route.value?.length ?? 0).toBeGreaterThanOrEqual(4);
    const hospital = nearestPoi(city, 'hospital', city.spawn.x, city.spawn.z);
    const poly = h.route.value ?? new Float32Array(0);
    expect(poly[poly.length - 2]).toBeCloseTo(hospital?.entrance.x ?? NaN, 0);
    expect(poly[poly.length - 1]).toBeCloseTo(hospital?.entrance.z ?? NaN, 0);

    expect(h.run('route 0 0')).toMatch(/^Route to \(0, 0\): /);
    expect(h.run('route off')).toBe('Route cleared');
    expect(h.route.value).toBeNull();
    expect(() => h.run('route')).toThrow(/Usage: route/);
    expect(() => h.run('route 1 2 3')).toThrow(/Usage: route/);
  });

  it('road describes the nearest street', () => {
    const h = harness();
    const edge = city.graph.edges[0];
    if (!edge) throw new Error('empty graph');
    const mx = ((edge.points[0] ?? 0) + (edge.points[2] ?? 0)) / 2;
    const mz = ((edge.points[1] ?? 0) + (edge.points[3] ?? 0)) / 2;
    h.player.x = mx;
    h.player.z = mz;
    const out = h.run('road');
    expect(out.split('\n')[0]).toContain(edge.name);
    expect(out).toMatch(/limit now \d+ mph \(posted \d+ mph\)/);
    expect(out).toContain('zones:');
  });

  it('car info, refuel, repair and spawn', () => {
    const h = harness();
    expect(h.run('car')).toMatch(/^speed 45 mph {2}gear 3/);
    expect(h.run('car info')).toContain('fuel 10.0 L (14%)');
    expect(h.run('car refuel')).toBe('Refuelled: 70.0 L');
    expect(h.run('car repair')).toBe('Repaired');
    expect(h.run('car spawn sedan')).toBe('Spawned sedan');
    expect(h.calls).toEqual(['refuel', 'repair', 'spawn sedan']);
    expect(() => h.run('car spawn spaceship')).toThrow(/models: .*patrol_sedan/);
    expect(() => h.run('car fly')).toThrow(/Usage: car/);
    h.inVehicle.value = false;
    expect(() => h.run('car info')).toThrow(/Not in a vehicle/);
  });

  it('traffic stats and clear', () => {
    const h = harness();
    expect(h.run('traffic')).toBe('traffic active 42  proxies 7  spawned 100  despawned 58');
    expect(h.run('traffic clear')).toBe('Traffic cleared');
    expect(h.calls).toEqual(['clearTraffic']);
    expect(() => h.run('traffic jam')).toThrow(/Usage: traffic/);
  });

  it('traffic density validates and forwards the scale', () => {
    const h = harness();
    expect(h.run('traffic density 0.5')).toBe('Traffic density x0.50');
    expect(h.run('traffic density 0')).toBe('Traffic density x0.00');
    expect(h.calls).toEqual(['density 0.5', 'density 0']);
    expect(() => h.run('traffic density')).toThrow(/Usage: traffic/);
    expect(() => h.run('traffic density 9')).toThrow(/Usage: traffic/);
    expect(() => h.run('traffic density lots')).toThrow(/Usage: traffic/);
  });

  it('traffic list shows id, plate, model, distance, speed, violations and record flags', () => {
    const h = harness();
    const lines = h.run('traffic list').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^id\s+plate\s+model\s+dist\s+mph\s+violations/);
    expect(lines[1]).toMatch(/^17\s+ABC 1234\s+sedan\s+42 m\s+31\s+speeding x2, redLight, stolen$/);
    expect(lines[2]).toMatch(/^9\s+XYZ 0001\s+van\s+80 m\s+0\s+crashed$/);
    expect(h.run('traffic list 1').split('\n')).toHaveLength(2);
    expect(() => h.run('traffic list 0')).toThrow(/1\.\.200/);
  });

  it('plate looks up found and missing records', () => {
    const h = harness();
    const found = h.run('plate abc 1234');
    expect(found.split('\n')[0]).toBe('ABC 1234');
    expect(found).toMatch(/modelId\s+sedan/);
    expect(found).toContain('{"speeding":true}');
    expect(h.run('plate XYZ 0001')).toBe('No record for XYZ 0001');
    expect(() => h.run('plate')).toThrow(/Usage: plate/);
    expect(() => h.run('plate 1234 ABC')).toThrow(/Usage: plate/);
  });

  it('chunks prints streamer stats', () => {
    expect(harness().run('chunks')).toBe('chunks loaded 30 (lod0 9, lod1 21)  in flight 2');
  });

  it('reports missing session state readably', () => {
    const h = harness();
    const deps: WorldCommandDeps = {
      ...h.deps,
      city: () => null,
      environment: () => null,
      trafficStats: () => null,
      chunkStats: () => null,
    };
    const commands = new Map(createWorldCommands(deps).map((c) => [c.name, c]));
    expect(() => commands.get('time')?.run([], ctx)).toThrow(/Environment unavailable/);
    expect(() => commands.get('road')?.run([], ctx)).toThrow(/City unavailable/);
    expect(() => commands.get('traffic')?.run([], ctx)).toThrow(/Traffic unavailable/);
    expect(() => commands.get('chunks')?.run([], ctx)).toThrow(/Chunk streamer unavailable/);
  });
});
