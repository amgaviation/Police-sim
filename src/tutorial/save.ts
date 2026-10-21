import { getTutorialScript } from './script';

/** Largest number of queued, unapplied events. */
export const TUTORIAL_QUEUE_MAX = 64;
/** Largest number of queued, unapplied player commands. */
export const TUTORIAL_PENDING_MAX = 8;
/** Fixed steps between probe checks. */
export const TUTORIAL_PROBE_PERIOD = 15;

export type TutorialCommand = 'ack' | 'skip' | 'end';

/** One queued bus event: the topic and a JSON-safe copy of the payload. */
export interface TutorialQueuedEvent {
  topic: string;
  payload: Record<string, unknown>;
}

/** The saved tutorial (Phase 9 design §8.2; the integrator stores it in save v11 as `tutorial`). */
export interface TutorialSave {
  version: 1;
  scriptId: string;
  /** Current step (== steps.length when finished). */
  index: number;
  /** The current step's `enter` actions ran. */
  entered: boolean;
  /** `$call`, -1 unbound. */
  callId: number;
  /** Fixed steps since the last probe check (0..14). */
  probeTick: number;
  /** Step ids skipped by the player. */
  skipped: string[];
  /** Finished or ended. */
  done: boolean;
  /** Finished through the last step (false when ended early). */
  completed: boolean;
  /** Unapplied events (<= 64). */
  queue: TutorialQueuedEvent[];
  /** Unapplied player commands (<= 8). */
  pending: TutorialCommand[];
}

/** A fresh tutorial save for a script id (the first step is entered by the runner's first step). */
export function newTutorialSave(scriptId: string): TutorialSave {
  return {
    version: 1,
    scriptId,
    index: 0,
    entered: false,
    callId: -1,
    probeTick: 0,
    skipped: [],
    done: false,
    completed: false,
    queue: [],
    pending: [],
  };
}

const MAX_DEPTH = 8;

function isJsonValue(v: unknown, depth: number): boolean {
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  return isPlainPayload(v, depth + 1);
}

function isPlainPayload(v: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH || typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const value of Object.values(v)) if (!isJsonValue(value, depth)) return false;
  return true;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** Full structural check of a saved block. An unknown script id is not a tutorial save. */
export function isTutorialSave(x: unknown): x is TutorialSave {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const s = x as Record<string, unknown>;
  if (s.version !== 1 || typeof s.scriptId !== 'string') return false;
  const script = getTutorialScript(s.scriptId);
  if (script === undefined) return false;
  const count = script.steps.length;
  if (!isInt(s.index, 0, count)) return false;
  if (typeof s.entered !== 'boolean' || typeof s.done !== 'boolean' || typeof s.completed !== 'boolean') return false;
  if (!isInt(s.callId, -1, Number.MAX_SAFE_INTEGER)) return false;
  if (!isInt(s.probeTick, 0, TUTORIAL_PROBE_PERIOD - 1)) return false;
  if (!Array.isArray(s.skipped) || s.skipped.length > count) return false;
  if (!s.skipped.every((id) => typeof id === 'string')) return false;
  if (s.completed && !s.done) return false;
  if (s.completed && s.index !== count) return false;
  if (!Array.isArray(s.queue) || s.queue.length > TUTORIAL_QUEUE_MAX) return false;
  for (const q of s.queue) {
    if (typeof q !== 'object' || q === null) return false;
    const e = q as Record<string, unknown>;
    if (typeof e.topic !== 'string' || e.topic === '' || !isPlainPayload(e.payload, 0)) return false;
  }
  if (!Array.isArray(s.pending) || s.pending.length > TUTORIAL_PENDING_MAX) return false;
  return s.pending.every((p) => p === 'ack' || p === 'skip' || p === 'end');
}
