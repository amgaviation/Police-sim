import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Environment } from '../../src/environment/environment';
import { EnvironmentRenderer } from '../../src/environment/render/environmentRenderer';
import { createSplashes } from '../../src/environment/render/precipitation';
import { VFX_DATA } from '../../src/render/vfx/data';
import { tapeOffset, tapePhase, tapeWind } from '../../src/render/vfx/math';
import { createPropSource, PROP } from '../../src/render/people/pose';
import { PropRenderer } from '../../src/render/people/propRenderer';
import { generateCity } from '../../src/world/generate';
import { CityMaterials } from '../../src/world/render/cityMaterials';
import { ChunkStreamer } from '../../src/world/render/chunkStreamer';
import { fakeChunkWorker, flush } from '../cityrender/fakeWorker';

const wet = VFX_DATA.wet;

describe('CityMaterials.setWetness', () => {
  it('starts dry with the data roughness', () => {
    const m = new CityMaterials();
    expect(m.ground.roughness).toBe(wet.dryRoughness);
    expect(m.markings.roughness).toBe(0.8);
    expect(m.ground.color.getHex()).toBe(0xffffff);
    m.dispose();
  });

  it('lerps ground and marking roughness and darkens the ground', () => {
    const m = new CityMaterials();
    m.setWetness(1, 0);
    expect(m.ground.roughness).toBeCloseTo(wet.wetRoughness, 9);
    expect(m.markings.roughness).toBeCloseTo(wet.markingsWetRoughness, 9);
    expect(m.ground.color.r).toBeCloseTo(1 - wet.darken, 6);
    expect(m.ground.color.g).toBeCloseTo(1 - wet.darken, 6);
    expect(m.ground.color.b).toBeCloseTo(1 - wet.darken, 6);
    m.setWetness(0.5, 0);
    expect(m.ground.roughness).toBeCloseTo((wet.dryRoughness + wet.wetRoughness) / 2, 9);
    expect(m.markings.roughness).toBeCloseTo((0.8 + wet.markingsWetRoughness) / 2, 9);
    expect(m.ground.color.r).toBeCloseTo(1 - wet.darken * 0.5, 6);
    m.setWetness(0, 0);
    expect(m.ground.roughness).toBe(wet.dryRoughness);
    expect(m.markings.roughness).toBe(0.8);
    expect(m.ground.color.r).toBe(1);
    m.dispose();
  });

  it('snow cover dries the road again', () => {
    const m = new CityMaterials();
    m.setWetness(1, 1);
    expect(m.ground.roughness).toBe(wet.dryRoughness);
    m.setWetness(1, 0.5);
    expect(m.ground.roughness).toBeCloseTo((wet.dryRoughness + wet.wetRoughness) / 2, 9);
    m.dispose();
  });

  it('writes only when the effective wetness moved by more than 0.01', () => {
    const m = new CityMaterials();
    m.setWetness(0.5, 0);
    const rough = m.ground.roughness;
    m.setWetness(0.505, 0);
    m.setWetness(0.495, 0);
    expect(m.ground.roughness).toBe(rough);
    m.setWetness(0.52, 0);
    expect(m.ground.roughness).not.toBe(rough);
    // A tiny residual from dry is ignored, but reaching exactly dry or wet always lands.
    const d = new CityMaterials();
    d.setWetness(0.004, 0);
    expect(d.ground.roughness).toBe(wet.dryRoughness);
    d.setWetness(0.999, 0);
    d.setWetness(1, 0);
    expect(d.ground.roughness).toBeCloseTo(wet.wetRoughness, 9);
    d.setWetness(0.006, 0);
    d.setWetness(0, 0);
    expect(d.ground.roughness).toBe(wet.dryRoughness);
    m.dispose();
    d.dispose();
  });
});

describe('ChunkStreamer.setWetness', () => {
  it('forwards to the shared ground and marking materials of loaded chunks', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, generateCity(12345), { worker: fake.client });
    streamer.update(100, -400, 320);
    fake.answer();
    await flush();
    streamer.update(100, -400, 320);
    const ground: THREE.MeshStandardMaterial[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh && (o.material as THREE.Material).name === 'city.ground') ground.push(o.material as THREE.MeshStandardMaterial);
    });
    expect(ground.length).toBeGreaterThan(0);
    streamer.setWetness(1, 0);
    expect(ground[0]?.roughness).toBeCloseTo(wet.wetRoughness, 9);
    streamer.setWetness(1, 1);
    expect(ground[0]?.roughness).toBe(wet.dryRoughness);
    streamer.dispose();
  });
});

