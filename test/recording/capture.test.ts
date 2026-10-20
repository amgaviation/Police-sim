import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAM_BITS, RECORDING, SnapshotScheduler } from '../../src/recording';

const { body, muted, dash } = CAM_BITS;

describe('SnapshotScheduler', () => {
  it('is never due while the cameras are off or the bodycam is muted', () => {
    const s = new SnapshotScheduler();
    expect(s.due(100, 0, 'C-1')).toBe(false);
    expect(s.due(100, muted, 'C-1')).toBe(false);
    expect(s.due(100, body | muted, 'C-1')).toBe(false);
  });

  it('is due on the first recording frame, then every intervalS sim seconds', () => {
    const s = new SnapshotScheduler();
    expect(s.due(10, body, 'C-1')).toBe(true);
    s.taken(10, 'C-1');
    expect(s.due(10, body, 'C-1')).toBe(false);
    expect(s.due(10 + RECORDING.intervalS - 0.01, body, 'C-1')).toBe(false);
    expect(s.due(10 + RECORDING.intervalS, body, 'C-1')).toBe(true);
    s.taken(13.2, 'C-1');
    expect(s.due(15, body, 'C-1')).toBe(false);
    expect(s.due(16.2, body, 'C-1')).toBe(true);
  });

  it('records on the dash bit alone and while muted if the dashcam is on', () => {
    const s = new SnapshotScheduler();
    expect(s.due(0, dash, 'C-1')).toBe(true);
    s.taken(0, 'C-1');
    expect(s.due(3, dash, 'C-1')).toBe(true);
    expect(s.due(3, dash | body | muted, 'C-1')).toBe(true);
  });

  it('honours a custom interval', () => {
    const s = new SnapshotScheduler({ ...RECORDING, intervalS: 10 });
    s.taken(0, 'C-1');
    expect(s.due(9.9, body, 'C-1')).toBe(false);
    expect(s.due(10, body, 'C-1')).toBe(true);
  });

  it('immediate() makes the next recording frame due, once', () => {
    const s = new SnapshotScheduler();
    s.taken(5, 'C-1');
    expect(s.due(5.5, body, 'C-1')).toBe(false);
    s.immediate();
    expect(s.due(5.5, body, 'C-1')).toBe(true);
    expect(s.due(5.6, body, 'C-1')).toBe(true); // still pending until taken
    s.taken(5.6, 'C-1');
    expect(s.due(5.7, body, 'C-1')).toBe(false);
  });

  it('drops an immediate request made while the cameras are off', () => {
    const s = new SnapshotScheduler();
    s.taken(5, 'C-1');
    s.immediate();
    expect(s.due(5.5, 0, 'C-1')).toBe(false);
    expect(s.due(5.6, body, 'C-1')).toBe(false);
  });

  it('is due at the first frame of another incident and after sim time goes backwards', () => {
    const s = new SnapshotScheduler();
    s.taken(50, 'C-1');
    expect(s.due(50.5, body, 'C-2')).toBe(true);
    s.taken(50.5, 'C-2');
    expect(s.due(51, body, 'C-2')).toBe(false);
    expect(s.due(10, body, 'C-2')).toBe(true); // a save with an earlier clock was loaded
  });
});

describe('captureSnapshot', () => {
  // The module keeps one scratch canvas; each test starts with a fresh module.
  let captureSnapshot: typeof import('../../src/recording/capture').captureSnapshot;
  beforeEach(async () => {
    vi.resetModules();
    ({ captureSnapshot } = await import('../../src/recording/capture'));
  });
  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('resolves null without a DOM', async () => {
    expect(await captureSnapshot({ width: 100, height: 100 } as HTMLCanvasElement, 160, 90, 0.5)).toBeNull();
  });

  it('centre-crops to 16:9 synchronously and encodes a JPEG', async () => {
    const draws: number[][] = [];
    const blob = new Blob(['jpeg']);
    let qualityUsed = -1;
    let created = 0;
    const target = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...a: number[]) => draws.push(a.slice(1)) }),
      toBlob: (cb: (b: Blob | null) => void, type: string, q: number) => {
        expect(type).toBe('image/jpeg');
        qualityUsed = q;
        cb(blob);
      },
    };
    (globalThis as { document?: unknown }).document = { createElement: () => { created++; return target; } };
    const promise = captureSnapshot({ width: 1000, height: 1000 } as HTMLCanvasElement, 160, 90, 0.5);
    expect(draws).toHaveLength(1); // drawn before any await
    expect(await promise).toBe(blob);
    expect(qualityUsed).toBe(0.5);
    expect(target.width).toBe(160);
    expect(target.height).toBe(90);
    const [sx, sy, sw, sh, dx, dy, dw, dh] = draws[0] as number[];
    expect(sw).toBe(1000);
    expect(sh).toBeCloseTo(562.5);
    expect(sx).toBe(0);
    expect(sy).toBeCloseTo(218.75);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 160, 90]);
    // A wide canvas is cropped horizontally; the scratch canvas is reused.
    draws.length = 0;
    await captureSnapshot({ width: 1920, height: 540 } as HTMLCanvasElement, 160, 90, 0.5);
    const [sx2, sy2, sw2, sh2] = draws[0] as number[];
    expect(sh2).toBeCloseTo(540);
    expect(sw2).toBeCloseTo(960);
    expect(sx2).toBeCloseTo(480);
    expect(sy2).toBeCloseTo(0);
    expect(created).toBeLessThanOrEqual(1);
  });

  it('resolves null when drawing or encoding fails or the canvas is empty', async () => {
    const failing = { width: 0, height: 0, getContext: () => ({ drawImage: () => { throw new Error('tainted'); } }), toBlob: () => undefined };
    (globalThis as { document?: unknown }).document = { createElement: () => failing };
    expect(await captureSnapshot({ width: 100, height: 100 } as HTMLCanvasElement, 160, 90, 0.5)).toBeNull();
    expect(await captureSnapshot({ width: 0, height: 0 } as HTMLCanvasElement, 160, 90, 0.5)).toBeNull();
  });
});
