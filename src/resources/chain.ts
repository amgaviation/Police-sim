/**
 * Chain of command (design §8.4): which ranked units respond to which trigger. Pure table lookup; the
 * runtime (`ResourceSystem`) turns the answer into `auto` requests.
 */

/** Tuning of the chain of command (code, not JSON: the design fixes these lists). */
export const CHAIN = {
  sergeantForceLevels: ['hardHands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm'],
  sergeantOnPursuit: true,
  sergeantOnExcessive: true,
  lieutenantLevels: ['major', 'disaster'],
  chiefLevels: ['disaster'],
} as const;

/** What happened that a supervisor cares about. */
export type ChainTrigger =
  | { kind: 'force'; level: string; callId: number }
  | { kind: 'verdict'; verdict: 'justified' | 'questionable' | 'excessive'; callId: number }
  | { kind: 'pursuit'; callId: number }
  | { kind: 'post'; level: 'none' | 'incident' | 'major' | 'disaster'; callId: number };

/** Ranked unit type ids the chain can dispatch. */
export type ChainType = 'supervisor' | 'lieutenant' | 'chief';

const NONE: readonly ChainType[] = [];
const SERGEANT: readonly ChainType[] = ['supervisor'];
const LIEUTENANT: readonly ChainType[] = ['lieutenant'];
const BOTH: readonly ChainType[] = ['lieutenant', 'chief'];

function listed(list: readonly string[], v: string): boolean {
  return list.includes(v);
}

/** Which ranked types to dispatch for a trigger: [] | ['supervisor'] | ['lieutenant'] | ['lieutenant', 'chief']. */
export function chainResponse(trigger: ChainTrigger): readonly ChainType[] {
  switch (trigger.kind) {
    case 'force':
      return listed(CHAIN.sergeantForceLevels, trigger.level) ? SERGEANT : NONE;
    case 'verdict':
      return CHAIN.sergeantOnExcessive && trigger.verdict === 'excessive' ? SERGEANT : NONE;
    case 'pursuit':
      return CHAIN.sergeantOnPursuit ? SERGEANT : NONE;
    case 'post':
      if (listed(CHAIN.chiefLevels, trigger.level)) return BOTH;
      return listed(CHAIN.lieutenantLevels, trigger.level) ? LIEUTENANT : NONE;
  }
}
