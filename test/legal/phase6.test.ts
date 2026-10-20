import { describe, expect, it } from 'vitest';
import { getRuleset } from '../../src/legal/ruleset';
import { evaluatePursuit, type PursuitInput } from '../../src/legal/pursuit';
import { evaluate, LogBuilder } from './helpers';

/** A pursuit of a stolen vehicle that runs 700 s (generic limit 600 s, strict 300 s) and ends with `reason`. */
function longChase(reason: string): LogBuilder {
  const b = new LogBuilder('C-00009', 'vehicleWanted').start().person(1, 'driver').indicator(1, 'stolenVehicle', 'lookup');
  b.at(1).pursuit(1);
  b.at(701).pursuitEnd(1, reason);
  return b;
}

describe('pursuit handoff (Phase 6)', () => {
  it('a handoff end counts as terminated: the duration rule does not apply', () => {
    const a = evaluate(longChase('handoff').build());
    expect(a.pursuits[0]).toMatchObject({ terminated: true, durationS: 700, outcome: 'lawful', ruleIds: [] });
  });

  it('an end that is neither terminated nor handed off is still penalised for the duration', () => {
    const a = evaluate(longChase('lost').build());
    expect(a.pursuits[0]).toMatchObject({ terminated: false, outcome: 'unlawful', ruleIds: ['GS-10.2'] });
    expect(a.pursuits[0]?.reasons[0]).toMatch(/Pursuit ran 700 s past the 600 s limit without being terminated/);
    expect(evaluate(longChase('terminated').build()).pursuits[0]).toMatchObject({ terminated: true, outcome: 'lawful' });
  });

  it('works the same in the strict ruleset', () => {
    const log = longChase('handoff').build();
    const a = evaluate(log, 'strict');
    expect(a.pursuits[0]?.terminated).toBe(true);
    expect(a.pursuits[0]?.ruleIds.includes('SS-10.2')).toBe(false);
  });

  it('a handoff after a termination advisory still counts the ignored advisory time', () => {
    const b = new LogBuilder('C-00009', 'vehicleWanted').start().person(1, 'driver').indicator(1, 'stolenVehicle', 'lookup');
    b.at(1).pursuit(1);
    b.at(100).advisory('terminatePursuit');
    b.at(130).pursuitEnd(1, 'handoff');
    const a = evaluate(b.build());
    expect(a.pursuits[0]).toMatchObject({ terminated: true, advisoryIgnoredS: 30 });
    expect(a.pursuits[0]?.ruleIds).toEqual(['GS-10.2']);
  });

  it('evaluatePursuit takes the end reason straight from its input', () => {
    const rs = getRuleset('generic');
    const input: PursuitInput = {
      start: { id: 1, t: 0, kind: 'pursuitStart', personId: 1, pursuit: 'vehicle', pursuitCallId: 2 } as PursuitInput['start'],
      samples: [],
      end: { id: 2, t: 700, kind: 'pursuitEnd', personId: 1, reason: 'handoff' } as NonNullable<PursuitInput['end']>,
      advisory: null,
      offense: 'felonyVehicle',
      nowT: 700,
    };
    expect(evaluatePursuit(input, rs).terminated).toBe(true);
    expect(evaluatePursuit({ ...input, end: { ...input.end!, reason: 'escaped' } }, rs).terminated).toBe(false);
  });
});
