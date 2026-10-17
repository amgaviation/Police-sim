/**
 * Dispatch console command: `dispatch call <type> [here]`, `dispatch backup <2|3>`,
 * `dispatch emergency`, `dispatch stats`, `dispatch units`.
 */
import { CALL_TYPES } from '../cad/data';
import type { CadTime } from '../cad/types';
import type { Command } from '../debug/console';
import type { Dispatcher } from './dispatcher';

export interface DispatchCommandDeps {
  dispatcher(): Dispatcher | null;
  now(): CadTime | null;
  playerPosition(): { x: number; z: number } | null;
}

const USAGE = 'Usage: dispatch call <type> [here] | backup <2|3> | emergency | stats | units';

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} not available (no game running)`);
  return value;
}

export function createDispatchCommands(deps: DispatchCommandDeps): Command[] {
  return [
    {
      name: 'dispatch',
      description: 'Dispatcher debug: create a call, request backup / emergency, show stats or AI units',
      usage: 'call <type> [here] | backup <2|3> | emergency | stats | units',
      run(args) {
        const d = need(deps.dispatcher(), 'Dispatcher');
        const sub = args[0];
        switch (sub) {
          case 'call': {
            const typeId = args[1];
            const ids = CALL_TYPES.map((c) => c.id);
            if (typeId === undefined || !ids.includes(typeId)) return `Usage: dispatch call <type> [here]; types: ${ids.join(', ')}`;
            const t = need(deps.now(), 'Game time');
            const at = args[2] === 'here' ? need(deps.playerPosition(), 'Player position') : undefined;
            const call = d.createCall(typeId, t, at);
            return call ? `${call.number} P${call.priority} ${call.nature} at ${call.location.text} (${call.location.near})` : `No location found for ${typeId}`;
          }
          case 'backup': {
            const code = args[1] === '3' ? 3 : args[1] === '2' ? 2 : null;
            if (code === null) return 'Usage: dispatch backup <2|3>';
            d.request(d.playerCallsign, { kind: 'backup', code }, 'key');
            return `Backup code ${code} requested`;
          }
          case 'emergency':
            d.request(d.playerCallsign, { kind: 'emergency' }, 'key');
            return 'Emergency button pressed';
          case 'stats': {
            const s = d.stats;
            return `Generated ${s.generated}, open ${s.open}, AI units busy ${s.aiBusy}`;
          }
          case 'units': {
            const lines = d.unitStates().map(
              (u) => `${u.callsign.padEnd(4)} fleet ${String(u.fleetIndex).padStart(2)}  ${u.mode.padEnd(8)} ${u.role.padEnd(9)} call ${u.callId ?? '-'}`,
            );
            return lines.length > 0 ? lines.join('\n') : 'No AI units';
          }
          default:
            return USAGE;
        }
      },
    },
  ];
}
