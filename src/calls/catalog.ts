/**
 * The call catalog (Phase 3 design §4.2, §6.2): validation of `src/data/calls/*.json` into typed
 * definitions, and the validated `CALL_CATALOG` loaded at import. Every validation error is an `Error`
 * naming the file and the JSON path (pattern: `src/cad/data.ts`).
 */
import actionsJson from '../data/calls/actions.json';
import familiesJson from '../data/calls/families.json';
import legacyJson from '../data/calls/legacy.json';
import servicesJson from '../data/calls/services.json';
import variantsJson from '../data/calls/variants.json';
import { DISPOSITIONS } from '../cad/data';
import { CRIME_CATEGORIES } from '../environment/crime';
import { TRUNK_ITEMS } from '../police/inventory';
import {
  fail,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { BRANCH_FLAG_NAMES, ROLE_FLAG_PREFIXES, SCENE_FLAG_NAMES, VARIANT_ROLES } from './cond';
import {
  ANCHORS,
  DRUG_KINDS,
  GRADES,
  ITEM_IDS,
  NPC_COMMAND_IDS,
  PROFILE_IDS,
  PROP_KINDS,
  SERVICE_EFFECTS,
  SERVICE_KINDS,
  SPOTS,
  VARIANT_KINDS,
  WEAPON_ITEM_IDS,
  type ActionDef,
  type ActionProps,
  type BranchDef,
  type CallCatalog,
  type CallTypeDef,
  type CatalogContext,
  type CatalogInput,
  type Cond,
  type FamilyDef,
  type GroundEvidenceDef,
  type ObjectiveDef,
  type OutcomeDef,
  type PersonConstraint,
  type RoleDef,
  type RoleOverrides,
  type ServiceDef,
  type ServiceKind,
  type VariantChange,
  type VariantConfig,
  type VariantKind,
  type VehicleRoleDef,
} from './types';

export * from './types';

/** Action ids every `actions.json` must define (design §4.2), besides one `request<Service>` per service kind. */
export const REQUIRED_ACTIONS: readonly string[] = [
  'knock', 'separateParties', 'perimeter', 'trafficControl', 'preserveScene', 'searchArea', 'canvass', 'photograph',
  'collectEvidence', 'evacuate', 'disperseCrowd', 'secureAnimal', 'notifyGuardian', 'firstAid', 'citeVehicle',
  'writeReport', 'contain',
];

/** Keys of a Phase 2 CAD call-type row; a family's `defaults` and a type row may carry only these (and the type extras). */
const CAD_ROW_KEYS = [
  'id', 'label', 'codeKey', 'category', 'generated', 'weight', 'priority', 'location', 'districts', 'units', 'onSceneS',
  'callers', 'narratives', 'fill', 'dispositions',
] as const;
const DEFAULT_KEYS = CAD_ROW_KEYS.filter((k) => k !== 'id' && k !== 'label' && k !== 'generated' && k !== 'weight');
const TYPE_ROW_KEYS = [...CAD_ROW_KEYS, 'branchWeights', 'variants'] as const;

/** Placeholders radio, ack and narrative texts of actions and services may use. */
const TEXT_PLACEHOLDERS = ['unit', 'address', 'near'];

const ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;
const FLAG_PATTERN = /^[a-zA-Z][a-zA-Z0-9]*$/;

// --- Readers --------------------------------------------------------------------------------------

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readPair(value: unknown, file: string, path: string, min: number, max: number, integer: boolean): [number, number] {
  const arr = readArray(value, file, path);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const read = (v: unknown, p: string): number => (integer ? readInt(v, file, p, min, max) : readNumber(v, file, p, min, max));
  const lo = read(arr[0], `${path}[0]`);
  const hi = read(arr[1], `${path}[1]`);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readStringList(value: unknown, file: string, path: string, minLength = 0): string[] {
  return readArray(value, file, path, minLength).map((v, i) => readString(v, file, `${path}[${i}]`));
}

function readId(value: unknown, file: string, path: string): string {
  const id = readString(value, file, path);
  if (!ID_PATTERN.test(id)) fail(file, path, `must match ${ID_PATTERN.source}, got ${show(id)}`);
  return id;
}

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, `${path}.${key}`, `is not one of ${allowed.join(', ')}`);
  }
}

function readChance(value: unknown, file: string, path: string): number {
  return readNumber(value, file, path, 0, 1);
}

function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? '');
}

function readText(value: unknown, file: string, path: string): string {
  const text = readString(value, file, path);
  for (const name of placeholdersOf(text)) {
    if (!TEXT_PLACEHOLDERS.includes(name)) fail(file, path, `uses unknown placeholder {${name}}`);
  }
  return text;
}

function readSet<T extends string>(value: unknown, list: readonly T[], file: string, path: string): T {
  return readOneOf(value, list, file, path);
}

// --- Condition vocabulary ----------------------------------------------------------------------------

/** What a condition atom may name: the family's roles, branches and the bare flags it can see. */
interface FlagScope {
  /** Role ids; null = unknown (action library level: arguments are not checked). */
  readonly roles: ReadonlySet<string> | null;
  readonly branches: ReadonlySet<string> | null;
  readonly bare: ReadonlySet<string> | null;
}

const NO_SCOPE: FlagScope = { roles: null, branches: null, bare: null };

