import type { Command } from '../debug/console';
import { ACTOR_STATE_NAMES, type ActorInfo } from './types';
import type { NpcSystem } from './npcSystem';

/** Debug console commands of the NPC module: `peds stats|density <x>|clear`, `actors`. */

function need(npc: NpcSystem | null): NpcSystem {
  if (npc === null) throw new Error('No game running');
  return npc;
}

export function createNpcCommands(deps: { npc(): NpcSystem | null }): Command[] {
  return [
    {
      name: 'peds',
      description: 'Ambient pedestrians: stats, density multiplier, clear',
      usage: 'stats | density <x> | clear',
      run(args) {
        const npc = need(deps.npc());
        const verb = args[0] ?? 'stats';
        if (verb === 'stats') {
          const s = npc.stats;
          return [
            `peds ${s.peds} (target ${npc.targetPeds}, density x${npc.density})  actors ${s.actors}  occupants ${s.occupants}`,
            `updates last step: peds ${s.pedUpdates}, actors ${s.actorUpdates}   step ${s.stepMs.toFixed(3)} ms`,
          ].join('\n');
        }
        if (verb === 'density') {
          const x = Number(args[1]);
          if (args[1] === undefined || !Number.isFinite(x) || x < 0) throw new Error('Usage: peds density <x>   (x >= 0)');
          npc.setDensityScale(x);
          return `Pedestrian density x${x}`;
        }
        if (verb === 'clear') {
          const n = npc.stats.peds;
          npc.clearPeds();
          return `Removed ${n} pedestrians`;
        }
        throw new Error('Usage: peds stats | density <x> | clear');
      },
    },
    {
      name: 'actors',
      description: 'List the scene actors',
      run() {
        const npc = need(deps.npc());
        const info: ActorInfo = {
          id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
          armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
        };
        const lines: string[] = [];
        for (const id of npc.actorIds([])) {
          if (!npc.actor(id, info)) continue;
          lines.push(
            `#${info.id}  ${info.role || '-'}  call ${info.callId}  person ${info.personId}  ${info.profile}  ${ACTOR_STATE_NAMES[info.state] ?? info.state}  ` +
              `(${info.x.toFixed(0)}, ${info.z.toFixed(0)})  stress ${info.stress.toFixed(2)}${info.cuffed ? ' cuffed' : ''}${info.hidden ? ' hidden' : ''}${info.weaponDrawn ? ' weapon' : ''}`,
          );
        }
        return lines.length === 0 ? 'No actors' : lines.join('\n');
      },
    },
  ];
}
