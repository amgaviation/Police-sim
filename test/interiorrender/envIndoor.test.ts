import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/environment/environment';
import { EnvironmentRenderer } from '../../src/environment/render/environmentRenderer';
import type { Renderer } from '../../src/render/renderer';

describe('EnvironmentRenderer.setIndoor', () => {
  it('hides precipitation indoors and shows it again outdoors', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const env = new Environment(1);
    const er = new EnvironmentRenderer(scene, null);
    const precip = scene.getObjectByName('precipitation') as THREE.Points;
    env.setWeatherOverride('rain', 0.8);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(precip.visible).toBe(true);
    er.setIndoor(true);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(precip.visible).toBe(false);
    er.setIndoor(false);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(precip.visible).toBe(true);
    er.dispose();
  });

  it('skips the heat-haze pass indoors and reinstalls it outdoors', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const installed: unknown[] = [];
    const renderer = {
      drawDistance: 800,
      shadows: 'off',
      gl: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1920, 1080) },
      setPostProcess: (pass: unknown) => installed.push(pass),
    } as unknown as Renderer;
    const env = new Environment(1);
    const er = new EnvironmentRenderer(scene, renderer);
    env.setWeatherOverride('heat', 1);
    env.setTimeOfDay(13);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(1);
    expect(installed[0]).not.toBeNull();
    er.setIndoor(true);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(2);
    expect(installed[1]).toBeNull();
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(2);
    er.setIndoor(false);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(3);
    expect(installed[2]).toBe(installed[0]);
    er.dispose();
  });

  it('is off by default', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const env = new Environment(1);
    const er = new EnvironmentRenderer(scene, null);
    env.setWeatherOverride('snow', 1);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect((scene.getObjectByName('precipitation') as THREE.Points).visible).toBe(true);
    er.dispose();
  });

  it('turns the sun and the sky ambient off indoors so the interior lights decide the brightness', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const env = new Environment(1);
    env.setTimeOfDay(12);
    const er = new EnvironmentRenderer(scene, null);
    const lights: THREE.Light[] = [];
    scene.traverse((o) => { if ((o as THREE.Light).isLight === true) lights.push(o as THREE.Light); });
    const sun = lights.find((l) => (l as THREE.DirectionalLight).isDirectionalLight === true) as THREE.DirectionalLight;
    const sky = lights.find((l) => (l as THREE.HemisphereLight).isHemisphereLight === true) as THREE.HemisphereLight;
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    const sunOut = sun.intensity, skyOut = sky.intensity;
    expect(sunOut).toBeGreaterThan(1);
    er.setIndoor(true);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(sun.intensity).toBe(0);
    expect(sky.intensity).toBeGreaterThan(0);
    expect(sky.intensity).toBeLessThan(skyOut / 4);
    er.setIndoor(false);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(sun.intensity).toBe(sunOut);
    expect(sky.intensity).toBe(skyOut);
    er.dispose();
  });
});
