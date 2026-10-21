/**
 * Radio menu cursor (design §7.5): `RadioControllerState.cursor` is -1 while the menu is closed, 0 (the first enabled option)
 * when it opens or changes level / page; `radio.cursorNext` / `radio.cursorPrev` move over the enabled options of the
 * current view (wrapping), `radio.cursorSelect` presses the option under the cursor exactly like its digit key, and a digit key
 * moves the cursor onto the pressed option.
 */
import { describe, expect, it } from 'vitest';
import type { UnitRequest } from '../../src/cad/types';
import type { ActionId } from '../../src/input/actions';
import { RadioController, type RadioControllerContext, type RadioLike } from '../../src/radio/controller';
import { RadioMenu } from '../../src/radio/menu';

class FakeInput {
  readonly pressed = new Set<ActionId>();
  isDown(): boolean {
    return false;
  }
  wasPressed(a: ActionId): boolean {
    return this.pressed.has(a);
  }
  wasReleased(): boolean {
    return false;
  }
  tap(...actions: ActionId[]): void {
    for (const a of actions) this.pressed.add(a);
  }
  clear(): void {
    this.pressed.clear();
  }
}

class FakeRadio implements RadioLike {
  readonly menu = new RadioMenu();
  readonly sent: { req: UnitRequest; via: string }[] = [];
  playerRequest(req: UnitRequest, via: 'radio' | 'voice' | 'key'): void {
    this.sent.push({ req, via });
  }
  emergencyButton(): void {
    /* not used here */
  }
  stepChannel(): void {
    /* not used here */
  }
  toggleScan(): void {
    /* not used here */
  }
}

const BASE: RadioControllerContext = {
  mode: 'tenCode',
  hasTarget: false,
  hasStop: false,
  pendingOffer: false,
  onCall: false,
  emergency: false,
  fallbackPlate: 'KDX 4410',
  fallbackVehicleId: 31,
};

function setup(ctx: RadioControllerContext = BASE) {
  const input = new FakeInput();
  const radio = new FakeRadio();
  const ctl = new RadioController({ input, radio, speechIn: null });
  let context = ctx;
  const frame = (...actions: ActionId[]) => {
    input.tap(...actions);
    const s = ctl.update(1 / 60, true, context);
    input.clear();
    return s;
  };
  return { input, radio, ctl, frame, setContext: (c: RadioControllerContext) => (context = c) };
}

/** The root menu of the test context: 1 Status, 2 Run plate (off), 3 Location, 4 Request, 5 Code 4, 6 Traffic stop (off), 7 and 8 (off), 9 Say again. */
const ENABLED_ROOT = [0, 2, 3, 4, 8];

