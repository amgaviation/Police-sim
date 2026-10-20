import { describe, expect, it } from 'vitest';
import { getRuleset } from '../../src/legal/ruleset';
import { IndicatorBook } from '../../src/legal/scores';

const generic = getRuleset('generic');
const strict = getRuleset('strict');

describe('IndicatorBook', () => {
  it('sums weights up to the query time', () => {
    const book = new IndicatorBook(generic);
    book.add(1, 'odorAlcohol', 1, 5, false);
    book.add(1, 'bacOver', 2, 20, false);
    expect(book.pc(1, 'dui', 4)).toBe(0);
    expect(book.pc(1, 'dui', 5)).toBeCloseTo(0.6);
    expect(book.pc(1, 'dui', 20)).toBeCloseTo(2.1);
    expect(book.rs(1, 20)).toBeCloseTo(1.6);
    expect(book.armed(1, 20)).toBe(0);
  });

  it('ignores tainted entries', () => {
    const book = new IndicatorBook(generic);
    book.add(1, 'bacOver', 1, 5, true);
    book.add(1, 'odorAlcohol', 2, 5, false);
    expect(book.pc(1, 'dui', 10)).toBeCloseTo(0.6);
    expect(book.has(1, 'bacOver', 10)).toBe(false);
    expect(book.has(1, 'odorAlcohol', 10)).toBe(true);
    expect(book.indicators(1, 10)).toEqual(['odorAlcohol']);
  });

  it('applies person -1 entries to everyone and keeps persons apart', () => {
    const book = new IndicatorBook(generic);
    book.add(-1, 'stolenVehicle', 1, 1, false);
    book.add(2, 'weaponSeen', 2, 1, false);
    expect(book.pc(1, 'felonyVehicle', 5)).toBeCloseTo(1.5);
    expect(book.pc(2, 'felonyVehicle', 5)).toBeCloseTo(1.5);
    expect(book.armed(1, 5)).toBeCloseTo(0.3);
    expect(book.armed(2, 5)).toBeCloseTo(1.3);
    expect(book.pc(-1, 'felonyVehicle', 5)).toBeCloseTo(1.5);
    expect(book.has(3, 'stolenVehicle', 5)).toBe(true);
    expect(book.has(1, 'weaponSeen', 5)).toBe(false);
  });

  it('counts licenseInvalid only for drivers', () => {
    const book = new IndicatorBook(generic);
    book.setRole(1, 'driver');
    book.setRole(2, 'passenger');
    book.add(1, 'licenseInvalid', 1, 1, false);
    book.add(2, 'licenseInvalid', 2, 1, false);
    expect(book.rs(1, 5)).toBe(0.5);
    expect(book.rs(2, 5)).toBe(0);
    expect(book.has(2, 'licenseInvalid', 5)).toBe(false);
  });

  it('resolves callSuspect through the call family', () => {
    const book = new IndicatorBook(generic);
    book.add(1, 'callSuspect', 1, 1, false);
    expect(book.pc(1, 'property', 5)).toBeCloseTo(0.8);
    book.setFamily('violent');
    expect(book.pc(1, 'property', 5)).toBe(0);
    expect(book.pc(1, 'violent', 5)).toBeCloseTo(0.8);
    book.setFamily('unknown family');
    expect(book.pc(1, 'property', 5)).toBeCloseTo(0.8);
  });

  it('bestPc honors the threshold, arrestability and ties', () => {
    const book = new IndicatorBook(generic);
    expect(book.bestPc(1, 5, false)).toBeNull();
    book.add(1, 'speeding', 1, 1, false);
    expect(book.bestPc(1, 5, true)).toBe('traffic');
    book.add(1, 'warrantHit', 2, 1, false);
    expect(book.bestPc(1, 5, false)).toBe('warrant'); // 2.0 ties with traffic: warrant is more severe
    const s = new IndicatorBook(strict);
    s.add(1, 'speeding', 1, 1, false);
    expect(s.bestPc(1, 5, false)).toBe('traffic');
    expect(s.bestPc(1, 5, true)).toBeNull();
  });

  it('knownOffense picks the most severe offense with any weight', () => {
    const book = new IndicatorBook(generic);
    expect(book.knownOffense(1, 5)).toBeNull();
    book.add(1, 'speeding', 1, 1, false);
    expect(book.knownOffense(1, 5)).toBe('traffic');
    book.add(1, 'weaponCall', 2, 1, false);
    expect(book.knownOffense(1, 5)).toBe('weapons');
    book.add(1, 'stolenVehicle', 3, 10, false);
    expect(book.knownOffense(1, 5)).toBe('weapons');
    const tainted = new IndicatorBook(generic);
    tainted.add(1, 'assaultOnOfficer', 1, 1, true);
    expect(tainted.knownOffense(1, 5)).toBeNull();
  });

  it('ignores unknown indicator ids', () => {
    const book = new IndicatorBook(generic);
    book.add(1, 'mystery', 1, 1, false);
    expect(book.rs(1, 5)).toBe(0);
    expect(book.knownOffense(1, 5)).toBeNull();
  });
});
