import { DOR_CATEGORIES, dorCategoryLabel, type CareerRequest, type DorCategory, type Trainee } from '../../career';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { Menu, UIRoot } from '../ui';
import './career.css';
import { focusKeyOf, keepFocus, tagOf } from './dom';
import { HEADLESS_ELEMENT, canBuildDom } from './types';

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const DEFAULT_RATING = 3;

/** All categories at the middle rating. */
export function defaultRatings(): Record<DorCategory, number> {
  const out = {} as Record<DorCategory, number>;
  for (const c of DOR_CATEGORIES) out[c] = DEFAULT_RATING;
  return out;
}

/** Sets a rating (rounded and clamped to 1..5); returns a new record. */
export function setRating(r: Readonly<Record<DorCategory, number>>, category: DorCategory, value: number): Record<DorCategory, number> {
  const v = Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(Number.isFinite(value) ? value : DEFAULT_RATING)));
  return { ...r, [category]: v };
}

/** The career request a submitted rating sends. */
export function ratingRequest(r: Readonly<Record<DorCategory, number>>): Extract<CareerRequest, { kind: 'traineeRating' }> {
  const ratings = {} as Record<DorCategory, number>;
  for (const c of DOR_CATEGORIES) ratings[c] = Math.min(RATING_MAX, Math.max(RATING_MIN, Math.round(r[c])));
  return { kind: 'traineeRating', ratings };
}

/** The panel's rows: label and current value per category (the trainee's hidden true scores are never shown). */
export function traineeModel(t: Readonly<Trainee> | null, r: Readonly<Record<DorCategory, number>>): {
  name: string;
  rows: { category: DorCategory; label: string; value: number }[];
} {
  return {
    name: t?.name ?? '',
    rows: DOR_CATEGORIES.map((category) => ({ category, label: dorCategoryLabel(category), value: r[category] })),
  };
}

/** What the trainee panel needs. */
export interface TraineeHost {
  trainee(): Readonly<Trainee> | null;
  request(r: CareerRequest): void;
  close(): void;
}

/**
 * FTO trainee rating (pausing Menu, id 'trainee'): five categories rated 1..5 (the DOR scale) for the trainee of the
 * shift; Submit sends `traineeRating`, which scores how close the ratings are to the trainee's true performance.
 * Keys: Up/Down choose the category, Left/Right or 1-5 set the rating, Enter submits, Escape leaves without rating.
 */
export class TraineeEvalPanel implements Menu {
  readonly id = 'trainee' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly body: HTMLDivElement | null;
  private readonly hint: HTMLDivElement | null;
  private openFlag = false;
  private ratings = defaultRatings();
  private focusIdx = 0;

  private readonly ui: UIRoot | null;
  private readonly host: TraineeHost;

  constructor(ui: UIRoot | null, host: TraineeHost) {
    this.ui = ui;
    this.host = host;
    if (canBuildDom(ui)) {
      const root = div('cr-panel cr-trainee');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'Trainee evaluation');
      this.body = div('cr-body', root);
      this.hint = div('cr-hint', root);
      this.element = root;
    } else {
      this.body = null;
      this.hint = null;
      this.element = HEADLESS_ELEMENT;
    }
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get current(): Readonly<Record<DorCategory, number>> {
    return this.ratings;
  }

  /** Opens the panel; false (and nothing opens) without a trainee. */
  open(): boolean {
    if (this.host.trainee() === null) return false;
    this.ratings = defaultRatings();
    this.focusIdx = 0;
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    return true;
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  /** Sets a category rating. */
  rate(category: DorCategory, value: number): void {
    this.ratings = setRating(this.ratings, category, value);
    this.render();
  }

  /** Sends the rating and closes. */
  submit(): CareerRequest | null {
    if (!this.openFlag || this.host.trainee() === null) return null;
    const request = ratingRequest(this.ratings);
    this.host.request(request);
    this.close();
    this.host.close();
    return request;
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    const category = DOR_CATEGORIES[this.focusIdx] as DorCategory;
    switch (event.key) {
      case 'Escape':
        this.close();
        this.host.close();
        return true;
      case 'Enter':
        if (tagOf(event.target) === 'BUTTON' && focusKeyOf(event.target) !== 'submit') return false;
        if (!event.repeat) this.submit();
        return true;
      case 'ArrowUp':
        this.focusIdx = (this.focusIdx + DOR_CATEGORIES.length - 1) % DOR_CATEGORIES.length;
        this.render();
        return true;
      case 'ArrowDown':
        this.focusIdx = (this.focusIdx + 1) % DOR_CATEGORIES.length;
        this.render();
        return true;
      case 'ArrowLeft':
        this.rate(category, this.ratings[category] - 1);
        return true;
      case 'ArrowRight':
        this.rate(category, this.ratings[category] + 1);
        return true;
      default: {
        const digit = /^(?:Digit|Numpad)?([1-5])$/.exec(event.key);
        if (!digit) return false;
        this.rate(category, Number(digit[1]));
        return true;
      }
    }
  }

  dispose(): void {
    this.close();
    if (this.body) this.element.remove();
  }

  private render(): void {
    const body = this.body;
    if (!body) return;
    const model = traineeModel(this.host.trainee(), this.ratings);
    keepFocus(body, () => {
      clearChildren(body);
      body.appendChild(el('h2', { class: 'cr-title' }, `Rate your trainee: ${model.name}`));
      body.appendChild(el('p', { class: 'cr-dim' }, '1 = unacceptable · 3 = meets standard · 5 = outstanding. The closer you are to their real performance, the more career points you earn.'));
      model.rows.forEach((row, i) => {
        const group = el('div', { class: `cr-rating${i === this.focusIdx ? ' cr-current' : ''}`, role: 'radiogroup', 'aria-label': row.label });
        group.appendChild(el('span', { class: 'cr-rating-label' }, row.label));
        for (let n = RATING_MIN; n <= RATING_MAX; n++) {
          group.appendChild(el('button', {
            type: 'button', role: 'radio', 'aria-checked': row.value === n ? 'true' : 'false', 'data-focus': `${row.category}:${String(n)}`,
            class: `cr-btn cr-rate${row.value === n ? ' cr-picked' : ''}`, onclick: () => { this.focusIdx = i; this.rate(row.category, n); },
          }, String(n)));
        }
        body.appendChild(group);
      });
      body.appendChild(el('div', { class: 'cr-actions' },
        el('button', { type: 'button', class: 'cr-btn cr-primary', 'data-focus': 'submit', onclick: () => { this.submit(); } }, 'Submit ratings'),
        el('button', { type: 'button', class: 'cr-btn', onclick: () => { this.close(); this.host.close(); } }, 'Skip')));
    });
    if (this.hint) setText(this.hint, '↑/↓ category · ←/→ or 1-5 rating · Enter submits · Esc skips');
  }
}