function envSetup(): { scene: THREE.Scene; env: Environment; camera: THREE.PerspectiveCamera; er: EnvironmentRenderer } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 800);
  camera.position.set(5, 2, 5);
  camera.updateMatrixWorld(true);
  const env = new Environment(1);
  const er = new EnvironmentRenderer(scene, null, { shadows: 'off' });
  return { scene, env, camera, er };
}
const step = (t: ReturnType<typeof envSetup>): void => t.er.update(t.env, t.camera, { x: 0, y: 0, z: 0 }, 1 / 60);

describe('rain splashes', () => {
  it('createSplashes builds a ground point cloud with a zero draw range', () => {
    const s = createSplashes();
    const pos = s.points.geometry.getAttribute('position');
    expect(pos.count).toBe(VFX_DATA.splashes.count);
    expect(s.count).toBe(VFX_DATA.splashes.count);
    expect(s.points.geometry.drawRange.count).toBe(0);
    expect(s.points.visible).toBe(false);
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeCloseTo(0.02, 6);
      expect(pos.getX(i)).toBeGreaterThanOrEqual(0);
      expect(pos.getX(i)).toBeLessThan(VFX_DATA.splashes.radiusM * 2);
    }
    const again = createSplashes();
    expect(Array.from(again.points.geometry.getAttribute('aRand').array)).toEqual(
      Array.from(s.points.geometry.getAttribute('aRand').array),
    );
  });

  it('is not in the scene while it stays dry and follows the rain amount', () => {
    const t = envSetup();
    t.env.setWeatherOverride('clear');
    step(t);
    expect(t.scene.getObjectByName('splashes')).toBeUndefined();
    t.env.setWeatherOverride('rain', 0.5);
    step(t);
    const splashes = t.scene.getObjectByName('splashes') as THREE.Points;
    expect(splashes).toBeTruthy();
    expect(splashes.visible).toBe(true);
    const w = t.env.weather;
    expect(splashes.geometry.drawRange.count).toBe(Math.round(VFX_DATA.splashes.count * Math.min(1, w.precipitation) * (1 - w.precipSnow)));
    const half = splashes.geometry.drawRange.count;
    t.env.setWeatherOverride('rain', 1);
    step(t);
    expect(splashes.geometry.drawRange.count).toBeGreaterThan(half);
    t.env.setWeatherOverride('clear');
    step(t);
    expect(splashes.visible).toBe(false);
  });

  it('draws none in snow', () => {
    const t = envSetup();
    t.env.setWeatherOverride('rain', 1);
    step(t);
    const splashes = t.scene.getObjectByName('splashes') as THREE.Points;
    expect(splashes.visible).toBe(true);
    t.env.setWeatherOverride('snow', 1);
    step(t);
    expect(t.env.weather.precipSnow).toBeGreaterThan(0.5);
    expect(t.scene.getObjectByName('precipitation')?.visible).toBe(true);
    expect(splashes.visible).toBe(false);
  });

  it('is hidden indoors and with effects off, and halved at low', () => {
    const t = envSetup();
    t.env.setWeatherOverride('rain', 1);
    step(t);
    const splashes = t.scene.getObjectByName('splashes') as THREE.Points;
    const full = splashes.geometry.drawRange.count;
    expect(full).toBeGreaterThan(0);
    t.er.setEffects('low');
    step(t);
    expect(splashes.geometry.drawRange.count).toBe(Math.round(full / 2));
    t.er.setEffects('off');
    step(t);
    expect(splashes.visible).toBe(false);
    t.er.setEffects('high');
    step(t);
    expect(splashes.visible).toBe(true);
    t.er.setIndoor(true);
    step(t);
    expect(splashes.visible).toBe(false);
    t.er.setIndoor(false);
    step(t);
    expect(splashes.visible).toBe(true);
  });

  it('advances a wrapped ring phase and follows the camera', () => {
    const t = envSetup();
    t.env.setWeatherOverride('rain', 1);
    step(t);
    const splashes = t.scene.getObjectByName('splashes') as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
    const u = (splashes.material.uniforms['uPhase'] as THREE.IUniform<number>);
    const a = u.value;
    for (let i = 0; i < 10; i++) step(t);
    expect(u.value).not.toBe(a);
    for (let i = 0; i < 2000; i++) {
      step(t);
      expect(u.value).toBeGreaterThanOrEqual(0);
      expect(u.value).toBeLessThan(1);
    }
    expect((splashes.material.uniforms['uCamera'] as THREE.IUniform<THREE.Vector3>).value.x).toBeCloseTo(5, 6);
  });

  it('exposes the points for tests and disposes them', () => {
    const t = envSetup();
    expect(t.er.splashPoints.name).toBe('splashes');
    t.er.dispose();
  });
});

