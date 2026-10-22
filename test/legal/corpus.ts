import type { IncidentLog } from '../../src/legal/types';
import { drugs, gun, item, LogBuilder } from './helpers';

/**
 * Hand-built incident corpus (Phase 9 §10): at least one scenario per rule of every shipped ruleset. Each scenario is a
 * small, readable story built with `LogBuilder`; `ruleCoverage.test.ts` evaluates all of them with every ruleset and
 * `doctrineMatrix.test.ts` reads the outcomes by doctrine.
 */

export interface Scenario {
  /** Unique id, also the incident key. */
  id: string;
  /** What the scenario shows, for failure messages. */
  note: string;
  log: IncidentLog;
}

type Build = (b: LogBuilder) => void;

const scenarios: Scenario[] = [];

/** Adds a scenario: a call of `family` with a driver (person 1), then whatever `build` records. */
function add(id: string, note: string, build: Build, family = 'trafficStop', role = 'driver'): void {
  const b = new LogBuilder(`C-${String(scenarios.length + 1).padStart(5, '0')}`, family).start().person(1, role, 'Alex Driver');
  b.after(1);
  build(b);
  const log = b.build();
  scenarios.push({ id, note, log: { ...log, key: id } });
}

/** A stop that is lawful by weight of suspicion: a speeding indicator then the detention. */
function lawfulStop(b: LogBuilder): void {
  b.indicator(1, 'speeding').after(1).detain(1, 'trafficStop').after(1);
}

/** A lawful arrest for a drug offense (an offense both rulesets accept and whose evidence may be in the car). */
function drugArrest(b: LogBuilder): number {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'command').after(1).arrest(1).after(1);
  return b.lastId;
}

// --- Detention, frisk ------------------------------------------------------------------------

add('detention-lawful', 'A speeding stop is supported by reasonable suspicion', (b) => {
  lawfulStop(b);
});

add('detention-unlawful', 'A stop with no indicator at all', (b) => {
  b.detain(1, 'command');
});

add('detention-consensual', 'A witness who complies with a command is not detained', (b) => {
  b.person(2, 'witness', 'Wendy Witness').after(1).detain(2, 'command');
}, 'disturbance');

add('detention-warrant-call', 'A call-level arrest warrant supports the stop of the call subject', (b) => {
  b.person(2, 'suspect', 'Sam Subject').after(1).warrant('arrest').after(1).detain(2, 'command').after(1).arrest(2);
}, 'wanted');

add('frisk-terry-lawful', 'A weapon indicator on a lawful stop supports a frisk that finds the gun', (b) => {
  b.indicator(1, 'speeding').indicator(1, 'weaponSeen').after(1).detain(1, 'trafficStop').after(1).frisk(1, [gun()]);
});

add('frisk-scope-property', 'A weapons frisk may not seize a non-weapon item (plain feel allows drugs only under generic)', (b) => {
  b.indicator(1, 'speeding').indicator(1, 'weaponSeen').after(1).detain(1, 'trafficStop').after(1).frisk(1, [item('p1', 'property', 'Wallet')]);
});

add('frisk-plain-feel-drugs', 'Drugs felt during a lawful weapons frisk: plain feel under generic, out of scope under strict', (b) => {
  b.indicator(1, 'speeding').indicator(1, 'weaponSeen').after(1).detain(1, 'trafficStop').after(1).frisk(1, [drugs('pf1')]);
});

add('frisk-unlawful', 'A frisk on a stop with no armed indicator', (b) => {
  lawfulStop(b);
  b.frisk(1, [drugs('f1')]);
});

add('frisk-consent', 'A pat-down with consent', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchPerson').after(1).frisk(1, [drugs('fc1')]);
});

add('frisk-after-arrest', 'A pat-down incident to arrest', (b) => {
  drugArrest(b);
  b.frisk(1, [gun('fa1')]);
});

// --- Arrest, search incident to arrest, automobile exception ---------------------------------

