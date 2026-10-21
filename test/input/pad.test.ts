/**
 * Gamepad queries for menu navigation (Phase 9, design §7.4: `padButton`, `padPressed`, `padAxis`) and the radio menu cursor
 * actions (design §7.5): while the radio menu is open the D-pad and A belong to the cursor and every other action loses them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { ACTIONS } from '../../src/input/actions';
import { ACTION_SCOPES, DEFAULT_INPUT_CONTEXT, isEligible, isModal, type InputContext } from '../../src/input/context';
import { InputManager, type GamepadLike } from '../../src/input/input';

const button = (value: number): GamepadLike['buttons'][number] => ({ value, pressed: value > 0.5 });
const ctx = (over: Partial<InputContext> = {}): InputContext => ({ ...DEFAULT_INPUT_CONTEXT, ...over });

describe('pad queries', () => {
  let pads: Array<GamepadLike | null>;
  let input: InputManager;

  beforeEach(() => {
    pads = [];
    input = new InputManager({ bus: new EventBus<EventMap>(), getGamepads: () => pads });
  });

  it('read 0 / false without a pad', () => {
    input.update();
    expect(input.padButton(0)).toBe(0);
    expect(input.padPressed(0)).toBe(false);
    expect(input.padAxis(0)).toBe(0);
    expect(input.padButton(99)).toBe(0);
  });

  it('padButton is the raw 0..1 value, padAxis the raw axis (no deadzone), both updated by update()', () => {
    pads = [{ connected: true, buttons: [button(0.25), button(1)], axes: [0.1, -0.8] }];
    expect(input.padButton(1)).toBe(0);
    input.update();
    expect(input.padButton(0)).toBeCloseTo(0.25);
    expect(input.padButton(1)).toBe(1);
    expect(input.padAxis(0)).toBeCloseTo(0.1); // inside the deadzone: still raw
    expect(input.padAxis(1)).toBeCloseTo(-0.8);
    expect(input.padAxis(7)).toBe(0);
  });

  it('padPressed is true only on the frame a button went down', () => {
    pads = [{ connected: true, buttons: [button(0)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(false);
    pads = [{ connected: true, buttons: [button(1)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(true);
    input.update();
    expect(input.padPressed(0)).toBe(false); // held
    pads = [{ connected: true, buttons: [button(0)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(false);
    pads = [{ connected: true, buttons: [button(1)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(true);
  });

  it('padPressed needs the value to cross the 0.5 button threshold', () => {
    pads = [{ connected: true, buttons: [button(0.3)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(false);
    pads = [{ connected: true, buttons: [button(0.6)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(true);
  });

  it('a pad that connects mid-game with a button already down counts as a press once', () => {
    input.update();
    pads = [{ connected: true, buttons: [button(1)], axes: [] }];
    input.update();
    expect(input.padPressed(0)).toBe(true);
    input.update();
    expect(input.padPressed(0)).toBe(false);
  });

  it('reads a disconnected pad as nothing', () => {
    pads = [{ connected: false, buttons: [button(1)], axes: [1] }];
    input.update();
    expect(input.padButton(0)).toBe(0);
    expect(input.padAxis(0)).toBe(0);
  });
});

describe('radio cursor actions', () => {
  it('are button actions with the design labels', () => {
    expect(ACTIONS['radio.cursorPrev']).toEqual({ kind: 'button', label: 'Radio menu: previous' });
    expect(ACTIONS['radio.cursorNext']).toEqual({ kind: 'button', label: 'Radio menu: next' });
    expect(ACTIONS['radio.cursorSelect']).toEqual({ kind: 'button', label: 'Radio menu: select' });
  });

  it('are modal (the radio option scope): they act only while the radio menu is open', () => {
    for (const id of ['radio.cursorPrev', 'radio.cursorNext', 'radio.cursorSelect'] as const) {
      expect(ACTION_SCOPES[id], id).toEqual(ACTION_SCOPES['radio.option1']);
      expect(isModal(id)).toBe(true);
      expect(isEligible(id, ctx())).toBe(false);
      expect(isEligible(id, ctx({ radioMenu: true }))).toBe(true);
      expect(isEligible(id, ctx({ radioMenu: true, driving: true }))).toBe(true);
    }
  });

  function padManager(): { input: InputManager; set: (buttons: number[]) => void } {
    let state: GamepadLike = { connected: true, buttons: [], axes: [] };
    const input = new InputManager({ bus: new EventBus<EventMap>(), getGamepads: () => [state] });
    return {
      input,
      set: (down) => {
        const buttons = Array.from({ length: 16 }, (_, i) => button(down.includes(i) ? 1 : 0));
        state = { connected: true, buttons, axes: [] };
      },
    };
  }

  it('with the menu closed the D-pad and A keep their usual actions and the cursor stays silent', () => {
    const { input, set } = padManager();
    input.setContext(ctx());
    set([12, 13, 0]);
    input.update();
    expect(input.wasPressed('officer.flashlight')).toBe(true); // D-pad up on foot
    expect(input.wasPressed('map.toggle')).toBe(true); // D-pad down
    expect(input.wasPressed('interact')).toBe(true); // A
    for (const id of ['radio.cursorPrev', 'radio.cursorNext', 'radio.cursorSelect'] as const) expect(input.wasPressed(id), id).toBe(false);
  });

  it('with the menu open the pad buttons pressed move the cursor and take the buttons from every other action', () => {
    const { input, set } = padManager();
    input.setContext(ctx({ radioMenu: true }));
    set([13]);
    input.update();
    expect(input.wasPressed('radio.cursorNext')).toBe(true);
    expect(input.wasPressed('map.toggle')).toBe(false);
    set([12]);
    input.update();
    expect(input.wasPressed('radio.cursorPrev')).toBe(true);
    expect(input.isDown('officer.flashlight')).toBe(false);
    set([0]);
    input.update();
    expect(input.wasPressed('radio.cursorSelect')).toBe(true);
    expect(input.isDown('interact')).toBe(false);
    expect(input.wasPressed('interact')).toBe(false);
  });

  it('takes the vehicle bindings of the buttons too (headlights on the D-pad up in a car)', () => {
    const { input, set } = padManager();
    input.setContext(ctx({ radioMenu: true, driving: true }));
    set([12]);
    input.update();
    expect(input.wasPressed('radio.cursorPrev')).toBe(true);
    expect(input.isDown('vehicle.headlights')).toBe(false);
  });

  it('a button held when the menu opens stays with its action until released', () => {
    const { input, set } = padManager();
    input.setContext(ctx({ driving: true }));
    set([12]);
    input.update();
    expect(input.isDown('vehicle.headlights')).toBe(true);
    input.setContext(ctx({ radioMenu: true, driving: true }));
    input.update();
    expect(input.isDown('vehicle.headlights')).toBe(true);
    expect(input.isDown('radio.cursorPrev')).toBe(false);
    set([]);
    input.update();
    set([12]);
    input.update();
    expect(input.wasPressed('radio.cursorPrev')).toBe(true);
    expect(input.isDown('vehicle.headlights')).toBe(false);
  });

  it('keeps the button with the menu until it is released even after the menu closed', () => {
    const { input, set } = padManager();
    input.setContext(ctx({ radioMenu: true }));
    set([0]);
    input.update();
    expect(input.wasPressed('radio.cursorSelect')).toBe(true);
    input.setContext(ctx()); // the option was chosen: the menu closed, A is still held
    input.update();
    expect(input.isDown('interact')).toBe(false);
    set([]);
    input.update();
    set([0]);
    input.update();
    expect(input.wasPressed('interact')).toBe(true);
  });

  it('PageUp / PageDown / Enter work as the keyboard side of the cursor', () => {
    const input = new InputManager({ bus: new EventBus<EventMap>(), getGamepads: () => [] });
    input.setContext(ctx({ radioMenu: true }));
    for (const [code, action] of [['PageUp', 'radio.cursorPrev'], ['PageDown', 'radio.cursorNext'], ['Enter', 'radio.cursorSelect']] as const) {
      input.handleKeyDown({ code });
      input.update();
      expect(input.wasPressed(action), code).toBe(true);
      input.handleKeyUp({ code });
      input.update();
    }
  });
});
