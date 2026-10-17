import type { Command } from '../debug/console';
import { RACK_ITEMS, SIREN_TONES, isSirenTone, type PatrolEquipment } from './equipment';
import { TRUNK_ITEMS } from './inventory';
import { LIGHTBAR_PATTERNS, patternIndex } from './lightbar';

export interface PoliceCommandDeps {
  /** Equipment of the driven (or last driven) patrol car; null when there is none. */
  equipment(): PatrolEquipment | null;
}

function need(eq: PatrolEquipment | null): PatrolEquipment {
  if (eq === null) throw new Error('No patrol car equipment (drive a patrol car first)');
  return eq;
}

function patternName(index: number): string {
  return LIGHTBAR_PATTERNS[index]?.id ?? String(index);
}

/** Multi-line state of `eq` for the `equip` command. */
export function describeEquipment(eq: PatrolEquipment): string {
  const deg = (rad: number): string => ((rad * 180) / Math.PI).toFixed(1);
  const rack = eq.spec.rack
    ? `${eq.rackLocked ? 'locked' : 'unlocked'}; ${RACK_ITEMS.map((r) => `${r.id} ${eq.rackHas(r.id) ? 'racked' : 'out'}`).join(', ')}`
    : 'none';
  const trunk = TRUNK_ITEMS.map((it) => `${it.id} ${eq.trunkCount(it.id)}`).join(', ');
  return [
    `siren ${eq.sirenOn ? 'on' : 'off'} (${eq.tone})${eq.horn ? ' horn' : ''}${eq.manual ? ' manual' : ''}`,
    `lights ${eq.lightsOn ? 'on' : 'off'}, pattern ${patternName(eq.pattern)}`,
    eq.spec.spotlight ? `spotlight ${eq.spotOn ? 'on' : 'off'} yaw ${deg(eq.spotYaw)}° pitch ${deg(eq.spotPitch)}°` : 'spotlight none',
    `rack ${rack}`,
    `trunk ${trunk}`,
    eq.spec.partition ? `cage ${eq.prisoner < 0 ? 'empty' : `person ${eq.prisoner}`}` : 'cage none',
  ].join('\n');
}

/** Console commands: `equip`, `pattern [<id>|next]`, `siren [<tone>|off]`. */
export function createPoliceCommands(deps: PoliceCommandDeps): Command[] {
  const patternIds = (): string => LIGHTBAR_PATTERNS.map((p) => p.id).join(', ');
  return [
    {
      name: 'equip',
      description: 'Show the patrol car equipment state',
      run: () => describeEquipment(need(deps.equipment())),
    },
    {
      name: 'pattern',
      description: 'Show or set the light bar pattern',
      usage: '[<id>|next]',
      run: (args) => {
        const eq = need(deps.equipment());
        const arg = args[0];
        if (arg === undefined) return `pattern ${patternName(eq.pattern)} (patterns: ${patternIds()})`;
        if (arg === 'next') eq.cyclePattern();
        else {
          const i = patternIndex(arg);
          if (i < 0) throw new Error(`Unknown pattern "${arg}" (patterns: ${patternIds()})`);
          eq.setPattern(i);
        }
        return `pattern ${patternName(eq.pattern)}`;
      },
    },
    {
      name: 'siren',
      description: 'Show the siren, switch it off or set its tone (switches it on)',
      usage: `[${SIREN_TONES.join('|')}|off]`,
      run: (args) => {
        const eq = need(deps.equipment());
        const arg = args[0];
        if (arg === 'off') eq.setSiren(false);
        else if (arg !== undefined) {
          if (!isSirenTone(arg) || !eq.setTone(arg)) throw new Error(`Usage: siren [${SIREN_TONES.join('|')}|off]`);
          eq.setSiren(true);
        }
        return `siren ${eq.sirenOn ? 'on' : 'off'} (${eq.tone})`;
      },
    },
  ];
}
