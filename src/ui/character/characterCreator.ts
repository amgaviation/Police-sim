/**
 * The character creator and uniform / gear editor (Phase 7 §12.2): tabs Identity, Body, Uniform, Badge & patch and
 * Gear next to a live 2D sketch of the figure. All behaviour sits in `creatorReducer` and the pure models; this class
 * forwards input to them and mirrors the state into the DOM. Headless (no `document` or no `UIRoot`) it keeps the
 * state and every method but builds no DOM.
 */
import './character.css';
import {
  ASSIGNMENTS,
  GEAR_SLOTS,
  OFFICER_PRESETS,
  assignmentPolicy,
  type LoadoutValidation,
  type OfficerLoadout,
} from '../../gear';
import {
  BADGE_SHAPES,
  CARRIER_IDS,
  CHARACTER_LINES,
  COLD_IDS,
  HAIR_STYLES,
  HAT_IDS,
  PATCH_SHAPES,
  RANK_IDS,
  UNIFORM_CLASSES,
  UNIFORM_DATA,
  applyPronouns,
  buildOutfit,
  displayName,
  figureAppearance,
  pronounLabel,
  rankDef,
  uniformClass,
  type CharacterProfile,
} from '../../uniform';
import { clearChildren, el, type Menu, type UIRoot } from '../ui';
import { PolygonPad } from '../livery/polygonPad';
import { Throttle } from '../livery/preview';
import {
  actionButton,
  barField,
  checkField,
  colorField,
  hexString,
  parseHexColor,
  selectField,
  sliderField,
  textField,
  type Option,
} from '../livery/fields';
import {
  BODY_RANGES,
  CREATOR_TABS,
  CREATOR_TAB_LABELS,
  GEAR_ROWS,
  createCreatorState,
  creatorProfile,
  creatorReducer,
  gearMessages,
  presetLabel,
  skinAt,
  skinPosition,
  type BodyField,
  type CreatorAction,
  type CreatorState,
  type PronounWord,
} from './creatorState';
import { asCanvas2D, drawBadge, drawPatch } from './emblem';
import { SKETCH_HEIGHT_M, figureSketchRects } from './sketch';

