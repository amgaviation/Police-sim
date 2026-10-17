import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/environment/environment';
import { EnvironmentRenderer } from '../../src/environment/render/environmentRenderer';

function countObjects(scene: THREE.Scene): number {
  let n = 0;
  scene.traverse(() => n++);
  return n - 1;
}

function setup(): { scene: THREE.Scene; env: Environment; camera: THREE.PerspectiveCamera; er: EnvironmentRenderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
  camera.position.set(5, 2, 5);
  const env = new Environment(1);
  const er = new EnvironmentRenderer(scene, null, { shadows: 'low' });
  return { scene, env, camera, er };
}

describe('EnvironmentRenderer (headless)', () => {
  it('updates without throwing and adds a fixed set of objects', () => {
    const { scene, env, camera, er } = setup();
    const added = countObjects(scene);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    env.update(600);
    er.update(env, camera, { x: 10, y: 0, z: -4 }, 1 / 60);
    expect(scene.children).toHaveLength(1);
    expect(countObjects(scene)).toBe(added);
    expect(added).toBe(6); // group, sky dome, light, light target, hemisphere, precipitation
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
    expect(scene.background).toBeInstanceOf(THREE.Color);
    expect(er.viewDistance).toBeGreaterThan(0);
    expect(er.viewDistance).toBeLessThanOrEqual(320);
  });

  it('shortens the view distance in fog and shows precipitation only when it falls', () => {
    const { scene, env, camera, er } = setup();
    const precip = scene.getObjectByName('precipitation') as THREE.Points;
    env.setWeatherOverride('clear');
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(precip.visible).toBe(false);
    expect(er.viewDistance).toBeCloseTo(320, 6);
    env.setWeatherOverride('rain', 0.5);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(precip.visible).toBe(true);
    expect(precip.geometry.drawRange.count).toBeGreaterThan(0);
    env.setWeatherOverride('fog', 1);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(er.viewDistance).toBeLessThan(200);
    expect(precip.visible).toBe(false);
  });

  it('moves the sun with the focus in whole shadow texels', () => {
    const { scene, env, camera, er } = setup();
    env.setWeatherOverride('clear');
    env.update(((12 - 7) * 3600) / 30);
    const light = scene.getObjectByName('sunMoon') as THREE.DirectionalLight;
    er.update(env, camera, { x: 100, y: 0, z: 100 }, 1 / 60);
    const before = light.target.position.clone();
    expect(before.distanceTo(new THREE.Vector3(100, 0, 100))).toBeLessThan(1);
    expect(light.castShadow).toBe(true);
    expect(light.shadow.intensity).toBe(1);
    // A sub-texel move only slides the target along the light axis (no texel change).
    er.update(env, camera, { x: 100.01, y: 0, z: 100 }, 1 / 60);
    const axis = light.position.clone().sub(light.target.position).normalize();
    const delta = light.target.position.clone().sub(before);
    expect(delta.clone().addScaledVector(axis, -delta.dot(axis)).length()).toBeLessThan(1e-6);
    // Night: moonlight without shadow updates.
    env.update(((24 - 7) * 3600) / 30);
    er.update(env, camera, { x: 100, y: 0, z: 100 }, 1 / 60);
    expect(light.shadow.autoUpdate).toBe(false);
    expect(light.shadow.intensity).toBe(0);
    expect(light.position.y).toBeGreaterThan(light.target.position.y);
  });

  it('dispose removes and frees everything it created', () => {
    const { scene, env, camera, er } = setup();
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    const disposed: string[] = [];
    scene.traverse((o) => {
      const d = o as Partial<THREE.Mesh>;
      d.geometry?.addEventListener('dispose', () => disposed.push(o.name));
    });
    er.dispose();
    expect(scene.children).toHaveLength(0);
    expect(scene.fog).toBeNull();
    expect(scene.background).toBeNull();
    expect(disposed.sort()).toEqual(['precipitation', 'skyDome']);
    er.dispose();
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
  });
});
