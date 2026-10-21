import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, spawn, type GameWorld } from '../../src/ecs/world';
import { attachPoliceLights, PoliceLights } from '../../src/police/components';
import { LIGHTBAR_SEGMENTS, lightbarColors, patternIndex } from '../../src/police/lightbar';
import { buildCarParts, LENS_KINDS } from '../../src/render/vehicles/carParts';
import { CarRenderer, lensWorld } from '../../src/render/vehicles/carRenderer';
import type { GlowSink } from '../../src/render/vfx/types';
import { attachVehicleLook, FAULT, LIGHT, VehicleLook } from '../../src/vehicles/components';
import { vehicleModel } from '../../src/vehicles/model';

const SEDAN = vehicleModel('patrol_sedan');

interface Glow {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  kind: number;
}
interface Pool {
  x: number;
  z: number;
  r: number;
  g: number;
  b: number;
}
interface Beam {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

class Recorder implements GlowSink {
  readonly calls: string[] = [];
  glows: Glow[] = [];
  pools: Pool[] = [];
  beams: Beam[] = [];
  begin(): void {
    this.calls.push('begin');
    this.glows = [];
    this.pools = [];
    this.beams = [];
  }
  glow(x: number, y: number, z: number, r: number, g: number, b: number, kind: number): void {
    this.glows.push({ x, y, z, r, g, b, kind });
  }
  pool(x: number, z: number, r: number, g: number, b: number): void {
    this.pools.push({ x, z, r, g, b });
  }
  beam(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    this.beams.push({ x, y, z, dx, dy, dz });
  }
  end(): void {
    this.calls.push('end');
  }
}

function setPose(eid: EntityId, x: number, z: number, yaw: number): void {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  for (const T of [Transform, PrevTransform]) {
    T.x[eid] = x;
    T.y[eid] = 0.9;
    T.z[eid] = z;
    T.qx[eid] = q.x;
    T.qy[eid] = q.y;
    T.qz[eid] = q.z;
    T.qw[eid] = q.w;
  }
}

function addCar(world: GameWorld, x: number, z: number, yaw = 0, lights = 0): EntityId {
  const eid = spawn(world, Transform, PrevTransform);
  attachVehicleLook(world, eid, SEDAN.index, 0x3366cc);
  setPose(eid, x, z, yaw);
  VehicleLook.lights[eid] = lights;
  return eid;
}

function setup(sink: GlowSink | null = new Recorder()) {
  const scene = new THREE.Scene();
  const world = createGameWorld();
  const cars = new CarRenderer(scene, world);
  cars.setGlowSink(sink);
  const lens = scene.getObjectByName('car-lenses') as THREE.InstancedMesh;
  return { scene, world, cars, lens, sink };
}

const lensIndex = (kind: (typeof LENS_KINDS)[number]): number =>
  buildCarParts(SEDAN)
    .filter((p) => LENS_KINDS.includes(p.kind))
    .findIndex((p) => p.kind === kind);

const segmentIndex = (segment: number): number =>
  buildCarParts(SEDAN)
    .filter((p) => LENS_KINDS.includes(p.kind))
    .findIndex((p) => p.kind === 'lightbar' && p.segment === segment);

const posOf = (m: THREE.InstancedMesh, i: number): THREE.Vector3 =>
  new THREE.Vector3().setFromMatrixPosition(m.getMatrixAt(i, new THREE.Matrix4()));
const colorOf = (m: THREE.InstancedMesh, i: number): THREE.Color => m.getColorAt(i, new THREE.Color());

describe('lensWorld', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  it('adds the local point to the origin for an identity basis', () => {
    const out = [0, 0, 0];
    lensWorld(identity, [10, 20, 30], 1, 2, 3, out);
    expect(out).toEqual([11, 22, 33]);
  });

  it('rotates by the column-major basis', () => {
    // Yaw 90 degrees: columns (c, 0, -s), (0, 1, 0), (s, 0, c) with s = 1.
    const rot = [0, 0, -1, 0, 1, 0, 1, 0, 0];
    const out = new Float64Array(3);
    lensWorld(rot, [0, 0, 0], 1, 2, 3, out);
    expect(Array.from(out)).toEqual([3, 2, -1]);
  });

  it('matches the matrix three composes from the same quaternion', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.9, -0.3));
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const rot = Array.from(m.elements).filter((_, i) => i % 4 !== 3 && i < 11);
    const out = [0, 0, 0];
    lensWorld(rot, [1, 2, 3], 0.5, -0.25, 2, out);
    const expected = new THREE.Vector3(0.5, -0.25, 2).applyMatrix4(m).add(new THREE.Vector3(1, 2, 3));
    expect(out[0]).toBeCloseTo(expected.x, 9);
    expect(out[1]).toBeCloseTo(expected.y, 9);
    expect(out[2]).toBeCloseTo(expected.z, 9);
  });
});

