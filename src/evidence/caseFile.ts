/**
 * Case file store (design phase 4 §9.3): one file per call with evidence items, markers, photos, prints,
 * canvass results, consents, statements, K9 and bodycam notes. Bounded so saves stay small. Pure data.
 */
import type { ConsentRecord, SearchBasis } from './searchRules';
import type { Container } from './types';

export interface EvidenceItem {
  /** `E-<callId>-<n>`. */
  id: string;
  callId: number;
  /** People item id or `latentPrint`. */
  item: string;
  label: string;
  x: number;
  y: number;
  z: number;
  buildingId: number;
  room: number;
  furniture: number;
  container: Container;
  concealed: boolean;
  ownerPersonId: number;
  state: 'inPlace' | 'found' | 'collected';
  plainView: boolean;
  foundBasis: SearchBasis | null;
  suppressed: boolean;
  /** 0 = no marker placed. */
  markerNo: number;
  k9Alert: boolean;
  incriminating: boolean;
}

export interface MarkerRecord {
  no: number;
  callId: number;
  x: number;
  y: number;
  z: number;
  buildingId: number;
  itemId: string | null;
  sim: number;
}

export interface PhotoRecord {
  id: string;
  callId: number;
  sim: number;
  game: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  buildingId: number;
  room: number;
  subjects: { kind: 'marker' | 'item' | 'person'; ref: string }[];
  caption: string;
  thumb: string | null;
}

export interface PrintRecord {
  id: string;
  callId: number;
  buildingId: number;
  furniture: number;
  quality: number;
  personId: number;
  itemId: string | null;
  sim: number;
}

export interface CanvassRecord {
  callId: number;
  buildingId: number;
  sim: number;
  result: 'noAnswer' | 'nothingSeen' | 'sawSomething' | 'refused';
  personId: number;
  text: string;
}

export interface StatementRecord {
  personId: number;
  role: string;
  text: string;
  sim: number;
}

export interface CaseFile {
  callId: number;
  incident: string;
  title: string;
  items: EvidenceItem[];
  markers: MarkerRecord[];
  photos: PhotoRecord[];
  prints: PrintRecord[];
  canvass: CanvassRecord[];
  consents: ConsentRecord[];
  statements: StatementRecord[];
  k9: { sim: number; text: string }[];
  bodycam: { start: number; end: number }[];
  nextItem: number;
  nextMarker: number;
  nextPhoto: number;
  closed: boolean;
}

export const MAX_FILES = 64;
export const MAX_ITEMS = 40;
export const MAX_MARKERS = 99;
export const MAX_PHOTOS = 48;
export const MAX_THUMBS = 32;

type ItemSpec = Omit<EvidenceItem, 'id' | 'callId' | 'state' | 'plainView' | 'foundBasis' | 'suppressed' | 'markerNo' | 'k9Alert'>;

const ITEM_ID = /^E-(-?\d+)-\d+$/;

/** Drops the oldest entries of `arr` beyond `max`. */
function capOldest<T>(arr: T[], max: number): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/** Case files by call id, insertion-ordered (oldest first). */
export class CaseStore {
  private readonly byCall = new Map<number, CaseFile>();

  /** Creates the file on demand; `incident` / `title` fill in blanks. */
  file(callId: number, incident?: string, title?: string): CaseFile {
    let f = this.byCall.get(callId);
    if (!f) {
      this.dropFilesTo(MAX_FILES - 1);
      f = {
        callId,
        incident: '',
        title: '',
        items: [],
        markers: [],
        photos: [],
        prints: [],
        canvass: [],
        consents: [],
        statements: [],
        k9: [],
        bodycam: [],
        nextItem: 1,
        nextMarker: 1,
        nextPhoto: 1,
        closed: false,
      };
      this.byCall.set(callId, f);
    }
    if (incident !== undefined && f.incident === '') f.incident = incident;
    if (title !== undefined && f.title === '') f.title = title;
    return f;
  }

  get(callId: number): CaseFile | null {
    return this.byCall.get(callId) ?? null;
  }