add('arrest-pc-drugs', 'Probable cause for a drug offense, then a search of the person incident to the arrest', (b) => {
  drugArrest(b);
  b.search(1, 'person', [drugs('sa1')]);
});

add('arrest-pc-traffic', 'A custodial arrest for a traffic offense (arrestable under generic only)', (b) => {
  lawfulStop(b);
  b.arrest(1).after(1).search(1, 'person', [drugs('at1')]);
});

add('arrest-warrant', 'A warrant hit supports the arrest', (b) => {
  b.indicator(1, 'warrantHit').after(1).detain(1, 'trafficStop').after(1).arrest(1);
});

add('arrest-unlawful', 'An arrest on weak suspicion (impaired-driving cues only) taints the search and the evidence', (b) => {
  b.indicator(1, 'weaving').after(1).detain(1, 'trafficStop').after(1).arrest(1).after(1).search(1, 'person', [drugs('au1')]);
});

add('arrest-booking-duplicate', 'A booking after the cuffing arrest is not a second arrest', (b) => {
  drugArrest(b);
  b.arrest(1, 'booking').after(1).charges(1, ['PC-260']).after(1).release(1, 'uncuff');
});

add('vehicle-sita-drugs', 'A vehicle search incident to a drug arrest (evidence of the offense may be in the car)', (b) => {
  drugArrest(b);
  b.search(1, 'vehicle', [drugs('vs1')], { claimedBasis: 'incidentToArrest', vehicleId: 4 });
});

add('vehicle-sita-warrant', 'A vehicle search incident to a warrant arrest: broad under generic, Gant-limited under strict', (b) => {
  b.indicator(1, 'warrantHit').after(1).detain(1, 'trafficStop').after(1).arrest(1).after(1)
    .search(1, 'vehicle', [drugs('vw1')], { claimedBasis: 'incidentToArrest', vehicleId: 4 });
});

add('vehicle-sita-late', 'A vehicle search long after the arrest is outside the window', (b) => {
  b.indicator(1, 'warrantHit').after(1).detain(1, 'trafficStop').after(1).arrest(1).after(2000)
    .search(1, 'vehicle', [drugs('vl1')]);
});

add('pre-arrest-search', 'A search just before an arrest that follows within a minute (generic only)', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'command').after(1)
    .search(1, 'person', [drugs('pa1')]).after(10).arrest(1);
});

add('automobile-exception', 'Probable cause for a drug offense without an arrest allows a vehicle search', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'trafficStop').after(1).search(1, 'vehicle', [drugs('ae1')], { vehicleId: 4 });
});

add('vehicle-search-no-basis', 'A vehicle search with nothing behind it', (b) => {
  lawfulStop(b);
  b.search(1, 'vehicle', [drugs('nb1')], { vehicleId: 4 });
});

// --- Consent ---------------------------------------------------------------------------------

add('consent-lawful', 'Freely given consent covers the person search', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchPerson').after(1).search(1, 'person', [drugs('cl1')]);
});

add('consent-scope-miss', 'Consent to search the person does not cover the vehicle', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchPerson').after(1).search(1, 'vehicle', [drugs('cs1')], { vehicleId: 4 });
});

add('consent-weapon-drawn', 'Consent given at gunpoint is coerced', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchVehicle', true, true, { weaponDrawn: true }).after(1).search(1, 'vehicle', [drugs('cw1')], { vehicleId: 4 });
});

add('consent-aggressive-2', 'Two aggressive lines: coerced under strict (max 1), acceptable under generic (max 3)', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchVehicle', true, true, { aggressiveLines: 2 }).after(1).search(1, 'vehicle', [drugs('ca1')], { vehicleId: 4 });
});

add('consent-invalid', 'A person who cannot give consent', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchPerson', true, false).after(1).search(1, 'person', [drugs('ci1')]);
});

add('consent-refused', 'A refusal revokes an earlier consent of the same kind', (b) => {
  lawfulStop(b);
  b.consent(1, 'searchVehicle').after(1).consent(1, 'searchVehicle', false).after(1).search(1, 'vehicle', [drugs('cr1')], { vehicleId: 4 });
});

