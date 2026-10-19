/** The locker loadout (design §11.1). Pure. */
import { UNIFORMS } from './data';

export { UNIFORMS, type UniformDef } from './data';

export const LOADOUT_FIELDS = ['uniform', 'vest', 'bodycamMount', 'radioAudio', 'flashlight'] as const;
export type LoadoutField = (typeof LOADOUT_FIELDS)[number];

export const BODYCAM_MOUNTS = ['chest', 'shoulder', 'none'] as const;
export const RADIO_AUDIO = ['speaker', 'earpiece'] as const;
export const FLASHLIGHTS = ['handheld', 'mounted'] as const;

export interface Loadout {
  /** A `UNIFORMS` id. */
  uniform: string;
  vest: boolean;
  bodycamMount: (typeof BODYCAM_MOUNTS)[number];
  radioAudio: (typeof RADIO_AUDIO)[number];
  flashlight: (typeof FLASHLIGHTS)[number];
}

/** First uniform, vest on, chest mount, speaker, handheld flashlight. */
export function defaultLoadout(): Loadout {
  return { uniform: UNIFORMS[0]?.id ?? '', vest: true, bodycamMount: 'chest', radioAudio: 'speaker', flashlight: 'handheld' };
}

function nextOf<T extends string>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length] ?? current;
}

/** A copy of `l` with `field` advanced to its next option (wrapping); the input is not changed. */
export function cycleLoadout(l: Loadout, field: LoadoutField): Loadout {
  const out: Loadout = { ...l };
  switch (field) {
    case 'uniform': {
      const i = UNIFORMS.findIndex((u) => u.id === l.uniform);
      out.uniform = UNIFORMS[(i + 1) % UNIFORMS.length]?.id ?? l.uniform;
      break;
    }
    case 'vest':
      out.vest = !l.vest;
      break;
    case 'bodycamMount':
      out.bodycamMount = nextOf(BODYCAM_MOUNTS, l.bodycamMount);
      break;
    case 'radioAudio':
      out.radioAudio = nextOf(RADIO_AUDIO, l.radioAudio);
      break;
    case 'flashlight':
      out.flashlight = nextOf(FLASHLIGHTS, l.flashlight);
      break;
  }
  return out;
}

/** Label of the loadout's uniform ('' when unknown). */
export function uniformLabel(l: Loadout): string {
  return UNIFORMS.find((u) => u.id === l.uniform)?.label ?? '';
}

/** Top and bottom colours (0xRRGGBB) of the loadout's uniform; the first uniform's for an unknown id. */
export function uniformColors(l: Loadout): { top: number; bottom: number } {
  const u = UNIFORMS.find((d) => d.id === l.uniform) ?? UNIFORMS[0];
  return { top: u?.top ?? 0x1f3350, bottom: u?.bottom ?? 0x1a2433 };
}

/** Structural check for saves (the uniform must exist). */
export function isLoadout(x: unknown): x is Loadout {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['uniform'] === 'string' &&
    UNIFORMS.some((u) => u.id === o['uniform']) &&
    typeof o['vest'] === 'boolean' &&
    (BODYCAM_MOUNTS as readonly unknown[]).includes(o['bodycamMount']) &&
    (RADIO_AUDIO as readonly unknown[]).includes(o['radioAudio']) &&
    (FLASHLIGHTS as readonly unknown[]).includes(o['flashlight'])
  );
}
