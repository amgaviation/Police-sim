import { describe, expect, it } from 'vitest';
import { dailyBolos } from '../../src/records/bolo';
import { CALENDAR } from '../../src/records/calendar';
import { RecordsDb } from '../../src/records/db';
import { generatePerson } from '../../src/records/person';
import { generateRegistration } from '../../src/records/vehicle';
import { fakeCtx, SEEDS } from './helpers';

describe.each(SEEDS)('daily BOLO coherence (seed %i)', (seed) => {
  it('derives every reason from the record that selected the subject', () => {
    let vehicles = 0, missing = 0, wanted = 0;
    for (let day = CALENDAR.startEpochDay; day < CALENDAR.startEpochDay + 60; day++) {
      for (const b of dailyBolos(seed, day)) {
        if (b.kind === 'vehicle') {
          vehicles++;
          const reg = generateRegistration(seed, b.vehicleId);
          expect(/Stolen vehicle/.test(b.text), b.text).toBe(reg.stolen);
          if (!reg.stolen) expect(b.text.startsWith(`${reg.flag ?? '?'} - `), b.text).toBe(true);
          continue;
        }
        const p = generatePerson(seed, b.personId, fakeCtx());
        if (/Missing person/.test(b.text)) {
          missing++;
          expect(p.warrants, b.text).toEqual([]);
        } else {
          wanted++;
          const first = p.warrants[0];
          expect(first, b.text).toBeDefined();
          expect(b.text.toLowerCase()).toContain(first?.offense.toLowerCase());
        }
      }
    }
    expect(vehicles).toBeGreaterThan(50);
    expect(missing).toBeGreaterThan(0);
    expect(wanted).toBeGreaterThan(missing);
  });

  it('withdraws a wanted-person BOLO once every warrant is served (and only then)', () => {
    let day = CALENDAR.startEpochDay;
    let db = new RecordsDb(seed, fakeCtx(day));
    let pb = db.bolos(day).find((b) => b.kind === 'person' && !/Missing person/.test(b.text));
    while (!pb) {
      day++;
      db = new RecordsDb(seed, fakeCtx(day));
      pb = db.bolos(day).find((b) => b.kind === 'person' && !/Missing person/.test(b.text));
    }
    const warrants = db.person(pb.personId).warrants;
    expect(db.personHits(pb.personId).some((h) => h.kind === 'bolo')).toBe(true);
    for (const w of warrants.slice(0, -1)) db.serveWarrant(pb.personId, w.id);
    expect(db.bolos(day).some((b) => b.id === pb.id)).toBe(true);
    const last = warrants[warrants.length - 1];
    if (last) db.serveWarrant(pb.personId, last.id);
    expect(db.bolos(day).some((b) => b.id === pb.id)).toBe(false);
    expect(db.personHits(pb.personId).filter((h) => h.severity === 'alert' && h.kind === 'bolo')).toEqual([]);
    // Survives save/load.
    const db2 = new RecordsDb(seed, fakeCtx(day));
    db2.restore(db.serialize());
    expect(db2.bolos(day).some((b) => b.id === pb.id)).toBe(false);
  });
});
