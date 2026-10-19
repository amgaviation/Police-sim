import { describe, expect, it } from 'vitest';
import {
  admissible,
  consentActive,
  lawfulPresence,
  plainView,
  searchAuthority,
  type ConsentRecord,
  type PresenceContext,
  type SearchContext,
  type SearchTarget,
} from '../../src/evidence/searchRules';

const HOUSE = 4;
const OTHER = 9;

function consent(over: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: 1, personId: 7, kind: 'searchRoom', granted: true, valid: true, authority: true,
    buildingId: HOUSE, room: 2, vehicleId: -1, sim: 100, revokedSim: -1, ...over,
  };
}

function presence(over: Partial<PresenceContext> = {}): PresenceContext {
  return {
    buildingId: HOUSE, room: 2, roomPublic: false, businessOpen: false, consents: [],
    exigency: false, warrant: false, sim: 200, ...over,
  };
}

function target(over: Partial<SearchTarget> = {}): SearchTarget {
  return { kind: 'container', buildingId: HOUSE, room: 2, container: 'drawer', hide: false, personId: -1, vehicleId: -1, ...over };
}

function search(ctx: Partial<SearchContext> = {}, t: Partial<SearchTarget> = {}): ReturnType<typeof searchAuthority> {
  return searchAuthority({ ...presence(), arrests: [], target: target(t), ...ctx });
}

describe('consentActive', () => {
  it('needs granted, valid, authority and no earlier revocation', () => {
    expect(consentActive(consent(), 200)).toBe(true);
    expect(consentActive(consent({ granted: false }), 200)).toBe(false);
    expect(consentActive(consent({ valid: false }), 200)).toBe(false);
    expect(consentActive(consent({ authority: false }), 200)).toBe(false);
    expect(consentActive(consent({ revokedSim: 150 }), 200)).toBe(false);
    expect(consentActive(consent({ revokedSim: 150 }), 149)).toBe(true);
    expect(consentActive(consent({ revokedSim: 150 }), 150)).toBe(false);
  });
});

describe('lawfulPresence', () => {
  it('is always lawful outdoors', () => {
    expect(lawfulPresence(presence({ buildingId: -1, room: -1 })).lawful).toBe(true);
  });
  it('treats the public room of an open business as lawful, not a closed store or a back office', () => {
    const open = lawfulPresence(presence({ roomPublic: true, businessOpen: true }));
    expect(open).toEqual({ lawful: true, basis: 'publicArea' });
    expect(lawfulPresence(presence({ roomPublic: true, businessOpen: false })).lawful).toBe(false);
    expect(lawfulPresence(presence({ roomPublic: false, businessOpen: true })).lawful).toBe(false);
  });
  it('accepts warrant and exigency', () => {
    expect(lawfulPresence(presence({ warrant: true })).basis).toBe('warrant');
    expect(lawfulPresence(presence({ exigency: true })).basis).toBe('exigency');
  });
  it('accepts entry, premises and room consent by scope', () => {
    expect(lawfulPresence(presence({ consents: [consent({ kind: 'entry', room: -1 })] }))).toEqual({ lawful: true, basis: 'invited' });
    expect(lawfulPresence(presence({ consents: [consent({ kind: 'searchPremises', room: -1 })], room: 5 })).lawful).toBe(true);
    expect(lawfulPresence(presence({ consents: [consent({ kind: 'searchRoom', room: 2 })], room: 2 })).lawful).toBe(true);
    expect(lawfulPresence(presence({ consents: [consent({ kind: 'searchRoom', room: 2 })], room: 3 })).lawful).toBe(false);
    expect(lawfulPresence(presence({ consents: [consent({ kind: 'entry' })], buildingId: OTHER })).lawful).toBe(false);
  });
  it('ignores consents that are denied, invalid, without authority or revoked', () => {
    for (const bad of [{ granted: false }, { valid: false }, { authority: false }, { revokedSim: 150 }]) {
      expect(lawfulPresence(presence({ consents: [consent({ kind: 'entry', ...bad })] })).lawful).toBe(false);
    }
  });
  it('ignores search-person, vehicle, pbt and sfst consents for presence', () => {
    for (const kind of ['searchPerson', 'searchVehicle', 'pbt', 'sfst'] as const) {
      expect(lawfulPresence(presence({ consents: [consent({ kind })] })).lawful).toBe(false);
    }
  });
});

