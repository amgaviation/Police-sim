import type { CadTime } from '../cad/types';
import { ACTOR_STATE, type ActorInfo } from '../npc/types';
import { BODY } from '../render/people/pose';
import { FORCE_CONFIG } from './data';
import './events';
import { firearmShot, isPregnant, lessLethalShot, meleeApply, riskFactors, taserShot, type ShotContext } from './models';
import { defaultForceSave, type ForceSave } from './save';
import { FORCE_TOOLS, type ForceConfig, type ForceDeps, type ForceHud, type ForceOfficer, type ForceRequest, type ForceToolId, type Resistance, type ToolDef } from './types';

/** Intoxication level (0..1) from which a target counts as impaired (OC spray works less well). */
export const IMPAIRED_LEVEL = 0.25;
/** Behaviour profiles that count as impaired / in crisis. */
const IMPAIRED_PROFILES: readonly string[] = ['subjectCrisis', 'subjectSuicidal', 'subjectIntoxicated'];
/** Seconds after the last TASER cycle on a person after which the cycle counter restarts. */
const CYCLE_RESET_S = 120;
/** Display radius for the firearm presence event. */
const DISPLAY_RANGE_M = 15;
/** A fellow officer must be this close to a restrained subject to start a misconduct episode. */
const FELLOW_NEAR_M = 3;
/** `fellowTest` reach. */
const FELLOW_TEST_M = 10;
/** Fellow checks per second. */
const FELLOW_CHECK_HZ = 4;
const MAX_QUEUE = 64;

type ToolKey = Exclude<ForceToolId, 'none'>;

interface Attached {
  personId: number;
  actorId: number;
  sinceSim: number;
}

interface Episode {
  personId: number;
  actorId: number;
  callId: number;
  officer: string;
  nextSim: number;
  strikes: number;
  firstSeq: number;
}

interface CycleCount {
  count: number;
  last: number;
}

function newActorInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function isToolId(v: string): v is ForceToolId {
  return (FORCE_TOOLS as readonly string[]).includes(v);
}

