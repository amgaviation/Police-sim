import { describe, expect, it } from 'vitest';
import { iaStatementOptions } from '../../src/conduct';
import type { IaCase, IaStatement } from '../../src/conduct/types';
import { MemoryMediaStore, camStateOf } from '../../src/recording';
import type { IncidentLog, LegalAssessment } from '../../src/legal';
import { iaReviewFooter, iaReviewSource, reviewEventsOf, toolLabel } from '../../src/ui/ia';
import { LogBuilder, drugs, gun } from '../legal/helpers';
import { assess, det, ruling } from '../conduct/helpers';
import { richFixture } from '../court/helpers';

function iaCase(over: Partial<IaCase> = {}): IaCase {
  return {
    id: 'IA-0001',
    key: 'C-00001',
    openedGame: 1000,
    triggers: [{ rule: 'excessiveForce', severity: 'major', eventIds: [] }],
    severity: 'major',
    status: 'open',
    statement: null,
    finding: null,
    untruthful: false,
    discipline: [],
    closedGame: 0,
    ...over,
  };
}

const byKind = (events: ReturnType<typeof reviewEventsOf>, kind: string): string[] => events.filter((e) => e.kind === kind).map((e) => e.label);

/** A log with one event of nearly every kind. */
function everyKind(): { log: IncidentLog; ids: Record<string, number> } {
  const b = new LogBuilder('C-00001', 'trafficStop');
  const ids: Record<string, number> = {};
  const mark = (name: string): void => {
    ids[name] = b.lastId;
  };
  b.at(0).start();
  b.person(1, 'driver', 'Sam Rivera');
  b.at(5).indicator(1, 'odorAlcohol');
  b.detain(1);
  b.at(6).question(1, 'drinking', true);
  b.statement(1, 'drinking', 'yes', true);
  b.miranda(1, 'waived');
  b.consent(1, 'searchVehicle', true, true);
  b.at(10).frisk(1, [gun()]);
  mark('frisk');
  b.search(1, 'vehicle', [drugs()], { claimedBasis: 'consent' });
  mark('search');
  b.seize(1, drugs(), ids['search'] as number);
  b.test(1, 'sfst', 'fail');
  b.arrest(1);
  b.at(20).force(1, 'taser', 'active');
  mark('taser');
  b.other(1, 'hardHands', 'passive', 2, { officer: 'Partner' });
  mark('other');
  b.intervene(ids['other'] as number);
  b.release(1, 'citation');
  b.cam(true, true);
  b.entry(3);
  b.exigency('screaming inside');
  b.warrant('search');
  b.pursuit(1, 'vehicle');
  b.sample(1, 62, { limitMph: 35 });
  b.pursuitEnd(1, 'terminated');
  b.advisory('terminatePursuit');
  b.at(40);
  return { log: b.build(), ids };
}

describe('toolLabel', () => {
  it('names every force tool and the firearm display', () => {
    expect(toolLabel('taser')).toBe('CED');
    expect(toolLabel('ocSpray')).toBe('OC spray');
    expect(toolLabel('firearmDisplay')).toBe('Firearm drawn');
    expect(toolLabel('lessLethal')).toBe('Less-lethal launcher');
    expect(toolLabel('hands')).toBe('Hands');
    expect(toolLabel('none')).toBe('Presence');
    expect(toolLabel('futureTool')).toBe('Future tool');
  });
});

