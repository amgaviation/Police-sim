/** Public API of the interior module (pure: no THREE, DOM or Rapier). */
export * from './constants';
export * from './types';
export { generateInterior } from './generate';
export { exitPath, findPath, reachableRooms, roomAt, type DoorPassable } from './nav';
export { furnitureBlocks, lineOfSight, wallsBlock, type DoorOpen } from './los';
export {
  FURNITURE,
  INTERIOR_TEMPLATES,
  parseFurniture,
  parseTemplate,
  parseTemplateSet,
  type BuildingTemplate,
  type FurnitureDef,
  type FurnitureEntry,
  type RoomDef,
  type TemplateSet,
} from './templates';