  files(): readonly CaseFile[] {
    return [...this.byCall.values()];
  }

  item(itemId: string): EvidenceItem | null {
    const m = ITEM_ID.exec(itemId);
    const f = m ? this.byCall.get(Number(m[1])) : undefined;
    return f?.items.find((i) => i.id === itemId) ?? null;
  }

  /** Adds an item in place (`E-<callId>-<n>`); a full file drops its oldest uncollected item. */
  addItem(callId: number, spec: ItemSpec): EvidenceItem {
    const f = this.file(callId);
    if (f.items.length >= MAX_ITEMS) {
      const at = Math.max(0, f.items.findIndex((i) => i.state !== 'collected'));
      f.items.splice(at, 1);
    }
    const item: EvidenceItem = {
      id: `E-${callId}-${f.nextItem++}`,
      callId,
      item: spec.item,
      label: spec.label,
      x: spec.x,
      y: spec.y,
      z: spec.z,
      buildingId: spec.buildingId,
      room: spec.room,
      furniture: spec.furniture,
      container: spec.container,
      concealed: spec.concealed,
      ownerPersonId: spec.ownerPersonId,
      state: 'inPlace',
      plainView: false,
      foundBasis: null,
      suppressed: false,
      markerNo: 0,
      k9Alert: false,
      incriminating: spec.incriminating,
    };
    f.items.push(item);
    return item;
  }

  /**
   * Enforces every size limit: 64 files (oldest closed dropped first), 40 items, 99 markers, 48 photos per
   * file, thumbnails only on the 32 newest photos overall. Call after pushing markers or photos directly.
   */
  trim(): void {
    this.dropFilesTo(MAX_FILES);
    const photos: { p: PhotoRecord; order: number }[] = [];
    for (const f of this.byCall.values()) {
      capOldest(f.items, MAX_ITEMS);
      capOldest(f.markers, MAX_MARKERS);
      capOldest(f.photos, MAX_PHOTOS);
      for (const p of f.photos) photos.push({ p, order: photos.length });
    }
    if (photos.length <= MAX_THUMBS) return;
    photos.sort((a, b) => b.p.sim - a.p.sim || b.order - a.order);
    for (let i = MAX_THUMBS; i < photos.length; i++) {
      const entry = photos[i];
      if (entry) entry.p.thumb = null;
    }
  }

  serialize(): CaseFile[] {
    this.trim();
    return structuredClone([...this.byCall.values()]);
  }

  static restore(files: readonly CaseFile[]): CaseStore {
    const store = new CaseStore();
    for (const f of files) store.byCall.set(f.callId, structuredClone(f));
    store.trim();
    return store;
  }

  private dropFilesTo(max: number): void {
    while (this.byCall.size > max) {
      let victim: number | undefined;
      for (const f of this.byCall.values()) {
        if (f.closed) {
          victim = f.callId;
          break;
        }
      }
      victim ??= this.byCall.keys().next().value;
      if (victim === undefined) return;
      this.byCall.delete(victim);
    }
  }
}

const ARRAY_FIELDS = ['items', 'markers', 'photos', 'prints', 'canvass', 'consents', 'statements', 'k9', 'bodycam'] as const;
const NUMBER_FIELDS = ['callId', 'nextItem', 'nextMarker', 'nextPhoto'] as const;

/** Structural check used when loading a save. */
export function isCaseFile(x: unknown): x is CaseFile {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.incident !== 'string' || typeof o.title !== 'string' || typeof o.closed !== 'boolean') return false;
  for (const k of NUMBER_FIELDS) if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return false;
  for (const k of ARRAY_FIELDS) {
    const arr = o[k];
    if (!Array.isArray(arr) || arr.some((e) => typeof e !== 'object' || e === null)) return false;
  }
  return (
    (o.items as { id?: unknown }[]).every((i) => typeof i.id === 'string') &&
    (o.photos as { id?: unknown }[]).every((p) => typeof p.id === 'string')
  );
}
