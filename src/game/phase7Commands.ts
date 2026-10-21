import type { Command } from '../debug/console';
import { FLEET_DATA, FLEET_SERVICES, type FleetService, type FleetUnitDef } from '../fleet';
import { OFFICER_PRESETS } from '../gear';
import { exportLivery, importLivery, newLiveryId } from '../livery';
import {
  COLD_IDS,
  HAT_IDS,
  PRONOUN_PRESETS,
  UNIFORM_CLASSES,
  displayName,
  pronounLabel,
  type ColdId,
  type HatId,
  type UniformClass,
} from '../uniform';
import type { GameSession } from './session';

/**
 * Phase 7 console commands (design §20.4): `fleet`, `livery`, `gear` (alias `loadout`), `uniform`, `char`, `drone`, `wear`
 * and `hit`.
 */
export interface Phase7CommandDeps {
  session(): GameSession | null;
}

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

function pct(v: number): string {
  return `${String(Math.round(v * 100))}%`;
}

/** The unit a console argument names: a unit id, a fleet class or a vehicle model id (the first match in roster order). */
function resolveUnit(arg: string): FleetUnitDef | null {
  const a = arg.toLowerCase();
  return (
    FLEET_DATA.units.find((u) => u.id.toLowerCase() === a) ??
    FLEET_DATA.units.find((u) => u.cls === a || u.model === a) ??
    FLEET_DATA.units.find((u) => u.model.includes(a) || u.id.toLowerCase().startsWith(a)) ??
    null
  );
}

