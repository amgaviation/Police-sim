import './review.css';
import type { Menu, UIRoot } from '../ui';
import { div, setClass, setText } from '../panels/dom';
import type { SnapshotMeta } from '../../recording/mediaStore';
import {
  camSegments,
  createReviewState,
  eventIndexAt,
  formatReviewTime,
  nearestSnapshot,
  reduceReviewKey,
  type ReviewEvent,
  type ReviewFooter,
  type ReviewSource,
} from '../../recording/timeline';

/** Real milliseconds per played sim second (4x speed). */
export const REVIEW_PLAY_MS_PER_S = 250;
/** A frame longer than this (hidden tab) advances playback by this much only. */
const MAX_FRAME_MS = 500;
/** DOM refresh interval while playing (about 30 Hz). */
const PAINT_MS = 33;

const SEVERITY_MARK = { info: '', warn: '!', bad: '!!' } as const;

interface ReviewDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly img: HTMLImageElement;
  readonly noVideo: HTMLDivElement;
  readonly clock: HTMLSpanElement;
  readonly mode: HTMLSpanElement;
  readonly scrub: HTMLInputElement;
  readonly strip: HTMLDivElement;
  readonly playhead: HTMLDivElement;
  readonly list: HTMLDivElement;
  readonly footLines: HTMLDivElement;
  readonly footOptions: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const HINT = 'Space play / pause · ←→ 1 s (Shift 10 s) · ↑↓ event · Home / End · 1-9 options · Esc close';

/**
 * Evidence review (design phase 5 §8.4): a pausing `Menu` that plays back an incident's bodycam / dashcam record: the
 * nearest 160x90 snapshot (or NO VIDEO), a scrubber with the REC / MUTED / OFF / DASH strip, the event list and an
 * optional footer (lines and numbered options, used by the IA statement). The app calls `update(nowMs)` every frame
 * while it is open (the world is paused, the render loop is not). Keys go through `reduceReviewKey`. Headless it keeps the
 * playhead, playback and image requests but builds no DOM.
 */
