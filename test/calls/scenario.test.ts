import { describe, expect, it } from 'vitest';
import { CALL_CATALOG, familyForType } from '../../src/calls/catalog';
import { buildScenario, type Scenario } from '../../src/calls/scenario';
import { rngFor, rolesOf, satisfies, stubInput, traits, type StubOptions } from './stub';

function build(o: StubOptions): Scenario {
  const input = stubInput(o);
  return buildScenario(input, rngFor(input.seed, input.callId));
}

function many(typeId: string, n: number, extra: Partial<StubOptions> = {}): Scenario[] {
  const out: Scenario[] = [];
  for (let i = 1; i <= n; i++) out.push(build({ typeId, callId: i, ...extra }));
  return out;
}

function within4Sigma(count: number, n: number, p: number): boolean {
  return Math.abs(count - n * p) <= 4 * Math.sqrt(n * p * (1 - p));
}

describe('buildScenario determinism and structure', () => {
  it('is a pure function of the input and the stream', () => {
    const a = build({ typeId: 'domesticDisturbance', callId: 7 });
    const b = build({ typeId: 'domesticDisturbance', callId: 7 });
    expect(a).toEqual(b);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    const others = new Set<string>();
    for (let id = 1; id <= 12; id++) others.add(JSON.stringify(build({ typeId: 'domesticDisturbance', callId: id })));
    expect(others.size).toBeGreaterThan(8);
    expect(build({ typeId: 'domesticDisturbance', callId: 7, seed: 99 })).not.toEqual(a);
  });

  it('throws for a type without a scene family', () => {
    expect(() => build({ typeId: 'officerAssist' })).toThrow(/no scenario family/);
    expect(() => build({ typeId: 'nope' })).toThrow(/nope/);
  });

  it('builds a consistent scenario for every generated catalog type', () => {
    for (const t of CALL_CATALOG.types) {
      if (CALL_CATALOG.families.find((f) => f.id === t.family)?.derived) continue;
      for (let id = 1; id <= 12; id++) {
        const s = build({ typeId: t.id, callId: id, reportedVehicleId: 1234 });
        const family = familyForType(t.id);
        expect(s.family).toBe(t.family);
        expect(s.typeId).toBe(t.id);
        expect(s.flags).toContain(`branch:${s.branch}`);
        expect(family?.branches.map((b) => b.id)).toContain(s.branch);
        expect((t.branchWeights[s.branch] ?? family?.branches.find((b) => b.id === s.branch)?.weight ?? 0)).toBeGreaterThan(0);
        s.participants.forEach((p, i) => {
          expect(p.index).toBe(i);
          if (p.body === 'dog') expect(p.personId).toBe(-1);
          else expect(p.personId).toBeGreaterThanOrEqual(0);
          if (p.spot === 'vehicle') expect(p.vehicle).toBeGreaterThanOrEqual(0);
        });
        s.vehicles.forEach((v, i) => expect(v.index).toBe(i));
        for (let i = 1; i < s.timeline.length; i++) expect(s.timeline[i]?.atS).toBeGreaterThanOrEqual(s.timeline[i - 1]?.atS ?? 0);
      }
    }
  });

  it('uses every branch with a positive weight and removes branch roles', () => {
    const seen = new Set<string>();
    for (const s of many('domesticDisturbance', 400)) {
      seen.add(s.branch);
      const roles = s.participants.map((p) => p.role);
      if (s.variants.includes('false')) continue;
      if (s.branch === 'suspectGone') expect(roles).not.toContain('suspect');
      else expect(roles).toContain('suspect');
      if (s.branch === 'assault') {
        expect(s.flags).toContain('injury:victim');
        const victim = s.participants.find((p) => p.role === 'victim');
        expect(victim?.injured).toBe(true);
        expect(victim?.profile).toBe('victimInjured');
      }
      if (s.branch === 'weapon') {
        const suspect = s.participants.find((p) => p.role === 'suspect');
        expect(suspect?.weapon).toBe('knife');
        expect(suspect?.profile).toBe('suspectArmedHostile');
      }
    }
    expect([...seen].sort()).toEqual(['assault', 'suspectGone', 'verbal', 'weapon']);
  });

  it('uses type branch weights (including person-constrained branches)', () => {
    for (const s of many('elderAbuseReport', 60)) {
      expect(['elderVerbal', 'elderAssault']).toContain(s.branch);
      if (s.variants.includes('false')) continue;
      const victim = s.participants.find((p) => p.role === 'victim');
      expect(traits(victim?.personId ?? -1).age).toBeGreaterThanOrEqual(70);
    }
    for (const s of many('trespassSchoolGrounds', 60)) {
      expect(s.branch).toBe('teen');
      if (s.variants.includes('false')) continue;
      const subject = s.participants.find((p) => p.role === 'subject');
      const age = traits(subject?.personId ?? -1).age;
      expect(age).toBeGreaterThanOrEqual(16);
      expect(age).toBeLessThanOrEqual(19);
    }
    for (const s of many('driverAsleepAtWheel', 40)) {
      expect(s.branch).toBe('asleepParked');
      if (s.variants.includes('false')) continue;
      expect(s.vehicles[0]?.mode).toBe('parked');
    }
  });

  it('honours person constraints (stub pickPerson table)', () => {
    for (const typeId of ['domesticDisturbance', 'wantedSubject', 'warrantService', 'suicidalSubject', 'robbery', 'burglaryInProgress', 'juvenileRunaway', 'protest']) {
      for (const s of many(typeId, 60)) {
        const roles = rolesOf(s);
        for (const p of s.participants) {
          const role = roles.find((r) => r.role === p.role);
          expect(role, `${typeId}/${p.role}`).toBeDefined();
          if (!role || p.body === 'dog' || typeof role.person === 'string') continue;
          expect(satisfies(p.personId, role.person), `${typeId}/${p.role}: ${p.personId} ${JSON.stringify(traits(p.personId))}`).toBe(true);
        }
      }
    }
  });

  it('fills sources: caller, driver, given and existing vehicles', () => {
    const dom = build({ typeId: 'domesticDisturbance', callId: 3, callerPersonId: 4242 });
    if (!dom.variants.includes('false')) expect(dom.participants.find((p) => p.role === 'caller')?.personId).toBe(4242);
    const noCaller = build({ typeId: 'domesticDisturbance', callId: 3, callerPersonId: -1 });
    const c = noCaller.participants.find((p) => p.role === 'caller');
    expect(traits(c?.personId ?? 0).age).toBeGreaterThanOrEqual(18);

    const stop = build({ typeId: 'trafficStop', callId: 5, existingVehicleId: 777, given: [10, 11, 12], derivedBranch: 'dui' });
    expect(stop.branch).toBe('dui');
    expect(stop.vehicles).toHaveLength(1);
    expect(stop.vehicles[0]).toMatchObject({ vehicleId: 777, existing: true, role: 'subjectVehicle' });
    const driver = stop.participants.find((p) => p.role === 'driver');
    expect(driver).toMatchObject({ personId: 10, spot: 'vehicle', vehicle: 0, seat: 0 });
    expect(stop.participants.filter((p) => p.role === 'passenger').map((p) => p.seat)).toEqual(
      stop.participants.filter((p) => p.role === 'passenger').map((_, i) => i + 1),
    );
    expect(stop.errors.wrongAddress).toBe(false);

    const dui = build({ typeId: 'impairedDriver', callId: 8, reportedVehicleId: 4321 });
    if (!dui.variants.includes('false') && !dui.variants.includes('swatting') && !dui.variants.includes('ambush')) {
      expect(dui.vehicles[0]).toMatchObject({ vehicleId: 4321, existing: false, reported: true, behavior: 'dui', mode: dui.branch === 'asleepParked' ? 'parked' : 'driving' });
      expect(dui.participants.find((p) => p.role === 'driver')?.personId).toBe(60000 + 4321);
    }
    const pursuit = build({ typeId: 'vehiclePursuit', callId: 2, existingVehicleId: 55, given: [9], derivedBranch: null });
    if (pursuit.branch === 'chase') expect(pursuit.vehicles[0]).toMatchObject({ existing: true, vehicleId: 55, flee: 1 });
  });

  it('removes the vehicle seat of a role whose vehicle role a branch removed', () => {
    for (const s of many('stolenVehicleSighted', 300)) {
      if (s.variants.length > 0 && !s.variants.every((v) => v === 'duplicate' || v === 'escalation' || v === 'deescalation')) continue;
      if (s.branch === 'notFound') {
        expect(s.participants).toHaveLength(0);
        expect(s.vehicles).toHaveLength(0);
      }
      if (s.branch === 'parked') {
        expect(s.vehicles[0]?.mode).toBe('parked');
        expect(s.participants.map((p) => p.role)).toEqual(['driver']);
        expect(s.participants[0]?.spot).toBe('hidden');
      }
    }
  });

  it('adds intoxication, items and injuries from the role definitions', () => {
    let bacs = 0;
    for (const s of many('impairedDriver', 200)) {
      if (s.variants.includes('false') || s.variants.includes('swatting') || s.variants.includes('ambush')) continue;
      const d = s.participants.find((p) => p.role === 'driver');
      if (s.branch === 'drunk') {
        expect(d?.intoxication).not.toBeNull();
        expect(d?.intoxication?.bac).toBeGreaterThanOrEqual(0.08);
        expect(d?.intoxication?.bac).toBeLessThanOrEqual(0.22);
        bacs++;
      }
      if (s.branch === 'tired' || s.branch === 'medical') expect(d?.intoxication).toBeNull();
      if (s.branch === 'drugged') expect(d?.intoxication?.drug).toBe('depressant');
    }
    expect(bacs).toBeGreaterThan(20);
    const overdoses = many('overdose', 100).filter((s) => s.branch === 'overdose' && !s.variants.includes('false'));
    expect(overdoses.length).toBeGreaterThan(10);
    for (const s of overdoses) {
      const patient = s.participants.find((p) => p.role === 'patient');
      expect(patient?.injured).toBe(true);
      expect(patient?.intoxication?.drug).toBe('opioid');
      expect(s.flags).toContain('injury:patient');
    }
  });

  it('spawns a dog without a person and counts spots', () => {
    const s = many('strayDog', 30).find((x) => !x.variants.includes('false'));
    const animal = s?.participants.find((p) => p.role === 'animal');
    expect(animal).toMatchObject({ personId: -1, body: 'dog', spot: 'yard', spotIndex: 0 });
    const crowd = many('largeFight', 30).find((x) => !x.variants.includes('false') && x.participants.filter((p) => p.spot === 'crowd').length > 3);
    const idx = crowd?.participants.filter((p) => p.spot === 'crowd').map((p) => p.spotIndex);
    expect(idx).toEqual(idx?.map((_, i) => i));
  });

  it('flags juveniles from ages', () => {
    const runaways = many('juvenileRunaway', 80).filter((s) => !s.variants.includes('false'));
    expect(runaways.length).toBeGreaterThan(30);
    for (const s of runaways) {
      const m = s.participants.find((p) => p.role === 'missing');
      expect(m && traits(m.personId).age < 18).toBe(true);
      expect(s.flags).toContain('juvenile:missing');
      expect(s.flags).toContain('role:missing');
    }
  });
});

