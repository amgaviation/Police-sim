import { describe, expect, it } from 'vitest';
import { ACTION_IDS, isActionId } from '../../src/input/actions';
import {
  BINDINGS_SCHEMA_VERSION,
  DEFAULT_BINDINGS,
  bindingSign,
  bindingsEqual,
  cloneBindings,
  isBinding,
  parseBindings,
  serializeBindings,
  withBindingSign,
  type Binding,
} from '../../src/input/bindings';
import { resolveActions, type RawInputState } from '../../src/input/input';

describe('DEFAULT_BINDINGS', () => {
  it('binds every action to at least one valid binding', () => {
    for (const id of ACTION_IDS) {
      const list = DEFAULT_BINDINGS[id];
      expect(list.length, id).toBeGreaterThan(0);
      for (const b of list) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
    }
  });

  it('uses WASD and arrows for movement, Shift for sprint, Esc/Backquote/F3 for UI', () => {
    const codes = (id: keyof typeof DEFAULT_BINDINGS): string[] => DEFAULT_BINDINGS[id].map((b) => b.code);
    expect(codes('move.forward')).toEqual(expect.arrayContaining(['KeyW', 'ArrowUp']));
    expect(codes('move.left')).toEqual(expect.arrayContaining(['KeyA', 'ArrowLeft']));
    expect(codes('move.sprint')).toContain('ShiftLeft');
    expect(codes('interact')).toContain('KeyE');
    expect(codes('menu.toggle')).toContain('Escape');
    expect(codes('console.toggle')).toContain('Backquote');
    expect(codes('perf.toggle')).toContain('F3');
    expect(codes('vehicle.steer')).toContain('GamepadAxis0');
    expect(codes('vehicle.accelerate')).toContain('GamepadButton7');
  });
});

