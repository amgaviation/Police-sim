import { describe, expect, it } from 'vitest';
import { ids, makeRig } from './helpers';

describe('base identity ignores the records overlay', () => {
  it('booking a contact or serving a warrant changes only wanted/record', () => {
    const rig = makeRig(42, 12 * 3600);
    let withWarrants = 0;
    for (const id of ids(1500)) {
      const a = rig.pop.identity(id);
      rig.records.addContact(id, { gameSeconds: 12 * 3600, kind: 'arrest', ref: 'X', summary: 'Booked' });
      for (const w of rig.records.peekPerson(id).warrants) {
        rig.records.serveWarrant(id, w.id);
        withWarrants++;
      }
      const b = rig.pop.identity(id);
      expect(b.risk).toBe(a.risk);
      expect(b.honesty).toBe(a.honesty);
      expect(b.attitude).toBe(a.attitude);
      expect(b.drugUse).toBe(a.drugUse);
      expect(b.mental).toBe(a.mental);
      expect(b.baseItems).toEqual(a.baseItems);
      expect(b.wanted).toBe(false);
    }
    expect(withWarrants).toBeGreaterThan(0);
  });
});
