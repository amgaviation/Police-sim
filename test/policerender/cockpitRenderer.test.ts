import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { PrevTransform, Transform } from '../../src/ecs/components';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { RACK_ITEMS } from '../../src/police/equipment';
import { cockpitParts, LED_COUNT, ledColors } from '../../src/render/police/cockpitParts';
import { CockpitRenderer } from '../../src/render/police/cockpitRenderer';
import { interpolateTransform } from '../../src/render/meshSync';
import { vehicleModel } from '../../src/vehicles/model';
import { cockpitState, fakeCanvas } from './helpers';

const SEDAN = vehicleModel('patrol_sedan');
const SUV = vehicleModel('patrol_suv');
const PLAIN = vehicleModel('sedan');

function car(x: number, z: number, yaw: number, prev = { x, z, yaw }): EntityId {
  const world = createGameWorld();
  const eid = spawn(world, Transform, PrevTransform);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const pq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prev.yaw);
  Transform.x[eid] = x;
  Transform.y[eid] = 0.9;
  Transform.z[eid] = z;
  Transform.qx[eid] = q.x;
  Transform.qy[eid] = q.y;
  Transform.qz[eid] = q.z;
  Transform.qw[eid] = q.w;
  PrevTransform.x[eid] = prev.x;
  PrevTransform.y[eid] = 0.9;
  PrevTransform.z[eid] = prev.z;
  PrevTransform.qx[eid] = pq.x;
  PrevTransform.qy[eid] = pq.y;
  PrevTransform.qz[eid] = pq.z;
  PrevTransform.qw[eid] = pq.w;
  return eid;
}

function group(scene: THREE.Scene): THREE.Object3D {
  const g = scene.getObjectByName('cockpit');
  if (!g) throw new Error('missing cockpit group');
  return g;
}

function instanced(scene: THREE.Scene, name: string): THREE.InstancedMesh {
  const m = scene.getObjectByName(name);
  if (!(m instanceof THREE.InstancedMesh)) throw new Error(`missing ${name}`);
  return m as THREE.InstancedMesh;
}

