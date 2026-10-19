import type { Command } from '../debug/console';
import { verifyLedger } from '../evidence';
import { ACTOR_STATE, type ActorInfo } from '../npc';
import { generateInterior, reachableRooms, type InteriorLayout } from '../interior';
import type { ShiftStep } from '../station';
import { SHIFT_STEPS, ARMORY_ITEMS, LOADOUT_FIELDS, type LoadoutField } from '../station';
import { BUILDING_KINDS, type BuildingInfo, type BuildingKind } from '../world/buildings';
import type { PartnerCommand } from '../tactical';
import { SOUND_KINDS, createListener, type SoundKind } from '../tactical';
import type { GameSession } from './session';

/**
 * Phase 4 console commands (design §20.6): `building`, `interior`, `shift`, `armory`, `loadout`, `case`, `evidence`, `custody`,
 * `ledger`, `k9`, `tape`, `aware`, `sound`, `partner`. (`call spawn <type> building <id>` is part of the Phase 3 `call` command.)
 */
export interface Phase4CommandDeps {
  session(): GameSession | null;
  flash(text: string): void;
}

const SEARCH_RADIUS_M = 700;
const PARTNER_COMMANDS: readonly PartnerCommand[] = ['follow', 'stack', 'hold', 'clear', 'dismiss', 'summon'];

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

function describeBuilding(session: GameSession, b: BuildingInfo): string {
  const layout = session.interiors.layout(b.id);
  const size = `${(b.maxX - b.minX).toFixed(0)}x${(b.maxZ - b.minZ).toFixed(0)} m`;
  const inside = layout ? `${String(layout.rooms.length)} rooms, ${String(layout.doors.length)} doors, ${String(layout.furniture.length)} furniture` : 'not enterable';
  return `#${String(b.id)} ${b.kind ?? 'none'} ${size} at ${b.address || 'unknown address'}; door (${b.door.x.toFixed(1)}, ${b.door.z.toFixed(1)}); ${inside}`;
}