export function createPhase7Commands(deps: Phase7CommandDeps): Command[] {
  const session = (): GameSession => need(deps.session());

  /** The unit of the named argument, else of the vehicle the officer drives (or drove last). */
  const unitArg = (s: GameSession, arg: string | undefined): string => {
    if (arg !== undefined) {
      const def = resolveUnit(arg);
      if (!def) throw new Error(`No such unit '${arg}' (fleet list)`);
      return def.id;
    }
    const id = s.unitOf(s.drivenVehicle ?? s.lastVehicle);
    if (id === null) throw new Error('Name a unit (fleet list) or get into a fleet vehicle');
    return id;
  };

  const fleetList = (s: GameSession): string => {
    const rows = s.fleet.units().map((u) => {
      const out = u.spawned ? 'OUT' : 'yard';
      return `${u.id.padEnd(6)} ${u.label.padEnd(24)} ${u.cls.padEnd(10)} ${out.padEnd(5)} ${u.status.padEnd(8)} fuel ${pct(u.fuel).padStart(4)} oil ${pct(u.oil).padStart(4)} tread ${pct(u.tread).padStart(4)} damage ${pct(u.damage).padStart(4)}  ${u.liveryId}`;
    });
    const open = s.fleet.openReports();
    return `${rows.join('\n')}${open > 0 ? `\n${String(open)} damage incident(s) without a report` : ''}`;
  };

  const gearShow = (s: GameSession): string => {
    const g = s.gear;
    const v = g.validation;
    const lines = [`Loadout (${g.loadout.assignment}): ${g.loadout.items.map((i) => `${i.id}${i.count > 1 ? ` x${String(i.count)}` : ''}${i.retention ? ` L${String(i.retention)}` : ''}`).join(', ')}`];
    lines.push(`Weight ${v.weightKg.toFixed(1)} / ${v.capacityKg} kg; retention level ${String(g.retention())}; protection ${pct(g.protection())}`);
    lines.push(`Slots: ${Object.entries(v.slots).map(([k, u]) => `${k} ${String(u.used)}/${String(u.cap)}`).join(', ')}`);
    for (const e of v.errors) lines.push(`ERROR  ${e.message}`);
    for (const w of v.warnings) lines.push(`warn   ${w.message}`);
    if (v.errors.length === 0 && v.warnings.length === 0) lines.push('Loadout is valid');
    return lines.join('\n');
  };

  const gear: Command = {
    name: 'gear',
    description: 'Officer loadout: show, validate, preset <id>, retention <1-3>',
    usage: '[show | validate | preset <id> | retention <1-3>]',
    run: (args) => {
      const s = session();
      const sub = args[0] ?? 'show';
      if (sub === 'show') return gearShow(s);
      if (sub === 'validate') {
        const v = s.gear.validation;
        return v.errors.length === 0 ? `Valid${v.warnings.length > 0 ? ` (${String(v.warnings.length)} warning(s))` : ''}` : v.errors.map((e) => e.message).join('\n');
      }
      if (sub === 'preset') {
        const id = args[1];
        const preset = id === undefined ? undefined : OFFICER_PRESETS[id];
        if (id === undefined || preset === undefined) return `Usage: gear preset <${Object.keys(OFFICER_PRESETS).join(' | ')}>`;
        s.setGear(preset);
        return gearShow(s);
      }
      if (sub === 'retention') {
        const level = Number(args[1]);
        if (level !== 1 && level !== 2 && level !== 3) return 'Usage: gear retention <1|2|3>';
        const cur = s.gear.loadout;
        if (!cur.items.some((i) => i.id === 'holster')) return 'The loadout has no holster';
        s.setGear({ assignment: cur.assignment, items: cur.items.map((i) => (i.id === 'holster' ? { ...i, retention: level } : { ...i })) });
        return `Holster retention ${String(level)}`;
      }
      return 'Usage: gear [show | validate | preset <id> | retention <1-3>]';
    },
  };

  return [
    {
      name: 'fleet',
      description: 'The fleet: list, checkout <unit|class>, spawn <type>, checkin [unit], service <kind> [unit], inspect [unit], report <id>, endshift, ledger',
      usage: '[list | checkout <unit> | spawn <type> | checkin [unit] | service <refuel|oil|tires|repair|all> [unit] | inspect [unit] | report <id> | endshift | ledger]',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'list';
        if (sub === 'list') return fleetList(s);
        if (sub === 'checkout' || sub === 'spawn') {
          const arg = args[1];
          if (arg === undefined) return `Usage: fleet ${sub} <unit | class | model> (${FLEET_DATA.units.map((u) => u.id).join(', ')})`;
          const def = resolveUnit(arg);
          if (!def) return `No such unit '${arg}' (fleet list)`;
          return s.checkOut(def.id).message;
        }
        if (sub === 'checkin') return s.checkIn(unitArg(s, args[1])).message;
        if (sub === 'service') {
          const kind = args[1] as FleetService | undefined;
          if (kind === undefined || !FLEET_SERVICES.includes(kind)) return `Usage: fleet service <${FLEET_SERVICES.join(' | ')}> [unit]`;
          const id = unitArg(s, args[2]);
          const quote = s.fleet.quote(id, kind);
          if (!quote) return `${id} is in the yard: check it out first`;
          if (!s.unitInYard(id)) return `Bring ${id} to the yard to service it`;
          s.fleet.request({ kind: 'service', unitId: id, service: kind });
          return `Service ${kind} for ${id}: $${String(quote.total)}${quote.lines.length > 0 ? ` (${quote.lines.map((l) => l.label).join(', ')})` : ''}`;
        }
        if (sub === 'inspect') {
          const id = unitArg(s, args[1]);
          const input = s.inspectionInput(id);
          if (!input) return `${id} is in the yard: check it out first`;
          s.fleet.request({ kind: 'inspect', unitId: id, input });
          return `Inspection of ${id} queued (fleet list; the result is in the MDT career tab and the flash line)`;
        }
        if (sub === 'report') {
          const incident = Number(args[1]);
          if (!Number.isInteger(incident)) {
            const open = s.fleet.incidents().filter((i) => !i.reported && !i.charged);
            return open.length === 0 ? 'No damage incident without a report' : `Usage: fleet report <incident id> (open: ${open.map((i) => `#${String(i.id)} ${i.unitId}`).join(', ')})`;
          }
          s.fleet.request({ kind: 'report', incidentId: incident });
          return `Damage report #${String(incident)} filed`;
        }
        if (sub === 'endshift') {
          s.fleet.request({ kind: 'endShift' });
          return 'Shift ending: damage charges are applied to your career points';
        }
        if (sub === 'ledger') {
          const entries = s.fleet.ledger.entries();
          if (entries.length === 0) return 'The ledger is empty';
          return [
            ...entries.slice(-12).map((e) => `#${String(e.seq)} ${e.unitId.padEnd(6)} ${e.kind.padEnd(7)} $${String(e.cost).padStart(5)}  ${e.points !== 0 ? `${String(e.points)} pts  ` : ''}${e.note}`),
            `Department cost $${String(s.fleet.ledger.departmentCost)}; officer points ${String(s.fleet.ledger.officerPoints)}`,
          ].join('\n');
        }
        return 'Usage: fleet [list | checkout <unit> | spawn <type> | checkin [unit] | service <kind> [unit] | inspect [unit] | report <id> | endshift | ledger]';
      },
    },
    {
      name: 'livery',
      description: 'Liveries: list, apply <id> [unit], export [id], import \'<json>\' [unit]',
      usage: '[list | apply <id> [unit] | export [id] | import \'<json>\']',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'list';
        if (sub === 'list') {
          return s.fleet
            .library()
            .map((l) => `${l.id.padEnd(22)} ${l.name}${l.author ? ` (${l.author})` : ''}`)
            .join('\n');
        }
        if (sub === 'apply') {
          const id = args[1];
          if (id === undefined) return 'Usage: livery apply <id> [unit]';
          const doc = s.fleet.library().find((l) => l.id === id);
          if (!doc) return `No livery '${id}' (livery list)`;
          const unit = unitArg(s, args[2]);
          if (!s.assignLivery(unit, doc)) return 'The livery library is full';
          return `${unit} now wears ${doc.name}`;
        }
        if (sub === 'export') {
          const id = args[1];
          const doc = id === undefined ? s.fleet.livery(unitArg(s, undefined)) : s.fleet.library().find((l) => l.id === id);
          if (!doc) return `No livery '${id ?? ''}' (livery list)`;
          return exportLivery(doc).trimEnd();
        }
        if (sub === 'import') {
          const text = args[1];
          if (text === undefined) return "Usage: livery import '<json>' [unit]";
          const result = importLivery(text);
          if (!result.ok) return `Rejected:\n${result.errors.join('\n')}`;
          const taken = s.fleet.library().map((l) => l.id);
          const doc = taken.includes(result.livery.id) ? { ...result.livery, id: newLiveryId(result.livery.id, taken) } : result.livery;
          const unit = unitArg(s, args[2]);
          if (!s.assignLivery(unit, doc)) return 'The livery library is full';
          return `Imported '${doc.name}' (${doc.id}) onto ${unit}`;
        }
        return "Usage: livery [list | apply <id> [unit] | export [id] | import '<json>']";
      },
    },
    gear,
    { ...gear, name: 'loadout', description: 'Alias of gear: the officer loadout (show, validate, preset, retention)' },
    {
      name: 'uniform',
      description: `Change the officer's uniform: ${UNIFORM_CLASSES.join(' | ')} [hat] [cold]`,
      usage: '<class> [hat] [cold]',
      run: (args) => {
        const s = session();
        const cls = args[0] as UniformClass | undefined;
        if (cls === undefined || !UNIFORM_CLASSES.includes(cls)) return `Usage: uniform <${UNIFORM_CLASSES.join(' | ')}> [${HAT_IDS.join(' | ')}] [${COLD_IDS.join(' | ')}]`;
        const hat = args[1] as HatId | undefined;
        const cold = args[2] as ColdId | undefined;
        if (hat !== undefined && !HAT_IDS.includes(hat)) return `Unknown hat '${hat}' (${HAT_IDS.join(', ')})`;
        if (cold !== undefined && !COLD_IDS.includes(cold)) return `Unknown cold-weather layer '${cold}' (${COLD_IDS.join(', ')})`;
        const profile = structuredClone(s.character);
        profile.outfit.uniform = cls;
        profile.outfit.hat = hat ?? 'default';
        profile.outfit.carrier = 'default';
        if (cold !== undefined) profile.outfit.cold = cold;
        s.setCharacter(profile);
        return `${displayName(profile)} wears ${cls}${hat ? ` with ${hat}` : ''}${cold && cold !== 'none' ? `, ${cold}` : ''}`;
      },
    },
    {
      name: 'char',
      description: 'The officer character: show, pronouns <she|he|they>',
      usage: '[show | pronouns <she|he|they>]',
      run: (args) => {
        const s = session();
        const sub = args[0] ?? 'show';
        const p = s.character;
        if (sub === 'show') {
          return `${displayName(p)}, badge ${p.badge}, ${pronounLabel(p.pronouns)}, ${p.body.heightM.toFixed(2)} m, build ${p.body.build.toFixed(2)}, ${p.outfit.uniform} uniform, ${p.hairStyle} hair`;
        }
        if (sub === 'pronouns') {
          const id = args[1] as 'she' | 'he' | 'they' | undefined;
          if (id === undefined || !(id in PRONOUN_PRESETS)) return 'Usage: char pronouns <she|he|they>';
          const profile = structuredClone(p);
          profile.pronouns = { ...PRONOUN_PRESETS[id] };
          s.setCharacter(profile);
          return `Pronouns: ${pronounLabel(profile.pronouns)}`;
        }
        return 'Usage: char [show | pronouns <she|he|they>]';
      },
    },
    {
      name: 'drone',
      description: 'Launch the camera drone (from the kit or a trunk) or recall it',
      run: () => session().toggleDrone().message,
    },
    {
      name: 'wear',
      description: 'Set the wear of the vehicle you drive (or drove last): oil <0..1> | tread <0..1>',
      usage: 'oil|tread <0..1>',
      run: (args) => {
        const s = session();
        const v = s.drivenVehicle ?? s.lastVehicle;
        const value = Number(args[1]);
        if (!v || (args[0] !== 'oil' && args[0] !== 'tread') || !Number.isFinite(value)) return 'Usage: wear <oil|tread> <0..1> (get into a vehicle first)';
        s.setVehicleWear(v, args[0] === 'oil' ? { oil: value } : { tread: value });
        return `${args[0] === 'oil' ? 'Oil' : 'Tread'} set to ${pct(Math.min(1, Math.max(0, value)))}`;
      },
    },
    {
      name: 'hit',
      description: 'Simulate a round fired at the officer from <distance> m (default 30): rolls the vest, then the radio call',
      usage: '[distance]',
      run: (args) => {
        const s = session();
        const d = args[0] === undefined ? 30 : Number(args[0]);
        if (!Number.isFinite(d) || d < 0) return 'Usage: hit [distance m]';
        const outcome = s.phase7.hit(s.gear.protection(), d);
        return outcome === 'miss' ? 'The round missed' : outcome === 'stopped' ? 'The vest stopped the round' : 'You were hit: officer down';
      },
    },
  ];
}
