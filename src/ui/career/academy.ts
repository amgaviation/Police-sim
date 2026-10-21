import { hashString } from '../../core/rng';
import {
  ACADEMY_MODULES, CAREER_CONFIG, academyModuleLabel, recordAcademyScore,
  type AcademyModule, type AcademyRecord, type PerformanceMods,
} from '../../career';
import { COURSES } from '../../training/course';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { Menu, UIRoot } from '../ui';
import './career.css';
import { DefensiveDrillScreen } from './defensive';
import { LegalQuizScreen } from './legalQuiz';
import { RangeMinigame } from './range';
import { ReportExerciseScreen } from './reportExercise';
import { HEADLESS_ELEMENT, canBuildDom, type MinigameOptions, type MinigameScreen } from './types';

/** What the academy screens need from the session (design §11.1). */
export interface AcademyHost {
  seed(): number;
  records(): Readonly<Record<AcademyModule, AcademyRecord>>;
  /** Performance penalties for the range sway. */
  mods(): Readonly<PerformanceMods>;
  /**
   * Records an attempt. In a paused session the career request queue does not run, so the host must make the record
   * visible to `records()` at once (e.g. queue the request and step the career with dt 0).
   */
  submit(module: AcademyModule, score: number): void;
  /** Closes the academy and starts the driving course run (the integrator's job). */
  startDrivingCourse(courseId: string): void;
  canGraduate(): boolean;
  graduate(): void;
  close(): void;
  readonly standalone: boolean;
}

export interface AcademyRow {
  module: AcademyModule;
  label: string;
  /** Best score or '--' when never tried. */
  best: string;
  attempts: number;
  passed: boolean;
  /** Pass mark of the module. */
  pass: number;
}

/** Rows of the academy hub and whether every module is passed. */
export function academyModel(
  records: Readonly<Record<AcademyModule, AcademyRecord>>,
  passMarks: Readonly<Record<AcademyModule, number>>,
): { rows: AcademyRow[]; canGraduate: boolean } {
  const rows = ACADEMY_MODULES.map((module): AcademyRow => {
    const r = records[module];
    return {
      module,
      label: academyModuleLabel(module),
      best: r.best < 0 ? '--' : String(Math.round(r.best)),
      attempts: r.attempts,
      passed: r.passed,
      pass: passMarks[module],
    };
  });
  return { rows, canGraduate: rows.every((row) => row.passed) };
}

export const TRAINING_STORAGE_KEY = 'patrol-training-records';
const NEUTRAL_MODS: Readonly<PerformanceMods> = Object.freeze({ aimSpread: 1, steerLagS: 0, vignette: 0 });

function emptyRecords(): Record<AcademyModule, AcademyRecord> {
  const out = {} as Record<AcademyModule, AcademyRecord>;
  for (const m of ACADEMY_MODULES) out[m] = { best: -1, attempts: 0, passed: false };
  return out;
}

/** Records from a stored JSON string; anything malformed falls back to the empty record of that module. */
export function parseTrainingRecords(text: string | null): Record<AcademyModule, AcademyRecord> {
  const out = emptyRecords();
  if (text === null) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;
  for (const m of ACADEMY_MODULES) {
    const r = (raw as Record<string, unknown>)[m];
    if (typeof r !== 'object' || r === null) continue;
    const { best, attempts, passed } = r as Record<string, unknown>;
    if (typeof best === 'number' && Number.isFinite(best) && typeof attempts === 'number' && Number.isInteger(attempts) && attempts >= 0) {
      out[m] = { best: Math.min(100, Math.max(-1, best)), attempts, passed: passed === true };
    }
  }
  return out;
}

/**
 * localStorage 'patrol-training-records': best / attempts per module for the no-world drills (academy drills and the
 * report-writing-only mode). Reads and writes are wrapped in try/catch, so a missing or blocked storage just means the
 * records do not persist. Graduation and the driving course are not available.
 */
export function standaloneAcademyHost(storage: Pick<Storage, 'getItem' | 'setItem'> | null, onClose: () => void): AcademyHost {
  let records = emptyRecords();
  try {
    records = parseTrainingRecords(storage?.getItem(TRAINING_STORAGE_KEY) ?? null);
  } catch {
    records = emptyRecords();
  }
  const seed = hashString('patrol-training');
  return {
    standalone: true,
    seed: () => seed,
    records: () => records,
    mods: () => NEUTRAL_MODS,
    submit(module, score) {
      records = { ...records, [module]: recordAcademyScore(records[module], module, score) };
      try {
        storage?.setItem(TRAINING_STORAGE_KEY, JSON.stringify(records));
      } catch {
        // Storage full or blocked: the records live for this session only.
      }
    },
    startDrivingCourse: () => undefined,
    canGraduate: () => false,
    graduate: () => undefined,
    close: onClose,
  };
}

interface HubDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly footer: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * Academy hub (pausing Menu, id 'academy'): one row per module with best score, attempts and pass mark, a Start button
 * (keys 1-5) that opens the minigame screen, a driving course picker, and Graduate when every module is passed (hidden
 * in standalone hosts). Escape closes through `host.close()`.
 */
export class AcademyScreen implements Menu {
  readonly id = 'academy' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: HubDom | null;
  private openFlag = false;
  private active: MinigameScreen | null = null;
  private courseId: string = COURSES[0]?.id ?? 'basic';
  private message = '';

  private readonly ui: UIRoot | null;
  private readonly host: AcademyHost;

