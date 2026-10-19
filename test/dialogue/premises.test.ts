import { describe, expect, it } from 'vitest';
import {
  CONSENT_KINDS,
  REQUIREMENTS,
  UTTERANCES,
  available,
  consentChance,
  requirementMet,
  respond,
  utterance,
} from '../../src/dialogue';
import { createRng } from '../../src/core/rng';
import { ctxOf, item, memoryOf, subjectOf } from './helpers';

const PREMISES_KINDS = ['entry', 'searchPremises', 'searchRoom'] as const;
const IDS = { entry: 'consentEntry', searchPremises: 'consentSearchPremises', searchRoom: 'consentSearchRoom' } as const;
const authority = { buildingId: 12, authority: true, room: 3 };

describe('premises consents in the data', () => {
  it('adds the three kinds and the requirement', () => {
    expect([...CONSENT_KINDS]).toEqual(['searchPerson', 'searchVehicle', 'pbt', 'sfst', 'entry', 'searchPremises', 'searchRoom']);
    expect(REQUIREMENTS).toContain('premisesAuthority');
  });

  it('has an utterance per kind that needs premises authority and says something in every tone', () => {
    for (const kind of PREMISES_KINDS) {
      const u = utterance(IDS[kind]);
      expect(u.topic).toBe('consent');
      expect(u.intent).toBe('consent');
      expect(u.consent).toBe(kind);
      expect(u.requires).toEqual(['premisesAuthority']);
      for (const tone of ['polite', 'neutral', 'commanding', 'aggressive'] as const) expect(u.text[tone].length).toBeGreaterThan(5);
    }
    expect(utterance('consentEntry').text.polite).toBe('May I come in and talk with you?');
    expect(utterance('consentSearchPremises').text.polite).toBe('Would you consent to a search of the residence?');
    expect(utterance('consentSearchRoom').text.polite).toBe('Do you mind if I look around this room?');
  });

  it('witnessSaw asks the same account question as askAccount', () => {
    const w = utterance('witnessSaw');
    const a = utterance('askAccount');
    expect(w.topic).toBe('questions');
    expect(w.intent).toBe(a.intent);
    expect(w.fact).toBe(a.fact);
    expect(w.requires).toEqual(a.requires);
    expect(w.text.polite).toBe('Did you see or hear anything?');
    expect(UTTERANCES.filter((u) => u.fact === 'account').map((u) => u.id)).toContain('witnessSaw');
  });
});

describe('premisesAuthority gating', () => {
  const subject = subjectOf(10);
  it('is met only for a context with premises authority', () => {
    const m = memoryOf(subject, ctxOf());
    expect(requirementMet('premisesAuthority', subject, ctxOf(), m)).toBe(false);
    expect(requirementMet('premisesAuthority', subject, ctxOf({ premises: { buildingId: 1, authority: false, room: 0 } }), m)).toBe(false);
    expect(requirementMet('premisesAuthority', subject, ctxOf({ premises: authority }), m)).toBe(true);
  });

  it('disables the three consent utterances with the reason "Not the resident or owner" and enables them with authority', () => {
    const ctx = ctxOf();
    const m = memoryOf(subject, ctx);
    for (const ctxX of [ctx, ctxOf({ premises: { buildingId: 1, authority: false, room: 0 } })]) {
      const rows = available(subject, ctxX, m);
      for (const kind of PREMISES_KINDS) {
        const row = rows.find((r) => r.utterance.id === IDS[kind]);
        expect(row?.enabled).toBe(false);
        expect(row?.reason).toBe('Not the resident or owner');
      }
      // The Phase 3 consents are unaffected.
      expect(rows.find((r) => r.utterance.id === 'consentPbt')?.enabled).toBe(true);
    }
    const rows = available(subject, ctxOf({ premises: authority }), m);
    for (const kind of PREMISES_KINDS) expect(rows.find((r) => r.utterance.id === IDS[kind])?.enabled).toBe(true);
  });

  it('a granted premises consent cannot be asked again, a denied one needs rapport', () => {
    const ctx = ctxOf({ premises: authority });
    const m = memoryOf(subject, ctx);
    m.consent.entry = 'granted';
    expect(available(subject, ctx, m).find((r) => r.utterance.id === 'consentEntry')?.reason).toBe('Already consented');
    m.consent.searchRoom = 'denied';
    m.consentAskedAt.searchRoom = 0;
    expect(available(subject, ctx, m).find((r) => r.utterance.id === 'consentSearchRoom')?.reason).toBe('Declined; build rapport first');
  });
});