describe('Phase 2 default bindings', () => {
  const codes = (id: keyof typeof DEFAULT_BINDINGS): string[] => DEFAULT_BINDINGS[id].map((b) => b.code);

  it('match the design table (§11.5)', () => {
    const table: [keyof typeof DEFAULT_BINDINGS, string[]][] = [
      ['vehicle.siren', ['KeyQ', 'GamepadButton3']],
      ['vehicle.lights', ['KeyL', 'GamepadButton2']],
      ['vehicle.sirenTone', ['KeyR', 'GamepadButton4']],
      ['vehicle.horn', ['KeyG', 'GamepadButton11']],
      ['vehicle.manual', ['KeyF']],
      ['vehicle.lightPattern', ['KeyK']],
      ['vehicle.spotlight', ['KeyJ']],
      ['vehicle.spotAim', ['MouseButton2']],
      ['vehicle.equipment', ['KeyX']],
      ['mdt.toggle', ['Tab']],
      ['target.runPlate', ['KeyP', 'GamepadButton15']],
      ['radio.menu', ['KeyT', 'GamepadButton14']],
      ['radio.ptt', ['KeyB', 'GamepadButton5']],
      ['radio.emergency', ['KeyZ']],
      ['radio.channelPrev', ['BracketLeft']],
      ['radio.channelNext', ['BracketRight']],
      ['radio.scan', ['Backslash']],
    ];
    for (const [id, expected] of table) expect(codes(id), id).toEqual(expected);
    expect(DEFAULT_BINDINGS['vehicle.spotAim']).toEqual([{ device: 'mouse', code: 'MouseButton2' }]);
  });

  it('binds Digit1..Digit9 to radio.option1..9', () => {
    for (let i = 1; i <= 9; i++) {
      const id = `radio.option${i}`;
      expect(isActionId(id)).toBe(true);
      if (isActionId(id)) expect(DEFAULT_BINDINGS[id]).toEqual([{ device: 'keyboard', code: `Digit${i}` }]);
    }
  });

  it('binds no keyboard code or gamepad button to two actions, except the intended shared ones', () => {
    // Driving and walking share keys (design §11.5, §12.5): W/A/S/D and the arrows move on foot and drive,
    // Space is the handbrake and the tackle, G the horn and the shout, GamepadButton1 and GamepadButton7 the
    // handbrake / throttle and the tackle / fire. GamepadButton9 (Start) is both the menu and the weapon cycle
    // as the design table says.
    // Phase 4 adds on-foot X / Q / R / F, right mouse button and pads 6 / 11 / 12 (equipment, siren, siren tone, manual
    // siren, spotlight aim, brake, horn, headlights in a car).
    const shared = new Set([
      'KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyG', 'GamepadButton1', 'GamepadButton7',
      'KeyX', 'KeyQ', 'KeyR', 'KeyF', 'MouseButton2', 'GamepadButton6', 'GamepadButton11', 'GamepadButton12',
      // Phase 5: H (headlights / intervene) and J (spotlight / bodycam mute).
      'KeyH', 'KeyJ',
    ]);
    const owners = new Map<string, string[]>();
    for (const id of ACTION_IDS) {
      for (const b of DEFAULT_BINDINGS[id]) {
        if (b.device === 'gamepad' && b.code.startsWith('GamepadAxis')) continue;
        const k = `${b.device}:${b.code}`;
        owners.set(k, [...(owners.get(k) ?? []), id]);
      }
    }
    for (const [k, ids] of owners) {
      if (ids.length < 2) continue;
      const code = k.slice(k.indexOf(':') + 1);
      if (code === 'GamepadButton9') {
        expect(ids.sort(), k).toEqual(['menu.toggle', 'officer.weapon']);
        continue;
      }
      expect(shared.has(code), `${k} bound to ${ids.join(', ')}`).toBe(true);
      expect(
        ids.every((id) => id.startsWith('move.') || id.startsWith('vehicle.') || id.startsWith('officer.')),
        k,
      ).toBe(true);
      // Never two actions of the same context on one input: at most one on-foot (move./officer.) pairing with vehicle ones.
      expect(ids.filter((id) => id.startsWith('vehicle.')).length, k).toBeLessThanOrEqual(1);
    }
  });
});

describe('Phase 3 default bindings', () => {
  const codes = (id: keyof typeof DEFAULT_BINDINGS): string[] => DEFAULT_BINDINGS[id].map((b) => b.code);

  it('match the design table (§12.5)', () => {
    expect(DEFAULT_BINDINGS['officer.weapon']).toEqual([
      { device: 'keyboard', code: 'KeyC' },
      { device: 'gamepad', code: 'GamepadButton9' },
    ]);
    expect(DEFAULT_BINDINGS['officer.fire']).toEqual([
      { device: 'mouse', code: 'MouseButton0' },
      { device: 'gamepad', code: 'GamepadButton7' },
    ]);
    expect(DEFAULT_BINDINGS['officer.tackle']).toEqual([
      { device: 'keyboard', code: 'Space' },
      { device: 'gamepad', code: 'GamepadButton1' },
    ]);
    expect(codes('officer.shout')).toEqual(['KeyG']);
    expect(codes('scene.menu')).toEqual(['KeyY']);
  });

  it('are valid bindings that survive a serialize / parse round trip', () => {
    for (const id of ['officer.weapon', 'officer.fire', 'officer.tackle', 'officer.shout', 'scene.menu'] as const) {
      for (const b of DEFAULT_BINDINGS[id]) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
    }
    expect(parseBindings(JSON.parse(JSON.stringify(serializeBindings(DEFAULT_BINDINGS))))).toEqual(DEFAULT_BINDINGS);
  });

  it('are rebindable like the others, and an old save without them gets the defaults', () => {
    const custom = parseBindings({ 'officer.shout': [{ device: 'keyboard', code: 'KeyH' }], interact: [{ device: 'keyboard', code: 'KeyF' }] });
    expect(custom['officer.shout']).toEqual([{ device: 'keyboard', code: 'KeyH' }]);
    expect(custom['officer.tackle']).toEqual(DEFAULT_BINDINGS['officer.tackle']);
    const old = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([id]) => !id.startsWith('officer.') && id !== 'scene.menu'));
    const parsed = parseBindings({ version: BINDINGS_SCHEMA_VERSION, bindings: old });
    expect(parsed).toEqual(DEFAULT_BINDINGS);
  });

  it('resolves Phase 3 actions from their default keys and mouse button', () => {
    const raw = (keys: string[], mouseButtons: number[] = []): RawInputState => ({
      keys: new Set(keys),
      mouseButtons: new Set(mouseButtons),
      mouse: { x: 0, y: 0, wheel: 0 },
      gamepadButtons: [],
      gamepadAxes: [],
    });
    const weapon = resolveActions(DEFAULT_BINDINGS, raw(['KeyC']));
    expect(weapon['officer.weapon']).toBe(1);
    expect(weapon['officer.tackle']).toBe(0);
    // Space is both the handbrake and the tackle; the game picks by context.
    const space = resolveActions(DEFAULT_BINDINGS, raw(['Space']));
    expect([space['vehicle.handbrake'], space['officer.tackle']]).toEqual([1, 1]);
    expect(resolveActions(DEFAULT_BINDINGS, raw([], [0]))['officer.fire']).toBe(1);
    expect(resolveActions(DEFAULT_BINDINGS, raw(['KeyY']))['scene.menu']).toBe(1);
    expect(resolveActions(DEFAULT_BINDINGS, raw(['KeyG']))['officer.shout']).toBe(1);
  });
});

