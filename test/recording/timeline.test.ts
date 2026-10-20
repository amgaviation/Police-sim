import { describe, expect, it } from 'vitest';
import {
  CAM_BITS,
  camSegments,
  camStateOf,
  createReviewState,
  eventIndexAt,
  formatReviewTime,
  nearestSnapshot,
  reduceReviewKey,
  type ReviewEvent,
  type ReviewState,
  type SnapshotMeta,
} from '../../src/recording';

const { body, muted, dash } = CAM_BITS;

function ev(id: number, t: number, cam: number = body, extra: Partial<ReviewEvent> = {}): ReviewEvent {
  return { id, t, label: `e${String(id)}`, kind: 'x', severity: 'info', cam, ...extra };
}

function snap(sim: number, source: 'body' | 'dash' = 'body'): SnapshotMeta {
  return { key: `k${String(sim)}${source}`, tag: 't', incident: 'C-1', source, sim, game: sim, bytes: 1, w: 160, h: 90 };
}

describe('camStateOf', () => {
  it('maps bits to strip states', () => {
    expect(camStateOf(0)).toBe('off');
    expect(camStateOf(body)).toBe('rec');
    expect(camStateOf(body | muted)).toBe('muted');
    expect(camStateOf(dash)).toBe('dash');
    expect(camStateOf(muted)).toBe('off');
    expect(camStateOf(body | dash)).toBe('rec');
    expect(camStateOf(body | muted | dash)).toBe('muted');
  });
});

describe('camSegments', () => {
  it('is one off segment without events and empty for an empty range', () => {
    expect(camSegments([], 0, 60)).toEqual([{ t0: 0, t1: 60, state: 'off' }]);
    expect(camSegments([ev(1, 5)], 10, 10)).toEqual([]);
    expect(camSegments([ev(1, 5)], 10, 5)).toEqual([]);
  });

  it('is one segment while the state never changes', () => {
    expect(camSegments([ev(1, 2), ev(2, 8)], 0, 10)).toEqual([{ t0: 0, t1: 10, state: 'rec' }]);
  });

  it('splits at state changes and merges equal neighbours', () => {
    const events = [ev(1, 0, 0), ev(2, 10, body), ev(3, 15, body), ev(4, 20, body | muted), ev(5, 30, body), ev(6, 40, dash)];
    expect(camSegments(events, 0, 50)).toEqual([
      { t0: 0, t1: 10, state: 'off' },
      { t0: 10, t1: 20, state: 'rec' },
      { t0: 20, t1: 30, state: 'muted' },
      { t0: 30, t1: 40, state: 'rec' },
      { t0: 40, t1: 50, state: 'dash' },
    ]);
  });

  it('extends the first event state back to t0 and clamps to the range', () => {
    const events = [ev(1, 5, body), ev(2, 8, body | muted), ev(3, 100, 0)];
    expect(camSegments(events, 0, 20)).toEqual([
      { t0: 0, t1: 8, state: 'rec' },
      { t0: 8, t1: 20, state: 'muted' },
    ]);
    // events before t0 only set the starting state
    expect(camSegments([ev(1, -5, 0), ev(2, -1, body)], 0, 10)).toEqual([{ t0: 0, t1: 10, state: 'rec' }]);
  });

  it('covers the range without gaps or zero-length segments', () => {
    const events = [ev(1, 0, 0), ev(2, 0, body), ev(3, 5, body | muted), ev(4, 5, body), ev(5, 5, dash), ev(6, 10, 0)];
    const segs = camSegments(events, 0, 10);
    expect(segs[0]?.t0).toBe(0);
    expect(segs[segs.length - 1]?.t1).toBe(10);
    for (let i = 0; i < segs.length; i++) {
      expect((segs[i] as { t1: number; t0: number }).t1).toBeGreaterThan((segs[i] as { t0: number }).t0);
      if (i > 0) expect((segs[i] as { t0: number }).t0).toBe((segs[i - 1] as { t1: number }).t1);
    }
  });
});

