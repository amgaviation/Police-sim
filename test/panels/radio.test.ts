import { afterEach, describe, expect, it } from 'vitest';
import { RadioMenu, type MenuContext } from '../../src/radio/menu';
import { setRadioRequestTypes, type RadioRequestType } from '../../src/radio/requestTypes';
import { RADIO_LINE_CAP, RADIO_STATUS_MS, RadioPanel, radioLineClass } from '../../src/ui/panels/radioPanel';
import { RadioMenuView } from '../../src/ui/panels/radioMenuView';
import {
  chargeWidth,
  radioLineText,
  radioMenuOptionText,
  radioModeLabel,
  radioStatusText,
  type RadioLine,
  type RadioStatusView,
} from '../../src/ui/panels/text';

const line = (id: number, o: Partial<RadioLine> = {}): RadioLine => ({
  id,
  channel: 'DISP',
  speaker: 'Dispatch',
  text: `message ${String(id)}`,
  clock: '14:05',
  blocked: false,
  priority: false,
  self: false,
  ...o,
});

const status = (o: Partial<RadioStatusView> = {}): RadioStatusView => ({
  channel: 'DISP',
  scanning: false,
  tx: false,
  rx: false,
  busy: false,
  emergency: false,
  mode: 'tenCode',
  voice: 'off',
  emergencyCharge: 0,
  ...o,
});

describe('radioLineText', () => {
  it('formats time, channel tag, speaker and text', () => {
    expect(radioLineText(line(1, { text: '12, 10-4' }))).toBe('14:05 DISP Dispatch: 12, 10-4');
    expect(radioLineText(line(1, { speaker: '12', text: 'show me 10-8', self: true }))).toBe('14:05 DISP 12: show me 10-8');
  });

  it('marks blocked lines and tolerates missing clock or speaker', () => {
    expect(radioLineText(line(1, { blocked: true, text: 'unit transmitting' }))).toBe('14:05 DISP Dispatch: unit transmitting [blocked]');
    expect(radioLineText(line(1, { clock: '', speaker: '', text: 'static' }))).toBe('DISP static');
  });

  it('builds the css class from the flags', () => {
    expect(radioLineClass(line(1))).toBe('radio-line');
    expect(radioLineClass(line(1, { self: true, priority: true, blocked: true }))).toBe('radio-line radio-self radio-priority radio-blocked');
  });
});

describe('radioStatusText', () => {
  it('shows the channel and mode at rest', () => {
    expect(radioStatusText(status())).toBe('DISP · 10-CODE');
    expect(radioStatusText(status({ mode: 'plain', channel: 'tac2' }))).toBe('TAC2 · PLAIN');
  });

  it('orders SCAN, TX/BUSY/RX, EMERG, mode and voice', () => {
    expect(radioStatusText(status({ scanning: true, tx: true, busy: true, rx: true, emergency: true, voice: 'listening' }))).toBe(
      'DISP · SCAN · TX · EMERG · 10-CODE · LISTENING',
    );
    expect(radioStatusText(status({ busy: true, rx: true }))).toBe('DISP · BUSY · 10-CODE');
    expect(radioStatusText(status({ rx: true, voice: 'ready' }))).toBe('DISP · RX · 10-CODE · VOICE READY');
    expect(radioStatusText(status({ voice: 'unavailable' }))).toBe('DISP · 10-CODE');
  });

  it('labels modes and quantises the emergency charge', () => {
    expect(radioModeLabel('tenCode')).toBe('10-CODE');
    expect(radioModeLabel('plain')).toBe('PLAIN');
    expect(radioModeLabel('other')).toBe('OTHER');
    expect(chargeWidth(0)).toBe('0%');
    expect(chargeWidth(0.52)).toBe('50%');
    expect(chargeWidth(0.53)).toBe('55%');
    expect(chargeWidth(2)).toBe('100%');
    expect(chargeWidth(Number.NaN)).toBe('0%');
  });
});