describe('Phase 2 and derived types', () => {
  it('builds scenarios for the legacy Phase 2 types through their families', () => {
    for (const [typeId, familyId] of Object.entries(CALL_CATALOG.legacy)) {
      if (familyId === 'trafficStop') continue;
      for (let id = 1; id <= 20; id++) {
        const s = build({ typeId, callId: id, reportedVehicleId: 99 });
        expect(s.family).toBe(familyId);
        expect(s.typeId).toBe(typeId);
      }
    }
  });

  it('builds every derived branch of the traffic stop and contact families without drawing a branch', () => {
    for (const branch of ['stolenVehicle', 'wanted', 'dui', 'contraband', 'suspended', 'clean']) {
      const s = build({ typeId: 'trafficStop', callId: 4, derivedBranch: branch, existingVehicleId: 42, given: [1, 2, 3] });
      expect(s.branch).toBe(branch);
      expect(s.variants).toEqual([]);
      expect(s.participants.map((p) => p.personId).slice(0, 3)).toEqual([1, 2, 3].slice(0, s.participants.length));
    }
    for (const branch of ['wanted', 'contraband', 'clean']) {
      const s = build({ typeId: 'fieldInterview', callId: 4, derivedBranch: branch, given: [77] });
      expect(s.branch).toBe(branch);
      expect(s.participants).toHaveLength(1);
      expect(s.participants[0]).toMatchObject({ role: 'subject', personId: 77, spot: 'curb' });
    }
  });
});