describe('nearestSnapshot', () => {
  const snaps = [snap(3), snap(6), snap(9)];
  it('returns the last snapshot at or before t', () => {
    expect(nearestSnapshot(snaps, 2.99)).toBe(-1);
    expect(nearestSnapshot(snaps, 3)).toBe(0);
    expect(nearestSnapshot(snaps, 5.9)).toBe(0);
    expect(nearestSnapshot(snaps, 6)).toBe(1);
    expect(nearestSnapshot(snaps, 100)).toBe(2);
    expect(nearestSnapshot(snaps, -5)).toBe(-1);
  });
  it('handles empty, single and duplicate sims', () => {
    expect(nearestSnapshot([], 5)).toBe(-1);
    expect(nearestSnapshot([snap(1)], 0.5)).toBe(-1);
    expect(nearestSnapshot([snap(1)], 1)).toBe(0);
    expect(nearestSnapshot([snap(4, 'body'), snap(4, 'dash'), snap(7)], 5)).toBe(1);
  });
  it('agrees with a linear scan', () => {
    const many = Array.from({ length: 50 }, (_, i) => snap(i * 1.5));
    for (let t = -2; t < 80; t += 0.37) {
      let expected = -1;
      many.forEach((s, i) => {
        if (s.sim <= t) expected = i;
      });
      expect(nearestSnapshot(many, t)).toBe(expected);
    }
  });
});

describe('eventIndexAt', () => {
  const events = [ev(1, 2), ev(2, 5), ev(3, 5), ev(4, 9)];
  it('returns the last event at or before t', () => {
    expect(eventIndexAt(events, 1.9)).toBe(-1);
    expect(eventIndexAt(events, 2)).toBe(0);
    expect(eventIndexAt(events, 4.99)).toBe(0);
    expect(eventIndexAt(events, 5)).toBe(2);
    expect(eventIndexAt(events, 50)).toBe(3);
    expect(eventIndexAt([], 5)).toBe(-1);
  });
});

describe('formatReviewTime', () => {
  it('formats mm:ss and h:mm:ss', () => {
    expect(formatReviewTime(0)).toBe('00:00');
    expect(formatReviewTime(59.9)).toBe('00:59');
    expect(formatReviewTime(75)).toBe('01:15');
    expect(formatReviewTime(3725)).toBe('1:02:05');
    expect(formatReviewTime(-4)).toBe('00:00');
  });
});

