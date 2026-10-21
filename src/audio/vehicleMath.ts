import type { EngineProfile, EngineProfileId, TireAudioData, TrafficEngineData } from './vehicleData';

/** Pure engine / tire audio maths (phase 9 design §5.4); no Web Audio, no allocation. */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

const CONTROL_PROFILE: Readonly<Record<string, EngineProfileId>> = {
  boat: 'outboard',
  helicopter: 'rotor',
  drone: 'drone',
};

const STYLE_PROFILE: Readonly<Record<string, EngineProfileId | null>> = {
  sedan: 'car',
  hatchback: 'car',
  suv: 'v8',
  pickup: 'v8',
  van: 'v8',
  truck: 'diesel',
  bus: 'diesel',
  motorcycle: 'twin',
  atv: 'single',
  boat: 'outboard',
  helicopter: 'rotor',
  drone: 'drone',
  bicycle: null,
};

/**
 * Engine profile for a vehicle model's control kind and body style; null = silent (bicycle).
 * boat / helicopter / drone controls win; otherwise the style: sedan|hatchback -> car; suv|pickup|van -> v8;
 * truck|bus -> diesel; motorcycle -> twin; atv -> single; bicycle -> null; anything else -> car.
 */
export function engineProfileFor(control: string, style: string): EngineProfileId | null {
  const byControl = Object.hasOwn(CONTROL_PROFILE, control) ? CONTROL_PROFILE[control] : undefined;
  if (byControl !== undefined) return byControl;
  if (Object.hasOwn(STYLE_PROFILE, style)) return STYLE_PROFILE[style] ?? null;
  return 'car';
}

/** Four-stroke firing frequency: rpm / 60 * cylinders / 2 (Hz). */
export function firingHz(rpm: number, cylinders: number): number {
  return ((rpm / 60) * cylinders) / 2;
}

/** Low-pass cutoff: lowpassBaseHz + lowpassPerRpm * rpm * (0.3 + 0.7 * throttle), clamped to [80, 12000]. */
export function engineCutoffHz(profile: EngineProfile, rpm: number, throttle: number): number {
  return clamp(profile.lowpassBaseHz + profile.lowpassPerRpm * rpm * (0.3 + 0.7 * throttle), 80, 12000);
}

/** Engine gain: profile.gain * (idleGain + (1 - idleGain) * throttle) when running, else 0. */
export function engineGain(profile: EngineProfile, idleGain: number, throttle: number, running: boolean): number {
  return running ? profile.gain * (idleGain + (1 - idleGain) * throttle) : 0;
}

/**
 * Slip (m/s) of the driven car: lateral = sqrt(max(0, groundSpeed^2 - speed^2)); longitudinal = |speed| when
 * (handbrake || (brake > 0.8 && !absActive)) and |speed| > lockSpeedMs, else 0; returns lateral + longitudinal.
 */
export function tireSlip(speed: number, groundSpeed: number, brake: number, absActive: boolean, handbrake: boolean, lockSpeedMs: number): number {
  const lateral = Math.sqrt(Math.max(0, groundSpeed * groundSpeed - speed * speed));
  const along = Math.abs(speed);
  const locked = (handbrake || (brake > 0.8 && !absActive)) && along > lockSpeedMs;
  return lateral + (locked ? along : 0);
}

/** Squeal level 0..1: smoothstep(slipStartMs, slipFullMs, slip) * surfaceSqueal[surface]; 0 when airborne. */
export function squealLevel(slip: number, surface: number, airborne: boolean, t: TireAudioData): number {
  if (airborne) return 0;
  return smoothstep(t.slipStartMs, t.slipFullMs, slip) * (t.surfaceSqueal[surface] ?? 0);
}

/** Gravel / dirt crunch level: clamp(groundSpeed / 15, 0, 1) * surfaceCrunch[surface] * gravelGain; 0 airborne. */
export function crunchLevel(groundSpeed: number, surface: number, airborne: boolean, t: TireAudioData): number {
  if (airborne) return 0;
  return clamp(groundSpeed / 15, 0, 1) * (t.surfaceCrunch[surface] ?? 0) * t.gravelGain;
}

/** Squeal pitch: lerp(squealHzMin, squealHzMax, clamp(slip / (2 * slipFullMs), 0, 1)). */
export function squealHz(slip: number, t: TireAudioData): number {
  const k = clamp(slip / (2 * t.slipFullMs), 0, 1);
  return t.squealHzMin + (t.squealHzMax - t.squealHzMin) * k;
}

/**
 * RPM of a traffic car from its speed: picks the highest gear whose rpm >= shiftRpm * 0.5 (gear 1 below that),
 * rpm = |speed| / wheelRadius * 60 / (2 pi) * ratio * finalDrive, clamped to [idleRpm, redlineRpm].
 */
export function rpmFromSpeed(speedMs: number, t: TrafficEngineData): number {
  const wheelRpm = ((Math.abs(speedMs) / t.wheelRadiusM) * 60) / (2 * Math.PI);
  const floor = t.shiftRpm * 0.5;
  const gears = t.gearRatios;
  let ratio = gears[0] ?? 1;
  for (let g = gears.length - 1; g > 0; g--) {
    const r = gears[g] ?? 1;
    if (wheelRpm * r * t.finalDrive >= floor) {
      ratio = r;
      break;
    }
  }
  return clamp(wheelRpm * ratio * t.finalDrive, t.idleRpm, t.redlineRpm);
}
