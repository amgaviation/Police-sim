import { describe, expect, it } from 'vitest';
import { SURFACE_NAMES } from '../../src/world/ids';
import vehicleAudioJson from '../../src/data/audio/vehicleAudio.json';
import { ENGINE_PROFILES, VEHICLE_AUDIO, parseVehicleAudio } from '../../src/audio/vehicleData';

type Json = Record<string, unknown>;

function clone(): Json {
  return JSON.parse(JSON.stringify(vehicleAudioJson)) as Json;
}

/** The nested object at a dotted path of `j`. */
function sub(j: Json, path: string): Json {
  let cur: Json = j;
  for (const key of path.split('.')) cur = cur[key] as Json;
  return cur;
}

describe('vehicleAudio.json', () => {
  it('validates and matches the design table', () => {
    expect(VEHICLE_AUDIO.speedOfSound).toBe(343);
    expect(VEHICLE_AUDIO.dopplerClamp).toEqual([0.5, 2]);
    expect(VEHICLE_AUDIO.dopplerTau).toBe(0.06);
    expect(Object.keys(VEHICLE_AUDIO.engine.profiles).sort()).toEqual([...ENGINE_PROFILES].sort());
    expect(VEHICLE_AUDIO.engine.profiles.rotor.am).toBe(0.85);
    expect(VEHICLE_AUDIO.engine.profiles.v8.cylinders).toBe(8);
    expect(VEHICLE_AUDIO.engine.traffic.voices).toBe(3);
    expect(VEHICLE_AUDIO.engine.traffic.maxDistanceM).toBe(60);
    expect(VEHICLE_AUDIO.engine.cabin).toEqual({ gain: 0.65, lowpassHz: 1600 });
    expect(VEHICLE_AUDIO.tires.surfaceSqueal).toHaveLength(SURFACE_NAMES.length);
    expect(VEHICLE_AUDIO.tires.surfaceCrunch).toHaveLength(SURFACE_NAMES.length);
    // squeal on pavement only, crunch off it
    expect(VEHICLE_AUDIO.tires.surfaceSqueal.slice(0, 2)).toEqual([1, 1]);
    expect(VEHICLE_AUDIO.tires.surfaceSqueal.slice(2).every((v) => v === 0)).toBe(true);
    expect(VEHICLE_AUDIO.tires.surfaceCrunch.slice(0, 2)).toEqual([0, 0]);
    expect(VEHICLE_AUDIO.tires.surfaceCrunch[SURFACE_NAMES.indexOf('gravel')]).toBe(1);
  });

  it('parses with a custom file name', () => {
    expect(() => parseVehicleAudio(vehicleAudioJson, 'mod.json')).not.toThrow();
    expect(() => parseVehicleAudio({ ...vehicleAudioJson, version: 2 }, 'mod.json')).toThrow(/mod\.json: version/);
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['version', (j) => (j['version'] = 2), /vehicleAudio\.json: version/],
    ['speed of sound', (j) => (j['speedOfSound'] = 5), /vehicleAudio\.json: speedOfSound/],
    ['clamp length', (j) => (j['dopplerClamp'] = [0.5]), /vehicleAudio\.json: dopplerClamp/],
    ['clamp min', (j) => (j['dopplerClamp'] = [2, 3]), /vehicleAudio\.json: dopplerClamp\[0\]/],
    ['clamp max', (j) => (j['dopplerClamp'] = [0.5, 0.9]), /vehicleAudio\.json: dopplerClamp\[1\]/],
    ['tau', (j) => (j['dopplerTau'] = 0), /vehicleAudio\.json: dopplerTau/],
    ['missing profile', (j) => delete sub(j, 'engine.profiles')['twin'], /vehicleAudio\.json: engine\.profiles\.twin/],
    ['profile wave', (j) => (sub(j, 'engine.profiles.v8')['wave'] = 'noise'), /vehicleAudio\.json: engine\.profiles\.v8\.wave/],
    ['profile cylinders', (j) => (sub(j, 'engine.profiles.car')['cylinders'] = 0), /vehicleAudio\.json: engine\.profiles\.car\.cylinders/],
    ['profile am', (j) => (sub(j, 'engine.profiles.rotor')['am'] = 2), /vehicleAudio\.json: engine\.profiles\.rotor\.am/],
    ['profile gain', (j) => (sub(j, 'engine.profiles.drone')['gain'] = 'loud'), /vehicleAudio\.json: engine\.profiles\.drone\.gain/],
    ['idle gain', (j) => (sub(j, 'engine')['idleGain'] = -1), /vehicleAudio\.json: engine\.idleGain/],
    ['cabin', (j) => delete sub(j, 'engine')['cabin'], /vehicleAudio\.json: engine\.cabin/],
    ['cabin lowpass', (j) => (sub(j, 'engine.cabin')['lowpassHz'] = 1), /vehicleAudio\.json: engine\.cabin\.lowpassHz/],
    ['traffic profile', (j) => (sub(j, 'engine.traffic')['profile'] = 'steam'), /vehicleAudio\.json: engine\.traffic\.profile/],
    ['traffic voices', (j) => (sub(j, 'engine.traffic')['voices'] = 0), /vehicleAudio\.json: engine\.traffic\.voices/],
    ['traffic redline', (j) => (sub(j, 'engine.traffic')['redlineRpm'] = 100), /vehicleAudio\.json: engine\.traffic\.redlineRpm/],
    ['traffic gears', (j) => (sub(j, 'engine.traffic')['gearRatios'] = []), /vehicleAudio\.json: engine\.traffic\.gearRatios/],
    ['traffic gear value', (j) => (sub(j, 'engine.traffic')['gearRatios'] = [3, 'x']), /vehicleAudio\.json: engine\.traffic\.gearRatios\[1\]/],
    ['shift rpm', (j) => (sub(j, 'engine.traffic')['shiftRpm'] = 99999), /vehicleAudio\.json: engine\.traffic\.shiftRpm/],
    ['slip full', (j) => (sub(j, 'tires')['slipFullMs'] = 1), /vehicleAudio\.json: tires\.slipFullMs/],
    ['squeal range', (j) => (sub(j, 'tires')['squealHzMax'] = 100), /vehicleAudio\.json: tires\.squealHzMax/],
    ['surface table length', (j) => (sub(j, 'tires')['surfaceSqueal'] = [1, 1]), /vehicleAudio\.json: tires\.surfaceSqueal/],
    ['surface table value', (j) => ((sub(j, 'tires')['surfaceCrunch'] as number[])[2] = 5), /vehicleAudio\.json: tires\.surfaceCrunch\[2\]/],
    ['tires missing', (j) => delete j['tires'], /vehicleAudio\.json: tires/],
  ];
  it.each(bad)('rejects bad %s naming the file and path', (_name, mutate, pattern) => {
    const j = clone();
    mutate(j);
    expect(() => parseVehicleAudio(j)).toThrow(pattern);
  });

  it('rejects a non-object root', () => {
    expect(() => parseVehicleAudio(null)).toThrow(/vehicleAudio\.json/);
    expect(() => parseVehicleAudio([])).toThrow(/vehicleAudio\.json/);
  });
});
