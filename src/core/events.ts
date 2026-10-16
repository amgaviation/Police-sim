import type { EventMap } from './event-map';
import { log } from './log';

export type EventHandler<P> = (payload: P) => void;

/** Called when a handler throws; the default logs through `core/log`. */
export type EventErrorHandler = (topic: string, error: unknown) => void;

type AnyHandler = (payload: unknown) => void;

interface Subscription {
  readonly fn: AnyHandler;
  readonly once: boolean;
}

const defaultOnError: EventErrorHandler = (topic, error) => {
  log.error(`Event handler for '${topic}' threw:`, error);
};

/**
 * Synchronous, typed publish/subscribe bus. Handlers run in subscription
 * order; a throwing handler is reported via `onError` and does not stop
 * the remaining handlers.
 */
export class EventBus<M extends object> {
  private readonly subs = new Map<keyof M, Subscription[]>();
  private readonly onError: EventErrorHandler;

  constructor(onError: EventErrorHandler = defaultOnError) {
    this.onError = onError;
  }

  /** Subscribes `handler` to `topic`; returns an unsubscribe function. */
  on<K extends keyof M>(topic: K, handler: EventHandler<M[K]>): () => void {
    return this.add(topic, handler, false);
  }

  /** Like `on`, but the handler is removed after its first invocation. */
  once<K extends keyof M>(topic: K, handler: EventHandler<M[K]>): () => void {
    return this.add(topic, handler, true);
  }

  /** Removes a previously subscribed handler (no-op if absent). */
  off<K extends keyof M>(topic: K, handler: EventHandler<M[K]>): void {
    const list = this.subs.get(topic);
    if (!list) return;
    const idx = list.findIndex((s) => s.fn === (handler as AnyHandler));
    if (idx === -1) return;
    list.splice(idx, 1);
    if (list.length === 0) this.subs.delete(topic);
  }

  /** Invokes every handler for `topic` synchronously, in subscription order. */
  emit<K extends keyof M>(topic: K, payload: M[K]): void {
    const list = this.subs.get(topic);
    if (!list || list.length === 0) return;
    // Snapshot so subscribe/unsubscribe inside a handler is safe.
    for (const sub of list.slice()) {
      if (sub.once) this.remove(topic, sub);
      try {
        sub.fn(payload);
      } catch (error) {
        this.onError(String(topic), error);
      }
    }
  }

  /** Number of handlers on `topic`, or across all topics when omitted. */
  listenerCount(topic?: keyof M): number {
    if (topic !== undefined) return this.subs.get(topic)?.length ?? 0;
    let n = 0;
    for (const list of this.subs.values()) n += list.length;
    return n;
  }

  /** Removes all handlers on `topic`, or every handler when omitted. */
  clear(topic?: keyof M): void {
    if (topic === undefined) this.subs.clear();
    else this.subs.delete(topic);
  }

  private add<K extends keyof M>(topic: K, handler: EventHandler<M[K]>, once: boolean): () => void {
    const sub: Subscription = { fn: handler as AnyHandler, once };
    const list = this.subs.get(topic);
    if (list) list.push(sub);
    else this.subs.set(topic, [sub]);
    return () => this.remove(topic, sub);
  }

  private remove(topic: keyof M, sub: Subscription): void {
    const list = this.subs.get(topic);
    if (!list) return;
    const idx = list.indexOf(sub);
    if (idx === -1) return;
    list.splice(idx, 1);
    if (list.length === 0) this.subs.delete(topic);
  }
}

/** Application-wide bus typed with the merged `EventMap`. */
export const bus: EventBus<EventMap> = new EventBus<EventMap>();
