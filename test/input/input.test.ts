import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { DEFAULT_BINDINGS, cloneBindings, type Binding } from '../../src/input/bindings';
import { InputManager, type GamepadLike } from '../../src/input/input';

function fakePad(partial: Partial<GamepadLike> = {}): GamepadLike {
  return { connected: true, buttons: [], axes: [], ...partial };
}

const button = (value: number): GamepadLike['buttons'][number] => ({ value, pressed: value > 0.5 });

describe('InputManager', () => {
  let bus: EventBus<EventMap>;
  let pads: Array<GamepadLike | null>;
  let input: InputManager;
  let events: EventMap['input:action'][];

  beforeEach(() => {
    bus = new EventBus<EventMap>();
    pads = [];
    events = [];
    bus.on('input:action', (e) => events.push(e));
    input = new InputManager({ bus, getGamepads: () => pads });
  });

  it('starts idle and reports nothing before update()', () => {
    expect(input.isDown('move.forward')).toBe(false);
    expect(input.wasPressed('move.forward')).toBe(false);
    expect(input.axis('vehicle.steer')).toBe(0);
    expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });
  });

  it('rolls press, hold and release edges across frames', () => {
    input.handleKeyDown({ code: 'KeyW' });
    expect(input.isDown('move.forward')).toBe(false); // not until update()

    input.update();
    expect(input.isDown('move.forward')).toBe(true);
    expect(input.wasPressed('move.forward')).toBe(true);
    expect(input.wasReleased('move.forward')).toBe(false);

    input.update();
    expect(input.isDown('move.forward')).toBe(true);
    expect(input.wasPressed('move.forward')).toBe(false);

    input.handleKeyUp({ code: 'KeyW' });
    input.update();
    expect(input.isDown('move.forward')).toBe(false);
    expect(input.wasReleased('move.forward')).toBe(true);

    input.update();
    expect(input.wasReleased('move.forward')).toBe(false);
  });

  it('registers a key tapped and released between two updates for one frame', () => {
    input.handleKeyDown({ code: 'KeyE' });
    input.handleKeyUp({ code: 'KeyE' });
    input.update();
    expect(input.wasPressed('interact')).toBe(true);
    expect(input.isDown('interact')).toBe(true);
    input.update();
    expect(input.wasReleased('interact')).toBe(true);
    expect(input.isDown('interact')).toBe(false);
  });

  it('ignores key repeats and prevents default on bound keys only', () => {
    const bound = { code: 'Backquote', preventDefault: vi.fn() };
    const unbound = { code: 'KeyZ', preventDefault: vi.fn() };
    input.handleKeyDown(bound);
    input.handleKeyDown(unbound);
    expect(bound.preventDefault).toHaveBeenCalledOnce();
    expect(unbound.preventDefault).not.toHaveBeenCalled();

    input.update();
    expect(input.wasPressed('console.toggle')).toBe(true);
    input.handleKeyDown({ code: 'Backquote', repeat: true });
    input.update();
    expect(input.wasPressed('console.toggle')).toBe(false);
    expect(input.isDown('console.toggle')).toBe(true);
  });

  it('ignores gameplay keys typed into a text field but keeps UI toggles', () => {
    const field = { tagName: 'INPUT' };
    input.handleKeyDown({ code: 'KeyW', target: field });
    input.handleKeyDown({ code: 'Escape', target: field });
    input.update();
    expect(input.isDown('move.forward')).toBe(false);
    expect(input.wasPressed('menu.toggle')).toBe(true);
  });

  it('emits input:action on the bus for button actions only', () => {
    input.handleKeyDown({ code: 'KeyW' });
    input.handleKeyDown({ code: 'KeyA' });
    input.update();
    const actions = events.map((e) => e.action).sort();
    // KeyW drives move.forward (button) and vehicle.accelerate (axis); KeyA drives move.left and vehicle.steer (axis).
    expect(actions).toEqual(['move.forward', 'move.left']);
    expect(events.every((e) => e.pressed && e.value === 1)).toBe(true);

    events.length = 0;
    input.handleKeyUp({ code: 'KeyW' });
    input.update();
    expect(events).toEqual([{ action: 'move.forward', value: 0, pressed: false }]);

    events.length = 0;
    input.update();
    expect(events).toEqual([]);
  });

  it('polls the first connected gamepad with deadzone and triggers', () => {
    pads = [null, fakePad({ axes: [0.05, 0], buttons: [button(0), button(0)] })];
    input.update();
    expect(input.axis('vehicle.steer')).toBe(0);

    const buttons = Array.from({ length: 8 }, () => button(0));
    buttons[7] = button(0.4);
    pads = [fakePad({ axes: [1, -1], buttons })];
    input.update();
    expect(input.axis('vehicle.steer')).toBe(1);
    expect(input.isDown('move.forward')).toBe(true);
    expect(input.isDown('move.right')).toBe(true);
    expect(input.axis('vehicle.accelerate')).toBeCloseTo(0.4);
    expect(input.isDown('vehicle.accelerate')).toBe(false);

    pads = [fakePad({ connected: false, axes: [1, -1], buttons })];
    input.update();
    expect(input.axis('vehicle.steer')).toBe(0);
    expect(input.wasReleased('move.forward')).toBe(true);
  });

  it('combines keyboard and gamepad contributions', () => {
    pads = [fakePad({ axes: [0.575, 0] })];
    input.handleKeyDown({ code: 'KeyA' });
    input.update();
    expect(input.axis('vehicle.steer')).toBeCloseTo(-0.5);
  });

  it('accumulates mouse movement per frame and clears it on update', () => {
    input.handleMouseMove({ movementX: 3, movementY: -2 });
    input.handleMouseMove({ movementX: 4, movementY: 1 });
    input.handleWheel({ deltaY: 120 });
    expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });

    input.update();
    expect(input.mouseDelta()).toEqual({ x: 7, y: -1 });
    expect(input.wheelDelta()).toBe(1);
    expect(input.axis('look.x')).toBeCloseTo(0.07);

    input.update();
    expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });
    expect(input.wheelDelta()).toBe(0);
    expect(input.axis('look.x')).toBe(0);
  });

  it('ignores mouse movement while pointer lock is enabled but not held', () => {
    const locked = new InputManager({ bus, pointerLock: true, getGamepads: () => pads });
    locked.handleMouseMove({ movementX: 10, movementY: 10 });
    locked.update();
    expect(locked.mouseDelta()).toEqual({ x: 0, y: 0 });
    expect(locked.isPointerLocked()).toBe(false);
  });

  it('tracks mouse buttons through custom bindings', () => {
    const bindings = cloneBindings(DEFAULT_BINDINGS);
    bindings.interact = [{ device: 'mouse', code: 'MouseButton0' }];
    input.setBindings(bindings);
    input.handleMouseDown({ button: 0 });
    input.update();
    expect(input.wasPressed('interact')).toBe(true);
    input.handleMouseUp({ button: 0 });
    input.update();
    expect(input.wasReleased('interact')).toBe(true);
  });

  it('clears held input on blur', () => {
    input.handleKeyDown({ code: 'KeyW' });
    input.handleMouseDown({ button: 0 });
    input.handleMouseMove({ movementX: 5, movementY: 5 });
    input.handleBlur();
    input.update();
    expect(input.isDown('move.forward')).toBe(false);
    expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });
  });

  describe('bindings', () => {
    it('getBindings returns a copy that does not alias internal state', () => {
      const copy = input.getBindings();
      copy.interact.length = 0;
      input.handleKeyDown({ code: 'KeyE' });
      input.update();
      expect(input.isDown('interact')).toBe(true);
    });

    it('rebind replaces a slot or appends past the end; unbind removes', () => {
      input.rebind('interact', 0, { device: 'keyboard', code: 'KeyF' });
      input.rebind('interact', 99, { device: 'keyboard', code: 'KeyG' });
      expect(input.getBindings().interact.map((b) => b.code)).toEqual(['KeyF', 'GamepadButton0', 'KeyG']);

      input.handleKeyDown({ code: 'KeyE' });
      input.handleKeyDown({ code: 'KeyG' });
      input.update();
      expect(input.isDown('interact')).toBe(true);
      input.handleKeyUp({ code: 'KeyG' });
      input.update();
      expect(input.isDown('interact')).toBe(false);

      input.unbind('interact', 2);
      input.unbind('interact', 1);
      expect(input.getBindings().interact).toEqual([{ device: 'keyboard', code: 'KeyF' }]);

      input.resetBindings();
      expect(input.getBindings()).toEqual(DEFAULT_BINDINGS);
    });
  });

  describe('captureNext', () => {
    it('delivers the next key and swallows it from the action state', () => {
      const captured: Array<Binding | null> = [];
      input.captureNext((b) => captured.push(b));
      expect(input.isCapturing()).toBe(true);

      const e = { code: 'KeyW', preventDefault: vi.fn() };
      input.handleKeyDown(e);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(captured).toEqual([{ device: 'keyboard', code: 'KeyW' }]);
      expect(input.isCapturing()).toBe(false);

      input.update();
      expect(input.isDown('move.forward')).toBe(false);
    });

    it('captures mouse buttons, gamepad buttons and deflected axes with sign', () => {
      const captured: Array<Binding | null> = [];
      input.captureNext((b) => captured.push(b));
      input.handleMouseDown({ button: 2 });

      input.captureNext((b) => captured.push(b));
      pads = [fakePad({ buttons: [button(0), button(1)] })];
      input.update();

      // Button still held: a fresh capture must wait for a new edge.
      input.captureNext((b) => captured.push(b));
      input.update();
      expect(input.isCapturing()).toBe(true);
      pads = [fakePad({ buttons: [button(0), button(1)], axes: [0, -0.9] })];
      input.update();

      expect(captured).toEqual([
        { device: 'mouse', code: 'MouseButton2' },
        { device: 'gamepad', code: 'GamepadButton1' },
        { device: 'gamepad', code: 'GamepadAxis1', scale: -1 },
      ]);
    });

    it('Escape cancels with null and the returned function abandons the capture', () => {
      const cb = vi.fn();
      input.captureNext(cb);
      input.handleKeyDown({ code: 'Escape' });
      expect(cb).toHaveBeenCalledWith(null);

      const cancel = input.captureNext(cb);
      cancel();
      expect(input.isCapturing()).toBe(false);
      input.handleKeyDown({ code: 'KeyE' });
      expect(cb).toHaveBeenCalledOnce();
      input.update();
      expect(input.isDown('interact')).toBe(true);
    });
  });
});
