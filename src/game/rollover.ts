import { emptyBackupSave } from '../backup/save';
import { emptyCommandSave } from '../command/save';
import { emptyInteriorSave } from '../indoors/save';
import { emptyPursuitSave } from '../pursuit/save';
import { defaultRadioSave } from '../radio/save';
import { emptyResourceSave } from '../resources/save';
import { defaultTacticalSave } from '../tactical/save';
import { aiBidders } from '../career';
import { emptyContactSave } from '../contact/save';
import { emptySceneSave } from '../scene/save';
import { yawQuaternion } from './playerController';
import { newShiftStationSave } from '../station/stationState';
import type { SaveGame } from '../save/schema';
import { KIND } from '../ecs/components';
import { UNITS_DATA } from '../dispatch/data';
import type { DispatchSave } from '../dispatch/save';
import type { FollowUpCall } from '../worldstate';
import type { GameSession } from './session';

/** Where the next shift starts. */
export interface RolloverPlan {
  /** Game seconds when the shift ended. */
  nowGame: number;
  /** Game seconds when the next shift starts (the career's new shift window). */
  startGame: number;
  /** The officer's spawn on foot. */
  spawn: { x: number; z: number; yaw: number };
  /** The player's callsign. */
  callsign: string;
}

/** Court hearings in the gap between two shifts are moved to this long after the next shift starts (game seconds). */
export const HEARING_DELAY_S = 2 * 3600;

/** Narrative line of a call closed by the shift change. */
export const SHIFT_CHANGE_NOTE = 'Shift change: handled by the oncoming shift';

const scratchQuat = { x: 0, y: 0, z: 0, w: 1 };

/**
 * The pure save transform of a shift rollover (design §20.3): time jumps to the next shift start, per-shift state is
 * reset (traffic, pedestrians, dispatcher, scenes, contacts, backup, pursuit, command, resources, interiors, tactical,
 * radio, station flow), every open CAD call is closed 'handled', the AI units leave and the player is back on foot at the
 * station; the persistent blocks (vehicles, fleet, people, records, investigation, incidents, conduct, court, roster,
 * character, gear, career, world, mode) are kept. The input is not modified.
 */
export function rolloverSave(input: SaveGame, plan: RolloverPlan): SaveGame {
  const save = structuredClone(input);
  save.environment.timeOffset += Math.max(0, plan.startGame - plan.nowGame);
  // The officer on foot at the station door.
  const q = yawQuaternion(plan.spawn.yaw, scratchQuat);
  for (const e of save.world.entities) {
    if (e.kind !== KIND.Player) continue;
    e.x = plan.spawn.x;
    e.y = 0.9;
    e.z = plan.spawn.z;
    e.qx = q.x;
    e.qy = q.y;
    e.qz = q.z;
    e.qw = q.w;
    e.vx = e.vy = e.vz = 0;
    e.wx = e.wy = e.wz = 0;
    e.sleeping = false;
  }
  save.player = { mode: 'onFoot', vehicle: -1, lastVehicle: -1 };
  for (const v of save.vehicles) {
    v.lightbar = false;
    v.reversing = false;
  }
  save.traffic = null;
  save.npc = null;
  save.dispatch = null;
  save.violations = [];
  save.speeding = [];
  // CAD: open calls handled, AI and resource units gone, the player out of service, no stop.
  const cad = save.cad;
  for (const call of cad.calls) {
    if (call.status === 'closed') continue;
    call.status = 'closed';
    call.closed = { sim: save.clock.simTime, game: plan.nowGame };
    call.disposition = 'handled';
    call.offeredTo = null;
    call.units = [];
    call.primary = null;
    (call.narrative as { sim: number; game: number; source: string; text: string }[]).push({
      sim: save.clock.simTime,
      game: plan.nowGame,
      source: 'CAD',
      text: SHIFT_CHANGE_NOTE,
    });
  }
  cad.units = cad.units.filter((u) => u.kind === 'player');
  for (const u of cad.units) {
    u.status = 'outOfService';
    u.callId = null;
  }
  cad.trafficStop = null;
  // Per-shift blocks, on their own stream states.
  save.scenes = emptySceneSave(save.scenes.rng);
  save.contacts = emptyContactSave();
  save.interiors = emptyInteriorSave(save.interiors.rng);
  save.tactical = defaultTacticalSave(save.tactical.rng);
  save.radio = defaultRadioSave(save.radio.rng);
  save.backup = emptyBackupSave(save.backup.rng);
  save.pursuit = emptyPursuitSave(save.pursuit.rng);
  save.command = emptyCommandSave(save.command.rng);
  save.resources = emptyResourceSave(save.resources.rng);
  save.station = newShiftStationSave();
  // Court hearings that fell into the gap are held two hours into the next shift.
  const hearing = plan.startGame + HEARING_DELAY_S;
  for (const c of save.court.cases) {
    if (c.hearingGame > plan.nowGame && c.hearingGame <= plan.startGame && (c.status === 'scheduled' || c.status === 'pending')) c.hearingGame = hearing;
  }
  return save;
}

