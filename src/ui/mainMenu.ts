import { officerPreset, validateOfficerLoadout, type OfficerLoadout } from '../gear';
import { DEFAULT_RULESET_ID, getRuleset, rulesetIds } from '../legal';
import type { SaveSummary } from '../save/saveManager';
import { defaultCharacter, pronounLabel, type CharacterProfile } from '../uniform';
import { CharacterCreator } from './character/characterCreator';
import { clearChildren, el, type Menu, type UIRoot } from './ui';

/** The officer made in the character creator: the profile and the gear loadout (Phase 7 §12.5). */
export interface MainMenuCharacter {
  profile: CharacterProfile;
  gear: OfficerLoadout;
}

/** 'Officer: Jordan Doe (they/them)'. */
export function officerSummary(c: Readonly<MainMenuCharacter>): string {
  return `Officer: ${c.profile.firstName} ${c.profile.lastName} (${pronounLabel(c.profile.pronouns)})`;
}

export interface MainMenuCallbacks {
  /**
   * Numeric seeds are passed as numbers; anything else as the raw text. `jurisdiction` is the ruleset id picked in the
   * Jurisdiction select (default `generic`); callers written for the old one-argument shape keep working. `character` is
   * the officer made with "Create officer..." (absent: the game starts with the default officer).
   */
  newGame(seed: number | string, jurisdiction?: string, character?: MainMenuCharacter): void;
  continueGame(slot: string): void;
  openSettings(): void;
  deleteSave?(slot: string): void;
  /** The Jurisdiction select changed (the app may remember it in the settings). */
  jurisdictionChanged?(id: string): void;
}

/** One entry of the Jurisdiction select. */
export interface JurisdictionOption {
  readonly id: string;
  readonly name: string;
}

/** The ruleset the menu starts on. */
export const DEFAULT_JURISDICTION = DEFAULT_RULESET_ID;

/** Every ruleset (sorted by id) with its display name: the options of the Jurisdiction select. */
export function jurisdictionOptions(): JurisdictionOption[] {
  return rulesetIds().map((id) => ({ id, name: getRuleset(id).name }));
}

