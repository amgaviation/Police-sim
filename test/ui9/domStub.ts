/**
 * A DOM stand-in for the UIRoot tests (node has no document): the Phase 7 fake elements plus a document that records its
 * listeners, menus whose focusable list the test controls, and key events as plain objects.
 */
import { FakeElement, fakeDocument, installFakeDom } from '../ui7/fakeDom';
import type { Menu } from '../../src/ui/ui';

type Handler = (event: unknown) => void;

export class StubDoc {
  readonly listeners: Record<string, Handler[]> = {};
  activeElement: unknown = null;
  readonly documentElement = fakeDocument.documentElement;
  createElement(tag: string): FakeElement {
    return fakeDocument.createElement(tag);
  }
  createTextNode(text: string): unknown {
    return fakeDocument.createTextNode(text);
  }
  getElementById(): null {
    return null;
  }
  addEventListener(type: string, fn: Handler): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Handler): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  /** Calls the document's keydown listeners. */
  keydown(event: unknown): void {
    for (const fn of this.listeners['keydown'] ?? []) fn(event);
  }
}

/** A focusable control the stub reports through `querySelectorAll`. */
export class Focusable extends FakeElement {
  closestHit = false;
  rects = 1;
  type = '';
  private readonly doc: StubDoc;
  constructor(doc: StubDoc, tag = 'button') {
    super(tag.toUpperCase());
    this.doc = doc;
  }
  override get ownerDocument(): never {
    return this.doc as never;
  }
  override focus(): void {
    this.doc.activeElement = this;
  }
  getClientRects(): unknown[] {
    return new Array<unknown>(this.rects).fill({});
  }
  closest(selector: string): unknown {
    if (/button|\[role="button"\]|select|input/.test(selector)) return this.closestHit ? this : null;
    return this.closestHit ? this : null;
  }
}

/** A menu element whose focusable controls are an explicit list. */
export class MenuEl extends FakeElement {
  focusables: Focusable[] = [];
  private readonly doc: StubDoc;
  constructor(doc: StubDoc) {
    super('div');
    this.doc = doc;
  }
  override get ownerDocument(): never {
    return this.doc as never;
  }
  querySelectorAll(): Focusable[] {
    return this.focusables;
  }
}

export interface TestMenu extends Menu {
  readonly element: HTMLElement;
  keys: string[];
  consume: (event: KeyboardEvent) => boolean;
}

export function makeMenu(doc: StubDoc, id: string, focusables = 0): { menu: TestMenu; el: MenuEl } {
  const el = new MenuEl(doc);
  el.focusables = Array.from({ length: focusables }, () => new Focusable(doc));
  const menu: TestMenu = {
    id,
    element: el as unknown as HTMLElement,
    keys: [],
    consume: () => false,
    onKeyDown(event: KeyboardEvent): boolean {
      menu.keys.push(event.key);
      return menu.consume(event);
    },
  };
  return { menu, el };
}

export function keyEvent(key: string, extra: Record<string, unknown> = {}): KeyboardEvent & { prevented: boolean } {
  const e = { key, code: key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, target: null, prevented: false, ...extra } as Record<
    string,
    unknown
  >;
  e['preventDefault'] = () => {
    e['prevented'] = true;
  };
  return e as unknown as KeyboardEvent & { prevented: boolean };
}

export { FakeElement, installFakeDom };
