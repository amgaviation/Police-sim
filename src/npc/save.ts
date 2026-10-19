import type { NpcSave } from './types';

/** Structural validator of `NpcSave` (design §8.6). Field values are range-checked by `NpcSystem.restore`, which drops bad entries. */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isPed(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    int(v.personId) && int(v.edge) && v.edge >= 0 && num(v.s) && num(v.side) && num(v.dir) && num(v.speed) && v.speed > 0 &&
    num(v.gait) && num(v.flee) && (v.acc === undefined || num(v.acc)) && (v.ox === undefined || num(v.ox)) && (v.oz === undefined || num(v.oz))
  );
}

function isActor(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return (
    int(v.id) && int(v.personId) && typeof v.role === 'string' && int(v.callId) && typeof v.profile === 'string' && int(v.state) &&
    v.state >= 0 && v.state <= 19 && num(v.x) && num(v.z) && num(v.yaw) && num(v.speed) && num(v.stress) && num(v.timer) &&
    num(v.stamina) && int(v.flags) && typeof v.weapon === 'string' && int(v.vehicleId) && int(v.seat) && int(v.body) &&
    num(v.targetX) && num(v.targetZ) && Array.isArray(v.route) && v.route.length <= 64 && v.route.every(num) &&
    int(v.routePos) && num(v.lostTimer) && (v.acc === undefined || num(v.acc)) &&
    (v.building === undefined || (int(v.building) && v.building >= -1)) && (v.aware === undefined || num(v.aware)) &&
    (v.hideSpot === undefined || int(v.hideSpot))
  );
}

function isPairs(v: unknown): boolean {
  return Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2 && int(e[0]) && Array.isArray(e[1]) && e[1].every(int));
}

/** Is `x` shaped like an `NpcSave`? Optional `acc` fields default to 0. */
export function isNpcSave(x: unknown): x is NpcSave {
  if (!isRecord(x) || x.version !== 1) return false;
  return (
    isRngState(x.rng) && isRngState(x.pedsRng) && isRngState(x.actorsRng) && int(x.step) && int(x.nextActorId) &&
    num(x.retargetIn) && int(x.target) && Array.isArray(x.peds) && x.peds.every(isPed) && Array.isArray(x.actors) &&
    x.actors.every(isActor) && isPairs(x.occupants) && isPairs(x.out)
  );
}
