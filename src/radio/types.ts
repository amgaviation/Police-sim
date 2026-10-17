/**
 * Radio shapes (design §9.7). Everything here is plain data (JSON-safe) so it can be saved.
 */
import type { RequestVia, UnitRequest } from '../cad/types';

export const CHANNEL_IDS = ['dispatch', 'tac', 'car', 'fireEms', 'county', 'state'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const SPEAKER_KINDS = ['dispatcher', 'officer', 'agency', 'player'] as const;
export type SpeakerKind = (typeof SPEAKER_KINDS)[number];

/** One transmission on the air (or in the log). `blocked` flips when it is stepped on. */
export interface Transmission {
  readonly id: number;
  readonly channel: ChannelId;
  /** Callsign ("21"), agency unit ("Engine 4") or dispatcher name ("Dispatch"). */
  readonly speaker: string;
  readonly speakerKind: SpeakerKind;
  /** Display text (keeps codes: "12, show me 10-8."). */
  readonly text: string;
  /** Text for TTS ("twelve, show me ten eight."). */
  readonly spoken: string;
  /** Sim seconds. */
  readonly start: number;
  /** Estimated: keyUpS + words / wordsPerSecond + tailS. */
  readonly duration: number;
  blocked: boolean;
  readonly priority: boolean;
  /** Phrase kind ("assign", "plateHit", "ambient", ...). */
  readonly kind: string;
  /** Game clock at the start, "HH:MM". */
  readonly clock: string;
  /** Selected channel, or scanned, when it started. */
  readonly audible: boolean;
}

/**
 * A transmission waiting for its channel (or on the air when `start >= 0`). Saved as is.
 * `follows` chains a reply to another transmission: it becomes eligible `gap` seconds after that one ends.
 */
export interface QueuedTransmission {
  id: number;
  channel: ChannelId;
  speaker: string;
  speakerKind: SpeakerKind;
  text: string;
  spoken: string;
  kind: string;
  priority: boolean;
  duration: number;
  /** Earliest sim start. */
  earliest: number;
  /** Wait for a clear channel (false: key up immediately, may step on someone). */
  waitClear: boolean;
  /** Id of the transmission this one answers (-1 none). */
  follows: number;
  /** Seconds after `follows` ends. */
  gap: number;
  /** Callsign the transmission is addressed to ('' none); dispatcher lines to the player feed `repeat`. */
  to: string;
  /** Ambient chatter (dropped first when the queue is full). */
  ambient: boolean;
  /** Player transmission: the request acted on when it ends unblocked. */
  request: UnitRequest | null;
  via: RequestVia | null;
  /** -1 while queued; the sim start once on the air. */
  start: number;
  blocked: boolean;
  clock: string;
  audible: boolean;
}
