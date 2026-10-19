/** Phase 4 scene rig: the real `InteriorSystem` over the harness city, a recording evidence port and an armory stub. */
import { InteriorSystem, type OccupantPort } from '../../src/indoors';
import type { CaseSummaryLike, SceneEvidencePort, ScenePlaceItem, ScenarioRuntime } from '../../src/scene/types';
import { BuildingIndex, type BuildingKind } from '../../src/world/buildings';
import { createRng } from '../../src/core/rng';
import { cityBuildings } from '../interior/helpers';
import { GAME0, at, makeRig, run, step, type RigOptions, type SceneRig } from './helpers';

export const NO_OCCUPANTS: OccupantPort = { spawn: () => 0, remove: () => undefined, busy: () => false, sceneOwns: () => true };

export class RecordingEvidence implements SceneEvidencePort {
  readonly placed: ScenePlaceItem[] = [];
  readonly removed: number[] = [];
  placeItem(spec: ScenePlaceItem): string {
    this.placed.push(spec);
    return `E-${spec.callId}-${this.placed.length}`;
  }
  removeCallItems(callId: number): void {
    this.removed.push(callId);
  }
  summary(callId: number): CaseSummaryLike {
    return {
      items: this.placed.filter((p) => p.callId === callId).length,
      found: 0, plainView: 0, suppressed: 0, collected: 0, custodyComplete: false, photos: 0, markers: 0, prints: 0, canvass: 0, consents: 0, bodycam: false,
    };
  }
}

export interface IndoorRig extends SceneRig {
  readonly buildings: BuildingIndex;
  readonly interiors: InteriorSystem;
  readonly evidence: RecordingEvidence;
  readonly weapons: { sidearm: boolean; taser: boolean };
}

export interface IndoorRigOptions extends RigOptions {
  /** Report the evidence port (default true). */
  evidence?: boolean;
}

/** The scene stack with a real `InteriorSystem`, a `BuildingIndex`, a recording evidence port and the nav port set. */
export async function makeIndoorRig(options: IndoorRigOptions = {}): Promise<IndoorRig> {
  const parts: { buildings?: BuildingIndex; interiors?: InteriorSystem; evidence?: RecordingEvidence } = {};
  const weapons = { sidearm: true, taser: true };
  const r = await makeRig({
    ...options,
    deps: (h) => {
      const buildings = new BuildingIndex(h.city);
      const interiors = new InteriorSystem({
        seed: h.seed,
        city: h.city,
        physics: h.physics,
        bus: h.bus,
        rng: createRng(h.seed).stream('interior'),
        buildings,
        occupants: NO_OCCUPANTS,
        now: () => GAME0 + h.sim * 30,
        kit: () => ({ carried: () => 1 }),
      });
      const evidence = new RecordingEvidence();
      Object.assign(parts, { buildings, interiors, evidence });
      return { buildings, interiors, ...(options.evidence === false ? {} : { evidence }), weaponsAvailable: () => weapons };
    },
  });
  const { buildings, interiors, evidence } = parts as Required<typeof parts>;
  r.npc.setIndoorNav(interiors.navPort());
  return Object.assign(r, { buildings, interiors, evidence, weapons });
}

/**
 * Creates calls of `typeId` at the door of `kind` buildings until one binds to a building with a matching kind
 * (others are cancelled); the player is not assigned. Returns the call id and the runtime.
 */
export function spawnBound(
  r: IndoorRig,
  typeId: string,
  kinds: readonly BuildingKind[],
  pred: (rt: ScenarioRuntime) => boolean = () => true,
  variants: Parameters<SceneRig['scene']['spawnCall']>[3] = [],
  maxCalls = 600,
): { id: number; rt: ScenarioRuntime } {
  const list = cityBuildings(r.buildings, 12).filter((b) => b.kind !== null && kinds.includes(b.kind));
  for (let n = 0; n < maxCalls; n++) {
    const b = list[n % list.length];
    if (!b) break;
    const id = r.scene.spawnCall(typeId, at(r.sim), { x: b.door.x, z: b.door.z }, variants);
    if (id === 0) break;
    const rt = r.scene.runtime(id);
    if (rt && rt.buildingId >= 0 && pred(rt)) return { id, rt };
    r.cad.closeCall(id, 'cancelled', at(r.sim));
  }
  throw new Error(`No bound ${typeId} scenario`);
}

/** Assigns the player to call `id` and walks them next to the anchor so the scene materializes. */
export function materialize(r: IndoorRig, id: number, seconds = 1): ScenarioRuntime {
  const rt = r.scene.runtime(id);
  if (!rt) throw new Error('No scenario');
  r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
  r.player.x = rt.scenario.anchor.x - 30;
  r.player.z = rt.scenario.anchor.z;
  run(r, seconds);
  return rt;
}

export { step, run };
