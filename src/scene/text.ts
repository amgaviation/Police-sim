/** Small text helpers of the scene module (radio lines, directions). */
import type { Rng } from '../core/rng';

/** "northbound" / "southbound" / "eastbound" / "westbound" for a heading given as yaw (0 = facing -Z, north = -Z). */
export function compass(yaw: number): string {
  const hx = -Math.sin(yaw);
  const hz = -Math.cos(yaw);
  if (Math.abs(hz) >= Math.abs(hx)) return hz < 0 ? 'northbound' : 'southbound';
  return hx > 0 ? 'eastbound' : 'westbound';
}

/** Replaces `{key}` placeholders from `vars` (unknown keys stay as they are). */
export function fill(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, key: string) => (Object.hasOwn(vars, key) ? (vars[key] ?? whole) : whole));
}

/**
 * An `Rng` whose first draws of `next()` are scripted: used to force scenario variants in the debug
 * `scene spawn` command (the scenario builder draws its three variant rolls first). Everything else
 * delegates to the wrapped generator.
 */
export class ScriptedRng implements Rng {
  private i = 0;
  private readonly base: Rng;
  private readonly script: readonly number[];
  constructor(base: Rng, script: readonly number[]) {
    this.base = base;
    this.script = script;
  }
  get seed(): number {
    return this.base.seed;
  }
  next(): number {
    const v = this.script[this.i];
    if (v !== undefined) {
      this.i++;
      this.base.next();
      return v;
    }
    return this.base.next();
  }
  nextInt(min: number, maxInclusive: number): number {
    return this.base.nextInt(min, maxInclusive);
  }
  nextFloat(min: number, max: number): number {
    return this.base.nextFloat(min, max);
  }
  chance(p: number): boolean {
    return this.base.chance(p);
  }
  pick<T>(arr: readonly T[]): T {
    return this.base.pick(arr);
  }
  shuffle<T>(arr: T[]): T[] {
    return this.base.shuffle(arr);
  }
  gaussian(mean?: number, sd?: number): number {
    return this.base.gaussian(mean, sd);
  }
  stream(name: string): Rng {
    return this.base.stream(name);
  }
  state(): ReturnType<Rng['state']> {
    return this.base.state();
  }
  restore(state: Parameters<Rng['restore']>[0]): void {
    this.base.restore(state);
  }
}
