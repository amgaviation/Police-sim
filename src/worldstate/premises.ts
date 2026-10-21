import { WORLD_CONFIG, type PremisesConfig } from './data';
import { PREMISE_FLAGS, type PremiseEntry, type PremiseFlag, type PremiseRecord } from './types';

/** Premise history rules (Phase 8 design §6.3). Pure. */

const DAY_S = 86400;

/** Upper case, trimmed, inner whitespace collapsed: '1240 n oak  street' -> '1240 N OAK STREET'. */
export function premiseKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toUpperCase();
}

export interface PremiseFlagInput {
  disposition: string;
  category: string;
  familyId: string | null;
  weaponSeen: boolean;
  forceUsed: boolean;
  officerInjured: boolean;
  drugsFound: boolean;
}

/**
 * Flags of a closed call (in `PREMISE_FLAGS` order): arrest (disposition arrestMade), weapon (weaponSeen), violence
 * (category assault | domestic | robbery), officerSafety (forceUsed | officerInjured), drugs (category dui | drugsFound),
 * mentalHealth (family 'crisis').
 */
export function premiseFlagsFor(i: Readonly<PremiseFlagInput>): PremiseFlag[] {
  const on: Record<PremiseFlag, boolean> = {
    weapon: i.weaponSeen,
    violence: i.category === 'assault' || i.category === 'domestic' || i.category === 'robbery',
    arrest: i.disposition === 'arrestMade',
    officerSafety: i.forceUsed || i.officerInjured,
    drugs: i.category === 'dui' || i.drugsFound,
    mentalHealth: i.familyId === 'crisis',
    repeat: false,
  };
  return PREMISE_FLAGS.filter((f) => on[f]);
}

/**
 * Adds an entry (newest last, oldest dropped beyond `entriesPerPremise`); adds 'repeat' to the new entry's flags when at
 * least `repeatThreshold` entries (including it) lie within `repeatWindowDays` of it. Mutates `p` and `e.flags`.
 */
export function addPremiseEntry(p: PremiseRecord, e: PremiseEntry, cfg: PremisesConfig = WORLD_CONFIG.premises): void {
  p.entries.push(e);
  while (p.entries.length > cfg.entriesPerPremise) p.entries.shift();
  const since = e.game - cfg.repeatWindowDays * DAY_S;
  let recent = 0;
  for (const x of p.entries) if (x.game >= since && x.game <= e.game) recent++;
  if (recent >= cfg.repeatThreshold && !e.flags.includes('repeat')) e.flags.push('repeat');
}
