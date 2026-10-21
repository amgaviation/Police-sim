/**
 * Small form-control builders shared by the livery editor and the character creator (Phase 7 §12). They only run
 * when a document exists. Class names use the `livery-` prefix (the creator adds its own `char-` ones).
 */
import './livery.css';
import { el } from '../ui';

/** 0xRRGGBB -> '#rrggbb'. */
export function hexString(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** '#rrggbb' (any case) -> 0xRRGGBB, null for anything else. */
export function parseHexColor(text: string): number | null {
  return /^#[0-9a-fA-F]{6}$/.test(text) ? parseInt(text.slice(1), 16) : null;
}

/** A numeric control: slider bounds and step plus the label shown next to it. */
export interface NumberFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
}

let uid = 0;
function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}-${String(uid)}`;
}

/** Label + control on one row; `hint` is a dim second line. */
export function fieldRow(label: string, control: HTMLElement, hint = ''): HTMLElement {
  const id = nextId('livery-f');
  control.id = control.id || id;
  return el(
    'div',
    { class: 'livery-field' },
    el('label', { class: 'livery-label', for: control.id }, label),
    control,
    hint !== '' ? el('div', { class: 'livery-hint' }, hint) : null,
  );
}

/** Range input with a live value readout; `onInput` gets every change while dragging. */
export function sliderField(spec: NumberFieldSpec, value: number, onInput: (v: number) => void, format?: (v: number) => string): HTMLElement {
  const show = format ?? ((v: number): string => (Number.isInteger(spec.step) ? String(Math.round(v)) : v.toFixed(2)));
  const readout = el('span', { class: 'livery-value' }, show(value));
  const input = el('input', {
    type: 'range',
    min: spec.min,
    max: spec.max,
    step: spec.step,
    value: String(value),
    oninput: (e: Event) => {
      const v = Number((e.target as HTMLInputElement).value);
      readout.textContent = show(v);
      onInput(v);
    },
  });
  const wrap = el('div', { class: 'livery-slider' }, input, readout);
  const id = nextId('livery-f');
  input.id = id;
  return el('div', { class: 'livery-field' }, el('label', { class: 'livery-label', for: id }, spec.label), wrap);
}

/** Native colour picker; `onInput` gets '#rrggbb'. */
export function colorField(label: string, value: string, onInput: (hex: string) => void): HTMLElement {
  const input = el('input', {
    type: 'color',
    value,
    oninput: (e: Event) => onInput((e.target as HTMLInputElement).value),
  });
  return fieldRow(label, input);
}

export function selectField<T extends string>(label: string, options: readonly Option<T>[], value: T, onChange: (v: T) => void, disabled = false): HTMLElement {
  const select = el(
    'select',
    {
      disabled,
      onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T),
    },
    ...options.map((o) => el('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  select.value = value;
  return fieldRow(label, select);
}

export function checkField(label: string, checked: boolean, onChange: (v: boolean) => void, opts: { disabled?: boolean; hint?: string } = {}): HTMLElement {
  const input = el('input', {
    type: 'checkbox',
    checked,
    disabled: opts.disabled === true,
    onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked),
  });
  input.checked = checked;
  const id = nextId('livery-f');
  input.id = id;
  return el(
    'div',
    { class: `livery-field livery-check${opts.disabled === true ? ' livery-disabled' : ''}` },
    input,
    el('label', { for: id }, label),
    opts.hint !== undefined && opts.hint !== '' ? el('div', { class: 'livery-hint' }, opts.hint) : null,
  );
}

export function textField(label: string, value: string, onInput: (v: string) => void, opts: { maxLength?: number; placeholder?: string } = {}): HTMLElement {
  const input = el('input', {
    type: 'text',
    value,
    maxlength: opts.maxLength,
    placeholder: opts.placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e: Event) => onInput((e.target as HTMLInputElement).value),
  });
  input.value = value;
  return fieldRow(label, input);
}

export function actionButton(text: string, onClick: () => void, cls = '', disabled = false, ariaLabel?: string): HTMLButtonElement {
  return el('button', { type: 'button', class: cls, disabled, onclick: onClick, 'aria-label': ariaLabel }, text);
}

/** A bar `used / cap` with a text readout; `over` turns it red. */
export function barField(label: string, used: number, cap: number, unit: string): HTMLElement {
  const fraction = cap > 0 ? Math.min(1, used / cap) : used > 0 ? 1 : 0;
  const over = used > cap;
  const fill = el('div', { class: `livery-bar-fill${over ? ' livery-bar-over' : ''}` });
  fill.style.width = `${String(Math.round(fraction * 100))}%`;
  const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return el(
    'div',
    { class: 'livery-field livery-bar', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': cap, 'aria-valuenow': used },
    el('span', { class: 'livery-label' }, label),
    el('div', { class: 'livery-bar-track' }, fill),
    el('span', { class: 'livery-value' }, `${fmt(used)} / ${fmt(cap)}${unit}`),
  );
}