describe('radio cursor', () => {
  it('is -1 while the menu is closed and 0 when it opens', () => {
    const { frame } = setup();
    expect(frame().cursor).toBe(-1);
    const s = frame('radio.menu');
    expect(s.menu?.title).toBe('Radio');
    expect(s.cursor).toBe(0);
    expect(frame().cursor).toBe(0);
  });

  it('cursorNext skips disabled options and wraps; cursorPrev goes back and wraps the other way', () => {
    const { frame } = setup();
    frame('radio.menu');
    const forward: number[] = [];
    for (let i = 0; i < ENABLED_ROOT.length; i++) forward.push(frame('radio.cursorNext').cursor);
    expect(forward).toEqual([2, 3, 4, 8, 0]);
    const backward: number[] = [];
    for (let i = 0; i < ENABLED_ROOT.length; i++) backward.push(frame('radio.cursorPrev').cursor);
    expect(backward).toEqual([8, 4, 3, 2, 0]);
  });

  it('enabled options follow the context (a target and an offer enable more rows)', () => {
    const { frame, setContext } = setup();
    setContext({ ...BASE, hasTarget: true, hasStop: true, pendingOffer: true });
    frame('radio.menu');
    const seen: number[] = [];
    for (let i = 0; i < 9; i++) seen.push(frame('radio.cursorNext').cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 0]);
  });

  it('cursorSelect sends the same request as the digit key of that option', () => {
    const a = setup();
    a.frame('radio.menu');
    a.frame('radio.cursorNext'); // 2: Location
    a.frame('radio.cursorSelect');
    const b = setup();
    b.frame('radio.menu');
    b.frame('radio.option3'); // Location
    expect(a.radio.sent).toEqual(b.radio.sent);
    expect(a.radio.sent).toEqual([{ req: { kind: 'location' }, via: 'radio' }]);
    expect(a.radio.menu.isOpen).toBe(false);
  });

  it('selecting a submenu entry opens it and puts the cursor back on 0', () => {
    const { frame, radio } = setup();
    frame('radio.menu');
    const s = frame('radio.cursorSelect'); // option 1: Status >
    expect(s.menu?.title).toBe('Status');
    expect(s.cursor).toBe(0);
    frame('radio.cursorNext');
    frame('radio.cursorNext');
    expect(frame('radio.cursorNext').cursor).toBe(0); // only "available" and "busy" and "out of service" are enabled off call
    const picked = frame('radio.cursorSelect');
    expect(radio.sent).toEqual([{ req: { kind: 'status', status: 'available' }, via: 'radio' }]);
    expect(picked.menu).toBeNull();
    expect(picked.cursor).toBe(-1);
  });

  it('a digit key picks its option and sets the cursor to it; level changes reset the cursor to 0', () => {
    const { frame } = setup();
    frame('radio.menu');
    frame('radio.cursorNext');
    frame('radio.cursorNext');
    expect(frame().cursor).toBe(3);
    const s = frame('radio.option1'); // Status >
    expect(s.menu?.title).toBe('Status');
    expect(s.cursor).toBe(0);
    frame('radio.cursorNext');
    // the same digit keys keep working with a cursor present: option 4 is "busy"
    const closed = frame('radio.option4');
    expect(closed.menu).toBeNull();
    expect(closed.cursor).toBe(-1);
  });

  it('a digit on a disabled option does nothing and leaves the cursor where it was', () => {
    const { frame, radio } = setup();
    frame('radio.menu');
    frame('radio.cursorNext');
    const s = frame('radio.option2'); // Run plate: disabled without a target
    expect(s.cursor).toBe(2);
    expect(radio.sent).toEqual([]);
    expect(radio.menu.isOpen).toBe(true);
  });

  it('cursorSelect on an option that became disabled sends nothing', () => {
    const { frame, radio, setContext } = setup({ ...BASE, hasTarget: true });
    frame('radio.menu');
    frame('radio.cursorNext'); // Run plate (enabled with a target)
    setContext(BASE);
    const s = frame('radio.cursorSelect');
    expect(radio.sent).toEqual([]);
    expect(s.menu?.title).toBe('Radio');
  });

  it('closing the menu (the menu key, or an Escape-driven close) gives -1; reopening starts at 0 again', () => {
    const { frame } = setup();
    frame('radio.menu');
    frame('radio.cursorNext');
    expect(frame('radio.menu').cursor).toBe(-1);
    expect(frame('radio.menu').cursor).toBe(0);
  });

  it('the menu key backs out of a submenu to the root with the cursor at 0', () => {
    const { frame } = setup();
    frame('radio.menu');
    frame('radio.option1');
    frame('radio.cursorNext');
    const s = frame('radio.menu');
    expect(s.menu?.title).toBe('Radio');
    expect(s.cursor).toBe(0);
  });

  it('cursor keys do nothing while the menu is closed or the controller is inactive', () => {
    const { frame, radio, ctl } = setup();
    expect(frame('radio.cursorNext', 'radio.cursorSelect').cursor).toBe(-1);
    expect(radio.sent).toEqual([]);
    expect(radio.menu.isOpen).toBe(false);
    frame('radio.menu');
    const inactive = ctl.update(1 / 60, false, BASE);
    expect(inactive.cursor).toBe(0);
  });

  it('a digit takes precedence over a cursor key pressed in the same frame', () => {
    const { frame, radio } = setup();
    frame('radio.menu');
    frame('radio.option3', 'radio.cursorNext');
    expect(radio.sent).toEqual([{ req: { kind: 'location' }, via: 'radio' }]);
  });

  it('reuses one state object (allocation-free per frame)', () => {
    const { frame } = setup();
    const a = frame('radio.menu');
    const b = frame('radio.cursorNext');
    expect(a).toBe(b);
  });
});
