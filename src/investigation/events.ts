/** Investigation bus topics (design phase 4 §10.2, §14). Every payload carries the `callId` of the case file (0 = field case). */
import type { CanvassRecord, CustodyAction, PhotoRecord, SearchBasis } from '../evidence';

export interface InvestigationMarkerEvent {
  callId: number;
  no: number;
  /** Linked evidence item, null for a free marker. */
  itemId: string | null;
  /** True when the marker was picked up again. */
  removed: boolean;
}

export interface InvestigationPhotoEvent {
  callId: number;
  photoId: string;
  subjects: PhotoRecord['subjects'];
}

export interface InvestigationPlainViewEvent {
  callId: number;
  itemId: string;
  label: string;
}

export interface InvestigationFoundEvent {
  callId: number;
  itemId: string;
  basis: SearchBasis | null;
  suppressed: boolean;
}

export interface InvestigationCollectedEvent {
  callId: number;
  itemId: string;
  label: string;
}

export interface InvestigationCustodyEvent {
  callId: number;
  itemId: string;
  action: CustodyAction;
}

export interface InvestigationCustodyCompleteEvent {
  callId: number;
  itemId: string;
}

export interface InvestigationTapeEvent {
  callId: number;
  closed: boolean;
  /** x, z pairs. */
  points: number[];
}

export interface InvestigationCanvassEvent {
  callId: number;
  buildingId: number;
  result: CanvassRecord['result'];
  personId: number;
}

export interface InvestigationK9AlertEvent {
  callId: number;
  kind: 'person' | 'item';
  /** Hidden actor id for a person alert, 0 for an item. */
  actorId: number;
  /** Evidence item id for an item alert, '' for a person. */
  itemId: string;
  room: number;
  text: string;
}

export interface InvestigationBodycamEvent {
  callId: number;
  on: boolean;
}

export interface InvestigationPrintEvent {
  callId: number;
  printId: string;
  quality: number;
  usable: boolean;
  /** The latent print evidence item (usable lifts only). */
  itemId: string | null;
}

/** A radio line for the integrator to speak / log. */
export interface InvestigationRadioEvent {
  callId: number;
  text: string;
}

/** A short on-screen line (HUD flash / subtitle). */
export interface InvestigationFlashEvent {
  callId: number;
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'investigation:marker': InvestigationMarkerEvent;
    'investigation:photo': InvestigationPhotoEvent;
    'investigation:plainView': InvestigationPlainViewEvent;
    'investigation:found': InvestigationFoundEvent;
    'investigation:collected': InvestigationCollectedEvent;
    'investigation:custody': InvestigationCustodyEvent;
    'investigation:custodyComplete': InvestigationCustodyCompleteEvent;
    'investigation:tape': InvestigationTapeEvent;
    'investigation:canvass': InvestigationCanvassEvent;
    'investigation:k9Alert': InvestigationK9AlertEvent;
    'investigation:bodycam': InvestigationBodycamEvent;
    'investigation:print': InvestigationPrintEvent;
    'investigation:radio': InvestigationRadioEvent;
    'investigation:flash': InvestigationFlashEvent;
  }
}
