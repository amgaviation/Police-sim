import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { layoutBindings } from '../../src/a11y/layouts';
import { ACTION_IDS } from '../../src/input/actions';
import { DEFAULT_BINDINGS, type BindingMap } from '../../src/input/bindings';
import {
  ACTION_SCOPES, DEFAULT_INPUT_CONTEXT, bindingCollisions, isEligible, scopesOverlap, unreachableActions, type InputContext,
} from '../../src/input/context';
import { InputManager } from '../../src/input/input';

const ctx = (over: Partial<InputContext> = {}): InputContext => ({ ...DEFAULT_INPUT_CONTEXT, ...over });

function manager(layout: BindingMap = layoutBindings('left')): InputManager {
  return new InputManager({ bus: new EventBus<EventMap>(), bindings: layout, getGamepads: () => [] });
}

/** A frame: keys go down, the manager updates. */
function press(input: InputManager, ...codes: string[]): void {
  for (const code of codes) input.handleKeyDown({ code });
  input.update();
}

describe('action scopes', () => {
  it('cover every action', () => {
    expect(Object.keys(ACTION_SCOPES).sort()).toEqual([...ACTION_IDS].sort());
  });

  it('eligibility follows foot / vehicle / aircraft / session mode / radio menu', () => {
    expect(isEligible('move.forward', ctx())).toBe(true);
    expect(isEligible('move.forward', ctx({ driving: true }))).toBe(false);
    expect(isEligible('vehicle.siren', ctx())).toBe(false);
    expect(isEligible('vehicle.siren', ctx({ driving: true }))).toBe(true);
    expect(isEligible('vehicle.handbrake', ctx({ driving: true }))).toBe(true);
    expect(isEligible('vehicle.handbrake', ctx({ driving: true, aircraft: true }))).toBe(false);
    expect(isEligible('vehicle.lift', ctx({ driving: true, aircraft: true }))).toBe(true);
    expect(isEligible('vehicle.lift', ctx({ driving: true }))).toBe(false);
    expect(isEligible('career.menu', ctx())).toBe(true);
    expect(isEligible('career.menu', ctx({ mode: 'coop' }))).toBe(false);
    expect(isEligible('coop.menu', ctx({ mode: 'coop' }))).toBe(true);
    expect(isEligible('coop.menu', ctx())).toBe(false);
    expect(isEligible('dispatch.console', ctx({ mode: 'dispatch' }))).toBe(true);
    expect(isEligible('radio.option1', ctx())).toBe(false);
    expect(isEligible('radio.option1', ctx({ radioMenu: true }))).toBe(true);
  });

  it('knows which actions can never act together', () => {
    expect(scopesOverlap('move.forward', 'vehicle.accelerate')).toBe(false);
    expect(scopesOverlap('career.menu', 'coop.menu')).toBe(false);
    expect(scopesOverlap('coop.menu', 'dispatch.console')).toBe(false);
    expect(scopesOverlap('radio.option1', 'scene.menu')).toBe(false);
    expect(scopesOverlap('scene.menu', 'backup.menu')).toBe(true);
    expect(scopesOverlap('perf.toggle', 'career.menu')).toBe(true);
    expect(scopesOverlap('officer.fire', 'air.flir')).toBe(true);
  });
});

describe('bindingCollisions / unreachableActions', () => {
  it('finds the double-fire pairs the old presets had (F3, Delete)', () => {
    const map = layoutBindings('left');
    map['perf.toggle'] = [{ device: 'keyboard', code: 'F3' }];
    expect(bindingCollisions(map, ACTION_IDS).some((c) => c.key === 'keyboard:F3' && !c.shadowed && c.actions.includes('perf.toggle'))).toBe(true);
    const right = layoutBindings('right');
    right['camera.toggle'] = [{ device: 'keyboard', code: 'Insert' }];
    expect(bindingCollisions(right, ACTION_IDS).some((c) => c.key === 'keyboard:Insert' && !c.shadowed)).toBe(true);
  });

  it('reports a rare opener behind a core action on every key it has', () => {
    const map = layoutBindings('right');
    map['fleet.menu'] = [{ device: 'keyboard', code: 'Enter' }]; // interact, always eligible
    expect(unreachableActions(map, ACTION_IDS)).toEqual(['fleet.menu']);
  });

  it('the default bindings have no collision at all', () => {
    expect(bindingCollisions(DEFAULT_BINDINGS, ACTION_IDS)).toEqual([]);
  });
});

