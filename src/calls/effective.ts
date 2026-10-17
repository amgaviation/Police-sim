/**
 * Effective roles and vehicles of a scenario (design §6.3 step 2): the family definitions with a
 * branch's `remove` / overrides applied, and the role rewrites of the `false`, `swatting` and `ambush`
 * variants. Pure; shared by the scenario builder and the flag/reachability analysis.
 */
import type { BranchDef, FamilyDef, PersonConstraint, RoleDef, VariantKind, VehicleRoleDef } from './types';

/** Roles that survive a `false` variant (nobody else is really there). */
export const REPORTER_ROLES: readonly string[] = ['caller', 'reporter', 'requester'];

/** The resident the `swatting` variant adds (a victim of the false report). */
export const SWATTING_RESIDENT: RoleDef = {
  role: 'resident',
  count: [1, 1],
  person: { minAge: 18 },
  spot: 'door',
  profile: 'residentInnocent',
  items: [],
  weapon: null,
  intoxication: null,
  injured: 0,
  deceased: false,
  body: 'human',
  vehicle: null,
};

/** The armed subject the `ambush` variant adds. */
export const AMBUSHER: RoleDef = {
  role: 'ambusher',
  count: [1, 1],
  person: { minAge: 18, risk: true } satisfies PersonConstraint,
  spot: 'hidden',
  profile: 'ambusher',
  items: [],
  weapon: 'handgun',
  intoxication: null,
  injured: 0,
  deceased: false,
  body: 'human',
  vehicle: null,
};

/** A role with an override applied (override keys win; absent keys keep the base value). */
export function applyRoleOverride(base: RoleDef, ov: Partial<RoleDef> | undefined): RoleDef {
  if (!ov) return base;
  return { ...base, ...ov, role: base.role };
}

/** A vehicle role with an override applied. */
export function applyVehicleOverride(base: VehicleRoleDef, ov: Partial<VehicleRoleDef> | undefined): VehicleRoleDef {
  if (!ov) return base;
  return { ...base, ...ov, role: base.role };
}

/** Family vehicle roles after the branch's `remove` and `vehicleOverrides`. */
export function effectiveVehicles(family: FamilyDef, branch: BranchDef): VehicleRoleDef[] {
  const out: VehicleRoleDef[] = [];
  for (const v of family.vehicles) {
    if (branch.remove.includes(v.role)) continue;
    out.push(applyVehicleOverride(v, branch.vehicleOverrides[v.role]));
  }
  return out;
}

/**
 * Family roles after the branch's `remove` and `roleOverrides`. A role whose vehicle role was removed
 * keeps no vehicle, and a `vehicle` spot becomes `curb`.
 */
export function effectiveRoles(family: FamilyDef, branch: BranchDef): RoleDef[] {
  const out: RoleDef[] = [];
  for (const r of family.roles) {
    if (branch.remove.includes(r.role)) continue;
    let role = applyRoleOverride(r, branch.roleOverrides[r.role]);
    if (role.vehicle !== null && branch.remove.includes(role.vehicle)) {
      role = { ...role, vehicle: null, spot: role.spot === 'vehicle' ? 'curb' : role.spot };
    }
    out.push(role);
  }
  return out;
}

/**
 * Applies the role-rewriting variants: `false` keeps only the reporter-like roles, `swatting` keeps
 * only `caller` and adds a resident, `ambush` keeps only `caller` and adds the ambusher. These variants
 * also remove every vehicle (there is no real incident). Escalation and de-escalation do not rewrite
 * the build (the scene applies the family overrides at their timeline entry).
 */
export function applyVariantRoles(
  roles: readonly RoleDef[],
  vehicles: readonly VehicleRoleDef[],
  variants: readonly VariantKind[],
): { roles: RoleDef[]; vehicles: VehicleRoleDef[] } {
  const detach = (r: RoleDef): RoleDef => ({ ...r, vehicle: null, spot: r.spot === 'vehicle' ? 'curb' : r.spot });
  if (variants.includes('swatting')) {
    return { roles: [...roles.filter((r) => r.role === 'caller').map(detach), SWATTING_RESIDENT], vehicles: [] };
  }
  if (variants.includes('ambush')) {
    return { roles: [...roles.filter((r) => r.role === 'caller').map(detach), AMBUSHER], vehicles: [] };
  }
  if (variants.includes('false')) {
    return { roles: roles.filter((r) => REPORTER_ROLES.includes(r.role)).map(detach), vehicles: [] };
  }
  return { roles: [...roles], vehicles: [...vehicles] };
}

/** Roles that can have a participant (max count at least 1). */
export function presentRoles(roles: readonly RoleDef[]): RoleDef[] {
  return roles.filter((r) => r.count[1] >= 1);
}
