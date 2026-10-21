/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import worldJson from '../../src/data/worldstate/world.json';
import { CRIME_DISTRICTS } from '../../src/environment/crime';
import { OFFENSE_CLASSES, WORLD_CONFIG, parseWorldConfig } from '../../src/worldstate';
import { CASE_STATUSES, OFFENDER_CUSTODY, PREMISE_FLAGS } from '../../src/worldstate';

function clone(): any {
  return structuredClone(worldJson);
}

function reject(edit: (j: any) => void, message: RegExp): void {
  const j = clone();
  edit(j);
  expect(() => parseWorldConfig(j, 'world.json')).toThrow(message);
}

describe('world.json', () => {
  it('parses to the design values', () => {
    expect(WORLD_CONFIG.premises).toEqual({ max: 400, entriesPerPremise: 12, repeatWindowDays: 30, repeatThreshold: 2 });
    expect(WORLD_CONFIG.cases).toEqual({
      max: 120, coldAfterShifts: 10, followUpChance: 0.5, maxFollowUpsPerShift: 2,
      categories: ['theft', 'burglary', 'robbery', 'assault', 'domestic', 'vandalism'],
    });
    expect(WORLD_CONFIG.offenders).toEqual({
      max: 300, jailDays: { infraction: 0, misdemeanor: 2, felony: 10, warrant: 1 }, pendingReleaseDays: 1, riskBase: 0.25,
      riskPerPrior: 0.12, riskJuvenile: 0.15, riskConvicted: 0.05, riskMax: 0.9, riskMin: 0.05, riskDecayPerDay: 0.01,
    });
    expect(WORLD_CONFIG.recidivism).toEqual({ pickChanceScale: 0.6, maxPickChance: 0.45, sameDistrictWeight: 2 });
    expect(WORLD_CONFIG.witnesses).toEqual({ max: 200, movePerDay: 0.04, unknownAddressShare: 0.3 });
    expect(WORLD_CONFIG.repeatCalls).toEqual({ chance: 0.2, minEntries: 2 });
    const n = WORLD_CONFIG.neighborhoods;
    expect([n.relax, n.trustWeight, n.offenderWeight, n.arrestWeight, n.noise, n.min, n.max, n.historyDays, n.crimeToTrust]).toEqual([
      0.15, 0.6, 0.02, 0.01, 0.03, 0.05, 0.95, 14, 0.02,
    ]);
    expect(n.factorRange).toEqual([0.7, 1.5]);
  });

  it('has a base crime for every district', () => {
    expect(Object.keys(WORLD_CONFIG.neighborhoods.baseCrime).sort()).toEqual([...CRIME_DISTRICTS].sort());
    expect(WORLD_CONFIG.neighborhoods.baseCrime.water).toBe(0);
  });

  it('fixed id lists match the design', () => {
    expect(PREMISE_FLAGS).toEqual(['weapon', 'violence', 'arrest', 'officerSafety', 'drugs', 'mentalHealth', 'repeat']);
    expect(CASE_STATUSES).toEqual(['open', 'followUp', 'cleared', 'cold']);
    expect(OFFENDER_CUSTODY).toEqual(['jailed', 'released', 'atLarge']);
    expect(OFFENSE_CLASSES).toEqual(['infraction', 'misdemeanor', 'felony', 'warrant']);
  });
});

describe('parseWorldConfig rejects', () => {
  it('a non-object, a wrong version and missing sections with file and path', () => {
    expect(() => parseWorldConfig(null, 'w.json')).toThrow(/^w\.json: /);
    reject((j) => { j.version = 2; }, /world\.json: version must be 1/);
    reject((j) => { delete j.premises; }, /world\.json: premises must be an object/);
    reject((j) => { delete j.repeatCalls; }, /world\.json: repeatCalls must be an object/);
  });

  it('bad numbers', () => {
    reject((j) => { j.premises.max = 0; }, /premises\.max/);
    reject((j) => { j.premises.max = 1.5; }, /premises\.max must be an integer/);
    reject((j) => { j.cases.followUpChance = 2; }, /cases\.followUpChance/);
    reject((j) => { j.witnesses.movePerDay = 'x'; }, /witnesses\.movePerDay/);
    reject((j) => { j.offenders.riskMin = 0.95; }, /offenders\.riskMin must not exceed riskMax/);
    reject((j) => { j.neighborhoods.min = 0.99; }, /neighborhoods\.min must not exceed max/);
    reject((j) => { j.neighborhoods.factorRange = [1.5, 0.7]; }, /neighborhoods\.factorRange/);
    reject((j) => { j.neighborhoods.factorRange = [1]; }, /neighborhoods\.factorRange must have 2 items/);
  });

  it('unknown districts and out-of-range base crime', () => {
    reject((j) => { j.neighborhoods.baseCrime.atlantis = 0.4; }, /neighborhoods\.baseCrime\.atlantis is not a district/);
    reject((j) => { j.neighborhoods.baseCrime.downtown = 1.2; }, /neighborhoods\.baseCrime\.downtown/);
    reject((j) => { j.neighborhoods.baseCrime.downtown = -0.1; }, /neighborhoods\.baseCrime\.downtown/);
  });

  it('bad categories and jail terms', () => {
    reject((j) => { j.cases.categories = []; }, /cases\.categories/);
    reject((j) => { j.cases.categories = ['theft', 'theft']; }, /cases\.categories\[1\] lists "theft" twice/);
    reject((j) => { j.cases.categories = ['piracy']; }, /cases\.categories\[0\]/);
    reject((j) => { delete j.offenders.jailDays.felony; }, /offenders\.jailDays\.felony/);
    reject((j) => { j.offenders.jailDays.treason = 5; }, /offenders\.jailDays\.treason is not an offense class/);
    reject((j) => { j.offenders.jailDays.felony = -1; }, /offenders\.jailDays\.felony/);
  });
});
