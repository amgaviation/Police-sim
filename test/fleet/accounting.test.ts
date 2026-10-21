import { describe, expect, it } from 'vitest';
import {
  FLEET_CLASSES, FleetLedger, MAINTENANCE, chargePoints, damageCost, isLedgerSave, isWreck, serviceQuote,
} from '../../src/fleet';
import { condition } from './helpers';

const P = MAINTENANCE.prices;

describe('serviceQuote', () => {
  it('a clean vehicle quotes 0 for every service', () => {
    for (const service of ['refuel', 'oil', 'tires', 'repair', 'all'] as const) {
      const q = serviceQuote(service, condition(), 60, 'patrol');
      expect(q.total).toBe(0);
      expect(q.lines).toEqual([]);
    }
  });

  it('refuel is (1 - fuel) x capacity x price and never multiplied by the class', () => {
    const cond = condition({ fuelFraction: 0.5 });
    for (const cls of FLEET_CLASSES) {
      const q = serviceQuote('refuel', cond, 60, cls);
      expect(q.total).toBe(30 * P.fuelPerL);
      expect(q.lines).toHaveLength(1);
      expect(q.lines[0]?.kind).toBe('fuel');
    }
    expect(serviceQuote('refuel', condition({ fuelFraction: 0.333 }), 60, 'air').total).toBe(Math.round(0.667 * 60 * 2));
    expect(serviceQuote('refuel', condition({ fuelFraction: 0 }), 100, 'patrol').total).toBe(200);
  });

  it('an oil change costs the price times the class multiplier, only when the oil is below full', () => {
    const cond = condition({ oilFraction: 0.5 });
    expect(serviceQuote('oil', cond, 60, 'patrol').total).toBe(80);
    expect(serviceQuote('oil', cond, 60, 'supervisor').total).toBe(88);
    expect(serviceQuote('oil', cond, 60, 'k9').total).toBe(96);
    expect(serviceQuote('oil', cond, 60, 'motor').total).toBe(48);
    expect(serviceQuote('oil', cond, 60, 'bicycle').total).toBe(4);
    expect(serviceQuote('oil', cond, 60, 'air').total).toBe(640);
    for (const cls of FLEET_CLASSES) {
      expect(serviceQuote('oil', cond, 60, cls).total).toBe(Math.round(80 * (MAINTENANCE.classMultiplier[cls] ?? 1)));
    }
    expect(serviceQuote('oil', condition({ oilFraction: 1 }), 60, 'patrol').total).toBe(0);
  });

  it('tyres cost per wheel that is flat or worn, once, times the class', () => {
    const cond = condition({ flats: [true, false, false, false], tread: [0.5, 1, 1, 0.9] });
    expect(serviceQuote('tires', cond, 60, 'patrol').total).toBe(2 * 180);
    expect(serviceQuote('tires', cond, 60, 'swat').total).toBe(2 * 450);
    expect(serviceQuote('tires', condition({ tread: [0.99, 0.99, 0.99, 0.99] }), 60, 'patrol').total).toBe(720);
    expect(serviceQuote('tires', condition({ flats: [false, false, true, true] }), 60, 'patrol').total).toBe(360);
    expect(serviceQuote('tires', cond, 60, 'patrol').lines[0]?.kind).toBe('tire');
  });

  it('repair is the body zones plus the engine, times the class', () => {
    const cond = condition({ zones: [0.5, 0.25, 0, 0], engineHealth: 0.8 });
    const q = serviceQuote('repair', cond, 60, 'patrol');
    expect(q.lines.map((l) => [l.kind, l.cost])).toEqual([['body', 1800], ['engine', 1800]]);
    expect(q.total).toBe(3600);
    expect(serviceQuote('repair', cond, 60, 'marine').total).toBe(7200);
    expect(serviceQuote('repair', cond, 60, 'bicycle').total).toBe(180);
    expect(serviceQuote('repair', condition({ zones: [1, 0, 0, 0] }), 60, 'armored').total).toBe(9600);
  });

  it('a failed engine is replaced at the replacement price', () => {
    const cond = condition({ engineFailed: true, engineHealth: 0.02 });
    const q = serviceQuote('repair', cond, 60, 'patrol');
    expect(q.total).toBe(14000);
    expect(q.lines.map((l) => l.label)).toEqual(['Engine replacement']);
    expect(serviceQuote('repair', cond, 60, 'supervisor').total).toBe(15400);
  });

  it('all adds every line, each class-multiplied except fuel', () => {
    const cond = condition({
      fuelFraction: 0.5, oilFraction: 0.2, tread: [0.5, 1, 1, 1], zones: [0.5, 0, 0, 0], engineHealth: 0.9,
    });
    const q = serviceQuote('all', cond, 60, 'k9');
    expect(q.lines.map((l) => [l.kind, l.cost])).toEqual([
      ['fuel', 60], ['oil', 96], ['tire', 216], ['body', 1440], ['engine', 1080],
    ]);
    expect(q.total).toBe(60 + 96 + 216 + 1440 + 1080);
  });

  it('honours a custom config', () => {
    const cfg = { ...MAINTENANCE, prices: { ...P, oilChange: 100 } };
    expect(serviceQuote('oil', condition({ oilFraction: 0 }), 60, 'patrol', cfg).total).toBe(100);
  });
});

