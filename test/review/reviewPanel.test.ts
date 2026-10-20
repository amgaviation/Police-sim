import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceReviewPanel } from '../../src/ui/review';
import { FakeEl, installFakeDocument } from './fakeDom';
import { asUi, ev, fakeUi, flush, key, makeFooter, makeLiveSource, makeSource, snap } from './helpers';

const fakeEl = (e: HTMLElement): FakeEl => e as unknown as FakeEl;

describe('EvidenceReviewPanel (headless)', () => {
  it('constructs without a document or a ui and has the menu contract', () => {
    const p = new EvidenceReviewPanel(null);
    expect(p.id).toBe('review');
    expect(p.pausesGame).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(p.time).toBe(0);
    const q = new EvidenceReviewPanel(asUi(fakeUi()));
    expect(q.isOpen).toBe(false);
    expect(q.element).toBeDefined();
  });

  it('opens, closes and is inert when closed', () => {
    const ui = fakeUi();
    const p = new EvidenceReviewPanel(asUi(ui));
    p.update(0);
    expect(p.onKeyDown(key('ArrowRight'))).toBe(false);
    p.close();
    p.open(makeSource(), makeFooter());
    expect(p.isOpen).toBe(true);
    expect(ui.menus).toEqual([p]);
    expect(p.time).toBe(0);
    p.close();
    expect(p.isOpen).toBe(false);
    expect(ui.menus).toEqual([]);
    expect(p.onKeyDown(key('ArrowRight'))).toBe(false);
    p.dispose();
  });

  it('works without a ui', () => {
    const p = new EvidenceReviewPanel(null);
    p.open(makeSource());
    expect(p.isOpen).toBe(true);
    expect(p.onKeyDown(key('ArrowRight', {}))).toBe(true);
    expect(p.time).toBe(1);
    p.close();
    expect(p.isOpen).toBe(false);
  });

  it('seeks with the keys and reports the focused event', () => {
    const p = new EvidenceReviewPanel(null);
    p.open(makeSource());
    expect(p.focusIndex).toBe(0);
    p.onKeyDown(key('ArrowRight', { shiftKey: true }));
    expect(p.time).toBe(10);
    expect(p.focusIndex).toBe(1);
    p.onKeyDown(key('ArrowDown'));
    expect(p.time).toBe(20);
    expect(p.focusIndex).toBe(2);
    p.onKeyDown(key('ArrowDown'));
    expect(p.focusIndex).toBe(3);
    p.onKeyDown(key('End'));
    expect(p.time).toBe(60);
    p.onKeyDown(key('Home'));
    expect(p.time).toBe(0);
    expect(p.onKeyDown(key('q'))).toBe(false);
    expect(p.onKeyDown(key('ArrowRight', {}) )).toBe(true);
    expect(p.onKeyDown({ key: 'ArrowRight', ctrlKey: true, repeat: false, shiftKey: false } as KeyboardEvent)).toBe(false);
  });

  it('plays 1 sim second per 250 ms real, pauses, and stops at the end', () => {
    const p = new EvidenceReviewPanel(null);
    p.open(makeSource());
    p.update(1000); // first frame only records the clock
    expect(p.time).toBe(0);
    p.onKeyDown(key(' '));
    expect(p.isPlaying).toBe(true);
    p.update(1250);
    expect(p.time).toBeCloseTo(1, 6);
    p.update(1500);
    expect(p.time).toBeCloseTo(2, 6);
    p.update(1750);
    p.onKeyDown(key(' '));
    expect(p.isPlaying).toBe(false);
    const t = p.time;
    p.update(5000);
    expect(p.time).toBe(t);
    // Playing resumes without a jump over the paused time.
    p.onKeyDown(key(' '));
    p.update(5250);
    expect(p.time).toBeCloseTo(t + 1, 6);
    // A long frame (hidden tab) is capped.
    p.update(60000);
    expect(p.time).toBeCloseTo(t + 3, 6);
    // Run to the end.
    for (let ms = 60250; p.isPlaying; ms += 250) p.update(ms);
    expect(p.time).toBe(60);
    expect(p.focusIndex).toBe(4);
    // Space at the end restarts from the beginning.
    p.onKeyDown(key(' '));
    expect(p.time).toBe(0);
    expect(p.isPlaying).toBe(true);
  });

  it('ignores a held Space and a held digit', () => {
    const p = new EvidenceReviewPanel(null);
    const footer = makeFooter();
    p.open(makeSource(), footer);
    p.onKeyDown(key(' '));
    p.onKeyDown(key(' ', { repeat: true }));
    expect(p.isPlaying).toBe(true);
    p.onKeyDown(key('1'));
    p.onKeyDown(key('1', { repeat: true }));
    expect(footer.picks).toEqual([0]);
    p.onKeyDown(key('ArrowRight', { repeat: true }));
    expect(p.time).toBe(1);
  });

  it('maps digits to footer options and ignores out-of-range ones', () => {
    const p = new EvidenceReviewPanel(null);
    const footer = makeFooter();
    p.open(makeSource(), footer);
    expect(p.onKeyDown(key('2'))).toBe(true);
    expect(p.onKeyDown(key('5'))).toBe(true);
    expect(footer.picks).toEqual([1]);
    const bare = new EvidenceReviewPanel(null);
    bare.open(makeSource());
    expect(() => bare.onKeyDown(key('1'))).not.toThrow();
  });

  it('Escape closes, pops the ui and calls onClose; close() does not', () => {
    const ui = fakeUi();
    const p = new EvidenceReviewPanel(asUi(ui));
    const onClose = vi.fn();
    p.open(makeSource(), undefined, onClose);
    expect(p.onKeyDown(key('Escape'))).toBe(true);
    expect(p.isOpen).toBe(false);
    expect(ui.menus).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
    p.open(makeSource(), undefined, onClose);
    p.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats the ui popping it as a close', () => {
    const ui = fakeUi();
    const p = new EvidenceReviewPanel(asUi(ui));
    const onClose = vi.fn();
    p.open(makeSource(), undefined, onClose);
    ui.pop(p);
    expect(p.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requests an image only when the nearest snapshot index changes', async () => {
    const src = makeLiveSource();
    const p = new EvidenceReviewPanel(null);
    p.open(src);
    await flush();
    expect(src.imageCalls).toEqual([]); // before the first snapshot (3 s): no video
    p.onKeyDown(key('ArrowRight', { shiftKey: true })); // 10 s
    expect(src.imageCalls).toEqual(['s9']);
    p.onKeyDown(key('ArrowRight')); // 11 s: same snapshot
    p.update(0);
    expect(src.imageCalls).toEqual(['s9']);
    p.onKeyDown(key('ArrowRight', { shiftKey: true })); // 21 s
    expect(src.imageCalls).toEqual(['s9', 's21']);
    p.onKeyDown(key('End'));
    expect(src.imageCalls).toEqual(['s9', 's21', 's57']);
    p.onKeyDown(key('Home'));
    expect(src.imageCalls).toEqual(['s9', 's21', 's57']); // back to no video: nothing to load
    p.onKeyDown(key('Home'));
    expect(src.imageCalls).toHaveLength(3);
  });

  it('swaps the image during playback only at snapshot boundaries', async () => {
    const src = makeLiveSource();
    const p = new EvidenceReviewPanel(null);
    p.open(src);
    await flush();
    p.onKeyDown(key('ArrowDown')); // 10 s
    p.onKeyDown(key(' '));
    p.update(0);
    for (let ms = 16; ms <= 5200; ms += 16) p.update(ms);
    // 5 s of real time at 4x = ~20 sim s: 10 s -> ~30 s
    expect(p.time).toBeGreaterThan(29);
    expect(src.imageCalls.slice(0, 7)).toEqual(['s9', 's12', 's15', 's18', 's21', 's24', 's27']);
    expect(src.imageCalls.length).toBeGreaterThanOrEqual(7);
  });

  it('shows no video once the camera is muted: the last frame is not played as footage', async () => {
    const snaps = [3, 6, 9, 12, 15, 18, 33, 36].map(snap);
    const src = makeSource({
      events: [ev(1, 0, 1), ev(2, 20, 3), ev(3, 30, 1)],
      snapshots: () => Promise.resolve(snaps),
    });
    const p = new EvidenceReviewPanel(null);
    p.open(src);
    await flush();
    p.onKeyDown(key('End')); // 60 s: recording again but the last frame (36 s) is stale
    expect(src.imageCalls).toEqual([]);
    p.onKeyDown(key('Home'));
    for (let i = 0; i < 19; i++) p.onKeyDown(key('ArrowRight')); // 19 s
    expect(src.imageCalls.at(-1)).toBe('s18');
    const calls = src.imageCalls.length;
    for (let i = 0; i < 3; i++) p.onKeyDown(key('ArrowRight')); // 22 s: muted since 20 s
    expect(src.imageCalls).toHaveLength(calls);
  });

  it('survives a failing source and a late snapshot list', async () => {
    const failing = makeSource({ snapshots: () => Promise.reject(new Error('idb gone')) });
    const p = new EvidenceReviewPanel(null);
    p.open(failing);
    await flush();
    expect(() => p.onKeyDown(key('End'))).not.toThrow();
    const noImage = makeSource({ image: () => Promise.reject(new Error('gone')) });
    p.open(noImage);
    await flush();
    expect(() => p.onKeyDown(key('End'))).not.toThrow();
    await flush();
    expect(p.isOpen).toBe(true);
  });

  it('drops snapshot lists that arrive after a reopen', async () => {
    let resolveFirst: (v: ReturnType<typeof makeSource>['events'] extends never ? never : unknown) => void = () => undefined;
    const slow = makeSource({
      snapshots: () => new Promise((r) => {
        resolveFirst = r as typeof resolveFirst;
      }),
    });
    const fast = makeSource({ snapshots: () => Promise.resolve([]) });
    const p = new EvidenceReviewPanel(null);
    p.open(slow);
    p.open(fast);
    resolveFirst([{ key: 'late', tag: 't', incident: 'x', source: 'body', sim: 0, game: 0, bytes: 1, w: 1, h: 1 }]);
    await flush();
    expect(slow.imageCalls).toEqual([]);
    expect(fast.imageCalls).toEqual([]);
  });

  it('handles an empty review (no events, zero length)', () => {
    const p = new EvidenceReviewPanel(null);
    p.open(makeSource({ events: [], t0: 5, t1: 5 }));
    expect(p.time).toBe(5);
    p.onKeyDown(key('ArrowRight'));
    p.onKeyDown(key('ArrowDown'));
    p.onKeyDown(key(' '));
    p.update(0);
    p.update(500);
    expect(p.time).toBe(5);
    expect(p.isPlaying).toBe(false);
  });
});

describe('EvidenceReviewPanel (DOM)', () => {
  let restore: () => void = () => undefined;
  let created: string[] = [];
  let revoked: string[] = [];
  beforeEach(() => {
    restore = installFakeDocument();
    created = [];
    revoked = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const u = `blob:fake-${String(created.length + 1)}`;
      created.push(u);
      return u;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => {
      revoked.push(u);
    });
  });
  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('lays out title, NO VIDEO stage, scrubber, strip, events and footer', async () => {
    const ui = fakeUi();
    const p = new EvidenceReviewPanel(asUi(ui));
    const footer = makeFooter();
    p.open(makeSource(), footer);
    const root = fakeEl(p.element);
    expect(root.className).toBe('rev-panel');
    expect(root.attrs['aria-label']).toBe('Evidence review');
    expect(root.all('rev-title')[0]?.textContent).toBe('C-00042 · Disturbance');
    const novideo = root.all('rev-novideo')[0] as FakeEl;
    const img = root.all('rev-img')[0] as FakeEl;
    expect(novideo.textContent).toBe('NO VIDEO');
    expect(novideo.hidden).toBe(false);
    expect(img.hidden).toBe(true);
    const scrub = root.all('rev-scrub')[0] as FakeEl;
    expect(scrub.type).toBe('range');
    expect([scrub.min, scrub.max]).toEqual(['0', '60']);
    expect(root.all('rev-clock')[0]?.textContent).toBe('00:00 / 01:00');
    expect(root.all('rev-mode')[0]?.textContent).toBe('PAUSED');
    // Strip: rec 0-20, muted 20-40 (cam 3), off 40-60.
    const segs = root.all('rev-seg');
    expect(segs.map((s) => s.className)).toEqual(['rev-seg rev-seg-rec', 'rev-seg rev-seg-muted', 'rev-seg rev-seg-off']);
    const widths = segs.map((s) => Number((s.style['width'] ?? '').replace('%', '')));
    expect(widths).toHaveLength(3);
    for (const w of widths) expect(w).toBeCloseTo(100 / 3, 6);
    expect(segs.map((s) => Number((s.style['left'] ?? '').replace('%', '')))[1]).toBeCloseTo(100 / 3, 6);
    expect(root.all('rev-key').map((k) => k.textContent)).toEqual(['REC', 'MUTED', 'OFF', 'DASH']);
    // Events: severity classes, times, current highlight.
    const rows = root.all('rev-row');
    expect(rows).toHaveLength(5);
    expect(rows[2]?.className).toBe('rev-row rev-sev-warn');
    expect(rows[3]?.className).toBe('rev-row rev-sev-bad');
    expect(rows[0]?.className).toBe('rev-row rev-sev-info rev-focus');
    expect(rows[3]?.all('rev-time')[0]?.textContent).toBe('00:20');
    expect(rows[3]?.all('rev-label')[0]?.textContent).toBe('Force applied');
    expect(rows[3]?.all('rev-mark')[0]?.textContent).toBe('!!');
    // Footer.
    expect(root.all('rev-foot-line').map((l) => l.textContent)).toEqual(['Statement 0', 'Why was the camera muted?']);
    expect(root.all('rev-option').map((b) => b.textContent)).toEqual(['1. Admit the muting', '2. Deny it']);
    await flush();
    p.close();
  });

  it('shows the snapshot image, swaps it, revokes object URLs and shows NO VIDEO again', async () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    const src = makeLiveSource();
    p.open(src);
    await flush();
    const root = fakeEl(p.element);
    const img = root.all('rev-img')[0] as FakeEl;
    const novideo = root.all('rev-novideo')[0] as FakeEl;
    p.onKeyDown(key('ArrowDown')); // 10 s -> s10
    await flush();
    expect(created).toEqual(['blob:fake-1']);
    expect(img.src).toBe('blob:fake-1');
    expect(img.hidden).toBe(false);
    expect(novideo.hidden).toBe(true);
    p.onKeyDown(key('ArrowRight')); // same snapshot: no new URL
    await flush();
    expect(created).toHaveLength(1);
    p.onKeyDown(key('ArrowRight', { shiftKey: true })); // 21 s -> s20
    await flush();
    expect(created).toHaveLength(2);
    expect(revoked).toEqual(['blob:fake-1']);
    expect(img.src).toBe('blob:fake-2');
    p.onKeyDown(key('Home')); // before the first snapshot
    expect(revoked).toEqual(['blob:fake-1', 'blob:fake-2']);
    expect(img.hidden).toBe(true);
    expect(novideo.hidden).toBe(false);
    p.onKeyDown(key('End'));
    await flush();
    expect(created).toHaveLength(3);
    p.close();
    expect(revoked).toHaveLength(3);
    expect(revoked[2]).toBe('blob:fake-3');
  });

  it('drops a superseded image result without creating a URL for it', async () => {
    const resolvers: Array<(b: Blob) => void> = [];
    const src = makeLiveSource({
      image: () => new Promise<Blob>((r) => {
        resolvers.push(r);
      }),
    });
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(src);
    await flush();
    p.onKeyDown(key('ArrowDown')); // s10 requested
    p.onKeyDown(key('End')); // s50 requested
    expect(resolvers).toHaveLength(2);
    (resolvers[0] as (b: Blob) => void)(new Blob(['a']));
    await flush();
    expect(created).toHaveLength(0);
    (resolvers[1] as (b: Blob) => void)(new Blob(['b']));
    await flush();
    expect(created).toHaveLength(1);
    p.close();
    expect(revoked).toEqual(['blob:fake-1']);
  });

  it('does not create a URL for an image that arrives after close', async () => {
    let resolve: (b: Blob) => void = () => undefined;
    const src = makeSource({ image: () => new Promise<Blob>((r) => { resolve = r; }) });
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(src);
    await flush();
    p.onKeyDown(key('End'));
    p.close();
    resolve(new Blob(['x']));
    await flush();
    expect(created).toHaveLength(0);
  });

  it('moves the highlight, scrubber, clock and mode with the keys and playback', async () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(makeSource());
    await flush();
    const root = fakeEl(p.element);
    const rows = root.all('rev-row');
    const scrub = root.all('rev-scrub')[0] as FakeEl;
    p.onKeyDown(key('ArrowDown'));
    expect(rows[0]?.className).toBe('rev-row rev-sev-info');
    expect(rows[1]?.className).toBe('rev-row rev-sev-info rev-focus');
    expect(scrub.value).toBe('10');
    expect(root.all('rev-clock')[0]?.textContent).toBe('00:10 / 01:00');
    p.onKeyDown(key(' '));
    expect(root.all('rev-mode')[0]?.textContent).toBe('PLAYING');
    p.update(0);
    p.update(250);
    p.update(500);
    expect(Number(scrub.value)).toBeCloseTo(12, 5);
    expect(root.all('rev-playhead')[0]?.style['left']).toBe(`${String((12 / 60) * 100)}%`);
    p.onKeyDown(key(' '));
    expect(root.all('rev-mode')[0]?.textContent).toBe('PAUSED');
  });

  it('seeks by scrubbing and by clicking an event row', async () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(makeSource());
    await flush();
    const root = fakeEl(p.element);
    const scrub = root.all('rev-scrub')[0] as FakeEl;
    scrub.value = '45.5';
    scrub.fire('input');
    expect(p.time).toBe(45.5);
    expect(p.focusIndex).toBe(4);
    root.all('rev-row')[2]?.fire('click');
    expect(p.time).toBe(20);
    expect(p.focusIndex).toBe(2);
    expect(root.all('rev-row')[2]?.className).toBe('rev-row rev-sev-warn rev-focus');
    scrub.value = '999';
    scrub.fire('input');
    expect(p.time).toBe(60);
  });

  it('picks footer options by key and by click and refreshes the footer', () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    const footer = makeFooter();
    p.open(makeSource(), footer);
    const root = fakeEl(p.element);
    p.onKeyDown(key('2'));
    expect(footer.picks).toEqual([1]);
    expect(root.all('rev-foot-line')[0]?.textContent).toBe('Statement 1');
    root.all('rev-option')[0]?.fire('click');
    expect(footer.picks).toEqual([1, 0]);
    expect(root.all('rev-foot-line')[0]?.textContent).toBe('Statement 2');
    footer.opts = ['Only option'];
    p.refreshFooter();
    expect(root.all('rev-option').map((b) => b.textContent)).toEqual(['1. Only option']);
    p.onKeyDown(key('2'));
    expect(footer.picks).toHaveLength(2);
  });

  it('shows no footer elements without a footer and rebuilds everything on reopen', () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(makeSource(), makeFooter());
    p.open(makeSource({ title: 'Second', events: [ev(1, 0, 4)] }));
    const root = fakeEl(p.element);
    expect(root.all('rev-title')[0]?.textContent).toBe('Second');
    expect(root.all('rev-row')).toHaveLength(1);
    expect(root.all('rev-option')).toHaveLength(0);
    expect(root.all('rev-foot-line')).toHaveLength(0);
    expect(root.all('rev-seg').map((s) => s.className)).toEqual(['rev-seg rev-seg-dash']);
  });

  it('dispose removes the element', () => {
    const p = new EvidenceReviewPanel(asUi(fakeUi()));
    p.open(makeSource());
    const root = fakeEl(p.element);
    const holder = new FakeEl();
    holder.appendChild(root);
    p.dispose();
    expect(holder.children).toHaveLength(0);
    expect(p.isOpen).toBe(false);
  });
});

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}

