/**
 * Driving-academy cone course (Phase 8 design 7.2). A course is data (`courses.json`): gates and cones are placed in
 * course space (`s` metres along the axis, `offset` metres to the driver's right) and anchored on a straight road
 * segment of the city. `DrivingCourseRun` scores a drive from the vehicle position, allocation-free per step.
 */
import coursesJson from '../data/training/courses.json';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { fail, readArray, readNumber, readObject, readString, readVersion, type JsonObject } from '../vehicles/json';
import './events';

export interface CourseGate {
  /** Metres along the axis. */
  readonly s: number;
  /** Metres to the right of the axis. */
  readonly offset: number;
  /** Clear width of the gate (m). */
  readonly width: number;
}

export interface CourseCone {
  readonly s: number;
  readonly offset: number;
}

export interface CoursePenalties {
  readonly cone: number;
  readonly missedGate: number;
  readonly stopBox: number;
  readonly perSecondOver: number;
}

export interface CourseDef {
  readonly id: string;
  readonly label: string;
  readonly parTimeS: number;
  readonly gates: readonly CourseGate[];
  readonly cones: readonly CourseCone[];
  /** Stop here (speed < 0.5 m/s) between `s` and `s + length`; null = no stop box. */
  readonly stopBox: { readonly s: number; readonly length: number } | null;
  readonly penalties: CoursePenalties;
}

/** A straight road piece of the city (world metres; x east, z south). */
export interface CourseSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Where a course sits in the world. */
export interface CourseAnchor {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  rightX: number;
  rightZ: number;
  length: number;
}

/** A cone is hit when the vehicle centre is this close (cone radius 0.6 m + vehicle half width 1.0 m). */
export const CONE_HIT_M = 1.6;
/** Speed below which the vehicle counts as stopped (m/s). */
export const STOP_SPEED = 0.5;
/** The run is aborted this far off the axis (m) or this far before the start (m). */
export const ABORT_OFFSET_M = 15;
export const ABORT_BEFORE_START_M = 30;
/** Shortest road segment a course is anchored on (m). */
export const MIN_SEGMENT_M = 320;

const FILE = 'training/courses.json';

function readCoursePoint(value: unknown, file: string, path: string, maxOffset: number): { s: number; offset: number } {
  const o = readObject(value, file, path);
  return { s: readNumber(o.s, file, `${path}.s`, 0, 300), offset: readNumber(o.offset, file, `${path}.offset`, -maxOffset, maxOffset) };
}

/** Validates `courses.json`; throws an `Error` naming the file and the dotted path. */
export function parseCourses(json: unknown, file: string): readonly CourseDef[] {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const list = readArray(root.courses, file, 'courses', 1);
  const seen = new Set<string>();
  return list.map((raw, i): CourseDef => {
    const p = `courses[${i}]`;
    const o: JsonObject = readObject(raw, file, p);
    const id = readString(o.id, file, `${p}.id`);
    if (seen.has(id)) fail(file, `${p}.id`, `duplicate course id "${id}"`);
    seen.add(id);
    const gatesRaw = readArray(o.gates, file, `${p}.gates`, 1);
    let prev = -1;
    const gates = gatesRaw.map((g, j): CourseGate => {
      const gp = `${p}.gates[${j}]`;
      const o2 = readObject(g, file, gp);
      const point = readCoursePoint(o2, file, gp, 3.5);
      if (point.s <= prev) fail(file, `${gp}.s`, `must be greater than the previous gate (${prev}), got ${point.s}`);
      prev = point.s;
      return { s: point.s, offset: point.offset, width: readNumber(o2.width, file, `${gp}.width`, 1.5, 8) };
    });
    const cones = readArray(o.cones, file, `${p}.cones`).map((c, j): CourseCone => readCoursePoint(c, file, `${p}.cones[${j}]`, 4.5));
    let stopBox: CourseDef['stopBox'] = null;
    if (o.stopBox !== null && o.stopBox !== undefined) {
      const sb = readObject(o.stopBox, file, `${p}.stopBox`);
      stopBox = { s: readNumber(sb.s, file, `${p}.stopBox.s`, 0, 300), length: readNumber(sb.length, file, `${p}.stopBox.length`, 2, 40) };
    }
    const pen = readObject(o.penalties, file, `${p}.penalties`);
    return {
      id,
      label: readString(o.label, file, `${p}.label`),
      parTimeS: readNumber(o.parTimeS, file, `${p}.parTimeS`, 5, 600),
      gates,
      cones,
      stopBox,
      penalties: {
        cone: readNumber(pen.cone, file, `${p}.penalties.cone`, 0, 100),
        missedGate: readNumber(pen.missedGate, file, `${p}.penalties.missedGate`, 0, 100),
        stopBox: readNumber(pen.stopBox, file, `${p}.penalties.stopBox`, 0, 100),
        perSecondOver: readNumber(pen.perSecondOver, file, `${p}.penalties.perSecondOver`, 0, 100),
      },
    };
  });
}

