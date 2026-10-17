import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/environment/environment';
import { EnvironmentRenderer } from '../../src/environment/render/environmentRenderer';
import {
  PRECIP_BOX,
  PRECIP_FALL_WRAP,
  PRECIP_MAX_POINT_PX,
  PRECIP_NEAR_FADE,
  PRECIP_SWAY_WRAP,
  PRECIP_WIND_DRIFT,
} from '../../src/environment/render/precipitation';
import type { Renderer } from '../../src/render/renderer';

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

  it('keeps the heat-haze pass across dusk and only uninstalls it while there is no haze', () => {
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
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(1);
    const pass = installed[0];
    expect(pass).not.toBeNull();
    env.setTimeOfDay(23);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    env.setTimeOfDay(13);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toEqual([pass, null, pass]);
    er.dispose();
    expect(installed).toEqual([pass, null, pass, null]);
  });

  it('prewarms the heat-haze and precipitation programs and reuses that pass when heat arrives', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const calls: string[] = [];
    const installed: unknown[] = [];
    let target: unknown = null;
    const renderer = {
      drawDistance: 800,
      shadows: 'off',
      gl: {
        getDrawingBufferSize: (v: THREE.Vector2) => v.set(1920, 1080),
        getRenderTarget: () => target,
        setRenderTarget: (t: unknown) => {
          target = t;
          calls.push(t ? 'target' : 'screen');
        },
        compile: (s: THREE.Object3D) => {
          // Hidden objects are skipped by three's compile: precipitation must be visible for it.
          const rain = scene.getObjectByName('precipitation')?.visible ? '+precip' : '';
          calls.push(s === scene ? `scene@${target ? 'target' : 'screen'}${rain}` : 'quad');
        },
      },
      setPostProcess: (pass: unknown) => installed.push(pass),
    } as unknown as Renderer;
    const env = new Environment(1);
    const er = new EnvironmentRenderer(scene, renderer);
    er.prewarmHaze(camera);
    expect(calls).toEqual(['scene@screen+precip', 'target', 'scene@target+precip', 'screen', 'quad']);
    expect(scene.getObjectByName('precipitation')?.visible).toBe(false);
    expect(installed).toHaveLength(0);
    env.setWeatherOverride('heat', 1);
    env.setTimeOfDay(13);
    er.update(env, camera, { x: 0, y: 0, z: 0 }, 1 / 60);
    expect(installed).toHaveLength(1);
    // No second compile: the pass built by the prewarm is the one installed.
    expect(calls).toHaveLength(5);
    er.dispose();
  });

  it('fades precipitation next to the eye and caps the sprite size', () => {
    const { scene, er } = setup();
    const points = scene.getObjectByName('precipitation') as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const vs = points.material.vertexShader;
    expect(PRECIP_NEAR_FADE[0]).toBeGreaterThan(0.5);
    expect(PRECIP_MAX_POINT_PX).toBeLessThanOrEqual(64);
    expect(vs).toContain('gl_PointSize = min(');
    expect(vs).toContain('smoothstep(NEAR_FADE.x, NEAR_FADE.y, d)');
    expect(vs).toContain(`#define MAX_POINT_PX ${PRECIP_MAX_POINT_PX.toFixed(1)}`);
    er.dispose();
  });

  it('integrates precipitation drift from the current wind, so a changing wind never slides particles', () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
    const env = new Environment(12345);
    const er = new EnvironmentRenderer(scene, null);
    const points = scene.getObjectByName('precipitation') as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const u = points.material.uniforms as Record<string, THREE.IUniform>;
    expect(points.material.vertexShader).toContain('p.xz += uDrift;');
    const dt = 1 / 60;
    let worst = 0;
    let frames = 0;
    let prevX = 0, prevZ = 0;
    // Three game days at 30 game s per frame, through weather blends: each frame drifts by the current wind only.
    for (let t = 0; t < 3 * 86400; t += 30) {
      env.update(t);
      er.update(env, camera, { x: 0, y: 0, z: 0 }, dt);
      const drift = u.uDrift?.value as THREE.Vector2;
      if (points.visible) {
        const wrap = (d: number): number => d - PRECIP_BOX * Math.round(d / PRECIP_BOX);
        const w = env.weather;
        const k = w.precipSnow > 0.5 ? PRECIP_WIND_DRIFT.snow : PRECIP_WIND_DRIFT.rain;
        const step = Math.hypot(wrap(drift.x - prevX), wrap(drift.y - prevZ));
        if (frames > 0) worst = Math.max(worst, Math.abs(step - Math.hypot(w.windX, w.windZ) * k * dt));
        expect(u.uFall?.value).toBeLessThan(PRECIP_FALL_WRAP);
        frames++;
      }
      prevX = drift.x;
      prevZ = drift.y;
    }
    expect(frames).toBeGreaterThan(100);
    expect(worst).toBeLessThan(1e-4);
    er.dispose();
  });

  it('wraps the fall distance and sway clock after a whole number of boxes and periods for every particle', () => {
    for (let q = 0; q < 10; q++) {
      const boxes = (PRECIP_FALL_WRAP * (0.8 + 0.04 * q)) / PRECIP_BOX;
      expect(Math.abs(boxes - Math.round(boxes))).toBeLessThan(1e-9);
      for (const f of [0.8 + 0.1 * q, 0.7 + 0.1 * q]) {
        const periods = (PRECIP_SWAY_WRAP * f) / (2 * Math.PI);
        expect(Math.abs(periods - Math.round(periods))).toBeLessThan(1e-9);
      }
    }
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
