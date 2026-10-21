import '../tutorial/events';
import type { CadState } from '../cad/cadState';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { PatrolEquipment } from '../police/equipment';
import {
  TUTORIAL_TOPICS,
  TutorialRunner,
  isTutorialSave,
  newTutorialSave,
  type TutorialPorts,
  type TutorialProbe,
  type TutorialSave,
} from '../tutorial';
import type { DrivableVehicle } from '../vehicles/drivableVehicle';
import type { City } from '../world/city';

/** POIs tried for a tutorial call before giving up. */
const MAX_CALL_TRIES = 24;

/** Everything the tutorial reads of the rest of the session (the session fills it). */
export interface Phase9Host {
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly dispatcher: Dispatcher;
  readonly city: City;
  /** Sim and game time now (CAD timestamps). */
  now(): { sim: number; game: number };
  /** The officer's simulated position. */
  playerPosition(out: { x: number; z: number }): { x: number; z: number };
  /** The vehicle the officer drives, null on foot. */
  drivenVehicle(): DrivableVehicle | null;
  /** Equipment of the driven vehicle, null on foot or without equipment. */
  drivenEquipment(): PatrolEquipment | null;
}

/**
 * The guided first shift of one session (Phase 9 design §19.2): the optional `TutorialRunner`, the bus forwarding and the
 * ports that read simulation state. Simulation state only: the runner steps at order -651, its queue and step index are
 * saved, and nothing here draws a random number.
 */
export class Phase9 {
  private runnerOrNull: TutorialRunner | null = null;
  private readonly host: Phase9Host;
  private readonly offs: (() => void)[] = [];
  private readonly scratch = { x: 0, z: 0 };

  constructor(host: Phase9Host) {
    this.host = host;
    for (const topic of TUTORIAL_TOPICS) {
      this.offs.push(host.bus.on(topic, (payload) => this.runnerOrNull?.onEvent(topic, payload)));
    }
  }

  /** The runner, null when the game has no tutorial. */
  get runner(): TutorialRunner | null {
    return this.runnerOrNull;
  }

  /** A tutorial is running (not finished or ended). */
  get active(): boolean {
    return this.runnerOrNull?.view.active === true;
  }

  /** Starts (or restarts) the tutorial script `scriptId`. False when the id is unknown. */
  start(scriptId: string): boolean {
    const save = newTutorialSave(scriptId);
    if (!isTutorialSave(save)) return false;
    this.runnerOrNull = new TutorialRunner(this.host.bus, this.ports(), save);
    return true;
  }

  /** Restores a saved block (a finished one stays finished); null means no tutorial. */
  restore(save: TutorialSave | null): void {
    this.runnerOrNull = save === null ? null : new TutorialRunner(this.host.bus, this.ports(), save);
  }

  /** The fixed step (system `tutorial`, order -651). */
  step(): void {
    this.runnerOrNull?.step();
  }

  /** The save block: null without a tutorial. */
  serialize(): { tutorial: TutorialSave | null } {
    return { tutorial: this.runnerOrNull?.serialize() ?? null };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.runnerOrNull = null;
  }

  private ports(): TutorialPorts {
    return {
      playerCallsign: () => this.host.dispatcher.playerCallsign,
      probe: (id, callId) => this.probe(id, callId),
      createCall: (typeId, minM, maxM) => this.createCall(typeId, minM, maxM),
    };
  }

  private probe(id: TutorialProbe, callId: number): number {
    const host = this.host;
    switch (id) {
      case 'speedKmh':
        return host.drivenVehicle()?.telemetry.speedKmh ?? 0;
      case 'driving':
        return host.drivenVehicle() !== null ? 1 : 0;
      case 'lightbar':
        return host.drivenVehicle()?.lightbar === true ? 1 : 0;
      case 'siren':
        return host.drivenEquipment()?.sirenOn === true ? 1 : 0;
      case 'distanceToCallM': {
        if (callId < 0) return Infinity;
        const call = host.cad.call(callId);
        if (!call) return Infinity;
        const p = host.playerPosition(this.scratch);
        return Math.hypot(call.location.x - p.x, call.location.z - p.z);
      }
    }
  }

  /**
   * The call of a step: at the POI (any kind) whose distance from the player is nearest to the middle of `minM`..`maxM`
   * (within the range; else the nearest ones beyond `maxM`), ties to the lower POI id. A POI the dispatcher cannot place a
   * call at (no road nearby) is skipped for the next best. The dispatcher's own assignment pass offers a pending call to an
   * available player in a police car.
   */
  private createCall(typeId: string, minM: number, maxM: number): number {
    const host = this.host;
    const p = host.playerPosition(this.scratch);
    const mid = (minM + maxM) / 2;
    const inRange: { id: number; x: number; z: number; score: number }[] = [];
    const beyond: { id: number; x: number; z: number; score: number }[] = [];
    for (const poi of host.city.pois) {
      const d = Math.hypot(poi.x - p.x, poi.z - p.z);
      if (d >= minM && d <= maxM) inRange.push({ id: poi.id, x: poi.x, z: poi.z, score: Math.abs(d - mid) });
      else if (d > maxM) beyond.push({ id: poi.id, x: poi.x, z: poi.z, score: d });
    }
    const byScore = (a: { id: number; score: number }, b: { id: number; score: number }): number => a.score - b.score || a.id - b.id;
    inRange.sort(byScore);
    beyond.sort(byScore);
    const t = host.now();
    let tries = 0;
    for (const at of [...inRange, ...beyond]) {
      if (tries++ >= MAX_CALL_TRIES) break;
      const call = host.dispatcher.createScriptedCall({ typeId, x: at.x, z: at.z }, t);
      if (call !== null) return call.id;
    }
    return -1;
  }
}
