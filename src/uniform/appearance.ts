import { SKIN_SHINS } from './types';
import type { CharacterProfile, OutfitDef } from './types';

/** What the people renderer needs to draw one figure (design Phase 7 §7.5). */
export interface FigureAppearance {
  skin: number;
  /** 0xffffffff = no hair. */
  hair: number;
  top: number;
  bottom: number;
  shins: number;
  height: number;
  build: number;
  shoulders: number;
  hips: number;
}

/** Figure colours and body proportions of a character wearing `outfit`. */
export function figureAppearance(p: CharacterProfile, outfit: OutfitDef): FigureAppearance {
  return {
    skin: p.skin,
    hair: outfit.hideHair || p.hairStyle === 'bald' ? 0xffffffff : p.hairColor,
    top: outfit.top,
    bottom: outfit.bottom,
    shins: outfit.shins === null ? outfit.bottom : outfit.shins === SKIN_SHINS ? p.skin : outfit.shins,
    height: p.body.heightM,
    build: p.body.build,
    shoulders: p.body.shoulders,
    hips: p.body.hips,
  };
}
