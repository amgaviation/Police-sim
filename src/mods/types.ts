/**
 * Mod bundle types (Phase 8 design §10.1). A mod is untrusted JSON: `schema.ts` validates it into a `ModBundle`,
 * `combine.ts` merges the enabled mods into a `ModOverlay` that the data loaders apply at page load.
 */

export const MOD_FORMAT = 'patrol-mod';
export const MOD_FORMAT_VERSION = 1;
/** Largest accepted mod (bytes of the bundle file, or of all files of a folder). */
export const MOD_MAX_BYTES = 2 * 1024 * 1024;

/** Content kinds a mod may carry under `content`. */
export const MOD_CONTENT_KINDS = [
  'callTypes',
  'statutes',
  'rulesets',
  'vehicles',
  'uniforms',
  'districts',
  'voicePacks',
  'dispatchScripts',
] as const;
export type ModContentKind = (typeof MOD_CONTENT_KINDS)[number];

/** Voice kinds a voice pack can tune (= `VoiceKind` of `src/speech/profile.ts`). */
export const VOICE_PACK_KINDS = ['dispatcher', 'officer', 'agency', 'player'] as const;
export type VoicePackKind = (typeof VOICE_PACK_KINDS)[number];

export interface ModManifest {
  format: 'patrol-mod';
  version: 1;
  /** `/^[a-z0-9][a-z0-9-]{1,39}$/` */
  id: string;
  /** 1..60 characters. */
  name: string;
  /** At most 60 characters. */
  author: string;
  /** At most 400 characters. */
  description: string;
  /** `/^\d+\.\d+\.\d+$/` */
  modVersion: string;
}

/** Per-kind TTS tuning of a voice pack. */
export interface VoicePackVoice {
  pitch: [number, number];
  rate: [number, number];
  /** Substrings of a voice name / language the speech pool is narrowed to (at most 8). */
  prefer: string[];
}

export interface VoicePackDef {
  id: string;
  name: string;
  voices: Partial<Record<VoicePackKind, VoicePackVoice>>;
  /** Keys = radio `PHRASE_KINDS`; a listed array replaces the whole table of that mode. */
  phrases?: Record<string, { tenCode?: string[]; plain?: string[] }>;
}

export interface DistrictPatch {
  label?: string;
  crimeFactor?: number;
  trustBaseline?: number;
}

export interface UniformPatch {
  classes?: ({ id: string } & Record<string, unknown>)[];
  department?: Record<string, unknown>;
}

export interface ModContent {
  /** Same shape as `src/data/calls/types/*.json` without `version`. */
  callTypes?: { family: string; types: unknown[] }[];
  /** Statute rows (`statutes.json` `statutes` entries). */
  statutes?: unknown[];
  /** Full ruleset documents (`src/data/legal/rulesets/*.json`). */
  rulesets?: unknown[];
  /** Vehicle model documents (`src/data/vehicles/*.json`). */
  vehicles?: unknown[];
  uniforms?: UniformPatch;
  districts?: Record<string, DistrictPatch>;
  voicePacks?: VoicePackDef[];
  /** `patrol-dispatch-script` documents (`src/training/script.ts`). */
  dispatchScripts?: unknown[];
}

export interface ModBundle extends ModManifest {
  content: ModContent;
}

/** One validation problem: the mod id, a dotted path inside the bundle and a message. */
export interface ModError {
  mod: string;
  path: string;
  message: string;
}

/** Identity of an enabled mod; a save records these. `hash` = 8 hex digits, FNV-1a of the canonical JSON. */
export interface ModRef {
  id: string;
  modVersion: string;
  hash: string;
}

/** The merged content of the enabled mods that the data loaders apply. */
export interface ModOverlay {
  refs: ModRef[];
  /** File `mod:<modId>:<n>.json`, json `{ version: 1, family, types }`. */
  callTypes: { file: string; json: unknown }[];
  statutes: unknown[];
  /** File `<id>.json`. */
  rulesets: { file: string; json: unknown }[];
  /** File `<id>.json`. */
  vehicles: { file: string; json: unknown }[];
  uniforms: { classes: ({ id: string } & Record<string, unknown>)[]; department: Record<string, unknown> | null }[];
  /** Later mods win per district key. */
  districts: Record<string, DistrictPatch>;
  /** The last enabled voice pack. */
  voicePack: VoicePackDef | null;
  dispatchScripts: unknown[];
}