function lerp(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/**
 * Officer tool selection, force application and fellow-officer misconduct (Phase 5 design 6.3). Fixed-step system
 * (order -685); every random draw comes from the injected `force` stream. Requests are queued and applied at the
 * start of the next `step`.
 */
export class ForceSystem {
  private readonly deps: ForceDeps;
  private readonly cfg: ForceConfig;
  private readonly defs: Partial<Record<ToolKey, ToolDef>> = {};
  private readonly coneCos: Partial<Record<ToolKey, number>> = {};
  private readonly armoryTools: ToolKey[] = [];
  private readonly armoryItems: string[] = [];
  private readonly queue: ForceRequest[] = [];
  private readonly cycles = new Map<number, CycleCount>();
  private readonly violent = new Set<number>();
  private readonly rolled = new Set<number>();
  private readonly hudObj: ForceHud = { tool: 'none', label: 'Hands free', ammo: '', attached: false, cycle: 0, episode: null };
  private readonly ids: number[] = [];
  private readonly scan = newActorInfo();
  private readonly target = newActorInfo();
  private readonly ctx: ShotContext & { cold: boolean } = { distance: 0, officerMoving: false, officerCrouched: false, targetRunning: false, cold: false };
  private targetDist = 0;
  private toolId: ForceToolId = 'none';
  private seq = 0;
  private cartridges: number;
  private rounds: { firearm: number; lessLethal: number; ocSpray: number };
  private attached: Attached | null = null;
  private episode: Episode | null = null;
  private seenMask = 0;
  private rev = 0;

  constructor(deps: ForceDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? FORCE_CONFIG;
    for (const def of this.cfg.tools) {
      this.defs[def.id] = def;
      this.coneCos[def.id] = Math.cos((def.coneDeg / 2) * (Math.PI / 180));
      if (def.armory !== null) {
        this.armoryTools.push(def.id);
        this.armoryItems.push(def.armory);
      }
    }
    const fresh = defaultForceSave(deps.rng.state(), this.cfg);
    this.cartridges = fresh.cartridges;
    this.rounds = fresh.rounds;
    this.refreshHud();
  }

  /** The selected tool. */
  get tool(): ForceToolId {
    return this.toolId;
  }

  /** HUD feed (one reused object, updated when `revision` changes). */
  get hud(): ForceHud {
    return this.hudObj;
  }

  /** Increments whenever a HUD field changes. */
  get revision(): number {
    return this.rev;
  }

  /** Queues a request for the next `step`. */
  request(r: ForceRequest): void {
    if (this.queue.length < MAX_QUEUE) this.queue.push(r);
  }

  /** Fixed step (order -685). */
  step(dt: number, t: CadTime, officer: ForceOfficer): void {
    this.refillAmmo();
    for (let i = 0; i < this.queue.length; i++) {
      const r = this.queue[i];
      if (r) this.handle(r, t, officer);
    }
    this.queue.length = 0;
    this.checkHeld(officer);
    if (this.attached !== null && t.sim - this.attached.sinceSim > this.cfg.taser.attachMaxS) {
      this.attached = null;
      this.refreshHud();
    }
    if (this.violent.size > 0 && this.episode === null && Math.floor(t.sim * FELLOW_CHECK_HZ) !== Math.floor((t.sim - dt) * FELLOW_CHECK_HZ)) {
      this.fellowCheck(t, officer);
    }
    if (this.episode !== null) this.stepEpisode(t, officer);
  }

  serialize(): ForceSave {
    const attached = this.attached;
    const ep = this.episode;
    const cycles: [number, number, number][] = [];
    for (const [pid, c] of this.cycles) cycles.push([pid, c.count, c.last]);
    const seen: string[] = [];
    for (let i = 0; i < this.armoryTools.length; i++) if ((this.seenMask & (1 << i)) !== 0) seen.push(this.armoryTools[i] ?? '');
    return {
      version: 1,
      rng: this.deps.rng.state(),
      tool: this.toolId,
      seq: this.seq,
      cartridges: this.cartridges,
      rounds: { ...this.rounds },
      attached: attached ? { ...attached } : null,
      cycles,
      violent: [...this.violent],
      rolled: [...this.rolled],
      episode: ep ? { ...ep } : null,
      armorySeen: seen,
      queue: this.queue.map((r) => ({ ...r })),
    };
  }

  restore(s: ForceSave): void {
    this.deps.rng.restore(s.rng);
    this.toolId = isToolId(s.tool) ? s.tool : 'none';
    this.seq = Math.max(0, s.seq);
    this.cartridges = Math.max(0, s.cartridges);
    this.rounds = { firearm: Math.max(0, s.rounds.firearm), lessLethal: Math.max(0, s.rounds.lessLethal), ocSpray: Math.max(0, s.rounds.ocSpray) };
    this.attached = s.attached ? { ...s.attached } : null;
    this.cycles.clear();
    for (const [pid, count, last] of s.cycles) this.cycles.set(pid, { count, last });
    this.violent.clear();
    for (const p of s.violent) this.violent.add(p);
    this.rolled.clear();
    for (const p of s.rolled) this.rolled.add(p);
    this.episode = s.episode ? { ...s.episode } : null;
    this.seenMask = 0;
    for (const name of s.armorySeen) {
      const i = this.armoryTools.indexOf(name as ToolKey);
      if (i >= 0) this.seenMask |= 1 << i;
    }
    this.queue.length = 0;
    for (const r of s.queue) this.queue.push({ ...r });
    this.refreshHud();
  }

  dispose(): void {
    this.queue.length = 0;
    this.cycles.clear();
    this.violent.clear();
    this.rolled.clear();
    this.attached = null;
    this.episode = null;
  }

  // --- Requests ----------------------------------------------------------------------------

  private handle(r: ForceRequest, t: CadTime, o: ForceOfficer): void {
    switch (r.kind) {
      case 'cycleTool':
        this.cycleTool(t, o);
        break;
      case 'selectTool':
        this.selectTool(r.tool, t, o);
        break;
      case 'apply':
        this.apply(r.dirX, r.dirZ, t, o);
        break;
      case 'intervene':
        this.intervene(t, o);
        break;
      case 'fellowTest':
        this.fellowTest(t, o);
        break;
    }
  }

  private flash(text: string): void {
    this.deps.bus.emit('force:flash', { text });
  }

  private def(id: ForceToolId): ToolDef | undefined {
    return id === 'none' ? undefined : this.defs[id];
  }

  /** Can `id` be drawn now (armory, ammo, K9 on scene)? */
  private canSelect(id: ForceToolId, o: ForceOfficer): boolean {
    switch (id) {
      case 'none':
      case 'hands':
        return true;
      case 'ocSpray':
        return this.armoryHas('ocSpray') && this.rounds.ocSpray > 0;
      case 'baton':
        return this.armoryHas('baton');
      case 'taser':
        return this.armoryHas('taser') && (this.cartridges > 0 || this.attached !== null);
      case 'lessLethal':
        return this.armoryHas('lessLethal') && this.rounds.lessLethal > 0;
      case 'firearm':
        return this.armoryHas('firearm') && this.rounds.firearm > 0;
      case 'k9':
        return this.deps.scene.serviceArrived(o.callId, 'k9');
    }
  }

  /** Is the armory item of tool `id` signed out to the officer (always true for tools without one)? */
  private armoryHas(id: ToolKey): boolean {
    const item = this.defs[id]?.armory;
    return item === null || item === undefined ? true : this.deps.armoryHas(item);
  }

  private cycleTool(t: CadTime, o: ForceOfficer): void {
    if (!o.onFoot) {
      this.flash('Exit the vehicle to draw a weapon');
      return;
    }
    const start = FORCE_TOOLS.indexOf(this.toolId);
    for (let k = 1; k <= FORCE_TOOLS.length; k++) {
      const next = FORCE_TOOLS[(start + k) % FORCE_TOOLS.length];
      if (next !== undefined && this.canSelect(next, o)) {
        this.setTool(next, t, o);
        return;
      }
    }
  }

  private selectTool(id: ForceToolId, t: CadTime, o: ForceOfficer): void {
    if (id === this.toolId) return;
    if (id !== 'none' && !o.onFoot) {
      this.flash('Exit the vehicle to draw a weapon');
      return;
    }
    if (!this.canSelect(id, o)) {
      this.flash(`${this.def(id)?.label ?? id} unavailable`);
      return;
    }
    this.setTool(id, t, o);
  }

  private setTool(id: ForceToolId, t: CadTime, o: ForceOfficer): void {
    this.toolId = id;
    this.deps.scene.setWeapon(id === 'firearm' ? 'sidearm' : id === 'taser' || id === 'lessLethal' ? 'taser' : 'none');
    this.deps.bus.emit('force:tool', { tool: id });
    this.refreshHud();
    if (id === 'firearm') this.firearmDisplay(t, o);
  }

  /** The legal "display of a firearm" event: drawn with an actor within 15 m (no effect). */
  private firearmDisplay(t: CadTime, o: ForceOfficer): void {
    const id = this.findTarget(o, 0, DISPLAY_RANGE_M, 0, 0, -1);
    if (id <= 0) return;
    const info = this.target;
    this.deps.bus.emit('force:applied', {
      seq: ++this.seq, tool: 'firearmDisplay', level: 'presence', personId: info.personId, actorId: id, callId: info.callId,
      resistance: this.deps.npc.resistance(id), hit: false, injury: 0, fatal: false, cycle: 0, riskFactors: [], distance: this.targetDist,
      restrained: info.cuffed, sim: t.sim,
    });
  }

  /** Deselects the tool when it can no longer be held (off foot, returned to the armory, K9 gone). */
  private checkHeld(o: ForceOfficer): void {
    const id = this.toolId;
    if (id === 'none') return;
    let reason = '';
    if (!o.onFoot) reason = '-';
    else if (id === 'k9') {
      if (!this.deps.scene.serviceArrived(o.callId, 'k9')) reason = 'K9 unit is not on scene';
    } else if (id !== 'hands' && !this.armoryHas(id)) reason = `${this.defs[id]?.label ?? id} returned to the armory`;
    if (reason === '') return;
    this.toolId = 'none';
    this.deps.scene.setWeapon('none');
    this.deps.bus.emit('force:tool', { tool: 'none' });
    this.refreshHud();
    if (reason !== '-') this.flash(reason);
  }

  /** Ammo refills to full when an armory item goes from returned to signed out. */
  private refillAmmo(): void {
    for (let i = 0; i < this.armoryItems.length; i++) {
      const has = this.deps.armoryHas(this.armoryItems[i] ?? '');
      const bit = 1 << i;
      const was = (this.seenMask & bit) !== 0;
      if (has === was) continue;
      this.seenMask = has ? this.seenMask | bit : this.seenMask & ~bit;
      if (!has) continue;
      const tool = this.armoryTools[i];
      const def = tool ? this.defs[tool] : undefined;
      if (tool === 'taser') {
        this.cartridges = this.cfg.taser.cartridges;
        this.attached = null;
      } else if (tool === 'firearm') this.rounds.firearm = def?.rounds ?? this.rounds.firearm;
      else if (tool === 'lessLethal') this.rounds.lessLethal = def?.rounds ?? this.rounds.lessLethal;
      else if (tool === 'ocSpray') this.rounds.ocSpray = def?.uses ?? this.rounds.ocSpray;
      else continue;
      this.refreshHud();
    }
  }

  // --- Targeting ---------------------------------------------------------------------------

  /**
   * The nearest visible human actor in the officer's building within `[minD, maxD]` metres and inside the cone around
   * `(hx, hz)` (`coneCos` -1 = any direction), the same search as the scene's `findActor`. Fills `this.target` and
   * `this.targetDist`; returns the actor id, 0 when none.
   */
  private findTarget(o: ForceOfficer, minD: number, maxD: number, hx: number, hz: number, coneCos: number): number {
    const { npc } = this.deps;
    const ids = npc.actorIds(this.ids);
    let best = 0;
    let bestD = maxD;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? 0;
      const info = npc.actor(id, this.scan);
      if (!info || info.hidden || info.dead === true || info.body !== BODY.human || (info.building ?? -1) !== o.building) continue;
      const dx = info.x - o.x;
      const dz = info.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || d < minD) continue;
      if (coneCos > -1 && d > 1e-6 && (dx * hx + dz * hz) / d < coneCos) continue;
      if (this.deceased(info.personId)) continue;
      best = id;
      bestD = d;
    }
    if (best > 0 && npc.actor(best, this.target)) this.targetDist = bestD;
    else best = 0;
    return best;
  }

  /** A dead person is no target (the body stays in the actor list). Only asked for a candidate that is already in range. */
  private deceased(personId: number): boolean {
    return personId >= 0 && this.deps.people.state(personId).deceased;
  }

  /** The actor the TASER probes are attached to, when it is still in reach and in the cone; fills `this.target`. */
  private reachAttached(o: ForceOfficer, hx: number, hz: number, coneCos: number): number {
    const att = this.attached;
    if (!att) return 0;
    const info = this.deps.npc.actor(att.actorId, this.target);
    if (!info || info.hidden || info.dead === true || (info.building ?? -1) !== o.building || info.personId !== att.personId || this.deceased(info.personId)) return 0;
    const dx = info.x - o.x;
    const dz = info.z - o.z;
    const d = Math.hypot(dx, dz);
    if (d > this.cfg.taser.reattachRangeM) return 0;
    if (d > 1e-6 && (dx * hx + dz * hz) / d < coneCos) return 0;
    this.targetDist = d;
    return att.actorId;
  }

  // --- Apply -------------------------------------------------------------------------------

  private apply(dirX: number, dirZ: number, t: CadTime, o: ForceOfficer): void {
    const tool = this.toolId;
    if (tool === 'none' || !o.onFoot) return;
    const def = this.defs[tool];
    if (!def) return;
    const { npc, people, bus } = this.deps;
    const cfg = this.cfg;
    const usesAmmo = tool === 'taser' || tool === 'lessLethal' || tool === 'firearm';

    if (tool === 'taser' && this.cartridges <= 0 && this.attached === null) {
      this.flash('TASER: no cartridges');
      return;
    }
    if ((tool === 'lessLethal' && this.rounds.lessLethal <= 0) || (tool === 'firearm' && this.rounds.firearm <= 0)) {
      this.flash(`${def.label}: empty`);
      return;
    }
    if (tool === 'ocSpray' && this.rounds.ocSpray <= 0) {
      this.flash('OC spray: empty');
      return;
    }

    let hx = -Math.sin(o.yaw);
    let hz = -Math.cos(o.yaw);
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-6) {
      hx = dirX / len;
      hz = dirZ / len;
    }
    const coneCos = this.coneCos[tool] ?? 0;

    let id = 0;
    let recycle = false;
    if (tool === 'taser') {
      id = this.reachAttached(o, hx, hz, coneCos);
      recycle = id > 0;
    }
    if (id === 0) id = this.findTarget(o, def.rangeM[0], def.rangeM[1], hx, hz, coneCos);
    if (tool === 'taser' && !recycle && this.cartridges <= 0) {
      this.flash('TASER: no cartridges');
      return;
    }

    if (id === 0) {
      if (!usesAmmo) {
        this.flash('No target in range');
        return;
      }
      if (tool === 'taser') this.cartridges--;
      else if (tool === 'lessLethal') this.rounds.lessLethal--;
      else this.rounds.firearm--;
      this.refreshHud();
      this.flash('Missed');
      return;
    }

    const info = this.target;
    const pid = info.personId;
    const d = this.targetDist;
    // Everything the event records is read before any effect changes the actor.
    const resistance: Resistance = npc.resistance(id);
    const risk = this.risk(info);
    const ctx = this.ctx;
    ctx.distance = d;
    ctx.officerMoving = o.moving;
    ctx.officerCrouched = o.crouched;
    ctx.targetRunning = info.state === ACTOR_STATE.flee;
    const restrained = info.cuffed;
    const callId = info.callId;
    const rng = this.deps.rng;

    let hit: boolean;
    let injury = 0;
    let fatal = false;
    let cycle = 0;
    let text: string;

    switch (tool) {
      case 'taser': {
        const tcfg = cfg.taser;
        if (recycle) {
          npc.taserCycle(id, tcfg.cycleS);
          cycle = this.bumpCycle(pid, t.sim);
          hit = true;
          injury = lerp(def.injury, rng.next());
          text = `TASER: cycle ${cycle}`;
        } else {
          this.cartridges--;
          ctx.cold = this.deps.temperatureC() < tcfg.coldC;
          const shot = taserShot(ctx, tcfg, def.rangeM[1], rng);
          hit = shot.probes > 0;
          if (hit) {
            injury = lerp(def.injury, rng.next());
            cycle = this.bumpCycle(pid, t.sim);
          }
          if (shot.nmi) {
            npc.incapacitate(id, tcfg.cycleS + 3, 'taser');
            this.attached = { personId: pid, actorId: id, sinceSim: t.sim };
            text = `TASER: probes hit (2/2), cycle ${cycle}`;
          } else if (shot.painOnly) {
            if (rng.next() < tcfg.painComply) npc.incapacitate(id, def.incapacitate.seconds, 'taser');
            text = `TASER: ${shot.probes} probe hit, pain only`;
          } else text = 'TASER: missed';
        }
        break;
      }
      case 'firearm': {
        this.rounds.firearm--;
        const shot = firearmShot(ctx, cfg.firearm, rng, cfg.modifiers);
        hit = shot.hit;
        injury = shot.injury;
        fatal = shot.fatal;
        if (hit) npc.wound(id, injury, fatal);
        text = hit ? `${def.label}: hit (${shot.zone})${fatal ? ', subject is not moving' : ''}` : `${def.label}: missed`;
        break;
      }
      case 'lessLethal': {
        this.rounds.lessLethal--;
        const shot = lessLethalShot(ctx, def, cfg.lessLethal, rng, cfg.modifiers, cfg.firearm.zoneWeights);
        hit = shot.hit;
        injury = shot.injury;
        fatal = shot.fatal;
        if (hit) {
          if (fatal) npc.wound(id, injury, true);
          else if (rng.next() < def.incapacitate.chance) npc.incapacitate(id, def.incapacitate.seconds, 'beanbag');
        }
        text = hit ? `${def.label}: hit (${shot.zone})${fatal ? ', subject is not moving' : ''}` : `${def.label}: missed`;
        break;
      }
      default: {
        if (tool === 'ocSpray') this.rounds.ocSpray--;
        const res = meleeApply(def, this.impaired(info), rng);
        hit = res.hit;
        injury = res.injury;
        if (res.incapacitated) npc.incapacitate(id, def.incapacitate.seconds, tool === 'hands' ? 'strike' : tool === 'ocSpray' ? 'oc' : tool);
        text = !hit ? `${def.label}: missed` : res.incapacitated ? `${def.label}: effective` : `${def.label}: hit`;
        break;
      }
    }

    if (pid >= 0 && injury > 0) {
      people.setInjured(pid, Math.max(people.state(pid).injured, injury));
      if (fatal) people.setDeceased(pid);
    }
    if (pid >= 0 && (resistance === 'assaultive' || resistance === 'lethal')) this.violent.add(pid);

    bus.emit('force:applied', {
      seq: ++this.seq, tool, level: def.level, personId: pid, actorId: id, callId, resistance, hit, injury, fatal, cycle, riskFactors: risk,
      distance: d, restrained, sim: t.sim,
    });
    this.refreshHud();
    this.flash(text);
  }

  private risk(info: ActorInfo): string[] {
    const pid = info.personId;
    let elderly = false;
    let juvenile = false;
    let pregnant = false;
    if (pid >= 0) {
      const ident = this.deps.people.identity(pid);
      elderly = ident.elderly;
      juvenile = ident.juvenile;
      pregnant = isPregnant(this.deps.seed, pid, ident.record.sex, ident.age, this.cfg.risk);
    }
    return riskFactors({
      elderly, juvenile, pregnant,
      elevated: this.deps.elevatedAt(info.building ?? -1, info.x, info.z),
      running: info.state === ACTOR_STATE.flee,
      restrained: info.cuffed,
    });
  }

  private impaired(info: ActorInfo): boolean {
    if (IMPAIRED_PROFILES.includes(info.profile)) return true;
    return info.personId >= 0 && this.deps.people.intoxication(info.personId).level >= IMPAIRED_LEVEL;
  }

  /** Next TASER cycle number of person `pid`; the counter restarts 120 s after the last cycle. */
  private bumpCycle(pid: number, sim: number): number {
    for (const [p, c] of this.cycles) if (p !== pid && sim - c.last > CYCLE_RESET_S) this.cycles.delete(p);
    const c = this.cycles.get(pid);
    if (c && sim - c.last <= CYCLE_RESET_S) {
      c.count++;
      c.last = sim;
      return c.count;
    }
    this.cycles.set(pid, { count: 1, last: sim });
    return 1;
  }

  // --- Fellow officer ----------------------------------------------------------------------

  /** 4 Hz: rolls once per restrained, previously violent subject near a fellow officer. */
  private fellowCheck(t: CadTime, o: ForceOfficer): void {
    const fellows = this.deps.fellows();
    if (fellows.length === 0 || o.callId === 0) return;
    const { npc, rng } = this.deps;
    const ids = npc.actorIds(this.ids);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? 0;
      const info = npc.actor(id, this.scan);
      if (!info || info.callId !== o.callId || !info.cuffed || info.hidden || info.personId < 0) continue;
      if (!this.violent.has(info.personId) || this.rolled.has(info.personId)) continue;
      const name = this.nearestFellow(info.x, info.z, info.building ?? -1, FELLOW_NEAR_M);
      if (name === null) continue;
      this.rolled.add(info.personId);
      const f = this.cfg.fellow;
      const u = rng.next();
      if (u < f.chance) {
        // The conditional uniform u / chance also picks the delay: one draw per person.
        this.startEpisode(info, id, name, t.sim + lerp(f.delayS, u / f.chance));
        return;
      }
    }
  }

  private nearestFellow(x: number, z: number, building: number, maxD: number): string | null {
    const fellows = this.deps.fellows();
    let best: string | null = null;
    let bestD = maxD;
    for (let i = 0; i < fellows.length; i++) {
      const f = fellows[i];
      if (!f || f.building !== building) continue;
      const d = Math.hypot(f.x - x, f.z - z);
      if (d <= bestD) {
        best = f.name;
        bestD = d;
      }
    }
    return best;
  }

  private startEpisode(info: ActorInfo, actorId: number, officer: string, firstStrikeSim: number): void {
    const firstSeq = this.seq + 1;
    // One seq per possible strike is reserved so the latest strike of an episode is `firstSeq + strikes - 1`.
    this.seq += this.cfg.fellow.maxStrikes;
    this.episode = { personId: info.personId, actorId, callId: info.callId, officer, nextSim: firstStrikeSim, strikes: 0, firstSeq };
    this.refreshHud();
  }

  private stepEpisode(t: CadTime, o: ForceOfficer): void {
    const ep = this.episode;
    if (!ep || t.sim < ep.nextSim) return;
    const f = this.cfg.fellow;
    if (ep.strikes >= f.maxStrikes) {
      this.episode = null;
      this.refreshHud();
      return;
    }
    const { npc, people, bus } = this.deps;
    const info = npc.actor(ep.actorId, this.scan);
    if (!info || !info.cuffed || info.personId !== ep.personId) {
      this.episode = null;
      this.refreshHud();
      return;
    }
    bus.emit('force:other', {
      seq: ep.firstSeq + ep.strikes, officer: ep.officer, level: 'hardHands', personId: ep.personId, actorId: ep.actorId, callId: ep.callId,
      resistance: npc.resistance(ep.actorId), restrained: true, distanceToOfficer: Math.hypot(info.x - o.x, info.z - o.z), injury: f.injury, sim: t.sim,
    });
    people.setInjured(ep.personId, Math.min(1, people.state(ep.personId).injured + f.injury));
    ep.strikes++;
    ep.nextSim = t.sim + f.repeatS;
    this.refreshHud();
    this.flash(`${ep.officer} is striking the restrained subject - press H to intervene`);
  }

  private intervene(t: CadTime, o: ForceOfficer): void {
    const ep = this.episode;
    const info = ep && ep.strikes > 0 ? this.deps.npc.actor(ep.actorId, this.scan) : null;
    if (!ep || !info) {
      this.flash('Nothing to intervene in');
      return;
    }
    if (Math.hypot(info.x - o.x, info.z - o.z) > this.cfg.fellow.interveneRadiusM) {
      this.flash('Too far to intervene');
      return;
    }
    this.episode = null;
    this.deps.bus.emit('force:intervened', { otherSeq: ep.firstSeq + ep.strikes - 1, personId: ep.personId, callId: ep.callId, sim: t.sim });
    this.refreshHud();
    this.flash('You intervened');
  }

  /** Console / smoke: a fellow officer starts striking the nearest restrained actor within 10 m at once. */
  private fellowTest(t: CadTime, o: ForceOfficer): void {
    if (this.episode !== null) {
      this.flash('A fellow officer episode is already running');
      return;
    }
    const { npc } = this.deps;
    const ids = npc.actorIds(this.ids);
    let best = 0;
    let bestD = FELLOW_TEST_M;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? 0;
      const info = npc.actor(id, this.scan);
      if (!info || !info.cuffed || info.hidden || info.personId < 0 || info.body !== BODY.human || (info.building ?? -1) !== o.building) continue;
      const d = Math.hypot(info.x - o.x, info.z - o.z);
      if (d <= bestD) {
        best = id;
        bestD = d;
      }
    }
    if (best <= 0 || !npc.actor(best, this.target)) {
      this.flash('No restrained subject nearby');
      return;
    }
    const fellows = this.deps.fellows();
    const name = this.nearestFellow(this.target.x, this.target.z, this.target.building ?? -1, Infinity) ?? fellows[0]?.name ?? 'Partner';
    this.rolled.add(this.target.personId);
    this.startEpisode(this.target, best, name, t.sim);
  }

  // --- HUD ---------------------------------------------------------------------------------

  private ammoText(): string {
    switch (this.toolId) {
      case 'taser':
        return `${this.cartridges}/${this.cfg.taser.cartridges}`;
      case 'firearm':
        return `${this.rounds.firearm}/${this.defs.firearm?.rounds ?? 0}`;
      case 'lessLethal':
        return `${this.rounds.lessLethal}/${this.defs.lessLethal?.rounds ?? 0}`;
      case 'ocSpray':
        return `${this.rounds.ocSpray}/${this.defs.ocSpray?.uses ?? 0}`;
      default:
        return '';
    }
  }

  private refreshHud(): void {
    const h = this.hudObj;
    const label = this.toolId === 'none' ? 'Hands free' : (this.defs[this.toolId]?.label ?? this.toolId);
    const ammo = this.ammoText();
    const att = this.attached !== null;
    const cycle = this.attached ? (this.cycles.get(this.attached.personId)?.count ?? 0) : 0;
    const ep = this.episode && this.episode.strikes > 0 ? this.episode.officer : null;
    if (h.tool === this.toolId && h.label === label && h.ammo === ammo && h.attached === att && h.cycle === cycle && h.episode === ep) return;
    h.tool = this.toolId;
    h.label = label;
    h.ammo = ammo;
    h.attached = att;
    h.cycle = cycle;
    h.episode = ep;
    this.rev++;
  }
}
