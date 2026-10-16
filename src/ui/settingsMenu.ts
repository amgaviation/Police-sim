import { ACTIONS, ACTION_IDS, actionKind, type ActionId } from '../input/actions';
import { DEFAULT_BINDINGS, bindingSign, cloneBindings, withBindingSign, type Binding, type BindingMap } from '../input/bindings';
import type { InputManager } from '../input/input';
import {
  fieldsOfSection,
  isImplemented,
  settingsField,
  visibleSections,
  type SettingsField,
  type SettingsPath,
  type SettingsSection,
  type SettingsStore,
} from '../settings/settings';
import { clearChildren, el, type Menu, type UIRoot } from './ui';

const TAB_LABELS: Record<SettingsSection, string> = {
  graphics: 'Graphics',
  audio: 'Audio',
  controls: 'Controls',
  accessibility: 'Accessibility',
};

/** Human-readable name for a binding, e.g. `W`, `Mouse 1`, `Pad axis 0 -`. */
export function describeBinding(binding: Binding): string {
  const { device, code, scale } = binding;
  const sign = scale !== undefined && scale < 0 ? ' -' : '';
  if (device === 'mouse') {
    const button = /^MouseButton(\d+)$/.exec(code);
    if (button) return `Mouse ${Number(button[1]) + 1}`;
    return code.replace('Mouse', 'Mouse ') + sign;
  }
  if (device === 'gamepad') {
    const m = /^Gamepad(Button|Axis)(\d+)$/.exec(code);
    if (m) return `Pad ${m[1] === 'Axis' ? 'axis' : 'button'} ${m[2]}${sign}`;
    return code + sign;
  }
  return code.replace(/^(Key|Digit)/, '').replace(/^Arrow/, 'Arrow ') + sign;
}

interface Control {
  readonly element: HTMLElement;
  refresh(): void;
}

