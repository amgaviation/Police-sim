/**
 * RadioSystem (design §9): the player's radio (selected channel, scan), the composer, ambient chatter
 * and the RadioNet, stepped at fixed order -650. Deterministic: draws only from `deps.rng`
 * (`session.rng.stream('radio')`); durations are estimated from word counts.
 */
import { addressAt, locationText } from '../cad/address';
import type { CadState } from '../cad/cadState';
import type { CadTime, RadioMode, UnitRequest } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { RoadGraph } from '../world/roadGraph';
import { ambientInterval, composeAmbient } from './ambient';
import { Composer, type ComposerHost } from './compose';
import { channelDef, PHRASES, RADIO_CONFIG } from './data';
import './events';
import { RadioMenu } from './menu';
import { RadioNet } from './net';
import type { RadioSave } from './save';
import type { ChannelId, QueuedTransmission, Transmission } from './types';

export interface RadioDeps {
  readonly seed: number;
  readonly rng: Rng;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly graph: RoadGraph;
  readonly playerCallsign: string;
  mode(): RadioMode;
}

/** Player 10-20s snap to a road within this distance (m). */
const PLAYER_ADDRESS_RADIUS = 200;

export class RadioSystem {
  readonly menu = new RadioMenu();

  private readonly deps: RadioDeps;
  private readonly net: RadioNet;
  private readonly composer: Composer;
  private ambientNext: Partial<Record<ChannelId, number>> = {};
  private lastToPlayer = -1;
  private px = 0;
  private pz = 0;

  constructor(deps: RadioDeps) {
    this.deps = deps;
    this.net = new RadioNet(deps.bus);
    const host: ComposerHost = {
      net: this.net,
      rng: deps.rng,
      cad: deps.cad,
      seed: deps.seed,
      player: deps.playerCallsign,
      mode: () => deps.mode(),
      playerNear: () => this.playerNear(),
    };
    this.composer = new Composer(host, deps.bus);
    this.net.hooks = {
      onStart: (e) => this.onStart(e),
      onEnd: (e) => this.onEnd(e),
    };
  }

  // --- Fixed step -----------------------------------------------------------------------------

  /** Fixed step (order -650): ends finished transmissions, ambient chatter, starts due ones. */
  step(_dt: number, t: CadTime, player: { x: number; z: number }): void {
    this.px = player.x;
    this.pz = player.z;
    this.ambient(t);
    this.net.step(t);
  }

  /** The player's transmission on the selected channel; its request is acted on when it ends unblocked. */
  playerRequest(request: UnitRequest, via: 'radio' | 'voice' | 'key'): void {
    if (request.kind === 'emergency') {
      this.emergencyButton();
      return;
    }
    this.composer.playerLine(request, via, this.net.selected);
  }

  /** Emergency button: the request goes to dispatch at once (any channel), plus a priority player line. */
  emergencyButton(): void {
    this.deps.bus.emit('unit:request', { callsign: this.deps.playerCallsign, request: { kind: 'emergency' }, via: 'key' });
    this.composer.playerLine({ kind: 'emergency' }, 'key', this.net.selected);
  }

  /** Debug: queues `text` on `channel` from its dispatcher (or `speaker`). */
  say(channel: ChannelId, text: string, speaker?: string): void {
    const def = channelDef(channel);
    const name = speaker ?? def.dispatcher ?? 'Unit';
    this.net.enqueue({
      channel,
      speaker: name,
      speakerKind: speaker === undefined && def.dispatcher !== null ? 'dispatcher' : 'officer',
      text,
      kind: 'console',
      earliest: this.net.now,
    });
  }

  // --- Channels -------------------------------------------------------------------------------

  selectChannel(id: ChannelId): void {
    if (this.net.selected === id) return;
    this.net.selected = id;
    this.emitChannel();
  }

  stepChannel(dir: 1 | -1): void {
    const list = RADIO_CONFIG.channels;
    const i = list.findIndex((c) => c.id === this.net.selected);
    const next = list[(i + dir + list.length) % list.length];
    if (next) this.selectChannel(next.id);
  }

  toggleScan(): void {
    this.net.scanning = !this.net.scanning;
    this.emitChannel();
  }

  get selected(): ChannelId {
    return this.net.selected;
  }

  get scanning(): boolean {
    return this.net.scanning;
  }

  get scanList(): readonly ChannelId[] {
    return this.net.scanList;
  }

  /** The selected channel has a transmission on the air. */
  get busy(): boolean {
    return this.net.isActive(this.net.selected);
  }

  /** The player is keyed up. */
  get transmitting(): boolean {
    for (const tx of this.net.onAir) if (tx.speakerKind === 'player') return true;
    return false;
  }

  get log(): readonly Transmission[] {
    return this.net.log;
  }

  /** Transmissions on the air. */
  get onAir(): readonly Transmission[] {
    return this.net.onAir;
  }

  /** Transmissions waiting to start. */
  get queued(): number {
    return this.net.pending.length;
  }

  isHeld(channel: ChannelId): boolean {
    return this.net.isHeld(channel);
  }

