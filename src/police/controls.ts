import type { InputManager } from '../input/input';

/** Patrol-car equipment input for one frame (edges are `wasPressed`, holds are `isDown`). */
export interface PoliceInput {
  toggleSiren: boolean;
  cycleTone: boolean;
  /** Held: air horn. */
  horn: boolean;
  /** Held: manual wind-up. */
  manual: boolean;
  toggleLights: boolean;
  cyclePattern: boolean;
  toggleSpot: boolean;
  /** Held: mouse aims the spotlight (suppresses camera look). */
  spotAim: boolean;
  equipmentPanel: boolean;
}

export function createPoliceInput(): PoliceInput {
  return {
    toggleSiren: false,
    cycleTone: false,
    horn: false,
    manual: false,
    toggleLights: false,
    cyclePattern: false,
    toggleSpot: false,
    spotAim: false,
    equipmentPanel: false,
  };
}

/** Reads the police actions into `out` (no allocation). Accepts an `InputManager` or anything with the same two queries. */
export function readPoliceInput(input: Pick<InputManager, 'wasPressed' | 'isDown'>, out: PoliceInput): PoliceInput {
  out.toggleSiren = input.wasPressed('vehicle.siren');
  out.cycleTone = input.wasPressed('vehicle.sirenTone');
  out.horn = input.isDown('vehicle.horn');
  out.manual = input.isDown('vehicle.manual');
  out.toggleLights = input.wasPressed('vehicle.lights');
  out.cyclePattern = input.wasPressed('vehicle.lightPattern');
  out.toggleSpot = input.wasPressed('vehicle.spotlight');
  out.spotAim = input.isDown('vehicle.spotAim');
  out.equipmentPanel = input.wasPressed('vehicle.equipment');
  return out;
}