describe('plainView', () => {
  const base = { presence: presence({ warrant: true }), concealed: false, visible: true, incriminating: true };
  it('passes with all four conditions', () => {
    expect(plainView(base)).toMatchObject({ plainView: true });
  });
  it('fails when any single condition is missing, with a reason', () => {
    for (const bad of [
      { presence: presence() },
      { visible: false },
      { concealed: true },
      { incriminating: false },
    ]) {
      const res = plainView({ ...base, ...bad });
      expect(res.plainView).toBe(false);
      expect(res.reason.length).toBeGreaterThan(5);
    }
  });
  it('works in the public room of an open store but not in its back office', () => {
    expect(plainView({ ...base, presence: presence({ warrant: false, roomPublic: true, businessOpen: true }) }).plainView).toBe(true);
    expect(plainView({ ...base, presence: presence({ warrant: false, roomPublic: false, businessOpen: true }) }).plainView).toBe(false);
  });
});

describe('searchAuthority: consent scope', () => {
  it('room consent allows a drawer in that room but not in the next room', () => {
    const c = [consent({ kind: 'searchRoom', room: 2 })];
    expect(search({ consents: c })).toMatchObject({ allowed: true, basis: 'consent' });
    const next = search({ consents: c, room: 3 }, { room: 3 });
    expect(next.allowed).toBe(false);
    expect(next.reason).toMatch(/does not cover/);
  });
  it('premises consent allows every room of its building and nothing in another building', () => {
    const c = [consent({ kind: 'searchPremises', room: -1 })];
    expect(search({ consents: c }, { room: 2 }).basis).toBe('consent');
    expect(search({ consents: c }, { room: 6, kind: 'room' }).basis).toBe('consent');
    expect(search({ consents: c, buildingId: OTHER }, { buildingId: OTHER }).allowed).toBe(false);
  });
  it('ignores consent that is denied, invalid, without authority or revoked', () => {
    for (const bad of [{ granted: false }, { valid: false }, { authority: false }, { revokedSim: 150 }]) {
      const res = search({ consents: [consent({ kind: 'searchPremises', ...bad })] });
      expect(res.allowed).toBe(false);
    }
  });
  it('entry consent gives presence only, not a drawer search', () => {
    const c = [consent({ kind: 'entry', room: -1 })];
    expect(lawfulPresence(presence({ consents: c })).lawful).toBe(true);
    const res = search({ consents: c });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/enter/);
  });
  it('person and vehicle consents cover only that person or vehicle', () => {
    const person = [consent({ kind: 'searchPerson', personId: 7 })];
    expect(search({ consents: person }, { kind: 'person', personId: 7, container: 'none' }).basis).toBe('consent');
    expect(search({ consents: person }, { kind: 'person', personId: 8, container: 'none' }).allowed).toBe(false);
    expect(search({ consents: person }).allowed).toBe(false);
    const veh = [consent({ kind: 'searchVehicle', vehicleId: 3 })];
    expect(search({ consents: veh }, { kind: 'vehicle', vehicleId: 3, container: 'none' }).basis).toBe('consent');
    expect(search({ consents: veh }, { kind: 'vehicle', vehicleId: 4, container: 'none' }).allowed).toBe(false);
  });
});

