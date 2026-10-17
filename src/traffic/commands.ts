import type { Command } from '../debug/console';
import { PULLOVER } from './data';
import { isFleetVehicleId, TRAFFIC_STATE, type FleetState, type TrafficSystem } from './trafficSystem';

/** Debug console commands of the traffic module: pullover, fleet. */

/** `pullover` looks for a car this close to the player (m). */
const PULLOVER_RANGE = 60;

export interface TrafficCommandDeps {
  traffic(): TrafficSystem | null;
  playerPosition(): { x: number; z: number } | null;
  /** Optional: the player's yaw, so `pullover` prefers cars ahead (else the nearest car). */
  playerHeading?(): number | null;
}

function need<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`${what} not available (no game running)`);
  return value;
}

function fmt(n: number, digits = 0): string {
  return n.toFixed(digits);
}

/** Console commands over the running game's traffic system. */
export function createTrafficCommands(deps: TrafficCommandDeps): Command[] {
  return [
    {
      name: 'pullover',
      description: 'Make the nearest ambient car ahead (within 60 m) pull over, or end the current stop',
      usage: '[release | abandon]',
      run(args) {
        const traffic = need(deps.traffic(), 'Traffic');
        const verb = args[0];
        if (verb === 'release' || verb === 'abandon') {
          const id = traffic.stopVehicleId;
          const ok = verb === 'release' ? traffic.releaseStop() : traffic.abandonStop();
          return ok ? `Stop on vehicle ${String(id)} ${verb === 'release' ? 'released' : 'abandoned'}` : 'No traffic stop';
        }
        if (verb !== undefined) throw new Error('Usage: pullover [release | abandon]');
        if (traffic.stopVehicleId >= 0) return `A stop is already running (vehicle ${String(traffic.stopVehicleId)})`;
        const at = need(deps.playerPosition(), 'Player position');
        const heading = deps.playerHeading?.() ?? null;
        const fx = heading === null ? 0 : -Math.sin(heading), fz = heading === null ? 0 : -Math.cos(heading);
        const view = traffic.view;
        let best = -1;
        let bestD = PULLOVER_RANGE;
        for (let i = 0; i < view.count; i++) {
          const id = view.vehicleId[i] ?? 0;
          if (isFleetVehicleId(id) || view.state[i] === TRAFFIC_STATE.crashed) continue;
          const dx = (view.x[i] ?? 0) - at.x, dz = (view.z[i] ?? 0) - at.z;
          if (heading !== null && dx * fx + dz * fz <= 0) continue;
          const d = Math.hypot(dx, dz);
          if (d < bestD) {
            best = i;
            bestD = d;
          }
        }
        if (best < 0) return `No car within ${String(PULLOVER_RANGE)} m${heading === null ? '' : ' ahead'}`;
        const id = view.vehicleId[best] ?? 0;
        if (!traffic.forceStop(id)) return `Vehicle ${String(id)} cannot be stopped`;
        return `Vehicle ${String(id)} pulling over (${fmt(bestD)} m)`;
      },
    },
    {
      name: 'fleet',
      description: 'List the AI police fleet cars: index, vehicle id, mode, arrival, position, speed',
      run() {
        const traffic = need(deps.traffic(), 'Traffic');
        const state: FleetState = { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
        const lines: string[] = [];
        for (let i = 0; i < PULLOVER.fleet.maxCars; i++) {
          const s = traffic.fleetState(i, state);
          if (!s) continue;
          const route = s.routeLeftM >= 0 ? `  route ${fmt(s.routeLeftM)} m` : '';
          lines.push(
            `${String(i).padStart(2)}  id ${String(traffic.vehicleIdOfEntity(s.eid))}  ${s.mode.padEnd(9)} ${s.arrived ? 'arrived' : '       '}${s.parked ? ' parked' : '       '}` +
              `  x ${fmt(s.x)} z ${fmt(s.z)}  ${fmt(s.speed, 1)} m/s${route}`,
          );
        }
        return lines.length === 0 ? 'No fleet cars' : lines.join('\n');
      },
    },
  ];
}
