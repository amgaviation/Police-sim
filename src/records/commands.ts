import type { Command } from '../debug/console';
import { REGISTRY_POPULATION, vehicleRecord } from '../traffic/registry';
import { formatDate } from './calendar';
import type { PersonSummary, RecordsDb } from './db';
import { displayName, type PersonRecord } from './person';
import { PLATE_FLAG, PLATE_FLAG_NAMES, canBeOnRoad, mountedPlate, plateFlags, vehicleDescription, type PlateFlagName } from './vehicle';

/** Debug console commands of the records module: person, runplate, vin, dl, platestates, bolos. */

/** Cars listed per state by `platestates` without a count. */
const PLATE_STATES_DEFAULT = 3;
const PLATE_STATES_MAX = 50;

function need<T>(value: T | null): T {
  if (value === null) throw new Error('No game running');
  return value;
}

function personLines(p: PersonRecord, hits: readonly string[]): string {
  const lines = [
    `${displayName(p)}  #${p.id}  ${p.sex}  DOB ${formatDate(p.dob)}  ${p.heightCm} cm ${p.weightKg} kg  eyes ${p.eyes}  hair ${p.hair}`,
    `  address  ${p.address}   phone ${p.phone}`,
    p.license.status === 'none'
      ? '  license  NONE'
      : `  license  ${p.license.number} class ${p.license.cls} ${p.license.status.toUpperCase()} exp ${formatDate(p.license.expires)}`,
  ];
  for (const w of p.warrants) lines.push(`  warrant  ${w.id} ${w.offense} - ${w.court} - bail $${w.bail} (issued ${formatDate(w.issued)})`);
  if (p.supervision.kind !== 'none') {
    lines.push(`  ${p.supervision.kind.padEnd(8)} ${p.supervision.agent} until ${formatDate(p.supervision.until)}: ${p.supervision.conditions.join(', ')}`);
  }
  if (p.gang) lines.push(`  gang     ${p.gang.name} (${p.gang.role})`);
  if (p.mentalHealth !== null) lines.push(`  mental   ${p.mentalHealth}`);
  for (const n of p.officerSafety) lines.push(`  safety   ${n}`);
  for (const f of p.firearms) lines.push(`  firearm  ${f.type} ${f.serial} (${formatDate(f.registered)})`);
  for (const o of p.protectiveOrders) lines.push(`  order    protects #${o.protectedId}: ${o.conditions.join(', ')} until ${formatDate(o.expires)}`);
  for (const c of p.priors) lines.push(`  prior    ${formatDate(c.day)} ${c.kind}: ${c.summary}${c.location === '' ? '' : ` @ ${c.location}`}${c.ref === '' ? '' : ` [${c.ref}]`}`);
  lines.push(hits.length === 0 ? '  hits     none' : `  hits     ${hits.join(' | ')}`);
  return lines.join('\n');
}

function summaryLine(s: PersonSummary): string {
  return `${String(s.personId).padEnd(6)} ${s.name.padEnd(28)} ${s.dob}  ${s.dl.padEnd(9)} ${s.dlStatus.padEnd(9)} ${s.severity}${s.hits.length > 0 ? ` (${s.hits.length} hits)` : ''}`;
}

