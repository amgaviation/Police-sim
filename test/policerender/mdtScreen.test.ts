import { describe, expect, it } from 'vitest';
import {
  MDT_SCREEN_MIN_INTERVAL_MS,
  MdtScreen,
  screenKey,
  screenPaintDue,
  type MdtScreenModel,
} from '../../src/render/police/mdtScreen';
import { fakeCanvas } from './helpers';

function model(over: Partial<MdtScreenModel> = {}): MdtScreenModel {
  return {
    callsign: '12',
    status: '10-8 AVAILABLE',
    clock: '14:05',
    call: { number: 'C-00042', priority: 2, nature: 'Traffic collision', address: '1200 Oak St', status: 'ENRT' },
    queue: [
      { priority: 1, nature: 'Alarm', address: '400 Elm Ave' },
      { priority: 3, nature: 'Noise complaint', address: '22 Pine St' },
    ],
    offer: null,
    alert: null,
    stop: null,
    ...over,
  };
}

describe('MdtScreen', () => {
  it('is a no-op headless: null canvas, paint false', () => {
    const screen = new MdtScreen();
    expect(screen.canvas).toBeNull();
    expect(screen.width).toBe(512);
    expect(screen.height).toBe(320);
    expect(screen.paint(model(), 0)).toBe(false);
    expect(new MdtScreen(256, 160, () => null).canvas).toBeNull();
  });

  it('paints when the model changed, at most every 500 ms', () => {
    const { canvas, ctx } = fakeCanvas(512, 320);
    const screen = new MdtScreen(512, 320, () => canvas);
    expect(screen.canvas).toBe(canvas);
    expect(screen.paint(model(), 1000)).toBe(true);
    expect(ctx.texts).toContain('UNIT 12');
    expect(ctx.texts).toContain('C-00042');
    expect(ctx.texts).toContain('TRAFFIC COLLISION');
    expect(ctx.texts.some((t) => t.includes('Alarm - 400 Elm Ave'))).toBe(true);

    expect(screen.paint(model(), 2000)).toBe(false); // unchanged
    const changed = model({ offer: 'C-00043 P1 Alarm' });
    expect(screen.paint(changed, 2100)).toBe(true);
    expect(ctx.texts.some((t) => t.startsWith('OFFER C-00043'))).toBe(true);
    const throttled = model({ alert: 'Status check' });
    expect(screen.paint(throttled, 2100 + MDT_SCREEN_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(screen.paint(throttled, 2100 + MDT_SCREEN_MIN_INTERVAL_MS)).toBe(true);
  });

  it('paints the no-call state and the stop line', () => {
    const { canvas, ctx } = fakeCanvas(512, 320);
    const screen = new MdtScreen(512, 320, () => canvas);
    screen.paint(model({ call: null, queue: [], stop: 'ABC123 2019 black Sedan' }), 0);
    expect(ctx.texts).toContain('NO ACTIVE CALL');
    expect(ctx.texts).toContain('PENDING (0)');
    expect(ctx.texts).toContain('STOP ABC123 2019 black Sedan');
  });
});

describe('screenKey', () => {
  it('is equal for equal content and differs when any shown field changes', () => {
    const base = screenKey(model());
    expect(screenKey(model())).toBe(base);
    const variants: Partial<MdtScreenModel>[] = [
      { callsign: '13' },
      { status: '10-6 BUSY' },
      { clock: '14:06' },
      { call: null },
      { call: { number: 'C-00042', priority: 1, nature: 'Traffic collision', address: '1200 Oak St', status: 'ENRT' } },
      { call: { number: 'C-00042', priority: 2, nature: 'Traffic collision', address: '1200 Oak St', status: 'ONSC' } },
      { queue: [] },
      { queue: [{ priority: 1, nature: 'Alarm', address: '402 Elm Ave' }] },
      { offer: 'x' },
      { alert: 'x' },
      { stop: 'x' },
      { offer: '' },
    ];
    const keys = variants.map((v) => screenKey(model(v)));
    for (const k of keys) expect(k).not.toBe(base);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ignores queue entries beyond the four shown', () => {
    const q = (n: number) => Array.from({ length: n }, (_, i) => ({ priority: 2, nature: `N${i}`, address: `A${i}` }));
    expect(screenKey(model({ queue: q(4) }))).toBe(screenKey(model({ queue: q(4).concat([{ priority: 1, nature: 'x', address: 'y' }]) })));
    expect(screenKey(model({ queue: q(3) }))).not.toBe(screenKey(model({ queue: q(4) })));
  });
});

describe('screenPaintDue', () => {
  it('allows the first paint, then one per interval (2 Hz)', () => {
    expect(screenPaintDue(0, -Infinity)).toBe(true);
    expect(screenPaintDue(1000, 800)).toBe(false);
    expect(screenPaintDue(1300, 800)).toBe(true);
    expect(screenPaintDue(1000, 1000, 250)).toBe(false);
    expect(screenPaintDue(1250, 1000, 250)).toBe(true);
    expect(screenPaintDue(10, 5000)).toBe(true); // clock went backwards (new session)
  });
});