describe('reviewEventsOf labels', () => {
  const { log } = everyKind();
  const events = reviewEventsOf(log, null);

  it('lists the events in order with their id, time, kind and camera bits', () => {
    expect(events.map((e) => e.id)).toEqual(log.events.filter((e) => e.kind !== 'pursuitSample').map((e) => e.id));
    for (let i = 1; i < events.length; i++) expect((events[i] as { t: number }).t).toBeGreaterThanOrEqual((events[i - 1] as { t: number }).t);
    const src = log.events[0];
    expect(events[0]).toMatchObject({ id: src?.id, t: src?.t, kind: 'start', cam: src?.cam });
  });

  it('leaves out the 1 Hz pursuit samples', () => {
    expect(log.events.some((e) => e.kind === 'pursuitSample')).toBe(true);
    expect(events.some((e) => e.kind === 'pursuitSample')).toBe(false);
  });

  it('labels the questions and answers like the design', () => {
    expect(byKind(events, 'question')).toEqual(['Q: drinking (custody)']);
    expect(byKind(events, 'statement')).toEqual(['A: drinking = yes']);
    expect(byKind(events, 'miranda')).toEqual(['Miranda: waived']);
  });

  it('labels consent, frisk, search, seizure and tests', () => {
    expect(byKind(events, 'consent')).toEqual(['Consent: searchVehicle granted']);
    expect(byKind(events, 'frisk')).toEqual(['Frisk — found 1']);
    expect(byKind(events, 'search')).toEqual(['Search of vehicle — found 1']);
    expect(byKind(events, 'seizure')).toEqual(['Seized: Baggie of pills']);
    expect(byKind(events, 'test')).toEqual(['Field sobriety test: fail']);
    expect(byKind(events, 'arrest')).toEqual(['Arrest']);
    expect(byKind(events, 'release')).toEqual(['Released with a citation']);
  });

  it('labels an empty frisk and search plainly', () => {
    const b = new LogBuilder();
    b.at(0).start().person(1, 'driver').frisk(1).search(1, 'vehicle');
    const e = reviewEventsOf(b.build(), null);
    expect(byKind(e, 'frisk')).toEqual(['Frisk']);
    expect(byKind(e, 'search')).toEqual(['Search of vehicle']);
  });

  it('labels the indicator from the ruleset label, or from the detail when the recorder gave one', () => {
    expect(byKind(events, 'indicator')).toEqual(['Observed: odor of alcohol']);
    const b = new LogBuilder();
    b.at(0).start().person(1, 'driver').indicator(1, 'speeding').indicator(1, 'weaving').indicator(1, 'sfstFail');
    expect(byKind(reviewEventsOf(b.build(), null), 'indicator')).toEqual([
      'Observed: speeding',
      'Observed: weaving within the lane',
      'Observed: failed field sobriety test',
    ]);
    const log = b.build();
    const first = log.events.find((e) => e.kind === 'indicator');
    if (first?.kind === 'indicator') first.detail = 'radar reading 62 mph';
    expect(byKind(reviewEventsOf(log, null), 'indicator')[0]).toBe('Observed: radar reading 62 mph');
  });

  it('labels the camera events by their bits', () => {
    const b = new LogBuilder();
    b.at(0).start().cam(true).cam(true, true).cam(false).cam(false, false, true).cam(true, false, true);
    expect(byKind(reviewEventsOf(b.build(), null), 'cam')).toEqual([
      'Bodycam ON',
      'Bodycam MUTED',
      'Bodycam OFF',
      'Bodycam OFF · Dashcam ON',
      'Bodycam ON · Dashcam ON',
    ]);
  });

  it('labels force with tool, resistance and verdict only when scored', () => {
    expect(byKind(events, 'force')).toEqual(['CED — active resistance']);
    expect(byKind(events, 'otherForce')).toEqual(['Partner: hard hands on passive resistance']);
    expect(byKind(events, 'intervene')).toEqual(['Intervened']);
    const id = log.events.find((e) => e.kind === 'force')?.id ?? -1;
    const scored = reviewEventsOf(log, assess('C-00001', { force: [ruling(id, 'justified')] }));
    expect(byKind(scored, 'force')).toEqual(['CED — active resistance (justified)']);
    const excessive = reviewEventsOf(log, assess('C-00001', { force: [ruling(id, 'excessive')] }));
    expect(byKind(excessive, 'force')).toEqual(['CED — active resistance (excessive)']);
  });

  it('labels a missed shot, a drawn firearm and fellow-officer force with its verdict', () => {
    const b = new LogBuilder();
    b.at(0).start().person(1, 'suspect').force(1, 'presence', 'assaultive', { tool: 'firearmDisplay' }).force(1, 'taser', 'active');
    const log = b.build();
    const taser = log.events.find((e) => e.kind === 'force' && e.tool === 'taser');
    if (taser?.kind === 'force') taser.hit = false;
    expect(byKind(reviewEventsOf(log, null), 'force')).toEqual(['Firearm drawn — assaultive resistance', 'CED — active resistance, missed']);
  });

  it('labels the remaining kinds', () => {
    expect(byKind(events, 'start')).toEqual(['Incident start: test']);
    expect(byKind(events, 'person')).toEqual(['Person: Sam Rivera (driver)']);
    expect(byKind(events, 'detention')).toEqual(['Detention (trafficStop)']);
    expect(byKind(events, 'entry')).toEqual(['Entered the building']);
    expect(byKind(events, 'exigency')).toEqual(['Exigency: screaming inside']);
    expect(byKind(events, 'warrant')).toEqual(['Warrant (search)']);
    expect(byKind(events, 'pursuitStart')).toEqual(['Pursuit begins (vehicle)']);
    expect(byKind(events, 'pursuitEnd')).toEqual(['Pursuit ends: terminated']);
    expect(byKind(events, 'advisory')).toEqual(['Advisory: terminatePursuit']);
    const b = new LogBuilder();
    b.at(0).start().person(1, 'suspect').entry(4, true).arrest(1, 'booking');
    const log = b.build();
    // Kinds the builder has no helper for.
    const base = { t: 1, game: 1001, personId: 1, cam: 1 };
    log.events.push(
      { ...base, id: 90, kind: 'command', command: 'stop', outcome: 'obeyed' },
      { ...base, id: 91, kind: 'service', service: 'k9Unit', phase: 'arrived' },
      { ...base, id: 92, kind: 'charges', statutes: ['DUI', 'RESIST'], docId: 'B-0001' },
      { ...base, id: 93, kind: 'charges', statutes: [], docId: 'B-0002' },
    );
    const e = reviewEventsOf(log, null);
    expect(byKind(e, 'entry')).toEqual(['Entered a public place']);
    expect(byKind(e, 'arrest')).toEqual(['Arrest (booking)']);
    expect(byKind(e, 'command')).toEqual(['Command: stop — obeyed']);
    expect(byKind(e, 'service')).toEqual(['K9 unit arrived']);
    expect(byKind(e, 'charges')).toEqual(['Charges: DUI, RESIST', 'Charges: none']);
  });

  it('never leaves a label empty for any kind', () => {
    for (const e of events) expect(e.label.length, e.kind).toBeGreaterThan(0);
  });
});