export class EvidenceReviewPanel implements Menu {
  readonly id = 'review' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly dom: ReviewDom | null;
  private src: ReviewSource | null = null;
  private footer: ReviewFooter | null = null;
  private onClose: (() => void) | null = null;
  private openFlag = false;
  private tNow = 0;
  private playing = false;
  private focus = -1;
  private lastMs = -1;
  private lastPaint = 0;
  private snaps: readonly SnapshotMeta[] = [];
  private snapIdx = -1;
  private imageToken = 0;
  private url: string | null = null;
  private optionCount = 0;
  // DOM caches: what the elements currently show.
  private rows: HTMLDivElement[] = [];
  private rowClass: string[] = [];
  private shownFocus = -1;
  private shownSec = -1;
  private shownT = Number.NaN;
  private shownPlaying: boolean | null = null;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** Playhead in sim seconds. */
  get time(): number {
    return this.tNow;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Index of the selected event (-1 before the first). */
  get focusIndex(): number {
    return this.focus;
  }

  /** Opens the review at the start of `src`. `onClose` is called when the user closes the panel (Escape), not by `close()`. */
  open(src: ReviewSource, footer?: ReviewFooter, onClose?: () => void): void {
    this.releaseImage();
    this.src = src;
    this.footer = footer ?? null;
    this.onClose = onClose ?? null;
    const st = createReviewState(src);
    this.tNow = st.t;
    this.playing = false;
    this.focus = st.focus;
    this.lastMs = -1;
    this.snaps = [];
    this.snapIdx = -1;
    this.openFlag = true;
    this.buildContent(src);
    this.refreshFooter();
    this.paint(true);
    const token = this.imageToken;
    src.snapshots().then(
      (list) => {
        if (token !== this.imageToken || !this.openFlag) return;
        this.snaps = list;
        this.snapIdx = -2;
        this.sync();
      },
      () => undefined,
    );
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Closes the panel without calling the `onClose` handler. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.onClose = null;
    this.releaseImage();
    this.src = null;
    this.footer = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  /** Re-reads the footer's lines and options (call after the footer's own state changed). */
  refreshFooter(): void {
    const f = this.footer;
    const lines = f ? f.lines() : [];
    const options = f ? f.options() : [];
    this.optionCount = options.length;
    const dom = this.dom;
    if (!dom) return;
    dom.footLines.replaceChildren();
    for (const line of lines) {
      const e = div('rev-foot-line', dom.footLines);
      e.textContent = line;
    }
    dom.footOptions.replaceChildren();
    for (let i = 0; i < options.length; i++) {
      const b = document.createElement('button');
      b.className = 'rev-option';
      b.type = 'button';
      b.textContent = `${String(i + 1)}. ${options[i] ?? ''}`;
      b.addEventListener('click', () => {
        this.pickOption(i);
      });
      dom.footOptions.appendChild(b);
    }
  }

  /** Per frame while open: playback (1 sim s per 250 ms real) and the image swap when the nearest snapshot changes. */
  update(nowMs: number): void {
    const src = this.src;
    if (!this.openFlag || !src) return;
    const last = this.lastMs;
    this.lastMs = nowMs;
    if (!this.playing || last < 0) return;
    const dt = Math.min(nowMs - last, MAX_FRAME_MS) / REVIEW_PLAY_MS_PER_S;
    if (!(dt > 0)) return;
    let t = this.tNow + dt;
    if (t >= src.t1) {
      t = src.t1;
      this.playing = false;
    }
    this.tNow = t;
    this.focus = eventIndexAt(src.events, t);
    this.sync();
    if (!this.playing || nowMs - this.lastPaint >= PAINT_MS) {
      this.lastPaint = nowMs;
      this.paint(false);
    }
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    const src = this.src;
    if (!this.openFlag || !src || event.ctrlKey || event.altKey || event.metaKey) return false;
    const r = reduceReviewKey({ t: this.tNow, playing: this.playing, focus: this.focus }, event.key, src, event.shiftKey);
    if (r.emit === 'close') {
      this.finish();
      return true;
    }
    // Holding Space or a digit never toggles or picks again; navigation keys repeat.
    if (event.repeat && (r.emit !== null || event.key === ' ')) return r.consumed;
    this.tNow = r.state.t;
    this.playing = r.state.playing;
    this.focus = r.state.focus;
    if (r.emit !== null) this.pickOption(r.emit.pick);
    this.sync();
    this.paint(true);
    return r.consumed;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private pickOption(index: number): void {
    if (index < 0 || index >= this.optionCount) return;
    this.footer?.pick(index);
    this.refreshFooter();
  }

  private finish(): void {
    const handler = this.onClose;
    this.close();
    handler?.();
  }

  /** Requests the image of the nearest snapshot when it differs from the one shown. */
  private sync(): void {
    const idx = nearestSnapshot(this.snaps, this.tNow);
    if (idx === this.snapIdx) return;
    this.snapIdx = idx;
    const token = ++this.imageToken;
    const meta = this.snaps[idx];
    const src = this.src;
    if (!meta || !src) {
      this.setImage(null);
      return;
    }
    // The previous image stays visible until the new one is ready; a result for a superseded request is dropped.
    src.image(meta.key).then(
      (blob) => {
        if (token === this.imageToken && this.openFlag) this.setImage(blob);
      },
      () => {
        if (token === this.imageToken && this.openFlag) this.setImage(null);
      },
    );
  }

  private setImage(blob: Blob | null): void {
    const dom = this.dom;
    const previous = this.url;
    this.url = dom && blob ? URL.createObjectURL(blob) : null;
    if (dom) {
      if (this.url !== null) {
        dom.img.src = this.url;
      } else {
        dom.img.removeAttribute('src');
      }
      dom.img.hidden = this.url === null;
      dom.noVideo.hidden = this.url !== null;
    }
    if (previous !== null) URL.revokeObjectURL(previous);
  }

  /** Drops pending image requests and revokes the object URL. */
  private releaseImage(): void {
    this.imageToken++;
    this.snaps = [];
    this.snapIdx = -1;
    if (this.url !== null || this.dom) this.setImage(null);
  }

  private seek(t: number): void {
    const src = this.src;
    if (!this.openFlag || !src) return;
    this.tNow = Math.min(src.t1, Math.max(src.t0, t));
    this.focus = eventIndexAt(src.events, this.tNow);
    this.sync();
    this.paint(true);
  }

  /** Writes the playhead, clock, play state and selected row; each element only when its value changed. */
  private paint(force: boolean): void {
    const dom = this.dom;
    const src = this.src;
    if (!dom || !src) return;
    const t = this.tNow;
    if (force) this.lastPaint = this.lastMs;
    const sec = Math.floor(t - src.t0);
    if (sec !== this.shownSec) {
      this.shownSec = sec;
      setText(dom.clock, `${formatReviewTime(t - src.t0)} / ${formatReviewTime(src.t1 - src.t0)}`);
    }
    if (t !== this.shownT) {
      this.shownT = t;
      dom.scrub.value = String(t);
      const span = src.t1 - src.t0;
      dom.playhead.style.left = `${String(span > 0 ? ((t - src.t0) / span) * 100 : 0)}%`;
    }
    if (this.playing !== this.shownPlaying) {
      this.shownPlaying = this.playing;
      setText(dom.mode, this.playing ? 'PLAYING' : 'PAUSED');
    }
    if (this.focus !== this.shownFocus) {
      const old = this.rows[this.shownFocus];
      if (old) setClass(old, this.rowClass[this.shownFocus] ?? '');
      const row = this.rows[this.focus];
      if (row) {
        setClass(row, `${this.rowClass[this.focus] ?? ''} rev-focus`);
        if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
      }
      this.shownFocus = this.focus;
    }
  }

  /** Fills the title, scrubber range, camera strip and event rows for a new source. */
  private buildContent(src: ReviewSource): void {
    const dom = this.dom;
    this.rows = [];
    this.rowClass = [];
    this.shownFocus = -1;
    this.shownSec = -1;
    this.shownT = Number.NaN;
    this.shownPlaying = null;
    if (!dom) return;
    setText(dom.title, src.title);
    dom.scrub.min = String(src.t0);
    dom.scrub.max = String(src.t1);
    const span = src.t1 - src.t0;
    dom.strip.replaceChildren();
    dom.strip.appendChild(dom.playhead);
    for (const seg of camSegments(src.events, src.t0, src.t1)) {
      const e = div(`rev-seg rev-seg-${seg.state}`, dom.strip);
      e.style.left = `${String(((seg.t0 - src.t0) / span) * 100)}%`;
      e.style.width = `${String(((seg.t1 - seg.t0) / span) * 100)}%`;
    }
    dom.list.replaceChildren();
    src.events.forEach((ev: ReviewEvent, i: number) => {
      const cls = `rev-row rev-sev-${ev.severity}`;
      const row = div(cls, dom.list);
      row.setAttribute('role', 'option');
      row.dataset['index'] = String(i);
      const time = div('rev-time', row);
      time.textContent = formatReviewTime(ev.t - src.t0);
      const mark = div('rev-mark', row);
      mark.textContent = SEVERITY_MARK[ev.severity];
      const label = div('rev-label', row);
      label.textContent = ev.label;
      row.addEventListener('click', () => {
        this.seek(ev.t);
        this.focus = i;
        this.paint(true);
      });
      this.rows.push(row);
      this.rowClass.push(cls);
    });
    this.setImage(null);
  }

  private build(): ReviewDom {
    const root = div('rev-panel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Evidence review');
    const title = div('rev-title', root);
    const stage = div('rev-stage', root);
    const img = document.createElement('img');
    img.className = 'rev-img';
    img.alt = 'Camera snapshot';
    img.hidden = true;
    stage.appendChild(img);
    const noVideo = div('rev-novideo', stage);
    noVideo.textContent = 'NO VIDEO';
    const bar = div('rev-bar', root);
    const clock = document.createElement('span');
    clock.className = 'rev-clock';
    const mode = document.createElement('span');
    mode.className = 'rev-mode';
    bar.append(clock, mode);
    const scrub = document.createElement('input');
    scrub.type = 'range';
    scrub.className = 'rev-scrub';
    scrub.step = '0.1';
    scrub.min = '0';
    scrub.max = '0';
    scrub.value = '0';
    scrub.tabIndex = -1;
    scrub.setAttribute('aria-label', 'Playhead');
    scrub.addEventListener('input', () => {
      this.seek(Number(scrub.value));
    });
    root.appendChild(scrub);
    const strip = div('rev-strip', root);
    const playhead = div('rev-playhead', strip);
    const legend = div('rev-legend', root);
    for (const [state, text] of [['rec', 'REC'], ['muted', 'MUTED'], ['off', 'OFF'], ['dash', 'DASH']] as const) {
      const item = document.createElement('span');
      item.className = `rev-key rev-key-${state}`;
      item.textContent = text;
      legend.appendChild(item);
    }
    const list = div('rev-events', root);
    list.setAttribute('role', 'listbox');
    // Focusable so UIRoot moves focus into the panel (keys are handled in onKeyDown).
    list.tabIndex = 0;
    list.setAttribute('autofocus', '');
    const foot = div('rev-foot', root);
    const footLines = div('rev-foot-lines', foot);
    const footOptions = div('rev-options', foot);
    const hint = div('rev-hint', root);
    hint.textContent = HINT;
    return { root, title, img, noVideo, clock, mode, scrub, strip, playhead, list, footLines, footOptions };
  }
}
