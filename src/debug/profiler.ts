/** Frame phases reported next to the per-system rows. */
export const PROFILE_PHASES = ['sim', 'update', 'render'] as const;
export type ProfilePhase = (typeof PROFILE_PHASES)[number];

/** One profiled system (or frame phase): call count, mean, 95th percentile, maximum and total in milliseconds. */
export interface ProfileRow {
  name: string;
  count: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  /** Fraction of the summed totals of the same table (systems: all systems; phases: all phases). */
  share: number;
}

export interface ProfileReport {
  /** Fixed steps counted by `endStep`. */
  steps: number;
  /** Frames: the largest sample count of any frame phase. */
  frames: number;
  /** Systems sorted by total time, descending. */
  systems: ProfileRow[];
  /** `sim`, `update` and `render`, in that order. */
  phases: ProfileRow[];
}

const BUCKETS = 64;
/** Histogram origin: bucket 0 holds everything up to 1 microsecond-ish (`ms / ORIGIN_MS < 2^0.25`). */
const ORIGIN_MS = 0.001;
const BUCKETS_PER_OCTAVE = 4;

/** Histogram bucket of `ms`: `clamp(floor(4 * log2(ms / 0.001)), 0, 63)`. */
function bucketOf(ms: number): number {
  if (!(ms > ORIGIN_MS)) return 0;
  const b = Math.floor(BUCKETS_PER_OCTAVE * Math.log2(ms / ORIGIN_MS));
  return b >= BUCKETS ? BUCKETS - 1 : b < 0 ? 0 : b;
}

/** Upper edge (ms) of histogram bucket `b`. */
function bucketUpperMs(b: number): number {
  return ORIGIN_MS * 2 ** ((b + 1) / BUCKETS_PER_OCTAVE);
}

/** Running statistics of one series; created on first sight, then updated without allocating. */
class Series {
  count = 0;
  total = 0;
  max = 0;
  readonly hist = new Uint32Array(BUCKETS);
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  add(ms: number): void {
    this.count++;
    this.total += ms;
    if (ms > this.max) this.max = ms;
    const b = bucketOf(ms);
    this.hist[b] = (this.hist[b] ?? 0) + 1;
  }

  clear(): void {
    this.count = 0;
    this.total = 0;
    this.max = 0;
    this.hist.fill(0);
  }

  p95(): number {
    if (this.count === 0) return 0;
    const rank = Math.ceil(this.count * 0.95);
    let seen = 0;
    for (let b = 0; b < BUCKETS; b++) {
      seen += this.hist[b] ?? 0;
      if (seen >= rank) return bucketUpperMs(b);
    }
    return bucketUpperMs(BUCKETS - 1);
  }

  row(): ProfileRow {
    return {
      name: this.name,
      count: this.count,
      meanMs: this.count === 0 ? 0 : this.total / this.count,
      p95Ms: this.p95(),
      maxMs: this.max,
      totalMs: this.total,
      share: 0,
    };
  }
}

/**
 * Per-system CPU profiler for the fixed step and the frame phases. `record` is allocation-free once a name has been
 * seen (one Map lookup into a preallocated series); `report` allocates and belongs to tools and the 2 Hz overlay.
 * It only reads durations it is given, so it never touches simulation state.
 */
export class SystemProfiler {
  private readonly series = new Map<string, Series>();
  private readonly phases: Series[] = PROFILE_PHASES.map((p) => new Series(p));
  private stepCount = 0;
  readonly maxSystems: number;

  constructor(maxSystems = 64) {
    this.maxSystems = maxSystems;
  }

  /** Adds one run of system `name` that took `ms`. Systems beyond `maxSystems` distinct names are ignored. */
  record(name: string, ms: number): void {
    let s = this.series.get(name);
    if (s === undefined) {
      if (this.series.size >= this.maxSystems) return;
      s = new Series(name);
      this.series.set(name, s);
    }
    s.add(ms);
  }

  /** Counts one fixed step (`SystemRegistry.runAll` calls it after the systems). */
  endStep(): void {
    this.stepCount++;
  }

  /** Adds one frame's time for a phase. */
  frame(phase: ProfilePhase, ms: number): void {
    const i = PROFILE_PHASES.indexOf(phase);
    if (i >= 0) this.phases[i]?.add(ms);
  }

  /** Forgets every sample (names stay registered). */
  reset(): void {
    this.stepCount = 0;
    for (const s of this.series.values()) s.clear();
    for (const p of this.phases) p.clear();
  }

  /** Builds the report (allocates). */
  report(): ProfileReport {
    const systems: ProfileRow[] = [];
    let sum = 0;
    for (const s of this.series.values()) {
      if (s.count === 0) continue;
      systems.push(s.row());
      sum += s.total;
    }
    systems.sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));
    for (const r of systems) r.share = sum > 0 ? r.totalMs / sum : 0;
    const phases = this.phases.map((p) => p.row());
    const phaseSum = phases.reduce((acc, r) => acc + r.totalMs, 0);
    for (const r of phases) r.share = phaseSum > 0 ? r.totalMs / phaseSum : 0;
    let frames = 0;
    for (const p of phases) if (p.count > frames) frames = p.count;
    return { steps: this.stepCount, frames, systems, phases };
  }
}

/** Markdown table of the `top` heaviest systems: system | mean ms | p95 | max | share. */
export function formatProfile(report: ProfileReport, top = 15): string {
  const lines = ['| system | mean ms | p95 | max | share |', '|---|---:|---:|---:|---:|'];
  for (const r of report.systems.slice(0, Math.max(0, top))) {
    lines.push(`| ${r.name} | ${r.meanMs.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.maxMs.toFixed(3)} | ${(r.share * 100).toFixed(1)}% |`);
  }
  return lines.join('\n');
}