describe('damageCost and isWreck', () => {
  it('zones x body price + engine delta x engine price + new flats x tyre price', () => {
    expect(damageCost([0.5, 0, 0, 0], 0.2, 1, false, 'patrol')).toBe(1200 + 1800 + 180);
    expect(damageCost([0.25, 0.25, 0, 0], 0, 0, false, 'patrol')).toBe(1200);
    expect(damageCost([0, 0, 0, 0], 0, 0, false, 'patrol')).toBe(0);
  });

  it('applies the class multiplier', () => {
    expect(damageCost([0.5, 0, 0, 0], 0.2, 1, false, 'supervisor')).toBe(1320 + 1980 + 198);
    expect(damageCost([1, 0, 0, 0], 0, 0, false, 'air')).toBe(19200);
  });

  it('an engine failure uses the replacement price instead of the delta', () => {
    expect(damageCost([0.5, 0, 0, 0], 0.4, 0, true, 'patrol')).toBe(1200 + 14000);
    expect(damageCost([0, 0, 0, 0], 0.1, 0, true, 'patrol')).toBe(14000);
  });

  it('a wreck is a zone sum of 2.5 or an engine failure', () => {
    expect(isWreck([1, 1, 0.5, 0], false)).toBe(true);
    expect(isWreck([1, 1, 0.49, 0], false)).toBe(false);
    expect(isWreck([0, 0, 0, 0], true)).toBe(true);
    expect(isWreck([0, 0, 0, 0], true, { ...MAINTENANCE, wreck: { zoneSum: 2.5, engineFailed: false } })).toBe(false);
  });
});

describe('chargePoints', () => {
  const base = { pursuit: false, emergency: false, reported: true, wreck: false };

  it('a $4 800 reported patrol crash is -5', () => {
    expect(chargePoints(4800, base)).toBe(-5);
  });

  it('is -1 in a pursuit, -2 on an emergency run, -10 unreported', () => {
    expect(chargePoints(4800, { ...base, pursuit: true })).toBe(-1);
    expect(chargePoints(4800, { ...base, emergency: true })).toBe(-2);
    expect(chargePoints(4800, { ...base, reported: false })).toBe(-10);
  });

  it('a pursuit outranks an emergency', () => {
    expect(chargePoints(4800, { ...base, pursuit: true, emergency: true })).toBe(-1);
  });

  it('a wreck adds 10 before the unreported factor', () => {
    expect(chargePoints(4800, { ...base, wreck: true })).toBe(-15);
    expect(chargePoints(0, { ...base, wreck: true })).toBe(-10);
    expect(chargePoints(1000, { ...base, wreck: true, reported: false })).toBe(-20);
  });

  it('clamps at 20 points', () => {
    expect(chargePoints(4800, { ...base, wreck: true, reported: false })).toBe(-20);
    expect(chargePoints(900000, base)).toBe(-20);
  });

  it('is exactly 0 (never -0) when nothing is owed', () => {
    expect(Object.is(chargePoints(0, base), 0)).toBe(true);
    expect(Object.is(chargePoints(100, base), 0)).toBe(true);
    expect(Object.is(chargePoints(0, { ...base, reported: false }), 0)).toBe(true);
    expect(Object.is(chargePoints(-50, base), 0)).toBe(true);
  });

  it('rounds to whole points', () => {
    expect(chargePoints(1400, base)).toBe(-1);
    expect(chargePoints(1600, base)).toBe(-2);
    expect(chargePoints(2500, base)).toBe(-3);
  });
});