/** What the creator needs from the app (design §12.2). */
export interface CreatorHost {
  readonly mode: 'newGame' | 'locker';
  validateGear(l: OfficerLoadout, extraVestSlots: number): LoadoutValidation;
  /** Locker: live update of the 3D officer figure (throttled to 10 Hz, only while the profile is valid). */
  preview?(p: CharacterProfile, gear: OfficerLoadout): void;
  done(p: CharacterProfile, gear: OfficerLoadout): void;
  cancel(): void;
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const SKETCH_W = 220;
const SKETCH_H = 420;
const EMBLEM_PX = 96;

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const humanize = (id: string): string => cap(id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
const opts = <T extends string>(values: readonly T[], label: (v: T) => string = humanize): Option<T>[] => values.map((v) => ({ value: v, label: label(v) }));

const PRONOUN_BUTTONS = [
  { id: 'she', label: 'she / her' },
  { id: 'he', label: 'he / him' },
  { id: 'they', label: 'they / them' },
  { id: 'custom', label: 'custom' },
] as const;

const PRONOUN_WORDS: readonly { word: PronounWord; label: string }[] = [
  { word: 'subject', label: 'Subject (she)' },
  { word: 'object', label: 'Object (her)' },
  { word: 'possessive', label: 'Possessive (her)' },
  { word: 'possessivePronoun', label: 'Possessive pronoun (hers)' },
  { word: 'reflexive', label: 'Reflexive (herself)' },
];

/** The sentence under the pronoun buttons: a real radio line with the character's pronouns applied. */
export function pronounSample(p: CharacterProfile): string {
  const template = CHARACTER_LINES['officerDown'] ?? '{name}: {they} {are} here.';
  return applyPronouns(template, p.pronouns, {
    name: displayName(p),
    pronouns: pronounLabel(p.pronouns),
    callsign: '12',
    near: 'Main Street and 3rd',
    badge: p.badge,
  });
}

interface CreatorDom {
  readonly root: HTMLDivElement;
  readonly tabs: HTMLButtonElement[];
  readonly errors: HTMLElement;
  readonly body: HTMLElement;
  readonly done: HTMLButtonElement;
  readonly sketch: HTMLCanvasElement;
  readonly summary: HTMLElement;
}

export class CharacterCreator implements Menu {
  readonly id = 'character-creator' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly host: CreatorHost;
  private readonly dom: CreatorDom | null;
  private readonly throttle: Throttle<{ profile: CharacterProfile; gear: OfficerLoadout }>;
  private st: CreatorState;
  private openFlag = false;
  private sampleEl: HTMLElement | null = null;
  /** The tab the body was last built for (focus and scroll are kept across rebuilds of the same tab). */
  private renderedTab: CreatorState['tab'] | null = null;
  private emblemCanvases: { badge: HTMLCanvasElement; patch: HTMLCanvasElement } | null = null;

  constructor(ui: UIRoot | null, host: CreatorHost, start: { profile: CharacterProfile; gear: OfficerLoadout }) {
    this.ui = ui;
    this.host = host;
    this.st = createCreatorState(start, (l, extra) => this.host.validateGear(l, extra));
    this.throttle = new Throttle((v) => this.host.preview?.(v.profile, v.gear));
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
    this.render();
  }

  get state(): Readonly<CreatorState> {
    return this.st;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** Done is available while the profile is valid (gear problems only warn). */
  get canDone(): boolean {
    return this.st.errors.length === 0;
  }

  /** Errors and warnings of the current gear. */
  get gearIssues(): { errors: string[]; warnings: string[] } {
    return gearMessages(this.st.gearCheck);
  }

  dispatch(action: CreatorAction): CreatorState {
    this.apply(action);
    return this.st;
  }

  open(): void {
    this.openFlag = true;
    this.ui?.push(this);
  }

  /** Hands the (trimmed) profile and gear to the host and closes; false while the profile is invalid. */
  done(): boolean {
    const profile = creatorProfile(this.st);
    if (profile === null) return false;
    this.throttle.cancel();
    this.host.done(profile, { assignment: this.st.gear.assignment, items: this.st.gear.items.map((it) => ({ ...it })) });
    this.finish();
    return true;
  }

  cancel(): void {
    this.throttle.cancel();
    this.host.cancel();
    this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.key !== 'Escape') return false;
    this.cancel();
    return true;
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) {
      this.throttle.cancel();
      this.host.cancel();
      this.openFlag = false;
    }
  }

  dispose(): void {
    this.throttle.cancel();
  }

  // --- state plumbing -----------------------------------------------------------------------

  private finish(): void {
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  private apply(action: CreatorAction, light = false): void {
    const prev = this.st;
    this.st = creatorReducer(prev, action, (l, extra) => this.host.validateGear(l, extra));
    if (this.st === prev) return;
    if ((this.st.profile !== prev.profile || this.st.gear !== prev.gear) && this.st.errors.length === 0 && this.host.preview) {
      this.throttle.push({ profile: this.st.profile, gear: this.st.gear });
    }
    if (light && this.st.tab === prev.tab) this.refreshChrome();
    else this.render();
  }

  // --- DOM ----------------------------------------------------------------------------------

  private build(): CreatorDom {
    const tabs = CREATOR_TABS.map((tab) =>
      el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', onclick: () => this.apply({ kind: 'tab', tab }) }, CREATOR_TAB_LABELS[tab]),
    );
    const errors = el('div', { class: 'char-errors', role: 'alert' });
    const body = el('div', { class: 'char-body' });
    const sketch = el('canvas', { class: 'char-sketch', width: SKETCH_W, height: SKETCH_H, 'aria-label': 'Sketch of the officer' });
    const summary = el('div', { class: 'char-summary' });
    const done = el('button', { type: 'button', class: 'primary', onclick: () => this.done() }, 'Done');
    const title = this.host.mode === 'newGame' ? 'Create officer' : 'Uniform & gear';
    const root = el(
      'div',
      { class: 'panel char-root', role: 'dialog', 'aria-label': title },
      el('h2', null, title),
      el('div', { class: 'char-tabs', role: 'tablist' }, ...tabs),
      errors,
      el('div', { class: 'char-main' }, body, el('div', { class: 'char-side' }, sketch, summary)),
      el('div', { class: 'char-foot' }, done, actionButton('Cancel', () => this.cancel())),
    );
    return { root, tabs, errors, body, done, sketch, summary };
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    CREATOR_TABS.forEach((tab, i) => dom.tabs[i]?.setAttribute('aria-selected', tab === this.st.tab ? 'true' : 'false'));
    this.sampleEl = null;
    this.emblemCanvases = null;
    // A rebuild of the same tab keeps the keyboard position: the focused control (by its place among the tab's controls)
    // and the scroll offset come back.
    const sameTab = this.renderedTab === this.st.tab;
    const focusAt = sameTab ? focusIndex(dom.body) : -1;
    const scroll = sameTab ? dom.body.scrollTop : 0;
    this.renderedTab = this.st.tab;
    clearChildren(dom.body);
    switch (this.st.tab) {
      case 'identity':
        dom.body.append(this.identityTab());
        break;
      case 'body':
        dom.body.append(this.bodyTab());
        break;
      case 'uniform':
        dom.body.append(this.uniformTab());
        break;
      case 'badge':
        dom.body.append(this.badgeTab());
        break;
      case 'gear':
        dom.body.append(this.gearTab());
        break;
    }
    if (sameTab) {
      dom.body.scrollTop = scroll;
      if (focusAt >= 0) restoreFocus(dom.body, focusAt);
    }
    this.refreshChrome();
  }

  /** Cheap refresh while a text box or slider is being edited. */
  private refreshChrome(): void {
    const dom = this.dom;
    if (!dom) return;
    clearChildren(dom.errors);
    dom.errors.hidden = this.st.errors.length === 0;
    for (const e of this.st.errors) dom.errors.append(el('div', null, e));
    dom.done.disabled = !this.canDone;
    const p = this.st.profile;
    dom.summary.textContent = `${displayName(p)} · ${pronounLabel(p.pronouns)} · badge ${p.badge}`;
    if (this.sampleEl) this.sampleEl.textContent = pronounSample(p);
    this.drawSketch();
    this.drawEmblems();
  }

  private drawSketch(): void {
    const canvas = this.dom?.sketch;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, SKETCH_W, SKETCH_H);
    ctx.fillStyle = '#0d141b';
    ctx.fillRect(0, 0, SKETCH_W, SKETCH_H);
    const p = this.st.profile;
    let rects;
    try {
      const outfit = buildOutfit(p.outfit, { lastName: p.lastName, rank: p.rank });
      rects = figureSketchRects(figureAppearance(p, outfit), outfit);
    } catch {
      return;
    }
    const scale = (SKETCH_H - 20) / SKETCH_HEIGHT_M;
    const baseY = SKETCH_H - 10;
    ctx.fillStyle = '#2a3a4a';
    ctx.fillRect(0, baseY, SKETCH_W, 1);
    for (const r of rects) {
      ctx.fillStyle = hexString(r.color);
      ctx.fillRect(SKETCH_W / 2 + r.x * scale, baseY - (r.y + r.h) * scale, Math.max(1, r.w * scale), Math.max(1, r.h * scale));
    }
  }

  private drawEmblems(): void {
    const c = this.emblemCanvases;
    if (!c) return;
    const o = this.st.profile.outfit;
    const badge = c.badge.getContext('2d');
    const patch = c.patch.getContext('2d');
    if (badge) drawBadge(asCanvas2D(badge), o.badge, EMBLEM_PX);
    if (patch) drawPatch(asCanvas2D(patch), o.patch, EMBLEM_PX);
  }

  private section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return el('section', { class: 'livery-section' }, el('h3', null, title), ...children);
  }