describe('InputManager key arbitration', () => {
  it('lets the radio menu own a shared key (T then 1 chooses the option and opens no panel)', () => {
    const input = manager();
    input.setContext(ctx({ radioMenu: true }));
    press(input, 'Digit1');
    expect(input.wasPressed('radio.option1')).toBe(true);
    expect(input.wasPressed('scene.menu')).toBe(false);
    expect(input.isDown('scene.menu')).toBe(false);
  });

  it('keeps the key with the menu until it is released, even after the menu closed', () => {
    const input = manager();
    input.setContext(ctx({ radioMenu: true }));
    press(input, 'Digit4');
    expect(input.wasPressed('radio.option4')).toBe(true);
    input.setContext(ctx()); // the option was chosen: the menu is closed, the key is still held
    input.update();
    expect(input.isDown('officer.leanLeft')).toBe(false);
    expect(input.wasPressed('officer.leanLeft')).toBe(false);
    input.handleKeyUp({ code: 'Digit4' });
    input.update();
    press(input, 'Digit4');
    expect(input.isDown('officer.leanLeft')).toBe(true);
  });

  it('opens the panel on the same key when the radio menu is closed', () => {
    const input = manager();
    input.setContext(ctx());
    press(input, 'Digit1');
    expect(input.wasPressed('scene.menu')).toBe(true);
    expect(input.wasPressed('radio.option1')).toBe(false);
  });

  it('does not hand a key that was already held to the menu that opens later', () => {
    const input = manager();
    input.setContext(ctx());
    press(input, 'Digit4');
    expect(input.isDown('officer.leanLeft')).toBe(true);
    input.setContext(ctx({ radioMenu: true }));
    input.update();
    expect(input.isDown('officer.leanLeft')).toBe(true);
    expect(input.isDown('radio.option4')).toBe(false);
  });

  it('sends a shared key to the action of the situation: on foot, in a car, in an aircraft', () => {
    const input = manager();
    input.setContext(ctx());
    press(input, 'Space');
    expect(input.wasPressed('officer.tackle')).toBe(true);
    expect(input.isDown('vehicle.handbrake')).toBe(false);
    expect(input.isDown('vehicle.lift')).toBe(false);
    input.handleKeyUp({ code: 'Space' });
    input.update();
    input.setContext(ctx({ driving: true }));
    press(input, 'Space');
    expect(input.wasPressed('vehicle.handbrake')).toBe(true);
    expect(input.isDown('officer.tackle')).toBe(false);
    expect(input.axis('vehicle.lift')).toBe(0);
    input.handleKeyUp({ code: 'Space' });
    input.update();
    input.setContext(ctx({ driving: true, aircraft: true }));
    press(input, 'Space');
    expect(input.isDown('vehicle.handbrake')).toBe(false);
    expect(input.axis('vehicle.lift')).toBe(1);
  });

  it('keeps the unshared bindings of a silenced action (arrow keys drive while WASD is shared)', () => {
    const input = new InputManager({ bus: new EventBus<EventMap>(), getGamepads: () => [] });
    input.setContext(ctx({ driving: true }));
    press(input, 'KeyW');
    expect(input.axis('vehicle.accelerate')).toBe(1);
    expect(input.isDown('move.forward')).toBe(false);
  });

  it('one press of F3 opens only the screen of the session mode', () => {
    for (const [mode, opens] of [['solo', 'career.menu'], ['coop', 'coop.menu'], ['dispatch', 'dispatch.console']] as const) {
      const input = manager();
      input.setContext(ctx({ mode }));
      press(input, 'F3');
      const fired = (['career.menu', 'coop.menu', 'dispatch.console', 'perf.toggle'] as const).filter((a) => input.wasPressed(a));
      expect(fired, mode).toEqual([opens]);
    }
  });

  it('gives way a rare opener to a core action on the same key, only where both act', () => {
    const input = manager();
    input.setContext(ctx()); // on foot: Digit4 = lean left (core) over backup.menu
    press(input, 'Digit4');
    expect(input.wasPressed('officer.leanLeft')).toBe(true);
    expect(input.wasPressed('backup.menu')).toBe(false);
    input.handleKeyUp({ code: 'Digit4' });
    input.update();
    input.setContext(ctx({ driving: true })); // in a car the key is free for the opener
    press(input, 'Digit4');
    expect(input.wasPressed('backup.menu')).toBe(true);
    expect(input.wasPressed('officer.leanLeft')).toBe(false);
  });

  it('does nothing until the game describes the situation (legacy behaviour)', () => {
    const input = manager();
    press(input, 'Space');
    expect(input.isDown('officer.tackle')).toBe(true);
    expect(input.isDown('vehicle.handbrake')).toBe(true);
  });

  it('follows rebinding', () => {
    const input = manager(DEFAULT_BINDINGS);
    input.setContext(ctx());
    input.rebind('map.toggle', 0, { device: 'keyboard', code: 'KeyK' }); // KeyK = vehicle.lightPattern
    press(input, 'KeyK');
    expect(input.wasPressed('map.toggle')).toBe(true);
    expect(input.isDown('vehicle.lightPattern')).toBe(false);
  });
});