describe('reviewEventsOf severities', () => {
  it('is info everywhere without an assessment', () => {
    expect(reviewEventsOf(everyKind().log, null).every((e) => e.severity === 'info')).toBe(true);
  });

  it('marks events with an unlawful determination bad and a questionable one warn', () => {
    const { log, ids } = everyKind();
    const a = assess('C-00001', { dets: [det('frisk', 'unlawful', [ids['frisk'] as number]), det('search', 'questionable', [ids['search'] as number]), det('detention', 'lawful', [log.events[3]?.id ?? 0])] });
    const events = reviewEventsOf(log, a);
    const sev = (id: number): string => events.find((e) => e.id === id)?.severity ?? '';
    expect(sev(ids['frisk'] as number)).toBe('bad');
    expect(sev(ids['search'] as number)).toBe('warn');
    expect(sev(log.events[3]?.id ?? 0)).toBe('info');
    expect(events.filter((e) => e.severity !== 'info')).toHaveLength(2);
  });

  it('marks every event of a recording determination and keeps the worst severity', () => {
    const { log, ids } = everyKind();
    const a = assess('C-00001', { dets: [det('recording', 'unlawful', [ids['taser'] as number, ids['frisk'] as number]), det('frisk', 'questionable', [ids['frisk'] as number])] });
    const events = reviewEventsOf(log, a);
    expect(events.find((e) => e.id === ids['taser'])?.severity).toBe('bad');
    expect(events.find((e) => e.id === ids['frisk'])?.severity).toBe('bad');
  });

  it('marks excessive force bad and questionable force warn, justified force info', () => {
    const b = new LogBuilder();
    b.at(0).start().person(1, 'suspect');
    b.at(5).force(1, 'taser', 'active');
    const t = b.lastId;
    b.at(10).force(1, 'baton', 'passive');
    const bt = b.lastId;
    b.at(15).force(1, 'hardHands', 'compliant');
    const h = b.lastId;
    const a = assess('C-00001', { force: [ruling(t, 'justified'), ruling(bt, 'excessive'), ruling(h, 'questionable')] });
    const events = reviewEventsOf(b.build(), a);
    expect(events.filter((e) => e.kind === 'force').map((e) => e.severity)).toEqual(['info', 'bad', 'warn']);
  });

  it('marks an unlawful pursuit at its start event', () => {
    const { log } = everyKind();
    const start = log.events.find((e) => e.kind === 'pursuitStart')?.id ?? -1;
    const a: LegalAssessment = {
      ...assess('C-00001'),
      pursuits: [{ startEventId: start, personId: 1, offense: null, startAllowed: false, overLimitS: 5, lightsSirenOk: true, advisoryIgnoredS: 0, durationS: 10, terminated: false, outcome: 'unlawful', ruleIds: [], reasons: [] }],
    };
    expect(reviewEventsOf(log, a).find((e) => e.id === start)?.severity).toBe('bad');
  });

  it('works on the real evaluator output of a busy stop', () => {
    const f = richFixture();
    const events = reviewEventsOf(f.log, f.assessment);
    expect(events.length).toBeGreaterThan(5);
    // The unlawful frisk and the strike on a passive subject are flagged.
    expect(events.find((e) => e.id === f.ids['frisk'])?.severity).toBe('bad');
    expect(events.find((e) => e.id === f.ids['strike'])?.severity).toBe('bad');
    expect(byKind(events, 'force')).toEqual(['CED — active resistance (justified)', 'Hands — passive resistance (questionable)']);
    // Every flagged event traces back to the assessment.
    const flagged = new Set<number>();
    for (const d of f.assessment.determinations) if (d.outcome !== 'lawful') for (const id of d.eventIds) flagged.add(id);
    for (const r of f.assessment.force) if (r.verdict !== 'justified') flagged.add(r.eventId);
    for (const e of events) if (e.severity !== 'info') expect(flagged.has(e.id), `event ${String(e.id)}`).toBe(true);
  });
});

