/* The fixtures break the shipped JSON files on purpose, so they are mutated as untyped objects. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
import { describe, expect, it } from 'vitest';
import { CALL_TYPES } from '../../src/cad/data';
import {
  ANCHORS,
  CALL_CATALOG,
  ITEM_IDS,
  NPC_COMMAND_IDS,
  PROFILE_IDS,
  SERVICE_KINDS,
  SPOTS,
  VARIANT_KINDS,
  actionDef,
  callTypeDef,
  familyForType,
  serviceDef,
} from '../../src/calls/catalog';
import { EXPECTED_FAMILIES, EXPECTED_TYPES } from './expected';
import { family, rawInput, validateRaw, type Json, type Raw } from './helpers';

const fixtures = (mutate: (raw: Raw) => void, pattern: RegExp): void => {
  const raw = rawInput();
  mutate(raw);
  expect(() => validateRaw(raw)).toThrow(pattern);
};

describe('call catalog', () => {
  it('loads and matches the design lists', () => {
    expect(ITEM_IDS).toHaveLength(26);
    expect(PROFILE_IDS).toHaveLength(32);
    expect(SERVICE_KINDS).toHaveLength(11);
    expect(VARIANT_KINDS).toHaveLength(6);
    expect(SPOTS).toHaveLength(10);
    expect(ANCHORS).toHaveLength(7);
    expect(NPC_COMMAND_IDS).toHaveLength(17);
    expect(CALL_CATALOG.families.map((f) => f.id)).toEqual(EXPECTED_FAMILIES);
    expect(CALL_CATALOG.families).toHaveLength(27);
    expect(CALL_CATALOG.services.map((s) => s.id).sort()).toEqual([...SERVICE_KINDS].sort());
  });

  it('ships exactly the 163 Phase 3 types of design 4.3, in family files', () => {
    expect(CALL_CATALOG.types.length).toBeGreaterThanOrEqual(150);
    expect(CALL_CATALOG.types).toHaveLength(163);
    const byFamily: Record<string, string[]> = {};
    for (const t of CALL_CATALOG.types) (byFamily[t.family] ??= []).push(t.id);
    expect(byFamily).toEqual(EXPECTED_TYPES);
    expect(new Set(CALL_CATALOG.types.map((t) => t.id)).size).toBe(163);
  });

  it('gives every family at least one type (legacy Phase 2 types count)', () => {
    for (const f of CALL_CATALOG.families) {
      const n = CALL_CATALOG.types.filter((t) => t.family === f.id).length;
      const legacy = Object.values(CALL_CATALOG.legacy).filter((x) => x === f.id).length;
      expect(n + legacy, f.id).toBeGreaterThan(0);
    }
    expect(CALL_CATALOG.legacy.trafficStop).toBe('trafficStop');
  });

  it('turns every catalog type into a valid CAD row, with no duplicate ids and all 175 present', () => {
    const ids = CALL_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(175);
    for (const t of CALL_CATALOG.types) {
      const row = CALL_TYPES.find((c) => c.id === t.id);
      expect(row, t.id).toBeDefined();
      expect(row?.category).toBe(t.category);
      expect(row?.generated).toBe(t.generated);
      expect(row?.weight).toBe(t.weight);
      expect(row?.narratives.length).toBeGreaterThanOrEqual(2);
    }
    for (const legacyId of Object.keys(CALL_CATALOG.legacy)) expect(ids).toContain(legacyId);
  });

  it('merges family defaults under the row (row wins) and falls back for missing keys', () => {
    const impaired = CALL_TYPES.find((t) => t.id === 'impairedDriver');
    expect(impaired?.priority).toEqual([0, 0.5, 0.5, 0]);
    expect(impaired?.location).toBe('road');
    expect(impaired?.units).toEqual([1, 1]);
    const wrongWay = CALL_TYPES.find((t) => t.id === 'wrongWayDriver');
    expect(wrongWay?.priority).toEqual([0.5, 0.5, 0, 0]);
    const ledge = CALL_TYPES.find((t) => t.id === 'personOnLedge');
    expect(ledge?.location).toBe('poi:harbor');
    expect(CALL_TYPES.find((t) => t.id === 'vehiclePursuit')?.codeKey).toBe('pursuit');
    expect(CALL_TYPES.find((t) => t.id === 'shotsFired')?.codeKey).toBe('shotsFired');
    // The default disposition (first) is the family's default outcome.
    expect(CALL_TYPES.find((t) => t.id === 'domesticDisturbance')?.dispositions[0]).toBe('handled');
    expect(CALL_TYPES.find((t) => t.id === 'burglaryCold')?.dispositions[0]).toBe('reportTaken');
    expect(CALL_TYPES.find((t) => t.id === 'childCustodyDispute')?.dispositions).toContain('referred');
  });

  it('never repeats the street name in a catalog narrative (each location placeholder at most once)', () => {
    for (const t of CALL_TYPES) {
      for (const template of t.narratives) {
        const locations = (template.match(/\{(street|near|address)\}/g) ?? []).length;
        expect(locations, `${t.id}: ${template}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('references only existing actions, services, profiles, items, roles and branches', () => {
    const actions = new Set(CALL_CATALOG.actions.map((a) => a.id));
    for (const f of CALL_CATALOG.families) {
      for (const a of f.actions) expect(actions.has(a), `${f.id}: ${a}`).toBe(true);
      const roleIds = f.roles.map((r) => r.role);
      for (const r of f.roles) {
        expect(PROFILE_IDS as readonly string[]).toContain(r.profile);
        for (const i of r.items) expect(ITEM_IDS as readonly string[]).toContain(i.item);
      }
      for (const b of f.branches) {
        for (const r of Object.keys(b.roleOverrides)) expect(roleIds).toContain(r);
        for (const id of b.remove) expect([...roleIds, ...f.vehicles.map((v) => v.role)]).toContain(id);
      }
      for (const t of CALL_CATALOG.types.filter((x) => x.family === f.id)) {
        for (const b of Object.keys(t.branchWeights)) expect(f.branches.map((x) => x.id), t.id).toContain(b);
      }
      expect(f.outcomes[f.outcomes.length - 1]?.when).toBe('true');
    }
    for (const a of CALL_CATALOG.actions) if (a.service) expect(serviceDef(a.service).id).toBe(a.service);
    for (const kind of SERVICE_KINDS) {
      const id = `request${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
      expect(actionDef(id).service).toBe(kind);
    }
  });

  it('looks up families and types', () => {
    expect(familyForType('domesticDisturbance')?.id).toBe('domestic');
    expect(familyForType('noiseComplaint')?.id).toBe('disturbance');
    expect(familyForType('trafficStop')?.id).toBe('trafficStop');
    expect(familyForType('officerAssist')).toBeNull();
    expect(familyForType('nope')).toBeNull();
    expect(callTypeDef('robbery')?.family).toBe('violent');
    expect(callTypeDef('noiseComplaint')).toBeNull();
    expect(() => actionDef('nope')).toThrow(/nope/);
    expect(familyForType('toString')).toBeNull();
  });

  it('flags the derived families', () => {
    expect(CALL_CATALOG.families.filter((f) => f.derived).map((f) => f.id)).toEqual(['trafficStop', 'contact']);
  });
});

describe('catalog validator failures (file and path named)', () => {
  it('accepts the shipped files', () => {
    expect(() => validateRaw(rawInput())).not.toThrow();
  });

  it('services', () => {
    fixtures((r) => { (r.services.services as Json[]).pop(); }, /services\.json: services is missing service/);
    fixtures((r) => { r.services.services[0].effect = 'explode'; }, /services\.json: services\[0\]\.effect must be one of/);
    fixtures((r) => { r.services.services[0].radio = 'Go to {moon}.'; }, /services\.json: services\[0\]\.radio uses unknown placeholder \{moon\}/);
    fixtures((r) => { r.services.services[1].id = 'ems'; }, /services\.json: services\[1\]\.id duplicates "ems"/);
    fixtures((r) => { r.services.services[0].arriveS = [200, 100]; }, /services\.json: services\[0\]\.arriveS must be \[min, max\]/);
    fixtures((r) => { r.services.version = 2; }, /services\.json: version must be 1/);
  });

  it('actions', () => {
    fixtures((r) => { r.actions.actions = (r.actions.actions as Json[]).filter((a) => a.id !== 'knock'); }, /actions\.json: actions is missing required action "knock"/);
    fixtures((r) => { r.actions.actions = (r.actions.actions as Json[]).filter((a) => a.id !== 'requestSwat'); }, /actions\.json: actions is missing required action "requestSwat"/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'requestTow')!.service = 'ems'; }, /actions\.json: actions action "requestTow" must request service "tow"/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'firstAid')!.consumes = { medkit: 1 }; }, /actions\.json: actions\[\d+\]\.consumes\.medkit is not a trunk item/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'perimeter')!.props.kind = 'balloon'; }, /actions\.json: actions\[\d+\]\.props\.kind must be one of/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'perimeter')!.props.radius = 0; }, /props\.radius must be greater than 0 for a ring/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'knock')!.requires = 'bogus:thing'; }, /actions\[\d+\]\.requires uses unknown flag prefix "bogus"/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'disperseCrowd')!.command.command = 'dance'; }, /command\.command must be one of/);
    fixtures((r) => { (r.actions.actions as Json[]).find((a) => a.id === 'knock')!.reveals = 'upstairs'; }, /actions\[\d+\]\.reveals must be one of inside, hidden/);
    fixtures((r) => { (r.actions.actions as Json[])[1]!.id = 'knock'; }, /actions\.json: actions\[1\]\.id duplicates "knock"/);
    fixtures((r) => { (r.actions.actions as Json[])[0]!.sets = ['not a flag']; }, /actions\[0\]\.sets\[0\] must be a plain flag name/);
    fixtures((r) => { (r.actions.actions as Json[])[0]!.mystery = 1; }, /actions\[0\]\.mystery is not one of/);
  });

  it('variants', () => {
    fixtures((r) => { delete r.variants.rates.swatting; }, /variants\.json: rates\.swatting/);
    fixtures((r) => { r.variants.rates.false = 1.5; }, /variants\.json: rates\.false must be in \[0, 1\]/);
    fixtures((r) => { r.variants.duplicate.callers = [0, 2]; }, /variants\.json: duplicate\.callers\[0\]/);
    fixtures((r) => { r.variants.dispatchErrors.addressShiftM = [120, 40]; }, /variants\.json: dispatchErrors\.addressShiftM must be \[min, max\]/);
  });

  it('legacy', () => {
    fixtures((r) => { r.legacy.families.alarm = 'nowhere'; }, /legacy\.json: families\.alarm references unknown family "nowhere"/);
  });

  it('family structure', () => {
    fixtures((r) => { r.families.families[1].id = 'trafficStop'; }, /families\.json: families\[1\]\.id duplicates "trafficStop"/);
    fixtures((r) => { family(r, 'domestic').anchor = 'roof'; }, /families\.json: families\[\d+\]\.anchor must be one of/);
    fixtures((r) => { family(r, 'domestic').mystery = 1; }, /families\.json: families\[\d+\]\.mystery is not one of/);
    fixtures((r) => { family(r, 'domestic').defaults.mystery = 1; }, /families\[\d+\]\.defaults\.mystery is not one of/);
    fixtures((r) => { family(r, 'domestic').roles[0].profile = 'cheerful'; }, /families\.json: families\[\d+\]\.roles\[0\]\.profile must be one of/);
    fixtures((r) => { family(r, 'domestic').roles[2].items = [{ item: 'rocket', chance: 0.5 }]; }, /roles\[2\]\.items\[0\]\.item must be one of/);
    fixtures((r) => { family(r, 'domestic').roles[2].items = [{ item: 'knife', chance: 1.5 }]; }, /roles\[2\]\.items\[0\]\.chance must be in \[0, 1\]/);
    fixtures((r) => { family(r, 'domestic').roles[2].weapon = 'phone'; }, /roles\[2\]\.weapon must be a weapon item/);
    fixtures((r) => { family(r, 'domestic').roles[0].spot = 'moon'; }, /roles\[0\]\.spot must be one of/);
    fixtures((r) => { family(r, 'domestic').roles[0].count = [3, 1]; }, /roles\[0\]\.count must be \[min, max\]/);
    fixtures((r) => { family(r, 'domestic').roles[0].count = [0, 99]; }, /roles\[0\]\.count\[1\] must be in \[0, 20\]/);
    fixtures((r) => { family(r, 'domestic').roles[1].person = { minAge: 50, maxAge: 20 }; }, /roles\[1\]\.person minAge 50 is above maxAge 20/);
    fixtures((r) => { family(r, 'domestic').roles[1].person = 'nobody'; }, /roles\[1\]\.person must be one of caller, driver, given/);
    fixtures((r) => { family(r, 'domestic').roles[1].person = { age: 4 }; }, /roles\[1\]\.person\.age is not one of/);
    fixtures((r) => { family(r, 'domestic').roles[1].person = 'driver'; }, /roles\[1\]\.person "driver" needs a vehicle role/);
    fixtures((r) => { family(r, 'domestic').roles[1].spot = 'vehicle'; }, /roles\[1\]\.spot "vehicle" needs a vehicle role/);
    fixtures((r) => { family(r, 'domestic').roles[1].vehicle = 'ghost'; }, /roles\[1\]\.vehicle names an unknown vehicle role "ghost"/);
    fixtures((r) => { family(r, 'domestic').roles[1].role = 'caller'; }, /roles\[1\]\.role duplicates "caller"/);
    fixtures((r) => { family(r, 'animal').roles[1].person = { minAge: 18 }; }, /roles\[1\]\.person must be \{\} for a dog/);
    fixtures((r) => { family(r, 'dui').vehicles[0].mode = 'flying'; }, /vehicles\[0\]\.mode must be one of/);
    fixtures((r) => { family(r, 'dui').vehicles[0].flee = 2; }, /vehicles\[0\]\.flee must be in \[0, 1\]/);
    fixtures((r) => { family(r, 'domestic').evidence[0].item = 'gold'; }, /evidence\[0\]\.item must be one of/);
    fixtures((r) => { family(r, 'domestic').describe = 'ghost'; }, /families\[\d+\]\.describe names an unknown role "ghost"/);
  });

  it('family branches, variants and overrides', () => {
    fixtures((r) => { family(r, 'domestic').branches[1].id = 'verbal'; }, /branches\[1\]\.id duplicates "verbal"/);
    fixtures((r) => { for (const b of family(r, 'domestic').branches as Json[]) b.weight = 0; }, /families\[\d+\]\.branches needs at least one branch with weight > 0/);
    fixtures((r) => { family(r, 'domestic').branches[0].flags = ['bogusFlag']; }, /branches\[0\]\.flags\[0\] must be one of/);
    fixtures((r) => { family(r, 'domestic').branches[0].flags = ['injury:ghost']; }, /branches\[0\]\.flags\[0\] names an unknown role/);
    fixtures((r) => { family(r, 'domestic').branches[0].flags = ['shout:victim']; }, /branches\[0\]\.flags\[0\] has unknown prefix "shout"/);
    fixtures((r) => { family(r, 'domestic').branches[0].remove = ['ghost']; }, /branches\[0\]\.remove\[0\] names an unknown role or vehicle role/);
    fixtures((r) => { family(r, 'domestic').branches[0].roleOverrides = { ghost: { profile: 'bystander' } }; }, /branches\[0\]\.roleOverrides\.ghost names an unknown role/);
    fixtures((r) => { family(r, 'domestic').branches[0].roleOverrides = { victim: { vehicle: 'x' } }; }, /roleOverrides\.victim\.vehicle is not one of/);
    fixtures((r) => { family(r, 'dui').branches[0].vehicleOverrides = { ghost: { mode: 'parked' } }; }, /vehicleOverrides\.ghost names an unknown vehicle role/);
    fixtures((r) => { family(r, 'dui').branches[0].vehicleOverrides = { subjectVehicle: { mode: 'flying' } }; }, /vehicleOverrides\.subjectVehicle\.mode must be one of/);
    fixtures((r) => { delete family(r, 'domestic').variants.ambush; }, /families\[\d+\]\.variants\.ambush is missing/);
    fixtures((r) => { family(r, 'domestic').variants.false = -1; }, /variants\.false must be in \[0, Infinity\]/);
    fixtures((r) => { family(r, 'domestic').escalation = null; }, /families\[\d+\]\.escalation is null but variants\.escalation is above 0/);
    fixtures((r) => { family(r, 'domestic').deescalation = null; }, /deescalation is null but variants\.deescalation is above 0/);
    fixtures((r) => { family(r, 'domestic').escalation.narratives = []; }, /escalation\.narratives must have at least 1 items/);
    fixtures((r) => { family(r, 'domestic').escalation.roleOverrides = { ghost: {} }; }, /escalation\.roleOverrides\.ghost names an unknown role/);
  });

  it('family actions, conditions, objectives and outcomes', () => {
    fixtures((r) => { family(r, 'domestic').actions.push('teleport'); }, /actions\[\d+\] references unknown action "teleport"/);
    fixtures((r) => { family(r, 'domestic').actions.push('knock'); }, /actions\[\d+\] duplicates "knock"/);
    fixtures((r) => { family(r, 'domestic').actions.push('secureAnimal'); }, /action "secureAnimal" does not fit this family/);
    fixtures((r) => { family(r, 'domestic').actions.push('disperseCrowd'); }, /action "disperseCrowd" commands roles/);
    fixtures((r) => { family(r, 'domestic').outcomes[0].when = 'bogus:thing'; }, /outcomes\[0\]\.when uses unknown flag prefix "bogus"/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'custody:ghost'; }, /outcomes\[1\]\.when "custody:ghost" names an unknown role "ghost"/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'branch:ghost'; }, /outcomes\[1\]\.when "branch:ghost" names an unknown branch "ghost"/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'variant:ghost'; }, /outcomes\[1\]\.when "variant:ghost" names an unknown variant/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'service:ghost'; }, /outcomes\[1\]\.when "service:ghost" names an unknown service/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'itemFound:ghost'; }, /outcomes\[1\]\.when "itemFound:ghost" names an unknown item/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = 'mysteryFlag'; }, /outcomes\[1\]\.when uses unknown flag "mysteryFlag"/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = { all: [] }; }, /outcomes\[1\]\.when\.all must have at least 1 items/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = { all: ['arrived'], any: ['arrived'] }; }, /outcomes\[1\]\.when must have exactly one of all, any, not/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].when = { not: { any: ['bad flag'] } }; }, /outcomes\[1\]\.when\.not\.any\[0\] has a malformed flag/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].disposition = 'vanished'; }, /outcomes\[1\]\.disposition must be one of/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].grade = 'great'; }, /outcomes\[1\]\.grade must be one of good, ok, bad/);
    fixtures((r) => { family(r, 'domestic').outcomes[1].id = 'unfounded'; }, /outcomes\[1\]\.id duplicates "unfounded"/);
    fixtures((r) => { family(r, 'domestic').outcomes.pop(); }, /families\[\d+\]\.outcomes the last outcome must have "when": "true"/);
    fixtures((r) => { family(r, 'domestic').objectives[0].done = 'nonsense'; }, /objectives\[0\]\.done uses unknown flag "nonsense"/);
    fixtures((r) => { family(r, 'domestic').objectives[0].show = 'role:ghost'; }, /objectives\[0\]\.show "role:ghost" names an unknown role/);
  });

  it('type files', () => {
    const file = (r: Raw, name: string): { file: string; json: Json } => {
      const f = r.types.find((t) => t.file === `types/${name}.json`);
      if (!f) throw new Error(name);
      return f;
    };
    fixtures((r) => { file(r, 'dui').json.family = 'nowhere'; }, /types\/dui\.json: family references unknown family "nowhere"/);
    fixtures((r) => { file(r, 'dui').json.types[1].id = 'impairedDriver'; }, /types\/dui\.json: types\[1\]\.id duplicates "impairedDriver"/);
    fixtures((r) => { file(r, 'dui').json.types[0].id = 'trafficHazard'; }, /types\/dui\.json: types\[0\]\.id duplicates the Phase 2 type "trafficHazard"/);
    fixtures((r) => { file(r, 'dui').json.types[0].id = 'bad id'; }, /types\/dui\.json: types\[0\]\.id must match/);
    fixtures((r) => { file(r, 'dui').json.types[0].category = 'piracy'; }, /types\/dui\.json: types\[0\]\.category must be one of/);
    fixtures((r) => { file(r, 'dui').json.types[0].mystery = 1; }, /types\/dui\.json: types\[0\]\.mystery is not one of/);
    fixtures((r) => { file(r, 'dui').json.types[0].narratives = ['only one']; }, /types\/dui\.json: types\[0\]\.narratives must have at least 2 items/);
    fixtures((r) => { file(r, 'dui').json.types[0].weight = 0; }, /types\/dui\.json: types\[0\]\.weight must be greater than 0 for a generated type/);
    fixtures((r) => { file(r, 'dui').json.types[0].branchWeights = { nope: 1 }; }, /types\[0\]\.branchWeights\.nope names an unknown branch "nope" of family dui/);
    fixtures((r) => { file(r, 'dui').json.types[0].branchWeights = { drunk: -1 }; }, /types\[0\]\.branchWeights\.drunk must be in \[0, Infinity\]/);
    fixtures((r) => {
      file(r, 'dui').json.types[0].branchWeights = { drunk: 0, drugged: 0, medical: 0, tired: 0, asleepParked: 0 };
    }, /types\[0\]\.branchWeights leaves every branch at weight 0/);
    fixtures((r) => { file(r, 'dui').json.types[0].variants = { false: -1 }; }, /types\[0\]\.variants\.false must be in \[0, Infinity\]/);
    fixtures((r) => { file(r, 'dui').json.types[0].variants = { teleport: 1 }; }, /types\[0\]\.variants\.teleport is not one of/);
    fixtures((r) => { file(r, 'service').json.types[0].variants = { escalation: 1 }; }, /types\[0\]\.variants\.escalation family service has no escalation/);
    fixtures((r) => { r.types.push({ file: 'types/ghost.json', json: { version: 1, family: 'dui', types: [] } }); }, /types\/ghost\.json: types must have at least 1 items/);
    fixtures((r) => { r.types = r.types.filter((t) => t.file !== 'types/pursuit.json'); }, /families\.json: pursuit has no call type/);
  });
});