describe('Phase 4 default bindings', () => {
  it('match the design table (§11.4)', () => {
    const table: [keyof typeof DEFAULT_BINDINGS, readonly { device: string; code: string }[]][] = [
      ['officer.crouch', [{ device: 'keyboard', code: 'KeyX' }, { device: 'gamepad', code: 'GamepadButton11' }]],
      ['officer.leanLeft', [{ device: 'keyboard', code: 'KeyQ' }]],
      ['officer.leanRight', [{ device: 'keyboard', code: 'KeyR' }]],
      ['officer.slice', [{ device: 'mouse', code: 'MouseButton2' }, { device: 'gamepad', code: 'GamepadButton6' }]],
      ['officer.flashlight', [{ device: 'keyboard', code: 'KeyF' }, { device: 'gamepad', code: 'GamepadButton12' }]],
      ['officer.bodycam', [{ device: 'keyboard', code: 'KeyU' }]],
      ['investigate.menu', [{ device: 'keyboard', code: 'KeyI' }]],
      ['camera.photo', [{ device: 'keyboard', code: 'KeyO' }]],
      ['partner.menu', [{ device: 'keyboard', code: 'KeyN' }]],
    ];
    for (const [id, expected] of table) {
      expect(DEFAULT_BINDINGS[id], id).toEqual(expected);
      for (const b of DEFAULT_BINDINGS[id]) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
    }
  });

  it('only reuse inputs of driving actions (X, Q, R, F, RMB, pads 6 / 11 / 12), never of another on-foot action', () => {
    const onFoot = new Map<string, string[]>();
    for (const id of ACTION_IDS) {
      if (id.startsWith('vehicle.') || id.startsWith('radio.') || id === 'mdt.toggle') continue;
      for (const b of DEFAULT_BINDINGS[id]) {
        if (b.device === 'gamepad' && b.code.startsWith('GamepadAxis')) continue;
        const k = `${b.device}:${b.code}`;
        onFoot.set(k, [...(onFoot.get(k) ?? []), id]);
      }
    }
    for (const id of ['officer.crouch', 'officer.leanLeft', 'officer.leanRight', 'officer.slice', 'officer.flashlight', 'officer.bodycam', 'investigate.menu', 'camera.photo', 'partner.menu'] as const) {
      for (const b of DEFAULT_BINDINGS[id]) expect(onFoot.get(`${b.device}:${b.code}`), `${id} ${b.code}`).toEqual([id]);
    }
  });

  it('survive a serialize / parse round trip and an old save without them gets the defaults', () => {
    expect(parseBindings(JSON.parse(JSON.stringify(serializeBindings(DEFAULT_BINDINGS))))).toEqual(DEFAULT_BINDINGS);
    const ids = ['officer.crouch', 'officer.leanLeft', 'officer.leanRight', 'officer.slice', 'officer.flashlight', 'officer.bodycam', 'investigate.menu', 'camera.photo', 'partner.menu'];
    const old = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([id]) => !ids.includes(id)));
    expect(parseBindings({ version: BINDINGS_SCHEMA_VERSION, bindings: old })).toEqual(DEFAULT_BINDINGS);
  });

  it('has no action bound twice to the same input within one action', () => {
    for (const id of ACTION_IDS) {
      const keys = DEFAULT_BINDINGS[id].map((b) => `${b.device}:${b.code}:${String(b.scale ?? 1)}`);
      expect(new Set(keys).size, id).toBe(keys.length);
    }
  });

  it('resolves the new actions from their default inputs', () => {
    const raw = (keys: string[], mouseButtons: number[] = [], pad: number[] = []): RawInputState => ({
      keys: new Set(keys),
      mouseButtons: new Set(mouseButtons),
      mouse: { x: 0, y: 0, wheel: 0 },
      gamepadButtons: pad.map((n) => n),
      gamepadAxes: [],
    });
    expect(resolveActions(DEFAULT_BINDINGS, raw(['KeyX']))['officer.crouch']).toBe(1);
    expect(resolveActions(DEFAULT_BINDINGS, raw(['KeyU']))['officer.bodycam']).toBe(1);
    expect(resolveActions(DEFAULT_BINDINGS, raw([], [2]))['officer.slice']).toBe(1);
    const a = resolveActions(DEFAULT_BINDINGS, raw(['KeyQ']));
    // Q is the siren in a car and the left lean on foot; the game picks by context.
    expect([a['vehicle.siren'], a['officer.leanLeft'], a['officer.leanRight']]).toEqual([1, 1, 0]);
  });
});

