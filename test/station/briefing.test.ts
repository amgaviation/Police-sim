import { describe, expect, it } from 'vitest';
import { dailyBolos } from '../../src/records/bolo';
import { epochDayOfGameSeconds } from '../../src/records/calendar';
import { BRIEFING_DATA } from '../../src/station/data';
import { buildBriefing, type BriefingInput } from '../../src/station/briefing';
import { DISTRICT_NAMES } from '../../src/world/ids';

const SEED = 42;
const GAME = 6 * 3600;

function input(over: Partial<BriefingInput> = {}): BriefingInput {
  return {
    seed: SEED,
    gameSeconds: GAME,
    officer: { name: 'Alex Rivera', badge: '4417' },
    unit: { callsign: '12-A', beat: 'Beat 4' },
    district: 'downtown',
    bolos: dailyBolos(SEED, epochDayOfGameSeconds(GAME)),
    openCalls: [
      { number: 'C-00003', label: 'Noise complaint', priority: 4, location: '100 Main St' },
      { number: 'C-00001', label: 'Burglary alarm', priority: 2, location: '9 Oak Ave' },
      { number: 'C-00002', label: 'Welfare check', priority: 3, location: '5 Pine Rd' },
    ],
    roster: [
      { callsign: '12-B', beat: 'Beat 5', status: '10-8' },
      { callsign: '12-C', beat: 'Beat 6', status: '10-6' },
    ],
    crime: [
      { category: 'theft', weight: 3 },
      { category: 'assault', weight: 5 },
      { category: 'vandalism', weight: 1 },
      { category: 'dui', weight: 4 },
    ],
    ...over,
  };
}

describe('briefing data', () => {
  it('has 3-5 notes for every district and generic safety reminders', () => {
    for (const d of DISTRICT_NAMES) {
      const notes = BRIEFING_DATA.districts[d];
      expect(notes, d).toBeDefined();
      expect(notes?.length, d).toBeGreaterThanOrEqual(3);
      expect(notes?.length, d).toBeLessThanOrEqual(5);
    }
    expect(BRIEFING_DATA.general.length).toBeGreaterThan(0);
  });
});

describe('buildBriefing', () => {
  it('has the six sections in order', () => {
    const v = buildBriefing(input());
    expect(v.title).toBe('Roll call');
    expect(v.assignment).toBe('12-A / Beat 4');
    expect(v.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(v.sections.map((s) => s.heading)).toEqual(['Assignment', 'BOLOs', 'District notes', 'Crime trends', 'Open calls', 'Units on duty']);
    expect(v.sections[0]?.lines.join(' ')).toContain('Alex Rivera');
    expect(v.sections[0]?.lines.join(' ')).toContain('12-A');
  });

  it('is deterministic from its input', () => {
    expect(buildBriefing(input())).toEqual(buildBriefing(input()));
    const other = buildBriefing(input({ seed: 7 }));
    expect(other.sections.map((s) => s.heading)).toEqual(buildBriefing(input()).sections.map((s) => s.heading));
  });

  it('lists the daily BOLOs (at most six)', () => {
    const day = epochDayOfGameSeconds(GAME);
    const bolos = dailyBolos(SEED, day);
    const v = buildBriefing(input());
    const lines = v.sections[1]?.lines ?? [];
    if (bolos.length > 0) {
      expect(lines).toHaveLength(Math.min(6, bolos.length));
      expect(lines[0]).toContain(bolos[0]?.text ?? '?');
    }
    const many = Array.from({ length: 9 }, (_, i) => ({ ...(bolos[0] ?? { id: 'B', day, kind: 'vehicle' as const, vehicleId: 1, personId: -1, text: 't' }), id: `BOLO-${String(i)}` }));
    expect(buildBriefing(input({ bolos: many })).sections[1]?.lines).toHaveLength(6);
    expect(buildBriefing(input({ bolos: [] })).sections[1]?.lines).toEqual(['No active bulletins.']);
  });

  it('fills district notes from the data without leftover placeholders', () => {
    for (const d of DISTRICT_NAMES) {
      const v = buildBriefing(input({ district: d, street: 'Maple Avenue' }));
      const lines = v.sections[2]?.lines ?? [];
      expect(lines.length, d).toBe(4);
      for (const l of lines) {
        expect(l, d).not.toMatch(/[{}]/);
        expect(l.length).toBeGreaterThan(0);
      }
    }
    const downtown = buildBriefing(input({ district: 'downtown', street: 'Maple Avenue' })).sections[2]?.lines.join('\n') ?? '';
    const templates = BRIEFING_DATA.districts['downtown'] ?? [];
    const filled = templates.map((t) => t.split('{street}').join('Maple Avenue').split('{district}').join('downtown'));
    expect(filled.some((f) => downtown.includes(f))).toBe(true);
  });

  it('falls back to the beat for {street} and tolerates an unknown district', () => {
    const v = buildBriefing(input({ district: 'nowhere' }));
    expect(v.sections[2]?.lines).toHaveLength(1);
    expect(buildBriefing(input({ district: 'suburbs' })).sections[2]?.lines.join(' ')).not.toContain('{');
  });

  it('shows the top three crime trends by weight', () => {
    const lines = buildBriefing(input()).sections[3]?.lines ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^assault: 38%/);
    expect(lines[1]).toMatch(/^dui: 31%/);
    expect(lines[2]).toMatch(/^theft: 23%/);
    expect(buildBriefing(input({ crime: [] })).sections[3]?.lines).toEqual(['No notable trends.']);
  });

  it('lists open calls by priority, at most five', () => {
    const v = buildBriefing(input());
    expect(v.sections[4]?.lines).toEqual([
      'C-00001 P2 Burglary alarm, 9 Oak Ave',
      'C-00002 P3 Welfare check, 5 Pine Rd',
      'C-00003 P4 Noise complaint, 100 Main St',
    ]);
    const many = Array.from({ length: 8 }, (_, i) => ({ number: `C-${String(i)}`, label: 'x', priority: 3, location: 'y' }));
    expect(buildBriefing(input({ openCalls: many })).sections[4]?.lines).toHaveLength(5);
    expect(buildBriefing(input({ openCalls: [] })).sections[4]?.lines).toEqual(['No calls holding.']);
  });

  it('lists the units on duty', () => {
    const lines = buildBriefing(input()).sections[5]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('12-B');
    expect(lines[0]).toContain('10-8');
    expect(buildBriefing(input({ roster: [] })).sections[5]?.lines).toEqual(['No other units on duty.']);
  });
});
