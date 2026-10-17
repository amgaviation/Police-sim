/**
 * Conditions, outcomes and reachability (Phase 3 design §6.4, §11.3): first-match outcomes, shown
 * objectives, the set of flags a family/branch can produce, and a DNF-witness reachability check used
 * by the catalog tests (every outcome must be reachable).
 */
import { CALL_CATALOG } from './catalog';
import { evalCond, toDnf, type Term } from './cond';
import { applyVariantRoles, effectiveRoles, effectiveVehicles, presentRoles } from './effective';
import {
  CONTRABAND_ITEM_IDS,
  WEAPON_ITEM_IDS,
  type BranchDef,
  type CallCatalog,
  type FamilyDef,
  type OutcomeDef,
  type RoleDef,
  type VariantKind,
} from './types';

export { condAtoms, evalCond } from './cond';

/** First outcome whose condition holds (the last one is `"true"`). */
export function outcomeFor(family: FamilyDef, flags: ReadonlySet<string>): OutcomeDef {
  for (const o of family.outcomes) if (evalCond(o.when, flags)) return o;
  const last = family.outcomes[family.outcomes.length - 1];
  if (!last) throw new Error(`Family ${family.id} has no outcomes`);
  return last;
}

/** Objectives shown for these flags (`show` holds or is absent), with their done state. */
export function objectivesFor(family: FamilyDef, flags: ReadonlySet<string>): { text: string; done: boolean }[] {
  const out: { text: string; done: boolean }[] = [];
  for (const o of family.objectives) {
    if (o.show !== null && !evalCond(o.show, flags)) continue;
    out.push({ text: o.text, done: evalCond(o.done, flags) });
  }
  return out;
}

/** Person-role flags any present human role can get from contact, npc and scene events. */
const PERSON_FLAGS = [
  'contacted', 'statement', 'identified', 'falseIdentity', 'custody', 'caged', 'warned', 'released', 'searched', 'frisked',
  'calmed', 'fled', 'escaped', 'caught', 'detained', 'weaponDrawn', 'left', 'citation',
];

function canBeJuvenile(role: RoleDef): boolean {
  if (typeof role.person === 'string') return true;
  return role.person.minAge === undefined || role.person.minAge < 18;
}

/**
 * Every flag a family can produce in this branch (design §11.3): role-scoped flags of the present
 * person roles (`transported:` only with `requestEms`; `found:` / `revealed:` for hidden or inside spots
 * and `missing` roles), item flags, breath/field-test flags for intoxication (and `trafficStop`/`dui`),
 * pursuit flags for fleeing vehicles, variant flags, action and service flags, `report`, `cited`,
 * `forceUsed`, and `attacked` / `shotsFired` for armed roles or the ambush variant.
 */
export function producibleFlags(family: FamilyDef, branch: BranchDef, catalog: CallCatalog = CALL_CATALOG): Set<string> {
  const flags = new Set<string>(['arrived', 'report', 'cited', 'forceUsed']);
  const roles = presentRoles(effectiveRoles(family, branch));
  const vehicles = effectiveVehicles(family, branch).filter((v) => v.count[1] >= 1);
  const hasEms = family.actions.includes('requestEms');
  const fieldTests = family.id === 'trafficStop' || family.id === 'dui' || roles.some((r) => r.intoxication !== null);
  let armed = family.variants.ambush > 0;
  const escalationArms = family.variants.escalation > 0 && family.escalation !== null &&
    Object.values(family.escalation.roleOverrides).some((o) => o.weapon !== undefined && o.weapon !== null);
  if (escalationArms) armed = true;
  const items = new Set<string>();
  for (const e of family.evidence) items.add(e.item);

  for (const r of roles) {
    flags.add(`role:${r.role}`);
    flags.add(`near:${r.role}`);
    for (const i of r.items) items.add(i.item);
    if (r.weapon !== null) {
      items.add(r.weapon);
      armed = true;
    }
    if (r.body === 'dog') continue;
    for (const f of PERSON_FLAGS) flags.add(`${f}:${r.role}`);
    if (canBeJuvenile(r)) flags.add(`juvenile:${r.role}`);
    if (hasEms) flags.add(`transported:${r.role}`);
    if (r.spot === 'hidden' || r.spot === 'inside' || r.role === 'missing') {
      flags.add(`found:${r.role}`);
      flags.add(`revealed:${r.role}`);
    }
    if (fieldTests) {
      flags.add(`pbt:${r.role}`);
      flags.add(`sfst:${r.role}`);
    }
  }
  if (fieldTests) {
    flags.add('bacOver');
    flags.add('sfstFail');
  }
  for (const item of items) {
    flags.add(`itemFound:${item}`);
    if (WEAPON_ITEM_IDS.includes(item)) flags.add('weaponFound');
    if (CONTRABAND_ITEM_IDS.includes(item)) flags.add('contrabandFound');
  }
  if (armed) {
    flags.add('attacked');
    flags.add('shotsFired');
  }
  if (vehicles.some((v) => v.flee > 0) || family.id === 'pursuit') {
    for (const f of ['pursuit', 'pursuitLost', 'pursuitEnded', 'vehicleStopped']) flags.add(f);
  }
  if (family.id === 'trafficStop') flags.add('vehicleStopped');
  if (family.variants.escalation > 0) flags.add('escalated');
  if (family.variants.deescalation > 0) flags.add('deescalated');

  for (const id of family.actions) {
    const action = catalog.actions.find((a) => a.id === id);
    if (!action) continue;
    for (const s of action.sets) flags.add(s);
    if (action.command?.command === 'disperse') flags.add('crowdDispersed');
    if (action.service !== null) {
      flags.add(`service:${action.service}`);
      flags.add(`arrived:${action.service}`);
      const service = catalog.services.find((s) => s.id === action.service);
      for (const s of service?.sets ?? []) flags.add(s);
    }
  }
  return flags;
}

