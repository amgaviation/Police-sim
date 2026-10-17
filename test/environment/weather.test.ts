import { describe, expect, it } from 'vitest';
import weatherJson from '../../src/data/environment/weather.json';
import {
  WEATHER,
  WEATHER_CONFIG,
  WEATHER_KINDS,
  WeatherTimeline,
  createWeatherState,
  overrideWeather,
  validateWeatherConfig,
  type WeatherState,
} from '../../src/environment/weather';

const DAY = 86400;
const STEP = 600; // 10 game minutes

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function samples(seed: number, days: number): WeatherState[] {
  const timeline = new WeatherTimeline(seed);
  const out: WeatherState[] = [];
  for (let t = 0; t < days * DAY; t += STEP) out.push({ ...timeline.sample(t, createWeatherState()) });
  return out;
}

/** Rain then clear, alternating, 3 h segments: deterministic regardless of seed. */
function rainClearConfig(): ReturnType<typeof validateWeatherConfig> {
  const data = clone(weatherJson);
  for (const from of WEATHER_KINDS) {
    for (const to of WEATHER_KINDS) data.transitions[from][to] = 0;
  }
  data.transitions.clear.rain = 1;
  data.transitions.rain.clear = 1;
  data.transitions.cloudy.clear = 1;
  data.transitions.storm.clear = 1;
  data.transitions.fog.clear = 1;
  data.transitions.heat.clear = 1;
  data.transitions.snow.clear = 1;
  data.segmentHours = [3, 3];
  return validateWeatherConfig(data);
}

describe('WeatherTimeline', () => {
  it('is deterministic per seed', () => {
    expect(samples(42, 7)).toEqual(samples(42, 7));
  });

  it('differs across seeds over 7 game days', () => {
    const kinds = (seed: number): string => samples(seed, 7).map((s) => s.kind).join(',');
    expect(kinds(1)).not.toBe(kinds(2));
    expect(kinds(2)).not.toBe(kinds(3));
  });

  it('is a pure function of game time (rewinds when queried earlier)', () => {
    const timeline = new WeatherTimeline(7);
    const late = { ...timeline.sample(5 * DAY + 1234, createWeatherState()) };
    const early = { ...timeline.sample(DAY / 2, createWeatherState()) };
    expect(early).toEqual(new WeatherTimeline(7).sample(DAY / 2, createWeatherState()));
    expect(timeline.sample(5 * DAY + 1234, createWeatherState())).toEqual(late);
  });

  it('only takes allowed transitions and keeps segment lengths in range', () => {
    const [minH, maxH] = WEATHER_CONFIG.segmentHours;
    for (const seed of [1, 2, 3, 99]) {
      const timeline = new WeatherTimeline(seed);
      for (let t = 0, i = 0; t < 30 * DAY; i++) {
        const seg = timeline.segmentAt(t);
        expect(seg.index).toBe(i);
        expect(WEATHER_CONFIG.transitions[seg.prevKind]?.[seg.kind] ?? 0).toBeGreaterThan(0);
        expect(seg.end - seg.start).toBeGreaterThanOrEqual(minH * 3600 - 1e-6);
        expect(seg.end - seg.start).toBeLessThanOrEqual(maxH * 3600 + 1e-6);
        t = seg.end;
      }
    }
  });

  it('blends between kinds over blendMinutes at the segment start', () => {
    const timeline = new WeatherTimeline(1, rainClearConfig());
    const s = createWeatherState();
    // Segment 1 starts at 3 h: rain -> clear.
    expect(timeline.sample(3 * 3600, s).kind).toBe('clear');
    const startPrecip = s.precipitation;
    timeline.sample(3 * 3600 + 10 * 60, s);
    const midPrecip = s.precipitation;
    timeline.sample(3 * 3600 + 20 * 60, s);
    expect(startPrecip).toBeGreaterThan(midPrecip);
    expect(midPrecip).toBeGreaterThan(0);
    expect(s.precipitation).toBe(0);
  });

  it('wets roads during rain and dries them to 0 after dryMinutes', () => {
    const config = rainClearConfig();
    const timeline = new WeatherTimeline(1, config);
    const s = createWeatherState();
    expect(timeline.sample(0, s).kind).toBe('rain');
    expect(s.wetness).toBe(0);
    const w5 = timeline.sample(5 * 60, s).wetness;
    const w10 = timeline.sample(10 * 60, s).wetness;
    expect(w5).toBeGreaterThan(0);
    expect(w10).toBeGreaterThan(w5);
    expect(timeline.sample(config.wetRampMinutes * 60, s).wetness).toBe(1);
    // Clear segment from 3 h: dries linearly.
    expect(timeline.sample(3 * 3600 + (config.dryMinutes / 2) * 60, s).wetness).toBeCloseTo(0.5, 9);
    expect(timeline.sample(3 * 3600 + config.dryMinutes * 60, s).wetness).toBe(0);
    expect(timeline.sample(3 * 3600 + config.dryMinutes * 60 + 1, s).wetness).toBe(0);
    // Wet again in the next rain segment, and never any snow.
    expect(timeline.sample(6 * 3600 + 3600, s).wetness).toBe(1);
    for (let t = 0; t < 2 * DAY; t += STEP) expect(timeline.sample(t, s).snowCover).toBe(0);
  });

  it('has snow cover only during or after snow', () => {
    let sawSnowCover = false;
    for (const seed of [1, 2, 3]) {
      const timeline = new WeatherTimeline(seed);
      const s = createWeatherState();
      let lastSnowEnd = -Infinity;
      for (let t = 0; t < 30 * DAY; t += STEP) {
        const seg = timeline.segmentAt(t);
        if (seg.prevKind === WEATHER.snow) lastSnowEnd = Math.max(lastSnowEnd, seg.start);
        timeline.sample(t, s);
        if (s.snowCover > 0) {
          sawSnowCover = true;
          const snowing = seg.kind === WEATHER.snow;
          expect(snowing || t - lastSnowEnd <= WEATHER_CONFIG.meltMinutes * 60).toBe(true);
        }
        expect(s.snowCover).toBeGreaterThanOrEqual(0);
        expect(s.snowCover).toBeLessThanOrEqual(1);
        expect(s.wetness).toBeGreaterThanOrEqual(0);
        expect(s.wetness).toBeLessThanOrEqual(1);
      }
    }
    expect(sawSnowCover).toBe(true);
  });
});