add('consent-tainted', 'Consent obtained during an unlawful detention does not cure it', (b) => {
  b.detain(1, 'command').after(1).consent(1, 'searchPerson').after(1).search(1, 'person', [drugs('ct1')]);
});

// --- Exigency, entry, premises ---------------------------------------------------------------

add('exigency-entry-search', 'Screaming inside: exigent entry and search of the premises', (b) => {
  b.exigency('screaming inside', 3).after(1).entry(3, false, 1).after(1).search(1, 'premises', [drugs('ex1')], { buildingId: 3 });
}, 'domestic', 'suspect');

add('exigency-stale', 'The exigency was confirmed far too long before the search', (b) => {
  b.exigency('screaming inside', 3).after(1).entry(3, false, 1).after(3000).search(1, 'room', [drugs('es1')], { buildingId: 3 });
}, 'domestic', 'suspect');

add('entry-unlawful-fruit', 'An entry with no basis, then a plain-view claim from inside', (b) => {
  b.entry(4, false, 1).after(1).search(1, 'room', [drugs('eu1')], { claimedBasis: 'plainView', buildingId: 4 });
}, 'domestic', 'suspect');

add('entry-consent', 'The occupant lets the officer in and consents to a search of the room', (b) => {
  b.consent(1, 'entry', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .consent(1, 'searchRoom', true, true, { buildingId: 5 }).after(1).search(1, 'room', [drugs('en1')], { buildingId: 5 });
}, 'domestic', 'suspect');

add('entry-consent-only', 'Consent to enter is not consent to search the room', (b) => {
  b.consent(1, 'entry', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .search(1, 'room', [drugs('eo1')], { buildingId: 5 });
}, 'domestic', 'suspect');

add('entry-warrant', 'A search warrant covers the entry and the search of the premises', (b) => {
  b.warrant('search').after(1).entry(6, false, 1).after(1).search(1, 'premises', [drugs('ew1')], { buildingId: 6 });
}, 'wanted', 'suspect');

add('entry-public', 'A public place needs no basis; plain view and public area are lawful there', (b) => {
  b.entry(7, true, 1).after(1).search(1, 'room', [drugs('ep1')], { claimedBasis: 'plainView', buildingId: 7 }).after(1)
    .search(1, 'container', [], { claimedBasis: 'publicArea', buildingId: 7 });
}, 'disturbance', 'suspect');

add('protective-sweep', 'A protective sweep of the building where the lawful arrest happened', (b) => {
  b.consent(1, 'entry', true, true, { buildingId: 8 }).after(1).entry(8, false, 1).after(1);
  b.indicator(1, 'warrantHit').after(1).arrest(1).after(1).search(1, 'room', [], { claimedBasis: 'protectiveSweep', buildingId: 8 });
}, 'wanted', 'suspect');

add('sweep-no-arrest', 'A sweep claim with no arrest in the building', (b) => {
  b.entry(9, true, 1).after(1).search(1, 'room', [drugs('sn1')], { claimedBasis: 'protectiveSweep', buildingId: 9 });
}, 'disturbance', 'suspect');

add('premises-sita-claim', 'A room search claiming incident to arrest right after a lawful arrest', (b) => {
  b.entry(10, true, 1).after(1).indicator(1, 'warrantHit').after(1).arrest(1).after(1)
    .search(1, 'room', [drugs('ps1')], { claimedBasis: 'incidentToArrest', buildingId: 10 });
}, 'wanted', 'suspect');

// --- Miranda and tests -----------------------------------------------------------------------

add('miranda-unwarned', 'Custodial questioning about the account without a warning: the answer is suppressed', (b) => {
  drugArrest(b);
  b.question(1, 'account', true).after(2).statement(1, 'account', 'I was driving home', true);
});

add('miranda-waived', 'Warned and waived: the statement stands', (b) => {
  drugArrest(b);
  b.miranda(1, 'waived').after(1).question(1, 'account', true).after(2).statement(1, 'account', 'I was driving home', true);
});

add('miranda-invoked', 'Questioning after the person invoked their rights', (b) => {
  drugArrest(b);
  b.miranda(1, 'invoked').after(1).question(1, 'drugs', true).after(2).statement(1, 'drugs', 'they are mine', true);
});

add('miranda-gunpoint', 'Questioned at gunpoint without being in custody: custody only under strict', (b) => {
  lawfulStop(b);
  b.question(1, 'weapons', false, true).after(2).statement(1, 'weapons', 'in the glovebox');
});

add('miranda-not-custodial', 'A roadside question outside custody needs no warning', (b) => {
  lawfulStop(b);
  b.question(1, 'origin').after(2).statement(1, 'origin', 'the gym');
});

add('statement-unlawful-stop', 'Answers after an unlawful stop are fruit of it', (b) => {
  b.detain(1, 'command').after(1).question(1, 'account').after(2).statement(1, 'account', 'I had two beers');
});

add('test-consented', 'A PBT with consent', (b) => {
  lawfulStop(b);
  b.consent(1, 'pbt').after(1).test(1, 'pbt', 'over');
});

add('test-no-consent', 'A field sobriety test with neither consent nor an arrest', (b) => {
  lawfulStop(b);
  b.test(1, 'sfst', 'fail');
});

add('test-implied-consent', 'A breath test after a DUI arrest: implied consent under generic only', (b) => {
  b.indicator(1, 'bacOver').indicator(1, 'sfstFail').after(1).detain(1, 'trafficStop').after(1).arrest(1).after(1).test(1, 'pbt', 'over');
}, 'dui');

// --- Evidence --------------------------------------------------------------------------------

add('evidence-inevitable', 'Drugs from an unlawful frisk would have been found in the later lawful arrest (generic only)', (b) => {
  lawfulStop(b);
  b.frisk(1, [drugs('in1')]).after(1).indicator(1, 'warrantHit').after(1).arrest(1);
});

add('evidence-seizure-lawful', 'Seizures after a lawful automobile search are admissible', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'trafficStop').after(1).search(1, 'vehicle', [drugs('sz1')], { vehicleId: 4 });
  const searchId = b.lastId;
  b.after(1).seize(1, drugs('sz1'), searchId).after(1).seize(1, drugs('sz2'), searchId);
});