describe('reduceReviewKey', () => {
  const events = [ev(1, 10), ev(2, 20), ev(3, 20), ev(4, 40)];
  const src = { t0: 0, t1: 60, events };
  const st = (t: number, playing = false, focus = eventIndexAt(events, t)): ReviewState => ({ t, playing, focus });

  it('starts paused at t0', () => {
    expect(createReviewState(src)).toEqual({ t: 0, playing: false, focus: -1 });
    expect(createReviewState({ ...src, t0: 10 }).focus).toBe(0);
  });

  it('seeks one second with the arrows and ten with Shift', () => {
    expect(reduceReviewKey(st(30), 'ArrowRight', src).state.t).toBe(31);
    expect(reduceReviewKey(st(30), 'ArrowLeft', src).state.t).toBe(29);
    expect(reduceReviewKey(st(30), 'ArrowRight', src, true).state.t).toBe(40);
    expect(reduceReviewKey(st(30), 'Shift+ArrowLeft', src).state.t).toBe(20);
    const r = reduceReviewKey(st(30), 'ArrowRight', src);
    expect(r.consumed).toBe(true);
    expect(r.emit).toBeNull();
  });

  it('clamps seeking to the range and updates the event focus', () => {
    expect(reduceReviewKey(st(0.5), 'ArrowLeft', src).state.t).toBe(0);
    expect(reduceReviewKey(st(0), 'ArrowLeft', src, true).state.t).toBe(0);
    expect(reduceReviewKey(st(59.5), 'ArrowRight', src).state.t).toBe(60);
    expect(reduceReviewKey(st(55), 'ArrowRight', src, true).state.t).toBe(60);
    expect(reduceReviewKey(st(9), 'ArrowRight', src).state.focus).toBe(0);
    expect(reduceReviewKey(st(21), 'ArrowLeft', src).state.focus).toBe(2);
    expect(reduceReviewKey(st(20), 'ArrowLeft', src).state.focus).toBe(0);
  });

  it('keeps the playing flag while seeking', () => {
    expect(reduceReviewKey(st(30, true), 'ArrowRight', src).state.playing).toBe(true);
  });

  it('steps through events with Down and Up, including events sharing a time', () => {
    let s = st(0);
    s = reduceReviewKey(s, 'ArrowDown', src).state;
    expect(s).toEqual({ t: 10, playing: false, focus: 0 });
    s = reduceReviewKey(s, 'ArrowDown', src).state;
    expect(s).toEqual({ t: 20, playing: false, focus: 1 });
    s = reduceReviewKey(s, 'ArrowDown', src).state;
    expect(s).toEqual({ t: 20, playing: false, focus: 2 });
    s = reduceReviewKey(s, 'ArrowDown', src).state;
    expect(s).toEqual({ t: 40, playing: false, focus: 3 });
    const end = reduceReviewKey(s, 'ArrowDown', src);
    expect(end.state).toBe(s);
    expect(end.consumed).toBe(true);
    s = reduceReviewKey(s, 'ArrowUp', src).state;
    expect(s).toEqual({ t: 20, playing: false, focus: 2 });
    s = reduceReviewKey(s, 'ArrowUp', src).state;
    expect(s).toEqual({ t: 20, playing: false, focus: 1 });
    s = reduceReviewKey(s, 'ArrowUp', src).state;
    expect(s).toEqual({ t: 10, playing: false, focus: 0 });
    const top = reduceReviewKey(s, 'ArrowUp', src);
    expect(top.state).toBe(s);
    expect(top.consumed).toBe(true);
  });

  it('Up between events returns to the current event, Down goes to the next', () => {
    expect(reduceReviewKey(st(25), 'ArrowUp', src).state).toEqual({ t: 20, playing: false, focus: 2 });
    expect(reduceReviewKey(st(25), 'ArrowDown', src).state).toEqual({ t: 40, playing: false, focus: 3 });
    expect(reduceReviewKey(st(3), 'ArrowUp', src).state.t).toBe(3); // before the first event: nothing to go back to
    expect(reduceReviewKey(st(3), 'ArrowDown', src).state.t).toBe(10);
  });

  it('is safe without events', () => {
    const empty = { t0: 0, t1: 10, events: [] };
    const s = { t: 4, playing: false, focus: -1 };
    expect(reduceReviewKey(s, 'ArrowDown', empty).state).toBe(s);
    expect(reduceReviewKey(s, 'ArrowUp', empty).state).toBe(s);
    expect(reduceReviewKey(s, 'ArrowDown', empty).consumed).toBe(true);
  });

  it('Space toggles playing and restarts from the end', () => {
    expect(reduceReviewKey(st(5), ' ', src).state.playing).toBe(true);
    expect(reduceReviewKey(st(5, true), ' ', src).state.playing).toBe(false);
    expect(reduceReviewKey(st(5, true), ' ', src).state.t).toBe(5);
    expect(reduceReviewKey(st(60), ' ', src).state).toEqual({ t: 0, playing: true, focus: -1 });
  });

  it('Home and End jump to the ends', () => {
    expect(reduceReviewKey(st(30, true), 'Home', src).state).toEqual({ t: 0, playing: true, focus: -1 });
    expect(reduceReviewKey(st(30, true), 'End', src).state).toEqual({ t: 60, playing: false, focus: 3 });
  });

  it('digits 1-9 pick footer options, 0 and others are not consumed', () => {
    for (let n = 1; n <= 9; n++) {
      const r = reduceReviewKey(st(5), String(n), src);
      expect(r.emit).toEqual({ pick: n - 1 });
      expect(r.consumed).toBe(true);
      expect(r.state.t).toBe(5);
    }
    for (const k of ['0', 'a', 'Tab', 'Enter', 'F5', '10']) {
      const r = reduceReviewKey(st(5), k, src);
      expect(r.consumed).toBe(false);
      expect(r.emit).toBeNull();
    }
  });

  it('Escape closes', () => {
    const r = reduceReviewKey(st(5), 'Escape', src);
    expect(r.emit).toBe('close');
    expect(r.consumed).toBe(true);
  });

  it('never mutates the input state', () => {
    const s = st(30);
    const copy = { ...s };
    reduceReviewKey(s, 'ArrowRight', src);
    reduceReviewKey(s, ' ', src);
    reduceReviewKey(s, 'End', src);
    expect(s).toEqual(copy);
  });
});