/** What the app needs after a successful report for duty. */
export interface PreparedRollover {
  ok: true;
  save: SaveGame;
  plan: RolloverPlan;
  followUps: FollowUpCall[];
  news: string[];
  /**
   * The dispatcher's rng streams at the end of the shift. The rolled save drops the dispatcher block (a fresh roster), so
   * `beginRolledShift` puts these back: the next shift draws new call locations instead of replaying the first shift's.
   */
  dispatchRng: DispatchSave['rng'];
}

export type RolloverAttempt = PreparedRollover | { ok: false; reason: string };

/**
 * Report for duty (design §20.3), the impure half of the rollover: resolves the bids when due, ends the off-duty period
 * in the career, evolves the world over the gap and applies its results, then serializes the session and transforms the
 * save. The caller loads the returned save into a fresh session. On `ok: false` nothing about the world changed
 * (an unfit officer takes leave and stays in the apartment).
 */
export function prepareRollover(session: GameSession): RolloverAttempt {
  const p8 = session.phase8;
  const career = p8.career;
  const nowGame = session.now().game;
  const before = career.view;
  const od = before.offDuty;
  if (od === null) return { ok: false, reason: 'Not off duty' };
  if (before.shift.shiftNo + 1 >= before.bid.nextBidShift) {
    const roster = UNITS_DATA.units.map((u) => ({ id: u.callsign, name: u.officer }));
    career.request({ kind: 'resolveBids', bidders: aiBidders(session.seed, roster, UNITS_DATA.units.map((u) => u.officer)) });
  }
  const result = career.reportForDuty(Math.floor(od.nextStartGame / 86400));
  if (!result.ok) return { ok: false, reason: result.reason };
  const startGame = career.view.shift.startGame;
  const trust: Record<string, number> = {};
  for (const row of session.conduct.trustRows()) trust[row.district] = row.value;
  const evo = p8.world.evolve({
    fromGame: nowGame,
    toGame: startGame,
    trust,
    arrestsByDistrict: p8.arrestsByDistrict,
    addressAt: (u) => session.randomAddress(u),
  });
  for (const id of evo.released) session.people.setCustody(id, 'released');
  // Freed by the court (acquitted, dismissed): out of the world's custody already, but still jailed in the people block.
  for (const o of p8.world.offenders()) {
    if (o.custody === 'released' && session.people.isTouched(o.personId) && session.people.state(o.personId).custody === 'jailed') {
      session.people.setCustody(o.personId, 'released');
    }
  }
  for (const m of evo.moves) if (m.address !== null) session.records.setAddress(m.personId, m.address);
  for (const t of evo.trustDeltas) session.conduct.request({ kind: 'trust', district: t.district, delta: t.delta, reason: 'neighborhood change' });
  const spawn = session.city.spawn;
  const plan: RolloverPlan = { nowGame, startGame, spawn: { x: spawn.x, z: spawn.z, yaw: spawn.yaw }, callsign: session.dispatcher.playerCallsign };
  const save = rolloverSave(session.serialize(), plan);
  return { ok: true, save, plan, followUps: evo.followUps, news: evo.news, dispatchRng: session.dispatcher.rngState() };
}

/**
 * After the rolled-over save is loaded: the dispatcher continues its rng streams (`PreparedRollover.dispatchRng`), the
 * shift starts in the locker room and follow-up warrant-service calls open.
 */
export function beginRolledShift(session: GameSession, followUps: readonly FollowUpCall[], dispatchRng?: DispatchSave['rng']): number {
  if (dispatchRng !== undefined) session.dispatcher.restoreRngState(dispatchRng);
  session.beginShiftInStation();
  let n = 0;
  for (const f of followUps) {
    const call = session.dispatcher.createScriptedCall({ typeId: f.typeId, x: f.x, z: f.z }, session.now());
    if (!call) continue;
    session.phase8.world.bindPerson(call.id, f.personId);
    n++;
  }
  return n;
}