add('evidence-seizure-unlawful', 'Seizures trace back to the unlawful search that found them', (b) => {
  lawfulStop(b);
  b.search(1, 'vehicle', [drugs('su1')], { vehicleId: 4 });
  const searchId = b.lastId;
  b.after(1).seize(1, drugs('su1'), searchId).after(1).seize(1, drugs('su2'), searchId);
});

add('evidence-fruit-indicator', 'A drug indicator that stems from an unlawful frisk cannot support the arrest', (b) => {
  b.indicator(1, 'weaving').after(1).detain(1, 'trafficStop').after(1).frisk(1, [drugs('fi1')]);
  const friskId = b.lastId;
  b.after(1).indicator(1, 'contrabandFound', 'evidence', friskId).after(1).arrest(1);
});

// --- Force -----------------------------------------------------------------------------------

add('force-justified', 'Soft hands on an active resister', (b) => {
  lawfulStop(b);
  b.force(1, 'softHands', 'active');
});

add('force-questionable', 'Hard hands on a passive subject: one step too far', (b) => {
  lawfulStop(b);
  b.force(1, 'hardHands', 'passive');
});

add('force-excessive', 'A baton on a compliant subject', (b) => {
  lawfulStop(b);
  b.force(1, 'baton', 'compliant');
});

add('force-baton-active', 'A baton on an active resister: allowed under generic, one step over under strict', (b) => {
  lawfulStop(b);
  b.force(1, 'baton', 'active');
});

