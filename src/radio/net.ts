/**
 * RadioNet (design §9.2): channel selection and scanning, the transmission queue, start/end in sim
 * time, stepped-on detection, emergency holds and the log. Deterministic; steps allocate nothing
 * unless a transmission starts or ends.
 */
import { clockOf } from '../cad/commands';
import type { CadTime, RequestVia, UnitRequest } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { RADIO_CONFIG, type RadioConfig } from './data';
import './events';
import { toSpoken, wordCount } from './spoken';
import type { ChannelId, QueuedTransmission, SpeakerKind, Transmission } from './types';

/** Pending transmissions kept at most (oldest ambient dropped first). */
export const QUEUE_CAP = 32;

export interface NewTransmission {
  readonly channel: ChannelId;
  readonly speaker: string;
  readonly speakerKind: SpeakerKind;
  readonly text: string;
  /**
   * Text the air time is estimated from, when `text` depends on a presentation setting (the radio
   * language): the ten-code wording, so timing never depends on the setting. Default `text`.
   */
  readonly durationText?: string;
  /** Air time (s), overriding the estimate (a repeat keeps the original's). */
  readonly duration?: number;
  readonly kind: string;
  readonly earliest: number;
  readonly priority?: boolean;
  readonly waitClear?: boolean;
  readonly follows?: number;
  readonly gap?: number;
  readonly to?: string;
  readonly ambient?: boolean;
  readonly request?: UnitRequest | null;
  readonly via?: RequestVia | null;
}

export interface NetHooks {
  /** A transmission went on the air (after radio:start / radio:blocked). */
  onStart?(entry: QueuedTransmission, tx: Transmission): void;
  /** A transmission ended (after radio:end). */
  onEnd?(entry: QueuedTransmission, tx: Transmission): void;
}

export class RadioNet {
  readonly config: RadioConfig;
  hooks: NetHooks = {};
  /** Sim / game time of the last step. */
  now = 0;
  game = 0;
  nextId = 1;
  selected: ChannelId;
  scanning = false;
  scanList: ChannelId[];

  private readonly bus: EventBus<EventMap>;
  private queue: QueuedTransmission[] = [];
  private active: QueuedTransmission[] = [];
  private activeTx: Transmission[] = [];
  private logList: Transmission[] = [];
  private readonly holds = new Set<ChannelId>();

  constructor(bus: EventBus<EventMap>, config: RadioConfig = RADIO_CONFIG) {
    this.bus = bus;
    this.config = config;
    this.selected = config.defaultSelected;
    this.scanList = [...config.defaultScan];
  }

  get log(): readonly Transmission[] {
    return this.logList;
  }

  /** Pending (not yet started) transmissions, in queue order. */
  get pending(): readonly QueuedTransmission[] {
    return this.queue;
  }

  /** Transmissions on the air, in start order. */
  get onAir(): readonly Transmission[] {
    return this.activeTx;
  }

  /** keyUpS + words / wordsPerSecond + tailS of the spoken text. */
  estimateDuration(spoken: string): number {
    const c = this.config;
    return c.keyUpS + wordCount(spoken) / c.wordsPerSecond + c.tailS;
  }

  isAudible(channel: ChannelId): boolean {
    return channel === this.selected || (this.scanning && this.scanList.includes(channel));
  }

  isActive(channel: ChannelId): boolean {
    for (const tx of this.activeTx) if (tx.channel === channel) return true;
    return false;
  }

  hold(channel: ChannelId): void {
    this.holds.add(channel);
  }

  release(channel: ChannelId): void {
    this.holds.delete(channel);
  }

  isHeld(channel: ChannelId): boolean {
    return this.holds.has(channel);
  }

  heldChannels(): ChannelId[] {
    return [...this.holds];
  }

  /** Queues a transmission; returns the entry (its id is final). */
  enqueue(t: NewTransmission): QueuedTransmission {
    const spoken = toSpoken(t.text);
    const entry: QueuedTransmission = {
      id: this.nextId++,
      channel: t.channel,
      speaker: t.speaker,
      speakerKind: t.speakerKind,
      text: t.text,
      spoken,
      kind: t.kind,
      priority: t.priority ?? false,
      duration: t.duration ?? this.estimateDuration(t.durationText === undefined ? spoken : toSpoken(t.durationText)),
      earliest: t.earliest,
      waitClear: t.waitClear ?? true,
      follows: t.follows ?? -1,
      gap: t.gap ?? 0,
      to: t.to ?? '',
      ambient: t.ambient ?? false,
      request: t.request ?? null,
      via: t.via ?? null,
      start: -1,
      blocked: false,
      clock: '',
      audible: false,
    };
    if (this.queue.length >= QUEUE_CAP) this.dropOne();
    this.queue.push(entry);
    return entry;
  }