describe('variant role rewrites', () => {
  const N = 6000;
  const sets = {
    false: many('domesticDisturbance', N).filter((s) => s.variants.includes('false')),
    swatting: many('personWithGun', N).filter((s) => s.variants.includes('swatting')),
    ambush: many('burglaryInProgress', N * 2).filter((s) => s.variants.includes('ambush')),
  };

  it('false keeps only reporter-like roles and no vehicles', () => {
    expect(sets.false.length).toBeGreaterThan(20);
    for (const s of sets.false) {
      for (const p of s.participants) expect(['caller', 'reporter', 'requester']).toContain(p.role);
      expect(s.vehicles).toHaveLength(0);
      expect(s.flags).toContain('variant:false');
    }
    const dui = many('impairedDriver', 3000).filter((s) => s.variants.includes('false'));
    expect(dui.length).toBeGreaterThan(20);
    for (const s of dui) {
      expect(s.participants).toHaveLength(0);
      expect(s.vehicles).toHaveLength(0);
    }
  });

  it('swatting keeps the caller and adds an innocent resident', () => {
    expect(sets.swatting.length).toBeGreaterThan(20);
    for (const s of sets.swatting) {
      expect(s.participants.map((p) => p.role).filter((r) => r !== 'caller')).toEqual(['resident']);
      const resident = s.participants.find((p) => p.role === 'resident');
      expect(resident).toMatchObject({ profile: 'residentInnocent', spot: 'door' });
      expect(traits(resident?.personId ?? 0).age).toBeGreaterThanOrEqual(18);
      expect(s.variants).not.toContain('escalation');
    }
  });

  it('ambush keeps the caller and adds an armed hidden ambusher plus an ambush entry', () => {
    expect(sets.ambush.length).toBeGreaterThan(10);
    for (const s of sets.ambush) {
      const a = s.participants.find((p) => p.role === 'ambusher');
      expect(a).toMatchObject({ profile: 'ambusher', spot: 'hidden', weapon: 'handgun' });
      expect(satisfies(a?.personId ?? 0, { minAge: 18, risk: true })).toBe(true);
      expect(s.participants.filter((p) => p.role !== 'caller' && p.role !== 'ambusher')).toHaveLength(0);
      const entries = s.timeline.filter((t) => t.kind === 'ambush');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.atS).toBeGreaterThanOrEqual(3);
      expect(entries[0]?.atS).toBeLessThanOrEqual(12);
    }
  });

  it('never produces a variant whose multiplier is 0', () => {
    for (const s of many('welfareCheckElderly', 3000)) {
      expect(s.variants).not.toContain('escalation');
      expect(s.variants).not.toContain('deescalation');
      expect(s.variants).not.toContain('swatting');
      expect(s.variants).not.toContain('ambush');
    }
  });
});

