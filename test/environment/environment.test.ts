import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { Environment, isEnvironmentSave } from '../../src/environment/environment';
import { TIME_CONFIG } from '../../src/environment/time';
import { WeatherTimeline } from '../../src/environment/weather';

const RATE = TIME_CONFIG.gameSecondsPerSimSecond;
/** Sim seconds until game hour `hour` of day 0 (start 07:00). */
const simAt = (hour: number): number => ((hour - TIME_CONFIG.startHour) * 3600) / RATE;

function spyBus(): { bus: EventBus<EventMap>; hours: EventMap['env:hour'][]; weather: EventMap['env:weather'][] } {
  const bus = new EventBus<EventMap>();
  const hours: EventMap['env:hour'][] = [];
  const weather: EventMap['env:weather'][] = [];
  bus.on('env:hour', (e) => hours.push(e));
  bus.on('env:weather', (e) => weather.push(e));
  return { bus, hours, weather };
}

describe('Environment time', () => {
  it('starts Monday 07:00 and follows sim time', () => {
    const env = new Environment(1);
    expect(env.time).toMatchObject({ day: 0, weekday: 0, isWeekday: true, hour: 7, minute: 0 });
    env.update(120);
    expect(env.time.hour).toBeCloseTo(8, 9);
  });

  it('setTimeOfDay jumps forward to the next occurrence, never backward', () => {
    const env = new Environment(1);
    env.update(simAt(10));
    const before = env.time.totalSeconds;
    env.setTimeOfDay(14.5);
    expect(env.time.day).toBe(0);
    expect(env.time.hour).toBeCloseTo(14.5, 9);
    expect(env.time.totalSeconds).toBeGreaterThan(before);
    env.setTimeOfDay(6);
    expect(env.time.day).toBe(1);
    expect(env.time.hour).toBeCloseTo(6, 9);
    const at6 = env.time.totalSeconds;
    env.setTimeOfDay(6);
    expect(env.time.totalSeconds).toBe(at6);
    // The offset persists as sim time advances.
    env.update(simAt(10) + 120);
    expect(env.time.hour).toBeCloseTo(7, 9);
    expect(() => env.setTimeOfDay(25)).toThrow(RangeError);
  });
});

describe('Environment lighting', () => {
  it('is day at noon and night at midnight', () => {
    const env = new Environment(3);
    env.setWeatherOverride('clear', 1);
    env.update(simAt(12));
    expect(env.lighting.nightFactor).toBe(0);
    expect(env.lighting.sunDirY).toBeGreaterThan(0.5);
    expect(env.lighting.sunIntensity).toBeGreaterThan(1);
    expect(env.lighting.streetlightsOn).toBe(false);
    expect(env.lighting.headlightsOn).toBe(false);
    env.update(simAt(24));
    expect(env.lighting.nightFactor).toBe(1);
    expect(env.lighting.sunDirY).toBeLessThan(0);
    expect(env.lighting.moonIntensity).toBeGreaterThan(0);
    expect(env.lighting.streetlightsOn).toBe(true);
    expect(env.lighting.headlightsOn).toBe(true);
  });

  it('turns headlights on in thick fog by day and heat haze off at night', () => {
    const env = new Environment(3);
    env.update(simAt(12));
    env.setWeatherOverride('fog', 1);
    expect(env.lighting.headlightsOn).toBe(true);
    env.setWeatherOverride('heat', 1);
    expect(env.weather.heatHaze).toBeGreaterThan(0.9);
    env.update(simAt(24));
    expect(env.weather.heatHaze).toBe(0);
  });
});

describe('Environment weather', () => {
  it('matches the seeded weather timeline', () => {
    const env = new Environment(11);
    const timeline = new WeatherTimeline(createRng(11).stream('weather').seed);
    for (let day = 0; day < 3; day++) {
      env.update(simAt(7 + day * 24 + 5));
      expect(env.weather.kind).toBe(timeline.sample(env.time.totalSeconds, { ...env.weather }).kind);
    }
  });

  it('override replaces the timeline and clearing it restores the timeline', () => {
    const env = new Environment(5);
    const reference = new Environment(5);
    env.update(simAt(15));
    reference.update(simAt(15));
    env.setWeatherOverride('storm', 0.8);
    expect(env.weather.kind).toBe('storm');
    expect(env.weather.intensity).toBe(0.8);
    expect(env.weather.precipitation).toBeCloseTo(0.8, 9);
    env.setWeatherOverride(null);
    expect(env.weather).toEqual(reference.weather);
    expect(() => env.setWeatherOverride('hail' as never)).toThrow(RangeError);
  });
});

describe('Environment save', () => {
  it('round-trips through serialize/restore', () => {
    const a = new Environment(9);
    a.update(simAt(9));
    a.setTimeOfDay(21.25);
    a.setWeatherOverride('snow', 0.6);
    const save = JSON.parse(JSON.stringify(a.serialize())) as unknown;
    expect(isEnvironmentSave(save)).toBe(true);
    const b = new Environment(9);
    b.restore(save as ReturnType<Environment['serialize']>);
    b.update(simAt(9));
    expect(b.time).toEqual(a.time);
    expect(b.weather).toEqual(a.weather);
    expect(b.lighting).toEqual(a.lighting);
    expect(b.serialize()).toEqual(a.serialize());
  });

  it('rejects invalid saves', () => {
    expect(isEnvironmentSave({ timeOffset: -1, override: null })).toBe(false);
    expect(isEnvironmentSave({ timeOffset: 0, override: { kind: 'hail', intensity: 1 } })).toBe(false);
    expect(isEnvironmentSave({ timeOffset: 0, override: { kind: 'rain', intensity: 2 } })).toBe(false);
    expect(isEnvironmentSave({ timeOffset: 0 })).toBe(false);
    expect(isEnvironmentSave({ timeOffset: 10, override: { kind: 'rain', intensity: 0.5 } })).toBe(true);
    expect(() => new Environment(1).restore({ timeOffset: Number.NaN, override: null })).toThrow(TypeError);
  });
});

describe('Environment events', () => {
  it('emits env:hour once per whole game hour change', () => {
    const { bus, hours } = spyBus();
    const env = new Environment(1, bus);
    for (let step = 0; step <= simAt(10) * 60; step++) env.update(step / 60);
    expect(hours.map((e) => e.hour)).toEqual([8, 9, 10]);
    expect(hours[0]).toEqual({ day: 0, weekday: 0, hour: 8 });
  });

  it('emits env:weather on override changes and segment changes only', () => {
    const { bus, weather } = spyBus();
    const env = new Environment(2, bus);
    env.update(0);
    env.setWeatherOverride('fog', 0.7);
    env.update(1);
    env.update(2);
    expect(weather).toEqual([{ kind: 'fog', intensity: 0.7 }]);
    env.setWeatherOverride(null);
    expect(weather).toHaveLength(2);
    expect(weather[1]?.kind).toBe(env.weather.kind);

    // Over two game days, one event per segment boundary crossed.
    const timeline = new WeatherTimeline(createRng(2).stream('weather').seed);
    const firstSegment = timeline.segmentAt(env.time.totalSeconds).index;
    weather.length = 0;
    const end = simAt(7 + 48);
    for (let sim = 2; sim <= end; sim += 1) env.update(sim);
    const lastSegment = timeline.segmentAt(env.time.totalSeconds).index;
    expect(lastSegment).toBeGreaterThan(firstSegment);
    expect(weather).toHaveLength(lastSegment - firstSegment);
  });
});