async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

describe('EvidenceReviewPanel allocation', () => {
  // 1000 calls per sample; the test loop itself boxes a few numbers per call (the captured clock), so the bounds are
  // a few tens of bytes per call: a per-call object, array or string would cost far more.
  async function leastDelta(update: () => void): Promise<number> {
    const gc = await loadGc();
    for (let i = 0; i < 2000; i++) update(); // warm up
    let least = Infinity;
    for (let k = 0; k < 16; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 1000; i++) update();
      least = Math.min(least, process.memoryUsage().heapUsed - before);
    }
    return least;
  }

  it('update() allocates nothing while paused (headless)', async () => {
    const p = new EvidenceReviewPanel(null);
    p.open(makeSource());
    await flush();
    p.onKeyDown(key('ArrowDown'));
    await flush();
    let now = 0;
    const least = await leastDelta(() => {
      now += 16;
      p.update(now);
    });
    expect(least).toBeLessThan(50_000);
  }, 30000);

  it('update() allocates nothing while paused (DOM)', async () => {
    const restore = installFakeDocument();
    try {
      const p = new EvidenceReviewPanel(asUi(fakeUi()));
      p.open(makeSource(), makeFooter());
      await flush();
      p.onKeyDown(key('ArrowDown'));
      await flush();
      let now = 0;
      const least = await leastDelta(() => {
        now += 16;
        p.update(now);
      });
      expect(least).toBeLessThan(50_000);
    } finally {
      restore();
    }
  }, 30000);

  it('playback between snapshot changes allocates nothing (headless)', async () => {
    const p = new EvidenceReviewPanel(null);
    // A long review so 16k frames of playback stay inside one snapshot interval.
    p.open(makeSource({ t0: 0, t1: 1e9, snapshots: () => Promise.resolve([{ key: 's0', tag: 't', incident: 'C', source: 'body', sim: 0, game: 0, bytes: 1, w: 1, h: 1 }]) }));
    await flush();
    p.onKeyDown(key(' '));
    let now = 0;
    const least = await leastDelta(() => {
      now += 16;
      p.update(now);
    });
    expect(p.time).toBeGreaterThan(100);
    expect(least).toBeLessThan(100_000);
  }, 30000);
});
