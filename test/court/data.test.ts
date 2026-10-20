import { describe, expect, it } from 'vitest';
import { COURT_CONFIG, QUESTIONS, parseCourtConfig, parseQuestions } from '../../src/court';
import { rulesetIds, getRuleset } from '../../src/legal';
import courtJson from '../../src/data/court/court.json';
import questionsJson from '../../src/data/court/questions.json';

const clone = <T>(v: T): T => structuredClone(v);

describe('court.json', () => {
  it('parses to the design values', () => {
    expect(COURT_CONFIG.plea).toEqual({ base: 0.3, strongBonus: 0.3 });
    expect(COURT_CONFIG.citationContest).toBe(0.25);
    expect(COURT_CONFIG.delayH).toEqual([2, 6]);
    expect(COURT_CONFIG.hours).toEqual([9, 17]);
    expect(COURT_CONFIG.windowBeforeMin).toBe(30);
    expect(COURT_CONFIG.windowAfterMin).toBe(120);
    expect(COURT_CONFIG.reminderMin).toBe(60);
    expect(COURT_CONFIG.maxQuestions).toBe(6);
    expect(COURT_CONFIG.credibility.impeachOnCam).toBe(-0.15);
    expect(COURT_CONFIG.testimony.base).toBe(0.5);
    expect(COURT_CONFIG.conviction.missedFactor).toBe(0.4);
  });

  it.each([
    ['version', (r: Record<string, unknown>) => { r.version = 2; }, 'version'],
    ['plea.base out of range', (r: Record<string, unknown>) => { (r.plea as Record<string, unknown>).base = 1.5; }, 'plea.base'],
    ['delayH reversed', (r: Record<string, unknown>) => { r.delayH = [6, 2]; }, 'delayH'],
    ['hours closing before opening', (r: Record<string, unknown>) => { r.hours = [17, 9]; }, 'hours'],
    ['hours of zero length', (r: Record<string, unknown>) => { r.hours = [9, 9]; }, 'hours'],
    ['maxQuestions fractional', (r: Record<string, unknown>) => { r.maxQuestions = 4.5; }, 'maxQuestions'],
    ['credibility missing', (r: Record<string, unknown>) => { delete (r.credibility as Record<string, unknown>).impeachOnCam; }, 'credibility.impeachOnCam'],
    ['conviction.noReportGrade over 100', (r: Record<string, unknown>) => { (r.conviction as Record<string, unknown>).noReportGrade = 120; }, 'conviction.noReportGrade'],
    ['not an object', (r: Record<string, unknown>) => { r.testimony = 5; }, 'testimony'],
  ])('rejects %s naming the path', (_name, mutate, path) => {
    const raw = clone(courtJson) as Record<string, unknown>;
    mutate(raw);
    expect(() => parseCourtConfig(raw, 'court.json')).toThrow(new RegExp(`court\\.json: ${path.replace('.', '\\.')}`));
  });
});

describe('questions.json', () => {
  it('has a template for every kind and a label for every fact and tool', () => {
    for (const kind of ['resistanceAt', 'consentGiven', 'mirandaBefore', 'camDuring', 'reportAssertion', 'omission', 'repeat'] as const) {
      expect(QUESTIONS.templates[kind].length).toBeGreaterThan(0);
    }
    for (const id of rulesetIds()) {
      for (const fact of getRuleset(id).miranda.incriminatingFacts) expect(QUESTIONS.labels.fact[fact], `${id}:${fact}`).toBeTruthy();
    }
    for (const tool of ['none', 'hands', 'ocSpray', 'baton', 'taser', 'lessLethal', 'firearm', 'firearmDisplay', 'k9']) {
      expect(QUESTIONS.labels.tool[tool]).toBeTruthy();
    }
  });

  it('uses generic courtroom wording (no real court names)', () => {
    const text = JSON.stringify(questionsJson).toLowerCase();
    expect(text).not.toMatch(/supreme|district court|lapd|nypd|police department/);
  });

  it('rejects a template missing its slot', () => {
    const raw = clone(questionsJson) as { templates: Record<string, string> };
    raw.templates.resistanceAt = 'Was my client resisting?';
    expect(() => parseQuestions(raw, 'questions.json')).toThrow(/templates\.resistanceAt: must contain \{level\}/);
  });

  it('rejects a missing label and a missing template', () => {
    const noLabel = clone(questionsJson) as { labels: { resistance: Record<string, string> } };
    delete noLabel.labels.resistance.assaultive;
    expect(() => parseQuestions(noLabel, 'questions.json')).toThrow(/labels\.resistance\.assaultive/);
    const noTemplate = clone(questionsJson) as { templates: Record<string, string> };
    delete noTemplate.templates.repeat;
    expect(() => parseQuestions(noTemplate, 'questions.json')).toThrow(/templates\.repeat/);
    const noRestate = clone(questionsJson) as { restatements: Record<string, string> };
    noRestate.restatements.camDuring = 'recording';
    expect(() => parseQuestions(noRestate, 'questions.json')).toThrow(/restatements\.camDuring: must contain \{action\}/);
  });
});