describe('searchAuthority: other bases', () => {
  it('a warrant allows everything', () => {
    for (const t of [
      { container: 'safe' as const },
      { kind: 'room' as const, container: 'none' as const },
      { kind: 'person' as const, container: 'none' as const },
      { kind: 'vehicle' as const, container: 'none' as const },
    ]) {
      expect(search({ warrant: true }, t)).toMatchObject({ allowed: true, basis: 'warrant' });
    }
  });
  it('public area allows open items of the public room of an open business only', () => {
    const open = { roomPublic: true, businessOpen: true };
    expect(search(open, { container: 'none' })).toMatchObject({ allowed: true, basis: 'publicArea' });
    expect(search(open, { container: 'drawer' }).allowed).toBe(false);
    expect(search({ roomPublic: true, businessOpen: false }, { container: 'none' }).allowed).toBe(false);
    expect(search({ roomPublic: false, businessOpen: true }, { container: 'none' }).allowed).toBe(false);
    expect(search(open, { container: 'none', room: 3 }).allowed).toBe(false);
  });
  it('exigency allows rooms but not drawers', () => {
    expect(search({ exigency: true }, { kind: 'room', container: 'none' })).toMatchObject({ allowed: true });
    const drawer = search({ exigency: true }, { container: 'drawer' });
    expect(drawer.allowed).toBe(false);
    expect(drawer.reason).toMatch(/Exigent/);
    expect(search({ exigency: true }, { kind: 'person', container: 'none' }).allowed).toBe(false);
  });
  it('a protective sweep allows a closet (hide place) but not a drawer', () => {
    const closet = search({ exigency: true }, { container: 'closet', hide: true });
    expect(closet).toMatchObject({ allowed: true, basis: 'protectiveSweep' });
    expect(search({ exigency: true }, { container: 'drawer', hide: false }).allowed).toBe(false);
    // An arrest on the premises also licenses the sweep, even in another room.
    const arrests = [{ personId: 1, buildingId: HOUSE, room: 5, sim: 100 }];
    expect(search({ arrests }, { container: 'closet', hide: true })).toMatchObject({ allowed: true, basis: 'protectiveSweep' });
    expect(search({ arrests }, { container: 'drawer', hide: false }).allowed).toBe(false);
    // An arrest in another building does not.
    const far = [{ personId: 1, buildingId: OTHER, room: 5, sim: 100 }];
    expect(search({ arrests: far }, { container: 'closet', hide: true }).allowed).toBe(false);
  });
  it('search incident to arrest covers the arrest room within 600 s only', () => {
    const arrests = [{ personId: 1, buildingId: HOUSE, room: 2, sim: 100 }];
    expect(search({ arrests, sim: 100 })).toMatchObject({ allowed: true, basis: 'incidentToArrest' });
    expect(search({ arrests, sim: 700 }).basis).toBe('incidentToArrest');
    const late = search({ arrests, sim: 701 });
    expect(late.allowed).toBe(false);
    expect(late.reason).toMatch(/600/);
    expect(search({ arrests, sim: 300 }, { room: 3 }).allowed).toBe(false);
    expect(search({ arrests: [{ personId: 1, buildingId: OTHER, room: 2, sim: 100 }], sim: 300 }).allowed).toBe(false);
    expect(search({ arrests, sim: 50 }).allowed).toBe(false);
  });
  it('the arrested person can be searched within the window', () => {
    const arrests = [{ personId: 1, buildingId: HOUSE, room: 2, sim: 100 }];
    expect(search({ arrests, sim: 150 }, { kind: 'person', personId: 1, container: 'none' }).basis).toBe('incidentToArrest');
    expect(search({ arrests, sim: 150 }, { kind: 'person', personId: 2, container: 'none' }).allowed).toBe(false);
  });
  it('picks the first basis in order (warrant before consent before arrest)', () => {
    const c = [consent({ kind: 'searchPremises' })];
    const arrests = [{ personId: 1, buildingId: HOUSE, room: 2, sim: 100 }];
    expect(search({ warrant: true, consents: c, arrests, exigency: true }).basis).toBe('warrant');
    expect(search({ consents: c, arrests, exigency: true }).basis).toBe('consent');
    expect(search({ arrests, exigency: true }).basis).toBe('incidentToArrest');
  });
  it('refuses with a reason when nothing applies', () => {
    const res = search();
    expect(res).toMatchObject({ allowed: false, basis: null });
    expect(res.reason).toMatch(/warrant/);
  });
});

describe('admissible', () => {
  it('needs a basis', () => {
    expect(admissible({ basis: 'plainView' })).toBe(true);
    expect(admissible({ basis: 'consent' })).toBe(true);
    expect(admissible({ basis: null })).toBe(false);
  });
});
