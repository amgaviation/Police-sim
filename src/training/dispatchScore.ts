/**
 * Dispatch-only scoring (Phase 8 design 7.3). Each call is scored 0..100 when it closes: timeliness of the first
 * assignment (0..50), coverage of the call's minimum units (0..25) and proximity of the assigned units against the
 * nearest available one (0..25).
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import './events';

export type DispatchPriority = 1 | 2 | 3 | 4;

export interface DispatchCallRecord {
  callId: number;
  number: string;
  priority: DispatchPriority;
  createdSim: number;
  /** Sim time of the first assignment (-1 = none yet). */
  firstAssignSim: number;
  minUnits: number;
  /** Units assigned so far. */
  assigned: number;
  /** Mean straight-line distance (m) of the assigned units at their assignment. */
  assignedDistM: number;
  /** Mean distance (m) of the nearest available unit at each assignment. */
  nearestDistM: number;
  closed: boolean;
  score: number;
}

export interface DispatchTrainingSave {
  /** Newest last, at most `MAX_RECORDS`. */
  calls: DispatchCallRecord[];
  /** Sum of the scores of all scored calls. */
  total: number;
  scored: number;
}

/** Records kept (oldest closed first dropped). */
export const MAX_RECORDS = 200;

/** Per priority: full timeliness points at or under the first value (s), none at or over the second. */
export const TIMELY_S: Readonly<Record<1 | 2 | 3 | 4, readonly [number, number]> > = { 1: [30, 180], 2: [60, 300], 3: [120, 600], 4: [300, 1200] };

const TIMELY_MAX = 50;
const COVER_MAX = 25;
const PROX_MAX = 25;

/**
 * Score of a call at `nowSim`: timeliness (the wait until the first assignment, or until now while unassigned) linear
 * from full at the first threshold to 0 at the second; coverage `assigned / minUnits`; proximity `nearest / assigned
 * distance` (full when no unit was nearer). A call never assigned that is closed or older than the second threshold
 * scores 0.
 */
export function scoreCall(r: Readonly<DispatchCallRecord>, nowSim: number): number {
  const [fast, slow] = TIMELY_S[r.priority];
  const assigned = r.firstAssignSim >= 0 && r.assigned > 0;
  const wait = assigned ? r.firstAssignSim - r.createdSim : nowSim - r.createdSim;
  if (!assigned && (r.closed || wait > slow)) return 0;
  const timely = TIMELY_MAX * Math.min(1, Math.max(0, (slow - wait) / (slow - fast)));
  const cover = COVER_MAX * Math.min(1, r.assigned / Math.max(1, r.minUnits));
  let prox = 0;
  if (assigned) prox = r.assignedDistM <= r.nearestDistM || r.assignedDistM <= 0 ? PROX_MAX : (PROX_MAX * r.nearestDistM) / r.assignedDistM;
  return Math.round(timely + cover + prox);
}

/** Structural check of a saved scoring block. */
export function isDispatchTrainingSave(x: unknown): x is DispatchTrainingSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.total !== 'number' || !Number.isFinite(o.total) || typeof o.scored !== 'number' || !Number.isInteger(o.scored) || o.scored < 0) return false;
  if (!Array.isArray(o.calls) || o.calls.length > MAX_RECORDS) return false;
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  return o.calls.every((c: unknown) => {
    if (typeof c !== 'object' || c === null) return false;
    const r = c as Record<string, unknown>;
    return (
      num(r.callId) && typeof r.number === 'string' && (r.priority === 1 || r.priority === 2 || r.priority === 3 || r.priority === 4) &&
      num(r.createdSim) && num(r.firstAssignSim) && num(r.minUnits) && num(r.assigned) && num(r.assignedDistM) && num(r.nearestDistM) &&
      typeof r.closed === 'boolean' && num(r.score)
    );
  });
}

export class DispatchTraining {
  private readonly bus: EventBus<EventMap>;
  private readonly records: DispatchCallRecord[] = [];
  private readonly byId = new Map<number, DispatchCallRecord>();
  private total = 0;
  private scored = 0;

  constructor(bus: EventBus<EventMap>, save?: DispatchTrainingSave) {
    this.bus = bus;
    if (save) {
      for (const c of save.calls) {
        const r = { ...c };
        this.records.push(r);
        this.byId.set(r.callId, r);
      }
      this.total = save.total;
      this.scored = save.scored;
    }
  }

  /** A call was created (track it). */
  onCreated(callId: number, number: string, priority: DispatchPriority, minUnits: number, sim: number): void {
    if (this.byId.has(callId)) return;
    const r: DispatchCallRecord = {
      callId, number, priority, createdSim: sim, firstAssignSim: -1, minUnits: Math.max(1, minUnits),
      assigned: 0, assignedDistM: 0, nearestDistM: 0, closed: false, score: 0,
    };
    this.records.push(r);
    this.byId.set(callId, r);
    this.trim();
  }

  /** A unit was assigned `distM` metres from the call while the nearest available one was `nearestDistM` away. */
  onAssigned(callId: number, sim: number, distM: number, nearestDistM: number): void {
    const r = this.byId.get(callId);
    if (!r || r.closed) return;
    const nearest = Number.isFinite(nearestDistM) ? Math.min(nearestDistM, distM) : distM;
    const n = r.assigned;
    r.assignedDistM = (r.assignedDistM * n + distM) / (n + 1);
    r.nearestDistM = (r.nearestDistM * n + nearest) / (n + 1);
    r.assigned = n + 1;
    if (r.firstAssignSim < 0) r.firstAssignSim = sim;
  }

  /** The call closed: it is scored and `training:dispatchScore` is emitted. */
  onClosed(callId: number, sim: number): void {
    const r = this.byId.get(callId);
    if (!r || r.closed) return;
    r.closed = true;
    r.score = scoreCall(r, sim);
    this.total += r.score;
    this.scored++;
    this.bus.emit('training:dispatchScore', { callNumber: r.number, score: r.score, total: this.total });
  }

  /** Mean score of the scored calls (0 without any). */
  average(): number {
    return this.scored > 0 ? this.total / this.scored : 0;
  }

  /** A at 90, B at 80, C at 70, D at 60, else F. */
  grade(): 'A' | 'B' | 'C' | 'D' | 'F' {
    const a = this.average();
    return a >= 90 ? 'A' : a >= 80 ? 'B' : a >= 70 ? 'C' : a >= 60 ? 'D' : 'F';
  }

  serialize(): DispatchTrainingSave {
    return { calls: this.records.map((r) => ({ ...r })), total: this.total, scored: this.scored };
  }

  private trim(): void {
    while (this.records.length > MAX_RECORDS) {
      let i = this.records.findIndex((r) => r.closed);
      if (i < 0) i = 0;
      const [gone] = this.records.splice(i, 1);
      if (gone) this.byId.delete(gone.callId);
    }
  }
}
