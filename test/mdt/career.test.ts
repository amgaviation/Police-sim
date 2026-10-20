import { describe, expect, it } from 'vitest';
import {
  CAREER_LIST_MAX,
  careerModel,
  communityModel,
  districtLabel,
  dutyText,
  formatUntil,
  trendArrow,
  type CareerSection,
} from '../../src/ui/mdt';
import { formatStamp } from '../../src/records/calendar';
import { at } from './helpers';
import { careerView, courtCase, iaCase } from './phase5';

const now = at(0);
const section = (m: ReturnType<typeof careerModel>, id: CareerSection['id']): CareerSection => {
  const s = m.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};

describe('formatUntil', () => {
  it('reads minutes and hours, now and overdue', () => {
    expect(formatUntil(80 * 60)).toBe('in 1 h 20 min');
    expect(formatUntil(60 * 60)).toBe('in 1 h');
    expect(formatUntil(45 * 60)).toBe('in 45 min');
    expect(formatUntil(20)).toBe('now');
    expect(formatUntil(-20)).toBe('now');
    expect(formatUntil(-12 * 60)).toBe('overdue 12 min');
    expect(formatUntil(Number.NaN)).toBe('');
  });
});

describe('dutyText', () => {
  it('shows the end of a suspension only when there is one', () => {
    expect(dutyText('active', 0)).toBe('ON DUTY');
    expect(dutyText('suspended', 90000)).toBe(`SUSPENDED until ${formatStamp(90000)}`);
    expect(dutyText('suspended', 0)).toBe('SUSPENDED');
    expect(dutyText('adminLeave', 90000)).toContain('ADMINISTRATIVE LEAVE until');
    expect(dutyText('terminated', 90000)).toBe('TERMINATED');
  });
});

