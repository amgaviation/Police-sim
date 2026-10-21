import type { SystemProfiler } from './profiler';
import { RollingStats, formatBytes, topEntries } from './stats';

/** Per-frame numbers fed to the overlay; the caller may reuse one object. */
export interface PerfSample {
  fps: number;
  frameMs: number;
  simMs: number;
  /** Fixed steps run during this frame. */
  steps: number;
  drawCalls: number;
  triangles: number;
  entities: number;
  /** Last run time per system, typically `SystemRegistry.timings`. */
  systemTimings?: ReadonlyMap<string, number>;
}

export interface PerfOverlayOptions {
  /** Element the panel is appended to; defaults to `document.body`. */
  parent?: HTMLElement;
  /** DOM refresh rate in updates per second. Default 4. */
  updateHz?: number;
  /** Number of frames in the rolling window. Default 60. */
  windowSize?: number;
  /** Start visible. Default false. */
  visible?: boolean;
  /** Clock used for refresh throttling; defaults to `performance.now`. */
  now?: () => number;
}

interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const TOP_SYSTEMS = 5;
/** The profiler lines are rebuilt this often (2 Hz): `report()` allocates. */
const PROFILER_REFRESH_MS = 500;

const PANEL_STYLE = [
  'position:fixed',
  'top:8px',
  'left:8px',
  'z-index:1000',
  'margin:0',
  'padding:6px 8px',
  'min-width:220px',
  'background:rgba(0,0,0,0.65)',
  'color:#d6f0d6',
  // Scales with the accessibility text size (--text-scale on <html>).
  'font:calc(12px * var(--text-scale, 1))/1.35 ui-monospace, Menlo, Consolas, monospace',
  'white-space:pre',
  'pointer-events:none',
  'border-radius:4px',
].join(';');

function readHeap(): MemoryInfo | undefined {
  if (typeof performance === 'undefined') return undefined;
  const memory = (performance as { memory?: Partial<MemoryInfo> }).memory;
  if (!memory || typeof memory.usedJSHeapSize !== 'number') return undefined;
  return { usedJSHeapSize: memory.usedJSHeapSize, jsHeapSizeLimit: memory.jsHeapSizeLimit ?? 0 };
}

/**
 * Fixed top-left performance panel. `record()` is cheap and allocation-free;
 * the DOM text is rebuilt at most `updateHz` times per second.
 */
export class PerfOverlay {
  private readonly panel: HTMLPreElement | null;
  private readonly frameMs: RollingStats;
  private readonly simMs: RollingStats;
  private readonly updateIntervalMs: number;
  private readonly now: () => number;
  private readonly extras = new Map<string, string>();
  private latest: PerfSample = {
    fps: 0,
    frameMs: 0,
    simMs: 0,
    steps: 0,
    drawCalls: 0,
    triangles: 0,
    entities: 0,
  };
  private lastRender = -Infinity;
  private shown: boolean;
  private profiler: SystemProfiler | null = null;
  private profilerLines: string[] = [];
  private profilerAt = -Infinity;

  constructor(options: PerfOverlayOptions = {}) {
    const windowSize = options.windowSize ?? 60;
    this.frameMs = new RollingStats(windowSize);
    this.simMs = new RollingStats(windowSize);
    this.updateIntervalMs = 1000 / (options.updateHz ?? 4);
    this.now = options.now ?? (() => performance.now());
    this.shown = options.visible ?? false;
    if (typeof document === 'undefined') {
      this.panel = null;
    } else {
      const panel = document.createElement('pre');
      panel.id = 'perf-overlay';
      panel.setAttribute('style', PANEL_STYLE);
      panel.style.display = this.shown ? 'block' : 'none';
      (options.parent ?? document.body).appendChild(panel);
      this.panel = panel;
    }
  }

  get visible(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.setVisible(!this.shown);
  }

  setVisible(visible: boolean): void {
    this.shown = visible;
    if (this.panel) this.panel.style.display = visible ? 'block' : 'none';
    if (visible) this.lastRender = -Infinity;
  }

  /** Attaches the profiler whose top systems by mean (mean / p95 ms) replace the last-run list; null detaches. */
  setProfiler(profiler: SystemProfiler | null): void {
    this.profiler = profiler;
    this.profilerLines = [];
    this.profilerAt = -Infinity;
  }

  /** Adds or replaces an extra line (e.g. `setExtra('worker ping', '1.2 ms')`). */
  setExtra(key: string, value: string | number | undefined): void {
    if (value === undefined) this.extras.delete(key);
    else this.extras.set(key, typeof value === 'number' ? value.toFixed(2) : value);
  }

  /** Records one frame; call once per rendered frame. */
  record(sample: PerfSample): void {
    this.frameMs.push(sample.frameMs);
    this.simMs.push(sample.simMs);
    this.latest = sample;
    if (!this.shown || !this.panel) return;
    const t = this.now();
    if (t - this.lastRender < this.updateIntervalMs) return;
    this.lastRender = t;
    this.panel.textContent = this.renderText();
  }

  /** The panel text for the most recent sample (also used for the DOM). */
  renderText(): string {
    const s = this.latest;
    const lines: string[] = [
      `fps        ${s.fps.toFixed(0).padStart(6)}`,
      `frame ms   ${this.frameMs.average().toFixed(2).padStart(6)}  1% low ${this.frameMs.worstAverage(0.01).toFixed(2)}`,
      `sim ms     ${this.simMs.average().toFixed(2).padStart(6)}  steps/frame ${String(s.steps)}`,
      `draw calls ${String(s.drawCalls).padStart(6)}  tris ${String(s.triangles)}`,
      `entities   ${String(s.entities).padStart(6)}`,
    ];
    const profiled = this.profiler ? this.profilerSection() : null;
    if (profiled && profiled.length > 0) {
      lines.push('systems  mean / p95 ms');
      for (const line of profiled) lines.push(line);
    } else if (s.systemTimings && s.systemTimings.size > 0) {
      lines.push('systems');
      for (const entry of topEntries(s.systemTimings, TOP_SYSTEMS)) {
        lines.push(`  ${entry.name.padEnd(18).slice(0, 18)} ${entry.ms.toFixed(3).padStart(7)}`);
      }
    }
    const heap = readHeap();
    if (heap) lines.push(`js heap    ${formatBytes(heap.usedJSHeapSize)}`);
    for (const [key, value] of this.extras) lines.push(`${key.padEnd(10).slice(0, 10)} ${value}`);
    return lines.join('\n');
  }

  /** Top systems by mean from the profiler, rebuilt at most every `PROFILER_REFRESH_MS`. */
  private profilerSection(): string[] {
    const profiler = this.profiler;
    if (!profiler) return this.profilerLines;
    const t = this.now();
    if (t - this.profilerAt < PROFILER_REFRESH_MS) return this.profilerLines;
    this.profilerAt = t;
    const rows = profiler.report().systems.slice().sort((a, b) => b.meanMs - a.meanMs || a.name.localeCompare(b.name));
    this.profilerLines = rows
      .slice(0, TOP_SYSTEMS)
      .map((r) => `  ${r.name.padEnd(18).slice(0, 18)} ${r.meanMs.toFixed(3).padStart(7)} / ${r.p95Ms.toFixed(3)}`);
    return this.profilerLines;
  }

  dispose(): void {
    this.panel?.remove();
    this.extras.clear();
  }
}
