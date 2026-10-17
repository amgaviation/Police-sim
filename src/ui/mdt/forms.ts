/**
 * MDT document forms (design §13.2 tab 8): incident report builder, citation writer, booking,
 * evidence log entry and supplemental narrative. A form is built once when opened and never rebuilt
 * while the user edits it; `read()` returns the draft fields for `DocumentStore.create/update`.
 */
import type { CadState } from '../../cad/cadState';
import { findStatute, STATUTES } from '../../cad/data';
import {
  EVIDENCE_CATEGORIES,
  PERSON_ROLES,
  citationTotal,
  type CitationViolation,
  type DocKind,
  type DraftFields,
  type EvidenceCategory,
  type PersonRole,
} from '../../cad/documents';
import { formatClockTime } from '../../records/calendar';
import { PERSON_POPULATION } from '../../records/ids';
import { displayName, personIdentity } from '../../records/person';
import { clearChildren, el } from '../ui';
import { areaField, button, checkList, numberField, selectField, setText, textField, type Option } from './dom';

export interface FormEnv {
  readonly cad: CadState;
  /** Records seed (cheap name display). */
  readonly seed: number;
}

export interface FormOptions {
  /** Citation prefilled with the registered owner because the driver was not identified. */
  readonly idUnverified?: boolean;
}

export interface DocFormView {
  readonly kind: DocKind;
  readonly element: HTMLElement;
  read(): DraftFields<DocKind>;
  focus(): void;
}

const SECONDS_PER_DAY = 86400;

function personName(seed: number, id: number): string {
  if (!Number.isInteger(id) || id < 0 || id >= PERSON_POPULATION) return id < 0 ? '' : 'UNKNOWN PERSON';
  return displayName(personIdentity(seed, id));
}

function intOf(input: HTMLInputElement, fallback: number): number {
  const n = Number(input.value.trim());
  return input.value.trim() !== '' && Number.isInteger(n) ? n : fallback;
}