/** The nearest enterable building of `kind` (any kind when null) around the officer. */
function nearestOfKind(session: GameSession, kind: BuildingKind | null): BuildingInfo | null {
  if (kind === 'policeStation') return session.buildings.station();
  if (kind === 'jail') return session.buildings.jail();
  const at = session.playerPosition({ x: 0, z: 0 });
  const out: BuildingInfo[] = [];
  session.buildings.near(at.x, at.z, SEARCH_RADIUS_M, out);
  let best: BuildingInfo | null = null;
  let bestD = Infinity;
  for (const b of out) {
    if (b.kind === null || (kind !== null && b.kind !== kind) || session.interiors.layout(b.id) === null) continue;
    const d = Math.hypot(b.door.x - at.x, b.door.z - at.z);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function parseKind(word: string | undefined): BuildingKind | null {
  return word !== undefined && (BUILDING_KINDS as readonly string[]).includes(word) ? (word as BuildingKind) : null;
}

/** The building named by `arg`: an id, 'here' (the officer's building, else the nearest entrance), or a kind. */
function resolveBuilding(session: GameSession, arg: string | undefined): BuildingInfo | null {
  if (arg === undefined || arg === 'here') {
    const b = session.officerBuilding;
    if (b >= 0) return session.buildings.building(b);
    const at = session.playerPosition({ x: 0, z: 0 });
    return session.buildings.nearestEntrance(at.x, at.z, 60);
  }
  const id = Number(arg);
  if (Number.isInteger(id)) return session.buildings.building(id);
  return nearestOfKind(session, parseKind(arg));
}

function enterBuilding(session: GameSession, b: BuildingInfo): string {
  const layout = session.interiors.layout(b.id);
  if (!layout) return `Building ${String(b.id)} is not enterable`;
  const main = layout.doors.find((d) => d.main);
  // Colliders and traffic load around the building first; then the officer is placed inside at once.
  if (main?.exit) session.teleport(main.exit.x, main.exit.z, main.exit.yaw + Math.PI);
  session.interiors.placeOfficerInside(b.id, layout.entry);
  return `Inside ${b.kind ?? 'building'} #${String(b.id)} (${layout.rooms.length} rooms)`;
}

function layoutReport(layout: InteriorLayout): string {
  const reached = reachableRooms(layout, layout.doors.find((d) => d.main)?.a ?? 0, () => true, []).length;
  return `${layout.kind}: ${String(layout.rooms.length)} rooms (${String(reached)} reachable), ${String(layout.doors.length)} doors, ${String(layout.furniture.length)} furniture, ${String(layout.hidingSpots.length)} hiding spots, ${String(layout.itemSpots.length)} item spots, ${String(layout.points.length)} points`;
}

export function createPhase4Commands(deps: Phase4CommandDeps): Command[] {
  return [
    {
      name: 'building',
      description: 'Show a building (id, here, or a kind): kind, size, address, door and interior size',
      usage: '[id|here|kind]',
      run(args) {
        const session = need(deps.session());
        const b = resolveBuilding(session, args[0]);
        return b ? describeBuilding(session, b) : 'No building found';
      },
    },
    {
      name: 'interior',
      description: 'Interiors: info, enter <id|kind>, exit, gen <kind> <seed>, doors, unlock, lights on|off',
      usage: 'info | enter <id|kind> | exit | gen <kind> <seed> | doors | unlock | lights on|off',
      run(args) {
        const session = need(deps.session());
        const verb = args[0] ?? 'info';
        const interiors = session.interiors;
        switch (verb) {
          case 'enter': {
            const b = resolveBuilding(session, args[1]);
            return b ? enterBuilding(session, b) : `No building found (kinds: ${BUILDING_KINDS.join(', ')})`;
          }
          case 'exit': {
            const id = interiors.officerBuilding;
            const main = id >= 0 ? interiors.layout(id)?.doors.find((d) => d.main)?.exit : null;
            if (!main) return 'Not inside a building';
            session.teleport(main.x, main.z, main.yaw + Math.PI);
            return 'Outside';
          }
          case 'gen': {
            const kind = parseKind(args[1]);
            const seed = Number(args[2] ?? session.seed);
            if (kind === null || !Number.isFinite(seed)) return `Usage: interior gen <kind> <seed>; kinds: ${BUILDING_KINDS.join(', ')}`;
            const b = nearestOfKind(session, kind);
            if (!b) return `No ${kind} found within ${String(SEARCH_RADIUS_M)} m`;
            const a = generateInterior(seed, b);
            const c = generateInterior(seed, b);
            if (!a || !c) return `No ${kind} template fits building #${String(b.id)}`;
            const same = JSON.stringify(a.rooms) === JSON.stringify(c.rooms) && a.walls.length === c.walls.length;
            return `Building #${String(b.id)} seed ${String(seed)}: ${layoutReport(a)}; deterministic: ${same ? 'yes' : 'NO'}`;
          }
          case 'doors': {
            const id = interiors.officerBuilding;
            const layout = id >= 0 ? interiors.layout(id) : null;
            if (!layout) return 'Not inside a building';
            return layout.doors.map((d) => `${String(d.index)} ${d.kind}${d.main ? ' main' : ''} ${interiors.doorState(id, d.index)} (${d.a}->${d.b})`).join('\n');
          }
          case 'unlock':
          case 'lights': {
            const id = interiors.officerBuilding;
            const layout = id >= 0 ? interiors.layout(id) : null;
            if (!layout) return 'Not inside a building';
            if (verb === 'unlock') {
              for (const d of layout.doors) if (interiors.doorState(id, d.index) === 'locked') interiors.setDoorState(id, d.index, 'closed');
              return 'Doors unlocked';
            }
            const on = args[1] !== 'off';
            for (const r of layout.rooms) interiors.setRoomLight(id, r.index, on);
            return `Lights ${on ? 'on' : 'off'}`;
          }
          default: {
            const id = interiors.officerBuilding;
            const layout = id >= 0 ? interiors.layout(id) : null;
            const s = interiors.stats;
            const head = `resident ${interiors.resident.join(', ') || 'none'}; ${String(s.colliders)} colliders; ${String(s.occupants)} occupants`;
            if (!layout) return `Outdoors; ${head}`;
            return `In #${String(id)} ${layoutReport(layout)}; room ${String(session.officerRoom())}; ${head}`;
          }
        }
      },
    },
    {
      name: 'shift',
      description: 'The shift flow (locker, briefing, armory, garage, on patrol); with a step, completes it',
      usage: '[step]',
      run(args) {
        const session = need(deps.session());
        const step = args[0];
        if (step !== undefined) {
          if (!(SHIFT_STEPS as readonly string[]).includes(step)) return `Unknown step; steps: ${SHIFT_STEPS.join(', ')}`;
          session.station.request({ kind: 'complete', step: step as ShiftStep });
        }
        const flow = session.station.flow;
        return `Step: ${flow.step}${flow.objective() ? ` (${flow.objective()})` : ''}; completed: ${flow.log.map(([s]) => s).join(', ') || 'none'}`;
      },
    },
    {
      name: 'armory',
      description: 'Armory log; `armory out|in <item>` signs equipment out or in',
      usage: '[out|in <item>]',
      run(args) {
        const session = need(deps.session());
        const action = args[0];
        if (action === 'out' || action === 'in') {
          const item = args[1];
          if (item === undefined || !ARMORY_ITEMS.some((d) => d.id === item)) return `Items: ${ARMORY_ITEMS.map((d) => d.id).join(', ')}`;
          session.station.request({ kind: 'armory', item, action });
        }
        const log = session.station.armory;
        const out = log.out().join(', ') || 'nothing';
        return `Signed out: ${out}; ${String(log.entries().length)} log entries`;
      },
    },
    {
      name: 'loadout',
      description: 'The locker loadout; `loadout <field>` cycles a field',
      usage: `[${LOADOUT_FIELDS.join('|')}]`,
      run(args) {
        const session = need(deps.session());
        const field = args[0];
        if (field !== undefined) {
          if (!(LOADOUT_FIELDS as readonly string[]).includes(field)) return `Fields: ${LOADOUT_FIELDS.join(', ')}`;
          session.station.request({ kind: 'loadout', field: field as LoadoutField });
        }
        return JSON.stringify(session.station.loadout);
      },
    },
    {
      name: 'case',
      description: 'Case file summary of a call (default: the current call, else the field case)',
      usage: '[callId]',
      run(args) {
        const session = need(deps.session());
        const arg = args[0];
        const callId = arg === undefined ? (session.cad.unit(session.dispatcher.playerCallsign)?.callId ?? 0) : Number(arg);
        if (!Number.isInteger(callId)) return 'Usage: case [callId]';
        const s = session.investigation.summary(callId);
        return `Case ${String(callId)}: ${String(s.items)} items (${String(s.found)} found, ${String(s.plainView)} plain view, ${String(s.suppressed)} suppressed, ${String(s.collected)} collected), custody ${s.custodyComplete ? 'complete' : 'open'}, ${String(s.photos)} photos, ${String(s.markers)} markers, ${String(s.prints)} prints, ${String(s.canvass)} canvass, ${String(s.consents)} consents, bodycam ${s.bodycam ? 'on' : 'off'}`;
      },
    },
    {
      name: 'evidence',
      description: 'Evidence items of every case file',
      usage: 'list',
      run() {
        const session = need(deps.session());
        const lines: string[] = [];
        for (const f of session.investigation.store.files()) {
          for (const i of f.items) {
            lines.push(`${i.id} ${i.state}${i.concealed ? ' concealed' : ''}${i.suppressed ? ' suppressed' : ''} ${i.label} in building ${String(i.buildingId)} room ${String(i.room)} (${i.x.toFixed(1)}, ${i.z.toFixed(1)}) custody ${session.investigation.ledger.state(i.id)}`);
          }
        }
        return lines.length === 0 ? 'No evidence items' : lines.join('\n');
      },
    },
    {
      name: 'custody',
      description: 'The chain of custody of an evidence item',
      usage: '<itemId>',
      run(args) {
        const session = need(deps.session());
        const id = args[0];
        if (id === undefined) return 'Usage: custody <itemId>';
        const ledger = session.investigation.ledger;
        const entries = ledger.itemEntries(id);
        if (entries.length === 0) return `No custody entries for ${id}`;
        return [`${id}: ${ledger.state(id)}, held by ${ledger.custodian(id)}${ledger.complete(id) ? ', complete' : ''}`, ...entries.map((e) => `#${String(e.seq)} ${e.action} ${e.from} -> ${e.to} @ ${e.location} ${e.hash.slice(0, 8)}`)].join('\n');
      },
    },
    {
      name: 'ledger',
      description: 'Verify the hash chain of the custody ledger',
      usage: 'verify',
      run() {
        const session = need(deps.session());
        const entries = session.investigation.ledger.entries();
        const result = verifyLedger(entries);
        return result.ok ? `Ledger intact: ${String(entries.length)} entries` : result.issues.map((i) => `#${String(i.seq)} ${i.itemId} ${i.kind}: ${i.text}`).join('\n');
      },
    },
    {
      name: 'k9',
      description: 'Start a K9 sweep on a call now',
      usage: '<callId>',
      run(args) {
        const session = need(deps.session());
        const callId = Number(args[0]);
        if (!Number.isInteger(callId) || callId <= 0) return 'Usage: k9 <callId>';
        session.investigation.startK9(callId);
        return `K9 sweep started for call ${String(callId)}`;
      },
    },
    {
      name: 'tape',
      description: 'Scene tape: `tape clear` removes the open and closed tapes',
      usage: 'clear',
      run(args) {
        const session = need(deps.session());
        if (args[0] !== 'clear') return 'Usage: tape clear';
        session.investigation.request({ kind: 'tapeClear' });
        return 'Tape cleared';
      },
    },
    {
      name: 'aware',
      description: 'Awareness of the actors in the officer\'s building (or outdoors) with the officer in sight',
      run() {
        const session = need(deps.session());
        const ids = session.npc.actorsInBuilding(session.officerBuilding, []);
        const info: ActorInfo = { id: 0, personId: -1, role: '', callId: 0, state: ACTOR_STATE.idle, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
        const lines = ids.map((id) => {
          const a = session.npc.actor(id, info);
          return a ? `actor ${String(a.id)} ${a.role} aware ${(a.aware ?? 0).toFixed(2)}${a.hidden ? ' hidden' : ''}` : '';
        });
        return lines.filter((l) => l !== '').join('\n') || 'Nobody here';
      },
    },
    {
      name: 'sound',
      description: 'Sound model: `sound <kind>` makes a sound at the officer, `sound debug` shows noise, visibility and listeners',
      usage: `debug | <${SOUND_KINDS.join('|')}>`,
      run(args) {
        const session = need(deps.session());
        const word = args[0] ?? 'debug';
        if (word === 'debug') {
          const at = session.playerPosition({ x: 0, z: 0 });
          const buf = Array.from({ length: 16 }, () => createListener());
          const n = session.npc.listeners(at.x, at.z, 30, buf);
          const lines = [`noise ${session.tactical.noise.toFixed(2)}, visibility ${session.tactical.visibility.toFixed(2)}, crouched ${String(session.tactical.stance.crouched)}, light ${String(session.tactical.flashlightOn)}, ${String(n)} listeners within 30 m`];
          for (let i = 0; i < Math.min(n, 16); i++) {
            const l = buf[i];
            if (l) lines.push(`actor ${String(l.actorId)} ${Math.hypot(l.x - at.x, l.z - at.z).toFixed(1)} m, building ${String(l.building)}, ${l.hearing}${l.asleep ? ', asleep' : ''}`);
          }
          return lines.join('\n');
        }
        if (!(SOUND_KINDS as readonly string[]).includes(word)) return `Kinds: ${SOUND_KINDS.join(', ')}`;
        const at = session.playerPosition({ x: 0, z: 0 });
        session.tactical.request({ kind: 'sound', source: word as SoundKind, x: at.x, z: at.z, building: session.officerBuilding });
        return `Sound ${word} at the officer`;
      },
    },
    {
      name: 'partner',
      description: 'Partner placeholder commands',
      usage: PARTNER_COMMANDS.join('|'),
      run(args) {
        const session = need(deps.session());
        const command = args[0];
        if (command === undefined || !(PARTNER_COMMANDS as readonly string[]).includes(command)) {
          return `Mode: ${session.tactical.partner.mode}; commands: ${PARTNER_COMMANDS.join(', ')}`;
        }
        session.tactical.request({ kind: 'partner', command: command as PartnerCommand });
        return `Partner: ${command}`;
      },
    },
  ];
}
