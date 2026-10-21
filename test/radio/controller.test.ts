import { describe, expect, it } from 'vitest';
import type { UnitRequest } from '../../src/cad/types';
import type { ActionId } from '../../src/input/actions';
import { HINTS, RadioController, type RadioControllerContext, type RadioLike, type SpeechInLike } from '../../src/radio/controller';
import { RadioMenu } from '../../src/radio/menu';

class FakeInput {
  readonly down = new Set<ActionId>();
  readonly pressed = new Set<ActionId>();
  readonly released = new Set<ActionId>();
  isDown(a: ActionId): boolean {
    return this.down.has(a);
  }
  wasPressed(a: ActionId): boolean {
    return this.pressed.has(a);
  }
  wasReleased(a: ActionId): boolean {
    return this.released.has(a);
  }
  /** One frame: `press` taps, then clears the edge sets. */
  tap(...actions: ActionId[]): void {
    for (const a of actions) this.pressed.add(a);
  }
  clear(): void {
    this.pressed.clear();
    this.released.clear();
  }
}

class FakeRadio implements RadioLike {
  readonly menu = new RadioMenu();
  readonly sent: { req: UnitRequest; via: string }[] = [];
  readonly calls: string[] = [];
  playerRequest(req: UnitRequest, via: 'radio' | 'voice' | 'key'): void {
    this.sent.push({ req, via });
  }
  emergencyButton(): void {
    this.calls.push('emergency');
  }
  stepChannel(dir: 1 | -1): void {
    this.calls.push(`channel:${dir}`);
  }
  toggleScan(): void {
    this.calls.push('scan');
  }
}

class FakeSpeechIn implements SpeechInLike {
  available = true;
  enabled = true;
  listening = false;
  starts = 0;
  private result: ((alts: readonly { transcript: string; confidence: number }[]) => void) | null = null;
  private error: ((code: string) => void) | null = null;
  start(): boolean {
    this.starts++;
    this.listening = true;
    return true;
  }
  stop(): void {
    this.listening = false;
  }
  onResult(fn: (alts: readonly { transcript: string; confidence: number }[]) => void): () => void {
    this.result = fn;
    return () => {
      this.result = null;
    };
  }
  onError(fn: (code: string) => void): () => void {
    this.error = fn;
    return () => {
      this.error = null;
    };
  }
  hear(...transcripts: string[]): void {
    this.result?.(transcripts.map((t, i) => ({ transcript: t, confidence: 1 - i * 0.1 })));
  }
  fail(code: string): void {
    this.error?.(code);
  }
}

const CTX: RadioControllerContext = {
  mode: 'tenCode',
  hasTarget: true,
  hasStop: false,
  pendingOffer: false,
  onCall: false,
  emergency: false,
  fallbackPlate: 'KDX 4410',
  fallbackVehicleId: 31,
};

function setup(speech: FakeSpeechIn | null = new FakeSpeechIn(), hasRadio?: () => boolean) {
  const input = new FakeInput();
  const radio = new FakeRadio();
  const ctl = new RadioController({ input, radio, speechIn: speech, ...(hasRadio ? { hasRadio } : {}) });
  const frame = (ctx: RadioControllerContext = CTX, dt = 1 / 60, active = true) => {
    const s = ctl.update(dt, active, ctx);
    input.clear();
    return s;
  };
  return { input, radio, ctl, frame, speech };
}

