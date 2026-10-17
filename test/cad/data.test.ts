import { describe, expect, it } from 'vitest';
import addressJson from '../../src/data/cad/address.json';
import callTypesJson from '../../src/data/cad/callTypes.json';
import dispositionsJson from '../../src/data/cad/dispositions.json';
import statutesJson from '../../src/data/cad/statutes.json';
import tenCodesJson from '../../src/data/cad/tenCodes.json';
import {
  CAD_CONFIG,
  CALL_TYPES,
  DISPOSITIONS,
  NARRATIVE_PLACEHOLDERS,
  PLATE_ISSUES,
  REQUIRED_CODE_KEYS,
  STATUTES,
  TEN_CODES,
  callType,
  findCallType,
  placeholdersOf,
  statute,
  statuteForPlateIssue,
  statuteForViolation,
  validateAddressConfig,
  validateCallTypes,
  validateDispositions,
  validateStatutes,
  validateTenCodes,
} from '../../src/cad/data';
import { CRIME_CATEGORIES } from '../../src/environment/crime';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

type Json = Record<string, unknown>;
const ctx = { dispositions: DISPOSITIONS.map((d) => d.id), codeKeys: Object.keys(TEN_CODES.codes) };

function brokenType(mutate: (t: Json) => void): unknown {
  const data = clone(callTypesJson) as unknown as { types: Json[] };
  const t = data.types[0];
  if (!t) throw new Error('no call types');
  mutate(t);
  return data;
}

