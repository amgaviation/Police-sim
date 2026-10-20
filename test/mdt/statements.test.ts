import { describe, expect, it } from 'vitest';
import { MDT_REFRESH_MS, MdtOverlay, gradeSections, normalizeAssertions, statementBlocks, type MdtDeps, type ReportGradeView } from '../../src/ui/mdt';
import { addCall, at, fixture } from './helpers';
import { CHOICES, careerFeed, careerView, courtCase, iaCase } from './phase5';

const NARRATIVE = 'Stopped a weaving vehicle, smelled alcohol and made an arrest.';

describe('statementBlocks', () => {
  it('keeps independent statements single and gathers a group where its first member stood', () => {
    const blocks = statementBlocks(CHOICES);
    expect(blocks.map((b) => b.kind)).toEqual(['check', 'group', 'check']);
    const group = blocks[1];
    expect(group?.kind === 'group' && group.items.map((c) => c.id)).toEqual(['consent:searchVehicle:1', 'consent:searchVehicle:1:no']);
    expect(statementBlocks([])).toEqual([]);
  });

  it('puts interleaved members of one group into one block', () => {
    const blocks = statementBlocks([
      { id: 'a', group: 'g', text: 'a' },
      { id: 'b', group: null, text: 'b' },
      { id: 'c', group: 'g', text: 'c' },
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['group', 'check']);
    expect(blocks[0]?.kind === 'group' && blocks[0].items.map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('normalizeAssertions', () => {
  it('drops unknown ids and repeats, keeps one member per exclusive group and follows the choice order', () => {
    const ids = ['miranda:1', 'consent:searchVehicle:1:no', 'consent:searchVehicle:1', 'bogus', 'detention:1', 'detention:1'];
    expect(normalizeAssertions(CHOICES, ids)).toEqual(['detention:1', 'consent:searchVehicle:1', 'miranda:1']);
    expect(normalizeAssertions(CHOICES, [])).toEqual([]);
    expect(normalizeAssertions([], ['detention:1'])).toEqual([]);
  });
});

describe('gradeSections', () => {
  const grade = (over: Partial<ReportGradeView> = {}): ReportGradeView => ({
    score: 84.6,
    letter: 'B',
    missing: [],
    contradictions: [],
    unsupported: [],
    ...over,
  });

  it('is empty without a grade', () => {
    expect(gradeSections(null)).toEqual([]);
  });

  it('shows the score and a clean note for a complete report', () => {
    const [s] = gradeSections(grade());
    expect(s?.id).toBe('grade');
    expect(s?.lines[0]).toEqual({ label: 'Score', text: '85 / 100 (B)', severity: 'none' });
    expect(s?.lines[1]?.label).toBe('Notes');
  });

  it('lists contradictions (bodycam first), missing and unsupported statements with severities', () => {
    const [s] = gradeSections(
      grade({
        score: 41,
        letter: 'F',
        missing: ['I read the driver his rights.'],
        contradictions: [
          { text: 'You said the subject was passive.', onCamera: false },
          { text: 'You said you did not strike him.', onCamera: true },
        ],
        unsupported: ['I saw a weapon.'],
      }),
    );
    const lines = s?.lines ?? [];
    expect(lines[0]).toMatchObject({ text: '41 / 100 (F)', severity: 'alert' });
    expect(lines.slice(1).map((l) => [l.label, l.severity])).toEqual([
      ['Contradicted on bodycam', 'alert'],
      ['Contradicted by the record', 'caution'],
      ['Missing', 'caution'],
      ['Unsupported', 'caution'],
    ]);
    expect(lines[1]?.text).toBe('You said you did not strike him.');
  });

  it('colours the letters', () => {
    const sev = (letter: string): string | undefined => gradeSections(grade({ letter }))[0]?.lines[0]?.severity;
    expect(sev('A')).toBe('none');
    expect(sev('C')).toBe('caution');
    expect(sev('D')).toBe('alert');
  });
});

describe('report form statements (headless model path)', () => {
  interface Submitted {
    docId: string;
    callId: number;
    ids: readonly string[];
  }

  function setup(extra: Partial<MdtDeps> = {}): { mdt: MdtOverlay; f: ReturnType<typeof fixture>; submitted: Submitted[]; callId: number } {
    const f = fixture();
    const call = addCall(f.cad, 1, 2);
    const submitted: Submitted[] = [];
    const deps: MdtDeps = {
      ...f.deps,
      reportChoices: (id) => (id === call.id ? CHOICES : []),
      submitReport: (docId, callId, ids) => submitted.push({ docId, callId, ids }),
      ...extra,
    };
    return { mdt: new MdtOverlay(null, deps), f, submitted, callId: call.id };
  }

  const reportInit = (callId: number | null, narrative = NARRATIVE): Parameters<MdtOverlay['openForm']>[1] => ({
    callId,
    title: 'Traffic stop',
    location: '248 N Oak Street',
    occurredGame: at(0).game,
    narrative,
    offenseIds: [],
    persons: [],
    vehicles: [],
    evidenceIds: [],
  });

  it('exposes the statements of the form call', () => {
    const { mdt, callId } = setup();
    expect(mdt.statementChoices(callId)).toEqual(CHOICES);
    expect(mdt.statementChoices(null)).toEqual([]);
    expect(mdt.statementChoices(callId + 99)).toEqual([]);
  });

  it('finalize passes the checked ids, normalized, to submitReport after validation', () => {
    const { mdt, submitted, callId } = setup();
    mdt.openForm('report', reportInit(callId));
    mdt.setAssertions(['miranda:1', 'consent:searchVehicle:1:no', 'consent:searchVehicle:1', 'bogus', 'detention:1']);
    expect(mdt.formAssertions()).toHaveLength(5);
    const r = mdt.submitForm(true);
    expect(r.errors).toEqual([]);
    expect(r.doc?.status).toBe('final');
    expect(submitted).toEqual([{ docId: r.doc?.id, callId, ids: ['detention:1', 'consent:searchVehicle:1', 'miranda:1'] }]);
  });

  it('submits an empty list when nothing is ticked (the report is graded as it stands)', () => {
    const { mdt, submitted, callId } = setup();
    mdt.openForm('report', reportInit(callId));
    mdt.submitForm(true);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.ids).toEqual([]);
  });

  it('does not submit when validation fails or the report is only saved as a draft', () => {
    const { mdt, submitted, callId } = setup();
    mdt.openForm('report', reportInit(callId, 'too short'));
    mdt.setAssertions(['detention:1']);
    const bad = mdt.submitForm(true);
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(submitted).toEqual([]);
    expect(mdt.cancelForm()).toBe(true);

    mdt.openForm('report', reportInit(callId));
    mdt.setAssertions(['detention:1']);
    const draft = mdt.submitForm(false);
    expect(draft.doc?.status).toBe('draft');
    expect(submitted).toEqual([]);
  });

  it('remembers the ticks of a draft and submits them when the draft is finalized from its form', () => {
    const { mdt, submitted, callId } = setup();
    mdt.openForm('report', reportInit(callId));
    mdt.setAssertions(['detention:1', 'miranda:1']);
    const draft = mdt.submitForm(false);
    const id = draft.doc?.id ?? '';
    mdt.cancelForm();
    mdt.openForm('report', reportInit(callId), {}, id);
    expect(mdt.formAssertions()).toEqual(['detention:1', 'miranda:1']);
    mdt.submitForm(true);
    expect(submitted).toEqual([{ docId: id, callId, ids: ['detention:1', 'miranda:1'] }]);
  });

  it('skips the submit for a report without a call, an incident without statements, or without the feed', () => {
    const noCall = setup();
    noCall.mdt.openForm('report', reportInit(null));
    noCall.mdt.submitForm(true);
    expect(noCall.submitted).toEqual([]);

    const none = setup({ reportChoices: () => [] });
    none.mdt.openForm('report', reportInit(none.callId));
    none.mdt.submitForm(true);
    expect(none.submitted).toEqual([]);

    const f = fixture();
    const call = addCall(f.cad, 1, 2);
    const plain = new MdtOverlay(null, f.deps); // Phase 4 deps: no statements, no submit
    plain.openForm('report', reportInit(call.id));
    expect(plain.submitForm(true).errors).toEqual([]);
  });

  it('only reports use the statements: a citation finalize never calls submitReport', () => {
    const { mdt, submitted } = setup();
    mdt.openForm('evidence', { callId: null, description: 'Bag of pills', category: 'drugs', foundAt: 'Oak Street' });
    mdt.submitForm(true);
    expect(submitted).toEqual([]);
  });

  it('refreshes the Reports tab when the viewed report gets its grade', () => {
    let grade: ReportGradeView | null = null;
    const { mdt, callId } = setup({ reportGrade: () => grade });
    mdt.open('reports');
    mdt.openForm('report', reportInit(callId));
    const doc = mdt.submitForm(true).doc;
    expect(doc).not.toBeNull();
    mdt.viewDocument(doc?.id ?? '');
    mdt.update(1000);
    const before = mdt.refreshes;
    mdt.update(1000 + MDT_REFRESH_MS * 2);
    expect(mdt.refreshes).toBe(before); // nothing changed
    grade = { score: 90, letter: 'A', missing: [], contradictions: [], unsupported: [] };
    mdt.update(1000 + MDT_REFRESH_MS * 4);
    expect(mdt.refreshes).toBe(before + 1);
    mdt.update(1000 + MDT_REFRESH_MS * 6);
    expect(mdt.refreshes).toBe(before + 1);
  });
});

describe('Career and Community tabs (headless)', () => {
  function setup(): { mdt: MdtOverlay; feed: ReturnType<typeof careerFeed> } {
    const f = fixture();
    const feed = careerFeed();
    return { mdt: new MdtOverlay(null, { ...f.deps, career: feed.career, community: feed.community }), feed };
  }

  it('builds the career sections when the tab is shown and only again when the revision or game minute changes', () => {
    const { mdt, feed } = setup();
    expect(mdt.careerSections).toBeNull();
    mdt.open('career');
    mdt.update(1000);
    const first = mdt.careerSections;
    expect(first?.sections.length).toBeGreaterThan(0);
    const refreshes = mdt.refreshes;
    mdt.update(1000 + MDT_REFRESH_MS * 2);
    expect(mdt.refreshes).toBe(refreshes);
    expect(mdt.careerSections).toBe(first);

    feed.state.rev++;
    mdt.update(1000 + MDT_REFRESH_MS * 4);
    expect(mdt.refreshes).toBe(refreshes + 1);
    expect(mdt.careerSections).not.toBe(first);

    feed.state.game += 61; // the calendar countdown moved a minute
    mdt.update(1000 + MDT_REFRESH_MS * 6);
    expect(mdt.refreshes).toBe(refreshes + 2);
  });

  it('shows the hearings and the ATTEND action from the feed', () => {
    const { mdt, feed } = setup();
    feed.state.cases = [courtCase({ hearingGame: feed.state.game + 1800 })];
    feed.state.attendable.add('CR-0001');
    mdt.open('career');
    mdt.update(1000);
    const cal = mdt.careerSections?.sections.find((s) => s.id === 'calendar');
    expect(cal?.lines[0]?.action).toEqual({ kind: 'attend', id: 'CR-0001' });
    expect(mdt.attendCase('CR-0001')).toBe(true);
    expect(feed.calls.attend).toEqual(['CR-0001']);
    expect(mdt.message).toBe('Attending CR-0001');
  });

  it('refuses ATTEND when the hearing is not open, and REVIEW on closed or unknown IA cases', () => {
    const { mdt, feed } = setup();
    feed.state.cases = [courtCase()];
    expect(mdt.attendCase('CR-0001')).toBe(false);
    expect(feed.calls.attend).toEqual([]);
    expect(mdt.messageIsError).toBe(true);
    feed.state.view = careerView({ ia: [iaCase({ id: 'IA-0001' }), iaCase({ id: 'IA-0002', status: 'closed', finding: 'sustained' })] });
    expect(mdt.reviewIa('IA-0001')).toBe(true);
    expect(mdt.reviewIa('IA-0002')).toBe(true); // closed cases are read-only in the app
    expect(mdt.reviewIa('IA-0009')).toBe(false);
    expect(feed.calls.ia).toEqual(['IA-0001', 'IA-0002']);
  });

  it('reviews a recorded incident when its record is on file', () => {
    const { mdt, feed } = setup();
    feed.state.onFile.add('C-00009');
    expect(mdt.reviewIncident('C-00009')).toBe(true);
    expect(mdt.reviewIncident('C-00001')).toBe(false);
    expect(feed.calls.review).toEqual(['C-00009']);
  });

  it('builds the community rows and refreshes them on their own revision', () => {
    const { mdt, feed } = setup();
    mdt.open('community');
    mdt.update(1000);
    expect(mdt.communityRows.map((r) => r.label)).toEqual(['Suburbs', 'Downtown']);
    expect(mdt.communityRows.map((r) => r.band)).toEqual(['high', 'low']);
    const refreshes = mdt.refreshes;
    mdt.update(1000 + MDT_REFRESH_MS * 2);
    expect(mdt.refreshes).toBe(refreshes);
    feed.state.communityRev++;
    mdt.update(1000 + MDT_REFRESH_MS * 4);
    expect(mdt.refreshes).toBe(refreshes + 1);
  });

  it('works without the Phase 5 feeds', () => {
    const f = fixture();
    const mdt = new MdtOverlay(null, f.deps);
    mdt.open('career');
    mdt.update(1000);
    expect(mdt.careerSections).toBeNull();
    expect(mdt.attendCase('CR-0001')).toBe(false);
    expect(mdt.reviewIa('IA-0001')).toBe(false);
    mdt.setTab('community');
    mdt.update(2000);
    expect(mdt.communityRows).toEqual([]);
  });
});
