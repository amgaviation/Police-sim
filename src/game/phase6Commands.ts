import { BACKUP_COMMANDS, SWAT_COMMANDS, type BackupCommand, type SwatCommand } from '../backup';
import { TRIAGE_TAGS, type TriageTag } from '../command';
import type { Command } from '../debug/console';
import { laneRef, type RoadHit } from '../world/roadGraph';
import { UNIT_TYPES, mistakeChances, unitType } from '../units';
import { Transform } from '../ecs/components';
import { headingOf, type GameSession } from './session';

/**
 * Phase 6 console commands (design 20.4): `units` (roster / by type), `request`, `eta`, `roster`, `stress`, `backup`,
 * `pursuit`, `swat`, `negotiate`, `mci`, `triage`, `ics` and `flir`.
 */
export interface Phase6CommandDeps {
  session(): GameSession | null;
  flash(text: string): void;
  /** Toggles the air unit camera. */
  flir(): void;
  flirOn(): boolean;
  /** The Phase 2 `units` command (CAD list), which `units` falls back to without arguments. */
  baseUnits?(): Command | undefined;
}

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

const MCI_TYPES = ['multiVehicleCrash', 'buildingCollapse', 'hazmatRelease'] as const;
const PURSUIT_STEPS = ['pit', 'spikes', 'strip', 'box', 'roadblock', 'air', 'perimeter'] as const;
const PURSUIT_REQUEST = {
  pit: { kind: 'requestPit' },
  spikes: { kind: 'spikesAhead' },
  strip: { kind: 'deployStrip' },
  box: { kind: 'boxIn' },
  roadblock: { kind: 'roadblock' },
  air: { kind: 'air' },
  perimeter: { kind: 'perimeter' },
} as const;
/** How far ahead of the officer `pursuit spawn` puts the running car (m). */
const PURSUIT_AHEAD_M = 45;

function pct(v: number): string {
  return `${String(Math.round(v * 100))}%`;
}

