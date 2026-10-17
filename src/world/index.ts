/** Public API of the world module (no THREE imports: the chunk worker imports it). */
export * from './constants';
export * from './roadGraph';
export {
  BLOCK_KIND,
  BLOCK_KIND_NAMES,
  blockSurface,
  type Block,
  type BlockKindId,
  type City,
  type Poi,
  type PoiKind,
  type Pose2,
} from './city';
export { generateCity } from './generate';
export * from './chunkLayout';
export { WorldColliders, type WorldCollidersOptions } from './colliders';
export { STATION_SLOTS, stationLayout, type StationLayout } from './stationLayout';
export {
  DISTRICT_TYPES,
  LANDMARKS,
  ROAD_CLASSES,
  STREET_NAMES,
  ZONES,
  districtType,
  roadClassDef,
  validateDistrictTypes,
  validateDistricts,
  validateLandmarks,
  validateRoadClasses,
  validateStreetNames,
  validateZones,
  type DistrictTypeDef,
  type RoadClassDef,
} from './data';
