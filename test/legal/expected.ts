import type { LegalAssessment } from '../../src/legal/types';

/** Every ruling of an assessment as one short line each, in evaluation order (see `EXPECTED`). */
export function digest(a: LegalAssessment): string[] {
  return [
    ...a.determinations.map((d) => `det ${d.doctrine} ${d.outcome} ${d.basis ?? '-'} ${d.ruleIds.join('+')}`),
    ...a.evidence.map((e) => `ev ${e.kind} ${e.admissible ? 'admissible' : 'suppressed'} ${e.ruleIds.join('+') || '-'}`),
    ...a.force.map((f) => `force ${f.verdict} ${f.ruleIds.join('+') || '-'}`),
    ...a.pursuits.map((p) => `pursuit ${p.outcome} ${p.ruleIds.join('+') || '-'}`),
  ];
}

/**
 * The corpus as an oracle (Phase 9 review): the rulings the engine must reach for every scenario under each shipped ruleset,
 * one `digest` line per ruling (determinations, then evidence, force and pursuit rulings, in evaluation order). Rule coverage
 * and the doctrine matrix only prove that some scenario cites a rule or reaches an outcome; this table pins what each
 * scenario concludes, so a flipped ruling fails here. Reviewed against each scenario's note. A deliberate rule change updates
 * the lines it affects, and the diff of this file is the review of the change.
 */
