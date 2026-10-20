import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { isConductSave, newConductSave, type ConductSave } from '../../src/conduct/save';
import { TRUST } from '../../src/dialogue/data';

function fresh(): ConductSave {
  return newConductSave(createRng(3).stream('conduct').state());
}

function mutate(change: (s: Record<string, unknown>) => void): unknown {
  const s = JSON.parse(JSON.stringify(fresh())) as Record<string, unknown>;
  change(s);
  return s;
}

describe('ConductSave', () => {
  it('starts at the baselines, active, with credibility 0.85', () => {
    const s = fresh();
    expect(s).toMatchObject({ version: 1, status: 'active', credibility: 0.85, points: 0, nextIa: 1, queue: [], ia: [], lastDriftGame: -1 });
    expect(Object.keys(s.trust).sort()).toEqual([...TRUST.keys()].sort());
    expect(s.trustDayAgo).toEqual(s.trust);
    expect(s.trustDayAgo).not.toBe(s.trust);
    expect(isConductSave(s)).toBe(true);
  });

  it('accepts a populated save', () => {
    const s = fresh();
    s.queue.push(
      { kind: 'incidentClosed', key: 'C-1', aggressiveLines: 1 },
      { kind: 'report', key: 'C-1', docId: 'D', assertions: ['a'] },
      { kind: 'iaStatement', caseId: 'IA-0001', statement: { kind: 'account', claims: [{ eventId: 3, resistance: 'active' }] } },
      { kind: 'verdict', key: 'C-1', caseId: 'CS', verdict: 'convicted', reason: '', credibilityDelta: 0.1, impeached: false, missed: false },
      { kind: 'trust', district: 'park', delta: 0.1, reason: 'x' },
      { kind: 'reinstate' },
    );
    s.ia.push({
      id: 'IA-0001', key: 'C-1', openedGame: 1, triggers: [{ rule: 'complaint', severity: 'minor', eventIds: [] }], severity: 'minor', status: 'closed',
      statement: { kind: 'acknowledge' }, finding: 'sustained', untruthful: false,
      discipline: [{ action: 'suspension', hours: 8, amount: 0, caseId: 'IA-0001', game: 2 }], closedGame: 3,
    });
    s.commendations.push({ id: 'cleanCase', label: 'Clean case', key: 'C-1', game: 1, points: 15 });
    s.reports.push({ docId: 'D', key: 'C-1', score: 90, letter: 'A', completeness: 1, missing: [], contradictions: [{ text: 't', onCamera: true }], unsupported: [], game: 1 });
    expect(isConductSave(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('rejects malformed saves', () => {
    expect(isConductSave(null)).toBe(false);
    expect(isConductSave('x')).toBe(false);
    expect(isConductSave({})).toBe(false);
    const bad: [string, (s: Record<string, unknown>) => void][] = [
      ['version', (s) => { s.version = 2; }],
      ['rng', (s) => { s.rng = { seed: 1, s: [1, 2, 3] }; }],
      ['rng word', (s) => { s.rng = { seed: 1, s: [1, 2, 3, -4] }; }],
      ['trust value', (s) => { (s.trust as Record<string, unknown>).park = 'x'; }],
      ['trust nan', (s) => { (s.trust as Record<string, unknown>).park = null; }],
      ['trust missing', (s) => { delete s.trust; }],
      ['dayAgo', (s) => { s.trustDayAgo = []; }],
      ['status', (s) => { s.status = 'fired'; }],
      ['lastDrift', (s) => { s.lastDriftGame = 'now'; }],
      ['credibility', (s) => { s.credibility = null; }],
      ['reason', (s) => { s.statusReason = 4; }],
      ['nextIa', (s) => { s.nextIa = 1.5; }],
      ['commendation', (s) => { s.commendations = [{ id: 'x' }]; }],
      ['discipline action', (s) => { s.discipline = [{ action: 'fine', hours: 0, amount: 0, caseId: '', game: 0 }]; }],
      ['ia', (s) => { s.ia = [{ id: 'IA-1' }]; }],
      ['ia finding', (s) => {
        s.ia = [{ id: 'a', key: 'k', openedGame: 0, triggers: [], severity: 'minor', status: 'open', statement: null, finding: 'guilty', untruthful: false, discipline: [], closedGame: -1 }];
      }],
      ['ia trigger', (s) => {
        s.ia = [{ id: 'a', key: 'k', openedGame: 0, triggers: [{ rule: 'x', severity: 'huge', eventIds: [] }], severity: 'minor', status: 'open', statement: null, finding: null, untruthful: false, discipline: [], closedGame: -1 }];
      }],
      ['ia statement', (s) => {
        s.ia = [{ id: 'a', key: 'k', openedGame: 0, triggers: [], severity: 'minor', status: 'open', statement: { kind: 'lie' }, finding: null, untruthful: false, discipline: [], closedGame: -1 }];
      }],
      ['report', (s) => { s.reports = [{ docId: 'D', key: 'k', score: 1, letter: 'Z', completeness: 1, missing: [], contradictions: [], unsupported: [], game: 0 }]; }],
      ['report contradiction', (s) => { s.reports = [{ docId: 'D', key: 'k', score: 1, letter: 'A', completeness: 1, missing: [], contradictions: [{ text: 1 }], unsupported: [], game: 0 }]; }],
      ['stats', (s) => { delete (s.stats as Record<string, unknown>).avgReport; }],
      ['queue kind', (s) => { s.queue = [{ kind: 'explode' }]; }],
      ['queue field', (s) => { s.queue = [{ kind: 'trust', district: 'park', delta: 'x', reason: '' }]; }],
      ['queue not array', (s) => { s.queue = {}; }],
    ];
    for (const [name, change] of bad) expect(isConductSave(mutate(change)), name).toBe(false);
  });
});
