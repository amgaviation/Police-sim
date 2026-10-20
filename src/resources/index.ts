/** Phase 6 resources: specialised unit pools, response-time dispatch, chain of command and the air unit. */
export { ON_STATION_S, ON_TARGET_M, ORBIT_R, REVEAL_EVERY_S, REVEAL_M, compassWord, newAirState, stepAir, airOnTarget, type AirState, type AirTargetKind } from './air';
export { EDGE_COORD, basePoint, firstPoiPoint, nearestPoiPoint, stationPoint, type BasePoint } from './bases';
export { CHAIN, chainResponse, type ChainTrigger, type ChainType } from './chain';
export { CREW_SIDE_M, CREW_SPACING_M, REAR_AXLE_M, crewSpot, type CrewSpot } from './crews';
export type { ResourceArrivedEvent, ResourceClearedEvent, ResourceDispatchedEvent } from './events';
export { ResourceSystem } from './resourceSystem';
export { POST_LEVELS, emptyResourceSave, isResourceRequest, isResourceSave, type PostLevel } from './save';
export {
  RESOURCE_STATUSES,
  type AirView,
  type ResourceAirSave,
  type ResourceDeps,
  type ResourceDispatchPort,
  type ResourceHud,
  type ResourceNpcPort,
  type ResourcePort,
  type ResourceRequest,
  type ResourceSave,
  type ResourceScenePort,
  type ResourceStatus,
  type ResourceTrafficPort,
  type ResourceUnitSave,
  type ResourceUnitView,
  type ResourceUrgency,
} from './types';