  /** Removes pending entries matching `pred` and, transitively, the replies chained to them. */
  cancel(pred: (e: QueuedTransmission) => boolean): number {
    let removed = 0;
    const ids: number[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const e = this.queue[i] as QueuedTransmission;
      if (pred(e)) {
        ids.push(e.id);
        this.queue.splice(i, 1);
        removed++;
      }
    }
    while (ids.length > 0) {
      const id = ids.pop() as number;
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const e = this.queue[i] as QueuedTransmission;
        if (e.follows === id) {
          ids.push(e.id);
          this.queue.splice(i, 1);
          removed++;
        }
      }
    }
    return removed;
  }

  /** Ends finished transmissions, then starts due ones (priority first, then queue order). */
  step(t: CadTime): void {
    this.now = t.sim;
    this.game = t.game;
    let i = 0;
    while (i < this.active.length) {
      const e = this.active[i] as QueuedTransmission;
      if (this.now >= e.start + e.duration) {
        const tx = this.activeTx[i] as Transmission;
        this.active.splice(i, 1);
        this.activeTx.splice(i, 1);
        this.bus.emit('radio:end', { id: e.id, blocked: e.blocked });
        this.resolveFollowers(e.id, e.start + e.duration);
        this.hooks.onEnd?.(e, tx);
      } else {
        i++;
      }
    }
    if (this.queue.length === 0) return;
    this.startPass(true, false);
    // The player keys up first when a channel clears (their radio holds the press), then the others.
    this.startPass(false, true);
    this.startPass(false, false);
  }

  // --- Persistence ----------------------------------------------------------------------------

  /** Pending and on-air entries (on-air ones have `start >= 0`), deep copies. */
  serializeQueue(): QueuedTransmission[] {
    return structuredClone([...this.active, ...this.queue]);
  }

  serializeLog(): Transmission[] {
    return structuredClone(this.logList);
  }

  restore(s: {
    selected: ChannelId;
    scanning: boolean;
    scanList: readonly ChannelId[];
    log: readonly Transmission[];
    queue: readonly QueuedTransmission[];
    nextId: number;
    holds: readonly ChannelId[];
    now: number;
    game: number;
  }): void {
    this.selected = s.selected;
    this.scanning = s.scanning;
    this.scanList = [...s.scanList];
    this.logList = structuredClone([...s.log]);
    while (this.logList.length > this.config.logSize) this.logList.shift();
    this.queue = [];
    this.active = [];
    this.activeTx = [];
    let next = s.nextId;
    for (const tx of this.logList) next = Math.max(next, tx.id + 1);
    for (const raw of s.queue) {
      const e = structuredClone(raw);
      next = Math.max(next, e.id + 1);
      if (e.start < 0) {
        this.queue.push(e);
        continue;
      }
      const logged = this.logList.find((tx) => tx.id === e.id);
      const tx = logged ?? this.transmissionOf(e);
      tx.blocked = e.blocked;
      this.active.push(e);
      this.activeTx.push(tx);
    }
    this.nextId = next;
    this.holds.clear();
    for (const h of s.holds) this.holds.add(h);
    this.now = s.now;
    this.game = s.game;
  }

  // --- Internals ------------------------------------------------------------------------------

  private startPass(priority: boolean, playerOnly: boolean): void {
    let i = 0;
    while (i < this.queue.length) {
      const e = this.queue[i] as QueuedTransmission;
      if (
        e.priority !== priority ||
        (playerOnly && e.speakerKind !== 'player') ||
        e.follows >= 0 ||
        e.earliest > this.now ||
        // A hold (emergency traffic) keeps other units off the channel, never the player (Code 4 must get
        // through); the player then waits for a clear channel instead of keying over emergency traffic.
        (!e.priority && e.speakerKind !== 'player' && this.holds.has(e.channel)) ||
        ((e.waitClear || (!e.priority && e.speakerKind === 'player' && this.holds.has(e.channel))) && this.isActive(e.channel))
      ) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(e);
    }
  }

  private start(e: QueuedTransmission): void {
    e.start = this.now;
    e.clock = clockOf(this.game);
    e.audible = this.isAudible(e.channel);
    const tx = this.transmissionOf(e);
    let stepped: number[] | null = null;
    for (let i = 0; i < this.active.length; i++) {
      const other = this.active[i] as QueuedTransmission;
      if (other.channel !== e.channel) continue;
      other.blocked = true;
      (this.activeTx[i] as Transmission).blocked = true;
      (stepped ??= []).push(other.id);
    }
    // The emergency button pre-empts the channel (like an emergency talk permit): it cuts the others off and gets through.
    if (stepped && !(e.priority && e.kind === 'playerEmergency')) {
      e.blocked = true;
      tx.blocked = true;
      stepped.push(e.id);
    }
    this.active.push(e);
    this.activeTx.push(tx);
    this.logList.push(tx);
    if (this.logList.length > this.config.logSize) this.logList.shift();
    this.bus.emit('radio:start', { tx });
    if (stepped) this.bus.emit('radio:blocked', { ids: stepped, channel: e.channel });
    this.hooks.onStart?.(e, tx);
  }

  private transmissionOf(e: QueuedTransmission): Transmission {
    return {
      id: e.id,
      channel: e.channel,
      speaker: e.speaker,
      speakerKind: e.speakerKind,
      text: e.text,
      spoken: e.spoken,
      start: e.start,
      duration: e.duration,
      blocked: e.blocked,
      priority: e.priority,
      kind: e.kind,
      clock: e.clock,
      audible: e.audible,
    };
  }

  private resolveFollowers(id: number, endTime: number): void {
    for (const q of this.queue) {
      if (q.follows !== id) continue;
      q.follows = -1;
      q.earliest = Math.max(q.earliest, endTime + q.gap);
    }
  }

  /** Full queue: drop the oldest ambient entry, else the oldest non-player one, else the oldest. */
  private dropOne(): void {
    let idx = this.queue.findIndex((e) => e.ambient);
    if (idx < 0) idx = this.queue.findIndex((e) => e.speakerKind !== 'player');
    if (idx < 0) idx = 0;
    const [dropped] = this.queue.splice(idx, 1);
    if (dropped) this.resolveFollowers(dropped.id, this.now);
  }
}
