import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import {
  COURSES,
  DrivingCourseRun,
  conePositions,
  coursePoint,
  findCourse,
  isCourseRunSave,
  parseCourses,
  pickCourseSegment,
  type CourseAnchor,
  type CourseDef,
} from '../../src/training/course';

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

const DT = 1 / 60;

/** A course anchored at (100, 400) facing north (0, -1): the right of the driver is east (+x). */
function anchor(): CourseAnchor {
  const a = pickCourseSegment([{ ax: 100, az: 400, bx: 100, bz: 0 }], 100, 400);
  if (!a) throw new Error('no anchor');
  return a;
}

function course(id: string): CourseDef {
  const c = findCourse(id);
  if (!c) throw new Error(`no course ${id}`);
  return c;
}

/** Lateral offset of the ideal line through every gate centre (linear between gates). */
function idealOffset(c: CourseDef, s: number): number {
  const g = c.gates;
  const first = g[0];
  const last = g[g.length - 1];
  if (!first || !last) return 0;
  if (s <= first.s) return first.offset;
  if (s >= last.s) return last.offset;
  for (let i = 0; i + 1 < g.length; i++) {
    const a = g[i];
    const b = g[i + 1];
    if (a && b && s >= a.s && s <= b.s) return a.offset + ((b.offset - a.offset) * (s - a.s)) / (b.s - a.s);
  }
  return 0;
}

interface DriveOptions {
  speed?: number;
  /** Replaces the lateral offset at `s`. */
  offsetAt?: (s: number) => number;
  /** Stand still at the stop box for this long (s). */
  stopFor?: number;
  endS?: number;
  startS?: number;
}

interface Drive {
  run: DrivingCourseRun;
  events: EventMap['training:course'][];
  sim: number;
}

function drive(c: CourseDef, opts: DriveOptions = {}): Drive {
  const a = anchor();
  const bus = new EventBus<EventMap>();
  const events: EventMap['training:course'][] = [];
  bus.on('training:course', (e) => events.push(e));
  const run = new DrivingCourseRun(c, a, bus);
  const speed = opts.speed ?? 10;
  const out = { x: 0, z: 0 };
  let s = opts.startS ?? -5;
  let sim = 0;
  let stoppedFor = 0;
  const endS = opts.endS ?? 260;
  while (s < endS && !run.done && !run.aborted) {
    const off = opts.offsetAt ? opts.offsetAt(s) : idealOffset(c, s);
    coursePoint(a, s, off, out);
    const box = c.stopBox;
    const inBox = box !== null && s >= box.s + 1 && s <= box.s + box.length - 1;
    if (inBox && opts.stopFor !== undefined && stoppedFor < opts.stopFor) {
      run.step(out.x, out.z, 0, sim);
      stoppedFor += DT;
    } else {
      run.step(out.x, out.z, speed, sim);
      s += speed * DT;
    }
    sim += DT;
  }
  return { run, events, sim };
}

describe('course data', () => {
  it('ships basic, slalom and precision with the specified sizes', () => {
    expect(COURSES.map((c) => c.id)).toEqual(['basic', 'slalom', 'precision']);
    const b = course('basic');
    expect([b.gates.length, b.cones.length, b.parTimeS, b.stopBox]).toEqual([8, 12, 45, null]);
    const sl = course('slalom');
    expect([sl.gates.length, sl.cones.length, sl.parTimeS]).toEqual([10, 20, 50]);
    expect(sl.gates.map((g) => g.offset)).toEqual([2, -2, 2, -2, 2, -2, 2, -2, 2, -2]);
    const p = course('precision');
    expect([p.gates.length, p.cones.length, p.parTimeS]).toEqual([6, 24, 60]);
    expect(p.gates.every((g) => g.width === 2.8)).toBe(true);
    expect(p.stopBox).not.toBeNull();
  });

  it('rejects malformed course files naming the path', () => {
    expect(() => parseCourses({ version: 2, courses: [] }, 'x.json')).toThrow('x.json: version');
    const bad = { version: 1, courses: [{ id: 'a', label: 'A', parTimeS: 10, gates: [{ s: 20, offset: 0, width: 3 }, { s: 10, offset: 0, width: 3 }], cones: [], stopBox: null, penalties: { cone: 1, missedGate: 1, stopBox: 1, perSecondOver: 1 } }] };
    expect(() => parseCourses(bad, 'x.json')).toThrow('courses[0].gates[1].s');
  });
});

