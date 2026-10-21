/**
 * GamepadNav (design §7.4): D-pad / left stick -> arrow keys with repeat, A -> click or Enter, B -> Escape, LB / RB ->
 * Shift+Tab / Tab (plus our own focus move after an unconsumed Tab), only while a menu is open. Driven by a fake pad, a
 * fake target and a recording dispatch (no DOM).
 */
import { describe, expect, it } from 'vitest';
import {
  GamepadNav,
  PAD_AXIS,
  PAD_BUTTON,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  padRepeat,
  type GamepadNavTarget,
  type KeyDispatch,
  type PadSource,
} from '../../src/ui/gamepadNav';

class FakePad implements PadSource {
  readonly buttons = new Map<number, number>();
  readonly axes = new Map<number, number>();
  private readonly edge = new Set<number>();
  padButton(i: number): number {
    return this.buttons.get(i) ?? 0;
  }
  padAxis(i: number): number {
    return this.axes.get(i) ?? 0;
  }
  padPressed(i: number): boolean {
    return this.edge.has(i);
  }
  /** Holds button `i` (an edge on this frame only). */
  press(i: number): void {
    this.buttons.set(i, 1);
    this.edge.add(i);
  }
  release(i: number): void {
    this.buttons.set(i, 0);
  }
  /** End of frame: edges are one frame long. */
  endFrame(): void {
    this.edge.clear();
  }
}

interface Sent {
  type: 'keydown' | 'keyup';
  key: string;
  code: string;
  shift: boolean;
  target: unknown;
}

function setup(opts: { open?: boolean; consumed?: boolean; target?: unknown } = {}) {
  const pad = new FakePad();
  const sent: Sent[] = [];
  const moves: (1 | -1)[] = [];
  const state = { open: opts.open ?? true, consumed: opts.consumed ?? false, focus: (opts.target === undefined ? { name: 'focus' } : opts.target) as unknown };
  const target: GamepadNavTarget = {
    isMenuOpen: () => state.open,
    focusTarget: () => state.focus as EventTarget | null,
    moveFocus: (d) => {
      moves.push(d);
      return true;
    },
  };
  const dispatch: KeyDispatch = (to, type, key, code, shift) => {
    sent.push({ type, key, code, shift, target: to });
    return !state.consumed;
  };
  const nav = new GamepadNav(pad, target, dispatch);
  let t = 0;
  const frame = (dtMs = 16): void => {
    t += dtMs;
    nav.update(t);
    pad.endFrame();
  };
  return { pad, sent, moves, state, nav, frame, now: () => t };
}

const keys = (sent: readonly Sent[], type: 'keydown' | 'keyup' = 'keydown'): string[] => sent.filter((s) => s.type === type).map((s) => s.key);

describe('padRepeat', () => {
  it('fires at once for a direction that has not fired yet (negative last fire)', () => {
    expect(padRepeat(0, -1, 1000)).toBe(true);
    expect(padRepeat(0, Number.NEGATIVE_INFINITY, 0)).toBe(true);
  });

  it('waits for the initial delay, then repeats every interval', () => {
    expect(padRepeat(100, 0, 100)).toBe(false);
    expect(padRepeat(REPEAT_DELAY_MS - 1, 0, REPEAT_DELAY_MS - 1)).toBe(false);
    expect(padRepeat(REPEAT_DELAY_MS, 0, REPEAT_DELAY_MS)).toBe(true);
    expect(padRepeat(REPEAT_DELAY_MS + 50, REPEAT_DELAY_MS, REPEAT_DELAY_MS + 50)).toBe(false);
    expect(padRepeat(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS, REPEAT_DELAY_MS, REPEAT_DELAY_MS + REPEAT_INTERVAL_MS)).toBe(true);
  });

  it('uses 400 ms then 120 ms', () => {
    expect(REPEAT_DELAY_MS).toBe(400);
    expect(REPEAT_INTERVAL_MS).toBe(120);
  });

  it('is a function of the three numbers only (a fire exactly one interval ago repeats)', () => {
    expect(padRepeat(1000, 880, 1000)).toBe(true);
    expect(padRepeat(1000, 881, 1000)).toBe(false);
    expect(padRepeat(399, 0, 5000)).toBe(false); // held too briefly whatever the last fire
  });
});

