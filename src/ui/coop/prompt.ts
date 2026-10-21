import './coop.css';
import { LIMITS, hasControlChars } from '../../net';
import { el, type Menu, type UIRoot } from '../ui';

/** Null when `text` can go out as a radio line, else the reason (trimmed length 1..160, no control characters). */
export function validateRadioLine(text: string): string | null {
  const t = text.trim();
  if (t === '') return 'Type a message first';
  if (t.length > LIMITS.radio) return `At most ${String(LIMITS.radio)} characters`;
  if (hasControlChars(t)) return 'Only plain text can be sent';
  return null;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * A one-line text prompt (a non-pausing `Menu`): Enter sends, Escape cancels. Used for the co-op radio line. Headless it
 * keeps `submit` and `cancel` but builds no DOM.
 */
export class LinePrompt implements Menu {
  readonly id = 'line-prompt';
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly input: HTMLInputElement | null;
  private readonly error: HTMLElement | null;
  private onSubmit: ((text: string) => void) | null = null;
  private onCancel: (() => void) | null = null;
  private openFlag = false;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    if (ui === null || typeof document === 'undefined') {
      this.input = null;
      this.error = null;
      this.element = HEADLESS_ELEMENT;
      return;
    }
    this.input = el('input', {
      type: 'text',
      maxlength: LIMITS.radio,
      autocomplete: 'off',
      'aria-label': 'Radio message',
      onkeydown: (e: Event) => {
        const k = e as KeyboardEvent;
        if (k.key === 'Enter') this.submit(this.input?.value ?? '');
        else if (k.key === 'Escape') this.cancel();
      },
    });
    this.error = el('div', { class: 'cl-error', role: 'status' });
    this.element = el(
      'div',
      { class: 'panel line-prompt', role: 'dialog', 'aria-label': 'Radio message' },
      el('label', { for: 'line-prompt-input' }, 'Radio message'),
      this.input,
      this.error,
      el('div', { class: 'row end' }, el('button', { type: 'button', onclick: () => this.cancel() }, 'Cancel'), el('button', { type: 'button', class: 'primary', onclick: () => this.submit(this.input?.value ?? '') }, 'Send')),
    );
    this.input.id = 'line-prompt-input';
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  open(onSubmit: (text: string) => void, onCancel?: () => void): void {
    this.onSubmit = onSubmit;
    this.onCancel = onCancel ?? null;
    this.openFlag = true;
    if (this.input) this.input.value = '';
    if (this.error) this.error.textContent = '';
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Sends `text` when valid (and closes); otherwise shows the reason and stays open. Returns whether it was sent. */
  submit(text: string): boolean {
    const reason = validateRadioLine(text);
    if (reason !== null) {
      if (this.error) this.error.textContent = reason;
      return false;
    }
    const cb = this.onSubmit;
    this.finish();
    cb?.(text.trim());
    return true;
  }

  cancel(): void {
    const cb = this.onCancel;
    this.finish();
    cb?.();
  }

  close(): void {
    this.finish();
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) {
      this.openFlag = false;
      this.onSubmit = null;
      this.onCancel = null;
    }
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag) return false;
    if (event.key === 'Escape') {
      this.cancel();
      return true;
    }
    return false;
  }

  private finish(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.onSubmit = null;
    this.onCancel = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }
}