  // --- Persistence ----------------------------------------------------------------------------

  serialize(): RadioSave {
    return {
      version: 1,
      selected: this.net.selected,
      scanning: this.net.scanning,
      scanList: [...this.net.scanList],
      log: this.net.serializeLog(),
      queue: this.net.serializeQueue(),
      nextId: this.net.nextId,
      holds: this.net.heldChannels(),
      ambientNext: { ...this.ambientNext },
      rng: this.deps.rng.state(),
      lastToPlayer: this.lastToPlayer,
      time: { sim: this.net.now, game: this.net.game },
      player: { x: this.px, z: this.pz },
      composer: this.composer.serialize(),
    };
  }

  /** Replaces the radio state (no events); the queue, holds, ambient timers and rng resume exactly. */
  restore(save: RadioSave): void {
    this.net.restore({
      selected: save.selected,
      scanning: save.scanning,
      scanList: save.scanList,
      log: save.log,
      queue: save.queue,
      nextId: save.nextId,
      holds: save.holds,
      now: save.time?.sim ?? 0,
      game: save.time?.game ?? 0,
    });
    this.ambientNext = { ...save.ambientNext };
    this.deps.rng.restore(save.rng);
    this.lastToPlayer = save.lastToPlayer;
    this.px = save.player?.x ?? 0;
    this.pz = save.player?.z ?? 0;
    this.composer.restore(save.composer ?? { pending: [], answered: [], expectLocation: false, answeringLocation: false, pulling: -1 });
    this.menu.close();
  }

  dispose(): void {
    this.composer.dispose();
    this.net.hooks = {};
  }

  // --- Internals ------------------------------------------------------------------------------

  private emitChannel(): void {
    this.deps.bus.emit('radio:channel', { selected: this.net.selected, scanning: this.net.scanning });
  }

  private playerNear(): string {
    const a = addressAt(this.deps.graph, this.px, this.pz, undefined, PLAYER_ADDRESS_RADIUS);
    return a ? locationText(a) : PHRASES.fragments.unknownLocation[this.deps.mode()];
  }

  private ambient(t: CadTime): void {
    const now = t.sim;
    for (const c of RADIO_CONFIG.channels) {
      if (c.ambientPerMin <= 0) continue;
      const next = this.ambientNext[c.id];
      if (next === undefined) {
        this.ambientNext[c.id] = now + ambientInterval(this.deps.rng, c.ambientPerMin);
        continue;
      }
      if (now < next) continue;
      this.ambientNext[c.id] = now + ambientInterval(this.deps.rng, c.ambientPerMin);
      if (this.net.isHeld(c.id)) continue;
      const line = composeAmbient(c, {
        rng: this.deps.rng,
        seed: this.deps.seed,
        graph: this.deps.graph,
        mode: this.deps.mode(),
        clock: this.composer.clock(),
      });
      this.net.enqueue({
        channel: c.id,
        speaker: line.speaker,
        speakerKind: line.speakerKind,
        text: line.text,
        kind: 'ambient',
        earliest: now,
        waitClear: !this.deps.rng.chance(RADIO_CONFIG.doubleKeyChance),
        ambient: true,
      });
    }
  }

  private onStart(e: QueuedTransmission): void {
    if (e.speakerKind === 'dispatcher' && e.to === this.deps.playerCallsign) this.lastToPlayer = e.id;
  }

  private onEnd(e: QueuedTransmission): void {
    if (e.speakerKind !== 'player') return;
    const def = channelDef(e.channel);
    const player = this.deps.playerCallsign;
    if (e.kind === 'locationAnswer') this.composer.locationAnswerEnded(e.blocked);
    if (e.blocked) {
      // The emergency request already went out with the button: never ask to repeat it.
      // Priority on a held channel, or the player would never hear it (the request was lost).
      if (e.kind !== 'playerEmergency') this.composer.dispatcherLine('blocked', player, {}, { channel: e.channel, priority: this.net.isHeld(e.channel) });
      return;
    }
    if (!def.requests) {
      // The emergency request went out with the button; other requests need the dispatch channel.
      if (e.kind !== 'playerEmergency') this.composer.dispatcherLine('wrongChannel', player, { channel: def.label }, { channel: e.channel });
      return;
    }
    if (e.kind === 'repeatRequest') {
      this.repeatLast();
      return;
    }
    const request = e.request;
    if (request === null) return;
    const via = e.via ?? 'radio';
    if (via === 'radio' || via === 'voice') this.composer.expectAnswer(request.kind);
    this.deps.bus.emit('unit:request', { callsign: player, request, via });
  }

  /** Re-queues the last dispatcher transmission to the player (no unit:request). */
  private repeatLast(): void {
    const tx = this.net.log.find((t) => t.id === this.lastToPlayer);
    if (!tx) return;
    this.net.enqueue({
      channel: tx.channel,
      speaker: tx.speaker,
      speakerKind: tx.speakerKind,
      text: tx.text,
      kind: tx.kind,
      earliest: this.net.now + this.composer.replyGap(),
      to: this.deps.playerCallsign,
    });
  }
}