/** The shipped courses: `basic`, `slalom`, `precision`. */
export const COURSES: readonly CourseDef[] = parseCourses(coursesJson, FILE);

/** A shipped course by id. */
export function findCourse(id: string): CourseDef | undefined {
  return COURSES.find((c) => c.id === id);
}

/**
 * The segment of length >= `minLength` (default 320 m) whose start is nearest (sx, sz), as an anchor at its start with
 * `dir = unit(b - a)` and `right = (-dirZ, dirX)` (world x east, z south: facing north (0, -1) the right is east
 * (1, 0)), so a positive offset is the driver's right. Ties go to the lower index; null when no segment is long enough.
 */
export function pickCourseSegment(segments: readonly CourseSegment[], sx: number, sz: number, minLength = MIN_SEGMENT_M): CourseAnchor | null {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    if (Math.hypot(s.bx - s.ax, s.bz - s.az) < minLength) continue;
    const d = Math.hypot(s.ax - sx, s.az - sz);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const s = segments[best];
  if (!s) return null;
  const length = Math.hypot(s.bx - s.ax, s.bz - s.az);
  const dirX = (s.bx - s.ax) / length;
  const dirZ = (s.bz - s.az) / length;
  return { x: s.ax, z: s.az, dirX, dirZ, rightX: -dirZ, rightZ: dirX, length };
}

/** World point at (`s`, `offset`) of the course frame; writes and returns `out`. */
export function coursePoint(a: CourseAnchor, s: number, offset: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = a.x + a.dirX * s + a.rightX * offset;
  out.z = a.z + a.dirZ * s + a.rightZ * offset;
  return out;
}

/** Writes x, z per cone into `out` (length >= 2 * cones); returns the cone count. */
export function conePositions(a: CourseAnchor, c: CourseDef, out: Float32Array): number {
  const n = Math.min(c.cones.length, out.length >> 1);
  for (let i = 0; i < n; i++) {
    const cone = c.cones[i];
    if (!cone) continue;
    out[2 * i] = a.x + a.dirX * cone.s + a.rightX * cone.offset;
    out[2 * i + 1] = a.z + a.dirZ * cone.s + a.rightZ * cone.offset;
  }
  return n;
}

export interface CourseRunSave {
  courseId: string;
  /** Sim time of the start line crossing (-1 before). */
  startSim: number;
  /** Next gate to resolve. */
  gateIdx: number;
  missed: number;
  /** Per cone 0 / 1. */
  coneHit: number[];
  lastS: number;
  stopped: boolean;
  done: boolean;
  aborted: boolean;
  /** Sim time the run ended (-1 while running). */
  finishSim: number;
}

/** Structural check of a saved run. */
export function isCourseRunSave(x: unknown): x is CourseRunSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  return (
    typeof o.courseId === 'string' &&
    num(o.startSim) &&
    typeof o.gateIdx === 'number' && Number.isInteger(o.gateIdx) && o.gateIdx >= 0 &&
    typeof o.missed === 'number' && Number.isInteger(o.missed) && o.missed >= 0 &&
    Array.isArray(o.coneHit) && o.coneHit.length <= 64 && o.coneHit.every((v) => v === 0 || v === 1) &&
    num(o.lastS) &&
    typeof o.stopped === 'boolean' &&
    typeof o.done === 'boolean' &&
    typeof o.aborted === 'boolean' &&
    num(o.finishSim)
  );
}

export interface CourseResult {
  timeS: number;
  cones: number;
  missed: number;
  stopOk: boolean;
  /** 100 minus the penalties, clamped to 0..100 and rounded. */
  score: number;
}

/**
 * One drive of a course. `step` is allocation-free (events and `result()` allocate only on rare transitions). Gates
 * resolve in order when the vehicle's axis position `s` crosses them: passed when the lateral distance to the gate
 * centre is within half the width, else missed. A run that is aborted counts its unresolved gates as missed.
 */
export class DrivingCourseRun {
  private readonly course: CourseDef;
  private readonly anchor: CourseAnchor;
  private readonly bus: EventBus<EventMap>;
  private readonly conesXz: Float32Array;
  private readonly hits: Uint8Array;
  private hitCount = 0;
  private startSim = -1;
  private gateIdx = 0;
  private missed = 0;
  private lastS = 0;
  private lastSim = 0;
  private stopped = false;
  private isDone = false;
  private isAborted = false;
  private finishSim = -1;
  private readonly boxEnd: number;

