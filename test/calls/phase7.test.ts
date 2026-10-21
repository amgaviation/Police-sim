import { describe, expect, it } from 'vitest';
import type { CallOutcome } from '../../src/scene/types';
import { actionDef, familyDef, objectivesFor, outcomeFor } from '../../src/calls';
import { engage, eventsOf, makeRig, run, runUntil, spawnWhere } from '../scene/helpers';
import { family, rawInput, validateRaw, type Json } from './helpers';

/** Phase 7 hooks (design §11.1): naloxone / tourniquet actions and the injury objectives. */

const flags = (...f: string[]): ReadonlySet<string> => new Set(f);

describe('Phase 7 calls data', () => {
  it('the shipped catalog still validates', () => {
    expect(() => validateRaw(rawInput())).not.toThrow();
  });

  it('adds the naloxone and tourniquet actions and relabels first aid', () => {
    expect(actionDef('naloxone')).toMatchObject({ label: 'Administer naloxone', requires: 'arrived', consumes: { naloxone: 1 }, once: true, sets: ['naloxone'] });
    expect(actionDef('tourniquet')).toMatchObject({ label: 'Apply a tourniquet', requires: 'arrived', consumes: { tourniquet: 1 }, once: true, sets: ['tourniquet'] });
    expect(actionDef('firstAid')).toMatchObject({ label: 'Treat with the med kit', consumes: { firstAid: 1 } });
  });

  it('a consumes id outside the trunk items is still rejected', () => {
    const raw = rawInput();
    (raw.actions.actions as Json[]).find((a) => a.id === 'naloxone')!.consumes = { sharpie: 1 };
    expect(() => validateRaw(raw)).toThrow(/is not a trunk item/);
  });

  it('medical offers naloxone right after first aid and shows its objective on the overdose branch only', () => {
    const med = familyDef('medical')!;
    expect(med.actions.slice(0, 2)).toEqual(['firstAid', 'naloxone']);
    const texts = (...f: string[]): string[] => objectivesFor(med, flags(...f)).map((o) => o.text);
    expect(texts('injury:patient', 'branch:overdose')).toContain('Administer naloxone');
    expect(texts('injury:patient', 'branch:collapse')).not.toContain('Administer naloxone');
    const shown = objectivesFor(med, flags('injury:patient', 'branch:overdose', 'naloxone'));
    expect(shown.find((o) => o.text === 'Administer naloxone')?.done).toBe(true);
    expect(texts('injury:patient', 'branch:overdose').indexOf('Administer naloxone')).toBe(texts('injury:patient', 'branch:overdose').indexOf('Render first aid') + 1);
  });

  it('overdoseUntreated sits before transported and needs a real overdose call', () => {
    const med = familyDef('medical')!;
    const ids = med.outcomes.map((o) => o.id);
    expect(ids.indexOf('overdoseUntreated')).toBe(ids.indexOf('transported') - 1);
    const base = ['branch:overdose', 'injury:patient', 'transported:patient'];
    expect(outcomeFor(med, flags(...base)).id).toBe('overdoseUntreated');
    expect(outcomeFor(med, flags(...base, 'naloxone'))).toMatchObject({ id: 'transported', grade: 'good' });
    expect(outcomeFor(med, flags(...base, 'variant:false')).id).toBe('unfounded');
    expect(outcomeFor(med, flags('branch:collapse', 'transported:patient')).id).toBe('transported');
    expect(outcomeFor(med, flags(...base))).toMatchObject({ disposition: 'handled', grade: 'bad' });
  });

  it.each([
    ['collision', 'injury:driverB'],
    ['domestic', 'injury:victim'],
    ['violent', 'injury:victim'],
    ['investigation', 'injury:victim'],
    ['welfare', 'injury:subject'],
  ])('%s offers first aid and a tourniquet before EMS and tracks the bleeding objective on %s', (id, injury) => {
    const fam = familyDef(id)!;
    const a = fam.actions;
    expect(a.indexOf('firstAid')).toBeGreaterThanOrEqual(0);
    expect(a.indexOf('tourniquet')).toBe(a.indexOf('firstAid') + 1);
    expect(a.indexOf('tourniquet')).toBeLessThan(a.indexOf('requestEms'));
    const raw = family(rawInput(), id);
    const obj = (raw.objectives as Json[]).find((o) => o.text === 'Control the bleeding')!;
    expect(obj.done).toEqual({ any: ['tourniquet', 'firstAid'] });
    expect(obj.show).toBe(injury);
    expect(objectivesFor(fam, flags()).map((o) => o.text)).not.toContain('Control the bleeding');
    expect(objectivesFor(fam, flags(injury)).find((o) => o.text === 'Control the bleeding')?.done).toBe(false);
    expect(objectivesFor(fam, flags(injury, 'tourniquet')).find((o) => o.text === 'Control the bleeding')?.done).toBe(true);
    expect(objectivesFor(fam, flags(injury, 'firstAid')).find((o) => o.text === 'Control the bleeding')?.done).toBe(true);
  });
});

describe('Phase 7 overdose scenario run', () => {
  const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
    !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

  async function overdose(missing: string[]): Promise<{ outcome: CallOutcome; used: string[]; flashes: string[] }> {
    const r = await makeRig({ missing });
    const id = spawnWhere(r, 'overdose', (rt) => rt.scenario.branch === 'overdose' && NOT_FALSE(rt));
    const rt = engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'naloxone' });
    run(r, 0.5);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    expect(runUntil(r, () => rt.flags.has('arrived:ems'), 300)).toBe(true);
    expect(rt.flags.has('transported:patient')).toBe(true);
    const flashes = eventsOf<{ text: string }>(r, 'scene:flash').map((e) => e.text);
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 1);
    const outcome = r.scene.outcomes().find((o) => o.callId === id) as CallOutcome;
    return { outcome, used: r.used.map((u) => u.item), flashes };
  }

  it('grades transported / good when the kit holds naloxone, and consumes one', async () => {
    const { outcome, used } = await overdose([]);
    expect(used).toContain('naloxone');
    expect(outcome.flags).toContain('naloxone');
    expect(outcome.outcomeId).toBe('transported');
    expect(outcome.grade).toBe('good');
    expect(outcome.suggested).toBe('transported');
  });

  it('grades overdoseUntreated / bad without naloxone, with a "Missing naloxone" flash', async () => {
    const { outcome, used, flashes } = await overdose(['naloxone']);
    expect(used).not.toContain('naloxone');
    expect(flashes).toContain('Missing naloxone');
    expect(outcome.flags).not.toContain('naloxone');
    expect(outcome.outcomeId).toBe('overdoseUntreated');
    expect(outcome.grade).toBe('bad');
    expect(outcome.suggested).toBe('handled');
  });
});
