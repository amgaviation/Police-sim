/**
 * A tiny DOM double for node tests: just enough of Element / Document for `el()`, the livery editor, the character
 * creator, the main menu and the HUD to build and react to events. Not a browser: no layout, no selectors.
 */

type Listener = (event: unknown) => void;

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

export class FakeElement {
  readonly nodeType = 1;
  parentNode: FakeElement | null = null;
  readonly children: (FakeElement | FakeText)[] = [];
  readonly attrs: Record<string, string> = {};
  readonly listeners: Record<string, Listener[]> = {};
  readonly style: Record<string, string> & { cssText: string } = { cssText: '' };
  readonly dataset: Record<string, string> = {};
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  value = '';
  id = '';
  inert = false;
  width = 0;
  height = 0;
  files: unknown[] | null = null;
  clicks = 0;
  readonly ctxCalls: string[] = [];
  private ctx: unknown = null;

  readonly tagName: string;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }

  get ownerDocument(): FakeDocument {
    return fakeDocument;
  }

  get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(text: string) {
    this.children.length = 0;
    if (text !== '') this.appendChild(new FakeText(text));
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: (FakeElement | FakeText | string)[]): void {
    for (const n of nodes) this.appendChild(typeof n === 'string' ? new FakeText(n) : n);
  }

  removeChild(child: FakeElement | FakeText): void {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'value') this.value = value;
    if (name === 'checked') this.checked = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(): void {}

  /** Dispatches a synthetic event to the listeners of `type`. */
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, preventDefault: () => undefined, ...event });
  }

  click(): void {
    this.clicks++;
    if (!this.disabled) this.fire('click');
  }

  focus(): void {}

  setPointerCapture(): void {}

  contains(): boolean {
    return false;
  }

  querySelector(): null {
    return null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }

  getContext(kind: string): unknown {
    if (kind !== '2d') return null;
    const base: Record<string | symbol, unknown> = { fillStyle: '', strokeStyle: '', lineWidth: 1 };
    this.ctx ??= new Proxy(
      base,
      {
        get: (t, k) => (k in t ? t[k] : (): void => void this.ctxCalls.push(String(k))),
        set: (t, k, v) => {
          t[k] = v;
          return true;
        },
      },
    );
    return this.ctx;
  }
}

export class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(): null {
    return null;
  }

  readonly documentElement = new FakeElement('html');
  addEventListener(): void {}
  removeEventListener(): void {}
}

export const fakeDocument = new FakeDocument();

/** Installs the double as the global `document` (node has none); returns the undo. */
export function installFakeDom(): () => void {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  g.document = fakeDocument;
  return () => {
    if (before === undefined) delete g.document;
    else g.document = before;
  };
}

/** Depth-first walk over elements. */
export function walk(root: FakeElement, visit: (e: FakeElement) => void): void {
  visit(root);
  for (const c of root.children) if (c instanceof FakeElement) walk(c, visit);
}

export function findAll(root: FakeElement, pred: (e: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  walk(root, (e) => {
    if (pred(e)) out.push(e);
  });
  return out;
}

export function findButton(root: FakeElement, text: string): FakeElement {
  const b = findAll(root, (e) => e.tagName === 'button' && e.textContent === text)[0];
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

/** A minimal stand-in for UIRoot: tracks the stack. */
export function fakeUi(): { push(m: unknown): void; pop(m?: unknown): unknown; isOpen(m: unknown): boolean; stack: unknown[] } {
  const stack: unknown[] = [];
  return {
    stack,
    push(m) {
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
      stack.push(m);
    },
    pop(m) {
      const target = m ?? stack.at(-1);
      const i = stack.indexOf(target);
      if (i >= 0) stack.splice(i, 1);
      return target;
    },
    isOpen: (m) => stack.includes(m),
  };
}
