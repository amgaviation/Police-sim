import { CALL_TYPES } from '../cad/data';
import { VARIANT_KINDS, type VariantKind } from '../calls';
import type { Command } from '../debug/console';
import { ACTOR_STATE_NAMES, type ActorInfo } from '../npc';
import { PEOPLE_CAP } from '../people';
import type { GameSession } from './session';

/**
 * Phase 3 console commands (design §20): `call spawn|list|types`, `npc spawn|info`, `dialogue debug`,
 * `population density|stats`. The people, npc (`peds`, `actors`), scene and calls commands come from their modules.
 */

/** `npc spawn <temperament>`: temperament (or a behaviour profile id) -> profile. */
const TEMPERAMENT_PROFILES: Readonly<Record<string, string>> = {
  calm: 'suspectCalm',
  timid: 'suspectNervous',
  irritable: 'suspectAgitated',
  volatile: 'suspectHostile',
  armed: 'suspectArmedHostile',
  flee: 'suspectFleeRisk',
  cooperative: 'driverCooperative',
};

const SPAWN_AHEAD_M = 6;

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

/** Console commands that need the running session. */
export function createPhase3Commands(deps: { session(): GameSession | null }): Command[] {
  let spawnCounter = 0;
  return [
    {
      name: 'call',
      description: 'Spawn a catalog call with its scene, list the open calls, search call types',
      usage: 'spawn <typeId> [here] [variant...] | list | types [filter]',
      run(args) {
        const verb = args[0] ?? 'list';
        if (verb === 'types') {
          const filter = (args[1] ?? '').toLowerCase();
          const ids = CALL_TYPES.map((c) => c.id).filter((id) => id.toLowerCase().includes(filter));
          return `${String(ids.length)} of ${String(CALL_TYPES.length)} types: ${ids.join(', ')}`;
        }
        const session = need(deps.session());
        if (verb === 'list') {
          const lines: string[] = [];
          for (const c of session.cad.openCalls()) {
            const rt = session.scene.runtime(c.id);
            const scenario = rt
              ? ` ${rt.scenario.branch}${rt.scenario.variants.length > 0 ? `+${rt.scenario.variants.join(',')}` : ''}${rt.materialized ? ' [on scene]' : ''}`
              : '';
            lines.push(`${c.number} P${String(c.priority)} ${c.typeId} ${c.status} ${c.location.text}${scenario}`);
          }
          return lines.length === 0 ? 'No open calls' : lines.join('\n');
        }
        if (verb !== 'spawn') return 'Usage: call spawn <typeId> [here] [variant...] | list | types [filter]';
        const typeId = args[1];
        if (typeId === undefined || !CALL_TYPES.some((c) => c.id === typeId)) return 'Unknown type; try: call types <filter>';
        const rest = args.slice(2);
        const here = rest.includes('here');
        const variants = rest.filter((a): a is VariantKind => (VARIANT_KINDS as readonly string[]).includes(a));
        const unknown = rest.filter((a) => a !== 'here' && !(VARIANT_KINDS as readonly string[]).includes(a));
        if (unknown.length > 0) return `Unknown variant ${unknown.join(', ')}; variants: ${VARIANT_KINDS.join(', ')}`;
        const id = session.scene.spawnCall(typeId, session.now(), here ? session.playerPosition({ x: 0, z: 0 }) : undefined, variants);
        if (id === 0) return `No location found for ${typeId}`;
        const call = session.cad.call(id);
        const rt = session.scene.runtime(id);
        return `Call ${call?.number ?? String(id)} ${typeId}: branch ${rt?.scenario.branch ?? '-'}, variants ${rt?.scenario.variants.join(',') || 'none'}`;
      },
    },
    {
      name: 'npc',
      description: 'Spawn a scene actor ahead of the officer (temperament or profile id), show the nearest actor',
      usage: 'spawn <calm|timid|irritable|volatile|armed|flee|profileId> | info',
      run(args) {
        const session = need(deps.session());
        const verb = args[0] ?? 'info';
        if (verb === 'spawn') {
          const key = args[1] ?? 'calm';
          const profile = TEMPERAMENT_PROFILES[key] ?? key;
          const at = session.playerPosition({ x: 0, z: 0 });
          const yaw = session.controller.yaw;
          // A deterministic walk through the person ids, skipping people who are already on scene.
          let personId = (spawnCounter * 7919 + 4217) % 100_000;
          while (session.npc.isActivePerson(personId)) personId = (personId + 1) % 100_000;
          spawnCounter++;
          try {
            const id = session.npc.spawnActor({
              personId,
              x: at.x - Math.sin(yaw) * SPAWN_AHEAD_M,
              z: at.z - Math.cos(yaw) * SPAWN_AHEAD_M,
              yaw: yaw + Math.PI,
              profile,
              role: 'subject',
              callId: 0,
              hidden: false,
              body: 'human',
              weapon: null,
              vehicleId: -1,
            });
            return id === 0 ? 'Actor pool is full' : `Actor ${String(id)} (person ${String(personId)}, ${profile}) ahead of you`;
          } catch (error) {
            return `${error instanceof Error ? error.message : String(error)}; profiles: ${Object.values(TEMPERAMENT_PROFILES).join(', ')}, or any behaviour profile id`;
          }
        }
        if (verb !== 'info') return 'Usage: npc spawn <temperament|profileId> | info';
        const at = session.playerPosition({ x: 0, z: 0 });
        const info = emptyInfo();
        let best: ActorInfo | null = null;
        let bestD = Infinity;
        for (const id of session.npc.actorIds([])) {
          const a = session.npc.actor(id, info);
          if (!a) continue;
          const d = Math.hypot(a.x - at.x, a.z - at.z);
          if (d < bestD) {
            bestD = d;
            best = { ...a };
          }
        }
        if (!best) return `No actors. Pedestrians ${String(session.npc.stats.peds)}, occupants ${String(session.npc.stats.occupants)}`;
        const id = session.people.identity(best.personId);
        const r = id.record;
        return [
          `Actor ${String(best.id)} ${r.first} ${r.last} (person ${String(best.personId)}), ${String(Math.round(bestD))} m, role ${best.role || '-'}, call ${String(best.callId)}`,
          `profile ${best.profile}, state ${ACTOR_STATE_NAMES[best.state] ?? String(best.state)}, stress ${best.stress.toFixed(2)}${best.cuffed ? ', cuffed' : ''}${best.armed ? ', armed' : ''}${best.hidden ? ', hidden' : ''}`,
          `temperament ${id.temperament}, honesty ${id.honesty.toFixed(2)}, attitude ${id.attitude.toFixed(2)}, language ${id.language.label}`,
        ].join('\n');
      },
    },
    {
      name: 'dialogue',
      description: 'Dialogue state: the active contact, its transcript, statements, facts and inconsistencies',
      usage: 'debug',
      run() {
        const session = need(deps.session());
        const c = session.contact;
        const lines = [`active ${String(c.active)}, revision ${String(c.revision)}, escorting actor ${String(c.escorting())}`];
        const view = c.active >= 0 ? c.view(c.active) : null;
        if (!view) return [...lines, 'No open conversation'].join('\n');
        lines.push(`${view.title} · ${view.subtitle} · tone ${view.tone} · mode ${view.commMode} (${view.commModes.join(', ')})`);
        lines.push(`topics: ${view.topics.map((t) => `${t.label}(${String(t.options.filter((o) => o.enabled).length)})`).join(', ')}`);
        lines.push(`actions: ${view.actions.filter((a) => a.enabled).map((a) => a.id).join(', ') || 'none'}`);
        for (const l of view.transcript.slice(-6)) lines.push(`  ${l.speaker}: ${l.text}`);
        for (const n of [...view.statements, ...view.facts, ...view.inconsistencies]) lines.push(`  [${n.severity}] ${n.text}`);
        const sfst = c.sfstView();
        if (sfst) lines.push(`SFST ${sfst.title}: ${sfst.instruction}${sfst.finished ? ' (finished)' : ''}`);
        return lines.join('\n');
      },
    },
    {
      name: 'population',
      description: 'Pedestrian density multiplier and people counts',
      usage: 'density <n> | stats',
      run(args) {
        const session = need(deps.session());
        const verb = args[0] ?? 'stats';
        if (verb === 'density') {
          const x = Number(args[1]);
          if (args[1] === undefined || !Number.isFinite(x) || x < 0) return 'Usage: population density <n>   (n >= 0; 1 = normal)';
          session.npc.setDensityScale(x);
          return `Pedestrian density x${String(x)} (target ${String(session.npc.targetPeds)})`;
        }
        const s = session.npc.stats;
        return `pedestrians ${String(s.peds)} (density x${String(session.npc.density)}), actors ${String(s.actors)}, occupants ${String(s.occupants)}, touched people ${String(session.people.touchedCount)}/${String(PEOPLE_CAP)}`;
      },
    },
  ];
}

function emptyInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
    following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}