/** Console commands over the running game's records; `records()` / `seed()` return null without a game. */
export function createRecordsCommands(deps: { records(): RecordsDb | null; seed(): number | null }): Command[] {
  const db = (): RecordsDb => need(deps.records());

  const showPerson = (records: RecordsDb, id: number): string => {
    const p = records.person(id);
    return personLines(p, records.personSummary(id).hits);
  };

  return [
    {
      name: 'person',
      description: 'Show a person record by id, or search by last [first] name',
      usage: '<id> | <last> [first]',
      run(args) {
        const records = db();
        const first = args[0];
        if (first === undefined) throw new Error('Usage: person <id> | <last> [first]');
        if (/^\d+$/.test(first)) {
          const id = Number(first);
          return showPerson(records, id);
        }
        const found = records.findPersons({ last: first, first: args[1] });
        if (found.length === 0) return `No persons match ${args.join(' ')}`;
        return found.map(summaryLine).join('\n');
      },
    },
    {
      name: 'runplate',
      description: 'Run a plate against the records (no observed vehicle)',
      usage: '<ABC 1234>',
      run(args) {
        const records = db();
        if (args.length === 0) throw new Error('Usage: runplate <ABC 1234>');
        const r = records.runPlate(args.join(' '));
        if (!r.found || !r.registration || !r.owner) return `${r.plate}: NO RECORD`;
        const reg = r.registration;
        return [
          `${reg.plate}  vehicle #${reg.vehicleId}  ${vehicleDescription(reg)}  VIN ${reg.vin}`,
          `  RO       ${displayName(r.owner)} #${r.owner.id}   reg exp ${formatDate(reg.expires)}   ${reg.insured ? `insured: ${reg.insurer}` : 'uninsured'}`,
          `  flags    ${PLATE_FLAG_NAMES.filter((k) => (r.flags & PLATE_FLAG[k]) !== 0).join(', ') || 'none'}`,
          r.hits.length === 0 ? '  hits     none' : `  hits     ${r.hits.map((h) => h.text).join(' | ')}`,
        ].join('\n');
      },
    },
    {
      name: 'vin',
      description: 'Run a VIN against the records',
      usage: '<VIN>',
      run(args) {
        const records = db();
        const vin = args[0];
        if (vin === undefined) throw new Error('Usage: vin <VIN>');
        const r = records.runVin(vin);
        if (!r.registration) return `${r.vin}: NO RECORD`;
        const reg = r.registration;
        return `${reg.vin}  vehicle #${reg.vehicleId}  ${vehicleDescription(reg)}  plate ${reg.plate}  RO #${reg.ownerId}\n` +
          (r.hits.length === 0 ? '  hits     none' : `  hits     ${r.hits.map((h) => h.text).join(' | ')}`);
      },
    },
    {
      name: 'dl',
      description: 'Look up a person by driver licence number',
      usage: '<D1234567>',
      run(args) {
        const records = db();
        const dl = args[0];
        if (dl === undefined) throw new Error('Usage: dl <D1234567>');
        const found = records.findPersons({ dl });
        const s = found[0];
        if (!s) return `${dl.toUpperCase()}: NO RECORD`;
        return showPerson(records, s.personId);
      },
    },
    {
      name: 'platestates',
      description: 'List the first cars (ids ascending) in each plate state, for testing plate runs',
      usage: '[n]',
      run(args) {
        const seed = need(deps.seed());
        const n = args[0] === undefined ? PLATE_STATES_DEFAULT : Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > PLATE_STATES_MAX) throw new Error(`Usage: platestates [n]  (1 to ${PLATE_STATES_MAX})`);
        const found = new Map<PlateFlagName, string[]>(PLATE_FLAG_NAMES.map((k) => [k, []]));
        let scanned = 0;
        for (let id = 0; id < REGISTRY_POPULATION; id++) {
          scanned = id + 1;
          // Only cars that can be on the road (plateFlags describes those).
          if (!canBeOnRoad(seed, id)) continue;
          const flags = plateFlags(seed, id);
          if (flags !== 0) {
            const mp = mountedPlate(seed, id);
            for (const k of PLATE_FLAG_NAMES) {
              const list = found.get(k) ?? [];
              if ((flags & PLATE_FLAG[k]) === 0 || list.length >= n) continue;
              const note = k === 'stolen' ? (vehicleRecord(seed, id).stolen ? ' stolen vehicle' : ' stolen plate') : '';
              list.push(`#${id} ${mp.plate}${mp.anomaly === 'none' ? '' : ` (${mp.anomaly} from #${mp.plateVehicleId})`}${note}`);
            }
          }
          if ([...found.values()].every((l) => l.length >= n)) break;
        }
        const lines = PLATE_FLAG_NAMES.map((k) => `${k.padEnd(11)} ${(found.get(k) ?? []).join(', ') || '-'}`);
        lines.push(`(scanned ${scanned} vehicles)`);
        return lines.join('\n');
      },
    },
    {
      name: 'bolos',
      description: "List today's BOLO bulletin and added BOLOs",
      run() {
        const records = db();
        const day = records.today();
        const list = records.bolos(day);
        if (list.length === 0) return `No BOLOs for ${formatDate(day)}`;
        return [`BOLOs ${formatDate(day)}`, ...list.map((b) => `  ${b.id.padEnd(16)} ${b.kind.padEnd(7)} ${b.text}`)].join('\n');
      },
    },
  ];
}
