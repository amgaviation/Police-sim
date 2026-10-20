/** A small DOM stand-in (no jsdom in this project): the subset the Phase 5 panels and `el()` touch. */
export class FakeNode {
  className = '';
  hidden = false;
  tabIndex = -1;
  type = '';
  id = '';
  name = '';
  value = '';
  title = '';
  checked = false;
  readonly attrs: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { cssText: string } = { cssText: '' };
  readonly children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  readonly tagName: string;
  private own: string;
  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(tagName: string, text = '') {
    this.tagName = tagName;
    this.own = text;
  }

  get textContent(): string {
    return this.own + this.children.map((c) => c.textContent).join('');
  }

  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children.length = 0;
    this.own = v;
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  appendChild(c: FakeNode): FakeNode {
    c.remove();
    c.parentNode = this;
    this.children.push(c);
    return c;
  }

  append(...cs: (FakeNode | string)[]): void {
    for (const c of cs) this.appendChild(typeof c === 'string' ? new FakeNode('#text', c) : c);
  }

  removeChild(c: FakeNode): FakeNode {
    c.remove();
    return c;
  }

  remove(): void {
    const p = this.parentNode;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parentNode = null;
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'value') this.value = v;
    else if (k === 'id') this.id = v;
    else if (k === 'type') this.type = v;
    else if (k === 'name') this.name = v;
    else if (k === 'class') this.className = v;
    else if (k === 'title') this.title = v;
  }

  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  /** Fires the listeners of `type` (click, change, submit). */
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  /** Depth-first descendants matching `pred`. */
  find(pred: (n: FakeNode) => boolean): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): void => {
      for (const c of n.children) {
        if (pred(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  /** Descendants having every class of `cls` (space separated). */
  all(cls: string): FakeNode[] {
    const want = cls.split(' ');
    return this.find((n) => want.every((w) => n.className.split(' ').includes(w)));
  }

  /** Descendants with this tag name. */
  tag(name: string): FakeNode[] {
    return this.find((n) => n.tagName === name.toUpperCase());
  }
}

/** Installs a fake `document`; call the returned function to remove it. */
export function installFakeDocument(): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  g.document = {
    createElement: (tag: string): FakeNode => new FakeNode(tag.toUpperCase()),
    createTextNode: (text: string): FakeNode => new FakeNode('#text', text),
  };
  return () => {
    if (before === undefined) delete g.document;
    else g.document = before;
  };
}

export function fakeKey(k: string, extra: { repeat?: boolean; ctrlKey?: boolean } = {}): KeyboardEvent {
  return { key: k, repeat: false, ctrlKey: false, altKey: false, metaKey: false, ...extra } as KeyboardEvent;
}
