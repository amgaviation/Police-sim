import { describe, expect, it, vi } from 'vitest';
import type { BriefingView } from '../../src/station/briefing';
import { BriefingScreen } from '../../src/ui/station/briefingScreen';
import type { Menu, UIRoot } from '../../src/ui/ui';

const view: BriefingView = {
  title: 'Roll call',
  date: '06/01/2026',
  assignment: '12-A / Beat 4',
  sections: [{ heading: 'Assignment', lines: ['Officer Test'] }],
};

const key = (k: string, repeat = false): KeyboardEvent => ({ key: k, repeat }) as KeyboardEvent;

/** The few UIRoot members the screen uses. */
interface FakeUi {
  readonly menus: Menu[];
  isOpen(m: Menu): boolean;
  push(m: Menu): void;
  pop(m?: Menu): void;
}

function fakeUi(): FakeUi {
  const stack: Menu[] = [];
  const ui: FakeUi = {
    menus: stack,
    isOpen: (m: Menu): boolean => stack.includes(m),
    push: (m: Menu): void => {
      stack.push(m);
    },
    pop: (m?: Menu): void => {
      const target = m ?? stack[stack.length - 1];
      if (!target) return;
      stack.splice(stack.indexOf(target), 1);
      target.onHide?.();
    },
  };
  return ui;
}

describe('BriefingScreen (headless)', () => {
  it('is a pausing menu with id briefing', () => {
    const s = new BriefingScreen(null);
    expect(s.id).toBe('briefing');
    expect(s.pausesGame).toBe(true);
    expect(s.isOpen).toBe(false);
    expect(s.view).toBeNull();
  });

  it('opens with a view and closes once, calling onClose once', () => {
    const s = new BriefingScreen(null);
    const onClose = vi.fn();
    s.open(view, onClose);
    expect(s.isOpen).toBe(true);
    expect(s.view).toBe(view);
    s.close();
    s.close();
    expect(s.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Enter and Escape and consumes them', () => {
    for (const k of ['Enter', 'Escape']) {
      const s = new BriefingScreen(null);
      const onClose = vi.fn();
      s.open(view, onClose);
      expect(s.onKeyDown(key('a'))).toBe(false);
      expect(s.isOpen).toBe(true);
      expect(s.onKeyDown(key(k))).toBe(true);
      expect(s.isOpen).toBe(false);
      expect(onClose).toHaveBeenCalledOnce();
    }
  });

  it('ignores key repeats and keys while closed', () => {
    const s = new BriefingScreen(null);
    expect(s.onKeyDown(key('Enter'))).toBe(false);
    const onClose = vi.fn();
    s.open(view, onClose);
    expect(s.onKeyDown(key('Enter', true))).toBe(true);
    expect(s.isOpen).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('can be reopened with another view', () => {
    const s = new BriefingScreen(null);
    const a = vi.fn();
    const b = vi.fn();
    s.open(view, a);
    s.close();
    const other = { ...view, title: 'Second' };
    s.open(other, b);
    expect(s.view).toBe(other);
    s.onKeyDown(key('Enter'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('dispose closes an open screen', () => {
    const s = new BriefingScreen(null);
    const onClose = vi.fn();
    s.open(view, onClose);
    s.dispose();
    expect(s.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('BriefingScreen on a menu stack (no document)', () => {
  it('pushes itself when opened and pops itself when closed', () => {
    const ui = fakeUi();
    const s = new BriefingScreen(ui as unknown as UIRoot);
    const onClose = vi.fn();
    s.open(view, onClose);
    expect(ui.menus).toEqual([s]);
    s.onKeyDown(key('Enter'));
    expect(ui.menus).toEqual([]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('counts as closed when someone else pops it', () => {
    const ui = fakeUi();
    const s = new BriefingScreen(ui as unknown as UIRoot);
    const onClose = vi.fn();
    s.open(view, onClose);
    ui.pop(s);
    expect(s.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    s.close();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/** A minimal DOM, enough to build and render the sheet. */
class FakeEl {
  className = '';
  textContent = '';
  type = '';
  children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, (() => void)[]>();
  get firstChild(): FakeEl | undefined {
    return this.children[0];
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  removeChild(c: FakeEl): void {
    this.children.splice(this.children.indexOf(c), 1);
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  click(): void {
    for (const fn of this.listeners.get('click') ?? []) fn();
  }
  remove(): void {}
  find(cls: string): FakeEl[] {
    return [...(this.className === cls ? [this] : []), ...this.children.flatMap((c) => c.find(cls))];
  }
}

describe('BriefingScreen DOM', () => {
  it('renders the sections and closes from the button', () => {
    const g = globalThis as { document?: unknown };
    const saved = g.document;
    g.document = { createElement: () => new FakeEl() };
    try {
      const ui = fakeUi();
      const s = new BriefingScreen(ui as unknown as UIRoot);
      const root = s.element as unknown as FakeEl;
      const onClose = vi.fn();
      s.open(
        { ...view, sections: [{ heading: 'Assignment', lines: ['a', 'b'] }, { heading: 'BOLOs', lines: ['c'] }] },
        onClose,
      );
      expect(root.find('brf-title')[0]?.textContent).toBe('Roll call');
      expect(root.find('brf-date')[0]?.textContent).toBe('06/01/2026');
      expect(root.find('brf-heading').map((h) => h.textContent)).toEqual(['Assignment', 'BOLOs']);
      expect(root.find('brf-line').map((l) => l.textContent)).toEqual(['a', 'b', 'c']);
      // Reopening replaces the rows instead of appending.
      s.close();
      s.open(view, vi.fn());
      expect(root.find('brf-heading')).toHaveLength(1);
      s.close();
      expect(onClose).toHaveBeenCalledOnce();
      const again = vi.fn();
      s.open(view, again);
      root.find('brf-button')[0]?.click();
      expect(again).toHaveBeenCalledOnce();
      expect(s.isOpen).toBe(false);
    } finally {
      g.document = saved;
    }
  });
});
