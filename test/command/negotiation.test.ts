import { describe, expect, it } from 'vitest';
import { COMMAND_CONFIG, NEGOTIATION_DATA } from '../../src/command/data';
import { findOption, negotiationOptions, negotiationTurn, newNegotiation, stageOf } from '../../src/command/negotiation';
import type { NegState, NegSubject, NegTone } from '../../src/command/types';
import { createRng, type Rng } from '../../src/core/rng';

const CALM: NegSubject = { temperament: 'calm', hostage: false, intoxicated: false, crisis: false };
const VOLATILE: NegSubject = { temperament: 'volatile', hostage: true, intoxicated: true, crisis: false };

/** A stream whose draws are all 0.5, i.e. zero noise. */
function withNext(next: () => number): Rng {
  return Object.create(createRng(1), { next: { value: next } }) as Rng;
}

function flat(): Rng {
  return withNext(() => 0.5);
}

function turn(s: NegState, id: string, tone: NegTone = 'neutral', subject: NegSubject = CALM, negotiator = false, rng: Rng = flat()): NegState {
  return negotiationTurn(s, id, tone, subject, negotiator, rng);
}

describe('newNegotiation', () => {
  it('starts at the configured trust and agitation in the contact stage', () => {
    const s = newNegotiation();
    expect(s.trust).toBe(COMMAND_CONFIG.negotiation.startTrust);
    expect(s.agitation).toBe(COMMAND_CONFIG.negotiation.startAgitation);
    expect(s).toMatchObject({ turns: 0, goodTurns: 0, stage: 'contact', outcome: 'ongoing', lastReply: '', history: [] });
  });
});

describe('negotiationOptions', () => {
  it('lists every category and flags options by stage and minimum trust', () => {
    const s = newNegotiation();
    const cats = negotiationOptions(s);
    expect(cats.map((c) => c.category)).toEqual(['listen', 'problem', 'pressure']);
    const flat = cats.flatMap((c) => c.options);
    const get = (id: string) => flat.find((o) => o.id === id);
    expect(get('minimal')?.enabled).toBe(true);
    expect(get('label')?.enabled).toBe(false);
    expect(get('label')?.hint).not.toBe('');
    expect(get('deadline')?.enabled).toBe(true);
    expect(get('plan')?.enabled).toBe(false);
  });

  it('opens options as trust rises through the stages', () => {
    const s = { ...newNegotiation(), trust: 0.5, stage: 'problem' as const };
    const flat = negotiationOptions(s).flatMap((c) => c.options);
    expect(flat.find((o) => o.id === 'offer')?.enabled).toBe(true);
    expect(flat.find((o) => o.id === 'plan')?.enabled).toBe(false);
    expect(flat.find((o) => o.id === 'openQuestion')?.enabled).toBe(false);
    const high = { ...newNegotiation(), trust: 0.7, stage: 'resolution' as const };
    expect(negotiationOptions(high).flatMap((c) => c.options).find((o) => o.id === 'plan')?.enabled).toBe(true);
  });
});

describe('stages', () => {
  it('is the highest stage whose trust threshold is reached', () => {
    expect(stageOf(0)).toBe('contact');
    expect(stageOf(0.24)).toBe('contact');
    expect(stageOf(0.25)).toBe('rapport');
    expect(stageOf(0.45)).toBe('problem');
    expect(stageOf(0.65)).toBe('resolution');
    expect(stageOf(1)).toBe('resolution');
  });

  it('progresses with trust over a run of listening turns', () => {
    const s = newNegotiation();
    const seen = new Set<string>([s.stage]);
    for (let i = 0; i < 6 && s.outcome === 'ongoing'; i++) {
      turn(s, i % 2 === 0 ? 'label' : 'paraphrase', 'polite');
      seen.add(s.stage);
    }
    expect(seen.has('rapport')).toBe(true);
  });
});