describe('careerModel', () => {
  it('lists the sections in order and handles an empty career', () => {
    const m = careerModel(careerView(), [], now);
    expect(m.sections.map((s) => s.id)).toEqual(['duty', 'calendar', 'cases', 'ia', 'commendations', 'discipline', 'reports', 'stats']);
    for (const s of m.sections) expect(s.title).not.toBe('');
    expect(section(m, 'calendar').lines).toEqual([]);
    expect(section(m, 'calendar').empty).toBe('No hearings scheduled');
    expect(section(m, 'ia').empty).not.toBe('');
    const duty = section(m, 'duty').lines;
    expect(duty[0]).toMatchObject({ label: 'Status', text: 'ON DUTY', severity: 'none' });
    expect(duty.find((l) => l.label === 'Credibility')?.text).toBe('85 %');
    expect(duty.find((l) => l.label === 'Points')?.text).toBe('12');
    expect(duty.some((l) => l.label === 'Jurisdiction')).toBe(false);
  });

  it('shows the jurisdiction, a suspension with its reason and a low credibility in alert', () => {
    const m = careerModel(
      careerView({ status: 'suspended', statusUntilGame: 90000, statusReason: 'IA-0001', credibility: 0.4 }),
      [],
      now,
      { jurisdiction: { id: 'strict', name: 'Strict Code' } },
    );
    const duty = section(m, 'duty').lines;
    expect(duty[0]?.severity).toBe('caution');
    expect(duty[0]?.text).toContain('SUSPENDED until');
    expect(duty.find((l) => l.label === 'Reason')?.text).toBe('IA-0001');
    expect(duty.find((l) => l.label === 'Jurisdiction')?.text).toBe('Strict Code (strict)');
    expect(duty.find((l) => l.label === 'Credibility')).toMatchObject({ text: '40 %', severity: 'alert' });
    expect(careerModel(careerView({ status: 'terminated' }), [], now).sections[0]?.lines[0]?.severity).toBe('alert');
  });

  it('puts scheduled hearings soonest first with an ATTEND action only where canAttend says so', () => {
    const cases = [
      courtCase({ id: 'CR-0002', hearingGame: now.game + 7200, personLabel: 'ROE, RICK' }),
      courtCase({ id: 'CR-0001', hearingGame: now.game + 4800 }),
      courtCase({ id: 'CR-0003', status: 'closed', hearingGame: now.game + 100, verdict: 'convicted' }),
      courtCase({ id: 'CR-0004', status: 'pleaded', hearingGame: -1, verdict: 'convicted', reason: 'plea' }),
    ];
    const m = careerModel(careerView(), cases, now, { canAttend: (id) => id === 'CR-0001' });
    const cal = section(m, 'calendar').lines;
    expect(cal.map((l) => l.text.split(' ')[0])).toEqual(['CR-0001', 'CR-0002']);
    expect(cal[0]?.label).toBe(formatStamp(now.game + 4800));
    expect(cal[0]?.text).toContain('in 1 h 20 min');
    expect(cal[0]?.action).toEqual({ kind: 'attend', id: 'CR-0001' });
    expect(cal[1]?.action).toBeUndefined();
    // Without canAttend nothing is attendable.
    for (const l of section(careerModel(careerView(), cases, now), 'calendar').lines) expect(l.action).toBeUndefined();
  });

  it('lists cases with status and verdict, dismissals for misconduct and missed hearings in alert', () => {
    const cases = [
      courtCase({ id: 'CR-0005', status: 'closed', verdict: 'dismissed', reason: 'suppression' }),
      courtCase({ id: 'CR-0004', status: 'missed', verdict: 'dismissed', reason: 'missed' }),
      courtCase({ id: 'CR-0003', status: 'closed', verdict: 'acquitted', reason: 'reasonableDoubt' }),
      courtCase({ id: 'CR-0002', status: 'pleaded', verdict: 'convicted', reason: 'plea', hearingGame: -1 }),
      courtCase({ id: 'CR-0001' }),
    ];
    const lines = section(careerModel(careerView(), cases, now), 'cases').lines;
    expect(lines.map((l) => l.label)).toEqual(['CR-0005', 'CR-0004', 'CR-0003', 'CR-0002', 'CR-0001']);
    expect(lines.map((l) => l.severity)).toEqual(['alert', 'alert', 'caution', 'none', 'none']);
    expect(lines[0]?.text).toContain('dismissed (suppression)');
    expect(lines[3]?.text).toContain('pleaded');
    expect(lines[4]?.text).toContain('hearing scheduled');
  });

  it('offers REVIEW only on open IA cases, newest first', () => {
    const view = careerView({
      ia: [
        iaCase({ id: 'IA-0001', status: 'closed', finding: 'sustained', closedGame: 60000 }),
        iaCase({ id: 'IA-0002', triggers: [{ rule: 'failureToIntervene', severity: 'critical', eventIds: [] }], severity: 'critical' }),
      ],
    });
    const lines = section(careerModel(view, [], now), 'ia').lines;
    expect(lines.map((l) => l.label)).toEqual(['IA-0002', 'IA-0001']);
    expect(lines[0]?.action).toEqual({ kind: 'review', id: 'IA-0002' });
    expect(lines[0]?.text).toContain('Failure to intervene');
    expect(lines[0]?.severity).toBe('caution');
    expect(lines[1]?.action).toBeUndefined();
    expect(lines[1]?.text).toContain('SUSTAINED');
    expect(lines[1]?.severity).toBe('alert');
  });

  it('lists commendations, discipline and graded reports newest first', () => {
    const view = careerView({
      commendations: [
        { id: 'deEscalation', label: 'De-escalation', key: 'C-00001', game: 51000, points: 3 },
        { id: 'lifesaving', label: 'Lifesaving', key: 'C-00002', game: 52000, points: 5 },
      ],
      discipline: [
        { action: 'suspension', hours: 24, amount: 0, caseId: 'IA-0001', game: 53000 },
        { action: 'civilSuit', hours: 0, amount: 50000, caseId: 'IA-0001', game: 53000 },
      ],
      reports: [
        { docId: 'R-0001', key: 'C-00001', score: 91, letter: 'A', completeness: 1, missing: [], contradictions: [], unsupported: [], game: 51000 },
        { docId: 'R-0002', key: 'C-00002', score: 55.4, letter: 'F', completeness: 0.4, missing: [], contradictions: [], unsupported: [], game: 52000 },
      ],
    });
    const m = careerModel(view, [], now);
    const com = section(m, 'commendations').lines;
    expect(com[0]?.text).toBe('Lifesaving (C-00002) +5');
    expect(section(m, 'discipline').lines.map((l) => l.text)).toEqual(['Civil suit $50000 (IA-0001)', 'Suspension 24 h (IA-0001)']);
    const rep = section(m, 'reports').lines;
    expect(rep[0]).toMatchObject({ label: 'R-0002', text: '55 (F) · C-00002', severity: 'alert' });
    expect(rep[1]).toMatchObject({ label: 'R-0001', severity: 'none' });
    expect(section(m, 'stats').lines.find((l) => l.label === 'Reports filed')?.text).toBe('4 (average 82)');
  });

  it('caps each list', () => {
    const cases = Array.from({ length: 30 }, (_, i) => courtCase({ id: `CR-${String(i + 1).padStart(4, '0')}`, hearingGame: now.game + 60 * (i + 1) }));
    const m = careerModel(careerView(), cases, now, { canAttend: () => true });
    expect(section(m, 'cases').lines).toHaveLength(CAREER_LIST_MAX);
    expect(section(m, 'calendar').lines).toHaveLength(CAREER_LIST_MAX);
  });
});

