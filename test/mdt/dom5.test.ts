import { afterEach, describe, expect, it } from 'vitest';
import { CadState } from '../../src/cad/cadState';
import {
  communityModel,
  careerModel,
  renderCareer,
  renderCommunity,
  statementsField,
  type ChoiceInfo,
} from '../../src/ui/mdt';
import { buildDocForm } from '../../src/ui/mdt/forms';
import { FakeNode, installFakeDocument } from '../courtui/fakeDom';
import { at } from './helpers';
import { CHOICES, careerView, courtCase, iaCase } from './phase5';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const root = (): FakeNode => new FakeNode('DIV');

describe('renderCareer (fake DOM)', () => {
  it('renders a heading and a label / text list per section, with ATTEND and REVIEW buttons wired to the handlers', () => {
    restore = installFakeDocument();
    const model = careerModel(
      careerView({ ia: [iaCase()] }),
      [courtCase({ hearingGame: at(0).game + 1800 })],
      at(0),
      { canAttend: () => true, jurisdiction: { id: 'generic', name: 'Generic State Code' } },
    );
    const c = root();
    const attended: string[] = [];
    const reviewed: string[] = [];
    renderCareer(c as unknown as HTMLElement, model, { attend: (id) => attended.push(id), review: (id) => reviewed.push(id) });
    const sections = c.tag('section');
    expect(sections).toHaveLength(model.sections.length);
    expect(sections[0]?.tag('h3')[0]?.textContent).toBe('Duty');
    expect(c.textContent).toContain('Generic State Code (generic)');
    const buttons = c.tag('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['ATTEND', 'REVIEW']);
    expect(buttons.map((b) => b.attrs['aria-label'])).toEqual(['ATTEND CR-0001', 'REVIEW IA-0001']);
    buttons[0]?.fire('click');
    buttons[1]?.fire('click');
    expect(attended).toEqual(['CR-0001']);
    expect(reviewed).toEqual(['IA-0001']);
  });

  it('shows the empty text of a section without lines, and replaces the previous content on a re-render', () => {
    restore = installFakeDocument();
    const c = root();
    const model = careerModel(careerView(), [], at(0));
    renderCareer(c as unknown as HTMLElement, model, { attend: () => undefined, review: () => undefined });
    expect(c.textContent).toContain('No hearings scheduled');
    expect(c.tag('button')).toHaveLength(0);
    const first = c.tag('section').length;
    renderCareer(c as unknown as HTMLElement, model, { attend: () => undefined, review: () => undefined });
    expect(c.tag('section')).toHaveLength(first);
  });
});

describe('renderCommunity (fake DOM)', () => {
  it('renders a bar per district with the fill, the baseline marker, the percentage and the trend arrow', () => {
    restore = installFakeDocument();
    const c = root();
    renderCommunity(
      c as unknown as HTMLElement,
      communityModel([
        { district: 'suburbs', value: 0.62, baseline: 0.6, trend: 0.02 },
        { district: 'downtown', value: 0.25, baseline: 0.45, trend: -0.03 },
      ]),
    );
    const rows = c.all('mdt-trust-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.all('mdt-trust-label')[0]?.textContent).toBe('Suburbs');
    const fill = rows[0]?.all('mdt-bar-fill')[0];
    expect(fill?.style['width']).toBe('62%');
    expect(fill?.className).toContain('mdt-band-high');
    expect(rows[0]?.all('mdt-bar-base')[0]?.style['left']).toBe('60%');
    expect(rows[0]?.all('mdt-trust-pct')[0]?.textContent).toBe('62 %');
    expect(rows[0]?.all('mdt-trust-trend')[0]?.textContent).toBe('▲');
    expect(rows[0]?.all('mdt-up')).toHaveLength(1);
    expect(rows[1]?.all('mdt-bar-fill')[0]?.className).toContain('mdt-band-low');
    expect(rows[1]?.all('mdt-down')).toHaveLength(1);
    expect(rows[1]?.all('mdt-bar')[0]?.attrs['aria-valuenow']).toBe('25');
  });

  it('says so when there are no districts', () => {
    restore = installFakeDocument();
    const c = root();
    renderCommunity(c as unknown as HTMLElement, []);
    expect(c.textContent).toBe('No community data');
  });
});

describe('statementsField (fake DOM)', () => {
  const source = (callId: number | null): readonly ChoiceInfo[] => (callId === 7 ? CHOICES : callId === 8 ? CHOICES.slice(0, 1) : []);

  it('renders a checkbox per independent statement and a radio set with a none entry per group', () => {
    restore = installFakeDocument();
    const f = statementsField(source, 7, []);
    const el = f.element as unknown as FakeNode;
    expect(el.hidden).toBe(false);
    const boxes = el.find((n) => n.tagName === 'INPUT' && n.type === 'checkbox');
    const radios = el.find((n) => n.tagName === 'INPUT' && n.type === 'radio');
    expect(boxes.map((b) => b.value)).toEqual(['detention:1', 'miranda:1']);
    expect(radios.map((r) => r.value)).toEqual(['', 'consent:searchVehicle:1', 'consent:searchVehicle:1:no']);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[0]?.checked).toBe(true);
    expect(el.tag('fieldset')).toHaveLength(1); // the radio set inside the statements fieldset
    expect(el.textContent).toContain('The driver consented to a search of the vehicle.');
    expect(f.assertions()).toEqual([]);
  });

  it('reads checked boxes and the chosen radio only, never the none entry', () => {
    restore = installFakeDocument();
    const f = statementsField(source, 7, []);
    const el = f.element as unknown as FakeNode;
    const inputs = el.find((n) => n.tagName === 'INPUT');
    const byValue = (v: string): FakeNode => inputs.find((i) => i.value === v) as FakeNode;
    byValue('miranda:1').checked = true;
    byValue('consent:searchVehicle:1:no').checked = true;
    // Display order: the radio set stands before the Miranda checkbox.
    expect(f.assertions()).toEqual(['consent:searchVehicle:1:no', 'miranda:1']);
    byValue('consent:searchVehicle:1:no').checked = false;
    byValue('').checked = true;
    expect(f.assertions()).toEqual(['miranda:1']);
  });

  it('starts with the given ticks', () => {
    restore = installFakeDocument();
    const f = statementsField(source, 7, ['detention:1', 'consent:searchVehicle:1']);
    expect(f.assertions()).toEqual(['detention:1', 'consent:searchVehicle:1']);
    const none = (f.element as unknown as FakeNode).find((n) => n.type === 'radio' && n.value === '')[0];
    expect(none?.checked).toBe(false);
  });

  it('is hidden without statements and rebuilds for another call, keeping the ticks that still apply', () => {
    restore = installFakeDocument();
    const f = statementsField(source, null, []);
    expect((f.element as unknown as FakeNode).hidden).toBe(true);
    f.setCall(7);
    expect((f.element as unknown as FakeNode).hidden).toBe(false);
    const box = (f.element as unknown as FakeNode).find((n) => n.value === 'detention:1')[0] as FakeNode;
    box.checked = true;
    const miranda = (f.element as unknown as FakeNode).find((n) => n.value === 'miranda:1')[0] as FakeNode;
    miranda.checked = true;
    f.setCall(8); // only detention:1 exists for call 8
    expect(f.assertions()).toEqual(['detention:1']);
    f.setCall(9);
    expect((f.element as unknown as FakeNode).hidden).toBe(true);
    expect(f.assertions()).toEqual([]);
  });
});

describe('report form with statements (fake DOM)', () => {
  const env = (): { cad: CadState; seed: number } => ({ cad: new CadState(), seed: 42 });
  const init = { callId: 7, title: 'Stop', location: 'Oak', occurredGame: at(0).game, narrative: '', offenseIds: [], persons: [], vehicles: [], evidenceIds: [] };

  it('adds the checklist only when the choices feed is given, and reads its ticks through assertions()', () => {
    restore = installFakeDocument();
    const plain = buildDocForm('report', init, env());
    expect('assertions' in plain).toBe(false);
    const withChoices = buildDocForm('report', init, env(), { choices: (id) => (id === 7 ? CHOICES : []), assertions: ['miranda:1'] });
    expect((withChoices.element as unknown as FakeNode).textContent).toContain('Statements of fact');
    expect(withChoices.assertions?.()).toEqual(['miranda:1']);
    // Other kinds never get one.
    expect('assertions' in buildDocForm('evidence', { callId: null, description: 'x', category: 'other', foundAt: '' }, env(), { choices: () => CHOICES })).toBe(false);
  });

  it('rebuilds the checklist when the call select changes', () => {
    restore = installFakeDocument();
    const view = buildDocForm('report', init, env(), { choices: (id) => (id === 7 ? CHOICES : id === 8 ? CHOICES.slice(0, 1) : []) });
    const el = view.element as unknown as FakeNode;
    const select = el.tag('select')[0] as FakeNode;
    expect(el.find((n) => n.value === 'miranda:1')).toHaveLength(1);
    select.value = '8';
    select.fire('change');
    expect(el.find((n) => n.value === 'miranda:1')).toHaveLength(0);
    expect(el.find((n) => n.value === 'detention:1')).toHaveLength(1);
    select.value = '';
    select.fire('change');
    expect(el.find((n) => n.value === 'detention:1')).toHaveLength(0);
    expect(el.all('mdt-statements')[0]?.hidden).toBe(true);
    expect(view.assertions?.()).toEqual([]);
  });
});
