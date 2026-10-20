import { describe, expect, it } from 'vitest';
import { evaluateIncident } from '../../src/legal/evaluate';
import { getRuleset } from '../../src/legal/ruleset';
import { drugs, LogBuilder } from './helpers';

/** About 600 events of every common kind across several persons. */
function bigLog() {
  const b = new LogBuilder('C-00500', 'trafficStop').start();
  for (let p = 1; p <= 4; p++) b.person(p, p === 1 ? 'driver' : 'passenger');
  b.entry(3, true, 1);
  let t = 0;
  while (b.lastId < 600) {
    t += 2;
    b.at(t);
    const p = 1 + (b.lastId % 4);
    switch (b.lastId % 12) {
      case 0: b.indicator(p, 'speeding'); break;
      case 1: b.detain(p); break;
      case 2: b.consent(p, 'searchPerson'); break;
      case 3: b.frisk(p, [drugs(`i${b.lastId}`)]); break;
      case 4: b.search(p, 'vehicle', [drugs(`s${b.lastId}`)]); break;
      case 5: b.question(p, 'account', true); break;
      case 6: b.statement(p, 'account', 'x'); break;
      case 7: b.force(p, 'hardHands', 'active'); break;
      case 8: b.other(p, 'baton', 'compliant', 5); break;
      case 9: b.arrest(p); break;
      case 10: b.sample(p, 50); break;
      default: b.indicator(p, 'odorAlcohol'); break;
    }
  }
  return b.build();
}

describe('performance', () => {
  it('evaluates a 600-event log in under 2 ms on average', () => {
    const log = bigLog();
    expect(log.events.length).toBeGreaterThanOrEqual(600);
    const rs = getRuleset('generic');
    for (let i = 0; i < 30; i++) evaluateIncident(log, rs);
    const start = performance.now();
    for (let i = 0; i < 50; i++) evaluateIncident(log, rs);
    const average = (performance.now() - start) / 50;
    expect(average).toBeLessThan(2);
  });
});