describe('Phase 5 default bindings', () => {
  const phase5 = ['officer.intervene', 'officer.bodycamMute'] as const;

  it('bind H to intervene and J to the bodycam mute, and keep C for the force tool cycle', () => {
    expect(DEFAULT_BINDINGS['officer.intervene']).toEqual([{ device: 'keyboard', code: 'KeyH' }]);
    expect(DEFAULT_BINDINGS['officer.bodycamMute']).toEqual([{ device: 'keyboard', code: 'KeyJ' }]);
    expect(DEFAULT_BINDINGS['officer.weapon']).toEqual([
      { device: 'keyboard', code: 'KeyC' },
      { device: 'gamepad', code: 'GamepadButton9' },
    ]);
    for (const id of phase5) for (const b of DEFAULT_BINDINGS[id]) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
  });

  it('only share their keys with driving actions, never with another on-foot action', () => {
    const onFoot = new Map<string, string[]>();
    const driving = new Map<string, string[]>();
    for (const id of ACTION_IDS) {
      for (const b of DEFAULT_BINDINGS[id]) {
        if (b.device === 'gamepad' && b.code.startsWith('GamepadAxis')) continue;
        const target = id.startsWith('vehicle.') ? driving : id.startsWith('radio.') || id === 'mdt.toggle' ? null : onFoot;
        if (!target) continue;
        const k = `${b.device}:${b.code}`;
        target.set(k, [...(target.get(k) ?? []), id]);
      }
    }
    for (const id of phase5) {
      for (const b of DEFAULT_BINDINGS[id]) {
        const k = `${b.device}:${b.code}`;
        expect(onFoot.get(k), `${id} ${b.code}`).toEqual([id]);
        expect(driving.get(k)?.length ?? 0, `${id} ${b.code} driving`).toBeLessThanOrEqual(1);
      }
    }
    expect(driving.get('keyboard:KeyH')).toEqual(['vehicle.headlights']);
    expect(driving.get('keyboard:KeyJ')).toEqual(['vehicle.spotlight']);
  });

  it('survive a round trip and an old save without them gets the defaults', () => {
    expect(parseBindings(JSON.parse(JSON.stringify(serializeBindings(DEFAULT_BINDINGS))))).toEqual(DEFAULT_BINDINGS);
    const old = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([id]) => !phase5.some((p) => p === id)));
    expect(parseBindings({ version: BINDINGS_SCHEMA_VERSION, bindings: old })).toEqual(DEFAULT_BINDINGS);
  });

  it('resolves from H and J', () => {
    const raw = (keys: string[]): RawInputState => ({
      keys: new Set(keys),
      mouseButtons: new Set<number>(),
      mouse: { x: 0, y: 0, wheel: 0 },
      gamepadButtons: [],
      gamepadAxes: [],
    });
    const h = resolveActions(DEFAULT_BINDINGS, raw(['KeyH']));
    // H is the headlights in a car and the intervene key on foot; the game picks by context.
    expect([h['vehicle.headlights'], h['officer.intervene'], h['officer.bodycamMute']]).toEqual([1, 1, 0]);
    const j = resolveActions(DEFAULT_BINDINGS, raw(['KeyJ']));
    expect([j['vehicle.spotlight'], j['officer.bodycamMute'], j['officer.intervene']]).toEqual([1, 1, 0]);
  });
});