describe('cad data tables', () => {
  it('loads every shipped file', () => {
    expect(CAD_CONFIG).toEqual({ metresPerHundred: 100, intersectionRadius: 40, agency: 'City Police' });
    expect(DISPOSITIONS.map((d) => d.id)).toEqual([
      'handled', 'reportTaken', 'citationIssued', 'warningIssued', 'arrestMade', 'goneOnArrival', 'unfounded', 'referred', 'cancelled',
    ]);
    for (const key of REQUIRED_CODE_KEYS) expect(TEN_CODES.codes[key]).toBeDefined();
    expect(STATUTES.length).toBeGreaterThanOrEqual(16);
  });

  it('ships the 8 generated and 4 non-generated call types', () => {
    const generated = CALL_TYPES.filter((t) => t.generated).map((t) => t.id);
    const manual = CALL_TYPES.filter((t) => !t.generated).map((t) => t.id);
    expect(generated.sort()).toEqual(
      ['alarm', 'minorCollision', 'noiseComplaint', 'parkingComplaint', 'suspiciousPerson', 'suspiciousVehicle', 'trafficHazard', 'welfareCheck'],
    );
    expect(manual.sort()).toEqual(['officerAssist', 'officerEmergency', 'officerWelfare', 'trafficStop']);
    for (const t of CALL_TYPES) {
      expect((CRIME_CATEGORIES as readonly string[]).includes(t.category)).toBe(true);
      expect(t.narratives.length).toBeGreaterThanOrEqual(2);
      const known = new Set<string>([...NARRATIVE_PLACEHOLDERS, ...Object.keys(t.fill)]);
      for (const n of t.narratives) for (const p of placeholdersOf(n)) expect(known.has(p)).toBe(true);
      expect(t.priority.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
      if (t.generated) expect(t.weight).toBeGreaterThan(0);
    }
    expect(callType('minorCollision').location).toBe('intersection');
    expect(callType('suspiciousVehicle').narratives.some((n) => n.includes('{plate}') && n.includes('{vehicle}'))).toBe(true);
    expect(callType('noiseComplaint').category).toBe('disturbance');
    expect(callType('officerEmergency').priority).toEqual([1, 0, 0, 0]);
    expect(callType('trafficStop').priority).toEqual([0, 0, 0, 1]);
    expect(() => callType('nope')).toThrow(/nope/);
    expect(findCallType('nope')).toBeNull();
  });

  it('maps violations and plate issues to statutes', () => {
    expect(statute('TR-301').speed).toBe(true);
    expect(statuteForViolation('speeding')?.id).toBe('TR-301');
    for (const kind of ['speeding', 'redLight', 'rollingStop', 'tailgating', 'weaving']) {
      const s = statuteForViolation(kind);
      expect(s?.citeable).toBe(true);
    }
    expect(statuteForViolation('jaywalking')).toBeNull();
    expect(statuteForViolation('toString')).toBeNull();
    for (const issue of PLATE_ISSUES) expect(statuteForPlateIssue(issue)).not.toBeNull();
    expect(statuteForPlateIssue('stolen')?.id).toBe('PC-210');
    expect(statuteForPlateIssue('cloned')?.id).toBe('PC-211');
    const warrant = statute('PC-220');
    expect(warrant.cls).toBe('warrant');
    expect(warrant.bookable).toBe(true);
    expect(warrant.citeable).toBe(false);
    for (const s of STATUTES) expect(s.id).toMatch(/^(TR-3|PC-2)\d\d$/);
    expect(() => statute('XX-999')).toThrow();
  });

  it('names the file and field of broken call types', () => {
    expect(() => validateCallTypes(brokenType((t) => { t.priority = { 1: 0, 2: 0 }; }), ctx)).toThrow(
      /callTypes\.json: types\[0\]\.priority weights must sum/,
    );
    expect(() => validateCallTypes(brokenType((t) => { t.priority = { 5: 1 }; }), ctx)).toThrow(/callTypes\.json: types\[0\]\.priority\.5/);
    expect(() => validateCallTypes(brokenType((t) => { t.units = [0, 1]; }), ctx)).toThrow(/callTypes\.json: types\[0\]\.units\[0\]/);
    expect(() => validateCallTypes(brokenType((t) => { t.units = [1.5, 2]; }), ctx)).toThrow(/types\[0\]\.units\[0\] must be an integer/);
    expect(() => validateCallTypes(brokenType((t) => { t.units = [3, 1]; }), ctx)).toThrow(/types\[0\]\.units must be \[min, max\]/);
    expect(() => validateCallTypes(brokenType((t) => { t.onSceneS = [0, 10]; }), ctx)).toThrow(/types\[0\]\.onSceneS\[0\] must be greater than 0/);
    expect(() => validateCallTypes(brokenType((t) => { t.onSceneS = [20, 10]; }), ctx)).toThrow(/types\[0\]\.onSceneS/);
    expect(() => validateCallTypes(brokenType((t) => { t.location = 'poi:castle'; }), ctx)).toThrow(/types\[0\]\.location/);
    expect(() => validateCallTypes(brokenType((t) => { t.location = 'poi:hospital'; }), ctx)).not.toThrow();
    expect(() => validateCallTypes(brokenType((t) => { t.dispositions = ['vanished']; }), ctx)).toThrow(
      /types\[0\]\.dispositions\[0\] references unknown disposition/,
    );
    expect(() => validateCallTypes(brokenType((t) => { t.narratives = ['At {moon}.', 'x']; }), ctx)).toThrow(
      /types\[0\]\.narratives\[0\] uses unknown placeholder \{moon\}/,
    );
    expect(() => validateCallTypes(brokenType((t) => { t.narratives = ['only one']; }), ctx)).toThrow(/types\[0\]\.narratives/);
    expect(() => validateCallTypes(brokenType((t) => { t.category = 'piracy'; }), ctx)).toThrow(/types\[0\]\.category/);
    expect(() => validateCallTypes(brokenType((t) => { t.codeKey = 'nope'; }), ctx)).toThrow(/types\[0\]\.codeKey/);
    expect(() => validateCallTypes(brokenType((t) => { t.districts = { atlantis: 1 }; }), ctx)).toThrow(/types\[0\]\.districts\.atlantis/);
    expect(() => validateCallTypes(brokenType((t) => { t.callers = { robot: 1 }; }), ctx)).toThrow(/types\[0\]\.callers\.robot/);
    expect(() => validateCallTypes(brokenType((t) => { t.fill = { street: ['x'] }; }), ctx)).toThrow(/types\[0\]\.fill\.street/);
    const dup = clone(callTypesJson) as unknown as { types: Json[] };
    dup.types.push(clone(dup.types[0] as Json));
    expect(() => validateCallTypes(dup, ctx)).toThrow(/callTypes\.json: types\[12\]\.id duplicates/);
  });

  it('names the file and field of broken statutes, codes, dispositions and config', () => {
    const s1 = clone(statutesJson) as unknown as { statutes: Json[]; violationMap: Json; plateMap: Json };
    s1.statutes.push(clone(s1.statutes[0] as Json));
    expect(() => validateStatutes(s1)).toThrow(/statutes\.json: statutes\[18\]\.id duplicates/);
    const s2 = clone(statutesJson) as unknown as { violationMap: Json };
    s2.violationMap.speeding = 'TR-999';
    expect(() => validateStatutes(s2)).toThrow(/statutes\.json: violationMap\.speeding references unknown statute/);
    const s3 = clone(statutesJson) as unknown as { plateMap: Json };
    delete s3.plateMap.stolen;
    expect(() => validateStatutes(s3)).toThrow(/statutes\.json: plateMap\.stolen is missing/);
    const s4 = clone(statutesJson) as unknown as { statutes: Json[] };
    (s4.statutes[0] as Json).class = 'crime';
    expect(() => validateStatutes(s4)).toThrow(/statutes\.json: statutes\[0\]\.class/);

    const c1 = clone(tenCodesJson) as unknown as { codes: Json; statusKeys: Json };
    delete c1.codes.ack;
    expect(() => validateTenCodes(c1)).toThrow(/tenCodes\.json: codes\.ack is missing/);
    const c2 = clone(tenCodesJson) as unknown as { codes: Record<string, Json> };
    delete (c2.codes.busy as Json).plain;
    expect(() => validateTenCodes(c2)).toThrow(/tenCodes\.json: codes\.busy\.plain/);
    const c3 = clone(tenCodesJson) as unknown as { statusKeys: Json };
    c3.statusKeys.busy = 'nope';
    expect(() => validateTenCodes(c3)).toThrow(/tenCodes\.json: statusKeys\.busy references unknown code/);
    const c4 = clone(tenCodesJson) as unknown as { statusKeys: Json };
    delete c4.statusKeys.transporting;
    expect(() => validateTenCodes(c4)).toThrow(/tenCodes\.json: statusKeys\.transporting/);

    const d1 = clone(dispositionsJson) as unknown as { dispositions: Json[] };
    d1.dispositions.push({ id: 'handled', label: 'Again' });
    expect(() => validateDispositions(d1)).toThrow(/dispositions\.json: dispositions\[9\]\.id duplicates/);

    const a1 = clone(addressJson) as unknown as Json;
    a1.metresPerHundred = 0;
    expect(() => validateAddressConfig(a1)).toThrow(/address\.json: metresPerHundred/);
    const a2 = clone(addressJson) as unknown as Json;
    a2.version = 2;
    expect(() => validateAddressConfig(a2)).toThrow(/address\.json: version/);
  });
});

describe('call-type narratives', () => {
  it('never repeat the street name (each location placeholder once)', () => {
    const values: Record<string, string> = {
      street: 'Oak Street', cross: '5th Street', address: '248 N Oak Street', district: 'Downtown', dir: 'northbound',
      plate: 'ABC 1234', vehicle: 'gray sedan', caller: 'RP',
    };
    for (const near of ['Oak Street at 5th Street', '800 block of N Oak Street']) {
      for (const type of CALL_TYPES) {
        for (const template of type.narratives) {
          const text = template.replace(/\{(\w+)\}/g, (_, k: string) => (k === 'near' ? near : values[k] ?? type.fill[k]?.[0] ?? k));
          expect(text.split('Oak Street').length - 1, `${type.id}: ${text}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