describe('GamepadNav buttons', () => {
  it('maps the standard buttons', () => {
    expect(PAD_BUTTON).toEqual({ a: 0, b: 1, lb: 4, rb: 5, up: 12, down: 13, left: 14, right: 15 });
    expect(PAD_AXIS).toEqual({ x: 0, y: 1 });
  });

  it('does nothing while no menu is open', () => {
    const { pad, sent, moves, frame } = setup({ open: false });
    pad.press(PAD_BUTTON.down);
    pad.press(PAD_BUTTON.a);
    pad.press(PAD_BUTTON.b);
    pad.press(PAD_BUTTON.rb);
    frame();
    frame(500);
    expect(sent).toEqual([]);
    expect(moves).toEqual([]);
  });

  it('D-pad sends the arrow keys, keydown then keyup on the same target', () => {
    for (const [button, key] of [
      [PAD_BUTTON.up, 'ArrowUp'],
      [PAD_BUTTON.down, 'ArrowDown'],
      [PAD_BUTTON.left, 'ArrowLeft'],
      [PAD_BUTTON.right, 'ArrowRight'],
    ] as const) {
      const { pad, sent, frame, state } = setup();
      pad.press(button);
      frame();
      expect(sent.map((s) => `${s.type}:${s.key}`), key).toEqual([`keydown:${key}`, `keyup:${key}`]);
      expect(sent.every((s) => s.target === state.focus && s.code === key && !s.shift)).toBe(true);
    }
  });

  it('an arrow nobody consumed moves focus (down / right forward, up / left back); a consumed one does not', () => {
    for (const [button, dir] of [
      [PAD_BUTTON.down, 1],
      [PAD_BUTTON.right, 1],
      [PAD_BUTTON.up, -1],
      [PAD_BUTTON.left, -1],
    ] as const) {
      const free = setup({ consumed: false });
      free.pad.press(button);
      free.frame();
      expect(free.moves, String(button)).toEqual([dir]);
      const taken = setup({ consumed: true });
      taken.pad.press(button);
      taken.frame();
      expect(taken.moves).toEqual([]);
      expect(taken.sent).toHaveLength(2);
    }
  });

  it('B sends Escape (and never moves focus)', () => {
    const { pad, sent, moves, frame } = setup();
    pad.press(PAD_BUTTON.b);
    frame();
    expect(sent.map((s) => `${s.type}:${s.key}`)).toEqual(['keydown:Escape', 'keyup:Escape']);
    expect(moves).toEqual([]);
    frame();
    expect(sent).toHaveLength(2); // an edge, not a level
  });

  it('RB sends Tab and LB Shift+Tab, then moves focus itself when nothing consumed the key', () => {
    const rb = setup();
    rb.pad.press(PAD_BUTTON.rb);
    rb.frame();
    expect(rb.sent.map((s) => [s.type, s.key, s.shift])).toEqual([
      ['keydown', 'Tab', false],
      ['keyup', 'Tab', false],
    ]);
    expect(rb.moves).toEqual([1]);
    const lb = setup();
    lb.pad.press(PAD_BUTTON.lb);
    lb.frame();
    expect(lb.sent.map((s) => [s.type, s.key, s.shift])).toEqual([
      ['keydown', 'Tab', true],
      ['keyup', 'Tab', true],
    ]);
    expect(lb.moves).toEqual([-1]);
  });

  it('a consumed Tab (a menu switching its tabs) does not move focus', () => {
    const { pad, moves, frame } = setup({ consumed: true });
    pad.press(PAD_BUTTON.rb);
    pad.press(PAD_BUTTON.lb);
    frame();
    expect(moves).toEqual([]);
  });

  it('A clicks a focused button, checkbox or radio, a link or a role=button; else it sends Enter', () => {
    const clicks: string[] = [];
    const clickable = (name: string, extra: Record<string, unknown> = {}): unknown => ({ tagName: 'BUTTON', click: () => clicks.push(name), ...extra });
    const cases: [string, unknown][] = [
      ['button', clickable('button')],
      ['link', clickable('link', { tagName: 'A' })],
      ['checkbox', clickable('checkbox', { tagName: 'INPUT', type: 'checkbox' })],
      ['radio', clickable('radio', { tagName: 'INPUT', type: 'radio' })],
      ['role', clickable('role', { tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'button' : null) })],
    ];
    for (const [name, focus] of cases) {
      const { pad, sent, frame } = setup({ target: focus });
      pad.press(PAD_BUTTON.a);
      frame();
      expect(clicks, name).toEqual([name]);
      expect(sent, name).toEqual([]);
      clicks.length = 0;
    }
    for (const [name, focus] of [
      ['div', { tagName: 'DIV', click: () => clicks.push('x') }],
      ['text input', { tagName: 'INPUT', type: 'text', click: () => clicks.push('x') }],
      ['body without click', { tagName: 'BODY' }],
      ['plain', { name: 'x' }],
    ] as const) {
      const { pad, sent, frame } = setup({ target: focus });
      pad.press(PAD_BUTTON.a);
      frame();
      expect(sent.map((s) => `${s.type}:${s.key}`), name).toEqual(['keydown:Enter', 'keyup:Enter']);
      expect(clicks, name).toEqual([]);
    }
  });

  it('does nothing when there is no key target', () => {
    const { pad, sent, moves, frame } = setup({ target: null });
    pad.press(PAD_BUTTON.a);
    pad.press(PAD_BUTTON.b);
    pad.press(PAD_BUTTON.down);
    frame();
    expect(sent).toEqual([]);
    expect(moves).toEqual([]);
  });
});

