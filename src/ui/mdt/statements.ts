/**
 * Statements of fact (design phase 5 §12.1): the checklist of an incident report and the grade view of a filed one.
 * `statementBlocks`, `normalizeAssertions` and `gradeSections` are pure; `statementsField` is the DOM checklist the
 * report form embeds. The hidden `truth` of a report choice never reaches this module (`MdtDeps.reportChoices` strips it).
 */
import { clearChildren, el } from '../ui';
import { nextId } from './dom';
import type { MdtLine, MdtSection } from './model';

/** One statement the officer may assert (a `ReportChoice` without its hidden fields). */
export interface ChoiceInfo {
  readonly id: string;
  /** Exclusive group (at most one may be asserted), null = independent. */
  readonly group: string | null;
  readonly text: string;
}

/** A checkbox, or the radio set of one exclusive group, in the order of first appearance. */
export type StatementBlock =
  | { readonly kind: 'check'; readonly choice: ChoiceInfo }
  | { readonly kind: 'group'; readonly group: string; readonly items: readonly ChoiceInfo[] };

/** Groups choices: independent ones stay single checkboxes, a group becomes one radio set where its first member stood. */
export function statementBlocks(choices: readonly ChoiceInfo[]): StatementBlock[] {
  const blocks: StatementBlock[] = [];
  const groups = new Map<string, ChoiceInfo[]>();
  for (const c of choices) {
    if (c.group === null) {
      blocks.push({ kind: 'check', choice: c });
      continue;
    }
    let items = groups.get(c.group);
    if (!items) {
      items = [];
      groups.set(c.group, items);
      blocks.push({ kind: 'group', group: c.group, items });
    }
    items.push(c);
  }
  return blocks;
}

/**
 * The asserted ids that are valid for `choices`: unknown and repeated ids dropped, and only the first member (in choice
 * order) of an exclusive group kept. The result follows the choice order.
 */
export function normalizeAssertions(choices: readonly ChoiceInfo[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  const usedGroups = new Set<string>();
  const out: string[] = [];
  for (const c of choices) {
    if (!wanted.has(c.id)) continue;
    if (c.group !== null) {
      if (usedGroups.has(c.group)) continue;
      usedGroups.add(c.group);
    }
    out.push(c.id);
  }
  return out;
}

// --- Grade view ---------------------------------------------------------------------------------

/** A graded report as the MDT shows it (`MdtDeps.reportGrade`). */
export interface ReportGradeView {
  readonly score: number;
  readonly letter: string;
  readonly missing: readonly string[];
  readonly contradictions: readonly { readonly text: string; readonly onCamera: boolean }[];
  readonly unsupported: readonly string[];
}

function letterSeverity(letter: string): MdtLine['severity'] {
  if (letter === 'A' || letter === 'B') return 'none';
  return letter === 'C' ? 'caution' : 'alert';
}

/** The grade lines under a filed report: score and letter, then the missing, contradicted (bodycam first) and unsupported statements. */
export function gradeSections(grade: ReportGradeView | null): MdtSection[] {
  if (!grade) return [];
  const lines: MdtLine[] = [{ label: 'Score', text: `${String(Math.round(grade.score))} / 100 (${grade.letter})`, severity: letterSeverity(grade.letter) }];
  const camFirst = [...grade.contradictions].sort((a, b) => Number(b.onCamera) - Number(a.onCamera));
  for (const c of camFirst) {
    lines.push({ label: c.onCamera ? 'Contradicted on bodycam' : 'Contradicted by the record', text: c.text, severity: c.onCamera ? 'alert' : 'caution' });
  }
  for (const m of grade.missing) lines.push({ label: 'Missing', text: m, severity: 'caution' });
  for (const u of grade.unsupported) lines.push({ label: 'Unsupported', text: u, severity: 'caution' });
  if (lines.length === 1) lines.push({ label: 'Notes', text: 'Complete and consistent with the record', severity: 'info' });
  return [{ id: 'grade', title: 'Report grade', lines }];
}

// --- DOM checklist --------------------------------------------------------------------------------

export interface StatementsField {
  readonly element: HTMLElement;
  /** The checked ids (radios: the chosen one), in display order. */
  assertions(): string[];
  /** Rebuilds the list for another call, keeping the ticks that still apply. */
  setCall(callId: number | null): void;
}

/**
 * The "Statements of fact" fieldset: a checkbox per independent statement and a radio set (with a "none of these"
 * entry) per exclusive group. Hidden while the call has no statements.
 */
export function statementsField(source: (callId: number | null) => readonly ChoiceInfo[], callId: number | null, checked: readonly string[]): StatementsField {
  const body = el('div', { class: 'mdt-statements-body' });
  const element = el('fieldset', { class: 'mdt-checklist mdt-statements' },
    el('legend', null, 'Statements of fact'),
    el('p', { class: 'mdt-hint' }, 'Tick what you are putting in your report. Statements the record does not support count against you.'),
    body);
  const inputs: HTMLInputElement[] = [];
  let ticked = new Set(checked);

  const read = (): string[] => inputs.filter((i) => i.checked && i.value !== '').map((i) => i.value);

  const render = (choices: readonly ChoiceInfo[]): void => {
    clearChildren(body);
    inputs.length = 0;
    element.hidden = choices.length === 0;
    for (const block of statementBlocks(choices)) {
      if (block.kind === 'check') {
        const id = nextId('st');
        const box = el('input', { type: 'checkbox', id, value: block.choice.id });
        box.checked = ticked.has(block.choice.id);
        inputs.push(box);
        body.appendChild(el('div', { class: 'mdt-check' }, box, el('label', { for: id }, block.choice.text)));
        continue;
      }
      const name = nextId('grp');
      const set = el('fieldset', { class: 'mdt-radioset' }, el('legend', null, 'Choose one'));
      const none = el('input', { type: 'radio', id: `${name}-none`, name, value: '' });
      const chosen = block.items.find((c) => ticked.has(c.id));
      none.checked = chosen === undefined;
      set.appendChild(el('div', { class: 'mdt-check' }, none, el('label', { for: `${name}-none` }, '(none of these)')));
      block.items.forEach((c, i) => {
        const id = `${name}-${String(i)}`;
        const radio = el('input', { type: 'radio', id, name, value: c.id });
        radio.checked = chosen?.id === c.id;
        inputs.push(radio);
        set.appendChild(el('div', { class: 'mdt-check' }, radio, el('label', { for: id }, c.text)));
      });
      body.appendChild(set);
    }
  };

  render(source(callId));
  return {
    element,
    assertions: read,
    setCall: (next) => {
      ticked = new Set(read());
      render(source(next));
    },
  };
}