describe('consentChance for premises kinds', () => {
  const clean = subjectOf(11);
  const dirty = subjectOf(12, { items: [item('fakeId', 'pocket')] });
  const ctx = ctxOf({ premises: authority });

  it('entry is 0.7 + 0.3 rapport - 0.2 stress, the polite tone adds 0.1', () => {
    expect(consentChance('entry', clean, ctx, memoryOf(clean, ctx, 0, 0))).toBeCloseTo(0.7, 9);
    expect(consentChance('entry', clean, ctx, memoryOf(clean, ctx, 0.5, 0.2))).toBeCloseTo(0.7 + 0.15 - 0.04, 9);
    expect(consentChance('entry', clean, ctxOf({ tone: 'polite' }), memoryOf(clean, ctx, 0, 0))).toBeCloseTo(0.8, 9);
    expect(consentChance('entry', clean, ctx, memoryOf(clean, ctx, 1, 0))).toBe(1);
  });

  it('searchPremises is 0.2 lower and searchRoom equals entry', () => {
    const m = memoryOf(clean, ctx, 0.3, 0.1);
    const entry = consentChance('entry', clean, ctx, m);
    expect(consentChance('searchPremises', clean, ctx, m)).toBeCloseTo(entry - 0.2, 9);
    expect(consentChance('searchRoom', clean, ctx, m)).toBeCloseTo(entry, 9);
  });

  it('drops 0.3 with incriminating items and 0.4 for the scenario suspect', () => {
    const m = memoryOf(clean, ctx, 0, 0);
    expect(consentChance('entry', dirty, ctx, m)).toBeCloseTo(0.4, 9);
    const suspectCtx = ctxOf({ premises: authority, truth: { ...ctx.truth, suspect: true } });
    expect(consentChance('entry', clean, suspectCtx, m)).toBeCloseTo(0.3, 9);
    expect(consentChance('entry', dirty, suspectCtx, m)).toBeCloseTo(0, 9);
    expect(consentChance('searchPremises', dirty, suspectCtx, m)).toBe(0);
  });

  it('the Phase 3 kinds keep their chance', () => {
    const m = memoryOf(clean, ctx, 0, 0);
    expect(consentChance('searchPerson', clean, ctx, m)).toBeCloseTo(0.6, 9);
    expect(consentChance('pbt', clean, ctx, m)).toBeCloseTo(0.6, 9);
  });

  it('respond grants about as often as the chance says and reports the kind', () => {
    const u = utterance('consentEntry');
    const m = memoryOf(clean, ctx, 0, 0);
    const rng = createRng(99).stream('consent');
    let granted = 0;
    const n = 600;
    for (let i = 0; i < n; i++) {
      const res = respond(u, clean, ctx, m, rng);
      expect(res.consent?.kind).toBe('entry');
      expect(res.consent?.valid).toBe(true);
      if (res.consent?.granted) granted++;
    }
    // Tone effects of a neutral request shift rapport and stress a little; the rate stays near 0.7.
    expect(granted / n).toBeGreaterThan(0.55);
    expect(granted / n).toBeLessThan(0.85);
  });

  it('a juvenile without a guardian cannot give a premises consent', () => {
    const kid = subjectOf(13, {}, { juvenile: true });
    const res = respond(utterance('consentSearchRoom'), kid, ctx, memoryOf(kid, ctx), createRng(5).stream('c'));
    expect(res.consent).toEqual({ kind: 'searchRoom', granted: false, valid: false });
    expect(res.lineKey).toBe('consent.needGuardian');
  });
});
