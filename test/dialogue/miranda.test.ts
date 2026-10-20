import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import mirandaJson from '../../src/data/dialogue/miranda.json';
import {
  INCRIMINATING_FACTS,
  LINE_KEYS,
  MIRANDA,
  MIRANDA_RESULTS,
  RESPONSES,
  TOPICS,
  UTTERANCES,
  parseMiranda,
  respond,
  utterance,
  waiveChance,
  type DialogueContext,
  type SubjectMemory,
  type SubjectProfile,
} from '../../src/dialogue';
import { isMemory } from '../../src/contact/save';
import { ctxOf, identityOf, memoryOf, subjectOf } from './helpers';

const ID = 11;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A subject with `priors` prior contacts on record. */
function withPriors(priors: number, over: Partial<SubjectProfile> = {}, language: 'fluent' | 'none' = 'fluent'): SubjectProfile {
  const base = identityOf(ID);
  const rec = { ...base.record, priors: Array.from({ length: priors }, () => ({}) as never) };
  const s = subjectOf(ID, over);
  return {
    ...s,
    identity: { ...s.identity, record: rec, language: { id: language === 'fluent' ? 'english' : 'xx', label: language === 'fluent' ? 'English' : 'Xish', english: language } },
  };
}

function say(uid: string, s: SubjectProfile, ctx: DialogueContext, m: SubjectMemory, seed: number) {
  return respond(utterance(uid), s, ctx, m, createRng(seed));
}

/** Waiver share over `n` seeded recitals. */
function rate(s: SubjectProfile, ctx: DialogueContext, stress: number, n = 600): number {
  let waived = 0;
  for (let seed = 1; seed <= n; seed++) {
    const r = say('miranda', s, ctx, memoryOf(s, ctx, 0, stress), seed);
    expect(['waived', 'invoked']).toContain(r.miranda);
    if (r.miranda === 'waived') waived++;
  }
  return waived / n;
}

describe('miranda data', () => {
  it('parses the shipped file and rejects bad values with the path', () => {
    expect(MIRANDA).toEqual({ waiveBase: 0.6, priorPenalty: 0.08, intoxBonus: 0.15, stressPenalty: 0.2, hostilePenalty: 0.25 });
    expect(() => parseMiranda(null)).toThrow(/miranda\.json/);
    const bad = clone(mirandaJson) as Record<string, unknown>;
    bad.waiveBase = 2;
    expect(() => parseMiranda(bad)).toThrow(/miranda\.json: waiveBase/);
    const missing = clone(mirandaJson) as Record<string, unknown>;
    delete missing.hostilePenalty;
    expect(() => parseMiranda(missing)).toThrow(/miranda\.json: hostilePenalty/);
    expect(() => parseMiranda({ ...clone(mirandaJson), version: 2 })).toThrow(/miranda\.json/);
  });

  it('has the four response lines with variants, the Rights topic and the exports', () => {
    for (const key of ['miranda.waive', 'miranda.invoke', 'miranda.confused', 'miranda.silent']) {
      expect(LINE_KEYS).toContain(key);
      expect(RESPONSES.lines.get(key)?.length).toBeGreaterThanOrEqual(3);
    }
    expect(RESPONSES.lines.get('miranda.waive')).toContain("Yeah, I understand. I'll talk.");
    expect(RESPONSES.lines.get('miranda.invoke')).toContain("I want a lawyer. I'm not saying anything.");
    expect(RESPONSES.lines.get('miranda.confused')).toContain("I don't understand.");
    expect(RESPONSES.lines.get('miranda.silent')).toContain('I already said I want a lawyer.');
    expect(TOPICS.find((t) => t.id === 'miranda')?.label).toBe('Rights');
    expect([...MIRANDA_RESULTS]).toEqual(['waived', 'invoked', 'misunderstood']);
    expect([...INCRIMINATING_FACTS]).toEqual([
      'account', 'drinking', 'drugs', 'weapons', 'vehicleContents', 'suspectWhereabouts', 'origin', 'destination', 'vehicleOwner',
    ]);
  });
});