describe('GamepadNav repeat and stick', () => {
  it('fires once on the press, waits 400 ms, then repeats every 120 ms while held', () => {
    const { pad, sent, frame, now } = setup();
    pad.press(PAD_BUTTON.down);
    frame(); // t = 16: the press
    expect(keys(sent)).toEqual(['ArrowDown']);
    const pressedAt = now();
    while (now() - pressedAt < REPEAT_DELAY_MS - 20) frame(); // still waiting
    expect(keys(sent)).toHaveLength(1);
    frame(32); // crosses the delay
    expect(keys(sent)).toHaveLength(2);
    const firstRepeat = now();
    while (now() - firstRepeat < REPEAT_INTERVAL_MS - 20) frame();
    expect(keys(sent)).toHaveLength(2);
    frame(32);
    expect(keys(sent)).toHaveLength(3);
  });

  it('releasing and pressing again fires at once; two directions repeat independently', () => {
    const { pad, sent, frame } = setup();
    pad.press(PAD_BUTTON.down);
    frame();
    pad.release(PAD_BUTTON.down);
    frame();
    pad.press(PAD_BUTTON.down);
    pad.press(PAD_BUTTON.right);
    frame();
    expect(keys(sent)).toEqual(['ArrowDown', 'ArrowDown', 'ArrowRight']);
  });

  it('the left stick past 0.5 acts like the D-pad, on both axes and both signs', () => {
    for (const [axis, value, key] of [
      [PAD_AXIS.x, 0.9, 'ArrowRight'],
      [PAD_AXIS.x, -0.9, 'ArrowLeft'],
      [PAD_AXIS.y, 0.9, 'ArrowDown'],
      [PAD_AXIS.y, -0.9, 'ArrowUp'],
    ] as const) {
      const { pad, sent, frame } = setup();
      pad.axes.set(axis, value);
      frame();
      expect(keys(sent), `${String(axis)} ${String(value)}`).toEqual([key]);
    }
  });

  it('a stick at or below 0.5 is ignored; the stick repeats like a button', () => {
    const { pad, sent, frame } = setup();
    pad.axes.set(PAD_AXIS.y, 0.5);
    frame();
    pad.axes.set(PAD_AXIS.y, 0.2);
    frame();
    expect(sent).toEqual([]);
    pad.axes.set(PAD_AXIS.y, 1);
    frame();
    for (let i = 0; i < 45; i++) frame();
    expect(keys(sent).length).toBeGreaterThanOrEqual(3);
    expect(new Set(keys(sent))).toEqual(new Set(['ArrowDown']));
  });

  it('a direction held while the menu opens waits for the repeat delay instead of firing at once', () => {
    const { pad, sent, state, frame, now } = setup({ open: false });
    pad.press(PAD_BUTTON.down);
    frame();
    frame();
    state.open = true;
    pad.endFrame();
    frame();
    expect(sent).toEqual([]);
    const opened = now();
    while (now() - opened < REPEAT_DELAY_MS + 40) frame();
    expect(keys(sent).length).toBeGreaterThanOrEqual(1);
  });

  it('closing the menu stops everything', () => {
    const { pad, sent, state, frame } = setup();
    pad.press(PAD_BUTTON.down);
    frame();
    state.open = false;
    for (let i = 0; i < 60; i++) frame();
    expect(keys(sent)).toEqual(['ArrowDown']);
  });
});

describe('GamepadNav: a key that closes its own menu', () => {
  it('sends the keyup to a connected element when the target was removed by the keydown', () => {
    const detached = { name: 'removed', isConnected: true };
    const page = { name: 'page', isConnected: true };
    const s = setup({ target: detached });
    // The menu closes on the keydown: the element leaves the page and the focus is back on the page.
    const dispatch: KeyDispatch = (to, type, key, code, shift) => {
      s.sent.push({ type, key, code, shift, target: to });
      if (type === 'keydown') {
        detached.isConnected = false;
        s.state.focus = page;
      }
      return true;
    };
    const nav = new GamepadNav(
      s.pad,
      { isMenuOpen: () => true, focusTarget: () => s.state.focus as EventTarget | null, moveFocus: () => true },
      dispatch,
    );
    s.pad.press(PAD_BUTTON.b);
    nav.update(16);
    expect(s.sent.map((e) => `${e.type}:${e.key}:${(e.target as { name: string }).name}`)).toEqual(['keydown:Escape:removed', 'keyup:Escape:page']);
  });
});
