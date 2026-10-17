import surfacesJson from '../data/physics/surfaces.json';
import { fail, readNumber, readObject, readVersion } from './json';

/** Surface names in id order; ids match the world module's `SURFACE` (asphalt = 0 ... sand = 5). */
export const SURFACE_NAMES = ['asphalt', 'concrete', 'gravel', 'dirt', 'grass', 'sand'] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];

export interface SurfaceDef {
  /** Grip multiplier on dry ground. */
  readonly grip: number;
  /** Rolling-resistance coefficient (force / wheel load). */
  readonly rolling: number;
  /** Grip multiplier at full wetness / full snow cover. */
  readonly wet: number;
  readonly snow: number;
}

/** Validates `surfaces.json`; every name in `SURFACE_NAMES` must be present. */
export function parseSurfaces(json: unknown, source = 'surfaces.json'): SurfaceDef[] {
  const root = readObject(json, source, '');
  readVersion(root, source);
  const surfaces = readObject(root.surfaces, source, 'surfaces');
  for (const key of Object.keys(surfaces)) {
    if (!(SURFACE_NAMES as readonly string[]).includes(key)) {
      fail(source, `surfaces.${key}`, `is not one of: ${SURFACE_NAMES.join(', ')}`);
    }
  }
  return SURFACE_NAMES.map((name) => {
    const path = `surfaces.${name}`;
    const s = readObject(surfaces[name], source, path);
    return {
      grip: readNumber(s.grip, source, `${path}.grip`, 0, 2),
      rolling: readNumber(s.rolling, source, `${path}.rolling`, 0, 1),
      wet: readNumber(s.wet, source, `${path}.wet`, 0, 2),
      snow: readNumber(s.snow, source, `${path}.snow`, 0, 2),
    };
  });
}

export const SURFACES: readonly SurfaceDef[] = parseSurfaces(surfacesJson);

function surfaceDef(id: number): SurfaceDef {
  return SURFACES[id] ?? (SURFACES[0] as SurfaceDef);
}

/** Effective grip multiplier: `grip x lerp(1, wet, wetness) x lerp(1, snow, snowCover)`. Unknown ids read as asphalt. */
export function surfaceGrip(id: number, wetness: number, snowCover: number): number {
  const s = surfaceDef(id);
  return s.grip * (1 + (s.wet - 1) * wetness) * (1 + (s.snow - 1) * snowCover);
}

/** Rolling-resistance coefficient; unknown ids read as asphalt. */
export function surfaceRolling(id: number): number {
  return surfaceDef(id).rolling;
}