describe('anchor picking', () => {
  it('picks the nearest long segment, lower index on ties, null when none is long enough', () => {
    const segs = [
      { ax: 0, az: 0, bx: 100, bz: 0 },
      { ax: 500, az: 0, bx: 500, bz: -400 },
      { ax: -300, az: 0, bx: -300, bz: 400 },
      { ax: 300, az: 0, bx: 300, bz: 400 },
    ];
    const a = pickCourseSegment(segs, 0, 0);
    expect(a?.x).toBe(-300);
    expect(a?.length).toBe(400);
    expect(pickCourseSegment(segs, 0, 0, 1000)).toBeNull();
    expect(pickCourseSegment([], 0, 0)).toBeNull();
    // Equidistant starts (-300, 0) and (300, 0) from the origin: the lower index (the segment at -300) wins.
    expect(pickCourseSegment([segs[3]!, segs[2]!], 0, 0)?.x).toBe(300);
  });

  it('facing north the right is east, and the course frame maps s and offset to world metres', () => {
    const a = anchor();
    expect([a.dirX, a.dirZ, a.rightX, a.rightZ]).toEqual([0, -1, 1, 0]);
    const p = coursePoint(a, 50, 2, { x: 0, z: 0 });
    expect(p.x).toBeCloseTo(102);
    expect(p.z).toBeCloseTo(350);
    const south = pickCourseSegment([{ ax: 0, az: 0, bx: 0, bz: 400 }], 0, 0);
    expect([south?.rightX, south?.rightZ]).toEqual([-1, 0]);
  });

  it('writes the cone positions', () => {
    const c = course('basic');
    const out = new Float32Array(c.cones.length * 2);
    expect(conePositions(anchor(), c, out)).toBe(12);
    const first = c.cones[0]!;
    expect(out[0]).toBeCloseTo(100 + first.offset);
    expect(out[1]).toBeCloseTo(400 - first.s);
  });
});