add('force-restrained', 'Hard hands on a handcuffed subject', (b) => {
  drugArrest(b);
  b.force(1, 'hardHands', 'passive', { restrained: true });
});

add('force-taser-cycles', 'Three TASER cycles pass under generic; the third is one too many under strict', (b) => {
  lawfulStop(b);
  b.force(1, 'taser', 'assaultive', { cycle: 1 }).after(5).force(1, 'taser', 'assaultive', { cycle: 3 }).after(5).force(1, 'taser', 'assaultive', { cycle: 4 });
});

add('force-taser-risk', 'A TASER on an elevated subject who is only an active resister', (b) => {
  lawfulStop(b);
  b.force(1, 'taser', 'active', { riskFactors: ['elevated'] });
});

add('force-firearm-nonlethal', 'A firearm used on an assaultive subject', (b) => {
  lawfulStop(b);
  b.force(1, 'firearm', 'assaultive');
});

add('force-firearm-lethal', 'A firearm used against a lethal threat', (b) => {
  lawfulStop(b);
  b.force(1, 'firearm', 'lethal');
});

add('force-display', 'Pointing a firearm at a compliant subject (below the display minimum under strict)', (b) => {
  lawfulStop(b);
  b.force(1, 'presence', 'compliant', { tool: 'firearmDisplay' }).after(2).force(1, 'presence', 'active', { tool: 'firearmDisplay' });
});

add('force-presence', 'Officer presence is always justified', (b) => {
  lawfulStop(b);
  b.force(1, 'presence', 'compliant');
});

// --- Duty to intervene -----------------------------------------------------------------------

add('intervene-failed', 'A partner uses excessive force within reach and the officer does not step in', (b) => {
  lawfulStop(b);
  b.other(1, 'baton', 'compliant', 5);
});

add('intervene-done', 'The officer steps in within the window', (b) => {
  lawfulStop(b);
  b.other(1, 'baton', 'compliant', 5);
  const id = b.lastId;
  b.after(2).intervene(id);
});

add('intervene-late', 'The officer steps in after the window closed', (b) => {
  lawfulStop(b);
  b.other(1, 'baton', 'compliant', 5);
  const id = b.lastId;
  b.after(20).intervene(id);
});

add('intervene-far', 'Excessive force too far away to stop', (b) => {
  lawfulStop(b);
  b.other(1, 'baton', 'compliant', 40);
});

add('intervene-episode', 'A burst of strikes by one partner is one episode', (b) => {
  lawfulStop(b);
  b.other(1, 'baton', 'compliant', 5).after(3).other(1, 'baton', 'compliant', 5).after(3).other(1, 'firearm', 'compliant', 5);
});

add('other-force-justified', 'A partner uses justified force', (b) => {
  lawfulStop(b);
  b.other(1, 'softHands', 'active', 3);
});

// --- Pursuits --------------------------------------------------------------------------------

/** `count` one-second samples starting now. */
function samples(b: LogBuilder, count: number, mph: number, opts: { limitMph?: number; lights?: boolean; siren?: boolean; wet?: boolean } = {}): void {
  for (let i = 0; i < count; i++) b.after(1).sample(1, mph, opts);
}

add('pursuit-lawful', 'A violent suspect, speeds within the margin, lights and siren on, ends in an arrest', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 5, 40);
  b.after(1).pursuitEnd(1, 'arrest');
}, 'violent', 'suspect');

add('pursuit-offense', 'A pursuit for a traffic offense', (b) => {
  b.indicator(1, 'speeding').after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(1).pursuitEnd(1, 'lost');
});

add('pursuit-speed', 'Far above the limit for longer than the allowed seconds', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 40, 95);
  b.after(1).pursuitEnd(1, 'arrest');
}, 'violent', 'suspect');

add('pursuit-speed-moderate', 'Twenty over for 25 seconds: within the generic margin, over the strict one', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 25, 55);
  b.after(1).pursuitEnd(1, 'arrest');
}, 'violent', 'suspect');