describe('FleetLedger', () => {
  function entry(i: number): Parameters<FleetLedger['add']>[0] {
    return { game: i, unitId: 'P-101', kind: i % 2 === 0 ? 'fuel' : 'charge', cost: 10, points: i % 2 === 0 ? 0 : -1, note: `n${i}` };
  }

  it('numbers entries and keeps the running totals', () => {
    const ledger = new FleetLedger(10);
    expect(ledger.add({ game: 1, unitId: 'P-101', kind: 'fuel', cost: 60, points: 0, note: 'a' }).seq).toBe(1);
    expect(ledger.add({ game: 2, unitId: 'P-101', kind: 'repair', cost: 1800, points: 0, note: 'b' }).seq).toBe(2);
    ledger.add({ game: 3, unitId: 'P-101', kind: 'charge', cost: 4800, points: -5, note: 'c' });
    expect(ledger.entries()).toHaveLength(3);
    expect(ledger.departmentCost).toBe(1860);
    expect(ledger.officerPoints).toBe(-5);
  });

  it('keeps the totals when the oldest entries are evicted', () => {
    const ledger = new FleetLedger(3);
    for (let i = 0; i < 8; i++) ledger.add(entry(i));
    expect(ledger.entries().map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(ledger.departmentCost).toBe(40);
    expect(ledger.officerPoints).toBe(-4);
    expect(ledger.add(entry(8)).seq).toBe(9);
  });

  it('defaults to the configured limit', () => {
    const ledger = new FleetLedger();
    for (let i = 0; i < MAINTENANCE.limits.ledger + 25; i++) ledger.add(entry(0));
    expect(ledger.entries()).toHaveLength(MAINTENANCE.limits.ledger);
    expect(ledger.departmentCost).toBe((MAINTENANCE.limits.ledger + 25) * 10);
  });

  it('round-trips through serialize and restore, including evicted totals', () => {
    const ledger = new FleetLedger(4);
    for (let i = 0; i < 9; i++) ledger.add(entry(i));
    const save = ledger.serialize();
    expect(isLedgerSave(save)).toBe(true);
    expect(isLedgerSave(JSON.parse(JSON.stringify(save)))).toBe(true);
    const copy = FleetLedger.restore(JSON.parse(JSON.stringify(save)) as typeof save, 4);
    expect(copy.serialize()).toEqual(save);
    expect(copy.entries()).toEqual(ledger.entries());
    expect(copy.departmentCost).toBe(ledger.departmentCost);
    expect(copy.officerPoints).toBe(ledger.officerPoints);
    expect(copy.add(entry(1)).seq).toBe(ledger.add(entry(1)).seq);
  });

  it('serialize does not alias the entries', () => {
    const ledger = new FleetLedger(4);
    ledger.add(entry(0));
    const save = ledger.serialize();
    save.entries[0]!.cost = 999;
    expect(ledger.entries()[0]?.cost).toBe(10);
  });

  it('isLedgerSave rejects malformed saves', () => {
    const good = new FleetLedger(4);
    good.add(entry(0));
    const s = good.serialize();
    expect(isLedgerSave(null)).toBe(false);
    expect(isLedgerSave({ ...s, entries: 'x' })).toBe(false);
    expect(isLedgerSave({ ...s, nextSeq: 1.5 })).toBe(false);
    expect(isLedgerSave({ ...s, departmentCost: NaN })).toBe(false);
    expect(isLedgerSave({ ...s, officerPoints: '0' })).toBe(false);
    expect(isLedgerSave({ ...s, entries: [{ ...s.entries[0], kind: 'tip' }] })).toBe(false);
    expect(isLedgerSave({ ...s, entries: [{ ...s.entries[0], note: 1 }] })).toBe(false);
  });
});