  // --- Identity -----------------------------------------------------------------------------

  private identityTab(): HTMLElement {
    const p = this.st.profile;
    const custom = p.pronouns.id === 'custom';
    const buttons = PRONOUN_BUTTONS.map((b) =>
      el(
        'button',
        {
          type: 'button',
          class: 'small',
          'aria-pressed': p.pronouns.id === b.id ? 'true' : 'false',
          onclick: () => (b.id === 'custom' ? this.apply({ kind: 'setPronounsCustom' }) : this.apply({ kind: 'setPronounPreset', preset: b.id })),
        },
        b.label,
      ),
    );
    this.sampleEl = el('div', { class: 'char-sample', 'aria-live': 'polite' }, pronounSample(p));
    return el(
      'div',
      null,
      this.section(
        'Name',
        textField('First name', p.firstName, (v) => this.apply({ kind: 'setText', field: 'firstName', value: v }, true), { maxLength: 24 }),
        textField('Last name', p.lastName, (v) => this.apply({ kind: 'setText', field: 'lastName', value: v }, true), { maxLength: 24 }),
        textField('Badge number', p.badge, (v) => this.apply({ kind: 'setText', field: 'badge', value: v }, true), { maxLength: 6, placeholder: '3 to 6 digits' }),
      ),
      this.section(
        'Pronouns',
        el('div', { class: 'char-pronouns' }, ...buttons),
        ...(custom
          ? PRONOUN_WORDS.map((w) => textField(w.label, p.pronouns[w.word], (v) => this.apply({ kind: 'setPronounWord', word: w.word, value: v }, true), { maxLength: 12 }))
          : []),
        checkField('Verbs agree in the plural (they are)', p.pronouns.plural, (on) => this.apply({ kind: 'setPlural', plural: on }), {
          disabled: !custom,
          hint: custom ? '' : 'Choose custom to change this.',
        }),
        this.sampleEl,
      ),
    );
  }