describe('dispatch errors and the timeline', () => {
  const N = 5000;
  const rates = CALL_CATALOG.variants.dispatchErrors;
  const builds = many('armedPerson', N);

  it('draws errors at the configured rates', () => {
    expect(within4Sigma(builds.filter((s) => s.errors.wrongAddress).length, N, rates.wrongAddress)).toBe(true);
    expect(within4Sigma(builds.filter((s) => s.errors.wrongDescription).length, N, rates.wrongDescription)).toBe(true);
    expect(within4Sigma(builds.filter((s) => s.errors.missingWeapon).length, N, rates.missingWeapon)).toBe(true);
  });

  it('writes the corrections that match the errors', () => {
    let describes = 0;
    for (const s of builds) {
      const texts = s.timeline.filter((t) => t.kind === 'correction').map((t) => t.text);
      expect(texts.filter((t) => t.startsWith('Correction: RP advises the location is')).length).toBe(s.errors.wrongAddress ? 1 : 0);
      const subject = s.participants.find((p) => p.role === 'subject');
      const described = s.timeline.find((t) => t.kind === 'describe');
      if (!subject) {
        expect(described).toBeUndefined();
        continue;
      }
      describes++;
      expect(described?.atS).toBe(0);
      expect(described?.text).toMatch(/^RP describes the subject as a (male|female) .+, wearing a \w+ top and blue jeans/);
      const armed = subject.weapon !== null;
      expect(described?.text.includes(', armed with a ')).toBe(armed && !s.errors.missingWeapon);
      expect(texts.filter((t) => t.startsWith('Update: second caller advises')).length).toBe(armed && s.errors.missingWeapon ? 1 : 0);
      expect(texts.filter((t) => t.startsWith('Correction: subject is wearing a')).length).toBe(s.errors.wrongDescription ? 1 : 0);
      if (s.errors.wrongDescription) {
        const said = /wearing a (\w+) top/.exec(described?.text ?? '')?.[1];
        const truth = /wearing a (\w+) top/.exec(texts.find((t) => t.startsWith('Correction: subject is wearing')) ?? '')?.[1];
        expect(said).not.toBe(truth);
      }
    }
    expect(describes).toBeGreaterThan(N / 2);
  });

  it('moves the true anchor along the edge on a wrong address, keeping the reported one', () => {
    const wrong = builds.filter((s) => s.errors.wrongAddress);
    expect(wrong.length).toBeGreaterThan(100);
    for (const s of wrong) {
      const shift = Math.abs(s.anchor.s - s.reported.s);
      const clamped = s.anchor.s === 5 || s.anchor.s === 295;
      expect(s.anchor.edge).toBe(3);
      expect(s.anchor.s).toBeGreaterThanOrEqual(5);
      expect(s.anchor.s).toBeLessThanOrEqual(295);
      if (!clamped) {
        expect(shift).toBeGreaterThanOrEqual(40 - 1e-6);
        expect(shift).toBeLessThanOrEqual(120 + 1e-6);
      }
      expect(s.reported.s).toBeCloseTo(100, 1);
      expect(s.anchor.x).toBeCloseTo(s.anchor.s, 3);
      expect(Math.abs(s.anchor.z)).toBeLessThan(1e-6);
    }
    for (const s of builds.filter((x) => !x.errors.wrongAddress)) expect(s.anchor).toEqual(s.reported);
    expect(builds.every((s) => s.anchor.side === 1 || s.anchor.side === -1)).toBe(true);
  });

  it('never gives a derived family an address error and snaps off-graph locations', () => {
    for (let i = 1; i <= 300; i++) {
      expect(build({ typeId: 'trafficStop', callId: i, derivedBranch: 'clean', given: [1, 2] }).errors.wrongAddress).toBe(false);
    }
    const off = build({ typeId: 'robbery', callId: 1, edge: -1 });
    expect(off.anchor).toMatchObject({ edge: -1, s: 0, x: 100, z: 6 });
    expect(off.errors.wrongAddress).toBe(false);
  });

  it('adds escalation, de-escalation, duplicate callers, linked calls', () => {
    const all = many('domesticDisturbance', 3000);
    const esc = all.filter((s) => s.variants.includes('escalation'));
    const de = all.filter((s) => s.variants.includes('deescalation'));
    const dup = all.filter((s) => s.variants.includes('duplicate'));
    expect(esc.length).toBeGreaterThan(50);
    expect(de.length).toBeGreaterThan(50);
    expect(dup.length).toBeGreaterThan(100);
    for (const s of esc) {
      const e = s.timeline.filter((t) => t.kind === 'escalate');
      expect(e).toHaveLength(1);
      expect(e[0]?.priority).toBe(1);
      expect(e[0]?.atS).toBeGreaterThanOrEqual(40);
      expect(e[0]?.atS).toBeLessThanOrEqual(180);
      expect(CALL_CATALOG.families.find((f) => f.id === 'domestic')?.escalation?.narratives).toContain(e[0]?.text);
    }
    for (const s of de) {
      const e = s.timeline.filter((t) => t.kind === 'deescalate');
      expect(e).toHaveLength(1);
      expect(e[0]?.priority).toBe(3);
    }
    let linked = 0;
    let withoutLinked = 0;
    for (const s of dup) {
      const callers = s.timeline.filter((t) => t.kind === 'duplicateCaller');
      expect(callers.length).toBeGreaterThanOrEqual(1);
      expect(callers.length).toBeLessThanOrEqual(3);
      for (const c of callers) {
        expect(c.callerPersonId).toBeGreaterThanOrEqual(0);
        expect(c.text).toBe('Additional caller {name} reports the same incident.');
        expect(c.atS).toBeGreaterThanOrEqual(10);
        expect(c.atS).toBeLessThanOrEqual(90);
      }
      const l = s.timeline.filter((t) => t.kind === 'linkedCall');
      expect(l.length).toBeLessThanOrEqual(1);
      if (l.length === 1) linked++;
      else withoutLinked++;
      for (let i = 1; i < s.timeline.length; i++) expect(s.timeline[i]?.atS).toBeGreaterThanOrEqual(s.timeline[i - 1]?.atS ?? 0);
    }
    expect(within4Sigma(linked, dup.length, 0.5), `${linked} of ${dup.length}`).toBe(true);
    expect(withoutLinked).toBeGreaterThan(0);
    // priority is bounded for a low-priority call.
    const p4 = many('doubleParked', 10).concat(many('domesticDisturbance', 10, { priority: 4 }));
    for (const s of p4) for (const t of s.timeline) if (t.priority > 0) expect(t.priority).toBeLessThanOrEqual(4);
  });
});