function mmss(s: number): string {
  if (!(s >= 0)) return '-';
  const m = Math.floor(s / 60);
  return `${String(m)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export function createPhase6Commands(deps: Phase6CommandDeps): Command[] {
  const session = (): GameSession => need(deps.session());
  const hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };

  /** A car on the road ahead of the officer that runs from the police: starts the pursuit call and returns a description. */
  const spawnPursuit = (s: GameSession): string => {
    const at = s.playerPosition({ x: 0, z: 0 });
    const graph = s.city.graph;
    const h = graph.nearestEdge(at.x, at.z, 80, hit);
    if (!h) return 'No road near the officer';
    const edge = graph.edges[h.edge];
    if (!edge) return 'No road near the officer';
    const v = s.drivenVehicle;
    const yaw = v ? headingOf(Transform.qx[v.eid] ?? 0, Transform.qy[v.eid] ?? 0, Transform.qz[v.eid] ?? 0, Transform.qw[v.eid] ?? 1) : s.controller.yaw;
    // Lane direction along the officer's heading: dir 0 runs with the edge, 1 against it.
    const p0 = graph.lanePoint(laneRef(h.edge, 0, 0), Math.min(h.s + 1, edge.length), { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    const dir: 0 | 1 = -Math.sin(yaw) * Math.sin(p0.yaw) - Math.cos(yaw) * Math.cos(p0.yaw) >= 0 ? 0 : 1;
    for (const ahead of [PURSUIT_AHEAD_M, 30, 70, 90]) {
      const lane = laneRef(h.edge, dir, 0);
      const base = graph.laneStart(lane);
      const along = dir === 0 ? h.s + ahead : edge.length - h.s + ahead;
      if (along >= edge.length - 5) continue;
      const slot = s.traffic.spawnAt(lane, base + along, { speed: 8, behavior: 0 });
      if (slot < 0) continue;
      const id = s.traffic.view.vehicleId[slot] ?? -1;
      if (id >= 0 && s.scene.startPursuitOf(id, s.now())) return `Pursuit started: car ${String(id)} runs ${String(ahead)} m ahead`;
      if (id >= 0) s.traffic.removeVehicle(id);
    }
    return 'No room for a running car here (move to a straight road)';
  };

  const sceneAt = (s: GameSession, typeId: string, building = -1): number => {
    const door = building >= 0 ? s.buildings.building(building)?.door : undefined;
    return s.scene.spawnCall(typeId, s.now(), door ?? s.playerPosition({ x: 0, z: 0 }), [], building);
  };

  return [
    {
      name: 'units',
      description: 'CAD units; "units roster" shows the officer roster, "units <typeId>" the resource units of one type',
      usage: '[roster | <typeId>]',
      run: (args, ctx) => {
        const arg = args[0];
        if (arg === undefined) {
          const base = deps.baseUnits?.();
          return base ? base.run([], ctx) : 'No CAD';
        }
        const s = session();
        if (arg === 'roster') return rosterTable(s);
        if (unitType(arg) === null) return `Unknown unit type '${arg}' (${UNIT_TYPES.types.map((t) => t.id).join(', ')})`;
        const rows = s.phase6.resources.units().filter((u) => u.typeId === arg);
        if (rows.length === 0) return `No ${arg} units (patrol types go through the dispatcher)`;
        return rows.map((u) => `${u.callsign.padEnd(10)} ${u.status.padEnd(12)} ${u.callId > 0 ? `call ${String(u.callId)}` : '-'}  ETA ${mmss(u.etaS)}  @ ${u.x.toFixed(0)}, ${u.z.toFixed(0)}`).join('\n');
      },
    },
    {
      name: 'request',
      description: 'Request a unit type for the current call (as from the MDT Resources tab)',
      usage: '<typeId>',
      run: (args) => {
        const s = session();
        const id = args[0];
        if (id === undefined) return `Usage: request <typeId> (${UNIT_TYPES.types.filter((t) => t.requestable).map((t) => t.id).join(', ')})`;
        if (!s.phase6.requestType(id, 'mdt')) return `Unknown unit type '${id}'`;
        return `Requested ${id}`;
      },
    },
    {
      name: 'eta',
      description: 'Live ETA of an en-route unit',
      usage: '<callsign>',
      run: (args) => {
        const s = session();
        const cs = args[0];
        if (cs === undefined) return 'Usage: eta <callsign>';
        const eta = s.phase6.resources.eta(cs);
        return eta >= 0 ? `${cs} ETA ${mmss(eta)}` : `${cs} is not en route`;
      },
    },
    {
      name: 'roster',
      description: 'The AI officer roster: traits, stress, fatigue, loyalty and mistake chances',
      usage: '[callsign]',
      run: (args) => {
        const s = session();
        const cs = args[0];
        if (cs === undefined) return rosterTable(s);
        const p = s.roster.profile(cs);
        const d = s.roster.dynamic(cs);
        if (!p || !d) return `No officer '${cs}' (try: roster)`;
        const m = mistakeChances(p.traits, d);
        const t = p.traits;
        return [
          `${p.callsign} ${p.name} (${p.rank})`,
          `traits: aggression ${pct(t.aggression)}, discipline ${pct(t.discipline)}, experience ${pct(t.experience)}, composure ${pct(t.composure)}, communication ${pct(t.communication)}`,
          `stress ${pct(d.stress)}, fatigue ${pct(d.fatigue)}, loyalty ${pct(d.loyalty)}; ${String(d.calls)} calls, ${String(d.arrivals)} arrivals, ${String(d.mistakes)} mistakes`,
          `mistake chances: late callout ${pct(m.lateCallout)}, poor position ${pct(m.poorPosition)}, excessive force ${pct(m.excessiveForce)}`,
        ].join('\n');
      },
    },
    {
      name: 'stress',
      description: 'Sets an officer\'s stress (0..1) for testing mistakes',
      usage: '<callsign> <0..1>',
      run: (args) => {
        const s = session();
        const d = s.roster.dynamic(args[0] ?? '');
        const v = Number(args[1]);
        if (!d || !Number.isFinite(v)) return 'Usage: stress <callsign> <0..1>';
        d.stress = Math.min(1, Math.max(0, v));
        s.roster.revision++;
        return `${args[0] ?? ''} stress ${pct(d.stress)}`;
      },
    },
    {
      name: 'backup',
      description: 'Backup: request a unit type, list the officers on foot, or command them',
      usage: 'list | <typeId> | <callsign|all> <cover|secondary|detain|standby|regroup|release>',
      run: (args) => {
        const s = session();
        const a = args[0];
        if (a === undefined || a === 'list') {
          const rows = s.phase6.backup.officers();
          if (rows.length === 0) return 'No backup officers on foot';
          return rows.map((o) => `${o.callsign.padEnd(8)} ${o.name.padEnd(22)} ${o.role.padEnd(10)} ${o.state.padEnd(10)} stress ${pct(o.stress)} fatigue ${pct(o.fatigue)} loyalty ${pct(o.loyalty)}${o.post ? ` post ${o.post}` : ''}`).join('\n');
        }
        const cmd = args[1];
        if (cmd !== undefined) {
          if (!(BACKUP_COMMANDS as readonly string[]).includes(cmd)) return `Unknown command '${cmd}' (${BACKUP_COMMANDS.join(', ')})`;
          s.phase6.backup.request({ kind: 'command', callsign: a, command: cmd as BackupCommand });
          return `${a}: ${cmd}`;
        }
        if (a === 'code2' || a === 'routine') return s.phase6.requestType('routine', 'mdt') ? 'Backup code 2 requested' : 'No such type';
        if (a === 'code3' || a === 'priority') return s.phase6.requestType('priority', 'mdt') ? 'Backup code 3 requested' : 'No such type';
        if (!s.phase6.requestType(a, 'mdt')) return `Unknown unit type '${a}'`;
        return `Requested ${a}`;
      },
    },
    {
      name: 'pursuit',
      description: 'Pursuit: spawn a running car, try a tactic or show the state',
      usage: 'spawn|start | pit | spikes | strip | box | roadblock | air | perimeter | status',
      run: (args) => {
        const s = session();
        const a = args[0] ?? 'status';
        if (a === 'spawn' || a === 'start') return spawnPursuit(s);
        if (a === 'status') {
          const hud = s.phase6.pursuit.hud();
          const menu = s.phase6.pursuit.menu();
          return `${hud ? hud.line : 'No pursuit'}${hud?.verdict ? ` | ${hud.verdict}` : ''}\n${menu.map((m) => `${m.id}: ${m.enabled ? 'ready' : 'off'} ${m.hint}`).join('\n')}`;
        }
        if ((PURSUIT_STEPS as readonly string[]).includes(a)) {
          s.phase6.pursuit.request(PURSUIT_REQUEST[a as (typeof PURSUIT_STEPS)[number]]);
          return `Requested ${a}`;
        }
        return `Usage: pursuit spawn|start | ${PURSUIT_STEPS.join(' | ')} | status`;
      },
    },
    {
      name: 'swat',
      description: 'SWAT: "swat test" opens a barricade at the nearest building and requests a team; or give a command',
      usage: 'test | <stage|stack|breach|clear|hold|withdraw> [front|rear] [deliberate|dynamic] [lessLethal]',
      run: (args) => {
        const s = session();
        const a = args[0] ?? 'test';
        if (a === 'test') {
          const at = s.playerPosition({ x: 0, z: 0 });
          const near = s.buildings.near(at.x, at.z, 120, []).find((b) => b.kind !== 'policeStation');
          if (!near) return 'No building near the officer';
          const id = sceneAt(s, 'barricadedSubject', near.id);
          if (id === 0) return 'Could not open a barricade call';
          s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'auto');
          s.phase6.resources.request({ kind: 'request', typeId: 'swat', callId: id, via: 'mdt' });
          return `Barricade call ${s.cad.call(id)?.number ?? String(id)} at building ${String(near.id)}; SWAT requested (check: units swat)`;
        }
        if (!(SWAT_COMMANDS as readonly string[]).includes(a)) return `Unknown SWAT command '${a}' (test, ${SWAT_COMMANDS.join(', ')})`;
        const plan: { entry?: 'front' | 'rear'; tempo?: 'deliberate' | 'dynamic'; lessLethal?: boolean } = {};
        for (const o of args.slice(1)) {
          if (o === 'front' || o === 'rear') plan.entry = o;
          else if (o === 'deliberate' || o === 'dynamic') plan.tempo = o;
          else if (o === 'lessLethal') plan.lessLethal = true;
          else return `Unknown option '${o}'`;
        }
        s.phase6.command.request({ kind: 'swat', command: a as SwatCommand, ...(Object.keys(plan).length > 0 ? { plan: { entry: 'front', tempo: 'deliberate', lessLethal: false, ...plan } } : {}) });
        return `SWAT: ${a}`;
      },
    },
    {
      name: 'negotiate',
      description: 'Negotiation with a barricaded subject: open, an option id with an optional tone, or close',
      usage: 'open | close | <optionId> [polite|neutral|commanding|aggressive]',
      run: (args) => {
        const s = session();
        const a = args[0];
        if (a === undefined || a === 'open') {
          s.phase6.command.request({ kind: 'negotiationOpen' });
          return 'Negotiation requested (needs an open command post at a barricade)';
        }
        if (a === 'close') {
          s.phase6.command.request({ kind: 'negotiationClose' });
          return 'Negotiation closed';
        }
        const tone = args[1] ?? 'neutral';
        if (tone !== 'polite' && tone !== 'neutral' && tone !== 'commanding' && tone !== 'aggressive') return `Unknown tone '${tone}'`;
        s.phase6.command.request({ kind: 'negotiate', optionId: a, tone });
        return `Said ${a} (${tone})`;
      },
    },
    {
      name: 'mci',
      description: 'Mass-casualty incident: spawns a call of the type at the officer',
      usage: `start|spawn [${MCI_TYPES.join('|')}]`,
      run: (args) => {
        const s = session();
        const t = args[1] ?? args[0] ?? 'multiVehicleCrash';
        const typeId = (MCI_TYPES as readonly string[]).includes(t) ? t : 'multiVehicleCrash';
        if (args[0] !== undefined && args[0] !== 'start' && args[0] !== 'spawn' && !(MCI_TYPES as readonly string[]).includes(args[0])) return `Usage: mci start [${MCI_TYPES.join('|')}]`;
        const id = sceneAt(s, typeId);
        if (id === 0) return `No location found for ${typeId}`;
        s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'auto');
        return `${typeId}: call ${s.cad.call(id)?.number ?? String(id)} opened and assigned (drive there, then ics post)`;
      },
    },
    {
      name: 'triage',
      description: 'Triage at a mass-casualty scene',
      usage: 'list | assess | tag <personId> <red|yellow|green|black>',
      run: (args) => {
        const s = session();
        const a = args[0] ?? 'list';
        const cmd = s.phase6.command;
        if (a === 'assess') {
          cmd.request({ kind: 'assess' });
          return 'Assessing the nearest untagged victim';
        }
        if (a === 'tag') {
          const id = Number(args[1]);
          const tag = args[2];
          if (!Number.isInteger(id) || tag === undefined || !(TRIAGE_TAGS as readonly string[]).includes(tag)) return `Usage: triage tag <personId> <${TRIAGE_TAGS.join('|')}>`;
          cmd.request({ kind: 'tag', personId: id, tag: tag as TriageTag });
          return `Tagged ${String(id)} ${tag}`;
        }
        const rows = cmd.board().victims;
        if (rows.length === 0) return 'No victims on the board (open a command post first: ics post)';
        return rows.map((v) => `${String(v.personId).padEnd(7)} ${v.label.padEnd(12)} ${(v.tag ?? 'untagged').padEnd(9)} ${v.by ?? '-'}${v.trapped ? ' trapped' : ''}${v.contaminated ? ' contaminated' : ''}${v.transported ? ' transported' : ''}`).join('\n');
      },
    },
    {
      name: 'ics',
      description: 'Incident command: post, traffic control points, evacuation, containment, resource needs, stand down',
      usage: 'post | tcp on|off | evac | contain | needs | down | status',
      run: (args) => {
        const s = session();
        const cmd = s.phase6.command;
        const a = args[0] ?? 'status';
        switch (a) {
          case 'post':
            cmd.request({ kind: 'establish' });
            return 'Establishing command';
          case 'tcp':
            cmd.request({ kind: 'tcp', on: args[1] !== 'off' });
            return `Traffic control points ${args[1] === 'off' ? 'off' : 'on'}`;
          case 'evac':
            cmd.request({ kind: 'evacuate' });
            return 'Evacuation ordered';
          case 'contain':
            cmd.request({ kind: 'contain' });
            return 'Containment ordered';
          case 'needs':
            cmd.request({ kind: 'requestNeeds' });
            return 'Requesting what the scene needs';
          case 'down':
            cmd.request({ kind: 'standDown' });
            return 'Standing down';
          case 'status': {
            const b = cmd.board();
            if (!b.post) return 'No command post';
            const c = b.counts;
            return `${b.post.level} post, commander ${b.post.commander}; RED ${String(c.immediate)} YEL ${String(c.delayed)} GRN ${String(c.minor)} BLK ${String(c.expectant)} untagged ${String(c.untagged)}; needs EMS ${String(b.needs.ems)} fire ${String(b.needs.fire)} sup ${String(b.needs.supervisor)}`;
          }
          default:
            return 'Usage: ics post | tcp on|off | evac | contain | needs | down | status';
        }
      },
    },
    {
      name: 'flir',
      description: 'Toggles the air unit camera (needs an air unit overhead)',
      run: () => {
        session();
        deps.flir();
        return deps.flirOn() ? 'FLIR on' : 'FLIR off';
      },
    },
  ];
}

function rosterTable(s: GameSession): string {
  const rows = s.roster.callsigns().map((cs) => {
    const p = s.roster.profile(cs);
    const d = s.roster.dynamic(cs);
    if (!p || !d) return cs;
    return `${cs.padEnd(9)} ${p.name.padEnd(24)} ${p.rank.padEnd(10)} stress ${pct(d.stress).padStart(4)} fatigue ${pct(d.fatigue).padStart(4)} loyalty ${pct(d.loyalty).padStart(4)}  ${String(d.calls)} calls ${String(d.mistakes)} mistakes`;
  });
  return rows.length === 0 ? 'The roster is empty' : rows.join('\n');
}
