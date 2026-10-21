import { restHeight, vehicleModel } from '../vehicles/model';
import { PERSON_POPULATION } from '../records/ids';
import { itemDef } from '../people/items';
import { coursePoint, planScenario, type SandboxScenario } from '../training';
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

/**
 * Why the scenario editor / a scenario run is not available now (null when it is): scenarios spawn calls, people and
 * vehicles and may set the clock and the weather, so they run only in free patrol and sandbox sessions (never in a career,
 * the dispatch or driving training, or a co-op session where every client simulates its own world).
 */
export function scenarioBlockedReason(session: GameSession, coop = false): string | null {
  if (coop) return 'Scenarios are not available in a co-op session';
  const id = session.phase8.modeId;
  return id === 'freePatrol' || id === 'sandbox' ? null : 'Scenarios run in free patrol or sandbox mode, not in a career or training mode';
}

/**
 * Runs a sandbox scenario (design §20.3): the session switches to sandbox mode, the planned spawns run in order, then the
 * officer stands near the anchor. The clock and the weather change only when the scenario sets them; the weather in force
 * before comes back when the sandbox ends. Returns the reason when it cannot run.
 */
export function runScenario(session: GameSession, scenario: SandboxScenario, coop = false): string | null {
  const blocked = scenarioBlockedReason(session, coop);
  if (blocked !== null) return blocked;
  const p8 = session.phase8;
  if (p8.modeId !== 'sandbox') p8.setMode('sandbox');
  p8.mode.scenario = structuredClone(scenario);
  const ops = planScenario(scenario, session.seed, (rng) => Math.floor(rng.next() * PERSON_POPULATION));
  let callId = 0;
  for (const op of ops) {
    switch (op.op) {
      case 'environment': {
        if (op.hour !== null) session.env.setTimeOfDay(op.hour);
        if (op.weather !== null) p8.overrideWeather(op.weather, 1);
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
