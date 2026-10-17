import { describe, expect, it } from 'vitest';
import type { ActionId } from '../../src/input/actions';
import type { InputManager } from '../../src/input/input';
import { createPoliceInput, readPoliceInput } from '../../src/police/controls';

function fakeInput(pressed: ActionId[], down: ActionId[]): InputManager {
  return {
    wasPressed: (a: ActionId) => pressed.includes(a),
    isDown: (a: ActionId) => down.includes(a),
  } as unknown as InputManager;
}

describe('readPoliceInput', () => {
  it('reads toggles on the press edge only', () => {
    const out = createPoliceInput();
    const held: ActionId[] = ['vehicle.siren', 'vehicle.sirenTone', 'vehicle.lights', 'vehicle.lightPattern', 'vehicle.spotlight', 'vehicle.equipment'];
    readPoliceInput(fakeInput([], held), out);
    expect(out).toEqual(createPoliceInput());
    expect(readPoliceInput(fakeInput(held, held), out)).toEqual({
      ...createPoliceInput(),
      toggleSiren: true,
      cycleTone: true,
      toggleLights: true,
      cyclePattern: true,
      toggleSpot: true,
      equipmentPanel: true,
    });
  });

  it('reads horn, manual and spot aim as holds, into the same object', () => {
    const out = createPoliceInput();
    const holds: ActionId[] = ['vehicle.horn', 'vehicle.manual', 'vehicle.spotAim'];
    expect(readPoliceInput(fakeInput(holds, []), out)).toEqual(createPoliceInput());
    const same = readPoliceInput(fakeInput([], holds), out);
    expect(same).toBe(out);
    expect(out).toEqual({ ...createPoliceInput(), horn: true, manual: true, spotAim: true });
    readPoliceInput(fakeInput([], []), out);
    expect(out).toEqual(createPoliceInput());
  });
});