  // --- Body ---------------------------------------------------------------------------------

  private bodyTab(): HTMLElement {
    const p = this.st.profile;
    const sliders = (Object.keys(BODY_RANGES) as BodyField[]).map((field) => {
      const r = BODY_RANGES[field];
      return sliderField(
        { key: field, label: r.label, min: r.min, max: r.max, step: r.step },
        p.body[field],
        (v) => this.apply({ kind: 'setBody', field, value: v }, true),
        (v) => (field === 'heightM' ? `${v.toFixed(2)} m` : `${Math.round(v * 100)} %`),
      );
    });
    const swatches = (colors: readonly number[], current: number, pick: (c: number) => void): HTMLElement =>
      el(
        'div',
        { class: 'char-swatches' },
        ...colors.map((c) => {
          const b = el('button', {
            type: 'button',
            class: `char-swatch${c === current ? ' char-selected' : ''}`,
            'aria-label': hexString(c),
            'aria-pressed': c === current ? 'true' : 'false',
            onclick: () => pick(c),
          });
          b.style.background = hexString(c);
          return b;
        }),
      );
    return el(
      'div',
      null,
      this.section('Body', ...sliders),
      this.section(
        'Skin tone',
        swatches(UNIFORM_DATA.skinTones, p.skin, (c) => this.apply({ kind: 'setSkin', color: c })),
        sliderField(
          { key: 'skin', label: 'Fine tone', min: 0, max: 1, step: 0.001 },
          skinPosition(p.skin),
          (v) => this.apply({ kind: 'setSkin', color: skinAt(v) }, true),
          () => '',
        ),
      ),
      this.section(
        'Hair',
        selectField('Style', opts(HAIR_STYLES), p.hairStyle, (v) => this.apply({ kind: 'setHairStyle', style: v })),
        swatches(UNIFORM_DATA.hairColors, p.hairColor, (c) => this.apply({ kind: 'setHairColor', color: c })),
        colorField('Custom colour', hexString(p.hairColor), (hex) => {
          const c = parseHexColor(hex);
          if (c !== null) this.apply({ kind: 'setHairColor', color: c }, true);
        }),
      ),
    );
  }

  // --- Uniform ------------------------------------------------------------------------------