describe('Phase 6 default bindings', () => {
  const phase6 = ['backup.menu', 'command.menu', 'pursuit.menu', 'air.flir'] as const;
  const keys: Record<(typeof phase6)[number], string> = {
    'backup.menu': 'Comma',
    'command.menu': 'Period',
    'pursuit.menu': 'Semicolon',
    'air.flir': 'Slash',
  };

  it('bind Comma, Period, Semicolon and Slash with no gamepad default', () => {
    for (const id of phase6) {
      expect(DEFAULT_BINDINGS[id], id).toEqual([{ device: 'keyboard', code: keys[id] }]);
      for (const b of DEFAULT_BINDINGS[id]) expect(isBinding(b), `${id}: ${b.code}`).toBe(true);
    }
  });

  it('collide with no other default binding', () => {
    for (const id of phase6) {
      const code = keys[id];
      const owners = ACTION_IDS.filter((a) => DEFAULT_BINDINGS[a].some((b) => b.device === 'keyboard' && b.code === code));
      expect(owners, code).toEqual([id]);
    }
  });

  it('survive a round trip and an old save without them gets the defaults', () => {
    expect(parseBindings(JSON.parse(JSON.stringify(serializeBindings(DEFAULT_BINDINGS))))).toEqual(DEFAULT_BINDINGS);
    const old = Object.fromEntries(Object.entries(DEFAULT_BINDINGS).filter(([id]) => !phase6.some((p) => p === id)));
    expect(parseBindings({ version: BINDINGS_SCHEMA_VERSION, bindings: old })).toEqual(DEFAULT_BINDINGS);
  });

  it('resolve from their keys', () => {
    const raw = (keys2: string[]): RawInputState => ({
      keys: new Set(keys2),
      mouseButtons: new Set<number>(),
      mouse: { x: 0, y: 0, wheel: 0 },
      gamepadButtons: [],
      gamepadAxes: [],
    });
    for (const id of phase6) {
      const r = resolveActions(DEFAULT_BINDINGS, raw([keys[id]]));
      expect(r[id], id).toBe(1);
      expect(phase6.filter((o) => r[o] === 1)).toEqual([id]);
    }
  });
});

