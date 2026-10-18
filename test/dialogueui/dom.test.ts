import { afterEach, describe, expect, it } from 'vitest';
import { DialoguePanel, TRANSCRIPT_LINES } from '../../src/ui/dialogue/dialoguePanel';
import { SfstPanel } from '../../src/ui/dialogue/sfstPanel';
import { SubtitleBar } from '../../src/ui/dialogue/subtitleBar';
import type { Menu, UIRoot } from '../../src/ui/ui';
import { handlers, keyEvent, sfst, view } from './fixtures';

/** The few DOM members the panels use, enough to exercise their rendering without a browser. */
class FakeEl {
  className = '';
  textContent = '';
  hidden = false;
  tabIndex = -1;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}

class FakeUi {
  readonly stack: Menu[] = [];
  push(m: Menu): void {
    if (!this.stack.includes(m)) this.stack.push(m);
  }
  pop(m: Menu): void {
    const i = this.stack.indexOf(m);
    if (i < 0) return;
    this.stack.splice(i, 1);
    m.onHide?.();
  }
  isOpen(m: Menu): boolean {
    return this.stack.includes(m);
  }
}

function install(): FakeUi {
  Reflect.set(globalThis, 'document', { createElement: () => new FakeEl() });
  return new FakeUi();
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

const asUi = (ui: FakeUi): UIRoot => ui as unknown as UIRoot;
const fake = (e: HTMLElement): FakeEl => e as unknown as FakeEl;

function find(root: FakeEl, cls: string): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (e: FakeEl): void => {
    if (e.className.split(' ').includes(cls)) out.push(e);
    for (const c of e.children) walk(c);
  };
  walk(root);
  return out;
}

const visibleRows = (root: FakeEl): FakeEl[] => (find(root, 'dlg-body')[0]?.children ?? []).filter((r) => !r.hidden);
const labels = (rows: FakeEl[]): string[] => rows.map((r) => r.children[1]?.textContent ?? '');