function decimals(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function createControl(path: SettingsPath, field: SettingsField, store: SettingsStore): Control | null {
  const id = `setting-${path.replace('.', '-')}`;
  const label = el('label', { for: id }, field.label);
  switch (field.kind) {
    case 'number': {
      const input = el('input', { type: 'range', id, min: field.min, max: field.max, step: field.step });
      const readout = el('span', { class: 'value' });
      const refresh = (): void => {
        const value = Number(store.get(path));
        input.value = String(value);
        readout.textContent = `${value.toFixed(decimals(field.step))}${field.unit ?? ''}`;
      };
      input.addEventListener('input', () => {
        store.trySet(path, Number(input.value));
        refresh();
      });
      refresh();
      return { element: el('div', { class: 'field' }, label, input, readout), refresh };
    }
    case 'enum': {
      const select = el('select', { id });
      field.options.forEach((option, index) => {
        select.appendChild(el('option', { value: String(index) }, option.label));
      });
      const refresh = (): void => {
        const current: unknown = store.get(path);
        select.value = String(field.options.findIndex((o) => o.value === current));
      };
      select.addEventListener('change', () => {
        const option = field.options[Number(select.value)];
        if (option) store.trySet(path, option.value);
        refresh();
      });
      refresh();
      return { element: el('div', { class: 'field' }, label, select, el('span', { class: 'value' })), refresh };
    }
    case 'boolean': {
      const input = el('input', { type: 'checkbox', id });
      const refresh = (): void => {
        input.checked = store.get(path) === true;
      };
      input.addEventListener('change', () => {
        store.trySet(path, input.checked);
        refresh();
      });
      refresh();
      return { element: el('div', { class: 'field' }, label, input, el('span', { class: 'value' })), refresh };
    }
    case 'text': {
      const input = el('input', { type: 'text', id, placeholder: field.placeholder ?? '' });
      const refresh = (): void => {
        const value: unknown = store.get(path);
        input.value = typeof value === 'string' ? value : '';
      };
      input.addEventListener('change', () => {
        store.trySet(path, input.value);
        refresh();
      });
      refresh();
      return { element: el('div', { class: 'field' }, label, input, el('span', { class: 'value' })), refresh };
    }
    case 'bindings':
      return null; // rendered by the bindings table
  }
}

/**
 * Tabbed settings screen bound to a `SettingsStore`. Generic controls come
 * from the field table; the Controls tab additionally lists every action
 * with its bindings and rebinding via `InputManager.captureNext`.
 */
export class SettingsMenu implements Menu {
  readonly id = 'settings';
  readonly element: HTMLElement;
  private readonly ui: UIRoot;
  private readonly store: SettingsStore;
  private readonly input: InputManager;
  private readonly tabs: HTMLElement;
  private readonly body: HTMLElement;
  private readonly controls = new Map<SettingsPath, Control>();
  private readonly bindingsTable = el('div', { class: 'stack bindings' });
  private section: SettingsSection = 'graphics';
  private cancelCapture: (() => void) | null = null;
  private pendingFocusKey: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(ui: UIRoot, store: SettingsStore, input: InputManager) {
    this.ui = ui;
    this.store = store;
    this.input = input;
    this.tabs = el('div', { class: 'tabs', role: 'tablist' });
    this.body = el('div', { class: 'stack' });
    for (const section of visibleSections()) {
      this.tabs.appendChild(
        el('button', { role: 'tab', dataset: { section }, onclick: () => this.showSection(section) }, TAB_LABELS[section]),
      );
    }
    this.element = el(
      'div',
      { class: 'panel settings-menu', role: 'dialog', 'aria-label': 'Settings' },
      el('h1', null, 'Settings'),
      this.tabs,
      this.body,
      el(
        'div',
        { class: 'row end' },
        el('button', { class: 'danger', onclick: () => this.resetToDefaults() }, 'Reset to defaults'),
        el('button', { class: 'primary', onclick: () => this.close() }, 'Back'),
      ),
    );
    this.showSection(this.section);
  }

  open(section?: SettingsSection): void {
    if (section) this.showSection(section);
    this.ui.push(this);
  }

  close(): void {
    this.ui.pop(this);
  }

  onShow(): void {
    this.input.setBindings(this.store.get('controls.bindings'));
    this.unsubscribe ??= this.store.subscribe((change) => {
      if (change.path === '*') {
        this.showSection(this.section);
        return;
      }
      if (change.path === 'controls.bindings') this.renderBindings(undefined, this.takePendingFocus());
      else this.controls.get(change.path)?.refresh();
    });
    this.refreshAll();
  }

  onHide(): void {
    this.stopCapture();
    this.unsubscribe?.();
    this.unsubscribe = null;
    void this.store.flush();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (this.cancelCapture) return false; // let the InputManager capture it
    if (event.key === 'Escape') {
      this.close();
      return true;
    }
    return false;
  }

  showSection(section: SettingsSection): void {
    this.stopCapture();
    this.section = section;
    for (const tab of this.tabs.children) {
      tab.setAttribute('aria-selected', String((tab as HTMLElement).dataset['section'] === section));
    }
    clearChildren(this.body);
    this.controls.clear();
    for (const path of fieldsOfSection(section)) {
      if (!isImplemented(path)) continue;
      const control = createControl(path, settingsField(path), this.store);
      if (!control) continue;
      this.controls.set(path, control);
      this.body.appendChild(control.element);
    }
    if (section === 'controls') {
      this.body.append(
        el('h2', null, 'Bindings'),
        el('p', { class: 'hint' }, 'Click a key to change it, × to remove it, + to add another. Escape or clicking another control cancels.'),
        this.bindingsTable,
      );
      this.renderBindings();
    }
  }

  private refreshAll(): void {
    for (const control of this.controls.values()) control.refresh();
    if (this.section === 'controls') this.renderBindings();
  }

  private resetToDefaults(): void {
    this.stopCapture();
    this.store.reset();
    this.input.setBindings(this.store.get('controls.bindings'));
  }

  // --- Bindings ---------------------------------------------------------------

  /**
   * Rebuilds the bindings table. Focus is restored to the control with the
   * same `action:index` key (default: the one focused before the rebuild),
   * so keyboard navigation and Escape keep working after a rebind or removal.
   */
  private renderBindings(capturing?: { action: ActionId; index: number; sign: number }, focusKey = this.focusedBindingKey()): void {
    clearChildren(this.bindingsTable);
    const map = this.store.get('controls.bindings');
    for (const action of ACTION_IDS) {
      const chips = el('div', { class: 'chips' });
      map[action].forEach((binding, index) => {
        const active = capturing?.action === action && capturing.index === index;
        chips.appendChild(
          el(
            'span',
            { class: active ? 'chip capturing' : 'chip' },
            el(
              'button',
              {
                class: 'small',
                title: 'Rebind',
                dataset: { bind: bindingKey(action, index) },
                // Clicking the capturing chip itself binds Mouse 1; other controls cancel.
                'data-capture-target': active,
                onclick: () => this.startCapture(action, index),
              },
              active ? 'Press a key...' : describeBinding(binding),
            ),
            el(
              'button',
              {
                class: 'x',
                type: 'button',
                title: 'Remove',
                'aria-label': `Remove binding ${describeBinding(binding)}`,
                dataset: { bind: `${bindingKey(action, index)}:x` },
                onclick: () => this.removeBinding(action, index),
              },
              '×',
            ),
          ),
        );
      });
      const addIndex = map[action].length;
      // Axis actions can take negative bindings too (e.g. a second "steer left" key).
      const signs = actionKind(action) === 'axis' ? [1, -1] : [1];
      for (const sign of signs) {
        const adding = capturing?.action === action && capturing.index === addIndex && capturing.sign === sign;
        const label = sign < 0 ? '+ −' : '+';
        chips.appendChild(
          el(
            'button',
            {
              class: adding ? 'small chip capturing' : 'small',
              title: sign < 0 ? 'Add negative binding' : 'Add binding',
              dataset: { bind: sign < 0 ? `${bindingKey(action, addIndex)}:neg` : bindingKey(action, addIndex) },
              'data-capture-target': adding,
              onclick: () => this.startCapture(action, addIndex, sign),
            },
            adding ? 'Press a key...' : label,
          ),
        );
      }
      chips.appendChild(
        el(
          'button',
          {
            class: 'small',
            title: 'Restore the default bindings of this action only',
            dataset: { bind: `${action}:default` },
            onclick: () => this.restoreDefault(action),
          },
          'Default',
        ),
      );
      this.bindingsTable.appendChild(
        el('div', { class: 'binding-row' }, el('span', { title: action }, ACTIONS[action].label), chips),
      );
    }
    if (focusKey !== null && this.element.isConnected) {
      this.bindingsTable.querySelector<HTMLElement>(`[data-bind="${focusKey}"]`)?.focus();
    }
  }

  private focusedBindingKey(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.bindingsTable.contains(active)) return null;
    return active.dataset['bind'] ?? null;
  }

  /** `sign` applies when appending; replacing a slot keeps that slot's sign. */
  private startCapture(action: ActionId, index: number, sign = 1): void {
    this.stopCapture();
    const key = sign < 0 ? `${bindingKey(action, index)}:neg` : bindingKey(action, index);
    this.renderBindings({ action, index, sign }, key);
    this.cancelCapture = this.input.captureNext((binding) => {
      this.cancelCapture = null;
      if (binding) this.applyBinding(action, index, binding, sign);
      else this.renderBindings();
    });
  }

  private stopCapture(): void {
    if (!this.cancelCapture) return;
    this.cancelCapture();
    this.cancelCapture = null;
    this.renderBindings();
  }

  private applyBinding(action: ActionId, index: number, binding: Binding, addSign: number): void {
    const map = this.store.get('controls.bindings');
    const list = map[action];
    if (index >= 0 && index < list.length) list[index] = withBindingSign(binding, bindingSign(list[index]), action);
    else list.push(withBindingSign(binding, addSign, action));
    this.commitBindings(map);
  }

  /** Puts back this action's default bindings (e.g. a removed mouse look), leaving the rest alone. */
  private restoreDefault(action: ActionId): void {
    this.stopCapture();
    const map = this.store.get('controls.bindings');
    map[action] = cloneBindings(DEFAULT_BINDINGS)[action];
    this.commitBindings(map, `${action}:default`);
  }

  private removeBinding(action: ActionId, index: number): void {
    this.stopCapture();
    const map = this.store.get('controls.bindings');
    map[action].splice(index, 1);
    // The next chip (or the + button) moves into the removed one's place.
    this.commitBindings(map, bindingKey(action, index));
  }

  private commitBindings(map: BindingMap, focusKey?: string): void {
    this.input.setBindings(map);
    this.pendingFocusKey = focusKey ?? null;
    if (!this.store.set('controls.bindings', map)) this.renderBindings(undefined, this.takePendingFocus());
  }

  private takePendingFocus(): string | null {
    const key = this.pendingFocusKey ?? this.focusedBindingKey();
    this.pendingFocusKey = null;
    return key;
  }
}

function bindingKey(action: ActionId, index: number): string {
  return `${action}:${String(index)}`;
}