describe('CarRenderer glow sink', () => {
  it('reports bar glows with the written colours and one pool for a police car with the bar on', () => {
    const { world, cars, lens, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 7, -3, 0, LIGHT.lightbar);
    attachPoliceLights(world, eid, 0);
    const alt = patternIndex('alternate');
    PoliceLights.pattern[eid] = alt;
    cars.update(1, 0.5, 0.05, false);

    const codes = lightbarColors(alt, 0.05, false, new Uint8Array(LIGHTBAR_SEGMENTS));
    const lit = Array.from(codes).flatMap((c, s) => (c > 0 ? [s] : []));
    expect(lit.length).toBeGreaterThan(0);
    expect(rec.calls).toEqual(['begin', 'end']);
    const bars = rec.glows.filter((g) => g.kind === 0);
    expect(bars).toHaveLength(lit.length);
    expect(rec.glows.filter((g) => g.kind !== 0)).toHaveLength(0);
    lit.forEach((s, k) => {
      const g = bars[k];
      const i = segmentIndex(s);
      const c = colorOf(lens, i);
      const p = posOf(lens, i);
      expect([g?.r, g?.g, g?.b].map((v) => Number((v ?? 0).toFixed(5)))).toEqual([c.r, c.g, c.b].map((v) => Number(v.toFixed(5))));
      expect(g?.x).toBeCloseTo(p.x, 4);
      expect(g?.y).toBeCloseTo(p.y, 4);
      expect(g?.z).toBeCloseTo(p.z, 4);
    });
    expect(rec.pools).toHaveLength(1);
    const pool = rec.pools[0];
    expect(pool?.x).toBeCloseTo(7, 6);
    expect(pool?.z).toBeCloseTo(-3, 6);
    const mean = bars.reduce((a, g) => [a[0]! + g.r, a[1]! + g.g, a[2]! + g.b], [0, 0, 0]).map((v) => v / bars.length);
    expect(pool?.r).toBeCloseTo(mean[0] ?? 0, 5);
    expect(pool?.g).toBeCloseTo(mean[1] ?? 0, 5);
    expect(pool?.b).toBeCloseTo(mean[2] ?? 0, 5);
    expect(rec.beams).toHaveLength(0);
    cars.dispose();
  });

  it('follows the bar frames and reports nothing while the bar is off', () => {
    const { world, cars, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 0, 0);
    attachPoliceLights(world, eid, 0);
    PoliceLights.pattern[eid] = patternIndex('alternate');
    cars.update(1, 0, 0.05, false);
    expect(rec.glows).toHaveLength(0);
    expect(rec.pools).toHaveLength(0);
    VehicleLook.lights[eid] = LIGHT.lightbar;
    cars.update(1, 0, 0.05, false);
    const first = rec.glows.map((g) => g.x);
    cars.update(1, 0, 0.3, false);
    const second = rec.glows.map((g) => g.x);
    expect(first.length).toBe(4);
    expect(second.length).toBe(4);
    // Left half, then right half.
    expect(Math.max(...first)).toBeLessThan(Math.min(...second));
    cars.dispose();
  });

  it('reports the dimmed colours under reduced flash', () => {
    const { world, cars, lens, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 0, 0, 0, LIGHT.lightbar);
    attachPoliceLights(world, eid, 0);
    PoliceLights.pattern[eid] = patternIndex('alternate');
    cars.update(1, 0, 0.05, false);
    const full = Math.max(...rec.glows.map((g) => g.r));
    cars.update(1, 0, 0.05, true);
    const dim = Math.max(...rec.glows.map((g) => g.r));
    expect(dim).toBeLessThan(full);
    const g = rec.glows[0];
    const s = lit(rec, lens);
    expect(g?.r).toBeCloseTo(colorOf(lens, segmentIndex(s)).r, 5);
    cars.dispose();
  });

  it('reports head glows and one beam along the forward axis for a car with headlights', () => {
    const { world, cars, lens, sink } = setup();
    const rec = sink as Recorder;
    addCar(world, 4, 6, 0, LIGHT.head);
    cars.update(1, 1, 0, false);
    const heads = rec.glows.filter((g) => g.kind === 1);
    expect(heads).toHaveLength(2);
    expect(rec.glows.filter((g) => g.kind === 0)).toHaveLength(0);
    expect(rec.pools).toHaveLength(0);
    expect(rec.beams).toHaveLength(1);
    const b = rec.beams[0] as Beam;
    expect([b.dx, b.dy, b.dz].map((v) => Math.round(v * 1e6) / 1e6 + 0)).toEqual([0, 0, -1]);
    // The beam starts between the two lamps, at the front of the car.
    const hl = posOf(lens, lensIndex('headLeft'));
    const hr = posOf(lens, lensIndex('headRight'));
    expect(b.x).toBeCloseTo((hl.x + hr.x) / 2, 5);
    expect(b.y).toBeCloseTo((hl.y + hr.y) / 2, 5);
    expect(b.z).toBeCloseTo((hl.z + hr.z) / 2, 5);
    expect(b.z).toBeLessThan(6 - SEDAN.body.length / 2 + 0.5);
    for (const h of heads) expect(h.r).toBeGreaterThan(0.7);
    cars.dispose();
  });

  it('turns the beam with the car', () => {
    const { world, cars, sink } = setup();
    const rec = sink as Recorder;
    addCar(world, 0, 0, Math.PI / 2, LIGHT.head);
    cars.update(1, 1, 0, false);
    const b = rec.beams[0] as Beam;
    // Yaw +90 degrees about Y turns forward (-Z) to -X.
    expect(b.dx).toBeCloseTo(-1, 6);
    expect(b.dz).toBeCloseTo(0, 6);
    expect(b.x).toBeLessThan(-1);
    cars.dispose();
  });

  it('drops a faulted head lamp and the beam', () => {
    const { world, cars, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 0, 0, 0, LIGHT.head);
    VehicleLook.faults[eid] = FAULT.headLeftOut;
    cars.update(1, 1, 0, false);
    expect(rec.glows.filter((g) => g.kind === 1)).toHaveLength(1);
    expect(rec.beams).toHaveLength(0);
    VehicleLook.faults[eid] = 0;
    VehicleLook.lights[eid] = 0;
    cars.update(1, 1, 0, false);
    expect(rec.glows).toHaveLength(0);
    expect(rec.beams).toHaveLength(0);
    cars.dispose();
  });

  it('reports tail glows for brake lights and the hazard blink only', () => {
    const { world, cars, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 0, 0, 0, LIGHT.brake);
    cars.update(1, 1, 0, false);
    const tails = rec.glows.filter((g) => g.kind === 2);
    expect(tails).toHaveLength(2);
    expect(tails[0]?.r).toBeCloseTo(1, 6);
    expect(tails[0]?.g).toBeLessThan(0.1);
    VehicleLook.faults[eid] = FAULT.brakeOut;
    cars.update(1, 1, 0, false);
    expect(rec.glows).toHaveLength(0);
    VehicleLook.faults[eid] = FAULT.tailOut;
    cars.update(1, 1, 0, false);
    expect(rec.glows).toHaveLength(0);
    VehicleLook.faults[eid] = 0;
    VehicleLook.lights[eid] = LIGHT.hazard;
    cars.update(1, 1, 0.1, false); // blink on (first half of the 1.5 Hz period)
    expect(rec.glows.filter((g) => g.kind === 2)).toHaveLength(2);
    cars.update(1, 1, 0.5, false); // blink off
    expect(rec.glows).toHaveLength(0);
    // Reverse lamps and a plain tail lamp with the headlights on do not glow.
    VehicleLook.lights[eid] = LIGHT.reverse;
    cars.update(1, 1, 0.1, false);
    expect(rec.glows).toHaveLength(0);
    cars.dispose();
  });

  it('places glows on the crumpled body', () => {
    const { world, cars, lens, sink } = setup();
    const rec = sink as Recorder;
    const eid = addCar(world, 0, 0, 0.4, LIGHT.head | LIGHT.brake);
    VehicleLook.damage[eid * 4] = 1;
    VehicleLook.damage[eid * 4 + 1] = 0.5;
    cars.update(1, 1, 0, false);
    const heads = rec.glows.filter((g) => g.kind === 1);
    expect(heads).toHaveLength(2);
    const pl = posOf(lens, lensIndex('headLeft'));
    const pr = posOf(lens, lensIndex('headRight'));
    const xs = heads.map((g) => g.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(Math.min(pl.x, pr.x), 4);
    expect(xs[1]).toBeCloseTo(Math.max(pl.x, pr.x), 4);
    cars.dispose();
  });

  it('keeps a pool per police car and a beam per lit car across many cars', () => {
    const { world, cars, sink } = setup();
    const rec = sink as Recorder;
    for (let i = 0; i < 5; i++) {
      const eid = addCar(world, i * 8, 0, 0, LIGHT.lightbar | LIGHT.head);
      attachPoliceLights(world, eid, 0);
    }
    addCar(world, 100, 0, 0, 0);
    cars.update(1, 1, 0.05, false);
    expect(rec.pools).toHaveLength(5);
    expect(rec.beams).toHaveLength(5);
    expect(rec.calls).toEqual(['begin', 'end']);
    cars.dispose();
  });

  it('draws identical buffers with and without a sink, and tolerates removing it', () => {
    const run = (sink: GlowSink | null): { m: Float32Array; c: Float32Array; stats: string } => {
      const t = setup(sink);
      const eid = addCar(t.world, 3, 4, 0.7, LIGHT.lightbar | LIGHT.head | LIGHT.brake);
      attachPoliceLights(t.world, eid, 0.1);
      PoliceLights.pattern[eid] = patternIndex('quad');
      addCar(t.world, -5, 2, 1.2, LIGHT.head | LIGHT.hazard);
      t.cars.update(0.5, 0.6, 1.23, false);
      const out = {
        m: Float32Array.from(t.lens.instanceMatrix.array),
        c: Float32Array.from(t.lens.instanceColor?.array ?? []),
        stats: JSON.stringify(t.cars.stats),
      };
      t.cars.setGlowSink(null);
      t.cars.update(0.5, 0.6, 1.23, false);
      expect(Array.from(t.lens.instanceMatrix.array)).toEqual(Array.from(out.m));
      t.cars.dispose();
      return out;
    };
    const a = run(null);
    const b = run(new Recorder());
    expect(Array.from(b.m)).toEqual(Array.from(a.m));
    expect(Array.from(b.c)).toEqual(Array.from(a.c));
    expect(b.stats).toBe(a.stats);
  });
});

/** The index of the first lit bar segment of the recorder's first glow (matches by position). */
function lit(rec: Recorder, lens: THREE.InstancedMesh): number {
  const g = rec.glows[0] as Glow;
  for (let s = 0; s < LIGHTBAR_SEGMENTS; s++) {
    const p = posOf(lens, segmentIndex(s));
    if (Math.abs(p.x - g.x) < 1e-4 && Math.abs(p.z - g.z) < 1e-4) return s;
  }
  throw new Error('no matching segment');
}