describe('waiver chance', () => {
  it('follows the formula and clamps to 0.05..0.95', () => {
    const ctx = ctxOf();
    const calm = withPriors(0, { demeanor: 'nervous' });
    expect(waiveChance(calm, memoryOf(calm, ctx, 0, 0))).toBeCloseTo(0.6, 10);
    expect(waiveChance(calm, memoryOf(calm, ctx, 0, 0.5))).toBeCloseTo(0.5, 10);
    const priors = withPriors(3, { demeanor: 'nervous' });
    expect(waiveChance(priors, memoryOf(priors, ctx, 0, 0))).toBeCloseTo(0.36, 10);
    const drunk = withPriors(0, { demeanor: 'nervous', intoxication: { bac: 0.15, drug: 'none', level: 1 } });
    expect(waiveChance(drunk, memoryOf(drunk, ctx, 0, 0))).toBeCloseTo(0.75, 10);
    const hostile = withPriors(0, { demeanor: 'hostile' });
    expect(waiveChance(hostile, memoryOf(hostile, ctx, 0, 0))).toBeCloseTo(0.35, 10);
    const lots = withPriors(20, { demeanor: 'hostile' });
    expect(waiveChance(lots, memoryOf(lots, ctx, 0, 1))).toBe(0.05);
    const easy = withPriors(0, { demeanor: 'nervous', intoxication: { bac: 0.3, drug: 'none', level: 3 } });
    expect(waiveChance(easy, memoryOf(easy, ctx, 0, 0))).toBe(0.95);
  });

  it('shows in seeded waiver rates by profile', () => {
    const ctx = ctxOf();
    const calm = rate(withPriors(0), ctx, 0);
    const repeat = rate(withPriors(4, { demeanor: 'hostile' }), ctx, 0.6);
    const drunk = rate(withPriors(0, { intoxication: { bac: 0.2, drug: 'none', level: 1 } }), ctx, 0);
    expect(calm).toBeGreaterThan(0.5);
    expect(calm).toBeLessThan(0.7);
    expect(repeat).toBeLessThan(0.15);
    expect(drunk).toBeGreaterThan(calm);
    expect(rate(withPriors(0), ctx, 0.9)).toBeLessThan(calm);
  });
});

describe('miranda answers', () => {
  it('waive and invoke set the memory, the result and the line; exactly one draw decides', () => {
    const ctx = ctxOf();
    const s = withPriors(0);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const m = memoryOf(s, ctx, 0, 0.2);
      const r = say('miranda', s, ctx, m, seed);
      expect(r.understood).toBe(true);
      expect(r.statement).toBeNull();
      expect(r.memory.mirandized).toBe(true);
      expect(r.memory.miranda).toBe(r.miranda);
      expect(m.miranda).toBeUndefined();
      expect(m.mirandized).toBe(false);
      expect(r.lineKey).toBe(r.miranda === 'waived' ? 'miranda.waive' : 'miranda.invoke');
      expect(RESPONSES.lines.get(r.lineKey)).toContain(r.text);
      seen.add(r.miranda ?? '');
      // The draw is the first one: the same stream decides waived / invoked.
      const u = createRng(seed).next();
      expect(r.miranda).toBe(u < waiveChance(s, r.memory) ? 'waived' : 'invoked');
    }
    expect(seen).toEqual(new Set(['waived', 'invoked']));
  });

  it('is misunderstood when the subject cannot follow, with the confused line', () => {
    const ctx = ctxOf();
    const foreign = withPriors(0, {}, 'none');
    let confused = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = say('miranda', foreign, ctx, memoryOf(foreign, ctx), seed);
      if (r.miranda === 'misunderstood') {
        confused++;
        expect(r.lineKey).toBe('miranda.confused');
        expect(r.understood).toBe(false);
        expect(r.memory.miranda).toBe('misunderstood');
        expect(r.memory.mirandized).toBe(true);
      } else expect(['waived', 'invoked']).toContain(r.miranda);
    }
    // 'none' English: understood about 0.6 of the time for a simple intent... but miranda is not simple: mostly confused.
    expect(confused).toBeGreaterThan(40);
    // With an interpreter every recital is understood.
    const withInterp = ctxOf({ commMode: 'interpreter', interpreterAvailable: true });
    for (let seed = 1; seed <= 40; seed++) expect(say('miranda', foreign, withInterp, memoryOf(foreign, withInterp), seed).miranda).not.toBe('misunderstood');
    // Deaf without notes: misunderstood; with written notes understood.
    const deaf = subjectOf(ID, {}, { hearing: 'deaf' });
    const spoken = say('miranda', deaf, ctx, memoryOf(deaf, ctx), 3);
    expect(spoken.miranda).toBe('misunderstood');
    expect(spoken.lineKey).toBe('miranda.confused');
    const written = ctxOf({ commMode: 'written' });
    expect(say('miranda', deaf, written, memoryOf(deaf, written), 3).miranda).not.toBe('misunderstood');
  });

  it('a garbled app translation is a misunderstood recital', () => {
    const ctx = ctxOf({ commMode: 'translationApp' });
    const s = withPriors(0, {}, 'none');
    let garbled = 0;
    for (let seed = 1; seed <= 200; seed++) if (say('miranda', s, ctx, memoryOf(s, ctx), seed).miranda === 'misunderstood') garbled++;
    expect(garbled).toBeGreaterThan(5);
    expect(garbled).toBeLessThan(60);
  });

  it('unresponsive subjects give no miranda result', () => {
    const s = subjectOf(ID, { demeanor: 'unresponsive' });
    const r = say('miranda', s, ctxOf(), memoryOf(s, ctxOf()), 1);
    expect(r.miranda).toBeUndefined();
    expect(r.lineKey).toBe('silent.none');
  });

  it('results of other intents carry no miranda field', () => {
    const s = withPriors(0);
    const r = say('greet', s, ctxOf(), memoryOf(s, ctxOf()), 1);
    expect('miranda' in r).toBe(false);
  });
});

