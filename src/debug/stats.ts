/**
 * Fixed-capacity ring buffer of numeric samples with rolling aggregates.
 * Pushing never allocates; aggregates that need sorting reuse one scratch buffer.
 */
export class RollingStats {
  readonly capacity: number;
  private readonly samples: Float64Array;
  private readonly scratch: Float64Array;
  private head = 0;
  private size = 0;
  private sum = 0;
  private lastValue = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RollingStats: capacity must be a positive integer, got ${String(capacity)}`);
    }
    this.capacity = capacity;
    this.samples = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  /** Number of samples currently held (at most `capacity`). */
  get count(): number {
    return this.size;
  }

  /** Most recently pushed value, or 0 when empty. */
  get last(): number {
    return this.lastValue;
  }

  /** Adds a sample, evicting the oldest once full. Non-finite values are ignored. */
  push(value: number): void {
    if (!Number.isFinite(value)) return;
    if (this.size === this.capacity) {
      this.sum -= this.samples[this.head] ?? 0;
    } else {
      this.size += 1;
    }
    this.samples[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    this.sum += value;
    this.lastValue = value;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.sum = 0;
    this.lastValue = 0;
  }

  /** Arithmetic mean of the held samples, or 0 when empty. */
  average(): number {
    return this.size === 0 ? 0 : this.sum / this.size;
  }

  min(): number {
    if (this.size === 0) return 0;
    let m = Infinity;
    for (let i = 0; i < this.size; i++) m = Math.min(m, this.samples[i] ?? 0);
    return m;
  }

  max(): number {
    if (this.size === 0) return 0;
    let m = -Infinity;
    for (let i = 0; i < this.size; i++) m = Math.max(m, this.samples[i] ?? 0);
    return m;
  }

  /**
   * Nearest-rank percentile, `p` in [0, 1]; `percentile(0.99)` is the value
   * that 99% of samples are at or below. Returns 0 when empty.
   */
  percentile(p: number): number {
    if (this.size === 0) return 0;
    const clamped = Math.min(1, Math.max(0, p));
    const sorted = this.sorted();
    const rank = Math.max(1, Math.ceil(clamped * this.size));
    return sorted[rank - 1] ?? 0;
  }

  /**
   * Mean of the highest `fraction` of samples (at least one sample), e.g.
   * `worstAverage(0.01)` is the classic "1% low" frame time. Returns 0 when empty.
   */
  worstAverage(fraction: number): number {
    if (this.size === 0) return 0;
    const clamped = Math.min(1, Math.max(0, fraction));
    const n = Math.max(1, Math.ceil(clamped * this.size));
    const sorted = this.sorted();
    let total = 0;
    for (let i = this.size - n; i < this.size; i++) total += sorted[i] ?? 0;
    return total / n;
  }

  private sorted(): Float64Array {
    const view = this.scratch.subarray(0, this.size);
    view.set(this.samples.subarray(0, this.size));
    view.sort();
    return view;
  }
}

/** Exponential moving average step. */
export function ema(previous: number, value: number, smoothing: number): number {
  return previous + (value - previous) * smoothing;
}

export interface TimingEntry {
  readonly name: string;
  readonly ms: number;
}

/** The `limit` largest entries of a timing map, descending by value then by name. */
export function topEntries(timings: ReadonlyMap<string, number>, limit: number): TimingEntry[] {
  const entries: TimingEntry[] = [];
  for (const [name, ms] of timings) entries.push({ name, ms });
  entries.sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name));
  return entries.slice(0, Math.max(0, limit));
}

/** Formats a byte count as a short human-readable string (e.g. "12.3 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? ''}`;
}
