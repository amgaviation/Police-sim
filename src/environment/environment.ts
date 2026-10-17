import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { createRng } from '../core/rng';
import type { EnvHourEvent, EnvWeatherEvent } from './events';
import { SKY_CONFIG, createSkySample, nightFactorAt, sampleSky, sunDirection, type SkySample } from './sky';
import { SECONDS_PER_DAY, TIME_CONFIG, createGameTime, gameSecondsAt, gameTimeAt, type GameTime } from './time';
import {
  WEATHER_CONFIG,
  WeatherTimeline,
  createWeatherState,
  isWeatherKind,
  overrideWeather,
  type WeatherKind,
  type WeatherState,
} from './weather';

export interface LightingState {
  /** Unit direction towards the sun (the moon is the opposite direction). */
  sunDirX: number;
  sunDirY: number;
  sunDirZ: number;
  /** Keyframed intensities, dimmed by cloud cover. */
  sunIntensity: number;
  moonIntensity: number;
  /** 0 day .. 1 night, smooth across the horizon. */
  nightFactor: number;
  streetlightsOn: boolean;
  /** Auto headlights: low sun, heavy precipitation or thick fog. */
  headlightsOn: boolean;
}

export interface EnvironmentSave {
  /** Game seconds added by `setTimeOfDay` (never negative). */
  timeOffset: number;
  override: { kind: WeatherKind; intensity: number } | null;
}

export function isEnvironmentSave(value: unknown): value is EnvironmentSave {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof EnvironmentSave, unknown>>;
  if (typeof v.timeOffset !== 'number' || !Number.isFinite(v.timeOffset) || v.timeOffset < 0) return false;
  if (v.override === null) return true;
  if (typeof v.override !== 'object' || v.override === undefined) return false;
  const o = v.override as { kind?: unknown; intensity?: unknown };
  return (
    isWeatherKind(o.kind) &&
    typeof o.intensity === 'number' &&
    Number.isFinite(o.intensity) &&
    o.intensity >= 0 &&
    o.intensity <= 1
  );
}

/**
 * Deterministic game time, weather and lighting. `update(simTime)` runs once per fixed
 * step (O(1), allocation-free) and refreshes `time`, `weather`, `lighting` and `sky` in
 * place; it emits `env:hour` when the whole game hour changes and `env:weather` when
 * the weather segment changes or the override is set or cleared.
 */
export class Environment {
  private readonly bus: EventBus<EventMap> | undefined;
  private readonly timeline: WeatherTimeline;
  private readonly gameTime = createGameTime();
  private readonly weatherState = createWeatherState();
  private readonly skySample = createSkySample();
  private readonly lightingState: LightingState = {
    sunDirX: 0,
    sunDirY: 1,
    sunDirZ: 0,
    sunIntensity: 0,
    moonIntensity: 0,
    nightFactor: 0,
    streetlightsOn: false,
    headlightsOn: false,
  };
  private readonly sunDir = { x: 0, y: 1, z: 0 };
  private timeOffset = 0;
  private override: { kind: WeatherKind; intensity: number } | null = null;
  private simTime = 0;
  private hourKey: number;
  private weatherKey: number;
  private weatherDirty = false;

  constructor(seed: number, bus?: EventBus<EventMap>) {
    this.bus = bus;
    this.timeline = new WeatherTimeline(createRng(seed).stream('weather').seed);
    this.compute(0);
    this.hourKey = this.currentHourKey();
    this.weatherKey = this.currentWeatherKey();
  }

  get time(): Readonly<GameTime> {
    return this.gameTime;
  }

  get weather(): Readonly<WeatherState> {
    return this.weatherState;
  }

  get lighting(): Readonly<LightingState> {
    return this.lightingState;
  }

  /** Interpolated, cloud-shaded sky colours and intensities (for the renderer). */
  get sky(): Readonly<SkySample> {
    return this.skySample;
  }