describe('after invoking', () => {
  const ctx = ctxOf();
  const invoked = (s: SubjectProfile): SubjectMemory => {
    const m = memoryOf(s, ctx, 0, 0.2);
    m.mirandized = true;
    m.miranda = 'invoked';
    return m;
  };

  it('re-reading the rights never lifts the invocation, whatever the draw', () => {
    const s = withPriors(0, { guilty: true });
    for (let seed = 1; seed <= 24; seed++) {
      const m = invoked(s);
      const r = say('miranda', s, ctx, m, seed);
      expect(r.miranda, String(seed)).toBe('invoked');
      expect(r.lineKey).toBe('miranda.silent');
      expect(m.miranda).toBe('invoked');
    }
  });

  it('re-reading the rights does not flip a waiver either', () => {
    const s = withPriors(0, { guilty: true });
    for (let seed = 1; seed <= 24; seed++) {
      const m = memoryOf(s, ctx, 0, 0.2);
      m.mirandized = true;
      m.miranda = 'waived';
      const r = say('miranda', s, ctx, m, seed);
      expect(r.miranda, String(seed)).toBe('waived');
      expect(m.miranda).toBe('waived');
    }
  });

  it('silences every incriminating ask without a statement', () => {
    const s = withPriors(0, { guilty: true, vehicleOwnerId: 3 });
    const asks = UTTERANCES.filter((u) => u.intent === 'ask' && u.fact !== null && (INCRIMINATING_FACTS as readonly string[]).includes(u.fact));
    expect(asks.length).toBeGreaterThanOrEqual(9);
    for (const u of asks) {
      const r = respond(u, s, ctx, invoked(s), createRng(5));
      expect(r.lineKey, u.id).toBe('miranda.silent');
      expect(r.statement, u.id).toBeNull();
      expect(r.memory.asked).toEqual({});
      expect(r.memory.miranda).toBe('invoked');
      expect(RESPONSES.lines.get('miranda.silent')).toContain(r.text);
    }
  });

  it('draws only the wording: the stream advances exactly once', () => {
    const s = withPriors(0, { guilty: true });
    const rng = createRng(9);
    const probe = createRng(9);
    respond(utterance('askDrugs'), s, ctx, invoked(s), rng);
    probe.next();
    expect(rng.next()).toBe(probe.next());
  });

  it('still answers name, date of birth, id and non-incriminating asks', () => {
    const s = withPriors(0);
    for (const uid of ['askName', 'askDob', 'askAddress', 'askInjured']) {
      let answered = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = say(uid, s, ctx, invoked(s), seed);
        expect(r.lineKey).not.toBe('miranda.silent');
        if (r.statement) answered++;
      }
      expect(answered, uid).toBeGreaterThan(5);
    }
  });

  it('a waiver or a misunderstanding does not silence anything', () => {
    const s = withPriors(0);
    for (const kind of ['waived', 'misunderstood'] as const) {
      const m = memoryOf(s, ctx, 0, 0.2);
      m.miranda = kind;
      let answered = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = respond(utterance('askDestination'), s, ctx, m, createRng(seed));
        expect(r.lineKey).not.toBe('miranda.silent');
        if (r.statement) answered++;
      }
      expect(answered).toBeGreaterThan(10);
    }
  });
});

describe('memory field', () => {
  it('round-trips through JSON and the contact validator; old memories without it are valid', () => {
    const s = withPriors(0);
    const ctx = ctxOf();
    const r = say('miranda', s, ctx, memoryOf(s, ctx), 4);
    const copy = clone(r.memory);
    expect(copy.miranda).toBe(r.miranda);
    expect(isMemory(copy)).toBe(true);
    const old = clone(memoryOf(s, ctx));
    expect('miranda' in old).toBe(false);
    expect(isMemory(old)).toBe(true);
    expect(isMemory({ ...old, miranda: 'maybe' })).toBe(false);
    // Copying through respond keeps the field.
    const next = say('greet', s, ctx, r.memory, 4);
    expect(next.memory.miranda).toBe(r.miranda);
  });
});
