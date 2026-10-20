import { describe, expect, it } from 'vitest';
import { gradeReport } from '../../src/conduct/report';
import { buildReportChoices } from '../../src/legal/report';
import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset } from '../../src/legal/ruleset';
import { LogBuilder, choice } from './helpers';

/** A body-camera log: event ids 1 (start) .. with a muted / off period. */
function camLog() {
  const b = new LogBuilder('C-00009', 'disturbance');
  b.start().person(1, 'suspect', 'Mr. Doe').after(1).force(1, 'taser', 'active');
  const onCam = b.lastId;
  b.after(1).cam(true, true).after(1).force(1, 'baton', 'passive');
  const muted = b.lastId;
  b.after(1).cam(false).after(1).force(1, 'hardHands', 'compliant');
  const off = b.lastId;
  return { log: b.build(), onCam, muted, off };
}

describe('gradeReport', () => {
  const { log, onCam, muted, off } = camLog();
  const keys = [
    choice('a', 'true', { key: true }), choice('b', 'true', { key: true }), choice('c', 'true', { key: true }), choice('d', 'true', { key: true }),
  ];

  it('gives a perfect report 100 / A', () => {
    const g = gradeReport(keys, ['a', 'b', 'c', 'd'], log, 'DOC-1', 555);
    expect(g).toMatchObject({ docId: 'DOC-1', key: 'C-00009', score: 100, letter: 'A', completeness: 1, missing: [], unsupported: [], game: 555 });
    expect(g.contradictions).toEqual([]);
  });

  it('scores 100 when there is nothing key to assert and nothing wrong is claimed', () => {
    expect(gradeReport([choice('x', 'true')], [], log, 'D', 0).score).toBe(100);
    expect(gradeReport([], [], log, 'D', 0).completeness).toBe(1);
  });

  it('lowers completeness for missing key facts and lists what is missing', () => {
    const g = gradeReport(keys, ['a', 'b'], log, 'D', 0);
    expect(g.completeness).toBe(0.5);
    expect(g.score).toBe(50);
    expect(g.letter).toBe('F');
    expect(g.missing).toEqual(['text c', 'text d']);
  });

  it('ignores non-key true facts, unknown ids and duplicate ids', () => {
    const cs = [choice('a', 'true', { key: true }), choice('n', 'true')];
    const g = gradeReport(cs, ['a', 'a', 'zzz', 'n'], log, 'D', 0);
    expect(g.score).toBe(100);
  });

  it('limits missing to five', () => {
    const many = Array.from({ length: 8 }, (_, i) => choice(`k${i}`, 'true', { key: true }));
    expect(gradeReport(many, [], log, 'D', 0).missing).toHaveLength(5);
  });

  it('costs 20 for a false claim about a recorded event and 12 off camera', () => {
    const base = [...keys];
    const onG = gradeReport([...base, choice('f', 'false', { eventId: onCam })], ['a', 'b', 'c', 'd', 'f'], log, 'D', 0);
    expect(onG.contradictions).toEqual([{ text: 'text f', onCamera: true }]);
    expect(onG.score).toBe(80);
    expect(onG.letter).toBe('B');
    const offG = gradeReport([...base, choice('f', 'false', { eventId: off })], ['a', 'b', 'c', 'd', 'f'], log, 'D', 0);
    expect(offG.contradictions).toEqual([{ text: 'text f', onCamera: false }]);
    expect(offG.score).toBe(88);
    const mutedG = gradeReport([...base, choice('f', 'false', { eventId: muted })], ['a', 'b', 'c', 'd', 'f'], log, 'D', 0);
    expect(mutedG.contradictions[0]?.onCamera).toBe(false);
    expect(mutedG.score).toBe(88);
  });

  it('does not count false claims that were not asserted', () => {
    expect(gradeReport([...keys, choice('f', 'false', { eventId: onCam })], ['a', 'b', 'c', 'd'], log, 'D', 0).score).toBe(100);
  });

  it('judges a distractor by the person events recorded', () => {
    const f = choice('f', 'false', { personId: 1 });
    // person 1: person + first force recorded, muted and off-camera force not: exactly half counts
    expect(gradeReport([f], ['f'], log, 'D', 0).contradictions[0]?.onCamera).toBe(true);
    const mostlyOff = new LogBuilder().start().person(1, 'suspect').cam(false).force(1, 'taser', 'active').force(1, 'baton', 'active').build();
    expect(gradeReport([f], ['f'], mostlyOff, 'D', 0).contradictions[0]?.onCamera).toBe(false);
    const rec = new LogBuilder().start().person(1, 'suspect').force(1, 'taser', 'active').build();
    expect(gradeReport([f], ['f'], rec, 'D', 0).contradictions[0]?.onCamera).toBe(true);
    const nobody = choice('g', 'false', { personId: 9 });
    expect(gradeReport([nobody], ['g'], rec, 'D', 0).contradictions[0]?.onCamera).toBe(false);
    // personId -1 uses every event
    const all = choice('h', 'false', { personId: -1 });
    expect(gradeReport([all], ['h'], rec, 'D', 0).contradictions[0]?.onCamera).toBe(true);
  });

  it('costs 10 for an unsupported claim', () => {
    const g = gradeReport([...keys, choice('u', 'unsupported')], ['a', 'b', 'c', 'd', 'u'], log, 'D', 0);
    expect(g.unsupported).toEqual(['text u']);
    expect(g.score).toBe(90);
    expect(g.letter).toBe('A');
  });

  it('treats two assertions of one group as one contradiction', () => {
    const grp = [
      choice('r1', 'true', { group: 'res:1', key: true, eventId: onCam }),
      choice('r2', 'false', { group: 'res:1', eventId: onCam }),
      choice('r3', 'false', { group: 'res:1', eventId: onCam }),
    ];
    const g = gradeReport(grp, ['r1', 'r2'], log, 'D', 0);
    expect(g.contradictions).toHaveLength(1);
    expect(g.contradictions[0]).toMatchObject({ onCamera: true });
    expect(g.contradictions[0]?.text).toBe('text r1 / text r2');
    expect(g.score).toBe(80);
    // three in a group is still one
    expect(gradeReport(grp, ['r1', 'r2', 'r3'], log, 'D', 0).contradictions).toHaveLength(1);
    // one false in the group is a plain contradiction
    const lone = gradeReport(grp, ['r2'], log, 'D', 0);
    expect(lone.contradictions).toHaveLength(1);
    expect(lone.completeness).toBe(0);
    // two independent groups -> two contradictions
    const two = [...grp, choice('s1', 'true', { group: 'g2' }), choice('s2', 'true', { group: 'g2' })];
    expect(gradeReport(two, ['r1', 'r2', 's1', 's2'], log, 'D', 0).contradictions).toHaveLength(2);
  });

  it('clamps the score at 0 and assigns letters at the boundaries', () => {
    const lies = Array.from({ length: 6 }, (_, i) => choice(`l${i}`, 'false', { eventId: onCam }));
    const g = gradeReport([...keys, ...lies], ['a', ...lies.map((l) => l.id)], log, 'D', 0);
    expect(g.score).toBe(0);
    expect(g.letter).toBe('F');
    const grade = (n: number): string => {
      const cs = Array.from({ length: 100 }, (_, i) => choice(`k${i}`, 'true', { key: true }));
      return gradeReport(cs, cs.slice(0, n).map((c) => c.id), log, 'D', 0).letter;
    };
    expect([grade(100), grade(90), grade(89), grade(80), grade(79), grade(70), grade(69), grade(60), grade(59)]).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'F']);
  });

  it('grades the real choices of the legal engine: asserting every key fact is a perfect report', () => {
    const rs = getRuleset('generic');
    const b = new LogBuilder('C-00042', 'trafficStop');
    b.start().person(1, 'driver', 'Mr. Doe').indicator(1, 'trafficViolation').detain(1).after(1).force(1, 'hardHands', 'active').after(1).release(1, 'citation');
    const log = b.build();
    const a = evaluateIncident(log, rs);
    const choices = buildReportChoices(log, a, rs, 11);
    const key = choices.filter((c) => c.key).map((c) => c.id);
    expect(key.length).toBeGreaterThan(0);
    const perfect = gradeReport(choices, key, log, 'D1', 0);
    expect(perfect.score).toBe(100);
    expect(perfect.contradictions).toEqual([]);
    // asserting a false distractor drops the score
    const lie = choices.find((c) => c.truth === 'false');
    if (lie) expect(gradeReport(choices, [...key, lie.id], log, 'D1', 0).score).toBeLessThan(100);
  });
});
