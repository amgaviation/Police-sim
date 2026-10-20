import { describe, expect, it } from 'vitest';
import unitTypesJson from '../../src/data/units/unitTypes.json';
import {
  ETA_CONFIG,
  ROSTER_CONFIG,
  UNIT_TYPES,
  expandResourceSlots,
  parseRosterConfig,
  parseUnitTypes,
  requestableTypes,
  resourceSlots,
  unitType,
} from '../../src/units/data';
import {
  MISTAKE_KINDS,
  RANKS,
  ROSTER_EVENTS,
  SEND_KINDS,
  UNIT_BASES,
  UNIT_BEHAVIORS,
} from '../../src/units/types';
import { VEHICLE_MODELS } from '../../src/vehicles/model';

type Obj = Record<string, unknown>;

function variant(mutate: (root: Obj, types: Obj[]) => void): unknown {
  const root = structuredClone(unitTypesJson) as unknown as Obj;
  mutate(root, root.types as Obj[]);
  return root;
}
function typeOf(types: Obj[], id: string): Obj {
  const t = types.find((x) => x.id === id);
  if (!t) throw new Error(`no type ${id}`);
  return t;
}

describe('id lists (design §4.1)', () => {
  it('have the contract sizes and order', () => {
    expect(UNIT_BEHAVIORS).toHaveLength(17);
    expect(UNIT_BEHAVIORS[0]).toBe('patrol');
    expect(UNIT_BEHAVIORS[16]).toBe('federal');
    expect([...SEND_KINDS]).toEqual(['backup2', 'backup3', 'emergency', 'resource']);
    expect([...UNIT_BASES]).toEqual(['station', 'hospital', 'airport', 'harbor', 'highway', 'edge']);
    expect([...RANKS]).toEqual(['officer', 'sergeant', 'lieutenant', 'chief']);
    expect(ROSTER_EVENTS).toHaveLength(11);
    expect([...MISTAKE_KINDS]).toEqual(['lateCallout', 'poorPosition', 'excessiveForce']);
  });
});