describe('iaReviewSource', () => {
  it('reviews an incident without a case (the Career tab): titled with the key', () => {
    const { log } = everyKind();
    const src = iaReviewSource(log, null, new MemoryMediaStore(), 'game1');
    expect(src.title).toBe('Incident C-00001');
    expect(src.events).toEqual(reviewEventsOf(log, null));
  });

  it('spans the incident, titles it with the case and keeps the cam bits for the REC strip', async () => {
    const { log } = everyKind();
    const media = new MemoryMediaStore();
    const src = iaReviewSource(log, iaCase(), media, 'game1');
    expect(src.title).toBe('IA-0001 · C-00001');
    expect(src.t0).toBe(0);
    expect(src.t1).toBe(40);
    expect(src.events).toEqual(reviewEventsOf(log, null).map((e) => ({ ...e, severity: e.severity })));
    const muted = src.events.find((e) => e.kind === 'entry');
    expect(camStateOf(muted?.cam ?? 0)).toBe('muted');
    expect(await src.snapshots()).toEqual([]);
    expect(await src.image('nothing')).toBeNull();
  });

  it('reads the snapshots of this incident and tag from the media store', async () => {
    const { log } = everyKind();
    const media = new MemoryMediaStore();
    const blob = new Blob(['jpeg']);
    await media.put({ tag: 'game1', incident: 'C-00001', source: 'body', sim: 3, game: 4, w: 160, h: 90 }, blob);
    await media.put({ tag: 'game1', incident: 'C-00002', source: 'body', sim: 3, game: 4, w: 160, h: 90 }, blob);
    await media.put({ tag: 'other', incident: 'C-00001', source: 'body', sim: 3, game: 4, w: 160, h: 90 }, blob);
    const src = iaReviewSource(log, iaCase(), media, 'game1');
    const snaps = await src.snapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.incident).toBe('C-00001');
    expect((await src.image(snaps[0]?.key ?? ''))?.size).toBe(4);
  });

  it('raises the events an IA trigger is about to at least warn, without lowering bad ones', () => {
    const { log, ids } = everyKind();
    const c = iaCase({ triggers: [{ rule: 'excessiveForce', severity: 'major', eventIds: [ids['taser'] as number, ids['frisk'] as number] }] });
    const a = assess('C-00001', { dets: [det('frisk', 'unlawful', [ids['frisk'] as number])] });
    const src = iaReviewSource(log, c, new MemoryMediaStore(), 't', a);
    expect(src.events.find((e) => e.id === ids['taser'])?.severity).toBe('warn');
    expect(src.events.find((e) => e.id === ids['frisk'])?.severity).toBe('bad');
    expect(iaReviewSource(log, c, new MemoryMediaStore(), 't').events.find((e) => e.id === ids['taser'])?.severity).toBe('warn');
  });

  it('gives an empty log a playable range', () => {
    const log: IncidentLog = { ...everyKind().log, events: [], openedSim: 10, closedSim: -1 };
    const src = iaReviewSource(log, iaCase(), new MemoryMediaStore(), 't');
    expect(src.events).toEqual([]);
    expect(src.t1).toBeGreaterThan(src.t0);
  });
});