/** `id` when it names a ruleset, else the default (a stale setting or a hand-edited value). */
export function normalizeJurisdiction(id: string | null | undefined): string {
  return id !== null && id !== undefined && rulesetIds().includes(id) ? id : DEFAULT_JURISDICTION;
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

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * Title screen: seed input, jurisdiction select, new game, save slot list, settings. Headless (no `document` or no
 * `UIRoot`) it builds no DOM but keeps the seed, the jurisdiction and `startNewGame`.
 */
export class MainMenu implements Menu {
  readonly id = 'main';
  readonly element: HTMLElement;
  private readonly ui: UIRoot | null;
  private readonly callbacks: MainMenuCallbacks;
  private readonly seedInput: HTMLInputElement | null;
  private readonly jurisdictionSelect: HTMLSelectElement | null;
  private readonly jurisdictionHint: HTMLElement | null;
  private readonly saveList: HTMLElement | null;
  private readonly status: HTMLElement | null;
  private readonly officerLine: HTMLElement | null;
  private seedText = '';
  private chosen: MainMenuCharacter | null = null;
  private jurisdictionId = DEFAULT_JURISDICTION;
  private statusText = '';
  private saves: readonly SaveSummary[] = [];

  constructor(ui: UIRoot | null, callbacks: MainMenuCallbacks) {
    this.ui = ui;
    this.callbacks = callbacks;
    if (ui === null || typeof document === 'undefined') {
      this.seedInput = null;
      this.jurisdictionSelect = null;
      this.jurisdictionHint = null;
      this.saveList = null;
      this.status = null;
      this.officerLine = null;
      this.element = HEADLESS_ELEMENT;
      return;
    }
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
    this.jurisdictionSelect = el(
      'select',
      { id: 'jurisdiction', onchange: () => this.pickJurisdiction(this.jurisdictionSelect?.value ?? DEFAULT_JURISDICTION) },
      ...jurisdictionOptions().map((o) => el('option', { value: o.id }, o.name)),
    );
    this.jurisdictionSelect.value = this.jurisdictionId;
    this.jurisdictionHint = el('p', { class: 'hint' }, getRuleset(this.jurisdictionId).description);
    this.saveList = el('div', { class: 'save-list' });
    this.status = el('p', { class: 'hint', role: 'status' });
    this.officerLine = el('p', { class: 'hint officer-line', role: 'status' });
    this.officerLine.hidden = true;
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
        el('button', { onclick: () => this.createOfficer() }, 'Create officer\u2026'),
      ),
      this.officerLine,
      el('p', { class: 'hint' }, 'Same seed, same shift. Leave blank for a random one.'),
      el('div', { class: 'row' }, el('label', { for: 'jurisdiction' }, 'Jurisdiction'), this.jurisdictionSelect),
      this.jurisdictionHint,
      el('h2', null, 'Continue'),
      this.saveList,
      this.status,
      el('div', { class: 'row end' }, el('button', { onclick: () => this.callbacks.openSettings() }, 'Settings')),
    );
    this.renderSaves();
  }

  /** Replaces the save slot list (sorted as provided). */
  setSaves(saves: readonly SaveSummary[]): void {
    this.saves = saves;
    this.renderSaves();
  }

  /** Short status line under the save list (e.g. why a save could not be loaded). */
  setStatus(text: string): void {
    this.statusText = text;
    if (this.status) this.status.textContent = text;
  }

  get statusLine(): string {
    return this.statusText;
  }

  get seed(): string {
    return this.seedInput ? this.seedInput.value : this.seedText;
  }

  set seed(value: string) {
    this.seedText = value;
    if (this.seedInput) this.seedInput.value = value;
  }

  /** The ruleset id picked in the Jurisdiction select. */
  get jurisdiction(): string {
    return this.jurisdictionId;
  }

  /** Preselects a jurisdiction (an unknown id falls back to the default); does not call `jurisdictionChanged`. */
  set jurisdiction(id: string) {
    this.setJurisdiction(id);
  }

  open(): void {
    this.setStatus('');
    this.ui?.push(this);
  }

  close(): void {
    this.ui?.pop(this);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    // Escape is swallowed here: the title screen cannot be dismissed.
    return event.key === 'Escape';
  }

  /** The officer made in the creator, null until one was made. */
  get character(): MainMenuCharacter | null {
    return this.chosen;
  }

  /** Sets (or clears) the officer the next new game starts with, and updates the summary line under the buttons. */
  setCharacter(character: MainMenuCharacter | null): void {
    this.chosen = character;
    const line = this.officerLine;
    if (!line) return;
    line.textContent = character ? officerSummary(character) : '';
    line.hidden = character === null;
  }

  /**
   * Opens the character creator (mode `newGame`) on the menu stack; Done stores the officer. Returns the creator, or
   * null headless (no `document` or no `UIRoot`).
   */
  createOfficer(): CharacterCreator | null {
    const ui = this.ui;
    if (ui === null || typeof document === 'undefined') return null;
    const start = this.chosen ?? { profile: defaultCharacter(), gear: officerPreset('patrolStandard') };
    const creator = new CharacterCreator(
      ui,
      {
        mode: 'newGame',
        validateGear: (l, extra) => validateOfficerLoadout(l, { extraVestSlots: extra }),
        done: (profile, gear) => this.setCharacter({ profile, gear }),
        cancel: () => undefined,
      },
      start,
    );
    creator.open();
    return creator;
  }

  /** Starts a new game with the seed box, the picked jurisdiction and (when one was made) the created officer. */
  startNewGame(): void {
    const seed = parseSeedInput(this.seed);
    if (this.chosen) this.callbacks.newGame(seed, this.jurisdictionId, this.chosen);
    else this.callbacks.newGame(seed, this.jurisdictionId);
  }

  private setJurisdiction(id: string): void {
    this.jurisdictionId = normalizeJurisdiction(id);
    if (this.jurisdictionSelect) this.jurisdictionSelect.value = this.jurisdictionId;
    if (this.jurisdictionHint) this.jurisdictionHint.textContent = getRuleset(this.jurisdictionId).description;
  }

  private pickJurisdiction(id: string): void {
    this.setJurisdiction(id);
    this.callbacks.jurisdictionChanged?.(this.jurisdictionId);
  }

  private renderSaves(): void {
    const list = this.saveList;
    if (!list) return;
    clearChildren(list);
    if (this.saves.length === 0) {
      list.appendChild(el('div', { class: 'empty' }, 'No saved shifts yet.'));
      return;
    }
    for (const save of this.saves) {
      const label = save.slot === 'autosave' ? 'Autosave' : save.slot;
      list.appendChild(
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
