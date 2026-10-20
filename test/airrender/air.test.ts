import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AirView } from '../../src/resources/types';
import { AIR_CAMERA_FOV, AIR_SPOT, AirRenderer, airCameraAltitude, airCameraPose, airCameraYaw, createAirCameraPose } from '../../src/render/air';

function view(over: Partial<AirView> = {}): AirView {
  return { x: 100, y: 150, z: -200, yaw: 0, spot: false, targetX: 100, targetZ: -400, onTarget: false, rotor: 0, ...over };
}

function drawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    if (o instanceof THREE.Mesh) n++;
  });
  return n;
}

describe('airCameraPose', () => {
  it('hangs 3 m under the helicopter, looks at the target on the ground and zooms to fov 25', () => {
    const out = createAirCameraPose();
    const r = airCameraPose(view({ x: 10, y: 150, z: 20, targetX: -30, targetZ: 60 }), out);
    expect(r).toBe(out);
    expect(out).toEqual({ x: 10, y: 147, z: 20, lookX: -30, lookY: 0, lookZ: 60, fov: 25 });
    expect(AIR_CAMERA_FOV).toBe(25);
    expect(airCameraAltitude(out)).toBe(147);
  });

  it('reuses the output object', () => {
    const out = createAirCameraPose();
    airCameraPose(view({ x: 1 }), out);
    airCameraPose(view({ x: 2, y: 80 }), out);
    expect(out.x).toBe(2);
    expect(out.y).toBe(77);
  });

  it('gives the heading of the look direction in the world yaw convention (0 faces -Z, + turns toward -X)', () => {
    const pose = (tx: number, tz: number) => airCameraPose(view({ x: 0, z: 0, targetX: tx, targetZ: tz }), createAirCameraPose());
    expect(airCameraYaw(pose(0, -100))).toBeCloseTo(0);
    expect(airCameraYaw(pose(-100, 0))).toBeCloseTo(Math.PI / 2);
    expect(airCameraYaw(pose(100, 0))).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(airCameraYaw(pose(0, 100)))).toBeCloseTo(Math.PI);
    expect(airCameraYaw(pose(0, 0))).toBe(0);
  });
});

describe('AirRenderer', () => {
  it('adds one group with a body and a rotor mesh and a single spotlight, hidden until there is a view', () => {
    const scene = new THREE.Scene();
    const r = new AirRenderer(scene);
    expect(scene.children).toContain(r.group);
    let meshCount = 0;
    const lights: THREE.Light[] = [];
    r.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshCount++;
      if (o instanceof THREE.Light) lights.push(o);
    });
    expect(meshCount).toBe(2);
    expect(lights).toHaveLength(1);
    expect(lights[0]).toBeInstanceOf(THREE.SpotLight);
    expect(r.spot.castShadow).toBe(false);
    expect(r.spot.intensity).toBe(0);
    expect(r.heli.visible).toBe(false);
    expect(r.drawCalls).toBe(0);
    expect(drawCalls(scene)).toBe(0);
  });

  it('shows and places the helicopter, spins the rotor and keeps the light count constant', () => {
    const scene = new THREE.Scene();
    const r = new AirRenderer(scene);
    r.update(view({ x: 5, y: 120, z: -7, yaw: 0.5, rotor: 1.25 }), 1);
    expect(r.heli.visible).toBe(true);
    expect(r.heli.position.toArray()).toEqual([5, 120, -7]);
    expect(r.heli.rotation.y).toBeCloseTo(0.5);
    expect(r.rotor.rotation.y).toBeCloseTo(1.25);
    expect(r.drawCalls).toBe(2);
    expect(drawCalls(scene)).toBeLessThanOrEqual(3);
    expect(r.spot.visible).toBe(true); // never toggled: the light count stays the same
    r.update(null, 1);
    expect(r.heli.visible).toBe(false);
    expect(r.spot.visible).toBe(true);
    expect(drawCalls(scene)).toBe(0);
  });

  it('lights the target only while the spotlight is on and aims at the ground point', () => {
    const r = new AirRenderer(new THREE.Scene());
    r.update(view({ spot: true, targetX: 40, targetZ: -90 }), 1);
    expect(r.spot.intensity).toBe(AIR_SPOT.intensity);
    expect(r.spot.target.position.toArray()).toEqual([40, 0, -90]);
    expect(r.spot.position.y).toBeCloseTo(150 - AIR_SPOT.dropM);
    r.update(view({ spot: false }), 1);
    expect(r.spot.intensity).toBe(0);
  });

  it('interpolates between the last two distinct views by alpha, along the shortest turn', () => {
    const r = new AirRenderer(new THREE.Scene());
    r.update(view({ x: 0, y: 100, z: 0, yaw: 3 }), 1);
    r.update(view({ x: 10, y: 100, z: 20, yaw: -3 }), 0.5);
    expect(r.heli.position.x).toBeCloseTo(5);
    expect(r.heli.position.z).toBeCloseTo(10);
    // 3 -> -3 rad is 0.28 rad the short way round (through pi), half-way is just past pi.
    const turned = Math.abs(THREE.MathUtils.euclideanModulo(r.heli.rotation.y + Math.PI, 2 * Math.PI) - Math.PI);
    expect(turned).toBeGreaterThan(Math.PI - 0.2);
    r.update(view({ x: 10, y: 100, z: 20, yaw: -3 }), 0); // same view again: no new step
    expect(r.heli.position.x).toBeCloseTo(0);
    r.update(view({ x: 10, y: 100, z: 20, yaw: -3 }), 1);
    expect(r.heli.position.x).toBeCloseTo(10);
  });

  it('does not interpolate from a stale position after the unit went away', () => {
    const r = new AirRenderer(new THREE.Scene());
    r.update(view({ x: 0 }), 1);
    r.update(null, 1);
    r.update(view({ x: 500 }), 0);
    expect(r.heli.position.x).toBe(500);
  });

  it('tolerates a non-finite alpha', () => {
    const r = new AirRenderer(new THREE.Scene());
    r.update(view({ x: 3 }), Number.NaN);
    expect(r.heli.position.x).toBe(3);
  });

  it('disposes: removes the group and frees geometries and materials', () => {
    const scene = new THREE.Scene();
    const r = new AirRenderer(scene);
    const disposed: string[] = [];
    r.body.geometry.addEventListener('dispose', () => disposed.push('body geometry'));
    r.rotor.geometry.addEventListener('dispose', () => disposed.push('rotor geometry'));
    (r.body.material as THREE.Material).addEventListener('dispose', () => disposed.push('body material'));
    (r.rotor.material as THREE.Material).addEventListener('dispose', () => disposed.push('rotor material'));
    r.dispose();
    expect(scene.children).not.toContain(r.group);
    expect(disposed.sort()).toEqual(['body geometry', 'body material', 'rotor geometry', 'rotor material']);
  });
});
