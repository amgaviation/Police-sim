import type { SaveSummary } from '../save/saveManager';
import { clearChildren, el, type Menu, type UIRoot } from './ui';

export interface MainMenuCallbacks {
  /** Numeric seeds are passed as numbers; anything else as the raw text. */
  newGame(seed: number | string): void;
  continueGame(slot: string): void;
  openSettings(): void;
  deleteSave?(slot: string): void;
}

/** Interprets the seed box: blank = random, integer text = number, else the text itself. */
export function parseSeedInput(text: string): number | string {
  const trimmed = text.trim();
  if (trimmed === '') return Math.floor(Math.random() * 0xffffffff);
  if (/^-?\d{1,15}$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/** Title screen: seed input, new game, save slot list, settings. */
export class MainMenu implements Menu {
  readonly id = 'main';
  readonly element: HTMLElement;
  private readonly ui: UIRoot;
  private readonly callbacks: MainMenuCallbacks;
  private readonly seedInput: HTMLInputElement;
  private readonly saveList: HTMLElement;
  private saves: readonly SaveSummary[] = [];

  constructor(ui: UIRoot, callbacks: MainMenuCallbacks) {
    this.ui = ui;
    this.callbacks = callbacks;
    this.seedInput = el('input', {
      type: 'text',
      id: 'seed',
      placeholder: 'random',
      autocomplete: 'off',
      spellcheck: 'false',
      onkeydown: (e: Event) => {
        if ((e as KeyboardEvent).key === 'Enter') this.startNewGame();
      },
    });
    this.saveList = el('div', { class: 'save-list' });
    this.element = el(
      'div',
      { class: 'panel main-menu', role: 'dialog', 'aria-label': 'Main menu' },
      el('h1', null, 'Patrol'),
      el('p', { class: 'hint' }, 'Browser police patrol simulator'),
      el('h2', null, 'New shift'),
      el(
        'div',
        { class: 'row' },
        el('label', { for: 'seed' }, 'Seed'),
        this.seedInput,
        el('button', { class: 'primary', autofocus: true, onclick: () => this.startNewGame() }, 'New game'),
      ),
      el('p', { class: 'hint' }, 'Same seed, same shift. Leave blank for a random one.'),
      el('h2', null, 'Continue'),
      this.saveList,
      el('div', { class: 'row end' }, el('button', { onclick: () => this.callbacks.openSettings() }, 'Settings')),
    );
    this.renderSaves();
  }

  /** Replaces the save slot list (sorted as provided). */
  setSaves(saves: readonly SaveSummary[]): void {
    this.saves = saves;
    this.renderSaves();
  }

  get seed(): string {
    return this.seedInput.value;
  }

  set seed(value: string) {
    this.seedInput.value = value;
  }

  open(): void {
    this.ui.push(this);
  }

  close(): void {
    this.ui.pop(this);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    // Escape is swallowed here: the title screen cannot be dismissed.
    return event.key === 'Escape';
  }

  private startNewGame(): void {
    this.callbacks.newGame(parseSeedInput(this.seedInput.value));
  }

  private renderSaves(): void {
    clearChildren(this.saveList);
    if (this.saves.length === 0) {
      this.saveList.appendChild(el('div', { class: 'empty' }, 'No saved shifts yet.'));
      return;
    }
    for (const save of this.saves) {
      const label = save.slot === 'autosave' ? 'Autosave' : save.slot;
      this.saveList.appendChild(
        el(
          'div',
          { class: 'save-item' },
          el(
            'button',
            { class: 'wide', onclick: () => this.callbacks.continueGame(save.slot) },
            el('div', null, `${label} — ${save.officerName || 'Unnamed officer'}`),
            el('div', { class: 'meta' }, `saved ${formatDate(save.updatedAt)} · v${save.version}`),
          ),
          this.callbacks.deleteSave
            ? el(
                'button',
                {
                  class: 'danger small',
                  title: 'Delete save',
                  onclick: () => {
                    if (window.confirm(`Delete save '${label}'?`)) this.callbacks.deleteSave?.(save.slot);
                  },
                },
                'Delete',
              )
            : null,
        ),
      );
    }
  }
}
