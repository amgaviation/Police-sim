/**
 * Evidence review timeline (design phase 5 §8.4): pure helpers and the key reducer of the review panel. Wave 1 declares
 * its own `ReviewEvent` / `ReviewSource` shapes; the UI layer maps incident logs into them.
 */
import { CAM_BITS } from './capture';
import type { SnapshotMeta } from './mediaStore';

export interface ReviewEvent {
  id: number;
  /** Sim seconds. */
  t: number;
  label: string;
  kind: string;
  severity: 'info' | 'warn' | 'bad';
  /** Camera bits at the event (body 1, muted 2, dash 4). */
  cam: number;
}

export interface ReviewSource {
  title: string;
  /** Review range in sim seconds. */
  t0: number;
  t1: number;
  /** Sorted by `t`. */
  events: readonly ReviewEvent[];
  /** Snapshots of the incident sorted by sim. */
  snapshots(): Promise<readonly SnapshotMeta[]>;
  image(key: string): Promise<Blob | null>;
}

export interface ReviewFooter {
  lines(): readonly string[];
  options(): readonly string[];
  pick(index: number): void;
}

export type CamState = 'rec' | 'muted' | 'off' | 'dash';

export interface CamSegment {
  t0: number;
  t1: number;
  state: CamState;
}

/** Camera strip state of a set of cam bits: the bodycam wins (recording or muted), else the dashcam, else off. */
export function camStateOf(cam: number): CamState {
  if ((cam & CAM_BITS.body) !== 0) return (cam & CAM_BITS.muted) !== 0 ? 'muted' : 'rec';
  return (cam & CAM_BITS.dash) !== 0 ? 'dash' : 'off';
}

/**
 * Contiguous segments covering `[t0, t1]` from the cam bits of consecutive events. The state before the first event is
 * the first event's state; no events means one `off` segment. Empty for `t1 <= t0`.
 */
export function camSegments(events: readonly ReviewEvent[], t0: number, t1: number): CamSegment[] {
  if (!(t1 > t0)) return [];
  const first = events[0];
  if (!first) return [{ t0, t1, state: 'off' }];
  const out: CamSegment[] = [];
  let state = camStateOf(first.cam);
  let from = t0;
  for (const e of events) {
    const next = camStateOf(e.cam);
    if (next === state) continue;
    const at = Math.min(t1, Math.max(t0, e.t));
    if (at > from) out.push({ t0: from, t1: at, state });
    from = at;
    state = next;
  }
  if (t1 > from) out.push({ t0: from, t1, state });
  return out;
}

/** Index of the last snapshot with `sim <= t` (`snaps` sorted by sim; binary search), -1 when none. */
export function nearestSnapshot(snaps: readonly SnapshotMeta[], t: number): number {
  let lo = 0;
  let hi = snaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((snaps[mid] as SnapshotMeta).sim <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Index of the last event with `e.t <= t` (`events` sorted by t; binary search), -1 when none. */
export function eventIndexAt(events: readonly ReviewEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((events[mid] as ReviewEvent).t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export interface ReviewState {
  /** Playhead, sim seconds. */
  t: number;
  playing: boolean;
  /** Index of the selected event, -1 before the first one. */
  focus: number;
}

export interface ReviewRange {
  t0: number;
  t1: number;
  events: readonly ReviewEvent[];
}

export type ReviewEmit = 'close' | { pick: number } | null;

export interface ReviewKeyResult {
  state: ReviewState;
  emit: ReviewEmit;
  consumed: boolean;
}

/** Seconds a plain arrow key seeks; Shift multiplies it. */
export const REVIEW_STEP_S = 1;
export const REVIEW_SHIFT_FACTOR = 10;

/** A fresh state at the start of the range, paused. */
export function createReviewState(src: ReviewRange): ReviewState {
  return { t: src.t0, playing: false, focus: eventIndexAt(src.events, src.t0) };
}

/** `mm:ss` of a non-negative number of seconds (`h:mm:ss` from an hour). */
export function formatReviewTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/**
 * Pure key reducer of the review panel. Left / Right seek -/+ 1 s (Shift, or a `Shift+` key prefix, x10); Up / Down
 * select the previous / next event and jump the playhead to it; Space plays or pauses (from the end it restarts);
 * Home / End jump to the range ends; digits 1-9 emit `{ pick: n - 1 }` for the footer options; Escape emits `close`.
 * Other keys are not consumed.
 */
export function reduceReviewKey(s: ReviewState, key: string, src: ReviewRange, shift = false): ReviewKeyResult {
  const idle = (consumed: boolean): ReviewKeyResult => ({ state: s, emit: null, consumed });
  const go = (t: number, focus: number, playing = s.playing): ReviewKeyResult => ({
    state: { t, focus, playing },
    emit: null,
    consumed: true,
  });
  let k = key;
  if (k.startsWith('Shift+')) {
    k = k.slice(6);
    shift = true;
  }
  const clamp = (t: number): number => Math.min(src.t1, Math.max(src.t0, t));
  const events = src.events;
  switch (k) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const step = (k === 'ArrowRight' ? 1 : -1) * REVIEW_STEP_S * (shift ? REVIEW_SHIFT_FACTOR : 1);
      const t = clamp(s.t + step);
      return go(t, eventIndexAt(events, t));
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      const n = events.length;
      // The selected event, unless the playhead has moved off it.
      const sel = s.focus >= 0 && s.focus < n && (events[s.focus] as ReviewEvent).t === s.t ? s.focus : eventIndexAt(events, s.t);
      let target: number;
      if (k === 'ArrowDown') target = sel + 1;
      else target = sel >= 0 && (events[sel] as ReviewEvent).t < s.t ? sel : sel - 1;
      if (target < 0 || target >= n) return idle(true);
      return go(clamp((events[target] as ReviewEvent).t), target);
    }
    case ' ':
    case 'Spacebar': {
      if (s.playing) return go(s.t, s.focus, false);
      if (s.t >= src.t1) return go(src.t0, eventIndexAt(events, src.t0), true);
      return go(s.t, s.focus, true);
    }
    case 'Home':
      return go(src.t0, eventIndexAt(events, src.t0));
    case 'End':
      return go(src.t1, eventIndexAt(events, src.t1), false);
    case 'Escape':
      return { state: s, emit: 'close', consumed: true };
    default:
      if (k.length === 1 && k >= '1' && k <= '9') return { state: s, emit: { pick: Number(k) - 1 }, consumed: true };
      return idle(false);
  }
}
