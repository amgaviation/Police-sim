import { describe, expect, it } from 'vitest';
import { allowedOverMph, evaluatePursuit, pursuitAdvisory, type PursuitInput } from '../../src/legal/pursuit';
import { getRuleset } from '../../src/legal/ruleset';
import type { AdvisoryEvent, PursuitEndEvent, PursuitSampleEvent, PursuitStartEvent } from '../../src/legal/types';
import { both, dets, evaluate, LogBuilder, one } from './helpers';

const generic = getRuleset('generic');
const strict = getRuleset('strict');

/** A vehicle pursuit of a driver wanted for a stolen vehicle (felony vehicle offense). */
function chase(): LogBuilder {
  const b = new LogBuilder('C-00009', 'vehicleWanted').start().person(1, 'driver').indicator(1, 'stolenVehicle', 'lookup');
  b.at(1).pursuit(1);
  return b;
}

/** `n` samples one second apart starting at t = `from`. */
function samples(b: LogBuilder, from: number, n: number, speed: number, opts: Parameters<LogBuilder['sample']>[2] = {}): void {
  for (let i = 0; i < n; i++) b.at(from + i).sample(1, speed, opts);
}

describe('allowedOverMph', () => {
  it('uses the district value or the default', () => {
    expect(allowedOverMph(generic, 'downtown', false, false)).toBe(25);
    expect(allowedOverMph(generic, 'rural', false, false)).toBe(40);
    expect(allowedOverMph(strict, 'park', false, false)).toBe(10);
  });

  it('applies the wet and night factors', () => {
    expect(allowedOverMph(generic, 'suburbs', true, false)).toBeCloseTo(18.75);
    expect(allowedOverMph(generic, 'suburbs', false, true)).toBeCloseTo(22.5);
    expect(allowedOverMph(generic, 'suburbs', true, true)).toBeCloseTo(16.875);
    expect(allowedOverMph(generic, 'unknown', true, true)).toBeCloseTo(27);
  });
});