  update(simTime: number): void {
    this.compute(simTime);
    const hourKey = this.currentHourKey();
    if (hourKey !== this.hourKey) {
      this.hourKey = hourKey;
      const t = this.gameTime;
      this.bus?.emit('env:hour', { day: t.day, weekday: t.weekday, hour: Math.floor(t.hour) } satisfies EnvHourEvent);
    }
    const weatherKey = this.currentWeatherKey();
    if (weatherKey !== this.weatherKey || this.weatherDirty) {
      this.weatherKey = weatherKey;
      this.weatherDirty = false;
      const w = this.weatherState;
      this.bus?.emit('env:weather', { kind: w.kind, intensity: w.intensity } satisfies EnvWeatherEvent);
    }
  }

  /** Jumps forward to the next occurrence of `hour` (0..24); time never runs backward. */
  setTimeOfDay(hour: number): void {
    if (!Number.isFinite(hour) || hour < 0 || hour > 24) throw new RangeError(`setTimeOfDay: hour must be in [0, 24], got ${hour}`);
    const now = gameSecondsAt(this.simTime, this.timeOffset, TIME_CONFIG);
    const secondOfDay = ((now % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    const delta = (((hour * 3600 - secondOfDay) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    this.timeOffset += delta;
    this.update(this.simTime);
  }

  /** Replaces the weather timeline with a fixed kind (debug); `null` returns to the timeline. */
  setWeatherOverride(kind: WeatherKind | null, intensity = 1): void {
    if (kind !== null && !isWeatherKind(kind)) throw new RangeError(`setWeatherOverride: unknown weather kind '${String(kind)}'`);
    const i = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1;
    this.override = kind === null ? null : { kind, intensity: i };
    this.weatherDirty = true;
    this.update(this.simTime);
  }

  serialize(): EnvironmentSave {
    return { timeOffset: this.timeOffset, override: this.override ? { ...this.override } : null };
  }

  /** Adopts a saved state; events for the new state fire on the next `update`. */
  restore(save: EnvironmentSave): void {
    if (!isEnvironmentSave(save)) throw new TypeError('Environment.restore: invalid EnvironmentSave');
    this.timeOffset = save.timeOffset;
    this.override = save.override ? { kind: save.override.kind, intensity: save.override.intensity } : null;
    this.weatherDirty = true;
    this.compute(this.simTime);
  }

  private currentHourKey(): number {
    return Math.floor(this.gameTime.totalSeconds / 3600);
  }

  private currentWeatherKey(): number {
    return this.override ? -1 : this.timeline.segmentAt(this.gameTime.totalSeconds).index;
  }

  private compute(simTime: number): void {
    this.simTime = simTime;
    const t = gameTimeAt(simTime, this.timeOffset, this.gameTime, TIME_CONFIG);
    const w = this.weatherState;
    if (this.override) overrideWeather(WEATHER_CONFIG, this.override.kind, this.override.intensity, w);
    else this.timeline.sample(t.totalSeconds, w);

    const sky = SKY_CONFIG;
    const elevation = sunDirection(sky, t.hour, this.sunDir);
    sampleSky(sky, t.hour, w.cloudCover, this.skySample);
    const night = nightFactorAt(sky, elevation);
    // Shimmer needs sun on the ground.
    w.heatHaze *= 1 - night;

    const l = this.lightingState;
    l.sunDirX = this.sunDir.x;
    l.sunDirY = this.sunDir.y;
    l.sunDirZ = this.sunDir.z;
    l.sunIntensity = this.skySample.sunIntensity;
    l.moonIntensity = this.skySample.moonIntensity;
    l.nightFactor = night;
    l.streetlightsOn = elevation < sky.streetlightsBelowDeg;
    l.headlightsOn =
      elevation < sky.headlights.belowDeg ||
      w.precipitation > sky.headlights.precipAbove ||
      w.fogDensity > sky.headlights.fogAbove;
  }
}