  constructor(course: CourseDef, anchor: CourseAnchor, bus: EventBus<EventMap>, save?: CourseRunSave) {
    this.course = course;
    this.anchor = anchor;
    this.bus = bus;
    this.conesXz = new Float32Array(Math.max(2, course.cones.length * 2));
    conePositions(anchor, course, this.conesXz);
    this.hits = new Uint8Array(course.cones.length);
    this.boxEnd = course.stopBox ? course.stopBox.s + course.stopBox.length : -1;
    if (save) {
      this.startSim = save.startSim;
      this.gateIdx = Math.min(save.gateIdx, course.gates.length);
      this.missed = save.missed;
      for (let i = 0; i < this.hits.length; i++) {
        const v = save.coneHit[i] ?? 0;
        this.hits[i] = v;
        this.hitCount += v;
      }
      this.lastS = save.lastS;
      this.stopped = save.stopped;
      this.isDone = save.done;
      this.isAborted = save.aborted;
      this.finishSim = save.finishSim;
      this.lastSim = this.startSim;
    }
  }

  get done(): boolean {
    return this.isDone;
  }

  get aborted(): boolean {
    return this.isAborted;
  }

  /**
   * Fixed step, allocation-free: the vehicle's `s` / offset on the axis; gates at `s` crossed since the last step pass
   * or miss; a cone within `CONE_HIT_M` of the vehicle centre counts once; speed < 0.5 m/s inside the stop box sets
   * `stopped`; past the last gate (and the stop box) the run is done; |offset| > 15 m or s < -30 m aborts it. Emits
   * `training:course` on every change.
   */
  step(x: number, z: number, speed: number, sim: number): void {
    if (this.isDone || this.isAborted) return;
    const a = this.anchor;
    const dx = x - a.x;
    const dz = z - a.z;
    const s = dx * a.dirX + dz * a.dirZ;
    const off = dx * a.rightX + dz * a.rightZ;
    this.lastSim = sim;
    if (this.startSim < 0 && s >= 0) this.startSim = sim;
    let changed = false;
    const gates = this.course.gates;
    while (this.gateIdx < gates.length) {
      const g = gates[this.gateIdx];
      if (!g || s < g.s) break;
      if (Math.abs(off - g.offset) > g.width * 0.5) this.missed++;
      this.gateIdx++;
      changed = true;
    }
    const xz = this.conesXz;
    const hits = this.hits;
    for (let i = 0; i < hits.length; i++) {
      if (hits[i] === 1) continue;
      const cx = (xz[2 * i] as number) - x;
      const cz = (xz[2 * i + 1] as number) - z;
      if (cx * cx + cz * cz <= CONE_HIT_M * CONE_HIT_M) {
        hits[i] = 1;
        this.hitCount++;
        changed = true;
      }
    }
    const box = this.course.stopBox;
    if (box !== null && !this.stopped && s >= box.s && s <= this.boxEnd && speed < STOP_SPEED) {
      this.stopped = true;
      changed = true;
    }
    this.lastS = s;
    if (Math.abs(off) > ABORT_OFFSET_M || s < -ABORT_BEFORE_START_M) {
      this.isAborted = true;
      this.finishSim = sim;
      this.emit();
      return;
    }
    if (this.gateIdx >= gates.length && (box === null || s > this.boxEnd)) {
      this.isDone = true;
      this.finishSim = sim;
      this.emit();
      return;
    }
    if (changed) this.emit();
  }

  /** Time, cones, gates, stop box and score so far (final once `done` or `aborted`). */
  result(): CourseResult {
    const pen = this.course.penalties;
    const ended = this.isDone || this.isAborted;
    const end = this.finishSim >= 0 ? this.finishSim : this.lastSim;
    const timeS = this.startSim < 0 ? 0 : Math.max(0, end - this.startSim);
    const missed = this.missed + (this.isAborted ? this.course.gates.length - this.gateIdx : 0);
    const stopOk = this.course.stopBox === null || this.stopped;
    let penalties = this.hitCount * pen.cone + missed * pen.missedGate + Math.max(0, timeS - this.course.parTimeS) * pen.perSecondOver;
    if (ended && !stopOk) penalties += pen.stopBox;
    return { timeS, cones: this.hitCount, missed, stopOk, score: Math.min(100, Math.max(0, Math.round(100 - penalties))) };
  }

  /** Per cone 0 / 1 (a live view for the renderer; do not mutate). */
  coneHits(): Uint8Array {
    return this.hits;
  }

  serialize(): CourseRunSave {
    return {
      courseId: this.course.id,
      startSim: this.startSim,
      gateIdx: this.gateIdx,
      missed: this.missed,
      coneHit: Array.from(this.hits),
      lastS: this.lastS,
      stopped: this.stopped,
      done: this.isDone,
      aborted: this.isAborted,
      finishSim: this.finishSim,
    };
  }

  private emit(): void {
    const r = this.result();
    this.bus.emit('training:course', {
      gate: this.gateIdx,
      gates: this.course.gates.length,
      cones: r.cones,
      missed: r.missed,
      done: this.isDone,
      score: r.score,
      timeS: r.timeS,
    });
  }
}