describe('communityModel', () => {
  it('builds one row per district with bar positions, percent text, arrows and colour bands', () => {
    const rows = communityModel([
      { district: 'suburbs', value: 0.62, baseline: 0.6, trend: 0.02 },
      { district: 'industrialPark', value: 0.25, baseline: 0.45, trend: -0.03 },
      { district: 'downtown', value: 0.4, baseline: 0.4, trend: 0.004 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['Suburbs', 'Industrial park', 'Downtown']);
    expect(rows.map((r) => r.percent)).toEqual(['62 %', '25 %', '40 %']);
    expect(rows.map((r) => r.fillPct)).toEqual([62, 25, 40]);
    expect(rows.map((r) => r.baselinePct)).toEqual([60, 45, 40]);
    expect(rows.map((r) => r.arrow)).toEqual(['▲', '▼', '–']);
    expect(rows.map((r) => r.trendText)).toEqual(['+2', '-3', '0']);
    expect(rows.map((r) => r.band)).toEqual(['high', 'low', 'mid']);
  });

  it('draws the colour band thresholds at 0.3 and 0.5 and the arrows at plus/minus 0.01', () => {
    const band = (v: number): string => communityModel([{ district: 'a', value: v, baseline: 0.5, trend: 0 }])[0]?.band ?? '';
    expect(band(0.299)).toBe('low');
    expect(band(0.3)).toBe('mid');
    expect(band(0.499)).toBe('mid');
    expect(band(0.5)).toBe('high');
    expect(trendArrow(0.01)).toBe('▲');
    expect(trendArrow(0.0099)).toBe('–');
    expect(trendArrow(-0.01)).toBe('▼');
    expect(trendArrow(-0.0099)).toBe('–');
    expect(trendArrow(0)).toBe('–');
  });

  it('clamps out-of-range values and keeps the input order', () => {
    const rows = communityModel([
      { district: 'b', value: 1.4, baseline: -0.2, trend: 0 },
      { district: 'a', value: Number.NaN, baseline: 0.5, trend: 0 },
    ]);
    expect(rows.map((r) => r.district)).toEqual(['b', 'a']);
    expect(rows[0]?.fillPct).toBe(100);
    expect(rows[0]?.baselinePct).toBe(0);
    expect(rows[1]?.fillPct).toBe(0);
    expect(communityModel([])).toEqual([]);
  });

  it('labels districts', () => {
    expect(districtLabel('suburbs')).toBe('Suburbs');
    expect(districtLabel('industrialPark')).toBe('Industrial park');
    expect(districtLabel('')).toBe('Unknown');
  });
});