function checkAtom(atom: string, scope: FlagScope, file: string, path: string): void {
  const name = atom.startsWith('!') ? atom.slice(1) : atom;
  if (name === 'true') return;
  const colon = name.indexOf(':');
  if (colon < 0) {
    if (!FLAG_PATTERN.test(name)) fail(file, path, `has a malformed flag ${show(atom)}`);
    if (scope.bare !== null && !scope.bare.has(name)) fail(file, path, `uses unknown flag ${show(name)}`);
    return;
  }
  const prefix = name.slice(0, colon);
  const arg = name.slice(colon + 1);
  if (arg === '') fail(file, path, `has an empty argument in ${show(atom)}`);
  const need = (list: ReadonlySet<string> | readonly string[] | null, what: string): void => {
    if (list === null) return;
    const has = Array.isArray(list) ? (list as readonly string[]).includes(arg) : (list as ReadonlySet<string>).has(arg);
    if (!has) fail(file, path, `${show(atom)} names an unknown ${what} ${show(arg)}`);
  };
  if (prefix === 'branch') need(scope.branches, 'branch');
  else if (prefix === 'variant') need(VARIANT_KINDS, 'variant');
  else if (prefix === 'service' || prefix === 'arrived') need(SERVICE_KINDS, 'service');
  else if (prefix === 'itemFound') need(ITEM_IDS, 'item');
  else if (ROLE_FLAG_PREFIXES.includes(prefix)) need(scope.roles, 'role');
  else fail(file, path, `uses unknown flag prefix ${show(prefix)} in ${show(atom)}`);
}

function readCond(value: unknown, scope: FlagScope, file: string, path: string): Cond {
  if (typeof value === 'string') {
    if (value === '') fail(file, path, 'must not be empty');
    checkAtom(value, scope, file, path);
    return value;
  }
  const o = readObject(value, file, path);
  const keys = Object.keys(o);
  if (keys.length !== 1) fail(file, path, `must have exactly one of all, any, not, got ${show(keys)}`);
  if (o.all !== undefined) {
    const items = readArray(o.all, file, `${path}.all`, 1);
    return { all: items.map((v, i) => readCond(v, scope, file, `${path}.all[${i}]`)) };
  }
  if (o.any !== undefined) {
    const items = readArray(o.any, file, `${path}.any`, 1);
    return { any: items.map((v, i) => readCond(v, scope, file, `${path}.any[${i}]`)) };
  }
  if (o.not !== undefined) return { not: readCond(o.not, scope, file, `${path}.not`) };
  return fail(file, path, `must have exactly one of all, any, not, got ${show(keys)}`);
}

// --- Services -----------------------------------------------------------------------------------------

