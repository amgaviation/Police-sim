/** Equipment catalog, policy and loadouts (Phase 7 design §8). */
export * from './types';
export {
  GEAR_FLEET_CLASSES,
  GEAR_ITEMS,
  GEAR_POLICY,
  OFFICER_PRESETS,
  REQUIRED_OFFICER_PRESETS,
  assignmentPolicy,
  gearItem,
  parseGearItems,
  parseOfficerPresets,
  parsePolicy,
  type AssignmentPolicy,
  type Ballistics,
  type GearItemDef,
  type GearPolicy,
} from './data';
export {
  BASE_SLOT_CAPACITY,
  GEAR_ITEM_IDS,
  WEIGHT_WARNING_SHARE,
  defaultVehicleLoadout,
  loadoutWeightKg,
  officerPreset,
  validateOfficerLoadout,
  validateVehicleLoadout,
} from './validate';
export { MAX_GEAR_PRESETS, OfficerGear, defaultGearSave, startingGearSave, isGearSave, officerHit, type GearPreset, type GearSave } from './officerGear';
