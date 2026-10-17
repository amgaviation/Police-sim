import { addComponent, type EntityId } from 'bitecs';
import { MAX_ENTITIES } from '../ecs/components';
import type { GameWorld } from '../ecs/world';

/** An ambient traffic car; `slot` indexes the `TrafficSystem` SoA (and its `view`). */
export const TrafficCar = {
  slot: new Int16Array(MAX_ENTITIES),
};

/** Adds `TrafficCar` to `eid` and sets its slot (entity ids are recycled). */
export function attachTrafficCar(world: GameWorld, eid: EntityId, slot: number): void {
  addComponent(world, eid, TrafficCar);
  TrafficCar.slot[eid] = slot;
}