describe('iaReviewFooter', () => {
  const real = (): { c: IaCase; log: IncidentLog } => {
    const b = new LogBuilder();
    b.at(0).start().person(1, 'suspect').force(1, 'taser', 'passive');
    const log = b.build();
    return { c: iaCase({ triggers: [{ rule: 'failureToIntervene', severity: 'critical', eventIds: [] }], severity: 'critical' }), log };
  };

  it('describes the case and lists the statement options as plain text (the panel numbers them)', () => {
    const { c, log } = real();
    const a = assess('C-00001', { force: [ruling(log.events.find((e) => e.kind === 'force')?.id ?? 0, 'excessive', { resistance: 'passive' })] });
    const options = iaStatementOptions(c, log);
    expect(options.length).toBeGreaterThanOrEqual(2);
    void a;
    const footer = iaReviewFooter(c, options, () => undefined);
    expect(footer.options()).toEqual(options.map((o) => o.text));
    const lines = footer.lines();
    expect(lines[0]).toBe('Internal affairs IA-0001 (critical)');
    expect(lines[1]).toBe('Concerns: Failure to intervene');
    expect(lines[2]).toContain('give your statement');
  });

  it('submits the picked statement once, then shows the outcome and no options', () => {
    const { c } = real();
    const options = [
      { text: 'I acknowledge the policy violation.', statement: { kind: 'acknowledge' } as IaStatement },
      { text: 'I have nothing to add.', statement: { kind: 'none' } as IaStatement },
    ];
    const submitted: IaStatement[] = [];
    const footer = iaReviewFooter(c, options, (s) => submitted.push(s));
    footer.pick(1);
    expect(submitted).toEqual([{ kind: 'none' }]);
    expect(footer.options()).toEqual([]);
    expect(footer.lines().at(-1)).toBe('Your statement was recorded: I have nothing to add.');
    footer.pick(0); // a second pick is ignored
    expect(submitted).toHaveLength(1);
  });

  it('ignores picks outside the options', () => {
    const { c } = real();
    const submitted: IaStatement[] = [];
    const footer = iaReviewFooter(c, [{ text: 'x', statement: { kind: 'none' } }], (s) => submitted.push(s));
    footer.pick(5);
    footer.pick(-1);
    expect(submitted).toEqual([]);
    expect(footer.options()).toEqual(['x']);
  });

  it('is read-only for a closed case or one that already has a statement', () => {
    const options = [{ text: 'x', statement: { kind: 'none' } as IaStatement }];
    const submitted: IaStatement[] = [];
    const closed = iaReviewFooter(iaCase({ status: 'closed', finding: 'sustained', statement: { kind: 'none' } }), options, (s) => submitted.push(s));
    expect(closed.options()).toEqual([]);
    expect(closed.lines().at(-1)).toBe('Finding: Sustained');
    closed.pick(0);
    const given = iaReviewFooter(iaCase({ statement: { kind: 'acknowledge' } }), options, (s) => submitted.push(s));
    expect(given.options()).toEqual([]);
    expect(given.lines().at(-1)).toBe('Your statement is on file.');
    given.pick(0);
    const shut = iaReviewFooter(iaCase({ status: 'closed' }), options, (s) => submitted.push(s));
    expect(shut.lines().at(-1)).toBe('This case is closed.');
    expect(submitted).toEqual([]);
  });

  it('reads a live case: once the app marks it closed the footer follows', () => {
    const c = iaCase();
    const footer = iaReviewFooter(c, [{ text: 'x', statement: { kind: 'none' } }], () => undefined);
    expect(footer.options()).toEqual(['x']);
    c.status = 'closed';
    c.finding = 'exonerated';
    expect(footer.options()).toEqual([]);
    expect(footer.lines().at(-1)).toBe('Finding: Exonerated');
  });
});