describe('negotiationTurn', () => {
  it('listening raises trust and lowers agitation', () => {
    const s = newNegotiation();
    turn(s, 'minimal');
    expect(s.trust).toBeCloseTo(0.15 + 0.04 - 0, 9);
    expect(s.agitation).toBeCloseTo(0.55 - 0.03 - 0.05, 9); // calm bias -0.1 * 0.5
    expect(s.turns).toBe(1);
  });

  it('pressure does the opposite', () => {
    const s = newNegotiation();
    turn(s, 'threat');
    expect(s.trust).toBeCloseTo(0.15 - 0.12, 9);
    expect(s.agitation).toBeCloseTo(0.55 + 0.2 - 0.05, 9);
  });

  it('applies the tone factor to trust only', () => {
    const polite = turn(newNegotiation(), 'minimal', 'polite');
    const neutral = turn(newNegotiation(), 'minimal', 'neutral');
    const aggressive = turn(newNegotiation(), 'minimal', 'aggressive');
    expect(polite.trust - 0.15).toBeCloseTo(0.04 * 1.1, 9);
    expect(neutral.trust - 0.15).toBeCloseTo(0.04, 9);
    expect(aggressive.trust - 0.15).toBeCloseTo(0.04 * 0.5, 9);
    expect(aggressive.agitation).toBeCloseTo(neutral.agitation, 9);
    expect(turn(newNegotiation(), 'minimal', 'commanding').trust - 0.15).toBeCloseTo(0.04 * 0.8, 9);
  });

  it('a negotiator on scene multiplies the trust change by 1.25', () => {
    const plain = turn(newNegotiation(), 'minimal');
    const helped = turn(newNegotiation(), 'minimal', 'neutral', CALM, true);
    expect(helped.trust - 0.15).toBeCloseTo((plain.trust - 0.15) * 1.25, 9);
    expect(helped.agitation).toBeCloseTo(plain.agitation, 9);
  });

  it('an option outside its stage counts half and adds 0.05 agitation', () => {
    const s = newNegotiation(); // contact: "plan" belongs to resolution and needs 0.6 trust
    turn(s, 'plan');
    expect(s.trust).toBeCloseTo(0.15 + 0.03, 9);
    expect(s.agitation).toBeCloseTo(0.55 + -0.05 * 0.5 + 0.05 - 0.05, 9);
  });

  it('the subject bias adds temperament, hostage, intoxication and crisis terms at half weight', () => {
    const s = newNegotiation();
    turn(s, 'minimal', 'neutral', VOLATILE);
    const bias = 0.15 + 0.05 + 0.08;
    expect(s.agitation).toBeCloseTo(0.55 - 0.03 + bias * 0.5, 9);
    const t = newNegotiation();
    turn(t, 'minimal', 'neutral', { temperament: 'calm', hostage: false, intoxicated: false, crisis: true });
    expect(t.agitation).toBeCloseTo(0.55 - 0.03 + (-0.1 - 0.05) * 0.5, 9);
  });

  it('draws two noise values (trust then agitation) and one reply pick', () => {
    const draws: number[] = [];
    const values = [0.9, 0.1, 0.0];
    const rng = withNext(() => { const v = values[draws.length] ?? 0.5; draws.push(v); return v; });
    const s = newNegotiation();
    negotiationTurn(s, 'minimal', 'neutral', CALM, false, rng);
    const sd = COMMAND_CONFIG.negotiation.noiseSd;
    expect(s.trust).toBeCloseTo(0.15 + 0.04 + (0.9 - 0.5) * 2 * sd, 9);
    expect(s.agitation).toBeCloseTo(0.55 - 0.03 - 0.05 + (0.1 - 0.5) * 2 * sd, 9);
    // pick() uses next() once more
    expect(draws).toHaveLength(3);
  });

  it('clamps trust and agitation to 0..1', () => {
    const s = newNegotiation();
    for (let i = 0; i < 4; i++) turn(s, 'threat', 'neutral', CALM, false, flat());
    expect(s.trust).toBeGreaterThanOrEqual(0);
    const t = { ...newNegotiation(), trust: 0.99, agitation: 0.01 };
    turn(t, 'minimal', 'polite', CALM, true);
    expect(t.trust).toBeLessThanOrEqual(1);
    expect(t.agitation).toBeGreaterThanOrEqual(0);
  });

  it('surrender follows two consecutive good turns', () => {
    const s = { ...newNegotiation(), trust: 0.76, agitation: 0.3, stage: 'resolution' as const };
    turn(s, 'plan');
    expect(s.goodTurns).toBe(1);
    expect(s.outcome).toBe('ongoing');
    turn(s, 'plan');
    expect(s.goodTurns).toBe(2);
    expect(s.outcome).toBe('surrender');
    expect(s.lastReply).toBe(NEGOTIATION_DATA.replies.surrender[0]);
  });

  it('a bad turn resets the good-turn streak', () => {
    const s = { ...newNegotiation(), trust: 0.76, agitation: 0.3, stage: 'resolution' as const };
    turn(s, 'plan');
    expect(s.goodTurns).toBe(1);
    turn(s, 'threat');
    expect(s.goodTurns).toBe(0);
    expect(s.outcome).toBe('ongoing');
  });

  it('agitation at 0.95 breaks the negotiation down', () => {
    const s = { ...newNegotiation(), agitation: 0.9 };
    turn(s, 'threat', 'neutral', CALM);
    expect(s.outcome).toBe('breakdown');
    expect(s.lastReply).toBe(NEGOTIATION_DATA.replies.breakdown[0]);
  });

  it('stalls at 25 turns', () => {
    const s = newNegotiation();
    // Alternate a gentle option with a mild one so trust and agitation stay in the middle.
    for (let i = 0; i < 24; i++) {
      turn(s, i % 2 === 0 ? 'minimal' : 'demand', 'aggressive');
      expect(s.outcome).toBe('ongoing');
    }
    turn(s, 'minimal', 'aggressive');
    expect(s.turns).toBe(25);
    expect(s.outcome).toBe('stalled');
    expect(['neutral', 'calm', 'agitated'].some((k) => (NEGOTIATION_DATA.replies as unknown as Record<string, string[]>)[k]?.includes(s.lastReply))).toBe(true);
  });

  it('a finished negotiation and an unknown option change nothing and draw nothing', () => {
    let draws = 0;
    const rng = withNext(() => { draws++; return 0.5; });
    const done = { ...newNegotiation(), outcome: 'breakdown' as const };
    const before = JSON.stringify(done);
    negotiationTurn(done, 'minimal', 'neutral', CALM, false, rng);
    const live = newNegotiation();
    const liveBefore = JSON.stringify(live);
    negotiationTurn(live, 'noSuchOption', 'neutral', CALM, false, rng);
    expect(JSON.stringify(done)).toBe(before);
    expect(JSON.stringify(live)).toBe(liveBefore);
    expect(draws).toBe(0);
    expect(findOption('noSuchOption')).toBeNull();
  });

  it('records the officer line and the answer in the history', () => {
    const s = newNegotiation();
    turn(s, 'minimal');
    expect(s.history).toEqual(["I'm here. Go on.", s.lastReply]);
    for (let i = 0; i < 40; i++) {
      if (s.outcome !== 'ongoing') break;
      turn(s, i % 2 ? 'minimal' : 'demand');
    }
    expect(s.history.length).toBeLessThanOrEqual(60);
  });

  it('is deterministic with a fixed stream and varies with the seed', () => {
    const run = (seed: number): NegState => {
      const rng = createRng(seed).stream('command');
      const s = newNegotiation();
      for (const id of ['minimal', 'label', 'paraphrase', 'openQuestion', 'pause', 'offer', 'deadline']) turn(s, id, 'polite', CALM, false, rng);
      return s;
    };
    expect(run(5)).toEqual(run(5));
    expect(run(5).trust).not.toBe(run(6).trust);
  });

  it('a patient listening run with a calm subject reaches a surrender', () => {
    const rng = createRng(3).stream('command');
    const s = newNegotiation();
    const script = ['minimal', 'openQuestion', 'label', 'paraphrase', 'label', 'iMessage', 'paraphrase', 'offer', 'offer', 'plan', 'plan', 'plan', 'plan', 'plan', 'plan'];
    for (const id of script) {
      if (s.outcome !== 'ongoing') break;
      turn(s, id, 'polite', CALM, true, rng);
    }
    expect(s.outcome).toBe('surrender');
  });
});
