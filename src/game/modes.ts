import { restHeight, vehicleModel } from '../vehicles/model';
import { PERSON_POPULATION } from '../records/ids';
import { itemDef } from '../people/items';
import { coursePoint, planScenario, type SandboxScenario } from '../training';
import type { WeatherKind } from '../environment/weather';
import type { GameSession } from './session';

/** The unit the driving academy and the career driving module use. */
export const COURSE_UNIT = 'P-101';
/** Metres before the start line the car is placed. */
const COURSE_RUN_UP_M = 15;
const scratch = { x: 0, z: 0 };

/** The heading (session yaw) that faces along the course axis. */
function axisYaw(dirX: number, dirZ: number): number {
  return Math.atan2(-dirX, -dirZ);
}

/**
 * Starts a driving course run (design §20.3): the officer is seated in P-101 and the car stands 15 m before the start
 * line facing along the axis. Returns null when started, else the reason.
 */
export function startDrivingCourse(session: GameSession, courseId: string): string | null {
  const reason = session.phase8.startCourse(courseId);
  if (reason !== null) return reason;
  const anchor = session.phase8.mode.anchor;
  if (!anchor) return 'No course anchor';
  const car = session.unitVehicle(COURSE_UNIT);
  if (!car) {
    session.phase8.stopCourse();
    return `${COURSE_UNIT} is not available`;
  }
  if (!session.driving && !session.enterVehicle(car)) {
    // The yard car is the one the officer must drive: get in wherever it stands.
    session.phase8.stopCourse();
    return `Could not get into ${COURSE_UNIT}`;
  }
  const at = coursePoint(anchor, -COURSE_RUN_UP_M, 0, scratch);
  session.teleport(at.x, at.z, axisYaw(anchor.dirX, anchor.dirZ));
  return null;
}

/** Ends the run and puts the officer and the car back in the station lot (the driving academy flow after a result). */
export function leaveDrivingCourse(session: GameSession): void {
  session.phase8.stopCourse();
  if (session.driving) session.exitVehicle();
  const spawn = session.city.spawn;
  session.teleport(spawn.x, spawn.z, spawn.yaw);
}

/** Runs a sandbox scenario (design §20.3): the planned spawns in order, then the officer near the anchor. */
export function runScenario(session: GameSession, scenario: SandboxScenario): string | null {
  const p8 = session.phase8;
  p8.mode.scenario = structuredClone(scenario);
  const ops = planScenario(scenario, session.seed, (rng) => Math.floor(rng.next() * PERSON_POPULATION));
  let callId = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'environment': {
        if (op.hour !== null) session.env.setTimeOfDay(op.hour);
        if (op.weather !== null) session.env.setWeatherOverride(op.weather as WeatherKind, 1);
        break;
      }
      case 'call': {
        const call = session.dispatcher.createScriptedCall({ typeId: op.typeId, priority: op.priority, x: op.x, z: op.z }, session.now());
        if (call) callId = call.id;
        break;
      }
      case 'vehicle': {
        const model = vehicleModel(op.modelId);
        session.spawnVehicle(model, { x: op.x, y: restHeight(model), z: op.z, yaw: op.yaw });
        break;
      }
      case 'actor': {
        session.npc.spawnActor({
          personId: op.personId,
          x: op.x,
          z: op.z,
          yaw: op.yaw,
          profile: op.profile,
          role: op.role,
          callId,
          hidden: op.hidden,
          body: 'human',
          weapon: op.weapon,
          vehicleId: -1,
          building: -1,
        });
        break;
      }
      case 'evidence': {
        session.investigation.placeItem({
          callId,
          item: op.item,
          label: itemDef(op.item).label,
          x: op.x,
          y: 0,
          z: op.z,
          buildingId: -1,
          room: -1,
          furniture: -1,
          container: 'none',
          concealed: op.concealed,
          ownerPersonId: -1,
          incriminating: true,
        });
        break;
      }
    }
  }
  // The officer stands a short walk from the scene, facing it.
  session.teleport(scenario.anchor.x, scenario.anchor.z + 25, 0);
  return callId > 0 || scenario.call === null ? null : `The call type ${scenario.call.typeId} could not be created`;
}
