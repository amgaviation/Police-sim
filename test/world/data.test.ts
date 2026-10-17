import { describe, expect, it } from 'vitest';
import districtsJson from '../../src/data/world/districts.json';
import districtTypesJson from '../../src/data/world/districtTypes.json';
import landmarksJson from '../../src/data/world/landmarks.json';
import roadClassesJson from '../../src/data/world/roadClasses.json';
import streetNamesJson from '../../src/data/world/streetNames.json';
import zonesJson from '../../src/data/world/zones.json';
import { CHUNKS_PER_SIDE, CHUNK_SIZE, DISTRICT_CELL, WORLD_HALF_SIZE, chunkCoord, chunkKey } from '../../src/world/constants';
import {
  DISTRICTS,
  DISTRICT_TYPES,
  LANDMARKS,
  ROAD_CLASSES,
  STREET_NAMES,
  ZONES,
  validateDistrictTypes,
  validateDistricts,
  validateLandmarks,
  validateRoadClasses,
  validateStreetNames,
  validateZones,
} from '../../src/world/data';
import { DISTRICT, DISTRICT_NAMES, ROAD_CLASS, SURFACE } from '../../src/world/roadGraph';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('world constants', () => {
  it('match the design numbers', () => {
    expect(WORLD_HALF_SIZE).toBe(3584);
    expect(CHUNK_SIZE).toBe(256);
    expect(DISTRICT_CELL).toBe(512);
    expect(CHUNKS_PER_SIDE).toBe(28);
    expect(CHUNKS_PER_SIDE * CHUNK_SIZE).toBe(2 * WORLD_HALF_SIZE);
  });

  it('chunkCoord floors and chunkKey is a stable unique int', () => {
    expect(chunkCoord(0)).toBe(0);
    expect(chunkCoord(255.9)).toBe(0);
    expect(chunkCoord(256)).toBe(1);
    expect(chunkCoord(-0.1)).toBe(-1);
    expect(chunkCoord(-3584)).toBe(-14);
    expect(chunkCoord(3583.9)).toBe(13);
    expect(chunkKey(0, 0)).toBe(64 * 128 + 64);
    const keys = new Set<number>();
    for (let cx = -14; cx < 14; cx++) for (let cz = -14; cz < 14; cz++) keys.add(chunkKey(cx, cz));
    expect(keys.size).toBe(28 * 28);
  });
});