function numOrNull(input: HTMLInputElement): number | null {
  const text = input.value.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** "HH:MM" on the day of `baseGame` (game seconds); `baseGame` when unparsable. */
export function parseClock(text: string, baseGame: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return baseGame;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return baseGame;
  return Math.floor(baseGame / SECONDS_PER_DAY) * SECONDS_PER_DAY + h * 3600 + min * 60;
}

/** Calls a document can be linked to: none, then the newest 30 calls. */
export function callOptions(cad: CadState): Option[] {
  const calls = cad.calls();
  const out: Option[] = [{ value: '', label: '(no call)' }];
  for (let i = calls.length - 1; i >= 0 && out.length <= 30; i--) {
    const c = calls[i];
    if (c) out.push({ value: String(c.id), label: `${c.number} ${c.nature} (${c.status})` });
  }
  return out;
}

function callSelect(cad: CadState, callId: number | null | undefined): { element: HTMLElement; read(): number | null } {
  const options = callOptions(cad);
  const value = callId !== null && callId !== undefined ? String(callId) : '';
  if (value !== '' && !options.some((o) => o.value === value)) options.push({ value, label: `C-${value.padStart(5, '0')}` });
  const f = selectField('Call', options, value);
  return { element: f.element, read: () => (f.control.value === '' ? null : Number(f.control.value)) };
}

const STATUTE_OPTIONS: readonly Option[] = STATUTES.map((s) => ({ value: s.id, label: `${s.id} ${s.title} (${s.cls})` }));
const CITEABLE_OPTIONS: readonly Option[] = STATUTES.filter((s) => s.citeable).map((s) => ({ value: s.id, label: `${s.id} ${s.title} - $${s.fine}` }));
const BOOKABLE_OPTIONS: readonly Option[] = STATUTES.filter((s) => s.bookable).map((s) => ({ value: s.id, label: `${s.id} ${s.title} (${s.cls})` }));
const ROLE_OPTIONS: readonly Option[] = PERSON_ROLES.map((r) => ({ value: r, label: r }));
const CATEGORY_OPTIONS: readonly Option[] = EVIDENCE_CATEGORIES.map((c) => ({ value: c, label: c }));

/** Editable list of rows with Add / Remove buttons. */
function rowsField<T>(
  legend: string,
  items: readonly T[],
  make: (item: T | null) => { element: HTMLElement; read(): T | null },
  addLabel: string,
  onChange: () => void = () => undefined,
): { element: HTMLElement; read(): T[] } {
  const rows: { element: HTMLElement; read(): T | null }[] = [];
  const list = el('div', { class: 'mdt-rows' });
  const add = (item: T | null): void => {
    const row = make(item);
    const wrap = el('div', { class: 'mdt-rowfield' }, row.element);
    const entry = { element: wrap, read: (): T | null => row.read() };
    wrap.appendChild(
      button('Remove', () => {
        rows.splice(rows.indexOf(entry), 1);
        wrap.remove();
        onChange();
      }, 'small'),
    );
    rows.push(entry);
    list.appendChild(wrap);
  };
  for (const item of items) add(item);
  const element = el('fieldset', { class: 'mdt-rowsfield' }, el('legend', null, legend), list, button(addLabel, () => {
    add(null);
    onChange();
  }, 'small'));
  return {
    element,
    read: () => {
      const out: T[] = [];
      for (const r of rows) {
        const v = r.read();
        if (v !== null) out.push(v);
      }
      return out;
    },
  };
}

function personInput(seed: number, label: string, id: number): { element: HTMLElement; control: HTMLInputElement } {
  const f = numberField(label, id >= 0 ? id : null, { min: 0, max: PERSON_POPULATION - 1, step: 1 });
  const name = el('span', { class: 'mdt-name', 'aria-live': 'polite' }, personName(seed, id));
  f.control.addEventListener('input', () => setText(name, personName(seed, intOf(f.control, -1))));
  f.element.appendChild(name);
  return { element: f.element, control: f.control };
}

// --- Kinds --------------------------------------------------------------------------------------

function reportForm(init: DraftFields<'report'>, env: FormEnv, docs: { id: string; label: string }[]): DocFormView {
  const call = callSelect(env.cad, init.callId);
  const title = textField('Title', init.title ?? '', { maxlength: 120 });
  const location = textField('Location', init.location ?? '');
  const baseGame = init.occurredGame ?? 0;
  const occurred = textField('Occurred (HH:MM)', formatClockTime(baseGame), { inputmode: 'numeric', maxlength: 5 });
  const offenses = checkList('Offenses', STATUTE_OPTIONS, init.offenseIds ?? []);
  type PersonRef = { personId: number; role: PersonRole };
  const persons = rowsField<PersonRef>(
    'Persons',
    init.persons ?? [],
    (item) => {
      const p = personInput(env.seed, 'Person #', item?.personId ?? -1);
      const role = selectField('Role', ROLE_OPTIONS, item?.role ?? 'involved');
      return {
        element: el('div', { class: 'mdt-inline' }, p.element, role.element),
        read: () => {
          const id = intOf(p.control, -1);
          return id >= 0 ? { personId: id, role: role.control.value as PersonRole } : null;
        },
      };
    },
    'Add person',
  );
  type VehicleRef = { vehicleId: number; plate: string; role: string };
  const vehicles = rowsField<VehicleRef>(
    'Vehicles',
    init.vehicles ?? [],
    (item) => {
      const plate = textField('Plate', item?.plate ?? '', { maxlength: 10 });
      const vid = numberField('Vehicle #', item && item.vehicleId >= 0 ? item.vehicleId : null, { min: 0, step: 1 });
      const role = textField('Role', item?.role ?? 'involved', { maxlength: 30 });
      return {
        element: el('div', { class: 'mdt-inline' }, plate.element, vid.element, role.element),
        read: () => {
          const p = plate.control.value.trim().toUpperCase();
          const v = intOf(vid.control, -1);
          return p !== '' || v >= 0 ? { vehicleId: v, plate: p, role: role.control.value.trim() } : null;
        },
      };
    },
    'Add vehicle',
  );
  const narrative = areaField('Narrative', init.narrative ?? '', 8);
  const evidence = checkList('Evidence', docs.map((d) => ({ value: d.id, label: d.label })), init.evidenceIds ?? []);
  const element = el('div', { class: 'mdt-form-fields' },
    call.element, title.element, location.element, occurred.element, offenses.element, persons.element, vehicles.element,
    narrative.element, evidence.element);
  return {
    kind: 'report',
    element,
    read: () => ({
      callId: call.read(),
      title: title.control.value.trim(),
      location: location.control.value.trim(),
      occurredGame: parseClock(occurred.control.value, baseGame),
      offenseIds: offenses.values(),
      persons: persons.read(),
      vehicles: vehicles.read(),
      narrative: narrative.control.value,
      evidenceIds: evidence.values(),
    }),
    focus: () => title.control.focus(),
  };
}

function citationForm(init: DraftFields<'citation'>, env: FormEnv, opts: FormOptions): DocFormView {
  const callId = init.callId ?? null;
  const person = personInput(env.seed, 'Person #', init.personId ?? -1);
  if (opts.idUnverified) person.element.appendChild(el('span', { class: 'mdt-badge mdt-sev-caution' }, 'ID UNVERIFIED'));
  const plate = textField('Plate', init.plate ?? '', { maxlength: 10 });
  const vehicle = numberField('Vehicle #', init.vehicleId !== undefined && init.vehicleId >= 0 ? init.vehicleId : null, { min: 0, step: 1 });
  const location = textField('Location', init.location ?? '');
  const total = el('output', { class: 'mdt-total', 'aria-live': 'polite' });
  // Assigned right below; the listeners only run after that.
  let violations: { element: HTMLElement; read(): CitationViolation[] } | null = null;
  const updateTotal = (): void => {
    setText(total, `Total fine: $${citationTotal(violations?.read() ?? [])}`);
  };
  violations = rowsField<CitationViolation>(
    'Violations',
    init.violations ?? [],
    (item) => {
      const first = CITEABLE_OPTIONS[0]?.value ?? '';
      const statute = selectField('Statute', CITEABLE_OPTIONS, item?.statuteId ?? first);
      const fine = numberField('Fine $', item?.fine ?? findStatute(statute.control.value)?.fine ?? 0, { min: 0, step: 1 });
      const detail = textField('Detail', item?.detail ?? '', { maxlength: 120 });
      statute.control.addEventListener('change', () => {
        fine.control.value = String(findStatute(statute.control.value)?.fine ?? 0);
        updateTotal();
      });
      fine.control.addEventListener('input', updateTotal);
      return {
        element: el('div', { class: 'mdt-inline' }, statute.element, fine.element, detail.element),
        read: () => {
          const f = numOrNull(fine.control);
          return { statuteId: statute.control.value, fine: f !== null && f >= 0 ? f : 0, detail: detail.control.value.trim() };
        },
      };
    },
    'Add violation',
    updateTotal,
  );
  const rows = violations;
  const speed = numberField('Recorded speed (mph)', init.recordedSpeedMph ?? null, { min: 0, step: 1 });
  const limit = numberField('Limit (mph)', init.limitMph ?? null, { min: 0, step: 1 });
  const notes = areaField('Notes', init.notes ?? '', 3);
  updateTotal();
  const element = el('div', { class: 'mdt-form-fields' },
    person.element, plate.element, vehicle.element, location.element, rows.element, total,
    el('div', { class: 'mdt-inline' }, speed.element, limit.element), notes.element);
  return {
    kind: 'citation',
    element,
    read: () => ({
      callId,
      personId: intOf(person.control, -1),
      plate: plate.control.value.trim().toUpperCase(),
      vehicleId: intOf(vehicle.control, -1),
      location: location.control.value.trim(),
      violations: rows.read(),
      recordedSpeedMph: numOrNull(speed.control),
      limitMph: numOrNull(limit.control),
      notes: notes.control.value,
    }),
    focus: () => person.control.focus(),
  };
}

function bookingForm(init: DraftFields<'booking'>, env: FormEnv): DocFormView {
  const callId = init.callId ?? null;
  const arrestedGame = init.arrestedGame;
  const person = personInput(env.seed, 'Prisoner person #', init.personId ?? -1);
  const charges = checkList('Charges (bookable)', BOOKABLE_OPTIONS, init.charges ?? []);
  const location = textField('Arrest location', init.arrestLocation ?? '');
  const property = areaField('Property', init.property ?? '', 3);
  const notes = areaField('Notes', init.notes ?? '', 3);
  const element = el('div', { class: 'mdt-form-fields' }, person.element, charges.element, location.element, property.element, notes.element);
  return {
    kind: 'booking',
    element,
    read: () => ({
      callId,
      personId: intOf(person.control, -1),
      charges: charges.values(),
      ...(arrestedGame !== undefined ? { arrestedGame } : {}),
      arrestLocation: location.control.value.trim(),
      property: property.control.value,
      notes: notes.control.value,
    }),
    focus: () => person.control.focus(),
  };
}

function evidenceForm(init: DraftFields<'evidence'>, env: FormEnv): DocFormView {
  const call = callSelect(env.cad, init.callId);
  const description = textField('Description', init.description ?? '', { maxlength: 160 });
  const category = selectField('Category', CATEGORY_OPTIONS, init.category ?? 'other');
  const foundAt = textField('Found at', init.foundAt ?? '');
  const element = el('div', { class: 'mdt-form-fields' }, call.element, description.element, category.element, foundAt.element,
    el('p', { class: 'mdt-hint' }, "A 'collected' custody entry is added when the item is first saved."));
  return {
    kind: 'evidence',
    element,
    read: () => ({
      callId: call.read(),
      description: description.control.value.trim(),
      category: category.control.value as EvidenceCategory,
      foundAt: foundAt.control.value.trim(),
    }),
    focus: () => description.control.focus(),
  };
}

function supplementForm(init: DraftFields<'supplement'>, env: FormEnv, reports: { id: string; label: string }[]): DocFormView {
  const options: Option[] = [{ value: '', label: '(pick a final report)' }, ...reports.map((r) => ({ value: r.id, label: r.label }))];
  const parent = selectField('Report', options, init.parentId ?? '');
  const narrative = areaField('Supplemental narrative', init.narrative ?? '', 8);
  const element = el('div', { class: 'mdt-form-fields' }, parent.element, narrative.element);
  return {
    kind: 'supplement',
    element,
    read: () => {
      const report = env.cad.docs.get(parent.control.value);
      return { callId: report?.callId ?? init.callId ?? null, parentId: parent.control.value, narrative: narrative.control.value };
    },
    focus: () => parent.control.focus(),
  };
}

/** Builds the form of `kind` from an existing draft's fields or a prefill. */
export function buildDocForm(kind: DocKind, init: DraftFields<DocKind>, env: FormEnv, opts: FormOptions = {}): DocFormView {
  const docs = env.cad.docs;
  switch (kind) {
    case 'report':
      return reportForm(init, env,
        docs.list('evidence').map((d) => ({ id: d.id, label: `${d.id} ${d.kind === 'evidence' ? d.description : ''}` })));
    case 'citation':
      return citationForm(init, env, opts);
    case 'booking':
      return bookingForm(init, env);
    case 'evidence':
      return evidenceForm(init, env);
    case 'supplement':
      return supplementForm(init, env,
        docs.list('report').filter((d) => d.status === 'final').map((d) => ({ id: d.id, label: `${d.id} ${d.kind === 'report' ? d.title : ''}` })));
  }
}

/** Replaces the error list of a form with `messages` (empty hides it). */
export function showErrors(list: HTMLElement, messages: readonly string[]): void {
  clearChildren(list);
  list.hidden = messages.length === 0;
  for (const m of messages) list.appendChild(el('li', null, m));
}
