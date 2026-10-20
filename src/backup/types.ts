/** Backup officers and SWAT: id lists, tuning shapes, requests and the port the command module drives (design §4.1, §4.5, §9). */

export const BACKUP_STATES = ['exiting', 'approach', 'cover', 'secondary', 'chase', 'detain', 'post', 'standby', 'returning', 'gone', 'swat'] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

export const BACKUP_ROLES = ['cover', 'secondary', 'post', 'standby', 'swat'] as const;
export type BackupRole = (typeof BACKUP_ROLES)[number];

export const BACKUP_COMMANDS = ['cover', 'secondary', 'detain', 'standby', 'release', 'regroup'] as const;
export type BackupCommand = (typeof BACKUP_COMMANDS)[number];

export const SWAT_COMMANDS = ['stage', 'stack', 'breach', 'clear', 'hold', 'withdraw'] as const;
export type SwatCommand = (typeof SWAT_COMMANDS)[number];

export const SWAT_PHASES = ['enRoute', 'staging', 'stacked', 'breaching', 'clearing', 'holding', 'done', 'withdrawn'] as const;
export type SwatPhase = (typeof SWAT_PHASES)[number];

export const POST_KINDS = ['inner', 'tcp', 'evac'] as const;
export type PostKind = (typeof POST_KINDS)[number];

/** What an officer calls out over the radio (keys of `backup.json` `callouts`). */
export const CALLOUT_KINDS = ['weapon', 'secondSubject', 'runner', 'handsClear', 'fight', 'covering', 'inCustody'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/** The three mistake kinds of `src/units` (`MISTAKE_KINDS`), re-declared as a tuple of booleans in saves. */
export type MistakeFlags = readonly [boolean, boolean, boolean];

export interface SwatPlan {
  entry: 'front' | 'rear';
  tempo: 'deliberate' | 'dynamic';
  lessLethal: boolean;
}

/** `backup.json`. */
export interface BackupConfig {
  readonly spawn: { readonly maxCarDistanceM: number; readonly maxOfficers: number; readonly exitS: number };
  readonly move: { readonly walk: number; readonly run: number; readonly chase: number; readonly arriveM: number };
  readonly cover: {
    readonly distanceM: readonly [number, number];
    readonly angleDeg: readonly [number, number];
    readonly poorAngleDeg: number;
    readonly poorDistanceM: number;
    readonly repositionS: number;
  };
  readonly secondary: { readonly standoffM: number; readonly commandEveryS: number; readonly detectRangeM: number };
  readonly chase: { readonly tackleRangeM: number; readonly giveUpM: number };
  readonly callout: {
    readonly delayS: readonly [number, number];
    readonly lateDelayS: readonly [number, number];
    readonly weaponRangeM: number;
    readonly cooldownS: number;
  };
  readonly post: { readonly staffedM: number };
  readonly stress: { readonly sampleS: number };
  readonly callouts: Readonly<Record<CalloutKind, readonly string[]>>;
}

/** `swat.json`. */
export interface SwatConfig {
  readonly operators: number;
  readonly speed: { readonly walk: number; readonly move: number };
  readonly stackOffsetM: number;
  readonly roomS: { readonly deliberate: number; readonly dynamic: number };
  readonly breachS: number;
  readonly stageDistanceM: number;
  readonly contact: {
    readonly surrenderBase: number;
    readonly negotiationTrust: number;
    readonly dynamicSurprise: number;
    readonly lessLethal: number;
    readonly hostagePenalty: number;
    readonly armedPenalty: number;
    readonly hostageInjuryBase: number;
    readonly hostageInjuryDynamic: number;
    readonly subjectInjuryLessLethal: number;
  };
  readonly colors: { readonly top: number; readonly bottom: number };
}

/** Queued requests (applied at the start of the next `step`). */
export type BackupRequest =
  | { readonly kind: 'command'; /** A callsign, or 'all'. */ readonly callsign: string; readonly command: BackupCommand; readonly targetPersonId?: number }
  | { readonly kind: 'post'; readonly id: string; readonly x: number; readonly z: number; readonly yaw: number; readonly postKind: PostKind }
  | { readonly kind: 'clearPosts'; readonly postKind?: PostKind }
  | { readonly kind: 'swat'; readonly callId: number; readonly command: SwatCommand; readonly plan?: Partial<SwatPlan> };

/** One officer for the HUD / backup panel. */
export interface BackupOfficerView {
  callsign: string;
  name: string;
  role: BackupRole;
  state: BackupState;
  stress: number;
  fatigue: number;
  loyalty: number;
  /** 0..1 position quality against the cover target (1 = ideal). */
  quality: number;
  /** Id of the staffed post, null none. */
  post: string | null;
}

/** What the command module drives (design §4.5). */
export interface BackupPort {
  /** Asks an available on-foot officer of the call to staff a post; returns the callsign or null when none is free. */
  staffPost(post: { id: string; x: number; z: number; yaw: number; kind: PostKind }): string | null;
  /** Releases every post of `kind` (all when omitted). */
  clearPosts(kind?: PostKind): void;
  /** Posts currently staffed (officer within `post.staffedM` of it). */
  staffed(kind: PostKind): number;
  /** A SWAT command (+ optional plan change) for the team on `callId`'s building; returns the reply text. */
  swat(callId: number, command: SwatCommand, plan?: Partial<SwatPlan>): string;
  /** SWAT phase on the call ('enRoute' when the team has not arrived, null when no SWAT unit is assigned). */
  swatPhase(callId: number): string | null;
}