  private uniformTab(): HTMLElement {
    const p = this.st.profile;
    const o = p.outfit;
    const cls = uniformClass(o.uniform);
    const colors = o.colors;
    const colorFields: HTMLElement[] =
      colors === null
        ? []
        : [
            colorField('Shirt colour', hexString(colors.top), (hex) => {
              const c = parseHexColor(hex);
              if (c !== null) this.apply({ kind: 'setColors', colors: { top: c, bottom: colors.bottom } }, true);
            }),
            colorField('Trouser colour', hexString(colors.bottom), (hex) => {
              const c = parseHexColor(hex);
              if (c !== null) this.apply({ kind: 'setColors', colors: { top: colors.top, bottom: c } }, true);
            }),
          ];
    return el(
      'div',
      null,
      this.section(
        'Uniform',
        selectField('Class', opts(UNIFORM_CLASSES, (c) => uniformClass(c).label), o.uniform, (v) => this.apply({ kind: 'setUniform', uniform: v })),
        selectField('Rank', opts(RANK_IDS, (r) => rankDef(r).label), p.rank, (v) => this.apply({ kind: 'setRank', rank: v })),
        selectField('Hat', [{ value: 'default', label: `Class default (${humanize(cls.hat)})` }, ...opts(HAT_IDS)], o.hat, (v) => this.apply({ kind: 'setHat', hat: v })),
        selectField('Vest carrier', [{ value: 'default', label: `Class default (${humanize(cls.carrier)})` }, ...opts(CARRIER_IDS)], o.carrier, (v) => this.apply({ kind: 'setCarrier', carrier: v })),
        selectField('Cold weather', opts(COLD_IDS), o.cold, (v) => this.apply({ kind: 'setCold', cold: v })),
        checkField('Name plate', o.namePlate, (on) => this.apply({ kind: 'setNamePlate', on })),
      ),
      this.section(
        'Colours',
        checkField('Custom colours', colors !== null, (on) => this.apply({ kind: 'setColors', colors: on ? { top: cls.top, bottom: cls.bottom } : null })),
        ...colorFields,
      ),
    );
  }

  // --- Badge & patch ------------------------------------------------------------------------

  private badgeTab(): HTMLElement {
    const o = this.st.profile.outfit;
    const badge = o.badge;
    const patch = o.patch;
    const badgeCanvas = el('canvas', { class: 'char-emblem', width: EMBLEM_PX, height: EMBLEM_PX, 'aria-label': 'Badge preview' });
    const patchCanvas = el('canvas', { class: 'char-emblem', width: EMBLEM_PX, height: EMBLEM_PX, 'aria-label': 'Patch preview' });
    this.emblemCanvases = { badge: badgeCanvas, patch: patchCanvas };
    const pad = (points: readonly [number, number][], onChange: (p: [number, number][]) => void): HTMLElement =>
      el('div', { class: 'livery-field' }, el('span', { class: 'livery-label' }, 'Outline'), new PolygonPad({ points, minPoints: 3, onChange }).element);
    const colour = (label: string, value: number, apply: (c: number) => void): HTMLElement =>
      colorField(label, hexString(value), (hex) => {
        const c = parseHexColor(hex);
        if (c !== null) apply(c);
      });
    return el(
      'div',
      null,
      this.section(
        'Badge',
        el('div', { class: 'char-emblem-row' }, badgeCanvas),
        selectField('Shape', opts(BADGE_SHAPES), badge.shape, (v) => this.apply({ kind: 'setBadge', patch: { shape: v } })),
        ...(badge.shape === 'star'
          ? [sliderField({ key: 'starPoints', label: 'Points', min: 3, max: 12, step: 1 }, badge.starPoints ?? 5, (v) => this.apply({ kind: 'setBadge', patch: { starPoints: v } }, true))]
          : []),
        ...(badge.shape === 'polygon' ? [pad(badge.points ?? [], (points) => this.apply({ kind: 'setBadge', patch: { points } }))] : []),
        colour('Metal', badge.metal, (c) => this.apply({ kind: 'setBadge', patch: { metal: c } }, true)),
        colour('Enamel', badge.enamel, (c) => this.apply({ kind: 'setBadge', patch: { enamel: c } }, true)),
        textField('Text', badge.text, (v) => this.apply({ kind: 'setBadge', patch: { text: v } }, true), { maxLength: 12 }),
      ),
      this.section(
        'Shoulder patch',
        el('div', { class: 'char-emblem-row' }, patchCanvas),
        selectField('Shape', opts(PATCH_SHAPES), patch.shape, (v) => this.apply({ kind: 'setPatch', patch: { shape: v } })),
        ...(patch.shape === 'polygon' ? [pad(patch.points ?? [], (points) => this.apply({ kind: 'setPatch', patch: { points } }))] : []),
        colour('Base', patch.base, (c) => this.apply({ kind: 'setPatch', patch: { base: c } }, true)),
        colour('Border', patch.border, (c) => this.apply({ kind: 'setPatch', patch: { border: c } }, true)),
        colour('Accent', patch.accent, (c) => this.apply({ kind: 'setPatch', patch: { accent: c } }, true)),
        textField('Initials', patch.initials, (v) => this.apply({ kind: 'setPatch', patch: { initials: v } }, true), { maxLength: 4 }),
        textField('Text', patch.text, (v) => this.apply({ kind: 'setPatch', patch: { text: v } }, true), { maxLength: 16 }),
      ),
    );
  }