export interface Reachability {
  readonly outcome: string;
  readonly reachable: boolean;
  /** A flag set for which `outcomeFor` returns the outcome (empty when unreachable). */
  readonly witness: readonly string[];
}

/** Variant sets tried by the reachability check: none, then each enabled kind alone (design §6.4). */
function variantSets(family: FamilyDef): VariantKind[][] {
  const sets: VariantKind[][] = [[]];
  const order: VariantKind[] = ['false', 'swatting', 'ambush', 'duplicate', 'escalation', 'deescalation'];
  for (const k of order) if (family.variants[k] > 0) sets.push([k]);
  return sets;
}

/**
 * Makes `witness` stop matching earlier outcomes by adding producible flags that falsify their negated
 * atoms (e.g. `!service:ems` is falsified by `service:ems`). Returns false when an earlier outcome cannot
 * be avoided.
 */
function repairShadows(family: FamilyDef, target: OutcomeDef, witness: Set<string>, forbidden: ReadonlySet<string>, producible: ReadonlySet<string>): boolean {
  for (let guard = 0; guard < 16; guard++) {
    const hit = outcomeFor(family, witness);
    if (hit.id === target.id) return true;
    if (family.outcomes.indexOf(hit) > family.outcomes.indexOf(target)) return false;
    let fixedOne = false;
    for (const term of toDnf(hit.when)) {
      if (!term.pos.every((p) => witness.has(p)) || term.neg.some((n) => witness.has(n))) continue;
      const add = term.neg.find((n) => producible.has(n) && !forbidden.has(n));
      if (add === undefined) continue;
      witness.add(add);
      fixedOne = true;
      break;
    }
    if (!fixedOne) return false;
  }
  return false;
}

/**
 * For each outcome: is there a branch, variant set and satisfiable DNF term whose witness flag set
 * makes `outcomeFor` return it (design §6.4)? Earlier outcomes that would shadow a term are avoided by
 * adding producible flags that falsify their negated atoms.
 */
export function reachableOutcomes(family: FamilyDef, catalog: CallCatalog = CALL_CATALOG): Reachability[] {
  const result = new Map<string, readonly string[]>();
  for (const branch of family.branches) {
    const producible = producibleFlags(family, branch, catalog);
    for (const variants of variantSets(family)) {
      const baseRoles = effectiveRoles(family, branch);
      const baseVehicles = effectiveVehicles(family, branch);
      const { roles } = applyVariantRoles(baseRoles, baseVehicles, variants);
      const fixed = new Set<string>([`branch:${branch.id}`, ...branch.flags]);
      for (const v of variants) fixed.add(`variant:${v}`);
      for (const r of presentRoles(roles)) fixed.add(`role:${r.role}`);
      for (const outcome of family.outcomes) {
        if (result.has(outcome.id)) continue;
        const terms: Term[] = toDnf(outcome.when);
        for (const term of terms) {
          if (!term.pos.every((p) => fixed.has(p) || producible.has(p))) continue;
          if (term.neg.some((n) => fixed.has(n))) continue;
          const witness = new Set<string>([...fixed, ...term.pos]);
          const forbidden = new Set<string>([...term.neg, ...fixed]);
          if (!repairShadows(family, outcome, witness, forbidden, producible)) continue;
          result.set(outcome.id, [...witness]);
          break;
        }
      }
    }
  }
  return family.outcomes.map((o) => {
    const witness = result.get(o.id);
    return { outcome: o.id, reachable: witness !== undefined, witness: witness ?? [] };
  });
}
