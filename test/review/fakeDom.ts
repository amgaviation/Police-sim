/** A tiny DOM stand-in (no jsdom in this project): just what the review panel touches. */
export class FakeEl {
  className = '';
  hidden = false;
  tabIndex = -1;
  alt = '';
  type = '';
  id = '';
  step = '';
  min = '';
  max = '';
  value = '';
  src = '';
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  parent: FakeEl | null = null;
  private text = '';
  private readonly listeners = new Map<string, (() => void)[]>();

  get textContent(): string {
    return this.text;
  }

  set textContent(v: string) {
    this.text = v;
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
  }

  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }

  append(...cs: FakeEl[]): void {
    for (const c of cs) this.appendChild(c);
  }

  replaceChildren(): void {
    for (const c of this.children) c.parent = null;
    this.children.length = 0;
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }

  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }

  removeAttribute(k: string): void {
    delete this.attrs[k];
    if (k === 'src') this.src = '';
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  remove(): void {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }

  scrollIntoView(): void {
    /* no layout */
  }

  /** Depth-first list of descendants having every class of `cls` (space separated). */
  all(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const want = cls.split(' ');
    const walk = (e: FakeEl): void => {
      for (const c of e.children) {
        const have = c.className.split(' ');
        if (want.every((w) => have.includes(w))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

/** Installs a fake `document` (call the returned function to remove it). */
export function installFakeDocument(): () => void {
  const g = globalThis as unknown as { document?: unknown };
  const before = g.document;
  g.document = { createElement: (): FakeEl => new FakeEl() };
  return () => {
    if (before === undefined) delete g.document;
    else g.document = before;
  };
}