add('pursuit-equipment', 'Lights off during the pursuit', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 3, 40);
  samples(b, 2, 40, { lights: false });
  b.after(1).pursuitEnd(1, 'arrest');
}, 'violent', 'suspect');

add('pursuit-too-long', 'A pursuit that outlasts the maximum duration without a termination', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(700).sample(1, 40);
}, 'violent', 'suspect');

add('pursuit-terminated', 'The same long pursuit, terminated by the officer, is within policy', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(700).sample(1, 40).after(1).pursuitEnd(1, 'terminated');
}, 'violent', 'suspect');

add('pursuit-advisory-ignored', 'The termination advisory is ignored for a minute', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(1).advisory('terminatePursuit').after(60).pursuitEnd(1, 'arrest');
}, 'violent', 'suspect');

add('pursuit-dui', 'A pursuit for impaired driving: allowed under generic only', (b) => {
  b.indicator(1, 'odorAlcohol').after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(1).pursuitEnd(1, 'arrest');
}, 'dui');

add('pursuit-family-offense', 'No indicator: the offense of a pursuit-family suspect comes from the call family', (b) => {
  b.after(1).pursuit(1);
  samples(b, 3, 40);
  b.after(1).pursuitEnd(1, 'arrest');
}, 'pursuit', 'suspect');

add('pursuit-wet-night', 'Wet and dark reduce the margin', (b) => {
  b.indicator(1, 'assaultOnOfficer').after(1).pursuit(1);
  for (let i = 0; i < 30; i++) b.after(1).sample(1, 64, { wet: true, night: true });
  b.after(1).pursuitEnd(1, 'handoff');
}, 'violent', 'suspect');

add('pursuit-on-foot', 'A foot pursuit is not judged as a vehicle pursuit', (b) => {
  b.indicator(1, 'flight').after(1).pursuit(1, 'foot').after(5).pursuitEnd(1, 'arrest');
});

// --- Recording -------------------------------------------------------------------------------

add('recording-missing', 'The body camera is off during a detention', (b) => {
  b.indicator(1, 'speeding').after(30).cam(false).after(1).detain(1, 'trafficStop');
});

add('recording-muted', 'The recording is muted during an arrest', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'command').after(30).cam(true, true).after(1).arrest(1);
});

add('recording-dash', 'The dash camera covers a detention but not a search', (b) => {
  b.indicator(1, 'contrabandPlainView').after(30).cam(false, false, true).after(1).detain(1, 'trafficStop').after(1).search(1, 'vehicle', [drugs('rd1')], { vehicleId: 4 });
});

add('recording-grace', 'The camera is off, but only within the activation grace of the first contact', (b) => {
  b.cam(false).after(1).indicator(1, 'speeding').after(1).detain(1, 'trafficStop');
});

add('recording-full', 'Everything is recorded', (b) => {
  drugArrest(b);
  b.consent(1, 'searchPerson').after(1).frisk(1, []).after(1).question(1, 'identity', true);
});

// --- Review round 1: gaps the first corpus left unpinned ------------------------------------

add('exigency-person-vehicle', 'An active exigency is a basis for premises only: a person search and a vehicle search stay unlawful', (b) => {
  b.exigency('screaming inside').after(1).search(1, 'person', [drugs('xp1')]).after(1).search(1, 'vehicle', [drugs('xv1')], { vehicleId: 4 });
}, 'domestic', 'suspect');

add('exigency-other-building', 'An exigency confirmed for one building does not justify a search of another', (b) => {
  b.exigency('screaming inside', 3).after(1).entry(4, true, 1).after(1).search(1, 'room', [drugs('xo1')], { buildingId: 4 });
}, 'domestic', 'suspect');

add('premises-sita-edge', 'A room search claiming incident to arrest 400 s after a lawful arrest: inside the generic window (600 s), outside strict (300 s)', (b) => {
  b.entry(10, true, 1).after(1).indicator(1, 'warrantHit').after(1).arrest(1).after(400)
    .search(1, 'room', [drugs('pe1')], { claimedBasis: 'incidentToArrest', buildingId: 10 });
}, 'wanted', 'suspect');

