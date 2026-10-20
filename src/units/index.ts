/** Phase 6 units: unit types, roster, personality and response-time estimation. */
export * from './types';
export {
  ETA_CONFIG,
  ROSTER_CONFIG,
  UNIT_TYPES,
  expandResourceSlots,
  parseEtaConfig,
  parseRosterConfig,
  parseUnitTypes,
  requestableTypes,
  resourceSlots,
  unitType,
} from './data';
export {
  airEta,
  estimateResponse,
  expectedSpeed,
  rankByEta,
  remainingEta,
  urgencyFor,
  type EtaCandidate,
  type EtaRoute,
  type RankedCandidate,
} from './eta';
export { mistakeChances, officerName, officerProfile, officerStart, rollMistakes } from './personality';
export { RosterState, emptyRosterSave, isRosterSave } from './roster';
