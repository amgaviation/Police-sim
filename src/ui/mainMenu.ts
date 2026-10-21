import { startingGearSave, validateOfficerLoadout, type OfficerLoadout } from '../gear';
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
  /**
   * Phase 8: "New career" (starts in the academy). Same arguments as `newGame`: the seed box, the picked jurisdiction and
   * the created officer when there is one. Absent: the Career section is hidden.
   */
  newCareer?(seed: number | string, jurisdiction?: string, character?: MainMenuCharacter): void;
  /**
   * Phase 8: a Training button. `drills` = academy drills, `report` = report writing, `driving` = driving academy,
   * `dispatch` = dispatch-only (`option` = the chosen script id, absent for "no script"), `sandbox` = scenario editor.
   * Absent: the Training section is hidden.
   */
  training?(kind: TrainingKind, option?: string): void;
  /** Phase 8: opens the co-op lobby. Absent: the Multiplayer section is hidden. */
  openCoop?(): void;
  /** Phase 8: opens the mod manager. Absent: the Mods section is hidden. */
  openMods?(): void;
  /** Phase 8: dispatch scripts for the dispatch-only picker (built-in and mod scripts). Absent: no picker. */
  scripts?(): readonly ScriptOption[];
  /** Phase 8: the line under the Mods button ('2 mods active'). */
  modSummary?(): string;
}

/** The Training buttons (`MainMenuCallbacks.training`). */
export const TRAINING_KINDS = ['drills', 'report', 'driving', 'dispatch', 'sandbox'] as const;
export type TrainingKind = (typeof TRAINING_KINDS)[number];

export const TRAINING_LABELS: Readonly<Record<TrainingKind, string>> = {
  drills: 'Academy drills',
  report: 'Report writing',
  driving: 'Driving academy',
  dispatch: 'Dispatch-only',
  sandbox: 'Scenario editor',
};

/** One dispatch script for the picker. */
export interface ScriptOption {
  readonly id: string;
  readonly name: string;
}

/** The title-screen sections, in display order, that a given set of callbacks shows. */
export type MainMenuSection = 'setup' | 'career' | 'freePatrol' | 'training' | 'multiplayer' | 'mods' | 'continue' | 'settings';

/** Label of the "no script" entry of the dispatch-only picker. */
export const NO_SCRIPT_LABEL = 'No script (random calls)';