describe('RadioPanel (headless)', () => {
  it('keeps up to 50 lines, oldest dropped first', () => {
    const panel = new RadioPanel(null);
    for (let i = 1; i <= 60; i++) panel.addLine(line(i));
    expect(panel.lines).toHaveLength(RADIO_LINE_CAP);
    expect(panel.lines[0]?.id).toBe(11);
    expect(panel.lines[RADIO_LINE_CAP - 1]?.id).toBe(60);
    panel.dispose();
  });

  it('marks a line blocked by transmission id', () => {
    const panel = new RadioPanel(null);
    const first = line(1);
    panel.addLine(first);
    panel.addLine(line(2));
    panel.markBlocked(1);
    expect(panel.lines[0]?.blocked).toBe(true);
    expect(panel.lines[1]?.blocked).toBe(false);
    expect(first.blocked).toBe(false);
    panel.markBlocked(99);
    panel.markBlocked(1);
    expect(panel.lines.filter((l) => l.blocked)).toHaveLength(1);
  });

  it('shows the caption until it expires and hides it for null', () => {
    const panel = new RadioPanel(null);
    panel.setCaption('Dispatch: 12, 10-4', 5000);
    expect(panel.caption).toBe('Dispatch: 12, 10-4');
    panel.update(4999);
    expect(panel.caption).toBe('Dispatch: 12, 10-4');
    panel.update(5000);
    expect(panel.caption).toBeNull();
    panel.setCaption('next', 9000);
    panel.setCaption(null, 0);
    expect(panel.caption).toBeNull();
    panel.setCaption('', 9000);
    expect(panel.caption).toBeNull();
  });

  it('writes the channel strip at most 4 Hz', () => {
    const panel = new RadioPanel(null);
    panel.setStatus(status(), 0);
    expect(panel.statusText).toBe('DISP · 10-CODE');
    panel.setStatus(status({ tx: true }), RADIO_STATUS_MS - 1);
    expect(panel.statusText).toBe('DISP · 10-CODE');
    panel.setStatus(status({ tx: true }), RADIO_STATUS_MS);
    expect(panel.statusText).toBe('DISP · TX · 10-CODE');
  });

  it('survives visibility changes and dispose without a DOM', () => {
    const panel = new RadioPanel(null);
    panel.setVisible(false);
    panel.addLine(line(1));
    panel.setVisible(true);
    expect(panel.lines).toHaveLength(1);
    panel.dispose();
  });
});

describe('RadioMenuView (headless)', () => {
  const root = {
    title: 'Radio',
    options: [
      { key: 1, label: 'Status ▸', enabled: true },
      { key: 2, label: 'Run plate', enabled: false },
    ],
  };

  it('formats option lines', () => {
    expect(radioMenuOptionText({ key: 1, label: 'Status ▸' })).toBe('1 Status ▸');
  });

  it('shows a copy of the view, hides for null and skips unchanged views', () => {
    const view = new RadioMenuView(null);
    expect(view.view).toBeNull();
    view.show(root);
    expect(view.view).toEqual(root);
    expect(view.view).not.toBe(root);
    expect(view.renders).toBe(1);
    // A fresh but equal object each frame does not re-render.
    view.show({ title: 'Radio', options: root.options.map((o) => ({ ...o })) });
    expect(view.renders).toBe(1);
    view.show({ ...root, options: [root.options[0]!, { key: 2, label: 'Run plate', enabled: true }] });
    expect(view.renders).toBe(2);
    view.show(null);
    expect(view.view).toBeNull();
    view.show(null);
    expect(view.renders).toBe(3);
    view.dispose();
  });
});

describe('RadioMenuView with the paged Request menu (Phase 6)', () => {
  const MENU_CTX: MenuContext = { mode: 'tenCode', hasTarget: false, hasStop: false, pendingOffer: false, onCall: false, emergency: false };

  afterEach(() => setRadioRequestTypes([]));

  it('shows the Request n/m title and all nine options of a full page', () => {
    setRadioRequestTypes(
      Array.from({ length: 18 }, (_, i): RadioRequestType => ({
        id: `t${String(i)}`, menu: `Type ${String(i)}`, label: `type ${String(i)}`, voice: [], request: { kind: 'resource', typeId: `t${String(i)}` },
      })),
    );
    const menu = new RadioMenu();
    menu.open();
    menu.press(4, MENU_CTX);
    const view = new RadioMenuView(null);
    view.show(menu.view(MENU_CTX));
    expect(view.view?.title).toBe('Request 1/3');
    expect(view.view?.options).toHaveLength(9);
    expect(view.view?.options.map((o) => radioMenuOptionText(o))[8]).toBe('9 More ▸');
    const first = view.renders;
    view.show(menu.view(MENU_CTX));
    expect(view.renders).toBe(first); // unchanged page: no write
    menu.press(9, MENU_CTX);
    view.show(menu.view(MENU_CTX));
    expect(view.view?.title).toBe('Request 2/3');
    expect(view.renders).toBe(first + 1);
    expect(view.view?.options[0]).toMatchObject({ key: 1, label: 'Type 8', enabled: true });
  });
});

// --- Phase 9: the radio menu cursor highlight (design §7.5) ------------------------------------------------------------------