  constructor(ui: UIRoot | null, host: AcademyHost) {
    this.ui = ui;
    this.host = host;
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The minigame screen opened from the hub, null when none. */
  get activeScreen(): MinigameScreen | null {
    return this.active;
  }

  get model(): ReturnType<typeof academyModel> {
    return academyModel(this.host.records(), CAREER_CONFIG.academy.pass);
  }

  open(): void {
    this.openFlag = true;
    this.message = '';
    this.refresh();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.active?.close();
    this.active = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onShow(): void {
    this.refresh();
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'Escape') {
      this.leave();
      return true;
    }
    const digit = /^(?:Digit|Numpad)?([1-5])$/.exec(event.key);
    if (digit) {
      const module = ACADEMY_MODULES[Number(digit[1]) - 1];
      if (module !== undefined && !event.repeat) this.launch(module);
      return true;
    }
    return false;
  }

  /** Picks the driving course the Driving row starts. */
  setCourse(id: string): void {
    if (COURSES.some((c) => c.id === id)) this.courseId = id;
  }

  /** Starts a module: a minigame screen above the hub, or the driving course through the host. */
  launch(module: AcademyModule): MinigameScreen | null {
    if (module === 'driving') {
      if (this.host.standalone) {
        this.message = 'The driving course needs a vehicle: use Driving academy from the main menu';
        this.refresh();
        return null;
      }
      this.host.startDrivingCourse(this.courseId);
      return null;
    }
    const opts: MinigameOptions = {
      seed: this.host.seed(),
      attempt: this.host.records()[module].attempts,
      onScore: (score) => { this.host.submit(module, score); },
      onExit: () => { this.active = null; this.refresh(); },
    };
    this.active?.close();
    const screen = this.create(module, opts);
    this.active = screen;
    screen.open();
    return screen;
  }

  /** Graduates when every module is passed (Career mode). */
  graduate(): boolean {
    if (this.host.standalone || !this.host.canGraduate()) return false;
    this.host.graduate();
    return true;
  }

  /** Leaves the hub (Escape / Close). */
  leave(): void {
    this.host.close();
  }

  refresh(): void {
    const dom = this.dom;
    if (!dom) return;
    const model = this.model;
    clearChildren(dom.body);
    setText(dom.title, this.host.standalone ? 'Training drills' : 'Academy');
    const table = el('table', { class: 'cr-table', 'aria-label': 'Academy modules' },
      el('thead', null, el('tr', null, ['Module', 'Best', 'Attempts', 'Pass mark', 'Status', ''].map((h) => el('th', { scope: 'col' }, h)))),
    );
    const tbody = el('tbody');
    model.rows.forEach((row, i) => {
      const status = row.passed ? 'Passed' : row.attempts > 0 ? 'Not passed' : 'Not tried';
      const cls = row.passed ? 'cr-ok' : row.attempts > 0 ? 'cr-caution' : '';
      tbody.appendChild(el('tr', { class: cls },
        el('th', { scope: 'row' }, `${String(i + 1)}  ${row.label}`),
        el('td', { class: 'cr-num' }, row.best),
        el('td', { class: 'cr-num' }, String(row.attempts)),
        el('td', { class: 'cr-num' }, String(row.pass)),
        el('td', null, status),
        el('td', null, el('button', {
          type: 'button', class: 'cr-btn', onclick: () => { this.launch(row.module); },
        }, row.attempts > 0 ? 'Retry' : 'Start')),
      ));
    });
    table.appendChild(tbody);
    dom.body.appendChild(table);
    if (!this.host.standalone) {
      const select = el('select', { id: 'cr-course', 'aria-label': 'Driving course', onchange: (e: Event) => { this.setCourse((e.target as HTMLSelectElement).value); } },
        COURSES.map((c) => el('option', { value: c.id, selected: c.id === this.courseId || null }, c.label)));
      dom.body.appendChild(el('div', { class: 'cr-row' }, el('label', { for: 'cr-course' }, 'Driving course '), select));
    }
    clearChildren(dom.footer);
    if (!this.host.standalone) {
      dom.footer.appendChild(el('button', {
        type: 'button', class: 'cr-btn cr-primary', disabled: !model.canGraduate, onclick: () => { this.graduate(); },
      }, 'Graduate'));
      if (!model.canGraduate) dom.footer.appendChild(el('span', { class: 'cr-dim' }, 'Pass every module to graduate'));
    }
    dom.footer.appendChild(el('button', { type: 'button', class: 'cr-btn', onclick: () => { this.leave(); } }, 'Close'));
    setText(dom.hint, this.message !== '' ? this.message : '1-5 start a module · Esc closes');
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private create(module: Exclude<AcademyModule, 'driving'>, opts: MinigameOptions): MinigameScreen {
    switch (module) {
      case 'firearms':
        return new RangeMinigame(this.ui, opts, () => this.host.mods());
      case 'defensive':
        return new DefensiveDrillScreen(this.ui, opts);
      case 'report':
        return new ReportExerciseScreen(this.ui, opts);
      case 'legal':
        return new LegalQuizScreen(this.ui, { mode: 'academy', ...opts });
    }
  }

  private build(): HubDom {
    const root = div('cr-panel cr-academy');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Academy');
    const title = div('cr-title', root);
    const body = div('cr-body', root);
    const footer = div('cr-actions', root);
    const hint = div('cr-hint', root);
    return { root, title, body, footer, hint };
  }
}