/** The sections `callbacks` shows: Career, Training, Multiplayer and Mods only when their callbacks exist. */
export function visibleSections(callbacks: Readonly<MainMenuCallbacks>): MainMenuSection[] {
  const out: MainMenuSection[] = ['setup'];
  if (callbacks.newCareer) out.push('career');
  out.push('freePatrol');
  if (callbacks.training) out.push('training');
  if (callbacks.openCoop) out.push('multiplayer');
  if (callbacks.openMods) out.push('mods');
  out.push('continue', 'settings');
  return out;
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
  private readonly scriptSelect: HTMLSelectElement | null;
  private readonly modLine: HTMLElement | null;
  private seedText = '';
  private scriptId = '';
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
      this.scriptSelect = null;
      this.modLine = null;
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
    this.scriptSelect = callbacks.scripts
      ? el('select', { id: 'dispatch-script', 'aria-label': 'Dispatch script', onchange: () => this.pickScript(this.scriptSelect?.value ?? '') })
      : null;
    this.modLine = callbacks.openMods ? el('p', { class: 'hint', role: 'status' }) : null;
    this.refreshExtras();
    this.element = el(
      'div',
      { class: 'panel main-menu', role: 'dialog', 'aria-label': 'Main menu' },
      el('h1', null, 'Patrol'),
      el('p', { class: 'hint' }, 'Browser police patrol simulator'),
      el('h2', null, 'Setup'),
      el(
        'div',
        { class: 'row' },
        el('label', { for: 'seed' }, 'Seed'),
        this.seedInput,
        el('button', { onclick: () => this.createOfficer() }, 'Create officer\u2026'),
      ),
      this.officerLine,
      el('p', { class: 'hint' }, 'Same seed, same shift. Leave blank for a random one.'),
      el('div', { class: 'row' }, el('label', { for: 'jurisdiction' }, 'Jurisdiction'), this.jurisdictionSelect),
      this.jurisdictionHint,
      callbacks.newCareer
        ? [
            el('h2', null, 'Career'),
            el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => this.startNewCareer() }, 'New career')),
            el('p', { class: 'hint' }, 'Start in the academy, pass probation and build a career over many shifts.'),
          ]
        : null,
      el('h2', null, 'Free patrol'),
      el('div', { class: 'row' }, el('button', { class: 'primary', autofocus: true, onclick: () => this.startNewGame() }, 'New game')),
      callbacks.training ? this.trainingSection() : null,
      callbacks.openCoop
        ? [
            el('h2', null, 'Multiplayer (optional)'),
            el('div', { class: 'row' }, el('button', { onclick: () => this.openMultiplayer() }, 'Co-op lobby\u2026')),
            el('p', { class: 'hint' }, 'Play with others on your own network. Nothing happens unless you open the lobby.'),
          ]
        : null,
      callbacks.openMods
        ? [el('h2', null, 'Mods'), el('div', { class: 'row' }, el('button', { onclick: () => this.openModManager() }, 'Manage mods\u2026')), this.modLine]
        : null,
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
    this.refreshExtras();
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
    const start = this.chosen ?? { profile: defaultCharacter(), gear: startingGearSave().loadout };
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

  /** The sections this menu shows (see `visibleSections`). */
  get sections(): MainMenuSection[] {
    return visibleSections(this.callbacks);
  }

  /** The Training buttons shown: all of them when a `training` callback exists, else none. */
  get trainingKinds(): TrainingKind[] {
    return this.callbacks.training ? [...TRAINING_KINDS] : [];
  }

  /** The dispatch scripts offered (from `scripts()`); [] without the callback. */
  get scriptOptions(): ScriptOption[] {
    return this.callbacks.scripts ? [...this.callbacks.scripts()] : [];
  }

  /** The picked dispatch script id; '' = no script. */
  get script(): string {
    return this.scriptId;
  }

  set script(id: string) {
    this.pickScript(id);
  }

  /** The line under the Mods button ('' without the callback). */
  get modSummaryText(): string {
    return this.callbacks.modSummary?.() ?? '';
  }

  /** Starts a new career with the seed box, the picked jurisdiction and the created officer; false when the callback is absent. */
  startNewCareer(): boolean {
    const cb = this.callbacks;
    if (!cb.newCareer) return false;
    const seed = parseSeedInput(this.seed);
    if (this.chosen) cb.newCareer(seed, this.jurisdictionId, this.chosen);
    else cb.newCareer(seed, this.jurisdictionId);
    return true;
  }

  /** Runs a Training button; `dispatch` passes the picked script (nothing for "no script"). False when the callback is absent. */
  startTraining(kind: TrainingKind, option?: string): boolean {
    const cb = this.callbacks;
    if (!cb.training) return false;
    const chosen = option ?? (kind === 'dispatch' && this.scriptId !== '' ? this.scriptId : undefined);
    if (chosen === undefined) cb.training(kind);
    else cb.training(kind, chosen);
    return true;
  }

  openMultiplayer(): boolean {
    if (!this.callbacks.openCoop) return false;
    this.callbacks.openCoop();
    return true;
  }

  openModManager(): boolean {
    if (!this.callbacks.openMods) return false;
    this.callbacks.openMods();
    return true;
  }

  private pickScript(id: string): void {
    const known = id === '' || this.scriptOptions.some((o) => o.id === id);
    this.scriptId = known ? id : '';
    if (this.scriptSelect) this.scriptSelect.value = this.scriptId;
  }

  /** Re-reads the script list and the mod summary (they can change while the title screen is closed). */
  private refreshExtras(): void {
    const select = this.scriptSelect;
    if (select) {
      clearChildren(select);
      select.appendChild(el('option', { value: '' }, NO_SCRIPT_LABEL));
      for (const o of this.scriptOptions) select.appendChild(el('option', { value: o.id }, o.name));
      this.pickScript(this.scriptId);
    }
    if (this.modLine) this.modLine.textContent = this.modSummaryText;
  }

  private trainingSection(): HTMLElement[] {
    const button = (kind: TrainingKind): HTMLElement => el('button', { onclick: () => this.startTraining(kind) }, TRAINING_LABELS[kind]);
    const dispatchRow: HTMLElement[] = [];
    if (this.scriptSelect) dispatchRow.push(el('label', { for: 'dispatch-script' }, 'Script'), this.scriptSelect);
    dispatchRow.push(el('button', { onclick: () => this.startTraining('dispatch') }, TRAINING_LABELS.dispatch));
    return [
      el('h2', null, 'Training'),
      el('div', { class: 'row' }, button('drills'), button('report'), button('driving'), button('sandbox')),
      el('div', { class: 'row' }, ...dispatchRow),
      el('p', { class: 'hint' }, 'Practice without a full shift: drills, report writing, a cone course, dispatching AI units, or building your own scenario.'),
    ];
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
