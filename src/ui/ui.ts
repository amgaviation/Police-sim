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

/**
 * Interface sound kinds (design §4.1; the audio module's `UI_SOUND_KINDS` lists the same literals, the two modules do
 * not import each other).
 */
export type UiSoundKind = 'move' | 'select' | 'back' | 'open' | 'close' | 'error' | 'notify';

export type UiSoundListener = (kind: UiSoundKind) => void;

/** Fan-out of UI sound requests to listeners (the audio engine). Pure: no DOM. */
export class UiSoundEmitter {
  private readonly listeners = new Set<UiSoundListener>();

  /** Subscribes `listener`; returns the unsubscribe. */
  on(listener: UiSoundListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(kind: UiSoundKind): void {
    for (const listener of this.listeners) listener(kind);
  }

  clear(): void {
    this.listeners.clear();
  }
}

/**
 * Index of the next (dir 1) or previous (-1) focusable out of `count`, wrapping. `current` is the index of the element
 * that has focus, or -1 / out of range when none of them does (then 1 gives the first and -1 the last). -1 for an
 * empty list.
 */
export function nextFocusIndex(count: number, current: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (!Number.isInteger(current) || current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** The keys UIRoot turns into focus moves when the top menu does not handle them. */
export function arrowDirection(key: string): 1 | -1 | 0 {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
  return 0;
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color']);

/** True for targets that use the arrow keys themselves: text-like inputs, textareas, selects, range sliders, editable text. */
export function usesArrowKeys(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true) return true;
  if (tag !== 'INPUT') return false;
  const type = typeof t.type === 'string' ? t.type.toLowerCase() : 'text';
  return type === 'range' || !NON_TEXT_INPUTS.has(type);
}

/** Visible, enabled focusable descendants of `root` in document order. */
export function focusableElements(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const node of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if ((node as HTMLButtonElement).disabled === true || node.hidden) continue;
    if ((node as HTMLInputElement).type === 'hidden') continue;
    if (node.closest('[hidden], [inert]') !== null) continue;
    if (node.getClientRects().length === 0) continue;
    out.push(node);
  }
  return out;
}

/** A screen managed by the menu stack. Only the top menu is interactive. */
export interface Menu {
  readonly id: string;
  readonly element: HTMLElement;
  /** False for overlays that let the world keep running (MDT, action panels); menus pause by default. */
  readonly pausesGame?: boolean;
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
  private readonly sounds = new UiSoundEmitter();
  // Keys go to the top menu whatever has focus (a rebuilt or removed control
  // leaves focus on <body>), except keys typed into the HUD (debug console).
  // Propagation is left intact so the InputManager (window listener) still
  // sees keys, e.g. during binding capture; only the default is suppressed.
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const top = this.top;
    if (!top) return;
    const from = event.target as Node | null;
    if (typeof from === 'object' && from !== null && this.hud.contains(from)) return;
    if (top.onKeyDown?.(event)) {
      event.preventDefault();
      return;
    }
    // Phase 9: arrows move focus over the real controls of menus that do not handle them (text fields, selects and
    // sliders keep their own arrows).
    const dir = arrowDirection(event.key);
    if (dir === 0 || event.altKey || event.ctrlKey || event.metaKey || usesArrowKeys(event.target)) return;
    if (this.moveFocus(dir)) event.preventDefault();
  };

  // 'select' sound for clicks on controls inside the menu layer.
  private readonly onClick = (event: Event): void => {
    const target = event.target as Partial<Element> | null;
    if (typeof target?.closest !== 'function') return;
    const hit = target.closest('button, [role="button"], input[type="checkbox"], input[type="radio"], select');
    if (hit !== null) this.sounds.emit('select');
  };

  constructor(root?: HTMLElement) {
    const found = root ?? document.getElementById('ui');
    if (!found) throw new Error('UIRoot: no #ui element to mount into');
    this.root = found;
    this.hud = el('div', { class: 'ui-hud' });
    this.menus = el('div', { class: 'ui-menus' });
    this.root.append(this.hud, this.menus);
    this.root.ownerDocument.addEventListener('keydown', this.onKeyDown);
    this.menus.addEventListener('click', this.onClick);
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
    this.sounds.emit('open');
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
    this.sounds.emit('close');
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
   * Notified for UI sounds: 'open' on push, 'close' on pop, 'move' on a focus move made by `moveFocus`, 'select' on a
   * click on a button / checkbox / radio / select inside the menu layer, and whatever `sound()` is asked for. Returns
   * the unsubscribe.
   */
  onUiSound(listener: UiSoundListener): () => void {
    return this.sounds.on(listener);
  }

  /** Plays a sound through the listeners (other modules: `ui.sound('error')`). */
  sound(kind: UiSoundKind): void {
    this.sounds.emit(kind);
  }

  /**
   * Moves focus inside the top menu to the next (dir 1) / previous (-1) visible, enabled focusable element in document
   * order, wrapping. False without a top menu or focusable.
   */
  moveFocus(dir: 1 | -1): boolean {
    const top = this.top;
    if (!top) return false;
    const list = focusableElements(top.element);
    const active = top.element.ownerDocument.activeElement;
    const next = list[nextFocusIndex(list.length, active === null ? -1 : list.indexOf(active as HTMLElement), dir)];
    if (!next) return false;
    next.focus();
    this.sounds.emit('move');
    return true;
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
    this.root.ownerDocument.removeEventListener('keydown', this.onKeyDown);
    this.menus.removeEventListener('click', this.onClick);
    this.hud.remove();
    this.menus.remove();
    this.listeners.clear();
    this.sounds.clear();
  }

  private readonly layers = new WeakMap<Menu, HTMLElement>();

  private layerFor(menu: Menu): HTMLElement {
    let layer = this.layers.get(menu);
    if (!layer) {
      const live = menu.pausesGame === false ? ' menu-layer-live' : '';
      layer = el('div', { class: `menu-layer${live}`, dataset: { menu: menu.id } }, menu.element);
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
  // querySelector returns the first match in document order, so [autofocus] needs its own query.
  const target =
    element.querySelector<HTMLElement>('[autofocus]') ??
    element.querySelector<HTMLElement>('button, input, select, [tabindex]:not([tabindex="-1"])');
  target?.focus();
}