describe('shipped unit types', () => {
  it('parses the 20 design types in file order', () => {
    expect(UNIT_TYPES.types.map((t) => t.id)).toEqual([
      'routine', 'priority', 'officerNeedsAssistance', 'supervisor', 'k9', 'ems', 'fire', 'tow', 'swat', 'negotiator', 'air',
      'coroner', 'detectives', 'csu', 'animalControl', 'bombSquad', 'statePatrol', 'federal', 'lieutenant', 'chief',
    ]);
    expect(UNIT_TYPES).toMatchObject({ fleetIndexBase: 8, maxFleetCars: 32, airSpeedMps: 45, airAltitudeM: 150 });
  });

  it('matches the §4.2 table', () => {
    const row = (id: string): [string, string, string, number, string, string, readonly [number, number], string[]] => {
      const t = unitType(id);
      if (!t) throw new Error(id);
      return [t.send, t.behavior, t.callsign, t.count, t.vehicle, t.base, t.turnoutS, [...t.sceneServices]];
    };
    expect(row('routine')[0]).toBe('backup2');
    expect(row('priority')[0]).toBe('backup3');
    expect(row('officerNeedsAssistance')[0]).toBe('emergency');
    expect(row('supervisor')).toEqual(['resource', 'supervisor', 'SGT-{n}', 2, 'patrol_suv', 'station', [10, 60], ['supervisor']]);
    expect(row('k9')).toEqual(['resource', 'k9', 'K9-{n}', 1, 'patrol_suv', 'station', [30, 120], ['k9']]);
    expect(row('ems')).toEqual(['resource', 'ems', 'MEDIC-{n}', 3, 'ambulance', 'hospital', [20, 90], ['ems']]);
    expect(row('fire')).toEqual(['resource', 'fire', 'ENGINE-{n}', 2, 'fire_engine', 'station', [40, 90], ['fire', 'hazmat']]);
    expect(row('tow')).toEqual(['resource', 'tow', 'TOW-{n}', 2, 'tow_truck', 'harbor', [120, 300], ['tow']]);
    expect(row('swat')).toEqual(['resource', 'swat', 'TAC-{n}', 1, 'tactical_truck', 'station', [300, 600], ['swat']]);
    expect(row('negotiator')).toEqual(['resource', 'negotiator', 'NEG-{n}', 1, 'sedan', 'station', [180, 420], ['negotiator']]);
    expect(row('air')).toEqual(['resource', 'air', 'AIR-{n}', 1, 'none', 'airport', [60, 180], ['airUnit']]);
    expect(row('coroner')).toEqual(['resource', 'coroner', 'CORONER-{n}', 1, 'van', 'hospital', [300, 900], ['coroner']]);
    expect(row('detectives')).toEqual(['resource', 'detectives', 'DET-{n}', 1, 'sedan', 'station', [300, 900], ['detectives']]);
    expect(row('csu')).toEqual(['resource', 'csu', 'CSU-{n}', 1, 'van', 'station', [240, 600], ['csu']]);
    expect(row('animalControl')).toEqual(['resource', 'animalControl', 'ANIMAL-{n}', 1, 'pickup', 'harbor', [180, 480], ['animalControl']]);
    expect(row('bombSquad')).toEqual(['resource', 'bombSquad', 'BOMB-{n}', 1, 'tactical_truck', 'station', [300, 600], ['bombSquad']]);
    expect(row('statePatrol')).toEqual(['resource', 'statePatrol', 'STATE-{n}', 2, 'patrol_sedan', 'highway', [10, 60], ['statePatrol']]);
    expect(row('federal')).toEqual(['resource', 'federal', 'FED-{n}', 1, 'sedan', 'edge', [600, 1200], ['federal']]);
    expect(row('lieutenant')).toEqual(['resource', 'command', 'LT-{n}', 1, 'patrol_suv', 'station', [60, 180], []]);
    expect(row('chief')).toEqual(['resource', 'command', 'CHIEF-{n}', 1, 'patrol_suv', 'station', [120, 300], []]);
    expect(unitType('supervisor')?.rank).toBe('sergeant');
    expect(unitType('lieutenant')?.rank).toBe('lieutenant');
    expect(unitType('chief')?.rank).toBe('chief');
    expect(unitType('k9')?.crew).toMatchObject({ count: 1, dog: true });
    expect(unitType('k9')?.color).toBe('#20242a');
    expect(unitType('k9')?.colorRgb).toBe(0x20242a);
    expect(unitType('swat')?.crew.count).toBe(0);
    expect(unitType('fire')?.channel).toBe('fireEms');
    expect(unitType('ems')?.channel).toBe('fireEms');
    expect(unitType('tow')?.onSceneS).toEqual([120, 240]);
    expect(unitType('coroner')?.onSceneS).toEqual([120, 240]);
    expect(unitType('animalControl')?.onSceneS).toEqual([120, 240]);
    expect(unitType('k9')?.onSceneS).toEqual([300, 600]);
    expect(unitType('fire')?.speedFactor).toBe(0.85);
    expect(unitType('nope')).toBeNull();
  });

  it('crew counts follow the design', () => {
    const crew = Object.fromEntries(UNIT_TYPES.types.filter((t) => t.send === 'resource').map((t) => [t.id, t.crew.count]));
    expect(crew).toEqual({
      supervisor: 1, k9: 1, ems: 2, fire: 3, tow: 1, swat: 0, negotiator: 1, air: 0, coroner: 2, detectives: 2, csu: 2,
      animalControl: 1, bombSquad: 2, statePatrol: 1, federal: 2, lieutenant: 1, chief: 1,
    });
  });

  it('requestableTypes is sorted by menuOrder and excludes lieutenant and chief', () => {
    const list = requestableTypes();
    expect(list.map((t) => t.id)).toEqual([
      'routine', 'priority', 'officerNeedsAssistance', 'supervisor', 'k9', 'ems', 'fire', 'tow', 'swat', 'negotiator', 'air',
      'coroner', 'detectives', 'csu', 'animalControl', 'bombSquad', 'statePatrol', 'federal',
    ]);
    expect(list.map((t) => t.menuOrder)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(list.every((t) => t.menu.length <= 28)).toBe(true);
    expect(UNIT_TYPES.types.filter((t) => !t.requestable).map((t) => t.id)).toEqual(['lieutenant', 'chief']);
  });

  it('every vehicle id is a shipped model (or none for air)', () => {
    for (const t of UNIT_TYPES.types.filter((x) => x.send === 'resource')) {
      if (t.behavior === 'air') expect(t.vehicle).toBe('none');
      else expect(VEHICLE_MODELS.some((m) => m.id === t.vehicle)).toBe(true);
    }
  });
});

describe('resourceSlots', () => {
  it('expands resource types in file order with fleet indices 8..29 and -1 for the air unit', () => {
    const slots = resourceSlots();
    expect(slots).toHaveLength(23);
    expect(slots.slice(0, 6).map((s) => [s.callsign, s.fleetIndex])).toEqual([
      ['SGT-1', 8], ['SGT-2', 9], ['K9-1', 10], ['MEDIC-1', 11], ['MEDIC-2', 12], ['MEDIC-3', 13],
    ]);
    expect(slots.map((s) => s.callsign)).toEqual([
      'SGT-1', 'SGT-2', 'K9-1', 'MEDIC-1', 'MEDIC-2', 'MEDIC-3', 'ENGINE-1', 'ENGINE-2', 'TOW-1', 'TOW-2', 'TAC-1', 'NEG-1',
      'AIR-1', 'CORONER-1', 'DET-1', 'CSU-1', 'ANIMAL-1', 'BOMB-1', 'STATE-1', 'STATE-2', 'FED-1', 'LT-1', 'CHIEF-1',
    ]);
    const air = slots.find((s) => s.typeId === 'air');
    expect(air).toEqual({ typeId: 'air', callsign: 'AIR-1', index: 1, fleetIndex: -1 });
    const ground = slots.filter((s) => s.fleetIndex >= 0);
    expect(ground).toHaveLength(22);
    expect(ground.map((s) => s.fleetIndex)).toEqual(Array.from({ length: 22 }, (_, i) => 8 + i));
    expect(ground[ground.length - 1]?.fleetIndex).toBe(29);
    expect(slots.filter((s) => s.typeId === 'ems').map((s) => s.index)).toEqual([1, 2, 3]);
    expect(slots.some((s) => s.typeId === 'routine')).toBe(false);
  });

  it('is exposed by expandResourceSlots for any data', () => {
    const data = parseUnitTypes(
      variant((root) => {
        root.fleetIndexBase = 10;
      }),
      'x.json',
    );
    expect(expandResourceSlots(data)[0]?.fleetIndex).toBe(10);
    expect(expandResourceSlots(data).filter((s) => s.fleetIndex >= 0).pop()?.fleetIndex).toBe(31);
  });
});

describe('parseUnitTypes rejects bad variants (naming the file and the path)', () => {
  const cases: [string, (root: Obj, types: Obj[]) => void, RegExp][] = [
    ['non-object root', () => undefined, /^$/],
    ['version', (r) => (r.version = 2), /^bad\.json: version must be 1, got 2$/],
    ['unknown root key', (r) => (r.extra = 1), /^bad\.json: extra is not one of/],
    ['negative fleetIndexBase', (r) => (r.fleetIndexBase = -1), /^bad\.json: fleetIndexBase must be in/],
    ['fractional fleetIndexBase', (r) => (r.fleetIndexBase = 8.5), /^bad\.json: fleetIndexBase must be an integer/],
    ['maxFleetCars missing', (r) => delete r.maxFleetCars, /^bad\.json: maxFleetCars must be a finite number/],
    ['too many ground units', (r) => (r.maxFleetCars = 20), /^bad\.json: types ground units \(22\) must be at most maxFleetCars - fleetIndexBase \(12\)$/],
    ['airSpeedMps', (r) => (r.airSpeedMps = 0), /^bad\.json: airSpeedMps must be in/],
    ['airAltitudeM', (r) => (r.airAltitudeM = -5), /^bad\.json: airAltitudeM must be in/],
    ['empty types', (r) => (r.types = []), /^bad\.json: types must have at least 1 items/],
    ['duplicate id', (_r, t) => (typeOf(t, 'tow').id = 'k9'), /^bad\.json: types\[7\]\.id duplicates id "k9"$/],
    ['non-camelCase id', (_r, t) => (typeOf(t, 'k9').id = 'K9_unit'), /^bad\.json: types\[4\]\.id must be camelCase/],
    ['long menu', (_r, t) => (typeOf(t, 'k9').menu = 'x'.repeat(29)), /^bad\.json: types\[4\]\.menu must be at most 28 characters, got 29$/],
    ['empty label', (_r, t) => (typeOf(t, 'k9').label = ''), /^bad\.json: types\[4\]\.label must be a non-empty string/],
    ['uppercase voice', (_r, t) => (typeOf(t, 'k9').voice = ['K9']), /^bad\.json: types\[4\]\.voice\[0\] must be lowercase/],
    ['voice not array', (_r, t) => (typeOf(t, 'k9').voice = 'k9'), /^bad\.json: types\[4\]\.voice must be an array/],
    ['requestable not boolean', (_r, t) => (typeOf(t, 'k9').requestable = 1), /^bad\.json: types\[4\]\.requestable must be true or false/],
    ['duplicate menuOrder', (_r, t) => (typeOf(t, 'ems').menuOrder = 5), /^bad\.json: types\[5\]\.menuOrder duplicates menuOrder 5/],
    ['missing menuOrder', (_r, t) => delete typeOf(t, 'k9').menuOrder, /^bad\.json: types\[4\]\.menuOrder must be a finite number/],
    ['menuOrder 0', (_r, t) => (typeOf(t, 'k9').menuOrder = 0), /^bad\.json: types\[4\]\.menuOrder must be in/],
    ['menuOrder on non-requestable', (_r, t) => (typeOf(t, 'chief').menuOrder = 30), /^bad\.json: types\[19\]\.menuOrder must be omitted/],
    ['bad send', (_r, t) => (typeOf(t, 'k9').send = 'fax'), /^bad\.json: types\[4\]\.send must be one of backup2, backup3, emergency, resource/],
    ['bad behavior', (_r, t) => (typeOf(t, 'k9').behavior = 'pirate'), /^bad\.json: types\[4\]\.behavior must be one of patrol,/],
    ['missing resolves', (_r, t) => delete typeOf(t, 'k9').resolves, /^bad\.json: types\[4\]\.resolves must be a non-empty string/],
    ['callsign without {n}', (_r, t) => (typeOf(t, 'k9').callsign = 'K9'), /^bad\.json: types\[4\]\.callsign must contain "\{n\}"/],
    ['duplicate callsign', (_r, t) => (typeOf(t, 'k9').callsign = 'SGT-{n}'), /^bad\.json: types\[4\]\.callsign duplicates callsign "SGT-1"$/],
    ['count 0', (_r, t) => (typeOf(t, 'k9').count = 0), /^bad\.json: types\[4\]\.count must be in \[1, 4\]/],
    ['count 5', (_r, t) => (typeOf(t, 'k9').count = 5), /^bad\.json: types\[4\]\.count must be in \[1, 4\]/],
    ['unknown vehicle', (_r, t) => (typeOf(t, 'k9').vehicle = 'hovercraft'), /^bad\.json: types\[4\]\.vehicle must be a vehicle model id, got "hovercraft"$/],
    ['none vehicle on ground', (_r, t) => (typeOf(t, 'k9').vehicle = 'none'), /^bad\.json: types\[4\]\.vehicle "none" is only allowed for the air behavior$/],
    ['vehicle on air', (_r, t) => (typeOf(t, 'air').vehicle = 'van'), /^bad\.json: types\[10\]\.vehicle must be "none" for the air behavior/],
    ['bad color', (_r, t) => (typeOf(t, 'k9').color = 'blue'), /^bad\.json: types\[4\]\.color must be a "#rrggbb" colour/],
    ['bad base', (_r, t) => (typeOf(t, 'k9').base = 'moon'), /^bad\.json: types\[4\]\.base must be one of station,/],
    ['turnout order', (_r, t) => (typeOf(t, 'k9').turnoutS = [120, 30]), /^bad\.json: types\[4\]\.turnoutS must be \[min, max\] with min <= max/],
    ['turnout length', (_r, t) => (typeOf(t, 'k9').turnoutS = [30]), /^bad\.json: types\[4\]\.turnoutS must have exactly 2 items/],
    ['negative turnout', (_r, t) => (typeOf(t, 'k9').turnoutS = [-1, 5]), /^bad\.json: types\[4\]\.turnoutS\[0\] must be in/],
    ['speedFactor high', (_r, t) => (typeOf(t, 'k9').speedFactor = 1.6), /^bad\.json: types\[4\]\.speedFactor must be in \[0\.5, 1\.5\]/],
    ['speedFactor low', (_r, t) => (typeOf(t, 'k9').speedFactor = 0.4), /^bad\.json: types\[4\]\.speedFactor must be in \[0\.5, 1\.5\]/],
    ['crew count', (_r, t) => ((typeOf(t, 'k9').crew as Obj).count = 5), /^bad\.json: types\[4\]\.crew\.count must be in \[0, 4\]/],
    ['crew colour', (_r, t) => ((typeOf(t, 'k9').crew as Obj).top = 'navy'), /^bad\.json: types\[4\]\.crew\.top must be a "#rrggbb" colour/],
    ['crew dog', (_r, t) => ((typeOf(t, 'k9').crew as Obj).dog = 'yes'), /^bad\.json: types\[4\]\.crew\.dog must be true or false/],
    ['crew key', (_r, t) => ((typeOf(t, 'k9').crew as Obj).hat = 1), /^bad\.json: types\[4\]\.crew\.hat is not one of/],
    ['unknown service', (_r, t) => (typeOf(t, 'k9').sceneServices = ['teleport']), /^bad\.json: types\[4\]\.sceneServices\[0\] must be one of/],
    ['onSceneS order', (_r, t) => (typeOf(t, 'k9').onSceneS = [600, 300]), /^bad\.json: types\[4\]\.onSceneS must be \[min, max\] with min <= max/],
    ['bad channel', (_r, t) => (typeOf(t, 'k9').channel = 'ham'), /^bad\.json: types\[4\]\.channel must be one of dispatch,/],
    ['bad rank', (_r, t) => (typeOf(t, 'supervisor').rank = 'captain'), /^bad\.json: types\[3\]\.rank must be one of officer, sergeant, lieutenant, chief/],
    ['resource field on a dispatcher type', (_r, t) => (typeOf(t, 'routine').callsign = 'X-{n}'), /^bad\.json: types\[0\]\.callsign is not one of/],
    ['unknown type key', (_r, t) => (typeOf(t, 'k9').flavour = 'x'), /^bad\.json: types\[4\]\.flavour is not one of/],
  ];

  for (const [name, mutate, message] of cases) {
    if (name === 'non-object root') {
      it(name, () => {
        expect(() => parseUnitTypes(null, 'bad.json')).toThrow(/^bad\.json: must be an object, got null$/);
        expect(() => parseUnitTypes([], 'bad.json')).toThrow(/^bad\.json: must be an object/);
      });
      continue;
    }
    it(name, () => {
      expect(() => parseUnitTypes(variant(mutate), 'bad.json')).toThrow(message);
    });
  }

  it('the unmodified data parses', () => {
    expect(() => parseUnitTypes(variant(() => undefined), 'ok.json')).not.toThrow();
  });
});

describe('roster config', () => {
  const j = (mutate: (r: Obj) => void): unknown => {
    const r = { ...structuredClone(ROSTER_CONFIG), version: 1 } as unknown as Obj;
    mutate(r);
    return r;
  };

  it('ships the design values', () => {
    expect(ROSTER_CONFIG.traits.aggression).toEqual([0.1, 0.8]);
    expect(ROSTER_CONFIG.rankTitles).toEqual({ officer: 'Officer', sergeant: 'Sgt.', lieutenant: 'Lt.', chief: 'Chief' });
    expect(ROSTER_CONFIG.stress).toMatchObject({ start: 0.1, decayPerMin: 0.03 });
    expect(ROSTER_CONFIG.stress.events.shotsFired).toBe(0.45);
    expect(ROSTER_CONFIG.loyalty.events.intervenedOnThem).toBe(-0.08);
    expect(ROSTER_CONFIG.fatigue).toEqual({ start: 0.05, perHour: 0.06, perCall: 0.015, max: 1 });
    expect(ROSTER_CONFIG.mistakes.lateCallout.stress).toBe(0.3);
    expect(ROSTER_CONFIG.mistakes.excessiveForce.aggression).toBe(0.08);
    expect(ROSTER_CONFIG.mistakes.lateCallout.aggression).toBe(0);
    expect(ROSTER_CONFIG.maxChance).toEqual({ lateCallout: 0.6, poorPosition: 0.5, excessiveForce: 0.2 });
    expect(ETA_CONFIG.rankCandidates).toBe(4);
  });

  it('rejects bad variants', () => {
    const cases: [(r: Obj) => void, RegExp][] = [
      [(r) => (r.version = 3), /^bad\.json: version must be 1, got 3$/],
      [(r) => ((r.traits as Obj).aggression = [0.9, 0.1]), /^bad\.json: traits\.aggression must be \[min, max\] with min <= max/],
      [(r) => ((r.traits as Obj).aggression = [0, 2]), /^bad\.json: traits\.aggression\[1\] must be in \[0, 1\]/],
      [(r) => delete (r.traits as Obj).composure, /^bad\.json: traits\.composure must be an array/],
      [(r) => ((r.traits as Obj).bravery = [0, 1]), /^bad\.json: traits\.bravery is not one of/],
      [(r) => delete (r.rankTitles as Obj).chief, /^bad\.json: rankTitles\.chief must be a non-empty string/],
      [(r) => ((r.stress as Obj).start = 2), /^bad\.json: stress\.start must be in \[0, 1\]/],
      [(r) => ((r.stress as { events: Obj }).events.explosion = 0.1), /^bad\.json: stress\.events\.explosion is not one of/],
      [(r) => ((r.stress as { events: Obj }).events.fight = 'lots'), /^bad\.json: stress\.events\.fight must be a finite number/],
      [(r) => delete (r.stress as { events: Obj }).events.fight, /^bad\.json: stress\.events is missing roster event "fight"/],
      [(r) => ((r.loyalty as { events: Obj }).events.fight = 0.1), /^bad\.json: loyalty\.events\.fight is also in stress\.events/],
      [(r) => ((r.loyalty as Obj).start = [0.8, 0.2]), /^bad\.json: loyalty\.start must be \[min, max\]/],
      [(r) => ((r.fatigue as Obj).max = 0), /^bad\.json: fatigue\.max must be in/],
      [(r) => Object.assign(r.fatigue as Obj, { start: 0.9, max: 0.5 }), /^bad\.json: fatigue\.start must be at most fatigue\.max/],
      [(r) => delete (r.mistakes as Obj).poorPosition, /^bad\.json: mistakes\.poorPosition must be an object/],
      [(r) => delete (r.mistakes as { lateCallout: Obj }).lateCallout.base, /^bad\.json: mistakes\.lateCallout\.base must be a finite number/],
      [(r) => ((r.mistakes as { lateCallout: Obj }).lateCallout.charm = 1), /^bad\.json: mistakes\.lateCallout\.charm is not one of/],
      [(r) => ((r.mistakes as { lateCallout: Obj }).lateCallout.stress = 5), /^bad\.json: mistakes\.lateCallout\.stress must be in/],
      [(r) => ((r.maxChance as Obj).lateCallout = 1.5), /^bad\.json: maxChance\.lateCallout must be in \[0, 1\]/],
      [(r) => delete (r.maxChance as Obj).excessiveForce, /^bad\.json: maxChance\.excessiveForce must be a finite number/],
    ];
    for (const [mutate, message] of cases) expect(() => parseRosterConfig(j(mutate), 'bad.json')).toThrow(message);
  });

  it('missing trait weights count as 0', () => {
    const cfg = parseRosterConfig(
      j((r) => {
        delete (r.mistakes as { poorPosition: Obj }).poorPosition.loyalty;
        delete (r.mistakes as { poorPosition: Obj }).poorPosition.experience;
      }),
      'x.json',
    );
    expect(cfg.mistakes.poorPosition.loyalty).toBe(0);
    expect(cfg.mistakes.poorPosition.experience).toBe(0);
  });
});
