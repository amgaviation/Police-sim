import { createCadCommands } from '../cad/commands';
import { DISPOSITIONS } from '../cad/data';
import type { Command, CommandContext } from '../debug/console';
import { createDispatchCommands } from '../dispatch/commands';
import { LIGHTBAR_PATTERNS, patternIndex } from '../police/lightbar';
import { createRadioCommands } from '../radio/commands';
import { isChannelId } from '../radio/data';
import { createRecordsCommands } from '../records/commands';
import type { GameSession } from './session';

/** What the patrol shortcuts reach. */
export interface PatrolCommandDeps {
  session(): GameSession | null;
}

function need(session: GameSession | null): GameSession {
  if (!session) throw new Error('No game running');
  return session;
}

function byName(commands: readonly Command[], name: string): Command {
  const c = commands.find((x) => x.name === name);
  if (!c) throw new Error(`missing command ${name}`);
  return c;
}

const CAD_USAGE = 'call <type> [here] | calls | show <id> | units | clear [disposition] | docs [kind]';
const LOOKUP_USAGE = 'plate <ABC 1234> | person <id> | person <last> [first]';
const LIGHTS_USAGE = `on | off | next | <${LIGHTBAR_PATTERNS.map((p) => p.id).join('|')}>`;
const RADIO_USAGE = 'say [channel] <text> | channel [id] | scan | log [n]';

/**
 * Short console commands for testing the patrol job (task list of Phase 2): `cad call <type>`,
 * `cad clear`, `cad units`, `lookup plate <p>`, `lookup person <id|name>`, `lights <pattern>` and
 * `radio say <text>` (the radio module's `radio` command, with the channel optional for `say`).
 * They forward to the module commands (`dispatch`, `calls`, `units`, `runplate`, `person`, `radio`) or
 * act on the session; `siren <tone>` is the police module's own.
 */
export function createPatrolCommands(deps: PatrolCommandDeps): Command[] {
  const cad = createCadCommands({ cad: () => deps.session()?.cad ?? null });
  const records = createRecordsCommands({ records: () => deps.session()?.records ?? null, seed: () => deps.session()?.seed ?? null });
  const dispatch = createDispatchCommands({
    dispatcher: () => deps.session()?.dispatcher ?? null,
    now: () => deps.session()?.now() ?? null,
    playerPosition: () => deps.session()?.playerPosition({ x: 0, z: 0 }) ?? null,
  });
  const radio = createRadioCommands({ radio: () => deps.session()?.radio ?? null });
  const forward = (command: Command, args: string[], ctx: CommandContext): ReturnType<Command['run']> => command.run(args, ctx);
  const dispositions = DISPOSITIONS.map((d) => d.id);
  return [
    {
      name: 'cad',
      description: 'CAD shortcuts: create a call, list calls or units, clear your call, list documents',
      usage: CAD_USAGE,
      run(args, ctx) {
        const [verb, ...rest] = args;
        switch (verb) {
          case 'call':
            return forward(byName(dispatch, 'dispatch'), ['call', ...rest], ctx);
          case 'calls':
            return forward(byName(cad, 'calls'), rest, ctx);
          case 'show':
            return forward(byName(cad, 'call'), rest, ctx);
          case 'units':
            return forward(byName(cad, 'units'), rest, ctx);
          case 'docs':
            return forward(byName(cad, 'docs'), rest, ctx);
          case 'clear': {
            const session = need(deps.session());
            const callsign = session.dispatcher.playerCallsign;
            const unit = session.cad.unit(callsign);
            const call = unit && unit.callId !== null ? session.cad.call(unit.callId) : null;
            if (!call) return 'You are not on a call';
            const disposition = rest[0] ?? 'handled';
            if (!dispositions.includes(disposition)) return `Unknown disposition "${disposition}" (${dispositions.join(', ')})`;
            session.dispatcher.request(callsign, { kind: 'clearCall', callId: call.id, disposition }, 'key');
            return `Clearing ${call.number} (${disposition})`;
          }
          default:
            return `Usage: cad ${CAD_USAGE}`;
        }
      },
    },
    {
      name: 'lookup',
      description: 'Records lookups: run a plate, show a person by id or search by name',
      usage: LOOKUP_USAGE,
      run(args, ctx) {
        const [what, ...rest] = args;
        if (what === 'plate' && rest.length > 0) return forward(byName(records, 'runplate'), rest, ctx);
        if (what === 'person' && rest.length > 0) return forward(byName(records, 'person'), rest, ctx);
        return `Usage: lookup ${LOOKUP_USAGE}`;
      },
    },
    {
      name: 'radio',
      description: 'Radio: queue a line (on the selected channel unless one is named), select a channel, toggle scan, show the log',
      usage: RADIO_USAGE,
      run(args, ctx) {
        if (args[0] === 'say' && args.length >= 2 && !isChannelId(args[1])) {
          const r = need(deps.session()).radio;
          r.say(r.selected, args.slice(1).join(' '));
          return `Queued on ${r.selected}`;
        }
        return forward(byName(radio, 'radio'), args, ctx);
      },
    },
    {
      name: 'lights',
      description: 'Light bar of the driven (or last driven) patrol car: on, off, next pattern, or a pattern (switches it on)',
      usage: LIGHTS_USAGE,
      run(args) {
        const session = need(deps.session());
        const vehicle = session.drivenVehicle ?? session.lastVehicle;
        const eq = session.equipmentOf(vehicle);
        if (!vehicle || !eq) throw new Error('No patrol car (drive one first)');
        const arg = args[0];
        if (arg === 'off') vehicle.lightbar = false;
        else if (arg === 'on') vehicle.lightbar = true;
        else if (arg === 'next') eq.cyclePattern();
        else if (arg !== undefined) {
          const i = patternIndex(arg);
          if (i < 0) throw new Error(`Usage: lights ${LIGHTS_USAGE}`);
          eq.setPattern(i);
          vehicle.lightbar = true;
        }
        return `lights ${vehicle.lightbar ? 'on' : 'off'}, pattern ${LIGHTBAR_PATTERNS[eq.pattern]?.id ?? '?'}`;
      },
    },
  ];
}