class CursorEl {
  readonly children: CursorEl[] = [];
  parentElement: CursorEl | null = null;
  className = '';
  hidden = false;
  readonly attrs: Record<string, string> = {};
  private text = '';
  /** Times the element's text was written (a rebuild rewrites every row's text). */
  textWrites = 0;
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
    this.textWrites++;
  }
  get firstChild(): CursorEl | null {
    return this.children[0] ?? null;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get classList(): { contains(c: string): boolean } {
    return { contains: (c) => this.className.split(/\s+/).includes(c) };
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  getAttribute(n: string): string | null {
    return this.attrs[n] ?? null;
  }
  appendChild(c: CursorEl): CursorEl {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: CursorEl, ref: CursorEl | null): CursorEl {
    c.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  remove(): void {
    const p = this.parentElement;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentElement = null;
  }
}

describe('RadioMenuView cursor (fake DOM)', () => {
  const g = globalThis as unknown as { document?: unknown; HTMLElement?: unknown };
  const saved = { document: g.document, HTMLElement: g.HTMLElement };
  afterEach(() => {
    if (saved.document === undefined) delete g.document;
    else g.document = saved.document;
    if (saved.HTMLElement === undefined) delete g.HTMLElement;
    else g.HTMLElement = saved.HTMLElement;
  });

  const model = (enabled2 = true) => ({
    title: 'Radio',
    options: [
      { key: 1, label: 'Status ▸', enabled: true },
      { key: 2, label: 'Run plate', enabled: enabled2 },
      { key: 3, label: 'Location', enabled: true },
    ],
  });

  function build(): { view: RadioMenuView; readonly rows: CursorEl[]; root: CursorEl } {
    g.document = { createElement: (): CursorEl => new CursorEl() };
    g.HTMLElement = CursorEl;
    const parent = new CursorEl();
    const view = new RadioMenuView(parent as unknown as HTMLElement);
    const column = parent.children[0] as CursorEl;
    const root = column.children[0] as CursorEl;
    // The rows are created by the first show(): read them lazily.
    return {
      view,
      get rows(): CursorEl[] {
        return root.children.slice(1);
      },
      root,
    };
  }

  it('marks the row at the cursor with is-selected and aria-selected, the others not', () => {
    const ctx = build();
    const { view } = ctx;
    view.show(model(), 0);
    const rows = ctx.rows;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.className.split(' ').includes('is-selected'))).toEqual([true, false, false]);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(view.cursor).toBe(0);
    view.show(model(), 2);
    expect(rows.map((r) => r.className.split(' ').includes('is-selected'))).toEqual([false, false, true]);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true']);
  });

  it('a cursor-only change toggles classes without rebuilding the rows', () => {
    const ctx = build();
    const { view } = ctx;
    view.show(model(), 0);
    const rows = ctx.rows;
    const writes = rows.map((r) => r.textWrites);
    const renders = view.renders;
    view.show(model(), 1);
    view.show(model(), 2);
    expect(rows.map((r) => r.textWrites)).toEqual(writes);
    expect(view.renders).toBe(renders + 2);
    view.show(model(), 2); // nothing changed: nothing written
    expect(view.renders).toBe(renders + 2);
  });

  it('keeps the disabled look next to the selection, and a changed menu rebuilds the rows', () => {
    const ctx = build();
    const { view } = ctx;
    view.show(model(false), 1);
    const rows = ctx.rows;
    expect(rows[1]?.className).toBe('radio-menu-option radio-menu-disabled is-selected');
    expect(rows[0]?.className).toBe('radio-menu-option');
    view.show({ title: 'Status', options: [{ key: 1, label: 'Available', enabled: true }] }, 0);
    expect(rows[0]?.textContent).toBe('1 Available');
    expect(rows[1]?.hidden).toBe(true);
    expect(rows[0]?.className).toBe('radio-menu-option is-selected');
  });

  it('defaults to no cursor, hides with null and resets the cursor', () => {
    const ctx = build();
    const { view, root } = ctx;
    view.show(model());
    const rows = ctx.rows;
    expect(rows.some((r) => r.className.includes('is-selected'))).toBe(false);
    expect(view.cursor).toBe(-1);
    view.show(model(), 1);
    view.show(null, 1);
    expect(root.hidden).toBe(true);
    expect(view.view).toBeNull();
    expect(view.cursor).toBe(-1);
  });

  it('is a headless no-op that still remembers the view and the cursor', () => {
    delete g.document;
    const view = new RadioMenuView(null);
    view.show(model(), 2);
    expect(view.view?.title).toBe('Radio');
    expect(view.cursor).toBe(2);
    view.show(model(), 0);
    expect(view.cursor).toBe(0);
  });
});