describe('RadioController', () => {
  it('menu key toggles, number keys pick, a request closes the menu', () => {
    const { input, radio, frame } = setup();
    expect(frame().menu).toBeNull();
    input.tap('radio.menu');
    const s = frame();
    expect(s.menu?.title).toBe('Radio');
    input.tap('radio.option1');
    expect(frame().menu?.title).toBe('Status');
    input.tap('radio.option1');
    expect(frame().menu).toBeNull();
    expect(radio.sent).toEqual([{ req: { kind: 'status', status: 'available' }, via: 'radio' }]);
  });

  it('menu key backs out of a submenu, then closes', () => {
    const { input, frame } = setup();
    input.tap('radio.menu');
    frame();
    input.tap('radio.option4');
    expect(frame().menu?.title).toBe('Backup');
    input.tap('radio.menu');
    expect(frame().menu?.title).toBe('Radio');
    input.tap('radio.menu');
    expect(frame().menu).toBeNull();
  });

  it('run plate from the menu uses the target plate', () => {
    const { input, radio, frame } = setup();
    input.tap('radio.menu');
    frame();
    input.tap('radio.option2');
    frame();
    expect(radio.sent).toEqual([{ req: { kind: 'runPlate', plate: 'KDX 4410', vehicleId: 31 }, via: 'radio' }]);
  });

  it('number keys do nothing while the menu is closed or controls are inactive', () => {
    const { input, radio, frame } = setup();
    input.tap('radio.option3');
    frame();
    input.tap('radio.menu');
    frame(CTX, 1 / 60, false);
    expect(radio.sent).toEqual([]);
    expect(radio.menu.isOpen).toBe(false);
  });

  it('push-to-talk starts and stops recognition; results become voice requests', () => {
    const { input, radio, frame, speech } = setup();
    const sin = speech as FakeSpeechIn;
    expect(frame().voice).toBe('ready');
    input.tap('radio.ptt');
    input.down.add('radio.ptt');
    expect(frame().voice).toBe('listening');
    expect(sin.starts).toBe(1);
    input.down.delete('radio.ptt');
    input.released.add('radio.ptt');
    frame();
    expect(sin.listening).toBe(false);
    sin.hear('blah blah', 'show me ten eight');
    frame();
    expect(radio.sent).toEqual([{ req: { kind: 'status', status: 'available' }, via: 'voice' }]);
    sin.hear('run plate');
    frame();
    expect(radio.sent[1]).toEqual({ req: { kind: 'runPlate', plate: 'KDX 4410', vehicleId: 31 }, via: 'voice' });
  });

  it('no match: "Say again" hint that expires', () => {
    const { frame, speech, radio } = setup();
    (speech as FakeSpeechIn).hear('pizza with extra cheese');
    expect(frame().hint).toBe('Say again');
    expect(radio.sent).toEqual([]);
    frame(CTX, 2);
    expect(frame(CTX, 1.5).hint).toBeNull();
    (speech as FakeSpeechIn).fail('no-match');
    const first = frame();
    expect(first.hint).toBe('Say again');
    // A second identical hint before the first expired is a new hint (the app flashes it again).
    const seq = first.hintSeq;
    frame(CTX, 2.6);
    (speech as FakeSpeechIn).fail('no-match');
    const again = frame();
    expect(again.hint).toBe('Say again');
    expect(again.hintSeq).toBe(seq + 1);
  });

  it('other recognition failures ("network") and a refused start give a "voice unavailable" hint', () => {
    const { frame, speech, input } = setup();
    const sin = speech as FakeSpeechIn;
    sin.fail('network');
    expect(frame().hint).toBe('Voice service unavailable');
    frame(CTX, 5);
    sin.fail('aborted');
    expect(frame().hint).toBeNull();
    sin.start = () => false;
    input.tap('radio.ptt');
    expect(frame().hint).toBe('Voice service unavailable');
  });

  it('voice state', () => {
    expect(setup(null).frame().voice).toBe('unavailable');
    const off = new FakeSpeechIn();
    off.enabled = false;
    const { input, frame } = setup(off);
    input.tap('radio.ptt');
    expect(frame().voice).toBe('off');
    expect(off.starts).toBe(0);
    const na = new FakeSpeechIn();
    na.available = false;
    expect(setup(na).frame().voice).toBe('unavailable');
  });

  it('transmits nothing without a radio in the loadout: requests and the emergency button say so', () => {
    const { input, radio, frame } = setup(new FakeSpeechIn(), () => false);
    input.tap('radio.menu');
    frame();
    input.tap('radio.option1');
    frame();
    input.tap('radio.option1');
    const s = frame();
    expect(radio.sent).toEqual([]);
    expect(s.hint).toBe(HINTS.noRadio);
    input.down.add('radio.emergency');
    frame(CTX, 1.5);
    expect(radio.calls).toEqual([]);
  });

  it('emergency fires once after a 1.2 s hold, with a charge meter', () => {
    const { input, radio, frame } = setup();
    input.down.add('radio.emergency');
    let s = frame(CTX, 0.6);
    expect(s.emergencyCharge).toBeCloseTo(0.5, 6);
    expect(radio.calls).toEqual([]);
    expect(frame(CTX, 0.5).emergencyCharge).toBeLessThan(1);
    expect(radio.calls).toEqual([]);
    s = frame(CTX, 0.2);
    expect(s.emergencyCharge).toBe(1);
    expect(radio.calls).toEqual(['emergency']);
    frame(CTX, 2);
    expect(radio.calls).toEqual(['emergency']);
    input.down.delete('radio.emergency');
    expect(frame().emergencyCharge).toBe(0);
    // a short tap does nothing
    input.down.add('radio.emergency');
    frame(CTX, 0.5);
    input.down.delete('radio.emergency');
    frame();
    input.down.add('radio.emergency');
    frame(CTX, 0.8);
    expect(radio.calls).toEqual(['emergency']);
  });

  it('channel keys and scan', () => {
    const { input, radio, frame } = setup();
    input.tap('radio.channelNext');
    frame();
    input.tap('radio.channelPrev', 'radio.scan');
    frame();
    expect(radio.calls).toEqual(['channel:1', 'channel:-1', 'scan']);
  });

  it('returns the same state object every frame', () => {
    const { frame } = setup();
    expect(frame()).toBe(frame());
  });
});
