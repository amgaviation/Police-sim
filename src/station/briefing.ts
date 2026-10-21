/** The roll-call briefing sheet (design §11.1): a pure function of its input. */
import { hash3 } from '../records/hash';
import { formatDate, epochDayOfGameSeconds } from '../records/calendar';
import type { Bolo } from '../records/bolo';
import { BRIEFING_DATA } from './data';

export interface BriefingInput {
  seed: number;
  gameSeconds: number;
  officer: { name: string; badge: string };
  unit: { callsign: string; beat: string };
  /** District name (`DISTRICT_NAMES`) the shift starts in. */
  district: string;
  bolos: readonly Bolo[];
  openCalls: readonly { number: string; label: string; priority: number; location: string }[];
  roster: readonly { callsign: string; beat: string; status: string }[];
  crime: readonly { category: string; weight: number }[];
  /** Street named in the district notes; the unit's beat when absent. */
  street?: string;
}

export interface BriefingView {
  title: string;
  date: string;
  assignment: string;
  sections: { heading: string; lines: string[] }[];
}

export const BRIEFING_MAX_BOLOS = 6;
export const BRIEFING_MAX_CALLS = 5;
export const BRIEFING_MAX_UNITS = 12;
/** District notes shown (of the district's 3-5 templates), before the general reminder. */
export const BRIEFING_DISTRICT_NOTES = 3;

function fill(template: string, street: string, district: string): string {
  return template.split('{street}').join(street).split('{district}').join(district);
}

/** The briefing: Assignment, BOLOs (<= 6), District notes, Crime trends (top 3 by weight), Open calls (<= 5), Units on duty. */
export function buildBriefing(input: BriefingInput): BriefingView {
  const street = input.street ?? input.unit.beat;
  const day = epochDayOfGameSeconds(input.gameSeconds);

  const assignment: string[] = [
    `${input.officer.name}, badge ${input.officer.badge}`,
    `Unit ${input.unit.callsign}, ${input.unit.beat}`,
    `District: ${input.district}`,
  ];

  const bolos = input.bolos.slice(0, BRIEFING_MAX_BOLOS).map((b) => `${b.id}: ${b.text}`);
  if (bolos.length === 0) bolos.push('No active bulletins.');

  // District notes: a day-dependent window over the district's templates, then one general reminder.
  const templates = BRIEFING_DATA.districts[input.district] ?? [];
  const notes: string[] = [];
  const count = Math.min(BRIEFING_DISTRICT_NOTES, templates.length);
  const start = templates.length === 0 ? 0 : hash3(input.seed, 0xb71f, day) % templates.length;
  for (let k = 0; k < count; k++) notes.push(fill(templates[(start + k) % templates.length] ?? '', street, input.district));
  const general = BRIEFING_DATA.general;
  const reminder = general[general.length === 0 ? 0 : hash3(input.seed, 0xb720, day) % general.length];
  if (reminder !== undefined) notes.push(fill(reminder, street, input.district));

  // Crime trends: the three heaviest categories (ties keep input order), as a share of the total weight.
  const total = input.crime.reduce((s, c) => s + Math.max(0, c.weight), 0);
  const trends = input.crime
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.weight - a.c.weight || a.i - b.i)
    .slice(0, 3)
    .map(({ c }) => `${c.category}: ${String(total > 0 ? Math.round((Math.max(0, c.weight) / total) * 100) : 0)}% of recent reports`);
  if (trends.length === 0) trends.push('No notable trends.');

  // Open calls: most urgent first (ties keep input order).
  const calls = input.openCalls
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
    .slice(0, BRIEFING_MAX_CALLS)
    .map(({ c }) => `${c.number} P${String(c.priority)} ${c.label}, ${c.location}`);
  if (calls.length === 0) calls.push('No calls holding.');

  const units = input.roster.slice(0, BRIEFING_MAX_UNITS).map((u) => `${u.callsign}  ${u.beat}  ${u.status}`);
  if (units.length === 0) units.push('No other units on duty.');

  return {
    title: 'Roll call',
    date: formatDate(day),
    assignment: `${input.unit.callsign} / ${input.unit.beat}`,
    sections: [
      { heading: 'Assignment', lines: assignment },
      { heading: 'BOLOs', lines: bolos },
      { heading: 'District notes', lines: notes },
      { heading: 'Crime trends', lines: trends },
      { heading: 'Open calls', lines: calls },
      { heading: 'Units on duty', lines: units },
    ],
  };
}
