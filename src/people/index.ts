/** People module (design §5): persistent in-world identities, family, items, intoxication, occupants. */
export * from './types';
export { PEOPLE_DATA, ITEM_IDS, parsePeopleData, parseItems, type PeopleData } from './data';
export { ITEMS, itemDef, baseItems, vehicleItems, hasCarryNote, hasRegisteredHandgun, type VehicleDriver } from './items';
export { SALT, generateIdentity, describePerson, riskOf, type PersonDescription } from './identity';
export { familyOf, nameIndexFor } from './family';
export { baseIntoxication, intoxicationLevel, weekdayOfEpochDay } from './intoxication';
export { occupantsOf } from './occupants';
export { Population, isPeopleSave, PEOPLE_CAP, PER_PERSON_CAP, IDENTITY_CACHE, type PopulationDeps } from './population';
export { createPeopleCommands } from './commands';
