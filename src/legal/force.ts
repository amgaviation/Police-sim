import { FORCE_LEVELS, RESISTANCE_LEVELS, type ForceLevel, type ForceVerdict, type Resistance, type Ruleset } from './types';

/** The facts of one use of force that the continuum judges. */
export interface ForceInput {
  level: ForceLevel;
  tool: string;
  resistance: Resistance;
  cycle: number;
  riskFactors: readonly string[];
  restrained: boolean;
}

export interface ForceVerdictResult {
  verdict: ForceVerdict;
  maxAllowed: ForceLevel;
  factors: string[];
  ruleIds: string[];
}

/** Index of `r` in `RESISTANCE_LEVELS` (compliant 0 .. lethal 4). */
export function resistanceRank(r: Resistance): number {
  return RESISTANCE_LEVELS.indexOf(r);
}

/** Judges one application of force against the ruleset's continuum (design §5.6). */
export function forceVerdict(e: ForceInput, rs: Ruleset): ForceVerdictResult {
  const f = rs.force;
  const lvl = f.levels[e.level];
  const max = f.maxByResistance[e.resistance];
  let maxAllowed: ForceLevel = 'presence';
  for (const level of FORCE_LEVELS) if (f.levels[level] <= max) maxAllowed = level;
  const result = (verdict: ForceVerdict, ruleIds: string[], factors: string[] = []): ForceVerdictResult => ({ verdict, maxAllowed, factors, ruleIds });

  if (e.level === 'presence') {
    if (e.tool === 'firearmDisplay' && resistanceRank(e.resistance) < resistanceRank(f.displayFirearmMin)) {
      return result('questionable', [f.displayRuleId], ['display']);
    }
    return result('justified', [f.ruleId]);
  }
  if (e.restrained && lvl > f.levels.softHands) return result('excessive', [f.restrainedRuleId], ['restrained']);
  if (e.level === 'firearm' && e.resistance !== 'lethal') return result('excessive', [f.lethalRuleId], ['lethal']);
  if (e.level === 'taser') {
    if (e.cycle > f.taser.maxCycles) return result('excessive', [f.taser.cycleRuleId], ['cycles']);
    const risk = e.riskFactors.filter((r) => f.taser.riskFactors.includes(r));
    if (risk.length > 0 && resistanceRank(e.resistance) < resistanceRank(f.taser.riskAllowedAt)) {
      return result('excessive', [f.taser.riskRuleId], risk);
    }
  }
  if (lvl <= max) return result('justified', [f.ruleId]);
  if (lvl <= max + 1) return result('questionable', [f.ruleId]);
  return result('excessive', [f.ruleId]);
}
