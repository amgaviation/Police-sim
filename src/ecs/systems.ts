import { Not, query } from 'bitecs';
import { PhysicsBody, PrevTransform, Transform, Velocity, copyTransformSlot } from './components';
import type { GameWorld } from './world';

/** A unit of simulation work, run once per fixed step. */
export interface System {
  readonly name: string;
  run(world: GameWorld, dt: number): void;
}

interface Entry {
  system: System;
  order: number;
  seq: number;
  enabled: boolean;
}

/**
 * Ordered collection of systems. Lower `order` runs first; equal orders keep registration order.
 * Per-system run time in milliseconds is recorded for the perf overlay.
 */
export class SystemRegistry {
  private readonly entries = new Map<string, Entry>();
  private sorted: Entry[] = [];
  private seq = 0;
  private readonly timingsMs = new Map<string, number>();

  /** Registers `system`; a system with the same name replaces the previous one. */
  register(system: System, order?: number): void {
    const prev = this.entries.get(system.name);
    const entry: Entry = {
      system,
      order: order ?? prev?.order ?? this.seq,
      seq: this.seq++,
      enabled: prev?.enabled ?? true,
    };
    this.entries.set(system.name, entry);
    this.resort();
  }

  /** Removes a system by name; returns whether one was registered. */
  unregister(name: string): boolean {
    const removed = this.entries.delete(name);
    if (removed) {
      this.timingsMs.delete(name);
      this.resort();
    }
    return removed;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  isEnabled(name: string): boolean {
    return this.entries.get(name)?.enabled ?? false;
  }

  enable(name: string): void {
    this.setEnabled(name, true);
  }

  disable(name: string): void {
    this.setEnabled(name, false);
  }

  setEnabled(name: string, enabled: boolean): void {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown system "${name}"`);
    entry.enabled = enabled;
    if (!enabled) this.timingsMs.set(name, 0);
  }

  /** Registered systems in execution order. */
  get systems(): readonly System[] {
    return this.sorted.map((e) => e.system);
  }

  /** Last measured run time per system, in milliseconds (0 while disabled). */
  get timings(): ReadonlyMap<string, number> {
    return this.timingsMs;
  }

  /** Runs every enabled system in order, recording each one's duration. */
  runAll(world: GameWorld, dt: number): void {
    for (const entry of this.sorted) {
      if (!entry.enabled) continue;
      const start = performance.now();
      entry.system.run(world, dt);
      this.timingsMs.set(entry.system.name, performance.now() - start);
    }
  }

  private resort(): void {
    this.sorted = [...this.entries.values()].sort((a, b) => a.order - b.order || a.seq - b.seq);
  }
}

/** Snapshots `Transform` into `PrevTransform`; run first in each fixed step. */
export const copyPrevTransform: System = {
  name: 'copyPrevTransform',
  run(world) {
    for (const eid of query(world, [Transform])) copyTransformSlot(Transform, PrevTransform, eid);
  },
};

/** Euler-integrates `Velocity` into `Transform` for entities not owned by physics. */
export const integrateVelocity: System = {
  name: 'integrateVelocity',
  run(world, dt) {
    for (const eid of query(world, [Transform, Velocity, Not(PhysicsBody)])) {
      Transform.x[eid] = (Transform.x[eid] ?? 0) + (Velocity.x[eid] ?? 0) * dt;
      Transform.y[eid] = (Transform.y[eid] ?? 0) + (Velocity.y[eid] ?? 0) * dt;
      Transform.z[eid] = (Transform.z[eid] ?? 0) + (Velocity.z[eid] ?? 0) * dt;
    }
  },
};

/** Built-in systems in their intended execution order. */
export const builtinSystems: readonly System[] = [copyPrevTransform, integrateVelocity];
