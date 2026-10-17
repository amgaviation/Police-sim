/** Radio bus topics (design §14). Emitted on transmission start/end only, never per step. */
import type { ChannelId, Transmission } from './types';

export interface RadioStartEvent {
  tx: Readonly<Transmission>;
}

export interface RadioEndEvent {
  id: number;
  blocked: boolean;
}

/** Transmissions stepped on each other: every id in `ids` is now blocked. */
export interface RadioBlockedEvent {
  ids: number[];
  channel: ChannelId;
}

export interface RadioChannelEvent {
  selected: ChannelId;
  scanning: boolean;
}

declare module '../core/event-map' {
  interface EventMap {
    'radio:start': RadioStartEvent;
    'radio:end': RadioEndEvent;
    'radio:blocked': RadioBlockedEvent;
    'radio:channel': RadioChannelEvent;
  }
}
