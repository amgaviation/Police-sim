import type { SettingsStore } from '../settings/settings';

export type ElChild = Node | string | number | null | undefined | false | ElChild[];

/**
 * Attribute bag for `el()`: `class`/`className` set the class list, `text`
 * sets textContent, `style` is applied as inline CSS text, `dataset`
 * entries become `data-*` attributes, `on*` keys add event listeners,
 * `true` sets a boolean attribute and `false`/`null`/`undefined` skip it.
 */
export type ElAttrs = Record<string, string | number | boolean | null | undefined | EventListener | Record<string, string>>;

/** Tiny DOM builder: `el('button', { class: 'primary', onclick: fn }, 'Start')`. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs | null = null,
  ...children: ElChild[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (typeof value === 'function') {
        if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      if (typeof value === 'object') {
        if (key === 'dataset') for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
        continue;
      }
      if (key === 'class' || key === 'className') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'style') node.style.cssText = String(value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(parent: Node, children: ElChild[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clearChildren(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A screen managed by the menu stack. Only the top menu is interactive. */
export interface Menu {
  readonly id: string;
  readonly element: HTMLElement;
  /** Called after the menu becomes the top of the stack. */
  onShow?(): void;
  /** Called when the menu is popped or covered by another menu. */
  onHide?(): void;
  /** Key handling while on top; return true to consume the event. */
  onKeyDown?(event: KeyboardEvent): boolean;
}

export type MenuStackListener = (stack: readonly Menu[]) => void;

/**
 * Owns the `#ui` element: a persistent HUD layer plus a stack of modal
 * menus. Lower menus are hidden and `inert`, so only the top one receives
 * pointer and keyboard input.
 */
export class UIRoot {
  readonly root: HTMLElement;
  readonly hud: HTMLElement;
  private readonly menus: HTMLElement;
  private readonly stack: Menu[] = [];
  private readonly listeners = new Set<MenuStackListener>();
  // Propagation is left intact so the InputManager (window listener) still
  // sees keys, e.g. during binding capture; only the default is suppressed.
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.top?.onKeyDown?.(event)) event.preventDefault();
  };

  constructor(root?: HTMLElement) {
    const found = root ?? document.getElementById('ui');
    if (!found) throw new Error('UIRoot: no #ui element to mount into');
    this.root = found;
    this.hud = el('div', { class: 'ui-hud' });
    this.menus = el('div', { class: 'ui-menus' });
    this.root.append(this.hud, this.menus);
    this.menus.addEventListener('keydown', this.onKeyDown);
  }

  get top(): Menu | undefined {
    return this.stack[this.stack.length - 1];
  }

  get menuStack(): readonly Menu[] {
    return this.stack;
  }

  isMenuOpen(): boolean {
    return this.stack.length > 0;
  }

  isOpen(menu: Menu): boolean {
    return this.stack.includes(menu);
  }

  /** Pushes `menu` on top; a menu already in the stack is moved to the top. */
  push(menu: Menu): void {
    const previous = this.top;
    const idx = this.stack.indexOf(menu);
    if (idx !== -1) this.stack.splice(idx, 1);
    if (previous && previous !== menu) previous.onHide?.();
    this.stack.push(menu);
    this.menus.appendChild(this.layerFor(menu));
    this.refresh();
    menu.onShow?.();
    this.emit();
  }

  /** Removes the top menu (or a specific one) and reveals the one beneath. */
  pop(menu?: Menu): Menu | undefined {
    const target = menu ?? this.top;
    if (!target) return undefined;
    const idx = this.stack.indexOf(target);
    if (idx === -1) return undefined;
    const wasTop = idx === this.stack.length - 1;
    this.stack.splice(idx, 1);
    target.onHide?.();
    this.layerFor(target).remove();
    this.refresh();
    if (wasTop) this.top?.onShow?.();
    this.emit();
    return target;
  }

  /** Replaces the top menu with `menu`. */
  replace(menu: Menu): void {
    this.pop();
    this.push(menu);
  }

  closeAll(): void {
    while (this.stack.length > 0) this.pop();
  }

  /** Hides or shows the whole UI layer (HUD and menus). */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.setVisible(true);
  }

  hide(): void {
    this.setVisible(false);
  }

  /** Notified whenever the menu stack changes (e.g. to pause the sim). */
  onMenuChange(listener: MenuStackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Mirrors accessibility settings onto the document: `--text-scale`,
   * `data-colorblind` and `data-reduced-flash`. Returns an unsubscribe.
   */
  bindSettings(store: SettingsStore): () => void {
    const apply = (): void => {
      const a = store.get().accessibility;
      const doc = document.documentElement;
      doc.style.setProperty('--text-scale', String(a.textScale));
      doc.dataset['colorblind'] = a.colorblind;
      doc.dataset['reducedFlash'] = String(a.reducedFlash);
    };
    apply();
    return store.subscribe((change) => {
      if (change.path === '*' || change.path.startsWith('accessibility.')) apply();
    });
  }

  dispose(): void {
    this.closeAll();
    this.menus.removeEventListener('keydown', this.onKeyDown);
    this.hud.remove();
    this.menus.remove();
    this.listeners.clear();
  }

  private readonly layers = new WeakMap<Menu, HTMLElement>();

  private layerFor(menu: Menu): HTMLElement {
    let layer = this.layers.get(menu);
    if (!layer) {
      layer = el('div', { class: 'menu-layer', dataset: { menu: menu.id } }, menu.element);
      this.layers.set(menu, layer);
    }
    return layer;
  }

  private refresh(): void {
    const top = this.top;
    for (const menu of this.stack) {
      const layer = this.layerFor(menu);
      layer.inert = menu !== top;
    }
    if (top) focusFirst(top.element);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener(this.stack);
  }
}

function focusFirst(element: HTMLElement): void {
  if (element.contains(document.activeElement)) return;
  const target = element.querySelector<HTMLElement>('[autofocus], button, input, select, [tabindex]');
  target?.focus();
}
