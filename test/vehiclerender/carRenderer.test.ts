import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, despawn, spawn, type GameWorld } from '../../src/ecs/world';
import { interpolateTransform } from '../../src/render/meshSync';
import { buildCarParts, LENS_KINDS } from '../../src/render/vehicles/carParts';
import { CarRenderer, type WheelSource } from '../../src/render/vehicles/carRenderer';
import { attachVehicleLook, FAULT, LIGHT, VehicleLook } from '../../src/vehicles/components';
import type { WheelPose } from '../../src/vehicles/drivableVehicle';
import { VEHICLE_MODELS, vehicleModel } from '../../src/vehicles/model';

const SEDAN = vehicleModel('patrol_sedan');
const VAN = vehicleModel('van');

function setPose(eid: EntityId, x: number, y: number, z: number, yaw: number, prev = { x, y, z, yaw }): void {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const pq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prev.yaw);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Transform.z[eid] = z;
  Transform.qx[eid] = q.x;
  Transform.qy[eid] = q.y;
  Transform.qz[eid] = q.z;
  Transform.qw[eid] = q.w;
  PrevTransform.x[eid] = prev.x;
  PrevTransform.y[eid] = prev.y;
  PrevTransform.z[eid] = prev.z;
  PrevTransform.qx[eid] = pq.x;
  PrevTransform.qy[eid] = pq.y;
  PrevTransform.qz[eid] = pq.z;
  PrevTransform.qw[eid] = pq.w;
}

function addCar(world: GameWorld, modelIndex: number, x: number, z: number, color = 0x3366cc): EntityId {
  const eid = spawn(world, Transform, PrevTransform);
  attachVehicleLook(world, eid, modelIndex, color);
  setPose(eid, x, 0.9, z, 0);
  return eid;
}

function mesh(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const found = scene.getObjectByName(name);
  if (!(found instanceof THREE.InstancedMesh)) throw new Error(`missing mesh ${name}`);
  return found as THREE.InstancedMesh;
}

function setup(options?: { maxPerModel?: number }) {
  const scene = new THREE.Scene();
  const world = createGameWorld();
  const cars = new CarRenderer(scene, world, options);
  return { scene, world, cars };
}

function lensIndex(kind: (typeof LENS_KINDS)[number], model = SEDAN): number {
  return buildCarParts(model)
    .filter((p) => LENS_KINDS.includes(p.kind))
    .findIndex((p) => p.kind === kind);
}

function lensColor(scene: THREE.Scene, i: number): THREE.Color {
  return mesh(scene, 'car-lenses').getColorAt(i, new THREE.Color());
}

