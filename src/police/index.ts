export { PoliceLights, SIREN_FLAG, attachPoliceLights, hasPoliceLights } from './components';
export {
  LIGHTBAR_PATTERNS,
  LIGHTBAR_SEGMENTS,
  REDUCED_FLASH,
  SEGMENT_COLOR,
  lightbarColors,
  maxTogglesPerSecond,
  patternIndex,
  reducedFlashRate,
  type LightbarFrame,
  type LightbarPattern,
  type SegmentColor,
} from './lightbar';
export {
  DEFAULT_SIREN_TONE,
  PatrolEquipment,
  RACK_ITEMS,
  RACK_UNLOCK_REQUIRES_STOP,
  SIREN_TONES,
  SPOTLIGHT,
  isEquipmentSave,
  isSirenTone,
  type EquipmentSave,
  type RackItem,
  type SirenTone,
  type SpotlightSpec,
  type VehicleEquipmentSpec,
} from './equipment';
export {
  OfficerKit,
  TRUNK_ITEMS,
  emptyOfficerKit,
  isOfficerKitSave,
  trunkItem,
  type OfficerKitSave,
  type TrunkItem,
} from './inventory';
export { createPoliceInput, readPoliceInput, type PoliceInput } from './controls';
export { createPoliceCommands, describeEquipment, type PoliceCommandDeps } from './commands';