function validateServices(data: unknown, file: string): Map<ServiceKind, ServiceDef> {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const out = new Map<ServiceKind, ServiceDef>();
  readArray(root.services, file, 'services', 1).forEach((v, i) => {
    const path = `services[${i}]`;
    const o = readObject(v, file, path);
    rejectUnknown(o, ['id', 'label', 'arriveS', 'effect', 'sets', 'radio', 'ack', 'arrivedText'], file, path);
    const id = readOneOf(o.id, SERVICE_KINDS, file, `${path}.id`);
    if (out.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    const sets = readStringList(o.sets, file, `${path}.sets`);
    sets.forEach((s, k) => {
      if (!FLAG_PATTERN.test(s)) fail(file, `${path}.sets[${k}]`, `must be a plain flag name, got ${show(s)}`);
    });
    out.set(id, {
      id,
      label: readString(o.label, file, `${path}.label`),
      arriveS: readPair(o.arriveS, file, `${path}.arriveS`, 1, 3600, false),
      effect: readOneOf(o.effect, SERVICE_EFFECTS, file, `${path}.effect`),
      sets,
      radio: readText(o.radio, file, `${path}.radio`),
      ack: readText(o.ack, file, `${path}.ack`),
      arrivedText: readText(o.arrivedText, file, `${path}.arrivedText`),
    });
  });
  for (const kind of SERVICE_KINDS) {
    if (!out.has(kind)) fail(file, 'services', `is missing service ${show(kind)}`);
  }
  return out;
}

// --- Actions ---------------------------------------------------------------------------------------------

function validateActions(data: unknown, file: string, trunkItems: readonly string[]): Map<string, ActionDef> {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const out = new Map<string, ActionDef>();
  readArray(root.actions, file, 'actions', 1).forEach((v, i) => {
    const path = `actions[${i}]`;
    const o = readObject(v, file, path);
    rejectUnknown(
      o,
      ['id', 'label', 'requires', 'sets', 'service', 'reveals', 'durationS', 'once', 'consumes', 'props', 'narrative', 'radio', 'command', 'opens'],
      file,
      path,
    );
    const id = readId(o.id, file, `${path}.id`);
    if (out.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    const sets = readStringList(o.sets ?? [], file, `${path}.sets`);
    sets.forEach((s, k) => {
      if (!FLAG_PATTERN.test(s)) fail(file, `${path}.sets[${k}]`, `must be a plain flag name, got ${show(s)}`);
    });
    const consumes: Record<string, number> = {};
    if (o.consumes !== undefined) {
      const c = readObject(o.consumes, file, `${path}.consumes`);
      for (const [item, n] of Object.entries(c)) {
        if (!trunkItems.includes(item)) fail(file, `${path}.consumes.${item}`, `is not a trunk item (${trunkItems.join(', ')})`);
        consumes[item] = readInt(n, file, `${path}.consumes.${item}`, 1, 20);
      }
    }
    let props: ActionProps | null = null;
    if (o.props !== undefined && o.props !== null) {
      const p = readObject(o.props, file, `${path}.props`);
      rejectUnknown(p, ['kind', 'count', 'pattern', 'spacing', 'radius'], file, `${path}.props`);
      props = {
        kind: readSet(p.kind, PROP_KINDS, file, `${path}.props.kind`),
        count: readInt(p.count, file, `${path}.props.count`, 1, 64),
        pattern: readOneOf(p.pattern, ['line', 'ring', 'point'] as const, file, `${path}.props.pattern`),
        spacing: p.spacing === undefined ? 3 : readNumber(p.spacing, file, `${path}.props.spacing`, 0.1, 100),
        radius: p.radius === undefined ? 0 : readNumber(p.radius, file, `${path}.props.radius`, 0, 200),
      };
      if (props.pattern === 'ring' && props.radius <= 0) fail(file, `${path}.props.radius`, 'must be greater than 0 for a ring');
    }
    let command: ActionDef['command'] = null;
    if (o.command !== undefined && o.command !== null) {
      const c = readObject(o.command, file, `${path}.command`);
      rejectUnknown(c, ['command', 'roles'], file, `${path}.command`);
      command = {
        command: readSet(c.command, NPC_COMMAND_IDS, file, `${path}.command.command`),
        roles: readStringList(c.roles, file, `${path}.command.roles`, 1),
      };
    }
    out.set(id, {
      id,
      label: readString(o.label, file, `${path}.label`),
      requires: o.requires === undefined || o.requires === null ? null : readCond(o.requires, NO_SCOPE, file, `${path}.requires`),
      sets,
      service: o.service === undefined || o.service === null ? null : readOneOf(o.service, SERVICE_KINDS, file, `${path}.service`),
      reveals: o.reveals === undefined || o.reveals === null ? null : readOneOf(o.reveals, ['inside', 'hidden'] as const, file, `${path}.reveals`),
      durationS: o.durationS === undefined ? 0 : readNumber(o.durationS, file, `${path}.durationS`, 0, 3600),
      once: o.once === undefined ? false : readBoolean(o.once, file, `${path}.once`),
      consumes,
      props,
      narrative: o.narrative === undefined || o.narrative === null ? null : readText(o.narrative, file, `${path}.narrative`),
      radio: o.radio === undefined || o.radio === null ? null : readText(o.radio, file, `${path}.radio`),
      command,
      opens: o.opens === undefined || o.opens === null ? null : readOneOf(o.opens, ['citation', 'report'] as const, file, `${path}.opens`),
    });
  });
  for (const id of REQUIRED_ACTIONS) {
    if (!out.has(id)) fail(file, 'actions', `is missing required action ${show(id)}`);
  }
  for (const kind of SERVICE_KINDS) {
    const id = `request${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    const a = out.get(id);
    if (!a) fail(file, 'actions', `is missing required action ${show(id)}`);
    if (a.service !== kind) fail(file, 'actions', `action ${show(id)} must request service ${show(kind)}`);
  }
  return out;
}

// --- Variants ------------------------------------------------------------------------------------------------

function validateVariants(data: unknown, file: string): VariantConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const rates = readObject(root.rates, file, 'rates');
  rejectUnknown(rates, VARIANT_KINDS, file, 'rates');
  const rateOut = {} as Record<VariantKind, number>;
  for (const kind of VARIANT_KINDS) rateOut[kind] = readChance(rates[kind], file, `rates.${kind}`);
  const timing = (key: 'escalation' | 'deescalation'): VariantConfig['escalation'] => {
    const o = readObject(root[key], file, key);
    rejectUnknown(o, ['delayS', 'priorityDelta'], file, key);
    return {
      delayS: readPair(o.delayS, file, `${key}.delayS`, 0, 3600, false),
      priorityDelta: readInt(o.priorityDelta, file, `${key}.priorityDelta`, -3, 3),
    };
  };
  const dup = readObject(root.duplicate, file, 'duplicate');
  rejectUnknown(dup, ['callers', 'delayS', 'linkedCallChance'], file, 'duplicate');
  const amb = readObject(root.ambush, file, 'ambush');
  rejectUnknown(amb, ['triggerDistanceM', 'delayS'], file, 'ambush');
  const err = readObject(root.dispatchErrors, file, 'dispatchErrors');
  rejectUnknown(err, ['wrongAddress', 'wrongDescription', 'missingWeapon', 'addressShiftM', 'correctionDelayS'], file, 'dispatchErrors');
  return {
    rates: rateOut,
    escalation: timing('escalation'),
    deescalation: timing('deescalation'),
    duplicate: {
      callers: readPair(dup.callers, file, 'duplicate.callers', 1, 10, true),
      delayS: readPair(dup.delayS, file, 'duplicate.delayS', 0, 3600, false),
      linkedCallChance: readChance(dup.linkedCallChance, file, 'duplicate.linkedCallChance'),
    },
    ambush: {
      triggerDistanceM: readNumber(amb.triggerDistanceM, file, 'ambush.triggerDistanceM', 1, 500),
      delayS: readPair(amb.delayS, file, 'ambush.delayS', 0, 600, false),
    },
    dispatchErrors: {
      wrongAddress: readChance(err.wrongAddress, file, 'dispatchErrors.wrongAddress'),
      wrongDescription: readChance(err.wrongDescription, file, 'dispatchErrors.wrongDescription'),
      missingWeapon: readChance(err.missingWeapon, file, 'dispatchErrors.missingWeapon'),
      addressShiftM: readPair(err.addressShiftM, file, 'dispatchErrors.addressShiftM', 1, 1000, false),
      correctionDelayS: readPair(err.correctionDelayS, file, 'dispatchErrors.correctionDelayS', 0, 3600, false),
    },
  };
}

// --- Families -------------------------------------------------------------------------------------------------

function readPerson(value: unknown, file: string, path: string): RoleDef['person'] {
  if (typeof value === 'string') return readOneOf(value, ['caller', 'driver', 'given'] as const, file, path);
  const o = readObject(value, file, path);
  rejectUnknown(o, ['minAge', 'maxAge', 'warrant', 'mentalHealth', 'dementia', 'risk', 'sex'], file, path);
  const out: { -readonly [K in keyof PersonConstraint]: PersonConstraint[K] } = {};
  if (o.minAge !== undefined) out.minAge = readInt(o.minAge, file, `${path}.minAge`, 0, 120);
  if (o.maxAge !== undefined) out.maxAge = readInt(o.maxAge, file, `${path}.maxAge`, 0, 120);
  if (out.minAge !== undefined && out.maxAge !== undefined && out.minAge > out.maxAge) {
    fail(file, path, `minAge ${out.minAge} is above maxAge ${out.maxAge}`);
  }
  if (o.warrant !== undefined) out.warrant = readBoolean(o.warrant, file, `${path}.warrant`);
  if (o.mentalHealth !== undefined) out.mentalHealth = readBoolean(o.mentalHealth, file, `${path}.mentalHealth`);
  if (o.dementia !== undefined) out.dementia = readBoolean(o.dementia, file, `${path}.dementia`);
  if (o.risk !== undefined) out.risk = readBoolean(o.risk, file, `${path}.risk`);
  if (o.sex !== undefined) out.sex = readOneOf(o.sex, ['M', 'F'] as const, file, `${path}.sex`);
  return out;
}

function readItems(value: unknown, file: string, path: string): { item: string; chance: number }[] {
  return readArray(value, file, path).map((v, i) => {
    const o = readObject(v, file, `${path}[${i}]`);
    rejectUnknown(o, ['item', 'chance'], file, `${path}[${i}]`);
    return { item: readSet(o.item, ITEM_IDS, file, `${path}[${i}].item`), chance: readChance(o.chance, file, `${path}[${i}].chance`) };
  });
}

function readWeapon(value: unknown, file: string, path: string): string | null {
  if (value === null) return null;
  const w = readSet(value, ITEM_IDS, file, path);
  if (!WEAPON_ITEM_IDS.includes(w)) fail(file, path, `must be a weapon item (${WEAPON_ITEM_IDS.join(', ')}), got ${show(w)}`);
  return w;
}

function readIntoxication(value: unknown, file: string, path: string): RoleDef['intoxication'] {
  if (value === null) return null;
  const o = readObject(value, file, path);
  rejectUnknown(o, ['chance', 'bac', 'drug'], file, path);
  return {
    chance: readChance(o.chance, file, `${path}.chance`),
    bac: readPair(o.bac, file, `${path}.bac`, 0, 0.5, false),
    drug: o.drug === undefined ? 'none' : readSet(o.drug, DRUG_KINDS, file, `${path}.drug`),
  };
}

const ROLE_KEYS = ['role', 'count', 'person', 'spot', 'profile', 'items', 'weapon', 'intoxication', 'injured', 'deceased', 'body', 'vehicle'];
const OVERRIDE_KEYS = ['count', 'person', 'spot', 'profile', 'items', 'weapon', 'intoxication', 'injured', 'deceased'];

function readRole(v: unknown, file: string, path: string, vehicleIds: readonly string[]): RoleDef {
  const o = readObject(v, file, path);
  rejectUnknown(o, ROLE_KEYS, file, path);
  const role = readString(o.role, file, `${path}.role`);
  if (!/^[a-zA-Z]+$/.test(role)) fail(file, `${path}.role`, `must match [a-zA-Z]+, got ${show(role)}`);
  const person = readPerson(o.person, file, `${path}.person`);
  const spot = readSet(o.spot, SPOTS, file, `${path}.spot`);
  const body = o.body === undefined ? 'human' : readOneOf(o.body, ['human', 'dog'] as const, file, `${path}.body`);
  if (body === 'dog' && (typeof person === 'string' || Object.keys(person).length > 0)) {
    fail(file, `${path}.person`, 'must be {} for a dog');
  }
  let vehicle: string | null = null;
  if (o.vehicle !== undefined && o.vehicle !== null) {
    vehicle = readString(o.vehicle, file, `${path}.vehicle`);
    if (!vehicleIds.includes(vehicle)) fail(file, `${path}.vehicle`, `names an unknown vehicle role ${show(vehicle)}`);
  } else if (vehicleIds.length === 1 && (spot === 'vehicle' || person === 'driver')) {
    vehicle = vehicleIds[0] ?? null;
  }
  if (vehicle === null && person === 'driver') fail(file, `${path}.person`, '"driver" needs a vehicle role');
  if (vehicle === null && spot === 'vehicle') fail(file, `${path}.spot`, '"vehicle" needs a vehicle role');
  return {
    role,
    count: readPair(o.count, file, `${path}.count`, 0, 20, true),
    person,
    spot,
    profile: readSet(o.profile, PROFILE_IDS, file, `${path}.profile`),
    items: o.items === undefined ? [] : readItems(o.items, file, `${path}.items`),
    weapon: o.weapon === undefined ? null : readWeapon(o.weapon, file, `${path}.weapon`),
    intoxication: o.intoxication === undefined ? null : readIntoxication(o.intoxication, file, `${path}.intoxication`),
    injured: o.injured === undefined ? 0 : readChance(o.injured, file, `${path}.injured`),
    deceased: o.deceased === undefined ? false : readBoolean(o.deceased, file, `${path}.deceased`),
    body,
    vehicle,
  };
}

function readRoleOverride(v: unknown, file: string, path: string): Partial<RoleDef> {
  const o = readObject(v, file, path);
  rejectUnknown(o, OVERRIDE_KEYS, file, path);
  const out: { -readonly [K in keyof RoleDef]?: RoleDef[K] } = {};
  if (o.count !== undefined) out.count = readPair(o.count, file, `${path}.count`, 0, 20, true);
  if (o.person !== undefined) out.person = readPerson(o.person, file, `${path}.person`);
  if (o.spot !== undefined) out.spot = readSet(o.spot, SPOTS, file, `${path}.spot`);
  if (o.profile !== undefined) out.profile = readSet(o.profile, PROFILE_IDS, file, `${path}.profile`);
  if (o.items !== undefined) out.items = readItems(o.items, file, `${path}.items`);
  if (o.weapon !== undefined) out.weapon = readWeapon(o.weapon, file, `${path}.weapon`);
  if (o.intoxication !== undefined) out.intoxication = readIntoxication(o.intoxication, file, `${path}.intoxication`);
  if (o.injured !== undefined) out.injured = readChance(o.injured, file, `${path}.injured`);
  if (o.deceased !== undefined) out.deceased = readBoolean(o.deceased, file, `${path}.deceased`);
  return out;
}

function readVehicleRole(v: unknown, file: string, path: string): VehicleRoleDef {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['role', 'count', 'mode', 'behavior', 'reported', 'flee'], file, path);
  return {
    role: readId(o.role, file, `${path}.role`),
    count: readPair(o.count, file, `${path}.count`, 0, 2, true),
    mode: readOneOf(o.mode, ['driving', 'parked', 'crashed'] as const, file, `${path}.mode`),
    behavior: o.behavior === undefined ? 'normal' : readOneOf(o.behavior, ['normal', 'dui'] as const, file, `${path}.behavior`),
    reported: o.reported === undefined ? false : readBoolean(o.reported, file, `${path}.reported`),
    flee: o.flee === undefined ? 0 : readChance(o.flee, file, `${path}.flee`),
  };
}

function readVehicleOverride(v: unknown, file: string, path: string): Partial<VehicleRoleDef> {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['count', 'mode', 'behavior', 'flee'], file, path);
  const out: { -readonly [K in keyof VehicleRoleDef]?: VehicleRoleDef[K] } = {};
  if (o.count !== undefined) out.count = readPair(o.count, file, `${path}.count`, 0, 2, true);
  if (o.mode !== undefined) out.mode = readOneOf(o.mode, ['driving', 'parked', 'crashed'] as const, file, `${path}.mode`);
  if (o.behavior !== undefined) out.behavior = readOneOf(o.behavior, ['normal', 'dui'] as const, file, `${path}.behavior`);
  if (o.flee !== undefined) out.flee = readChance(o.flee, file, `${path}.flee`);
  return out;
}

function readRoleOverrides(value: unknown, roleIds: readonly string[], file: string, path: string): RoleOverrides {
  if (value === undefined) return {};
  const o = readObject(value, file, path);
  const out: Record<string, Partial<RoleDef>> = {};
  for (const [role, ov] of Object.entries(o)) {
    if (!roleIds.includes(role)) fail(file, `${path}.${role}`, `names an unknown role ${show(role)}`);
    out[role] = readRoleOverride(ov, file, `${path}.${role}`);
  }
  return out;
}

function readRemove(value: unknown, ids: readonly string[], file: string, path: string): string[] {
  if (value === undefined) return [];
  const list = readStringList(value, file, path);
  list.forEach((id, i) => {
    if (!ids.includes(id)) fail(file, `${path}[${i}]`, `names an unknown role or vehicle role ${show(id)}`);
  });
  return list;
}

function readVariantChange(
  value: unknown,
  roleIds: readonly string[],
  allIds: readonly string[],
  file: string,
  path: string,
): VariantChange | null {
  if (value === null || value === undefined) return null;
  const o = readObject(value, file, path);
  rejectUnknown(o, ['narratives', 'roleOverrides', 'remove'], file, path);
  return {
    narratives: readStringList(o.narratives, file, `${path}.narratives`, 1),
    roleOverrides: readRoleOverrides(o.roleOverrides, roleIds, file, `${path}.roleOverrides`),
    remove: readRemove(o.remove, allIds, file, `${path}.remove`),
  };
}

function readBranch(v: unknown, roleIds: readonly string[], vehicleIds: readonly string[], derived: boolean, file: string, path: string): BranchDef {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['id', 'weight', 'flags', 'remove', 'roleOverrides', 'vehicleOverrides'], file, path);
  const flags = o.flags === undefined ? [] : readStringList(o.flags, file, `${path}.flags`);
  flags.forEach((f, i) => {
    const colon = f.indexOf(':');
    if (colon < 0) {
      if (!BRANCH_FLAG_NAMES.includes(f)) fail(file, `${path}.flags[${i}]`, `must be one of ${BRANCH_FLAG_NAMES.join(', ')} or injury:/deceased:<role>, got ${show(f)}`);
      return;
    }
    const prefix = f.slice(0, colon);
    if (prefix !== 'injury' && prefix !== 'deceased') fail(file, `${path}.flags[${i}]`, `has unknown prefix ${show(prefix)}`);
    if (!roleIds.includes(f.slice(colon + 1))) fail(file, `${path}.flags[${i}]`, `names an unknown role in ${show(f)}`);
  });
  const vehicleOverrides: Record<string, Partial<VehicleRoleDef>> = {};
  if (o.vehicleOverrides !== undefined) {
    for (const [role, ov] of Object.entries(readObject(o.vehicleOverrides, file, `${path}.vehicleOverrides`))) {
      if (!vehicleIds.includes(role)) fail(file, `${path}.vehicleOverrides.${role}`, `names an unknown vehicle role ${show(role)}`);
      vehicleOverrides[role] = readVehicleOverride(ov, file, `${path}.vehicleOverrides.${role}`);
    }
  }
  return {
    id: readId(o.id, file, `${path}.id`),
    weight: derived && o.weight === undefined ? 1 : readNumber(o.weight, file, `${path}.weight`, 0),
    flags,
    remove: readRemove(o.remove, [...roleIds, ...vehicleIds], file, `${path}.remove`),
    roleOverrides: readRoleOverrides(o.roleOverrides, roleIds, file, `${path}.roleOverrides`),
    vehicleOverrides,
  };
}

function readVariantMultipliers(value: unknown, file: string, path: string, partial: boolean): Partial<Record<VariantKind, number>> {
  const o = readObject(value, file, path);
  rejectUnknown(o, VARIANT_KINDS, file, path);
  const out: Partial<Record<VariantKind, number>> = {};
  for (const kind of VARIANT_KINDS) {
    if (o[kind] === undefined) {
      if (!partial) fail(file, `${path}.${kind}`, 'is missing');
      continue;
    }
    out[kind] = readNumber(o[kind], file, `${path}.${kind}`, 0);
  }
  return out;
}

function validateFamilies(
  data: unknown,
  file: string,
  ctx: CatalogContext,
  actions: ReadonlyMap<string, ActionDef>,
  services: ReadonlyMap<ServiceKind, ServiceDef>,
): FamilyDef[] {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const ids = new Set<string>();
  return readArray(root.families, file, 'families', 1).map((v, i): FamilyDef => {
    const path = `families[${i}]`;
    const o = readObject(v, file, path);
    rejectUnknown(
      o,
      ['id', 'label', 'anchor', 'derived', 'defaults', 'roles', 'vehicles', 'evidence', 'describe', 'branches', 'variants', 'escalation', 'deescalation', 'actions', 'objectives', 'outcomes'],
      file,
      path,
    );
    const id = readId(o.id, file, `${path}.id`);
    if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    ids.add(id);
    const derived = o.derived === undefined ? false : readBoolean(o.derived, file, `${path}.derived`);
    const anchor = readSet(o.anchor, ANCHORS, file, `${path}.anchor`);
    if (o.defaults !== undefined) {
      const defaults = readObject(o.defaults, file, `${path}.defaults`);
      rejectUnknown(defaults, DEFAULT_KEYS, file, `${path}.defaults`);
    }

    const vehicles = readArray(o.vehicles ?? [], file, `${path}.vehicles`).map((x, k) => readVehicleRole(x, file, `${path}.vehicles[${k}]`));
    const vehicleIds = vehicles.map((x) => x.role);
    vehicleIds.forEach((r, k) => {
      if (vehicleIds.indexOf(r) !== k) fail(file, `${path}.vehicles[${k}].role`, `duplicates ${show(r)}`);
    });
    const roles = readArray(o.roles, file, `${path}.roles`).map((x, k) => readRole(x, file, `${path}.roles[${k}]`, vehicleIds));
    const roleIds = roles.map((r) => r.role);
    roleIds.forEach((r, k) => {
      if (roleIds.indexOf(r) !== k) fail(file, `${path}.roles[${k}].role`, `duplicates ${show(r)}`);
      if (vehicleIds.includes(r)) fail(file, `${path}.roles[${k}].role`, `collides with a vehicle role ${show(r)}`);
    });

    const evidence = readArray(o.evidence ?? [], file, `${path}.evidence`).map((x, k): GroundEvidenceDef => {
      const e = readObject(x, file, `${path}.evidence[${k}]`);
      rejectUnknown(e, ['item', 'spot', 'chance'], file, `${path}.evidence[${k}]`);
      return {
        item: readSet(e.item, ITEM_IDS, file, `${path}.evidence[${k}].item`),
        spot: readSet(e.spot, SPOTS, file, `${path}.evidence[${k}].spot`),
        chance: readChance(e.chance, file, `${path}.evidence[${k}].chance`),
      };
    });

    let describe: string | null = null;
    if (o.describe !== undefined && o.describe !== null) {
      describe = readString(o.describe, file, `${path}.describe`);
      if (!roleIds.includes(describe)) fail(file, `${path}.describe`, `names an unknown role ${show(describe)}`);
    }

    const branches = readArray(o.branches, file, `${path}.branches`, 1).map((x, k) =>
      readBranch(x, roleIds, vehicleIds, derived, file, `${path}.branches[${k}]`),
    );
    const branchIds = branches.map((b) => b.id);
    branchIds.forEach((b, k) => {
      if (branchIds.indexOf(b) !== k) fail(file, `${path}.branches[${k}].id`, `duplicates ${show(b)}`);
    });
    if (!derived && !branches.some((b) => b.weight > 0)) fail(file, `${path}.branches`, 'needs at least one branch with weight > 0');

    const mult = readVariantMultipliers(o.variants, file, `${path}.variants`, false) as Record<VariantKind, number>;
    const escalation = readVariantChange(o.escalation, roleIds, [...roleIds, ...vehicleIds], file, `${path}.escalation`);
    const deescalation = readVariantChange(o.deescalation, roleIds, [...roleIds, ...vehicleIds], file, `${path}.deescalation`);
    if (escalation === null && mult.escalation > 0) fail(file, `${path}.escalation`, 'is null but variants.escalation is above 0');
    if (deescalation === null && mult.deescalation > 0) fail(file, `${path}.deescalation`, 'is null but variants.deescalation is above 0');

    const actionIds = readStringList(o.actions ?? [], file, `${path}.actions`);
    const bare = new Set<string>([...SCENE_FLAG_NAMES, ...BRANCH_FLAG_NAMES]);
    actionIds.forEach((a, k) => {
      if (actionIds.indexOf(a) !== k) fail(file, `${path}.actions[${k}]`, `duplicates ${show(a)}`);
      const def = actions.get(a);
      if (!def) fail(file, `${path}.actions[${k}]`, `references unknown action ${show(a)}`);
      for (const s of def.sets) bare.add(s);
      if (def.service !== null) for (const s of services.get(def.service)?.sets ?? []) bare.add(s);
    });
    const scope: FlagScope = { roles: new Set([...roleIds, ...VARIANT_ROLES]), branches: new Set(branchIds), bare };
    actionIds.forEach((a, k) => {
      const def = actions.get(a);
      if (def?.requires) {
        try {
          readCond(def.requires, scope, 'actions.json', `actions[${a}].requires`);
        } catch (e) {
          fail(file, `${path}.actions[${k}]`, `action ${show(a)} does not fit this family: ${(e as Error).message}`);
        }
      }
      if (def?.command && !def.command.roles.some((r) => roleIds.includes(r))) {
        fail(file, `${path}.actions[${k}]`, `action ${show(a)} commands roles ${def.command.roles.join(', ')}, none of which exist here`);
      }
    });

    const objectives = readArray(o.objectives ?? [], file, `${path}.objectives`).map((x, k): ObjectiveDef => {
      const p = `${path}.objectives[${k}]`;
      const ob = readObject(x, file, p);
      rejectUnknown(ob, ['text', 'done', 'show'], file, p);
      return {
        text: readString(ob.text, file, `${p}.text`),
        done: readCond(ob.done, scope, file, `${p}.done`),
        show: ob.show === undefined || ob.show === null ? null : readCond(ob.show, scope, file, `${p}.show`),
      };
    });

    const outcomeIds = new Set<string>();
    const outcomes = readArray(o.outcomes, file, `${path}.outcomes`, 1).map((x, k): OutcomeDef => {
      const p = `${path}.outcomes[${k}]`;
      const oc = readObject(x, file, p);
      rejectUnknown(oc, ['id', 'when', 'disposition', 'grade'], file, p);
      const oid = readId(oc.id, file, `${p}.id`);
      if (outcomeIds.has(oid)) fail(file, `${p}.id`, `duplicates ${show(oid)}`);
      outcomeIds.add(oid);
      return {
        id: oid,
        when: readCond(oc.when, scope, file, `${p}.when`),
        disposition: readSet(oc.disposition, ctx.dispositions, file, `${p}.disposition`),
        grade: readSet(oc.grade, GRADES, file, `${p}.grade`),
      };
    });
    if (outcomes[outcomes.length - 1]?.when !== 'true') fail(file, `${path}.outcomes`, 'the last outcome must have "when": "true"');

    return {
      id,
      label: readString(o.label, file, `${path}.label`),
      anchor,
      derived,
      roles,
      vehicles,
      evidence,
      describe,
      branches,
      variants: mult,
      escalation,
      deescalation,
      actions: actionIds,
      objectives,
      outcomes,
    };
  });
}

// --- Types ---------------------------------------------------------------------------------------------------

function validateTypes(
  files: CatalogInput['types'],
  families: readonly FamilyDef[],
  legacy: Readonly<Record<string, string>>,
  ctx: CatalogContext,
): CallTypeDef[] {
  const ids = new Set<string>();
  const out: CallTypeDef[] = [];
  files.forEach(({ file, json }) => {
    const root = readObject(json, file, '');
    readVersion(root, file);
    const familyId = readString(root.family, file, 'family');
    const family = families.find((f) => f.id === familyId);
    if (!family) fail(file, 'family', `references unknown family ${show(familyId)}`);
    readArray(root.types, file, 'types', 1).forEach((v, i) => {
      const path = `types[${i}]`;
      const o = readObject(v, file, path);
      rejectUnknown(o, TYPE_ROW_KEYS, file, path);
      const id = readId(o.id, file, `${path}.id`);
      if (ids.has(id)) fail(file, `${path}.id`, `duplicates ${show(id)}`);
      if (Object.hasOwn(legacy, id)) fail(file, `${path}.id`, `duplicates the Phase 2 type ${show(id)} listed in legacy.json`);
      ids.add(id);
      const category = readString(o.category, file, `${path}.category`);
      if (!ctx.crimeCategories.includes(category)) fail(file, `${path}.category`, `must be one of ${ctx.crimeCategories.join(', ')}, got ${show(category)}`);
      const generated = readBoolean(o.generated, file, `${path}.generated`);
      const weight = readNumber(o.weight, file, `${path}.weight`, 0);
      if (generated && weight <= 0) fail(file, `${path}.weight`, 'must be greater than 0 for a generated type');
      if (readArray(o.narratives, file, `${path}.narratives`, 2).some((n) => typeof n !== 'string')) {
        fail(file, `${path}.narratives`, 'must be strings');
      }
      const branchWeights: Record<string, number> = {};
      if (o.branchWeights !== undefined) {
        for (const [b, w] of Object.entries(readObject(o.branchWeights, file, `${path}.branchWeights`))) {
          if (!family.branches.some((x) => x.id === b)) fail(file, `${path}.branchWeights.${b}`, `names an unknown branch ${show(b)} of family ${familyId}`);
          branchWeights[b] = readNumber(w, file, `${path}.branchWeights.${b}`, 0);
        }
      }
      if (!family.derived && !family.branches.some((b) => (branchWeights[b.id] ?? b.weight) > 0)) {
        fail(file, `${path}.branchWeights`, 'leaves every branch at weight 0');
      }
      let variants: Record<VariantKind, number> | null = null;
      if (o.variants !== undefined && o.variants !== null) {
        const part = readVariantMultipliers(o.variants, file, `${path}.variants`, true);
        variants = { ...family.variants, ...part };
        if (variants.escalation > 0 && family.escalation === null) fail(file, `${path}.variants.escalation`, `family ${familyId} has no escalation`);
        if (variants.deescalation > 0 && family.deescalation === null) fail(file, `${path}.variants.deescalation`, `family ${familyId} has no deescalation`);
      }
      out.push({ id, family: familyId, label: readString(o.label, file, `${path}.label`), generated, weight, category, branchWeights, variants });
    });
  });
  return out;
}

function validateLegacy(data: unknown, file: string, families: readonly FamilyDef[]): Record<string, string> {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const map = readObject(root.families, file, 'families');
  const out: Record<string, string> = {};
  for (const [typeId, familyId] of Object.entries(map)) {
    const f = readString(familyId, file, `families.${typeId}`);
    if (!families.some((x) => x.id === f)) fail(file, `families.${typeId}`, `references unknown family ${show(f)}`);
    out[typeId] = f;
  }
  return out;
}

/** Validates the raw catalog files into typed definitions; throws an `Error` naming file and path. */
export function validateCatalog(input: CatalogInput, ctx: CatalogContext): CallCatalog {
  const services = validateServices(input.services, 'services.json');
  const actions = validateActions(input.actions, 'actions.json', ctx.trunkItems);
  const variants = validateVariants(input.variants, 'variants.json');
  const families = validateFamilies(input.families, 'families.json', ctx, actions, services);
  const legacy = validateLegacy(input.legacy, 'legacy.json', families);
  const types = validateTypes(input.types, families, legacy, ctx);
  for (const f of families) {
    if (!types.some((t) => t.family === f.id) && !Object.values(legacy).includes(f.id)) {
      fail('families.json', f.id, 'has no call type (types/*.json or legacy.json)');
    }
  }
  return { families, types, actions: [...actions.values()], services: [...services.values()], variants, legacy };
}

// --- Loading ---------------------------------------------------------------------------------------------------

function loadTypeFiles(modules: Readonly<Record<string, unknown>>): { file: string; json: unknown }[] {
  return Object.keys(modules)
    .sort()
    .map((path) => ({ file: `types/${path.slice(path.lastIndexOf('/') + 1)}`, json: modules[path] }));
}

/** The validated catalog (type files processed sorted by path: generation must not depend on the file system). */
export const CALL_CATALOG: CallCatalog = validateCatalog(
  {
    families: familiesJson,
    types: loadTypeFiles(import.meta.glob<unknown>('../data/calls/types/*.json', { eager: true, import: 'default' })),
    actions: actionsJson,
    services: servicesJson,
    variants: variantsJson,
    legacy: legacyJson,
  },
  {
    dispositions: DISPOSITIONS.map((d) => d.id),
    crimeCategories: CRIME_CATEGORIES,
    trunkItems: TRUNK_ITEMS.map((t) => t.id),
  },
);

const FAMILY_BY_ID = new Map(CALL_CATALOG.families.map((f) => [f.id, f]));
const TYPE_BY_ID = new Map(CALL_CATALOG.types.map((t) => [t.id, t]));
const ACTION_BY_ID = new Map(CALL_CATALOG.actions.map((a) => [a.id, a]));
const SERVICE_BY_ID = new Map(CALL_CATALOG.services.map((s) => [s.id, s]));

/** Family of a call type: catalog types first, then `legacy.json`; null for officer-initiated types (no scene). */
export function familyForType(typeId: string): FamilyDef | null {
  const t = TYPE_BY_ID.get(typeId);
  if (t) return FAMILY_BY_ID.get(t.family) ?? null;
  const legacyId = Object.hasOwn(CALL_CATALOG.legacy, typeId) ? CALL_CATALOG.legacy[typeId] : undefined;
  return legacyId === undefined ? null : (FAMILY_BY_ID.get(legacyId) ?? null);
}

/** Phase 3 type definition; null for Phase 2 types (see `familyForType`) and unknown ids. */
export function callTypeDef(typeId: string): CallTypeDef | null {
  return TYPE_BY_ID.get(typeId) ?? null;
}

/** Family by id; null when unknown. */
export function familyDef(id: string): FamilyDef | null {
  return FAMILY_BY_ID.get(id) ?? null;
}

/** Action by id; throws on an unknown id. */
export function actionDef(id: string): ActionDef {
  const a = ACTION_BY_ID.get(id);
  if (!a) throw new Error(`Unknown scene action ${show(id)}`);
  return a;
}

/** Service by kind; throws on an unknown kind. */
export function serviceDef(id: ServiceKind): ServiceDef {
  const s = SERVICE_BY_ID.get(id);
  if (!s) throw new Error(`Unknown service ${show(id)}`);
  return s;
}
