import { describe, expect, it } from 'vitest';
import { CALL_CATALOG } from '../../src/calls/catalog';
import { buildScenario, topPhrase } from '../../src/calls/scenario';
import { describePerson } from '../../src/people';
import { makeRig } from '../people/helpers';
import { rngFor, stubInput } from './stub';

describe('descriptions use the real identity wording', () => {
  const rig = makeRig(42, 12 * 3600);

  it('topPhrase picks the article', () => {
    expect(topPhrase('orange')).toBe('an orange top');
    expect(topPhrase('black')).toBe('a black top');
  });

  it('the wrong colour never equals the true one and both read the same way', () => {
    let checked = 0;
    for (const t of CALL_CATALOG.types) {
      const family = CALL_CATALOG.families.find((f) => f.id === t.family);
      if (!family || family.derived || family.describe === null) continue;
      for (let callId = 1; callId <= 40; callId++) {
        const input = { ...stubInput({ typeId: t.id, callId }), describe: (id: number) => describePerson(rig.pop.identity(id % 100000)) };
        const s = buildScenario(input, rngFor(input.seed, callId));
        if (!s.errors.wrongDescription) continue;
        const said = s.timeline.find((e) => e.kind === 'describe')?.text ?? '';
        const fixed = s.timeline.find((e) => e.text.startsWith('Correction: subject is wearing'))?.text ?? '';
        if (said === '') continue;
        const a = /wearing (an? \w+ top)/.exec(said)?.[1];
        const b = /wearing (an? \w+ top)/.exec(fixed)?.[1];
        expect(a, said).toBeDefined();
        expect(b, fixed).toBeDefined();
        expect(a).not.toBe(b);
        expect(said).not.toMatch(/shirt top|\ba [aeiou]\w+ top/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});