describe('CarRenderer', () => {
  it('draws one instance per car in its model meshes and shares wheels and lenses', () => {
    const { scene, world, cars } = setup();
    addCar(world, SEDAN.index, 0, 0);
    addCar(world, SEDAN.index, 10, 0);
    addCar(world, VAN.index, 20, 0);
    cars.update(1, 0, 0, false);

    expect(mesh(scene, 'car-body:patrol_sedan').count).toBe(2);
    expect(mesh(scene, 'car-glass:patrol_sedan').count).toBe(2);
    expect(mesh(scene, 'car-body:van').count).toBe(1);
    expect(mesh(scene, 'car-body:sedan').count).toBe(0);
    expect(mesh(scene, 'car-body:sedan').visible).toBe(false);
    expect(mesh(scene, 'car-wheels').count).toBe(12);
    expect(mesh(scene, 'car-lenses').count).toBe(2 * 6 + 4);
    expect(cars.stats).toEqual({ cars: 3, drawCalls: 2 * 2 + 2 });
    for (const m of [mesh(scene, 'car-body:van'), mesh(scene, 'car-wheels'), mesh(scene, 'car-lenses')]) {
      expect(m.frustumCulled).toBe(false);
      expect(m.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
    }
    cars.dispose();
  });

  it('places bodies at the interpolated transform and paints them with the look colour', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0, 0xff0000);
    setPose(eid, 4, 0.9, -2, 0.8, { x: 2, y: 0.9, z: -1, yaw: 0.2 });
    cars.update(0.25, 0, 0, false);

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    interpolateTransform(eid, 0.25, pos, quat);
    const expected = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
    const actual = mesh(scene, 'car-body:patrol_sedan').getMatrixAt(0, new THREE.Matrix4());
    expected.elements.forEach((v, i) => expect(actual.elements[i]).toBeCloseTo(v, 5));
    const glass = mesh(scene, 'car-glass:patrol_sedan').getMatrixAt(0, new THREE.Matrix4());
    expected.elements.forEach((v, i) => expect(glass.elements[i]).toBeCloseTo(v, 5));
    expect(mesh(scene, 'car-body:patrol_sedan').getColorAt(0, new THREE.Color()).getHex()).toBe(0xff0000);
    cars.dispose();
  });

  it('tints and crumples damaged bodies', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0, 0xffffff);
    VehicleLook.damage[eid * 4] = 1; // front
    cars.update(1, 0, 0, false);
    const body = mesh(scene, 'car-body:patrol_sedan');
    const color = body.getColorAt(0, new THREE.Color());
    expect(color.r).toBeLessThan(0.8); // white blended 30% toward dark grey
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    body.getMatrixAt(0, new THREE.Matrix4()).decompose(pos, new THREE.Quaternion(), scale);
    expect(scale.z).toBeLessThan(1);
    expect(pos.z).toBeGreaterThan(0); // pushed back from the front (-Z)
    cars.dispose();
  });

  it('colours lenses from the LIGHT and FAULT bits', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    VehicleLook.lights[eid] = LIGHT.head | LIGHT.brake;
    VehicleLook.faults[eid] = FAULT.headLeftOut;
    cars.update(1, 1, 0, false);
    expect(lensColor(scene, lensIndex('headLeft')).r).toBeLessThan(0.1);
    expect(lensColor(scene, lensIndex('headRight')).r).toBeGreaterThan(0.7);
    const braking = lensColor(scene, lensIndex('tailLeft'));
    expect(braking.r).toBeGreaterThan(0.9);
    expect(braking.g).toBeLessThan(0.1);

    VehicleLook.lights[eid] = LIGHT.head;
    cars.update(1, 1, 0, false);
    const dim = lensColor(scene, lensIndex('tailRight')).r;
    expect(dim).toBeGreaterThan(0.2);
    expect(dim).toBeLessThan(braking.r);

    VehicleLook.lights[eid] = LIGHT.head | LIGHT.brake;
    VehicleLook.faults[eid] = FAULT.brakeOut;
    cars.update(1, 1, 0, false);
    expect(lensColor(scene, lensIndex('tailRight')).r).toBeCloseTo(dim, 5);

    VehicleLook.faults[eid] = FAULT.tailOut;
    cars.update(1, 1, 0, false);
    expect(lensColor(scene, lensIndex('tailLeft')).r).toBeLessThan(0.1);

    VehicleLook.faults[eid] = 0;
    VehicleLook.lights[eid] = LIGHT.reverse;
    cars.update(1, 1, 0, false);
    const reverse = lensColor(scene, lensIndex('tailLeft'));
    expect(reverse.g).toBeGreaterThan(0.8);
    expect(lensColor(scene, lensIndex('headLeft')).r).toBeLessThan(0.3); // heads off

    VehicleLook.lights[eid] = LIGHT.hazard;
    cars.update(1, 1, 0.1, false); // 1.5 Hz: on for the first third of a second
    expect(lensColor(scene, lensIndex('headLeft')).g).toBeGreaterThan(0.3);
    cars.update(1, 1, 0.5, false);
    expect(lensColor(scene, lensIndex('headLeft')).r).toBeLessThan(0.3);
    cars.dispose();
  });

  it('makes headlights brighter at night', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    VehicleLook.lights[eid] = LIGHT.head;
    cars.update(1, 0, 0, false);
    const day = lensColor(scene, lensIndex('headLeft')).r;
    cars.update(1, 1, 0, false);
    expect(lensColor(scene, lensIndex('headLeft')).r).toBeGreaterThan(day);
    cars.dispose();
  });

  it('alternates the light bar halves, slower and dimmer with reducedFlash', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    const red = lensIndex('lightbarRed');
    const blue = lensIndex('lightbarBlue');
    cars.update(1, 0, 0, false);
    const offRed = lensColor(scene, red).r;

    VehicleLook.lights[eid] = LIGHT.lightbar;
    cars.update(1, 0, 0, false);
    expect(lensColor(scene, red).r).toBeGreaterThan(0.9);
    expect(lensColor(scene, blue).b).toBeLessThan(0.3);
    cars.update(1, 0, 0.3, false); // 2 Hz: second half of the period
    expect(lensColor(scene, red).r).toBeLessThan(0.3);
    expect(lensColor(scene, blue).b).toBeGreaterThan(0.9);

    cars.update(1, 0, 0.3, true); // 0.5 Hz: still the red half
    const reducedRed = lensColor(scene, red).r;
    expect(reducedRed).toBeGreaterThan(offRed);
    expect(reducedRed).toBeLessThan(0.9);
    cars.update(1, 0, 1.2, true);
    expect(lensColor(scene, red).r).toBeLessThan(0.3);
    expect(lensColor(scene, blue).b).toBeGreaterThan(offRed);
    cars.dispose();
  });

  it('draws drivable wheels from the WheelSource and spins traffic wheels by distance', () => {
    const { scene, world, cars } = setup();
    const driven = addCar(world, SEDAN.index, 10, 5);
    const traffic = addCar(world, VAN.index, 50, 0);
    const calls: number[] = [];
    const source: WheelSource = {
      wheelCount: 4,
      wheelPose(i: number, out: WheelPose): WheelPose {
        calls.push(i);
        out.x = i % 2 === 0 ? -0.9 : 0.9;
        out.y = -0.3;
        out.z = i < 2 ? -1.4 : 1.4;
        out.steer = i < 2 ? 0.3 : 0;
        out.spin = 0;
        out.radius = 0.25;
        out.inContact = true;
        return out;
      },
    };
    cars.setDrivable(driven, source);
    cars.update(1, 0, 0, false);
    expect(calls).toEqual([0, 1, 2, 3]);

    const wheels = mesh(scene, 'car-wheels');
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    wheels.getMatrixAt(0, new THREE.Matrix4()).decompose(pos, quat, scale);
    expect(pos.x).toBeCloseTo(9.1, 5);
    expect(pos.y).toBeCloseTo(0.6, 5);
    expect(pos.z).toBeCloseTo(3.6, 5);
    expect(scale.y).toBeCloseTo(0.25, 5);
    expect(scale.x).toBeCloseTo(SEDAN.tires.width, 5);
    // Steered left: the wheel's axle (+X) turns toward -Z.
    const axle = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
    expect(axle.z).toBeCloseTo(-Math.sin(0.3), 5);

    // Traffic wheels: rest positions and a spin that follows the distance rolled.
    const before = new THREE.Quaternion();
    wheels.getMatrixAt(4, new THREE.Matrix4()).decompose(pos, before, scale);
    expect(scale.y).toBeCloseTo(VAN.tires.radius, 5);
    expect(pos.y - VAN.tires.radius).toBeCloseTo(0.9 - (VAN.body.height / 2 + VAN.body.groundClearance), 5);
    setPose(traffic, 50, 0.9, -1, 0, { x: 50, y: 0.9, z: 0, yaw: 0 }); // 1 m forward (-Z)
    cars.update(1, 0, 0, false);
    const after = new THREE.Quaternion();
    wheels.getMatrixAt(4, new THREE.Matrix4()).decompose(pos, after, scale);
    expect(before.angleTo(after)).toBeCloseTo(1 / VAN.tires.radius, 3);

    cars.setDrivable(driven, null);
    calls.length = 0;
    cars.update(1, 0, 0, false);
    expect(calls).toEqual([]);
    cars.dispose();
  });

  it('drops despawned entities on the next update and respects maxPerModel', () => {
    const { scene, world, cars } = setup({ maxPerModel: 2 });
    const a = addCar(world, SEDAN.index, 0, 0);
    const b = addCar(world, SEDAN.index, 5, 0);
    const c = addCar(world, SEDAN.index, 10, 0);
    cars.update(1, 0, 0, false);
    expect(mesh(scene, 'car-body:patrol_sedan').count).toBe(2);
    expect(cars.stats.cars).toBe(2);
    despawn(world, a);
    cars.update(1, 0, 0, false);
    expect(mesh(scene, 'car-body:patrol_sedan').count).toBe(2);
    despawn(world, b);
    despawn(world, c);
    cars.update(1, 0, 0, false);
    expect(mesh(scene, 'car-body:patrol_sedan').count).toBe(0);
    expect(mesh(scene, 'car-wheels').visible).toBe(false);
    expect(cars.stats).toEqual({ cars: 0, drawCalls: 0 });
    cars.dispose();
  });

  it('keeps two headlight spots in the scene and lights them only for the target with its head bit', () => {
    const { scene, world, cars } = setup();
    const eid = addCar(world, SEDAN.index, 0, 0);
    const left = scene.getObjectByName('headlight-spot-left');
    const right = scene.getObjectByName('headlight-spot-right');
    if (!(left instanceof THREE.SpotLight) || !(right instanceof THREE.SpotLight)) throw new Error('missing spots');
    expect(left.castShadow).toBe(false);

    cars.setHeadlightTarget(eid);
    cars.update(1, 1, 0, false);
    expect(left.intensity).toBe(0);

    VehicleLook.lights[eid] = LIGHT.head;
    cars.update(1, 1, 0, false);
    expect(left.intensity).toBeGreaterThan(0);
    expect(right.intensity).toBeGreaterThan(0);
    expect(left.position.z).toBeLessThan(-SEDAN.body.length / 2);
    expect(left.position.x).toBeLessThan(0);
    expect(left.target.position.z).toBeLessThan(left.position.z);

    VehicleLook.faults[eid] = FAULT.headRightOut;
    cars.update(1, 1, 0, false);
    expect(right.intensity).toBe(0);

    cars.setHeadlightTarget(0);
    cars.update(1, 1, 0, false);
    expect(left.intensity).toBe(0);
    cars.dispose();
  });

  it('creates no objects per frame and dispose removes and frees everything', () => {
    const { scene, world, cars } = setup();
    for (let i = 0; i < 5; i++) addCar(world, i % 3, i * 8, 0);
    const group = scene.getObjectByName('vehicles');
    if (!group) throw new Error('missing group');
    const sceneChildren = scene.children.length;
    let objects = 0;
    group.traverse(() => objects++);
    for (let f = 0; f < 10; f++) cars.update(f / 10, 0.5, f / 60, f % 2 === 0);
    let after = 0;
    group.traverse(() => after++);
    expect(scene.children.length).toBe(sceneChildren);
    expect(after).toBe(objects);

    const body = mesh(scene, 'car-body:patrol_sedan');
    const geometryDisposed = vi.fn();
    const materialDisposed = vi.fn();
    body.geometry.addEventListener('dispose', geometryDisposed);
    (body.material as THREE.Material).addEventListener('dispose', materialDisposed);
    cars.dispose();
    expect(scene.children.length).toBe(0);
    expect(scene.getObjectByName('vehicles')).toBeUndefined();
    expect(geometryDisposed).toHaveBeenCalled();
    expect(materialDisposed).toHaveBeenCalled();
  });

  it('updates 200 cars within the frame budget', () => {
    const { world, cars } = setup({ maxPerModel: 64 });
    for (let i = 0; i < 200; i++) {
      const eid = addCar(world, i % VEHICLE_MODELS.length, (i % 20) * 8, Math.floor(i / 20) * 8);
      VehicleLook.lights[eid] = LIGHT.head | (i % 3 === 0 ? LIGHT.brake : 0) | (i % 9 === 0 ? LIGHT.lightbar : 0);
    }
    for (let f = 0; f < 60; f++) cars.update(0.5, 1, f / 60, false);
    const frames = 200;
    const start = performance.now();
    for (let f = 0; f < frames; f++) cars.update(0.5, 1, f / 60, false);
    const ms = (performance.now() - start) / frames;
    expect(cars.stats.cars).toBe(200);
    // The budget is 0.4 ms on a desktop browser; leave headroom for slow CI machines.
    expect(ms).toBeLessThan(2);
    cars.dispose();
  });
});