describe('pursuit initiation', () => {
  it('a known stolen vehicle justifies a pursuit in generic but not in strict', () => {
    const b = chase();
    samples(b, 2, 3, 50);
    b.at(10).pursuitEnd(1, 'lost');
    const { generic: g, strict: s } = both(b.build());
    expect(g.pursuits[0]).toMatchObject({ offense: 'felonyVehicle', startAllowed: true, outcome: 'lawful' });
    expect(one(g, 'pursuit')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-10.1'] });
    expect(s.pursuits[0]).toMatchObject({ startAllowed: false, outcome: 'unlawful', ruleIds: ['SS-10.1'] });
    expect(s.pursuits[0]?.reasons[0]).toBe('Pursuit initiated for Felony vehicle offense');
  });

  it('a pursuit for an unknown offense is not allowed', () => {
    const b = new LogBuilder().start().person(1, 'bystander').at(1).pursuit(1);
    b.at(5).pursuitEnd(1, 'lost');
    const a = evaluate(b.build());
    expect(a.pursuits[0]).toMatchObject({ offense: null, startAllowed: false });
    expect(a.pursuits[0]?.reasons[0]).toBe('Pursuit initiated for an unknown offense');
  });

  it('falls back to the call family offense for a suspect', () => {
    const b = new LogBuilder('C-1', 'violent').start().person(1, 'suspect').at(1).pursuit(1);
    b.at(5).pursuitEnd(1, 'lost');
    expect(evaluate(b.build(), 'strict').pursuits[0]).toMatchObject({ offense: 'violent', startAllowed: true });
  });

  it('foot pursuits get no ruling', () => {
    const b = chase();
    b.at(1).pursuit(1, 'foot');
    const a = evaluate(new LogBuilder().start().person(1, 'suspect').at(1).pursuit(1, 'foot').build());
    expect(a.pursuits).toHaveLength(0);
    expect(dets(a, 'pursuit')).toHaveLength(0);
  });
});

describe('pursuit speed, equipment and termination', () => {
  it('25 s over the limit violates the speed rule in generic (limit 20 s)', () => {
    const b = chase();
    samples(b, 2, 26, 75); // limit 35 + allowed 25 = 60 < 75; first sample 1 s + 25 x 1 s = 26 s
    b.at(40).pursuitEnd(1, 'lost');
    const a = evaluate(b.build());
    expect(a.pursuits[0]?.overLimitS).toBe(26);
    expect(a.pursuits[0]?.ruleIds).toEqual(['GS-10.3']);
    expect(one(a, 'pursuit').outcome).toBe('unlawful');
  });

  it('exactly 20 s over is still within policy', () => {
    const b = chase();
    samples(b, 2, 20, 75);
    b.at(40).pursuitEnd(1, 'lost');
    expect(evaluate(b.build()).pursuits[0]).toMatchObject({ overLimitS: 20, outcome: 'lawful' });
  });

  it('wet and night conditions shrink the allowance', () => {
    const b = chase();
    samples(b, 2, 22, 55); // 35 + 16.875 = 51.875 < 55 in wet+night; dry allowance 60
    b.at(40).pursuitEnd(1, 'lost');
    expect(evaluate(b.build()).pursuits[0]?.outcome).toBe('lawful');
    const wet = chase();
    samples(wet, 2, 22, 55, { wet: true, night: true });
    wet.at(40).pursuitEnd(1, 'lost');
    expect(evaluate(wet.build()).pursuits[0]).toMatchObject({ outcome: 'unlawful', overLimitS: 22 });
  });

  it('strict has smaller allowances and a shorter speed budget', () => {
    const b = chase();
    samples(b, 2, 11, 55); // allowed 15 -> 50 limit, over by 5: 11 s > 10 s
    b.at(40).pursuitEnd(1, 'lost');
    const a = evaluate(b.build(), 'strict');
    expect(a.pursuits[0]?.ruleIds).toContain('SS-10.3');
  });

  it('lights or siren off in a sample violates the equipment rule', () => {
    const b = chase();
    samples(b, 2, 2, 50);
    b.at(5).sample(1, 50, { siren: false });
    b.at(10).pursuitEnd(1, 'lost');
    const a = evaluate(b.build());
    expect(a.pursuits[0]).toMatchObject({ lightsSirenOk: false, ruleIds: ['GS-10.4'] });
  });

  it('ignoring a terminate advisory for longer than the grace violates the termination rule', () => {
    const b = chase();
    samples(b, 2, 3, 50);
    b.at(100).advisory('terminatePursuit');
    b.at(120).pursuitEnd(1, 'lost');
    const g = evaluate(b.build());
    expect(g.pursuits[0]).toMatchObject({ advisoryIgnoredS: 20, ruleIds: ['GS-10.2'] });
  });

  it('terminating within the grace is lawful', () => {
    const b = chase();
    b.at(100).advisory('terminatePursuit');
    b.at(105).pursuitEnd(1, 'terminated');
    const a = evaluate(b.build());
    expect(a.pursuits[0]).toMatchObject({ terminated: true, advisoryIgnoredS: 5, outcome: 'lawful' });
  });

  it('strict grace is 10 s', () => {
    const b = chase();
    b.at(100).advisory('terminatePursuit');
    b.at(112).pursuitEnd(1, 'terminated');
    const log = b.build();
    expect(evaluate(log, 'generic').pursuits[0]?.outcome).toBe('lawful');
    expect(evaluate(log, 'strict').pursuits[0]?.ruleIds).toContain('SS-10.2');
  });

  it('a pursuit running past the time limit without termination violates the termination rule', () => {
    const b = chase();
    b.at(700).pursuitEnd(1, 'lost');
    expect(evaluate(b.build()).pursuits[0]).toMatchObject({ durationS: 699, ruleIds: ['GS-10.2'] });
    const t = chase();
    t.at(700).pursuitEnd(1, 'terminated');
    expect(evaluate(t.build()).pursuits[0]?.outcome).toBe('lawful');
  });

  it('an unfinished pursuit is measured to the last event', () => {
    const b = chase();
    b.at(800).sample(1, 40);
    const a = evaluate(b.build());
    expect(a.pursuits[0]).toMatchObject({ durationS: 799, ruleIds: ['GS-10.2'] });
  });
});

describe('pursuitAdvisory (live check)', () => {
  function input(over: Partial<PursuitInput>): PursuitInput {
    const start: PursuitStartEvent = { id: 1, t: 0, game: 0, personId: 1, cam: 1, kind: 'pursuitStart', pursuit: 'vehicle', pursuitCallId: 1 };
    return { start, samples: [], end: null, advisory: null, offense: 'violent', nowT: 10, ...over };
  }
  function sample(t: number, speedMph: number, lights = true): PursuitSampleEvent {
    return { id: 2 + t, t, game: t, personId: 1, cam: 1, kind: 'pursuitSample', speedMph, limitMph: 35, district: 'suburbs', wet: false, night: false, lights, siren: true };
  }

  it('is null until the first problem', () => {
    expect(pursuitAdvisory(input({}), generic)).toBeNull();
    expect(pursuitAdvisory(input({ samples: [sample(1, 50), sample(2, 50)] }), generic)).toBeNull();
    expect(pursuitAdvisory(input({ offense: 'traffic' }), generic)).toBe('Pursuit initiated for Traffic offense');
    expect(pursuitAdvisory(input({ samples: [sample(1, 50), sample(2, 50, false)] }), generic)).toBe('Emergency lights and siren were not active throughout');
    const fast = Array.from({ length: 25 }, (_, i) => sample(i + 1, 90));
    expect(pursuitAdvisory(input({ samples: fast }), generic)).toContain('above the allowed margin');
    expect(pursuitAdvisory(input({ nowT: 700 }), generic)).toContain('past the 600 s limit');
  });

  it('does not report the advisory rule', () => {
    const advisory: AdvisoryEvent = { id: 9, t: 0, game: 0, personId: -1, cam: 1, kind: 'advisory', advisory: 'terminatePursuit', text: '' };
    const end: PursuitEndEvent = { id: 10, t: 100, game: 100, personId: 1, cam: 1, kind: 'pursuitEnd', reason: 'lost' };
    const p = input({ advisory, end });
    expect(pursuitAdvisory(p, generic)).toBeNull();
    expect(evaluatePursuit(p, generic).ruleIds).toEqual(['GS-10.2']);
  });
});
