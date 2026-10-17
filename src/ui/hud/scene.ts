import { formatDistance } from './format';

/** Pure text helpers for the Phase 3 HUD additions (design §12.4); no DOM. */

/** The officer's drawn weapon. */
export interface HudOfficer {
  weapon: 'none' | 'sidearm' | 'taser';
}

/** The person the officer is in contact with (nearest approachable or open conversation). */
export interface HudContact {
  name: string;
  /** Short state, e.g. 'calm', 'cuffed'. */
  state: string;
  distanceM: number;
}

export interface HudObjective {
  text: string;
  done: boolean;
}

/** The player's materialized call scene and its visible objectives. */
export interface HudScene {
  title: string;
  objectives: readonly HudObjective[];
}

/** Objective lines the HUD shows (the first ones, in order). */
export const SCENE_LINES = 4;

/** 'SIDEARM' / 'TASER', '' when holstered or unknown. */
export function weaponChipText(o: Readonly<HudOfficer> | null | undefined): string {
  if (!o) return '';
  if (o.weapon === 'sidearm') return 'SIDEARM';
  if (o.weapon === 'taser') return 'TASER';
  return '';
}

/** 'Jane Doe · calm · 4 m' (empty parts and an unknown distance omitted); '' without a contact. */
export function contactChipText(c: Readonly<HudContact> | null | undefined): string {
  if (!c) return '';
  let out = c.name;
  const distance = formatDistance(c.distanceM);
  for (const part of [c.state, distance]) {
    if (part === '') continue;
    out = out === '' ? part : `${out} · ${part}`;
  }
  return out;
}

export interface SceneText {
  /** '' hides the objective box. */
  title: string;
  /** `SCENE_LINES` entries, '' for unused lines. */
  lines: string[];
  done: boolean[];
}

export function createSceneText(): SceneText {
  return { title: '', lines: new Array<string>(SCENE_LINES).fill(''), done: new Array<boolean>(SCENE_LINES).fill(false) };
}

/** Fills `out` with the objective box title and its first four objectives; all empty without a scene. */
export function sceneText(s: Readonly<HudScene> | null | undefined, out: SceneText = createSceneText()): SceneText {
  out.title = s ? s.title : '';
  for (let i = 0; i < SCENE_LINES; i++) {
    const o = s?.objectives[i];
    out.lines[i] = o ? o.text : '';
    out.done[i] = o ? o.done : false;
  }
  return out;
}
