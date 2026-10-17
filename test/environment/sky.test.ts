import { describe, expect, it } from 'vitest';
import skyJson from '../../src/data/environment/sky.json';
import {
  SKY_CONFIG,
  createSkySample,
  nightFactorAt,
  sampleSky,
  sunDirection,
  validateSkyConfig,
} from '../../src/environment/sky';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const dir = { x: 0, y: 0, z: 0 };

describe('sunDirection', () => {
  it('is up at noon and down at midnight', () => {
    expect(sunDirection(SKY_CONFIG, 12, dir)).toBeGreaterThan(30);
    expect(dir.y).toBeGreaterThan(0.5);
    expect(sunDirection(SKY_CONFIG, 0, dir)).toBeLessThan(-30);
    expect(dir.y).toBeLessThan(-0.5);
  });

  it('rises in the east, culminates in the south and sets in the west', () => {
    const { sunriseHour, sunsetHour, maxSunElevationDeg } = SKY_CONFIG;
    expect(sunDirection(SKY_CONFIG, sunriseHour, dir)).toBeCloseTo(0, 6);
    expect(dir.x).toBeCloseTo(1, 6);
    expect(sunDirection(SKY_CONFIG, (sunriseHour + sunsetHour) / 2, dir)).toBeCloseTo(maxSunElevationDeg, 6);
    expect(dir.z).toBeGreaterThan(0);
    expect(Math.abs(dir.x)).toBeLessThan(1e-6);
    expect(sunDirection(SKY_CONFIG, sunsetHour, dir)).toBeCloseTo(0, 6);
    expect(dir.x).toBeCloseTo(-1, 6);
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1, 9);
  });
});

describe('nightFactor', () => {
  const at = (hour: number): number => nightFactorAt(SKY_CONFIG, sunDirection(SKY_CONFIG, hour, dir));

  it('is 0 at noon and 1 at midnight', () => {
    expect(at(12)).toBe(0);
    expect(at(0)).toBe(1);
  });

  it('rises monotonically and smoothly through dusk', () => {
    let prev = at(15);
    for (let h = 15.05; h <= 23; h += 0.05) {
      const v = at(h);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v - prev).toBeLessThan(0.15);
      prev = v;
    }
    expect(at(SKY_CONFIG.sunsetHour)).toBeCloseTo(0.5, 6);
  });
});

describe('sampleSky', () => {
  it('returns a keyframe exactly at its hour', () => {
    const s = sampleSky(SKY_CONFIG, 12, 0, createSkySample());
    expect(s.sunIntensity).toBeCloseTo(2.8, 9);
    expect(s.skyTop.r).toBeCloseTo(0x3a / 255, 9);
  });

  it('interpolates with wrap-around through midnight', () => {
    const data = clone(skyJson);
    data.keyframes = [
      { ...data.keyframes[0]!, hour: 6, sunIntensity: 1, skyTop: '#ffffff' },
      { ...data.keyframes[0]!, hour: 18, sunIntensity: 0, skyTop: '#000000' },
    ];
    const config = validateSkyConfig(data);
    const s = createSkySample();
    expect(sampleSky(config, 0, 0, s).sunIntensity).toBeCloseTo(0.5, 9); // halfway 18 -> 6
    expect(sampleSky(config, 23, 0, s).sunIntensity).toBeCloseTo(5 / 12, 9);
    expect(sampleSky(config, 3, 0, s).skyTop.g).toBeCloseTo(0.75, 9);
    expect(sampleSky(config, 12, 0, s).sunIntensity).toBeCloseTo(0.5, 9);
  });

  it('darkens and dims with cloud cover', () => {
    const clear = sampleSky(SKY_CONFIG, 12, 0, createSkySample());
    const overcast = sampleSky(SKY_CONFIG, 12, 1, createSkySample());
    expect(overcast.sunIntensity).toBeLessThan(clear.sunIntensity * 0.5);
    expect(overcast.skyTop.b).toBeLessThan(clear.skyTop.b);
    expect(overcast.ambientIntensity).toBeLessThan(clear.ambientIntensity);
  });
});

describe('validateSkyConfig', () => {
  it('accepts the shipped file with the required keyframe hours', () => {
    const hours = SKY_CONFIG.keyframes.map((k) => k.hour);
    for (const h of [0, 5, 6, 7, 9, 12, 16, 18, 19, 20, 22]) expect(hours).toContain(h);
  });

  it('rejects unsorted keyframes, bad colours and an inverted day', () => {
    const unsorted = clone(skyJson);
    unsorted.keyframes[2]!.hour = 1;
    expect(() => validateSkyConfig(unsorted)).toThrow(/sky\.json: keyframes\[2\]\.hour must be greater/);
    const badColor = clone(skyJson);
    badColor.keyframes[1]!.skyTop = 'blue';
    expect(() => validateSkyConfig(badColor)).toThrow(/keyframes\[1\]\.skyTop must be a "#rrggbb" colour/);
    const inverted = clone(skyJson);
    inverted.sunsetHour = 5;
    expect(() => validateSkyConfig(inverted)).toThrow(/sunsetHour must be after sunriseHour/);
    const missing = clone(skyJson) as Partial<typeof skyJson>;
    delete missing.headlights;
    expect(() => validateSkyConfig(missing)).toThrow(/headlights must be an object/);
  });
});