describe('driving a course', () => {
  it.each(['basic', 'slalom', 'precision'])('a drive through every gate centre scores 100 under par (%s)', (id) => {
    const c = course(id);
    const d = drive(c, { stopFor: 0.5 });
    expect(d.run.done).toBe(true);
    expect(d.run.aborted).toBe(false);
    const r = d.run.result();
    expect(r).toMatchObject({ cones: 0, missed: 0, stopOk: true, score: 100 });
    expect(r.timeS).toBeLessThan(c.parTimeS);
    const last = d.events.at(-1);
    expect(last).toMatchObject({ done: true, score: 100, gate: c.gates.length, gates: c.gates.length });
  });

  it('clipping a cone and missing a gate costs the penalties', () => {
    const c = course('basic');
    // Gate and cones at s = 60: swing 2.4 m right between s 55 and 65 (hits the +2.4 cone, misses the 4 m wide gate).
    const d = drive(c, { offsetAt: (s) => (s >= 55 && s <= 65 ? 2.4 : 0) });
    const r = d.run.result();
    expect(r.cones).toBe(1);
    expect(r.missed).toBe(1);
    expect(r.score).toBe(100 - 2 - 5);
    expect(d.run.coneHits().reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('a cone is counted once however long the car stays on it', () => {
    const c = course('basic');
    const d = drive(c, { speed: 1, offsetAt: (s) => (s >= 55 && s <= 65 ? 2.4 : 0), endS: 70 });
    expect(d.run.result().cones).toBe(1);
  });

  it('time over par costs a point per second', () => {
    const c = course('basic');
    const d = drive(c, { speed: 4 });
    const r = d.run.result();
    expect(r.timeS).toBeGreaterThan(c.parTimeS);
    expect(r.score).toBe(Math.round(100 - (r.timeS - c.parTimeS)));
  });

  it('the stop box needs the car to stop; skipping it costs the stop-box penalty', () => {
    const c = course('precision');
    const stopped = drive(c, { stopFor: 0.5 }).run.result();
    expect(stopped.stopOk).toBe(true);
    expect(stopped.score).toBe(100);
    const skipped = drive(c, { endS: 300 }).run;
    expect(skipped.done).toBe(true);
    const r = skipped.result();
    expect(r.stopOk).toBe(false);
    expect(r.score).toBe(100 - 5);
  });

  it('aborts far off the axis and before the start; unresolved gates count as missed', () => {
    const c = course('basic');
    const wide = drive(c, { offsetAt: (s) => (s > 40 ? 20 : 0) });
    expect(wide.run.aborted).toBe(true);
    expect(wide.run.done).toBe(false);
    expect(wide.run.result().missed).toBeGreaterThan(0);
    expect(wide.events.at(-1)?.done).toBe(false);
    const back = drive(c, { startS: -29, speed: -10, endS: 0 });
    expect(back.run.aborted).toBe(true);
  });

  it('emits training:course on gates, cones and the finish', () => {
    const d = drive(course('basic'), { offsetAt: (s) => (s >= 55 && s <= 65 ? 2.4 : 0) });
    expect(d.events.length).toBeGreaterThanOrEqual(8);
    expect(d.events.filter((e) => e.cones === 1).length).toBeGreaterThan(0);
    expect(d.events.map((e) => e.gate)).toEqual([...d.events.map((e) => e.gate)].sort((a, b) => a - b));
    expect(d.events.at(-1)?.done).toBe(true);
  });

  it('serialize / restore mid-run continues identically', () => {
    const c = course('slalom');
    const a = anchor();
    const out = { x: 0, z: 0 };
    const bus = new EventBus<EventMap>();
    const full = new DrivingCourseRun(c, a, bus);
    const part = new DrivingCourseRun(c, a, bus);
    let restored: DrivingCourseRun | null = null;
    let sim = 0;
    for (let s = -5; s < 260; s += 10 * DT, sim += DT) {
      coursePoint(a, s, idealOffset(c, s) + (s > 100 && s < 110 ? 1.5 : 0), out);
      full.step(out.x, out.z, 10, sim);
      if (restored) restored.step(out.x, out.z, 10, sim);
      else {
        part.step(out.x, out.z, 10, sim);
        if (s > 120) {
          const save = JSON.parse(JSON.stringify(part.serialize())) as ReturnType<DrivingCourseRun['serialize']>;
          expect(isCourseRunSave(save)).toBe(true);
          restored = new DrivingCourseRun(c, a, bus, save);
        }
      }
    }
    expect(restored).not.toBeNull();
    expect(restored?.serialize()).toEqual(full.serialize());
    expect(restored?.result().score).toBe(full.result().score);
  });

  it('isCourseRunSave rejects malformed saves', () => {
    expect(isCourseRunSave(null)).toBe(false);
    expect(isCourseRunSave({})).toBe(false);
    const ok = new DrivingCourseRun(course('basic'), anchor(), new EventBus<EventMap>()).serialize();
    expect(isCourseRunSave(ok)).toBe(true);
    expect(isCourseRunSave({ ...ok, coneHit: [2] })).toBe(false);
    expect(isCourseRunSave({ ...ok, gateIdx: -1 })).toBe(false);
  });
});

describe('course step performance', () => {
  it('step is fast and allocates nothing in steady state', async () => {
    const gc = await loadGc();
    const c = course('precision');
    const a = anchor();
    const run = new DrivingCourseRun(c, a, new EventBus<EventMap>());
    const out = { x: 0, z: 0 };
    // A car idling at s = 10 beside the course: no gate, cone or stop event ever fires.
    coursePoint(a, 10, 0, out);
    const x = out.x;
    const z = out.z;
    for (let i = 0; i < 8000; i++) run.step(x, z, 3, i * DT);
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) run.step(x, z, 3, i * DT);
    const perStepMs = (performance.now() - t0) / 20000;
    expect(perStepMs).toBeLessThan(0.002);
    let least = Infinity;
    for (let k = 0; k < 16; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100; i++) run.step(x, z, 3, i * DT);
      least = Math.min(least, process.memoryUsage().heapUsed - before);
    }
    expect(least).toBeLessThan(40_000);
  }, 30000);
});