describe('tape flutter', () => {
  function tapeMesh(scene: THREE.Scene): THREE.InstancedMesh {
    return scene.getObjectByName('prop-tape') as THREE.InstancedMesh;
  }

  it('builds the ribbon from 12 segments along -Z and keeps the post', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const geo = tapeMesh(scene).geometry;
    const pos = geo.getAttribute('position');
    const zs = new Set<number>();
    let ribbonVertices = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0.85 && pos.getZ(i) < -0.03) {
        zs.add(Math.round(pos.getZ(i) * 1000) / 1000);
        ribbonVertices++;
      }
    }
    expect(ribbonVertices).toBeGreaterThan(0);
    // 13 rows of vertices from z = 0 to -3 (every 0.25 m).
    expect(zs.size).toBeGreaterThanOrEqual(12);
    expect(Math.min(...zs)).toBeCloseTo(-3, 6);
    geo.computeBoundingBox();
    expect(geo.boundingBox?.min.z).toBeCloseTo(-3, 6);
    expect(geo.boundingBox?.max.y).toBeCloseTo(1, 6);
    props.dispose();
  });

  it('injects the wave into the vertex shader with the data constants', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const material = tapeMesh(scene).material as THREE.MeshLambertMaterial;
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
    };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
    expect(shader.uniforms['uTime']).toBeDefined();
    expect(shader.uniforms['uWind']).toBeDefined();
    const vs = shader.vertexShader;
    expect(vs).toContain('uniform float uTime;');
    expect(vs).toContain('instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61');
    expect(vs).toContain(`${VFX_DATA.tape.amplitudeM.toFixed(6)} * uWind`);
    expect(vs).toContain(VFX_DATA.tape.freqHz.toFixed(6));
    expect(vs).toContain('sin(PI * (-position.z / 3.000000))');
    // Other kinds keep a plain material.
    const plain = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <begin_vertex>' };
    ((scene.getObjectByName('prop-cone') as THREE.InstancedMesh).material as THREE.Material).onBeforeCompile(
      plain as unknown as THREE.WebGLProgramParametersWithUniforms,
      null as never,
    );
    expect(plain.uniforms).toEqual({});
    expect(plain.vertexShader).toBe('#include <begin_vertex>');
    props.dispose();
  });

  it('setWind writes the wrapped clock and the clamped wind factor', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const material = tapeMesh(scene).material as THREE.MeshLambertMaterial;
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <common>\n#include <begin_vertex>' };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as never);
    const time = shader.uniforms['uTime'] as THREE.IUniform<number>;
    const wind = shader.uniforms['uWind'] as THREE.IUniform<number>;
    expect(wind.value).toBe(0.15);
    props.setWind(12.5, VFX_DATA.tape.windFull / 2);
    expect(time.value).toBe(12.5);
    expect(wind.value).toBeCloseTo(0.5, 12);
    props.setWind(601.5, 0);
    expect(time.value).toBeCloseTo(1.5, 9);
    expect(wind.value).toBe(0.15);
    props.setWind(5, 99);
    expect(wind.value).toBe(1);
    props.setWind(-1, 5);
    expect(time.value).toBeCloseTo(599, 9);
    expect(wind.value).toBe(tapeWind(5));
    props.dispose();
  });

  it('keeps update() drawing instances as before', () => {
    const scene = new THREE.Scene();
    const props = new PropRenderer(scene);
    const s = createPropSource(4);
    s.kind[0] = PROP.tape;
    s.x[0] = 3;
    s.y[0] = 0;
    s.z[0] = 4;
    s.yaw[0] = 0.5;
    s.count = 1;
    props.update(s, 0);
    const mesh = tapeMesh(scene);
    expect(mesh.count).toBe(1);
    expect(props.stats.drawCalls).toBe(1);
    // The phase the shader derives from the instance matrix equals the pure helper's input.
    const m = mesh.getMatrixAt(0, new THREE.Matrix4());
    const phase = (m.elements[12] ?? 0) * 0.37 + (m.elements[14] ?? 0) * 0.61;
    expect(phase).toBeCloseTo(tapePhase(3, 4), 6);
    expect(Math.abs(tapeOffset(-1.5, 2, 1, phase))).toBeLessThanOrEqual(VFX_DATA.tape.amplitudeM);
    props.dispose();
  });
});