describe('CockpitRenderer', () => {
  it('constructs headless, hidden, with no meshes until a patrol vehicle is set', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    expect(group(scene).visible).toBe(false);
    cockpit.update(1, true, cockpitState());
    expect(group(scene).visible).toBe(false);
    expect(cockpit.stats.drawCalls).toBe(0);
    expect(cockpit.radioPaints).toBe(0); // no document: no radio canvas
    cockpit.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('shows at most six draw calls only when visible, placed at the interpolated transform', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    const eid = car(10, -4, 0.7, { x: 8, z: -2, yaw: 0.3 });
    cockpit.setVehicle(eid, SEDAN);
    expect(group(scene).children.length).toBe(6);

    cockpit.update(0.25, false, cockpitState());
    expect(group(scene).visible).toBe(false);
    expect(cockpit.stats.drawCalls).toBe(0);

    cockpit.update(0.25, true, cockpitState());
    expect(group(scene).visible).toBe(true);
    expect(cockpit.stats.drawCalls).toBe(6);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    interpolateTransform(eid, 0.25, pos, quat);
    expect(group(scene).position.distanceTo(pos)).toBeLessThan(1e-6);
    expect(group(scene).quaternion.angleTo(quat)).toBeLessThan(1e-6);
    for (const child of group(scene).children) expect(child.frustumCulled).toBe(false);

    // Back out of cockpit view, then into a car without equipment.
    cockpit.update(1, false, cockpitState());
    expect(group(scene).visible).toBe(false);
    cockpit.setVehicle(eid, PLAIN);
    expect(group(scene).children.length).toBe(0);
    cockpit.update(1, true, cockpitState());
    expect(group(scene).visible).toBe(false);
    expect(cockpit.stats.drawCalls).toBe(0);
    cockpit.setVehicle(0, null);
    cockpit.update(1, true, cockpitState());
    expect(group(scene).visible).toBe(false);
    cockpit.dispose();
  });

  it('rebuilds only when the model changes and frees the old geometry', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    const eid = car(0, 0, 0);
    cockpit.setVehicle(eid, SEDAN);
    const interior = scene.getObjectByName('cockpit-interior') as THREE.Mesh;
    const disposed = vi.fn();
    interior.geometry.addEventListener('dispose', disposed);
    cockpit.setVehicle(eid, SEDAN);
    expect(scene.getObjectByName('cockpit-interior')).toBe(interior);
    expect(disposed).not.toHaveBeenCalled();
    cockpit.setVehicle(eid, SUV);
    expect(disposed).toHaveBeenCalled();
    expect(scene.getObjectByName('cockpit-interior')).not.toBe(interior);
    cockpit.dispose();
  });

  it('writes LED colours from the state only when they change', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    const leds = instanced(scene, 'cockpit-leds');
    expect(leds.count).toBe(LED_COUNT);
    const state = cockpitState({ sirenOn: true, tone: 1, lightsOn: true, rackLocked: false });
    cockpit.update(1, true, state);
    const expected = ledColors(state, new Float32Array(LED_COUNT * 3));
    expect(Array.from(leds.instanceColor?.array ?? [])).toEqual(Array.from(expected));
    const version = leds.instanceColor?.version ?? 0;
    cockpit.update(1, true, state);
    expect(leds.instanceColor?.version).toBe(version);
    cockpit.update(1, true, cockpitState({ horn: true }));
    expect(leds.instanceColor?.version).toBeGreaterThan(version);
    cockpit.dispose();
  });

  it('shows racked guns and hides checked-out ones', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    const cage = instanced(scene, 'cockpit-cage');
    const parts = cockpitParts(SEDAN);
    const bars = parts.filter((p) => p.kind === 'cageBar').length;
    expect(cage.count).toBe(bars + RACK_ITEMS.length);
    /** Height of gun `i` (the matrix Y column length; hidden guns get a zero matrix). */
    const scale = (i: number): number => {
      const e = cage.getMatrixAt(bars + i, new THREE.Matrix4()).elements;
      return Math.hypot(e[4] ?? 0, e[5] ?? 0, e[6] ?? 0);
    };
    cockpit.update(1, true, cockpitState({ racked: [true, false] }));
    expect(scale(0)).toBeGreaterThan(0.3);
    expect(scale(1)).toBe(0);
    const version = cage.instanceMatrix.version;
    cockpit.update(1, true, cockpitState({ racked: [true, false] }));
    expect(cage.instanceMatrix.version).toBe(version);
    cockpit.update(1, true, cockpitState({ racked: [false, true] }));
    expect(scale(0)).toBe(0);
    expect(scale(1)).toBeGreaterThan(0.3);
    cockpit.dispose();
  });

  it('repaints the radio display only when channel or flags change', () => {
    const scene = new THREE.Scene();
    const { canvas, ctx } = fakeCanvas(128, 32);
    const cockpit = new CockpitRenderer(scene, { createCanvas: () => canvas });
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    cockpit.update(1, true, cockpitState());
    expect(cockpit.radioPaints).toBe(1);
    expect(ctx.texts).toContain('DISPATCH 1');
    for (let i = 0; i < 5; i++) cockpit.update(1, true, cockpitState());
    expect(cockpit.radioPaints).toBe(1);
    cockpit.update(1, true, cockpitState({ radioTx: true }));
    expect(cockpit.radioPaints).toBe(2);
    expect(ctx.texts).toContain('TX');
    cockpit.update(1, true, cockpitState({ radioTx: true, radioChannel: 'Ops 2' }));
    expect(cockpit.radioPaints).toBe(3);
    cockpit.update(1, false, cockpitState({ emergency: true }));
    expect(cockpit.radioPaints).toBe(3); // hidden: nothing repainted
    cockpit.dispose();
  });

  it('shows the MDT canvas on the screen and uploads it when marked dirty', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    const screen = scene.getObjectByName('cockpit-screen') as THREE.Mesh;
    const material = screen.material as THREE.MeshBasicMaterial;
    expect(material.map).toBeNull();
    cockpit.markScreenDirty(); // no source: no-op

    const { canvas } = fakeCanvas(512, 320);
    cockpit.setScreenSource(canvas);
    const texture = material.map;
    if (!(texture instanceof THREE.CanvasTexture)) throw new Error('expected a CanvasTexture');
    expect(texture.image).toBe(canvas);
    cockpit.setScreenSource(canvas); // same canvas: same texture
    expect(material.map).toBe(texture);
    const version = texture.version;
    cockpit.markScreenDirty();
    expect(texture.version).toBeGreaterThan(version);

    const disposed = vi.fn();
    texture.addEventListener('dispose', disposed);
    cockpit.setScreenSource(null);
    expect(disposed).toHaveBeenCalled();
    expect(material.map).toBeNull();
    cockpit.dispose();
  });

  it('creates no objects per frame and dispose frees everything', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    let before = 0;
    group(scene).traverse(() => before++);
    for (let f = 0; f < 20; f++) {
      cockpit.update(f / 20, true, cockpitState({ sirenOn: f % 2 === 0, racked: [f % 3 === 0, true] }));
    }
    let after = 0;
    group(scene).traverse(() => after++);
    expect(after).toBe(before);

    const interior = scene.getObjectByName('cockpit-interior') as THREE.Mesh;
    const geometry = vi.fn();
    const material = vi.fn();
    interior.geometry.addEventListener('dispose', geometry);
    (interior.material as THREE.Material).addEventListener('dispose', material);
    cockpit.dispose();
    expect(geometry).toHaveBeenCalled();
    expect(material).toHaveBeenCalled();
    expect(scene.getObjectByName('cockpit')).toBeUndefined();
  });

  it('updates within the frame budget', () => {
    const scene = new THREE.Scene();
    const cockpit = new CockpitRenderer(scene);
    cockpit.setVehicle(car(0, 0, 0), SEDAN);
    const states = [cockpitState(), cockpitState({ sirenOn: true, horn: true })];
    for (let f = 0; f < 100; f++) cockpit.update(0.5, true, states[f % 2] ?? cockpitState());
    const frames = 2000;
    const start = performance.now();
    for (let f = 0; f < frames; f++) cockpit.update(0.5, true, states[f % 2] ?? cockpitState());
    const ms = (performance.now() - start) / frames;
    // Budget 0.1 ms/frame in a browser; headroom for slow CI.
    expect(ms).toBeLessThan(0.1);
    cockpit.dispose();
  });
});
