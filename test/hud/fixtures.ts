import { createGameTime } from '../../src/environment/time';
import { createWeatherState } from '../../src/environment/weather';
import type { HudSnapshot } from '../../src/ui/hud/hud';
import type { VehicleTelemetry } from '../../src/vehicles/drivableVehicle';

export function telemetry(overrides: Partial<VehicleTelemetry> = {}): VehicleTelemetry {
  return {
    speed: 20,
    speedKmh: 72,
    speedMph: 44.7,
    groundSpeed: 20,
    rpm: 2500,
    gear: 3,
    throttle: 0.4,
    brake: 0,
    steer: 0,
    absActive: false,
    handbrake: false,
    fuelL: 35,
    fuelFraction: 0.5,
    engineRunning: true,
    engineHealth: 1,
    brakeTempC: 40,
    brakeEfficiency: 1,
    tireFlat: [false, false, false, false],
    damage: [0, 0, 0, 0],
    wheelSurface: [0, 0, 0, 0],
    airborne: false,
    ...overrides,
  };
}

export function snapshot(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  const time = createGameTime();
  time.hour = 7.7;
  time.minute = 42;
  const weather = createWeatherState();
  weather.kind = 'rain';
  weather.temperatureC = 11.6;
  return {
    mode: 'driving',
    telemetry: telemetry(),
    time,
    weather,
    roadName: 'Maple Avenue',
    speedLimitMph: 35,
    schoolZoneActive: false,
    construction: false,
    prompt: null,
    cameraMode: 'chase',
    headlights: false,
    ...overrides,
  };
}