describe('isBinding', () => {
  it('accepts well-formed bindings for each device', () => {
    expect(isBinding({ device: 'keyboard', code: 'KeyW' })).toBe(true);
    expect(isBinding({ device: 'keyboard', code: 'KeyA', scale: -1 })).toBe(true);
    expect(isBinding({ device: 'mouse', code: 'MouseButton0' })).toBe(true);
    expect(isBinding({ device: 'mouse', code: 'MouseX', scale: 0.01 })).toBe(true);
    expect(isBinding({ device: 'gamepad', code: 'GamepadAxis2' })).toBe(true);
    expect(isBinding({ device: 'gamepad', code: 'GamepadButton12' })).toBe(true);
  });

  it('rejects malformed bindings', () => {
    expect(isBinding(null)).toBe(false);
    expect(isBinding('KeyW')).toBe(false);
    expect(isBinding({ device: 'touch', code: 'Tap' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: '' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: 'KeyW', scale: 'fast' })).toBe(false);
    expect(isBinding({ device: 'keyboard', code: 'KeyW', scale: Number.NaN })).toBe(false);
    expect(isBinding({ device: 'mouse', code: 'KeyW' })).toBe(false);
    expect(isBinding({ device: 'gamepad', code: 'MouseX' })).toBe(false);
  });
});

describe('serializeBindings / parseBindings', () => {
  it('round-trips a map through the versioned envelope', () => {
    const custom = cloneBindings(DEFAULT_BINDINGS);
    custom.interact = [{ device: 'keyboard', code: 'KeyF' }];
    const serialized = serializeBindings(custom);
    expect(serialized.version).toBe(BINDINGS_SCHEMA_VERSION);
    const parsed = parseBindings(JSON.parse(JSON.stringify(serialized)));
    expect(parsed).toEqual(custom);
  });

  it('serializing copies the map instead of aliasing it', () => {
    const custom = cloneBindings(DEFAULT_BINDINGS);
    const serialized = serializeBindings(custom);
    custom.interact.push({ device: 'keyboard', code: 'KeyF' });
    expect(serialized.bindings['interact']).toEqual(DEFAULT_BINDINGS.interact);
  });

  it('returns defaults for garbage input', () => {
    for (const junk of [undefined, null, 42, 'bindings', [], { version: 'x' }]) {
      expect(parseBindings(junk)).toEqual(DEFAULT_BINDINGS);
    }
  });

  it('accepts a bare record without the envelope', () => {
    const parsed = parseBindings({ interact: [{ device: 'keyboard', code: 'KeyF' }] });
    expect(parsed.interact).toEqual([{ device: 'keyboard', code: 'KeyF' }]);
    expect(parsed['move.forward']).toEqual(DEFAULT_BINDINGS['move.forward']);
  });

  it('falls back per action, drops bad entries and ignores unknown actions', () => {
    const parsed = parseBindings({
      version: BINDINGS_SCHEMA_VERSION,
      bindings: {
        'move.forward': 'KeyW',
        'move.back': [{ device: 'keyboard', code: 'KeyX' }, { device: 'laser', code: 'Pew' }, 7],
        'move.left': [],
        'fly.up': [{ device: 'keyboard', code: 'Space' }],
      },
    });
    expect(parsed['move.forward']).toEqual(DEFAULT_BINDINGS['move.forward']);
    expect(parsed['move.back']).toEqual([{ device: 'keyboard', code: 'KeyX' }]);
    expect(parsed['move.left']).toEqual([]);
    expect(Object.keys(parsed).sort()).toEqual([...ACTION_IDS].sort());
    expect('fly.up' in parsed).toBe(false);
  });

  it('never returns references into the input or the defaults', () => {
    const input: Binding[] = [{ device: 'keyboard', code: 'KeyF' }];
    const parsed = parseBindings({ interact: input });
    expect(parsed.interact[0]).not.toBe(input[0]);
    expect(parsed['move.forward']).not.toBe(DEFAULT_BINDINGS['move.forward']);
  });
});