  // --- Gear ---------------------------------------------------------------------------------

  private gearTab(): HTMLElement {
    const g = this.st.gear;
    const check = this.st.gearCheck;
    const msgs = gearMessages(check);
    const presets: Option<string>[] = [{ value: '', label: 'Apply a preset…' }, ...Object.keys(OFFICER_PRESETS).map((id) => ({ value: id, label: presetLabel(id) }))];
    const rows = GEAR_ROWS.map((def) => {
      const item = g.items.find((it) => it.id === def.id);
      const count = item?.count ?? 0;
      const retention =
        def.retention && count > 0
          ? el(
              'select',
              {
                'aria-label': `${def.label} retention level`,
                onchange: (e: Event) => this.apply({ kind: 'setRetention', id: def.id, level: Number((e.target as HTMLSelectElement).value) as 1 | 2 | 3 }),
              },
              ...([1, 2, 3] as const).map((level) => el('option', { value: String(level), selected: (item?.retention ?? 2) === level }, `Level ${String(level)}`)),
            )
          : null;
      if (retention && item) retention.value = String(item.retention ?? 2);
      return el(
        'div',
        { class: 'livery-loadout-row', role: 'group', 'aria-label': `${def.label}: ${String(count)}` },
        el('span', { class: 'livery-loadout-name' }, def.label, el('span', { class: 'livery-hint' }, ` ${String(def.weightKg)} kg`)),
        retention,
        actionButton('−', () => this.apply({ kind: 'setItem', id: def.id, count: count - 1 }), 'small', count === 0, `Remove one ${def.label} (${String(count)} now)`),
        el('span', { class: 'livery-value' }, String(count)),
        actionButton('+', () => this.apply({ kind: 'setItem', id: def.id, count: count + 1 }), 'small', count >= def.max, `Add one ${def.label} (${String(count)} now)`),
      );
    });
    const bars: HTMLElement[] = [];
    if (check) {
      bars.push(barField('Weight', check.weightKg, check.capacityKg, ' kg'));
      for (const slot of GEAR_SLOTS) {
        const s = check.slots[slot];
        if (s.cap > 0 || s.used > 0) bars.push(barField(humanize(slot), s.used, s.cap, ''));
      }
    }
    return el(
      'div',
      null,
      this.section(
        'Assignment',
        selectField('Assignment', opts(ASSIGNMENTS, (a) => assignmentPolicy(a).label), g.assignment, (v) => this.apply({ kind: 'setAssignment', assignment: v })),
        selectField('Preset', presets, '', (v) => {
          if (v !== '') this.apply({ kind: 'applyPreset', preset: v });
        }),
        ...bars,
        ...msgs.errors.map((m) => el('div', { class: 'livery-msg livery-msg-error' }, m)),
        ...msgs.warnings.map((m) => el('div', { class: 'livery-msg' }, m)),
        msgs.errors.length > 0 ? el('div', { class: 'livery-hint' }, 'Gear problems are warnings: you can still continue.') : null,
      ),
      this.section('Items', ...rows),
    );
  }
}

const FOCUSABLE = 'button, input, select, textarea';

/** Place of the focused control among the controls of `root`, -1 when focus is elsewhere. */
function focusIndex(root: HTMLElement): number {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (!active || !root.contains(active)) return -1;
  return Array.from(root.querySelectorAll(FOCUSABLE)).indexOf(active);
}

/** Focuses control `index` of the rebuilt `root`; when it is disabled now (a "-" at zero) the next enabled control, else the previous one. */
function restoreFocus(root: HTMLElement, index: number): void {
  const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  const enabled = (c: HTMLElement | undefined): c is HTMLElement => c !== undefined && !(c as HTMLButtonElement).disabled;
  const pick = [controls[index], controls[index + 1], controls[index - 1]].find(enabled);
  pick?.focus({ preventScroll: true });
}