export const EXPECTED: Readonly<Record<string, { readonly generic: readonly string[]; readonly strict: readonly string[] }>> = {
  // A speeding stop is supported by reasonable suspicion
  'detention-lawful': {
    generic: ["det detention lawful - GS-1.1"],
    strict: ["det detention lawful - SS-1.1"],
  },
  // A stop with no indicator at all
  'detention-unlawful': {
    generic: ["det detention unlawful - GS-1.1"],
    strict: ["det detention unlawful - SS-1.1"],
  },
  // A witness who complies with a command is not detained
  'detention-consensual': {
    generic: [],
    strict: [],
  },
  // A call-level arrest warrant supports the stop of the call subject
  'detention-warrant-call': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful warrant GS-3.2"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful warrant SS-3.2"],
  },
  // A weapon indicator on a lawful stop supports a frisk that finds the gun
  'frisk-terry-lawful': {
    generic: ["det detention lawful - GS-1.1", "det frisk lawful terry GS-2.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det frisk lawful terry SS-2.1", "ev item admissible -"],
  },
  // A weapons frisk may not seize a non-weapon item (plain feel allows drugs only under generic)
  'frisk-scope-property': {
    generic: ["det detention lawful - GS-1.1", "det frisk lawful terry GS-2.1", "det friskScope unlawful - GS-2.2", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det frisk lawful terry SS-2.1", "det friskScope unlawful - SS-2.2", "ev item suppressed SS-12.1"],
  },
  // Drugs felt during a lawful weapons frisk: plain feel under generic, out of scope under strict
  'frisk-plain-feel-drugs': {
    generic: ["det detention lawful - GS-1.1", "det frisk lawful terry GS-2.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det frisk lawful terry SS-2.1", "det friskScope unlawful - SS-2.2", "ev item suppressed SS-12.1"],
  },
  // A frisk on a stop with no armed indicator
  'frisk-unlawful': {
    generic: ["det detention lawful - GS-1.1", "det frisk unlawful - GS-2.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det frisk unlawful - SS-2.1", "ev item suppressed SS-12.1"],
  },
  // A pat-down with consent
  'frisk-consent': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful searchPerson GS-5.1", "det frisk lawful consent GS-2.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det consent lawful searchPerson SS-5.1", "det frisk lawful consent SS-2.1", "ev item admissible -"],
  },
  // A pat-down incident to arrest
  'frisk-after-arrest': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det frisk lawful incidentToArrest GS-2.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det frisk lawful incidentToArrest SS-2.1", "ev item admissible -"],
  },
  // Probable cause for a drug offense, then a search of the person incident to the arrest
  'arrest-pc-drugs': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det search lawful incidentToArrest GS-4.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det search lawful incidentToArrest SS-4.1", "ev item admissible -"],
  },
  // A custodial arrest for a traffic offense (arrestable under generic only)
  'arrest-pc-traffic': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det search lawful incidentToArrest GS-4.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest unlawful - SS-3.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.2+SS-12.1"],
  },
  // A warrant hit supports the arrest
  'arrest-warrant': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful warrant GS-3.2"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful warrant SS-3.2"],
  },
  // An arrest on weak suspicion (impaired-driving cues only) taints the search and the evidence
  'arrest-unlawful': {
    generic: ["det detention lawful - GS-1.1", "det arrest unlawful - GS-3.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.2+GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest unlawful - SS-3.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.2+SS-12.1"],
  },
  // A booking after the cuffing arrest is not a second arrest
  'arrest-booking-duplicate': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1"],
  },
  // A vehicle search incident to a drug arrest (evidence of the offense may be in the car)
  'vehicle-sita-drugs': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det search lawful incidentToArrest GS-4.2", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det search lawful incidentToArrest SS-4.2", "ev item admissible -"],
  },
  // A vehicle search incident to a warrant arrest: broad under generic, Gant-limited under strict
  'vehicle-sita-warrant': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful warrant GS-3.2", "det search lawful incidentToArrest GS-4.2", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful warrant SS-3.2", "det search unlawful - SS-4.2+SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A vehicle search long after the arrest is outside the window
  'vehicle-sita-late': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful warrant GS-3.2", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful warrant SS-3.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A search just before an arrest that follows within a minute (generic only)
  'pre-arrest-search': {
    generic: ["det detention lawful - GS-1.1", "det search lawful incidentToArrest GS-4.1", "det arrest lawful probableCause GS-3.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det search unlawful - SS-12.1", "det arrest lawful probableCause SS-3.1", "ev item suppressed SS-12.1"],
  },
  // Probable cause for a drug offense without an arrest allows a vehicle search
  'automobile-exception': {
    generic: ["det detention lawful - GS-1.1", "det search lawful automobile GS-4.3", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det search lawful automobile SS-4.3", "ev item admissible -"],
  },
  // A vehicle search with nothing behind it
  'vehicle-search-no-basis': {
    generic: ["det detention lawful - GS-1.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // Freely given consent covers the person search
  'consent-lawful': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful searchPerson GS-5.1", "det search lawful consent GS-5.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det consent lawful searchPerson SS-5.1", "det search lawful consent SS-5.1", "ev item admissible -"],
  },
  // Consent to search the person does not cover the vehicle
  'consent-scope-miss': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful searchPerson GS-5.1", "det search unlawful - GS-5.2+GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det consent lawful searchPerson SS-5.1", "det search unlawful - SS-5.2+SS-12.1", "ev item suppressed SS-12.1"],
  },
  // Consent given at gunpoint is coerced
  'consent-weapon-drawn': {
    generic: ["det detention lawful - GS-1.1", "det consent unlawful searchVehicle GS-5.3", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det consent unlawful searchVehicle SS-5.3", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // Two aggressive lines: coerced under strict (max 1), acceptable under generic (max 3)
  'consent-aggressive-2': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful searchVehicle GS-5.1", "det search lawful consent GS-5.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det consent unlawful searchVehicle SS-5.3", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A person who cannot give consent
  'consent-invalid': {
    generic: ["det detention lawful - GS-1.1", "det consent unlawful searchPerson GS-5.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det consent unlawful searchPerson SS-5.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A refusal revokes an earlier consent of the same kind
  'consent-refused': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful searchVehicle GS-5.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det consent lawful searchVehicle SS-5.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // Consent obtained during an unlawful detention does not cure it
  'consent-tainted': {
    generic: ["det detention unlawful - GS-1.1", "det consent questionable searchPerson GS-5.1+GS-12.2", "det search unlawful - GS-12.1", "ev item suppressed GS-12.2+GS-12.1"],
    strict: ["det detention unlawful - SS-1.1", "det consent questionable searchPerson SS-5.1+SS-12.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.2+SS-12.1"],
  },
  // Screaming inside: exigent entry and search of the premises
  'exigency-entry-search': {
    generic: ["det entry lawful exigency GS-6.1", "det search lawful exigency GS-6.1", "ev item admissible -"],
    strict: ["det entry lawful exigency SS-6.1", "det search lawful exigency SS-6.1", "ev item admissible -"],
  },
  // The exigency was confirmed far too long before the search
  'exigency-stale': {
    generic: ["det entry lawful exigency GS-6.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det entry lawful exigency SS-6.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // An entry with no basis, then a plain-view claim from inside
  'entry-unlawful-fruit': {
    generic: ["det entry unlawful - GS-6.2", "det search unlawful - GS-6.4+GS-12.1", "ev item suppressed GS-12.2+GS-12.1"],
    strict: ["det entry unlawful - SS-6.2", "det search unlawful - SS-6.4+SS-12.1", "ev item suppressed SS-12.2+SS-12.1"],
  },
  // The occupant lets the officer in and consents to a search of the room
  'entry-consent': {
    generic: ["det consent lawful entry GS-5.1", "det entry lawful consent GS-5.1", "det consent lawful searchRoom GS-5.1", "det search lawful consent GS-5.1", "ev item admissible -"],
    strict: ["det consent lawful entry SS-5.1", "det entry lawful consent SS-5.1", "det consent lawful searchRoom SS-5.1", "det search lawful consent SS-5.1", "ev item admissible -"],
  },
  // Consent to enter is not consent to search the room
  'entry-consent-only': {
    generic: ["det consent lawful entry GS-5.1", "det entry lawful consent GS-5.1", "det search unlawful - GS-5.2+GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det consent lawful entry SS-5.1", "det entry lawful consent SS-5.1", "det search unlawful - SS-5.2+SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A search warrant covers the entry and the search of the premises
  'entry-warrant': {
    generic: ["det entry lawful warrant GS-3.2", "det search lawful warrant GS-3.2", "ev item admissible -"],
    strict: ["det entry lawful warrant SS-3.2", "det search lawful warrant SS-3.2", "ev item admissible -"],
  },
  // A public place needs no basis; plain view and public area are lawful there
  'entry-public': {
    generic: ["det entry lawful publicPlace GS-6.2", "det search lawful plainView GS-6.4", "det search lawful publicArea GS-6.4", "ev item admissible -"],
    strict: ["det entry lawful publicPlace SS-6.2", "det search lawful plainView SS-6.4", "det search lawful publicArea SS-6.4", "ev item admissible -"],
  },
  // A protective sweep of the building where the lawful arrest happened
  'protective-sweep': {
    generic: ["det consent lawful entry GS-5.1", "det entry lawful consent GS-5.1", "det arrest lawful warrant GS-3.2", "det search lawful protectiveSweep GS-6.3"],
    strict: ["det consent lawful entry SS-5.1", "det entry lawful consent SS-5.1", "det arrest lawful warrant SS-3.2", "det search lawful protectiveSweep SS-6.3"],
  },
  // A sweep claim with no arrest in the building
  'sweep-no-arrest': {
    generic: ["det entry lawful publicPlace GS-6.2", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det entry lawful publicPlace SS-6.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A room search claiming incident to arrest right after a lawful arrest
  'premises-sita-claim': {
    generic: ["det entry lawful publicPlace GS-6.2", "det arrest lawful warrant GS-3.2", "det search lawful incidentToArrest GS-4.1", "ev item admissible -"],
    strict: ["det entry lawful publicPlace SS-6.2", "det arrest lawful warrant SS-3.2", "det search lawful incidentToArrest SS-4.1", "ev item admissible -"],
  },
  // Custodial questioning about the account without a warning: the answer is suppressed
  'miranda-unwarned': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det miranda unlawful - GS-7.1", "ev statement suppressed GS-7.1+GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det miranda unlawful - SS-7.1", "ev statement suppressed SS-7.1+SS-12.1"],
  },
  // Warned and waived: the statement stands
  'miranda-waived': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "ev statement admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "ev statement admissible -"],
  },
  // Questioning after the person invoked their rights
  'miranda-invoked': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det miranda unlawful - GS-7.2", "ev statement suppressed GS-7.2+GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det miranda unlawful - SS-7.2", "ev statement suppressed SS-7.2+SS-12.1"],
  },
  // Questioned at gunpoint without being in custody: custody only under strict
  'miranda-gunpoint': {
    generic: ["det detention lawful - GS-1.1", "ev statement admissible -"],
    strict: ["det detention lawful - SS-1.1", "det miranda unlawful - SS-7.1", "ev statement suppressed SS-7.1+SS-12.1"],
  },
  // A roadside question outside custody needs no warning
  'miranda-not-custodial': {
    generic: ["det detention lawful - GS-1.1", "ev statement admissible -"],
    strict: ["det detention lawful - SS-1.1", "ev statement admissible -"],
  },
  // Answers after an unlawful stop are fruit of it
  'statement-unlawful-stop': {
    generic: ["det detention unlawful - GS-1.1", "ev statement suppressed GS-12.2+GS-12.1"],
    strict: ["det detention unlawful - SS-1.1", "ev statement suppressed SS-12.2+SS-12.1"],
  },
  // A PBT with consent
  'test-consented': {
    generic: ["det detention lawful - GS-1.1", "det consent lawful pbt GS-5.1", "det test lawful consent GS-7.3", "ev test admissible -"],
    strict: ["det detention lawful - SS-1.1", "det consent lawful pbt SS-5.1", "det test lawful consent SS-7.3", "ev test admissible -"],
  },
  // A field sobriety test with neither consent nor an arrest
  'test-no-consent': {
    generic: ["det detention lawful - GS-1.1", "det test unlawful - GS-7.3", "ev test suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det test unlawful - SS-7.3", "ev test suppressed SS-12.1"],
  },
  // A breath test after a DUI arrest: implied consent under generic only
  'test-implied-consent': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det test lawful arrest GS-7.3", "ev test admissible -"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det test unlawful - SS-7.3", "ev test suppressed SS-12.1"],
  },
  // Drugs from an unlawful frisk would have been found in the later lawful arrest (generic only)
  'evidence-inevitable': {
    generic: ["det detention lawful - GS-1.1", "det frisk unlawful - GS-2.1", "det arrest lawful warrant GS-3.2", "ev item admissible GS-12.3"],
    strict: ["det detention lawful - SS-1.1", "det frisk unlawful - SS-2.1", "det arrest lawful warrant SS-3.2", "ev item suppressed SS-12.1"],
  },
  // Seizures after a lawful automobile search are admissible
  'evidence-seizure-lawful': {
    generic: ["det detention lawful - GS-1.1", "det search lawful automobile GS-4.3", "ev item admissible -", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det search lawful automobile SS-4.3", "ev item admissible -", "ev item admissible -"],
  },
  // Seizures trace back to the unlawful search that found them
  'evidence-seizure-unlawful': {
    generic: ["det detention lawful - GS-1.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1", "ev item suppressed GS-12.2+GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1", "ev item suppressed SS-12.2+SS-12.1"],
  },
  // A drug indicator that stems from an unlawful frisk cannot support the arrest
  'evidence-fruit-indicator': {
    generic: ["det detention lawful - GS-1.1", "det frisk unlawful - GS-2.1", "det arrest unlawful - GS-3.1", "ev item suppressed GS-12.1"],
    strict: ["det detention lawful - SS-1.1", "det frisk unlawful - SS-2.1", "det arrest unlawful - SS-3.1", "ev item suppressed SS-12.1"],
  },
  // Soft hands on an active resister
  'force-justified': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "force justified SS-8.1"],
  },
  // Hard hands on a passive subject: one step too far
  'force-questionable': {
    generic: ["det detention lawful - GS-1.1", "det force questionable - GS-8.1", "force questionable GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det force questionable - SS-8.1", "force questionable SS-8.1"],
  },
  // A baton on a compliant subject
  'force-excessive': {
    generic: ["det detention lawful - GS-1.1", "det force unlawful - GS-8.1", "force excessive GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det force unlawful - SS-8.1", "force excessive SS-8.1"],
  },
  // A baton on an active resister: allowed under generic, one step over under strict
  'force-baton-active': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det force questionable - SS-8.1", "force questionable SS-8.1"],
  },
  // Hard hands on a handcuffed subject
  'force-restrained': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det force unlawful - GS-8.2", "force excessive GS-8.2"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det force unlawful - SS-8.2", "force excessive SS-8.2"],
  },
  // Three TASER cycles pass under generic; the third is one too many under strict
  'force-taser-cycles': {
    generic: ["det detention lawful - GS-1.1", "det force unlawful - GS-8.3", "force justified GS-8.1", "force justified GS-8.1", "force excessive GS-8.3"],
    strict: ["det detention lawful - SS-1.1", "det force unlawful - SS-8.3", "det force unlawful - SS-8.3", "force justified SS-8.1", "force excessive SS-8.3", "force excessive SS-8.3"],
  },
  // A TASER on an elevated subject who is only an active resister
  'force-taser-risk': {
    generic: ["det detention lawful - GS-1.1", "det force unlawful - GS-8.4", "force excessive GS-8.4"],
    strict: ["det detention lawful - SS-1.1", "det force unlawful - SS-8.4", "force excessive SS-8.4"],
  },
  // A firearm used on an assaultive subject
  'force-firearm-nonlethal': {
    generic: ["det detention lawful - GS-1.1", "det force unlawful - GS-8.5", "force excessive GS-8.5"],
    strict: ["det detention lawful - SS-1.1", "det force unlawful - SS-8.5", "force excessive SS-8.5"],
  },
  // A firearm used against a lethal threat
  'force-firearm-lethal': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "force justified SS-8.1"],
  },
  // Pointing a firearm at a compliant subject (below the display minimum under strict)
  'force-display': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det force questionable - SS-8.6", "force questionable SS-8.6", "force justified SS-8.1"],
  },
  // Officer presence is always justified
  'force-presence': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "force justified SS-8.1"],
  },
  // A partner uses excessive force within reach and the officer does not step in
  'intervene-failed': {
    generic: ["det detention lawful - GS-1.1", "det intervene unlawful - GS-9.1", "force excessive GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det intervene unlawful - SS-9.1", "force excessive SS-8.1"],
  },
  // The officer steps in within the window
  'intervene-done': {
    generic: ["det detention lawful - GS-1.1", "det intervene lawful - GS-9.1", "force excessive GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det intervene lawful - SS-9.1", "force excessive SS-8.1"],
  },
  // The officer steps in after the window closed
  'intervene-late': {
    generic: ["det detention lawful - GS-1.1", "det intervene unlawful - GS-9.1", "force excessive GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "det intervene unlawful - SS-9.1", "force excessive SS-8.1"],
  },
  // Excessive force too far away to stop
  'intervene-far': {
    generic: ["det detention lawful - GS-1.1", "force excessive GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "force excessive SS-8.1"],
  },
  // A burst of strikes by one partner is one episode
  'intervene-episode': {
    generic: ["det detention lawful - GS-1.1", "det intervene unlawful - GS-9.1", "force excessive GS-8.1", "force excessive GS-8.1", "force excessive GS-8.5"],
    strict: ["det detention lawful - SS-1.1", "det intervene unlawful - SS-9.1", "force excessive SS-8.1", "force excessive SS-8.1", "force excessive SS-8.5"],
  },
  // A partner uses justified force
  'other-force-justified': {
    generic: ["det detention lawful - GS-1.1", "force justified GS-8.1"],
    strict: ["det detention lawful - SS-1.1", "force justified SS-8.1"],
  },
  // A violent suspect, speeds within the margin, lights and siren on, ends in an arrest
  'pursuit-lawful': {
    generic: ["det pursuit lawful - GS-10.1", "pursuit lawful -"],
    strict: ["det pursuit lawful - SS-10.1", "pursuit lawful -"],
  },
  // A pursuit for a traffic offense
  'pursuit-offense': {
    generic: ["det pursuit unlawful - GS-10.1", "pursuit unlawful GS-10.1"],
    strict: ["det pursuit unlawful - SS-10.1", "pursuit unlawful SS-10.1"],
  },
  // Far above the limit for longer than the allowed seconds
  'pursuit-speed': {
    generic: ["det pursuit unlawful - GS-10.3", "pursuit unlawful GS-10.3"],
    strict: ["det pursuit unlawful - SS-10.3", "pursuit unlawful SS-10.3"],
  },
  // Twenty over for 25 seconds: within the generic margin, over the strict one
  'pursuit-speed-moderate': {
    generic: ["det pursuit lawful - GS-10.1", "pursuit lawful -"],
    strict: ["det pursuit unlawful - SS-10.3", "pursuit unlawful SS-10.3"],
  },
  // Lights off during the pursuit
  'pursuit-equipment': {
    generic: ["det pursuit unlawful - GS-10.4", "pursuit unlawful GS-10.4"],
    strict: ["det pursuit unlawful - SS-10.4", "pursuit unlawful SS-10.4"],
  },
  // A pursuit that outlasts the maximum duration without a termination
  'pursuit-too-long': {
    generic: ["det pursuit unlawful - GS-10.2", "pursuit unlawful GS-10.2"],
    strict: ["det pursuit unlawful - SS-10.2", "pursuit unlawful SS-10.2"],
  },
  // The same long pursuit, terminated by the officer, is within policy
  'pursuit-terminated': {
    generic: ["det pursuit lawful - GS-10.1", "pursuit lawful -"],
    strict: ["det pursuit lawful - SS-10.1", "pursuit lawful -"],
  },
  // The termination advisory is ignored for a minute
  'pursuit-advisory-ignored': {
    generic: ["det pursuit unlawful - GS-10.2", "pursuit unlawful GS-10.2"],
    strict: ["det pursuit unlawful - SS-10.2", "pursuit unlawful SS-10.2"],
  },
  // A pursuit for impaired driving: allowed under generic only
  'pursuit-dui': {
    generic: ["det pursuit lawful - GS-10.1", "pursuit lawful -"],
    strict: ["det pursuit unlawful - SS-10.1", "pursuit unlawful SS-10.1"],
  },
  // No indicator: the offense of a pursuit-family suspect comes from the call family
  'pursuit-family-offense': {
    generic: ["det pursuit lawful - GS-10.1", "pursuit lawful -"],
    strict: ["det pursuit unlawful - SS-10.1", "pursuit unlawful SS-10.1"],
  },
  // Wet and dark reduce the margin
  'pursuit-wet-night': {
    generic: ["det pursuit unlawful - GS-10.3", "pursuit unlawful GS-10.3"],
    strict: ["det pursuit unlawful - SS-10.3", "pursuit unlawful SS-10.3"],
  },
  // A foot pursuit is not judged as a vehicle pursuit
  'pursuit-on-foot': {
    generic: [],
    strict: [],
  },
  // The body camera is off during a detention
  'recording-missing': {
    generic: ["det detention lawful - GS-1.1", "det recording unlawful - GS-11.1"],
    strict: ["det detention lawful - SS-1.1", "det recording unlawful - SS-11.1"],
  },
  // The recording is muted during an arrest
  'recording-muted': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det recording unlawful - GS-11.2"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det recording unlawful - SS-11.2"],
  },
  // The dash camera covers a detention but not a search
  'recording-dash': {
    generic: ["det detention lawful - GS-1.1", "det search lawful automobile GS-4.3", "det recording unlawful - GS-11.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det search lawful automobile SS-4.3", "det recording unlawful - SS-11.1", "ev item admissible -"],
  },
  // The camera is off, but only within the activation grace of the first contact
  'recording-grace': {
    generic: ["det detention lawful - GS-1.1"],
    strict: ["det detention lawful - SS-1.1"],
  },
  // Everything is recorded
  'recording-full': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1", "det consent lawful searchPerson GS-5.1", "det frisk lawful consent GS-2.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1", "det consent lawful searchPerson SS-5.1", "det frisk lawful consent SS-2.1"],
  },
  // An active exigency is a basis for premises only: a person search and a vehicle search stay unlawful
  'exigency-person-vehicle': {
    generic: ["det search unlawful - GS-12.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det search unlawful - SS-12.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1", "ev item suppressed SS-12.1"],
  },
  // An exigency confirmed for one building does not justify a search of another
  'exigency-other-building': {
    generic: ["det entry lawful publicPlace GS-6.2", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det entry lawful publicPlace SS-6.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A room search claiming incident to arrest 400 s after a lawful arrest: inside the generic window (600 s), outside strict (300 s)
  'premises-sita-edge': {
    generic: ["det entry lawful publicPlace GS-6.2", "det arrest lawful warrant GS-3.2", "det search lawful incidentToArrest GS-4.1", "ev item admissible -"],
    strict: ["det entry lawful publicPlace SS-6.2", "det arrest lawful warrant SS-3.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A room search claiming incident to arrest 1000 s after a lawful arrest is outside both windows
  'premises-sita-outside': {
    generic: ["det entry lawful publicPlace GS-6.2", "det arrest lawful warrant GS-3.2", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det entry lawful publicPlace SS-6.2", "det arrest lawful warrant SS-3.2", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A booking with no earlier cuffing arrest is itself the arrest: lawful with probable cause
  'arrest-booking-only-pc': {
    generic: ["det detention lawful - GS-1.1", "det arrest lawful probableCause GS-3.1"],
    strict: ["det detention lawful - SS-1.1", "det arrest lawful probableCause SS-3.1"],
  },
  // A booking with no earlier cuffing arrest and no probable cause is an unlawful arrest
  'arrest-booking-only-no-pc': {
    generic: ["det arrest unlawful - GS-3.1"],
    strict: ["det arrest unlawful - SS-3.1"],
  },
  // A search 100 s before the arrest is outside the pre-arrest window (60 s)
  'pre-arrest-late': {
    generic: ["det detention lawful - GS-1.1", "det search unlawful - GS-12.1", "det arrest lawful probableCause GS-3.1", "ev item admissible GS-12.3"],
    strict: ["det detention lawful - SS-1.1", "det search unlawful - SS-12.1", "det arrest lawful probableCause SS-3.1", "ev item suppressed SS-12.1"],
  },
  // A search before an arrest that only speeding supports: lawful pre-arrest under generic, no window under strict
  'pre-arrest-speeding': {
    generic: ["det detention lawful - GS-1.1", "det search lawful incidentToArrest GS-4.1", "det arrest lawful probableCause GS-3.1", "ev item admissible -"],
    strict: ["det detention lawful - SS-1.1", "det search unlawful - SS-12.1", "det arrest unlawful - SS-3.1", "ev item suppressed SS-12.1"],
  },
  // The occupant consents to a search of the room of the building: it covers the officer who searches it
  'consent-occupant-building': {
    generic: ["det consent lawful searchRoom GS-5.1", "det entry lawful consent GS-5.1", "det search lawful consent GS-5.1", "ev item admissible -"],
    strict: ["det consent lawful searchRoom SS-5.1", "det entry lawful consent SS-5.1", "det search lawful consent SS-5.1", "ev item admissible -"],
  },
  // The occupant's consent to enter does not cover a search of the room
  'consent-occupant-entry-only': {
    generic: ["det consent lawful entry GS-5.1", "det entry lawful consent GS-5.1", "det search unlawful - GS-5.2+GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det consent lawful entry SS-5.1", "det entry lawful consent SS-5.1", "det search unlawful - SS-5.2+SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A second occupant's refusal revokes the first occupant's consent for the same building
  'consent-building-revoked': {
    generic: ["det consent lawful searchRoom GS-5.1", "det entry lawful consent GS-5.1", "det search unlawful - GS-12.1", "ev item suppressed GS-12.1"],
    strict: ["det consent lawful searchRoom SS-5.1", "det entry lawful consent SS-5.1", "det search unlawful - SS-12.1", "ev item suppressed SS-12.1"],
  },
  // A refusal for another building does not revoke the consent
  'consent-other-building-kept': {
    generic: ["det consent lawful searchRoom GS-5.1", "det entry lawful consent GS-5.1", "det search lawful consent GS-5.1", "ev item admissible -"],
    strict: ["det consent lawful searchRoom SS-5.1", "det entry lawful consent SS-5.1", "det search lawful consent SS-5.1", "ev item admissible -"],
  },
  // Commands, services, advisories, charges, releases and the close are recorded without a ruling
  'quiet-kinds': {
    generic: ["det detention lawful - GS-1.1"],
    strict: ["det detention lawful - SS-1.1"],
  },
  // A call with only its start
  'empty-call': {
    generic: [],
    strict: [],
  },
};