describe('DialoguePanel DOM', () => {
  it('pushes itself on the menu stack and renders the header, tabs, tones and topics', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    panel.open(view({ commModes: ['verbal', 'written'] }), handlers().handlers);
    expect(ui.stack).toEqual([panel]);
    const root = fake(panel.element);
    expect(find(root, 'dlg-title')[0]?.textContent).toBe('Jane Doe');
    expect(find(root, 'dlg-subtitle-chips')[0]?.textContent).toBe('Driver · 34 · calm');
    expect(find(root, 'dlg-tone').map((t) => t.textContent)).toEqual(['Polite', 'Neutral', 'Commanding', 'Aggressive']);
    expect(find(root, 'dlg-tone').map((t) => t.className.includes('dlg-on'))).toEqual([false, true, false, false]);
    expect(find(root, 'dlg-tab').map((t) => t.textContent)).toEqual(['Talk', 'Actions', 'Notes']);
    expect(find(root, 'dlg-mode')[0]?.textContent).toBe('Verbal (M)');
    expect(labels(visibleRows(root))).toEqual(['Greeting', 'Identity', 'Nothing here']);
    expect(visibleRows(root).map((r) => r.children[0]?.textContent)).toEqual(['1', '2', '3']);
    expect(visibleRows(root)[0]?.className).toContain('dlg-focus');
    expect(visibleRows(root)[2]?.className).toContain('dlg-off');
  });

  it('shows the options of the opened topic with hints and marks disabled ones', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    panel.open(view(), handlers().handlers);
    panel.onKeyDown(keyEvent('2'));
    const rows = visibleRows(fake(panel.element));
    expect(labels(rows)).toEqual(['Name?', 'May I see your ID?', 'Date of birth?']);
    expect(rows[0]?.children[2]?.textContent).toBe('Not yet greeted');
    expect(rows[0]?.className).toContain('dlg-off');
    expect(rows[1]?.className).toContain('dlg-focus');
    panel.onKeyDown(keyEvent('Backspace'));
    expect(labels(visibleRows(fake(panel.element)))).toEqual(['Greeting', 'Identity', 'Nothing here']);
  });

  it('lists the actions and the notes sections with severity classes', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    panel.open(
      view({
        statements: [{ text: 'Said she was at work', severity: 'info' }],
        inconsistencies: [{ text: 'Name differs from the licence', severity: 'alert' }],
      }),
      handlers().handlers,
    );
    panel.onKeyDown(keyEvent('Tab'));
    expect(labels(visibleRows(fake(panel.element)))).toEqual(['Frisk', 'Handcuff', 'Release']);
    panel.onKeyDown(keyEvent('Tab'));
    const root = fake(panel.element);
    const notes = visibleRows(root);
    const texts = labels(notes);
    expect(texts).toEqual(['Inconsistencies', 'Name differs from the licence', 'Statements', 'Said she was at work', 'Facts', 'None yet']);
    expect(notes[1]?.className).toContain('dlg-note-alert');
    expect(notes[3]?.className).toContain('dlg-note-info');
    expect(notes[5]?.className).toContain('dlg-note-none');
    // Back on the talk tab the rows are rebuilt.
    panel.onKeyDown(keyEvent('Tab'));
    expect(labels(visibleRows(root))).toEqual(['Greeting', 'Identity', 'Nothing here']);
  });

  it('shows the newest notes of a long list and scrolls the body with the arrows', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const facts = Array.from({ length: 20 }, (_, i) => ({ text: `fact ${String(i)}`, severity: 'info' as const }));
    panel.open(view({ facts }), handlers().handlers);
    panel.onKeyDown(keyEvent('Tab'));
    panel.onKeyDown(keyEvent('Tab'));
    const root = fake(panel.element);
    const texts = labels(visibleRows(root));
    expect(texts).toContain('fact 19');
    expect(texts).toContain('fact 8');
    expect(texts).not.toContain('fact 7');
    const body = find(root, 'dlg-body')[0] as FakeEl & { scrollTop?: number; clientHeight?: number };
    body.scrollTop = 0;
    body.clientHeight = 200;
    expect(panel.onKeyDown(keyEvent('ArrowDown'))).toBe(true);
    expect(body.scrollTop).toBe(32);
    expect(panel.onKeyDown(keyEvent('PageDown'))).toBe(true);
    expect(body.scrollTop).toBe(32 + 160);
    expect(panel.onKeyDown(keyEvent('ArrowUp'))).toBe(true);
    expect(body.scrollTop).toBe(32 + 160 - 32);
  });

  it('scrolls the highlighted row into view when the highlight moves', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const actions = Array.from({ length: 22 }, (_, i) => ({ id: `a${String(i)}`, label: `Action ${String(i)}`, enabled: true }));
    panel.open(view({ actions }), handlers().handlers);
    const seen: string[] = [];
    const proto = Object.getPrototypeOf(document.createElement('div')) as { scrollIntoView?: unknown };
    proto.scrollIntoView = function (this: FakeEl): void {
      seen.push(this.children[1]?.textContent ?? '');
    };
    panel.onKeyDown(keyEvent('Tab'));
    for (let i = 0; i < 20; i++) panel.onKeyDown(keyEvent('ArrowDown'));
    expect(seen.at(-1)).toBe('Action 20');
    // An update that keeps the highlight does not scroll again.
    const before = seen.length;
    panel.update(view({ actions }));
    expect(seen.length).toBe(before);
    delete proto.scrollIntoView;
  });

  it('shows the last transcript lines by speaker and the waiting status', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const speakers = ['officer', 'subject', 'system'] as const;
    const transcript = Array.from({ length: 11 }, (_, i) => ({
      id: i,
      speaker: speakers[i % 3] ?? 'system',
      text: `line ${String(i)}`,
      pending: i === 10,
    }));
    panel.open(view({ transcript, busy: true }), handlers().handlers);
    const root = fake(panel.element);
    const lines = find(root, 'dlg-line').filter((l) => !l.hidden);
    expect(lines).toHaveLength(TRANSCRIPT_LINES);
    expect(lines.map((l) => l.textContent)).toEqual(transcript.slice(-TRANSCRIPT_LINES).map((l) => (l.pending ? `${l.text} …` : l.text)));
    expect(lines[0]?.className).toContain('dlg-officer');
    expect(lines[2]?.className).toContain('dlg-system');
    expect(lines[TRANSCRIPT_LINES - 1]?.className).toContain('dlg-pending');
    const status = find(root, 'dlg-status')[0];
    expect(status?.hidden).toBe(false);
    panel.update(view({ transcript: [], busy: false }));
    expect(find(root, 'dlg-line').every((l) => l.hidden)).toBe(true);
    expect(status?.hidden).toBe(true);
  });

  it('reacts to clicks on rows, tones and tabs', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const { handlers: h, calls } = handlers();
    panel.open(view(), h);
    const root = fake(panel.element);
    find(root, 'dlg-tone')[3]?.click();
    expect(panel.state.tone).toBe('aggressive');
    visibleRows(root)[0]?.click();
    expect(panel.state.topic).toBe(0);
    visibleRows(root)[1]?.click();
    expect(calls.say).toEqual([['reason', 'aggressive']]);
    find(root, 'dlg-tab')[1]?.click();
    expect(panel.state.tab).toBe('actions');
    visibleRows(root)[2]?.click();
    expect(calls.action).toEqual(['release']);
  });

  it('close() pops without telling the app, Escape and an external pop do', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const a = handlers();
    panel.open(view(), a.handlers);
    panel.close();
    expect(ui.stack).toEqual([]);
    expect(a.calls.close).toBe(0);

    const b = handlers();
    panel.open(view(), b.handlers);
    panel.onKeyDown(keyEvent('Escape'));
    expect(ui.stack).toEqual([]);
    expect(b.calls.close).toBe(1);

    const c = handlers();
    panel.open(view(), c.handlers);
    ui.pop(panel);
    expect(panel.isOpen).toBe(false);
    expect(c.calls.close).toBe(1);
  });

  it('covering the panel with another menu does not close it', () => {
    const ui = install();
    const panel = new DialoguePanel(asUi(ui));
    const { handlers: h, calls } = handlers();
    panel.open(view(), h);
    // UIRoot calls onHide on the menu below when another is pushed; the panel is still on the stack.
    panel.onHide();
    expect(panel.isOpen).toBe(true);
    expect(calls.close).toBe(0);
  });
});

