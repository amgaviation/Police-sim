import { describe, expect, it } from 'vitest';
import { CALL_TYPES, findCallType } from '../../src/cad/data';
import { validateCatalog, CALL_CATALOG, familyForType } from '../../src/calls/catalog';
import { BRANCH_FLAG_NAMES, COMMAND_FLAG_NAMES, SCENE_FLAG_NAMES } from '../../src/calls/cond';
import { outcomeFor, producibleFlags, reachableOutcomes } from '../../src/calls/conditions';
import { SERVICE_KINDS } from '../../src/calls/types';
import { clone, CTX, family, rawInput, type Json } from './helpers';

function validate(raw: ReturnType<typeof rawInput>): unknown {
  return validateCatalog(raw, CTX);
}

const mci = CALL_CATALOG.families.find((f) => f.id === 'massCasualty')!;

describe('Phase 6 call catalog', () => {
  it('registers the three mass-casualty types as CAD rows with the family defaults', () => {
    for (const id of ['multiVehicleCrash', 'buildingCollapse', 'hazmatRelease']) {
      const row = findCallType(id);
      expect(row, id).not.toBeNull();
      expect(familyForType(id)?.id).toBe('massCasualty');
      expect(row?.generated).toBe(true);
      expect(row?.priority).toEqual([1, 0, 0, 0]);
      expect(row?.units).toEqual([3, 4]);
      expect(row?.onSceneS).toEqual([1200, 2400]);
      expect(row?.dispositions).toEqual(['reportTaken', 'handled']);
    }
    expect(findCallType('multiVehicleCrash')?.districts).toMatchObject({ highway: 3, industrial: 0.5, rural: 0.5 });
    expect(findCallType('buildingCollapse')?.districts).toMatchObject({ downtown: 1, industrial: 1.5, suburbs: 0.5 });
    expect(findCallType('hazmatRelease')?.districts).toMatchObject({ industrial: 2, harbor: 2, highway: 1 });
    expect(CALL_TYPES.filter((t) => t.id.match(/^(multiVehicleCrash|buildingCollapse|hazmatRelease)$/))).toHaveLength(3);
  });

  it('every massCasualty outcome is reachable and the well-run witness selects it', () => {
    const result = reachableOutcomes(mci);
    expect(result.map((r) => r.outcome)).toEqual(['wellRun', 'noCommand', 'default']);
    for (const r of result) {
      expect(r.reachable, r.outcome).toBe(true);
      expect(outcomeFor(mci, new Set(r.witness)).id).toBe(r.outcome);
    }
  });

  it('a family with establishCommand can produce every command flag, one without cannot', () => {
    const flags = producibleFlags(mci, mci.branches[0]!);
    for (const f of COMMAND_FLAG_NAMES) expect(flags.has(f), f).toBe(true);
    const barricade = CALL_CATALOG.families.find((f) => f.id === 'barricade')!;
    expect(producibleFlags(barricade, barricade.branches[0]!).has('triaged')).toBe(false);
    expect(producibleFlags(barricade, barricade.branches[0]!).has('negotiatorOnScene')).toBe(true);
  });

  it('knows the new flag vocabulary', () => {
    for (const f of ['mci', 'roadway', 'trapped', 'decon']) expect(BRANCH_FLAG_NAMES).toContain(f);
    for (const f of ['triaged', 'transportedRed', 'icsTransport']) expect(SCENE_FLAG_NAMES).toContain(f);
    expect([...COMMAND_FLAG_NAMES]).toEqual([
      'commandPost', 'contained', 'perimeter', 'evacuated', 'trafficControl', 'triaged', 'transportedRed', 'icsTransport',
      'negotiated', 'swatResolved', 'csuProcessed', 'federalNotified',
    ]);
  });

  it('requires a request action for each of the 17 service kinds', () => {
    expect(SERVICE_KINDS).toHaveLength(17);
    const raw = rawInput();
    raw.actions.actions = (raw.actions.actions as Json[]).filter((a) => a.id !== 'requestAirUnit');
    // The families still list it, so the first complaint may be either the family or the missing action.
    expect(() => validate(raw)).toThrow(/requestAirUnit/);
    const raw2 = rawInput();
    raw2.services.services = (raw2.services.services as Json[]).filter((s) => s.id !== 'csu');
    expect(() => validate(raw2)).toThrow(/services\.json: services is missing service "csu"/);
  });

  it('rejects a misspelled command flag in a condition and accepts the real one', () => {
    const raw = rawInput();
    (family(raw, 'massCasualty').objectives as Json[])[1]!.done = 'triagedd';
    expect(() => validate(raw)).toThrow(/uses unknown flag "triagedd"/);
    const ok = rawInput();
    (family(ok, 'massCasualty').objectives as Json[])[1]!.done = 'triaged';
    expect(() => validate(ok)).not.toThrow();
  });

  it('rejects a branch flag outside the vocabulary and keeps the new ones valid', () => {
    const raw = rawInput();
    (family(raw, 'massCasualty').branches as Json[])[0]!.flags = ['mci', 'wobbly'];
    expect(() => validate(raw)).toThrow(/families\.json: families\[\d+\]\.branches\[0\]\.flags\[1\] must be one of/);
    expect(() => validate(clone(rawInput()))).not.toThrow();
  });
});
