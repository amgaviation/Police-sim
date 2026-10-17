import type { WeatherKind } from './weather';

/** Whole game hour changed. Weekday 0 = Monday. */
export interface EnvHourEvent {
  day: number;
  weekday: number;
  hour: number;
}

/** Weather segment changed, or the debug override was set or cleared. */
export interface EnvWeatherEvent {
  kind: WeatherKind;
  intensity: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'env:hour': EnvHourEvent;
    'env:weather': EnvWeatherEvent;
  }
}