describe('SfstPanel DOM', () => {
  it('shows the prompt key, the bars and the summary when finished', () => {
    const ui = install();
    const panel = new SfstPanel(asUi(ui));
    panel.open(sfst({ prompt: 'SPACE', promptRemaining: 0.5, progress: 0.25 }), { key: () => undefined, close: () => undefined });
    expect(ui.stack).toEqual([panel]);
    const root = fake(panel.element);
    const prompt = find(root, 'dlg-prompt')[0];
    expect(prompt?.textContent).toBe('SPACE');
    expect(prompt?.hidden).toBe(false);
    expect(find(root, 'dlg-title')[0]?.textContent).toBe('Horizontal gaze test');
    const fills = find(root, 'dlg-bar-fill');
    expect(fills[0]?.style['width']).toBe('50%');
    expect(fills[1]?.style['width']).toBe('26%');
    expect(find(root, 'dlg-summary')[0]?.hidden).toBe(true);
    panel.update(sfst({ prompt: null, finished: true, progress: 1, summary: ['4 of 6 clues', 'Result: fail'] }));
    expect(prompt?.hidden).toBe(true);
    expect(find(root, 'dlg-summary')[0]?.hidden).toBe(false);
    expect(find(root, 'dlg-summary')[0]?.textContent).toBe('4 of 6 clues\nResult: fail');
    expect(fills[1]?.style['width']).toBe('100%');
  });
});

describe('SubtitleBar DOM', () => {
  it('writes the line into its element and hides it after the time', () => {
    install();
    const parent = new FakeEl();
    const bar = new SubtitleBar(parent as unknown as HTMLElement);
    const el = parent.children[0];
    expect(el?.className).toBe('dlg-subtitle');
    expect(el?.hidden).toBe(true);
    bar.show('Jane', 'Hello', 0, 1000);
    expect(el?.textContent).toBe('Jane: Hello');
    expect(el?.hidden).toBe(false);
    bar.update(1000);
    expect(el?.hidden).toBe(true);
    bar.show('Jane', 'Again', 2000, 1000);
    bar.setVisible(false);
    expect(el?.hidden).toBe(true);
    bar.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
