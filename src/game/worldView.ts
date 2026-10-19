import type * as THREE from 'three';
import type { LightingState } from '../environment/environment';
import type { ShadowQuality } from '../render/renderer';
import { Minimap } from '../ui/hud/minimap';
import type { WorkerClient } from '../workers/workerClient';
import type { City } from '../world/city';
import type { ChunkWorkerMap } from '../world/render/chunkProtocol';
import { ChunkStreamer } from '../world/render/chunkStreamer';
import { SignalHeads } from '../world/render/signalHeads';
import { StreetlightPool } from '../world/render/streetlightPool';

export interface WorldViewOptions {
  /** Chunk meshing worker (owned by the app); null meshes on the main thread. */
  worker: WorkerClient<ChunkWorkerMap> | null;
  shadows: ShadowQuality;
}

/** Pooled streetlight point lights per graphics quality: the shadows setting also sets the lighting budget. */
export function streetlightCount(quality: ShadowQuality): number {
  return quality === 'off' ? 2 : 4;
}

/**
 * Render-side objects of one session's city: streamed chunk meshes, the global signal
 * heads and the streetlight pool (all absent without a scene to draw into), plus the
 * minimap. Render-only; nothing here feeds back into the simulation.
 */
export class WorldView {
  readonly streamer: ChunkStreamer | null;
  readonly signals: SignalHeads | null;
  readonly minimap: Minimap;
  private readonly scene: THREE.Scene | null;
  private readonly city: City;
  private streetlights: StreetlightPool | null;
  private disposed = false;

  constructor(city: City, scene: THREE.Scene | null, hudParent: HTMLElement, options: WorldViewOptions) {
    this.city = city;
    this.scene = scene;
    this.streamer = scene ? new ChunkStreamer(scene, city, { worker: options.worker, shadows: options.shadows !== 'off' }) : null;
    this.signals = scene ? new SignalHeads(scene, city) : null;
    this.streetlights = scene ? new StreetlightPool(scene, city, streetlightCount(options.shadows)) : null;
    this.minimap = new Minimap(hudParent, city);
  }

  /** Point lights in the streetlight pool. */
  get streetlightCount(): number {
    return this.streetlights?.lights.length ?? 0;
  }

  /** Chunk shadows follow the setting; a different streetlight budget rebuilds the pool (one shader recompile). */
  setShadows(quality: ShadowQuality): void {
    this.streamer?.setShadows(quality !== 'off');
    const count = streetlightCount(quality);
    if (!this.scene || !this.streetlights || this.streetlights.lights.length === count) return;
    this.streetlights.dispose();
    this.streetlights = new StreetlightPool(this.scene, this.city, count);
  }

  /** Indoors the city chunks are not drawn (the interior is a closed box below the street). */
  setIndoor(on: boolean): void {
    if (this.streamer) this.streamer.root.visible = !on;
  }

  /** Per frame, after the camera and the environment renderer: streaming, signal lamps, streetlights. */
  update(cameraX: number, cameraZ: number, viewDistance: number, simTime: number, lighting: Readonly<LightingState>): void {
    if (this.disposed) return;
    this.streamer?.setLighting(lighting.nightFactor, lighting.streetlightsOn);
    this.streamer?.update(cameraX, cameraZ, viewDistance);
    this.signals?.update(simTime, cameraX, cameraZ);
    this.streetlights?.update(cameraX, cameraZ, lighting.streetlightsOn);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.streamer?.dispose();
    this.signals?.dispose();
    this.streetlights?.dispose();
    this.minimap.dispose();
  }
}