describe('world data', () => {
  it('loads the shipped files', () => {
    expect(DISTRICTS.cells.length).toBe(196);
    expect(DISTRICTS.cells[0]).toBe(DISTRICT.rural);
    expect(DISTRICTS.cells[7 * 14]).toBe(DISTRICT.highway);
    expect(DISTRICTS.cells[13 * 14 + 13]).toBe(DISTRICT.water);
    expect(DISTRICTS.highways).toEqual([{ name: 'State Highway 9', axis: 'x', coord: 256, from: -3584, to: 3584 }]);
    expect(DISTRICT_TYPES.length).toBe(DISTRICT_NAMES.length);
    expect(DISTRICT_TYPES[DISTRICT.downtown]?.ground).toBe(SURFACE.concrete);
    expect(DISTRICT_TYPES[DISTRICT.water]?.subdivisions).toBe(0);
    expect(ROAD_CLASSES.classes[ROAD_CLASS.highway]?.laneWidth).toBe(3.65);
    expect(ROAD_CLASSES.classes[ROAD_CLASS.gravel]?.surface).toBe(SURFACE.gravel);
    expect(ROAD_CLASSES.districtSpeedMph[DISTRICT.downtown]?.[ROAD_CLASS.arterial]).toBe(35);
    expect(ROAD_CLASSES.signals.cycle[ROAD_CLASS.highway]).toBe(100);
    expect(ZONES.schoolZone.limitMph).toBe(20);
    expect(ZONES.construction.classes).toEqual([ROAD_CLASS.arterial, ROAD_CLASS.collector, ROAD_CLASS.local]);
    expect(LANDMARKS.station).toEqual({ x: 192, z: -320, yaw: 0 });
    expect(STREET_NAMES.words.length).toBeGreaterThanOrEqual(57);
    expect(STREET_NAMES.suffix[ROAD_CLASS.county]).toBe('County Road');
  });

  it('names the file and field on bad districts', () => {
    const bad = clone(districtsJson);
    bad.rows[3] = 'RRSSSSSSSSIIR';
    expect(() => validateDistricts(bad)).toThrow('districts.json: rows[3] must have 14 characters');
    const unknown = clone(districtsJson);
    unknown.rows[0] = 'RRRRRRRRRRRRRX';
    expect(() => validateDistricts(unknown)).toThrow("districts.json: rows[0][13] letter 'X' is not in the legend");
    const legend = clone(districtsJson) as { legend: Record<string, string> };
    legend.legend.D = 'downtownz';
    expect(() => validateDistricts(legend)).toThrow('districts.json: legend.D must be one of');
    const hw = clone(districtsJson);
    (hw.highways[0] as { axis: string }).axis = 'y';
    expect(() => validateDistricts(hw)).toThrow('districts.json: highways[0].axis');
    expect(() => validateDistricts({ ...clone(districtsJson), version: 2 })).toThrow('districts.json: version must be 1');
  });

  it('names the file and field on bad district types', () => {
    const missing = clone(districtTypesJson) as { types: Record<string, unknown> };
    delete missing.types.harbor;
    expect(() => validateDistrictTypes(missing)).toThrow('districtTypes.json: types.harbor is missing');
    const ground = clone(districtTypesJson);
    (ground.types.park as { ground: string }).ground = 'lava';
    expect(() => validateDistrictTypes(ground)).toThrow('districtTypes.json: types.park.ground must be one of');
    const range = clone(districtTypesJson);
    range.types.suburbs.buildings.height = [9, 4];
    expect(() => validateDistrictTypes(range)).toThrow('districtTypes.json: types.suburbs.buildings.height must have min <= max');
    const color = clone(districtTypesJson);
    color.types.downtown.buildings.palette[0] = 'grey';
    expect(() => validateDistrictTypes(color)).toThrow('districtTypes.json: types.downtown.buildings.palette[0] must be a #rrggbb colour');
  });

  it('names the file and field on bad road classes, zones, landmarks and names', () => {
    const rc = clone(roadClassesJson);
    rc.classes.local.lanes = 0;
    expect(() => validateRoadClasses(rc)).toThrow('roadClasses.json: classes.local.lanes must be in [1, 4]');
    const cyc = clone(roadClassesJson) as { signals: { cycle: Record<string, number> } };
    delete cyc.signals.cycle.local;
    expect(() => validateRoadClasses(cyc)).toThrow('roadClasses.json: signals.cycle.local is missing');
    const z = clone(zonesJson);
    z.construction.classes = ['arterial', 'freeway'];
    expect(() => validateZones(z)).toThrow('zones.json: construction.classes[1] must be one of');
    const w = clone(zonesJson);
    w.schoolZone.windows = [[7, 25]];
    expect(() => validateZones(w)).toThrow('zones.json: schoolZone.windows[0] must end by hour 24');
    const l = clone(landmarksJson);
    l.station.x = 9000;
    expect(() => validateLandmarks(l)).toThrow('landmarks.json: station.x must be in');
    const n = clone(streetNamesJson);
    n.words.push('Oak');
    expect(() => validateStreetNames(n)).toThrow('streetNames.json: words must not contain duplicates');
    const sfx = clone(streetNamesJson) as { suffix: Record<string, string> };
    delete sfx.suffix.gravel;
    expect(() => validateStreetNames(sfx)).toThrow('streetNames.json: suffix.gravel is missing');
  });
});