add('premises-sita-outside', 'A room search claiming incident to arrest 1000 s after a lawful arrest is outside both windows', (b) => {
  b.entry(10, true, 1).after(1).indicator(1, 'warrantHit').after(1).arrest(1).after(1000)
    .search(1, 'room', [drugs('po1')], { claimedBasis: 'incidentToArrest', buildingId: 10 });
}, 'wanted', 'suspect');

add('arrest-booking-only-pc', 'A booking with no earlier cuffing arrest is itself the arrest: lawful with probable cause', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'command').after(1).arrest(1, 'booking');
});

add('arrest-booking-only-no-pc', 'A booking with no earlier cuffing arrest and no probable cause is an unlawful arrest', (b) => {
  b.arrest(1, 'booking');
});

add('pre-arrest-late', 'A search 100 s before the arrest is outside the pre-arrest window (60 s)', (b) => {
  b.indicator(1, 'contrabandPlainView').after(1).detain(1, 'command').after(1)
    .search(1, 'person', [drugs('pl1')]).after(100).arrest(1);
});

add('pre-arrest-speeding', 'A search before an arrest that only speeding supports: lawful pre-arrest under generic, no window under strict', (b) => {
  b.indicator(1, 'speeding').after(1).detain(1, 'trafficStop').after(1)
    .search(1, 'person', [drugs('ps2')]).after(10).arrest(1);
});

add('consent-occupant-building', 'The occupant consents to a search of the room of the building: it covers the officer who searches it', (b) => {
  b.person(2, 'witness', 'Olive Occupant').after(1)
    .consent(2, 'searchRoom', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .search(1, 'room', [drugs('co1')], { buildingId: 5 });
}, 'domestic', 'suspect');

add('consent-occupant-entry-only', "The occupant's consent to enter does not cover a search of the room", (b) => {
  b.person(2, 'witness', 'Olive Occupant').after(1)
    .consent(2, 'entry', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .search(1, 'room', [drugs('ce1')], { buildingId: 5 });
}, 'domestic', 'suspect');

add('consent-building-revoked', "A second occupant's refusal revokes the first occupant's consent for the same building", (b) => {
  b.person(2, 'witness', 'Olive Occupant').after(1).person(3, 'witness', 'Omar Occupant').after(1)
    .consent(2, 'searchRoom', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .consent(3, 'searchRoom', false, true, { buildingId: 5 }).after(1)
    .search(1, 'room', [drugs('cb1')], { buildingId: 5 });
}, 'domestic', 'suspect');

add('consent-other-building-kept', 'A refusal for another building does not revoke the consent', (b) => {
  b.person(2, 'witness', 'Olive Occupant').after(1).person(3, 'witness', 'Omar Occupant').after(1)
    .consent(2, 'searchRoom', true, true, { buildingId: 5 }).after(1).entry(5, false, 1).after(1)
    .consent(3, 'searchRoom', false, true, { buildingId: 6 }).after(1)
    .search(1, 'room', [drugs('ck1')], { buildingId: 5 });
}, 'domestic', 'suspect');

// --- Event kinds that never judge ------------------------------------------------------------

add('quiet-kinds', 'Commands, services, advisories, charges, releases and the close are recorded without a ruling', (b) => {
  lawfulStop(b);
  b.command(1, 'stepOut').after(1).service('ems', 'requested').after(1).service('ems', 'arrived').after(1)
    .advisory('activateBodycam').after(1).release(1, 'warn').after(1).close('report', 'cleared');
});

add('empty-call', 'A call with only its start', () => undefined);

/** Every scenario, in definition order. */
export const CORPUS: readonly Scenario[] = scenarios;

/** The scenario with `id` (throws when absent so a renamed scenario fails loudly). */
export function scenario(id: string): Scenario {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`corpus: no scenario ${id}`);
  return found;
}
