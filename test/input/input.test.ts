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
    const unbound = { code: 'KeyY', preventDefault: vi.fn() };
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

  describe('look input', () => {
    it('stickAxis ignores mouse movement, so mouse look is applied once (via mouseDelta)', () => {
      input.handleMouseMove({ movementX: 100, movementY: -40 });
      input.update();
      expect(input.axis('look.x')).toBe(1); // MouseX * 0.01, clamped
      expect(input.stickAxis('look.x')).toBe(0);
      expect(input.stickAxis('look.y')).toBe(0);
      expect(input.mouseDelta()).toEqual({ x: 100, y: -40 });
    });

    it('stickAxis still reads gamepad sticks and keys', () => {
      pads = [fakePad({ axes: [0, 0, 1, -1] })];
      input.handleMouseMove({ movementX: 50, movementY: 0 });
      input.update();
      expect(input.stickAxis('look.x')).toBe(1);
      expect(input.stickAxis('look.y')).toBe(-1);
      input.handleKeyDown({ code: 'KeyD' });
      input.update();
      expect(input.stickAxis('vehicle.steer')).toBe(1);
    });
  });

  describe('deadzone', () => {
    it('setDeadzone changes how far a stick must move', () => {
      pads = [fakePad({ axes: [0.3, 0] })];
      input.update();
      expect(input.deadzone).toBe(0.15);
      expect(input.axis('vehicle.steer')).toBeCloseTo((0.3 - 0.15) / 0.85);
      input.setDeadzone(0.4);
      input.update();
      expect(input.deadzone).toBe(0.4);
      expect(input.axis('vehicle.steer')).toBe(0);
      input.setDeadzone(0);
      input.update();
      expect(input.axis('vehicle.steer')).toBeCloseTo(0.3);
      input.setDeadzone(5);
      expect(input.deadzone).toBe(0.95);
    });
  });

  describe('pointer lock', () => {
    it('notifies when a held lock is released, not when it was never held', () => {
      const lost = vi.fn();
      input.setPointerLockEnabled(true);
      const off = input.onPointerLockLost(lost);
      input.handlePointerLockChange(false);
      expect(lost).not.toHaveBeenCalled();
      input.handlePointerLockChange(true);
      expect(input.isPointerLocked()).toBe(true);
      input.handlePointerLockChange(false);
      expect(lost).toHaveBeenCalledOnce();
      expect(input.isPointerLocked()).toBe(false);
      off();
      input.handlePointerLockChange(true);
      input.handlePointerLockChange(false);
      expect(lost).toHaveBeenCalledOnce();
    });
  });

  describe('capture from window-level mouse events', () => {
    it('captures a mouse button anywhere and swallows the resulting click', () => {
      const captured: Array<Binding | null> = [];
      input.captureNext((b) => captured.push(b));
      const down = { button: 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureMouseDown(down);
      expect(captured).toEqual([{ device: 'mouse', code: 'MouseButton2' }]);
      expect(down.preventDefault).toHaveBeenCalled();
      expect(down.stopPropagation).toHaveBeenCalled();
      expect(input.isCapturing()).toBe(false);

      const contextmenu = { type: 'contextmenu', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      const auxclick = { type: 'auxclick', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureClick(contextmenu);
      input.handleCaptureClick(auxclick);
      expect(contextmenu.preventDefault).toHaveBeenCalled();
      expect(auxclick.stopPropagation).toHaveBeenCalled();
      // Later clicks are untouched.
      const later = { type: 'click', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureClick(later);
      expect(later.preventDefault).not.toHaveBeenCalled();
    });

    it('a primary click on another control cancels the capture and goes through', () => {
      const captured: Array<Binding | null> = [];
      // Minimal Element stand-ins: closest() reports which selectors match.
      const control = (matches: (selector: string) => boolean) => ({ closest: (sel: string) => (matches(sel) ? {} : null) });
      const back = control((sel) => sel.includes('button'));
      const chip = control(() => true); // a button marked data-capture-target
      const empty = control(() => false);

      input.captureNext((b) => captured.push(b));
      const onBack = { button: 0, target: back, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureMouseDown(onBack);
      expect(captured).toEqual([null]);
      expect(onBack.preventDefault).not.toHaveBeenCalled();
      expect(onBack.stopPropagation).not.toHaveBeenCalled();
      expect(input.isCapturing()).toBe(false);

      input.captureNext((b) => captured.push(b));
      input.handleCaptureMouseDown({ button: 0, target: chip, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      input.captureNext((b) => captured.push(b));
      input.handleCaptureMouseDown({ button: 0, target: empty, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      input.captureNext((b) => captured.push(b));
      input.handleCaptureMouseDown({ button: 1, target: back, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(captured.slice(1)).toEqual([
        { device: 'mouse', code: 'MouseButton0' },
        { device: 'mouse', code: 'MouseButton0' },
        { device: 'mouse', code: 'MouseButton1' },
      ]);
    });

    it('leaves mouse events alone when no capture is pending', () => {
      const down = { button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureMouseDown(down);
      expect(down.preventDefault).not.toHaveBeenCalled();
      const click = { type: 'click', preventDefault: vi.fn(), stopPropagation: vi.fn() };
      input.handleCaptureClick(click);
      expect(click.stopPropagation).not.toHaveBeenCalled();
    });
  });

  describe('gamepad sticks on button actions', () => {
    it('a stick pushed one way presses exactly one of the opposing move actions', () => {
      const moves = ['move.forward', 'move.back', 'move.left', 'move.right'] as const;
      const cases: Array<[number[], (typeof moves)[number]]> = [
        [[0, -1], 'move.forward'],
        [[0, 1], 'move.back'],
        [[-1, 0], 'move.left'],
        [[1, 0], 'move.right'],
      ];
      for (const [axes, expected] of cases) {
        pads = [fakePad({ axes: [...axes, 0, 0] })];
        input.update();
        expect(moves.filter((m) => input.isDown(m)), expected).toEqual([expected]);
        expect(input.axis(expected)).toBe(1);
      }
    });
  });

  describe('modifier shortcuts', () => {
    it('leaves Ctrl/Cmd/Alt + a bound key to the browser', () => {
      for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
        const e = { code: 'KeyS', key: 's', ...mod, preventDefault: vi.fn() };
        input.handleKeyDown(e);
        input.update();
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(input.isDown('move.back')).toBe(false);
      }
    });

    it('still reads a modifier key itself, and drops keys held with Cmd when Cmd goes up', () => {
      const map = cloneBindings(DEFAULT_BINDINGS);
      map.interact = [{ device: 'keyboard', code: 'ControlLeft' }];
      input.setBindings(map);
      input.handleKeyDown({ code: 'ControlLeft', key: 'Control', ctrlKey: true });
      input.update();
      expect(input.isDown('interact')).toBe(true);

      input.handleKeyDown({ code: 'KeyW', key: 'w' });
      input.update();
      expect(input.isDown('move.forward')).toBe(true);
      input.handleKeyDown({ code: 'MetaLeft', key: 'Meta', metaKey: true });
      input.handleKeyUp({ code: 'MetaLeft' }); // macOS never sends KeyW's keyup here
      input.update();
      expect(input.isDown('move.forward')).toBe(false);
    });
  });

  describe('pointer lock while disabled', () => {
    it('releases a lock granted after locking was turned off', () => {
      const locking = new InputManager({ bus, pointerLock: true, getGamepads: () => pads });
      locking.setPointerLockEnabled(false);
      locking.handlePointerLockChange(true);
      expect(locking.isPointerLocked()).toBe(false);
    });

    it('the click that requests the lock does not also fire its action', () => {
      const requestPointerLock = vi.fn(() => Promise.resolve());
      const element = { requestPointerLock, ownerDocument: { exitPointerLock: vi.fn() } };
      const locking = new InputManager({ bus, pointerLock: true, getGamepads: () => pads });
      (locking as unknown as { element: unknown }).element = element;
      const map = cloneBindings(DEFAULT_BINDINGS);
      map['menu.toggle'] = [{ device: 'mouse', code: 'MouseButton3' }];
      locking.setBindings(map);
      locking.handleMouseDown({ button: 3 });
      locking.update();
      expect(requestPointerLock).toHaveBeenCalledOnce();
      expect(locking.isDown('menu.toggle')).toBe(false);
      locking.handlePointerLockChange(true);
      locking.handleMouseDown({ button: 3 });
      locking.update();
      expect(locking.isDown('menu.toggle')).toBe(true);
    });
  });

  describe('review regressions', () => {
    it('a gamepad button captured for rebinding does not fire the new binding until pressed again', () => {
      const pad = { connected: true, buttons: [button(0), button(0)], axes: [0] };
      pads = [pad];
      input.update();
      input.captureNext((b) => {
        if (!b) return;
        const map = input.getBindings();
        map['console.toggle'].push(b);
        input.setBindings(map);
      });
      pad.buttons[1] = button(1);
      input.update();
      expect(input.getBindings()['console.toggle']).toContainEqual({ device: 'gamepad', code: 'GamepadButton1' });
      expect(input.wasPressed('console.toggle')).toBe(false);
      input.update(); // still held from the capture
      expect(input.isDown('console.toggle')).toBe(false);
      pad.buttons[1] = button(0);
      input.update();
      pad.buttons[1] = button(1);
      input.update();
      expect(input.wasPressed('console.toggle')).toBe(true);
    });

    it('a gamepad axis captured for rebinding is ignored until it returns to centre', () => {
      const pad = { connected: true, buttons: [], axes: [0, 0] };
      pads = [pad];
      input.update();
      input.captureNext((b) => {
        if (!b) return;
        const map = input.getBindings();
        map['perf.toggle'] = [b];
        input.setBindings(map);
      });
      pad.axes[1] = 0.9;
      input.update();
      expect(input.isDown('perf.toggle')).toBe(false);
      pad.axes[1] = 0;
      input.update();
      pad.axes[1] = 0.9;
      input.update();
      expect(input.wasPressed('perf.toggle')).toBe(true);
    });

    it('UI actions bound to printable keys do not hijack typing in a text field', () => {
      const bindings = cloneBindings(DEFAULT_BINDINGS);
      bindings['console.toggle'] = [{ device: 'keyboard', code: 'KeyC' }];
      input.setBindings(bindings);
      const typed = { code: 'KeyC', key: 'c', target: { tagName: 'INPUT' }, preventDefault: vi.fn() };
      input.handleKeyDown(typed);
      input.update();
      expect(typed.preventDefault).not.toHaveBeenCalled();
      expect(input.wasPressed('console.toggle')).toBe(false);
      // Outside a text field the same key still toggles.
      input.handleKeyUp(typed);
      input.handleKeyDown({ code: 'KeyC', key: 'c', target: { tagName: 'BODY' } });
      input.update();
      expect(input.wasPressed('console.toggle')).toBe(true);
    });

    it('Escape and Backquote still work as UI keys inside a text field', () => {
      const field = { tagName: 'INPUT' };
      input.handleKeyDown({ code: 'Backquote', key: '`', target: field });
      input.handleKeyDown({ code: 'Escape', key: 'Escape', target: field });
      input.update();
      expect(input.wasPressed('console.toggle')).toBe(true);
      expect(input.wasPressed('menu.toggle')).toBe(true);
    });

    it('does not preventDefault gameplay keys while a menu control has focus', () => {
      const onButton = { code: 'ArrowDown', key: 'ArrowDown', target: { tagName: 'BUTTON' }, preventDefault: vi.fn() };
      input.handleKeyDown(onButton);
      expect(onButton.preventDefault).not.toHaveBeenCalled();
      const onBody = { code: 'ArrowDown', key: 'ArrowDown', target: { tagName: 'BODY' }, preventDefault: vi.fn() };
      input.handleKeyDown(onBody);
      expect(onBody.preventDefault).toHaveBeenCalledOnce();
      input.setPointerLockEnabled(true);
      input.handlePointerLockChange(true);
      const locked = { code: 'KeyW', key: 'w', target: { tagName: 'BUTTON' }, preventDefault: vi.fn() };
      input.handleKeyDown(locked);
      expect(locked.preventDefault).toHaveBeenCalledOnce();
      // UI keys are still handled (and prevented) on a focused button.
      const esc = { code: 'Escape', key: 'Escape', target: { tagName: 'BUTTON' }, preventDefault: vi.fn() };
      input.handleKeyDown(esc);
      expect(esc.preventDefault).toHaveBeenCalledOnce();
    });

    it('releases held mouse buttons when pointer lock is lost', () => {
      const bindings = cloneBindings(DEFAULT_BINDINGS);
      bindings.interact = [{ device: 'mouse', code: 'MouseButton0' }];
      input.setBindings(bindings);
      input.handlePointerLockChange(true);
      input.handleMouseDown({ button: 0 });
      input.update();
      expect(input.isDown('interact')).toBe(true);
      input.handlePointerLockChange(false); // the mouseup lands on a menu, not the canvas
      input.update();
      input.update();
      expect(input.isDown('interact')).toBe(false);
    });

    it('drops cursor movement gathered while pointer lock was disabled', () => {
      input.setPointerLockEnabled(false);
      input.handleMouseMove({ movementX: 300, movementY: 20 });
      input.update();
      expect(input.mouseDelta()).toEqual({ x: 300, y: 20 });
      input.setPointerLockEnabled(true);
      expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });
      input.setPointerLockEnabled(false);
      input.handleMouseMove({ movementX: 50, movementY: 0 });
      input.setPointerLockEnabled(true);
      input.handlePointerLockChange(true);
      input.update();
      expect(input.mouseDelta()).toEqual({ x: 0, y: 0 });
    });
  });
});