describe('bindingsEqual', () => {
  it('treats a missing scale as 1', () => {
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'keyboard', code: 'KeyW', scale: 1 })).toBe(true);
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'keyboard', code: 'KeyW', scale: -1 })).toBe(false);
    expect(bindingsEqual({ device: 'keyboard', code: 'KeyW' }, { device: 'mouse', code: 'MouseX' })).toBe(false);
  });
});

describe('withBindingSign / bindingSign', () => {
  it('keeps a negative slot negative when a key replaces it (Steer left stays left)', () => {
    const old = DEFAULT_BINDINGS['vehicle.steer'][0];
    expect(old).toEqual({ device: 'keyboard', code: 'KeyA', scale: -1 });
    const sign = bindingSign(old);
    expect(sign).toBe(-1);
    expect(withBindingSign({ device: 'keyboard', code: 'KeyJ' }, sign, 'vehicle.steer')).toEqual({
      device: 'keyboard',
      code: 'KeyJ',
      scale: -1,
    });
    expect(withBindingSign({ device: 'gamepad', code: 'GamepadButton4' }, sign, 'vehicle.steer')).toEqual({
      device: 'gamepad',
      code: 'GamepadButton4',
      scale: -1,
    });
  });

  it('leaves positive slots as captured', () => {
    expect(bindingSign(undefined)).toBe(1);
    expect(bindingSign({ device: 'keyboard', code: 'KeyD' })).toBe(1);
    expect(withBindingSign({ device: 'keyboard', code: 'KeyK' }, 1, 'vehicle.steer')).toEqual({ device: 'keyboard', code: 'KeyK' });
  });

  it('gives a stick captured for a two-way axis the slot sign, not the push direction', () => {
    const up = { device: 'gamepad', code: 'GamepadAxis3', scale: -1 } as const;
    // Pushing the stick up into the default (positive) Look vertical slot must not invert look.
    expect(withBindingSign(up, bindingSign(DEFAULT_BINDINGS['look.y'][1]), 'look.y')).toEqual({ device: 'gamepad', code: 'GamepadAxis3' });
    // Pushing left into a negative slot inverts it, whichever way the stick went.
    const left = { device: 'gamepad', code: 'GamepadAxis2', scale: -1 } as const;
    expect(withBindingSign(left, -1, 'look.x')).toEqual({ device: 'gamepad', code: 'GamepadAxis2', scale: -1 });
    expect(withBindingSign({ ...left, scale: 1 }, -1, 'vehicle.steer')).toEqual({ device: 'gamepad', code: 'GamepadAxis2', scale: -1 });
  });

  it('keeps the push direction of a stick captured for a button or one-way axis', () => {
    const down = { device: 'gamepad', code: 'GamepadAxis1', scale: -1 } as const;
    expect(withBindingSign(down, 1, 'move.forward')).toEqual(down);
    expect(withBindingSign(down, -1, 'vehicle.accelerate')).toEqual(down);
  });

  it('never makes a button action negative when a key replaces a negative pad-axis slot', () => {
    const slot = DEFAULT_BINDINGS['move.forward'][2];
    expect(bindingSign(slot)).toBe(-1);
    const map = cloneBindings(DEFAULT_BINDINGS);
    map['move.forward'][2] = withBindingSign({ device: 'keyboard', code: 'KeyI' }, bindingSign(slot), 'move.forward');
    expect(map['move.forward'][2]).toEqual({ device: 'keyboard', code: 'KeyI' });
    const raw = { keys: new Set(['KeyW', 'KeyI']), mouseButtons: new Set<number>(), mouse: { x: 0, y: 0, wheel: 0 }, gamepadButtons: [], gamepadAxes: [] };
    expect(resolveActions(map, raw)['move.forward']).toBe(1);
  });
});

