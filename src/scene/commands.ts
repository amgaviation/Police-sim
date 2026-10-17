/**
 * Scene console commands: `scene spawn <typeId> [here] [variant...]`, `scene info`, `scene outcomes`,
 * `scene flags <callId>`, and `weapon` (cycles the officer's weapon like the key does).
 */
import { CALL_TYPES } from '../cad/data';
import type { CadTime } from '../cad/types';
import { VARIANT_KINDS, type VariantKind } from '../calls';
import type { Command } from '../debug/console';
import type { SceneDirector } from './director';

export interface SceneCommandDeps {
  scene(): SceneDirector | null;
  now(): CadTime | null;
  playerPosition(): { x: number; z: number } | null;
}

const USAGE = `Usage: scene spawn <typeId> [here] [${VARIANT_KINDS.join('|')}...] | info | outcomes | flags <callId>`;

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} not available (no game running)`);
  return value;
}

export function createSceneCommands(deps: SceneCommandDeps): Command[] {
  return [
    {
      name: 'scene',
      description: 'Scene director debug: spawn a call with variants, show scenarios, outcomes and flags',
      usage: 'spawn <typeId> [here] [variant...] | info | outcomes | flags <callId>',
      run(args) {
        const scene = need(deps.scene(), 'Scene director');
        switch (args[0]) {
          case 'spawn': {
            const typeId = args[1];
            if (typeId === undefined || !CALL_TYPES.some((c) => c.id === typeId)) return `${USAGE}; types: ${CALL_TYPES.map((c) => c.id).join(', ')}`;
            const rest = args.slice(2);
            const here = rest.includes('here');
            const variants = rest.filter((a): a is VariantKind => (VARIANT_KINDS as readonly string[]).includes(a));
            const unknown = rest.filter((a) => a !== 'here' && !(VARIANT_KINDS as readonly string[]).includes(a));
            if (unknown.length > 0) return `Unknown variant ${unknown.join(', ')}; variants: ${VARIANT_KINDS.join(', ')}`;
            const t = need(deps.now(), 'Game time');
            const at = here ? need(deps.playerPosition(), 'Player position') : undefined;
            const id = scene.spawnCall(typeId, t, at, variants);
            if (id === 0) return `No location found for ${typeId}`;
            const rt = scene.runtime(id);
            const got = rt ? rt.scenario.variants.join(',') || 'none' : 'no scenario';
            return `Call ${id} (${typeId})${here ? ' at the player' : ''}: branch ${rt?.scenario.branch ?? '-'}, variants ${got}`;
          }
          case 'info': {
            const s = scene.stats;
            const lines = [`scenarios ${s.scenarios}, materialized ${s.materialized}, weapon ${scene.officerWeapon}, props ${scene.props.count}, step ${s.stepMs.toFixed(3)} ms`];
            const at = deps.playerPosition();
            const near = at ? scene.sceneAt(at.x, at.z) : -1;
            if (near >= 0) lines.push(`Player scene: call ${near}`);
            return lines.join('\n');
          }
          case 'outcomes': {
            const list = scene.outcomes();
            if (list.length === 0) return 'No outcomes yet';
            return list
              .slice(-20)
              .map((o) => `${o.number} ${o.typeId}/${o.branch} -> ${o.outcomeId} (${o.grade}) suggested ${o.suggested}, recorded ${o.disposition}, by ${o.resolvedBy}${o.forceUsed.length > 0 ? `, force ${o.forceUsed.join('+')}` : ''}`)
              .join('\n');
          }
          case 'flags': {
            const id = Number(args[1]);
            if (!Number.isInteger(id)) return 'Usage: scene flags <callId>';
            const rt = scene.runtime(id);
            if (!rt) return `No scenario for call ${id}`;
            return [...rt.flags].sort().join(' ');
          }
          default:
            return USAGE;
        }
      },
    },
    {
      name: 'weapon',
      description: 'Cycle the officer weapon (none, sidearm, taser)',
      run() {
        const scene = need(deps.scene(), 'Scene director');
        scene.request({ kind: 'weapon' });
        return 'Weapon change requested';
      },
    },
  ];
}
