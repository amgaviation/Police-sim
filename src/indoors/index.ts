/** Public API of the interior runtime (design §6). */
import './events';
export * from './types';
export { InteriorSystem } from './interiorSystem';
export { occupantPlan, residentPerson, hourOf, isOpenAt } from './occupants';
export { MAX_OVERRIDES, MAX_QUEUE, emptyInteriorSave, isInteriorSave, type InteriorSave } from './save';
export type {
  InteriorDoorEvent,
  InteriorFlashEvent,
  InteriorMoveOfficerEvent,
  InteriorResidentEvent,
  InteriorSwitchEvent,
  InteriorTransitionEvent,
} from './events';