describe('precipitation type', () => {
  it('keeps snowing (not raining) while a snow segment blends into clear', () => {
    const data = clone(weatherJson);
    for (const from of WEATHER_KINDS) {
      for (const to of WEATHER_KINDS) data.transitions[from][to] = 0;
      data.transitions[from].clear = 1;
    }
    data.transitions.clear = { ...data.transitions.clear, clear: 0, snow: 1 };
    data.segmentHours = [3, 3];
    const timeline = new WeatherTimeline(7, validateWeatherConfig(data));
    const snowing = timeline.sample(3600, createWeatherState());
    expect(snowing.kind).toBe('snow');
    expect(snowing.precipSnow).toBe(1);
    const fading = timeline.sample(3 * 3600 + 300, createWeatherState());
    expect(fading.kind).toBe('clear');
    expect(fading.precipitation).toBeGreaterThan(0.3);
    expect(fading.precipSnow).toBe(1);
    expect(overrideWeather(WEATHER_CONFIG, 'rain', 1, createWeatherState()).precipSnow).toBe(0);
    expect(overrideWeather(WEATHER_CONFIG, 'snow', 0.6, createWeatherState()).precipSnow).toBe(1);
  });
});

describe('visibility', () => {
  // Visibility is 2 / fogDensity (environmentRenderer's VISIBILITY_FACTOR); the default fog far is 320 m.
  const visibility = (kind: 'rain' | 'snow' | 'storm', intensity: number): number =>
    2 / overrideWeather(WEATHER_CONFIG, kind, intensity, createWeatherState()).fogDensity;

  it('rain, snow and storm shorten the view below the default fog far', () => {
    for (const kind of ['rain', 'snow', 'storm'] as const) expect(visibility(kind, 1), kind).toBeLessThan(320);
    expect(visibility('storm', WEATHER_CONFIG.intensity[0])).toBeLessThan(320);
    expect(visibility('storm', 1)).toBeLessThan(visibility('rain', 1));
  });
});

describe('overrideWeather', () => {
  it('applies a fixed kind scaled by intensity', () => {
    const s = overrideWeather(WEATHER_CONFIG, 'fog', 0.5, createWeatherState());
    expect(s.kind).toBe('fog');
    expect(s.intensity).toBe(0.5);
    expect(s.fogDensity).toBeCloseTo(0.006, 9);
    expect(s.precipitation).toBe(0);
    overrideWeather(WEATHER_CONFIG, 'rain', 0.8, s);
    expect(s.precipitation).toBeCloseTo(0.8, 9);
    expect(s.wetness).toBeCloseTo(0.8, 9);
    expect(s.snowCover).toBe(0);
    overrideWeather(WEATHER_CONFIG, 'snow', 1, s);
    expect(s.snowCover).toBe(1);
    expect(s.wetness).toBe(0);
    expect(s.temperatureC).toBeLessThan(0);
  });
});

describe('validateWeatherConfig', () => {
  it('normalizes transition rows', () => {
    for (const row of WEATHER_CONFIG.transitions) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('rejects malformed data with readable errors', () => {
    const missingKind = clone(weatherJson) as { kinds: Partial<typeof weatherJson.kinds> };
    delete missingKind.kinds.heat;
    expect(() => validateWeatherConfig(missingKind)).toThrow(/weather\.json: kinds\.heat must be an object/);
    const unknown = clone(weatherJson) as unknown as { transitions: Record<string, Record<string, number>> };
    unknown.transitions.clear!.hail = 0.1;
    expect(() => validateWeatherConfig(unknown)).toThrow(/transitions\.clear\.hail is not one of/);
    const zeroRow = clone(weatherJson);
    for (const k of WEATHER_KINDS) zeroRow.transitions.fog[k] = 0;
    expect(() => validateWeatherConfig(zeroRow)).toThrow(/transitions\.fog must have at least one positive weight/);
    const badRange = clone(weatherJson);
    badRange.segmentHours = [8, 2];
    expect(() => validateWeatherConfig(badRange)).toThrow(/segmentHours must be \[min, max\]/);
    const badNumber = clone(weatherJson) as unknown as { kinds: { rain: { precip: unknown } } };
    badNumber.kinds.rain.precip = 'lots';
    expect(() => validateWeatherConfig(badNumber)).toThrow(/kinds\.rain\.precip must be a finite number/);
  });
});
