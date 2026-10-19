/**
 * Station data tables (design §11.1): the armory items, the locker uniforms and the briefing note templates,
 * validated at import. Every validation error names the file and the JSON path.
 */
import armoryJson from '../data/station/armory.json';
import briefingJson from '../data/station/briefing.json';
import lockerJson from '../data/station/locker.json';
import { fail, readArray, readColor, readObject, readOneOf, readString, readVersion } from '../vehicles/json';
import { DISTRICT_NAMES } from '../world/ids';

export interface ArmoryItemDef {
  readonly id: string;
  readonly label: string;
  readonly serialPrefix: string;
  /** The weapon the item enables on duty, null for equipment that is not a drawn weapon. */
  readonly weapon: 'sidearm' | 'taser' | null;
}

export interface UniformDef {
  readonly id: string;
  readonly label: string;
  /** 0xRRGGBB. */
  readonly top: number;
  readonly bottom: number;
}

export interface BriefingData {
  /** Safety reminders appended to the district notes. */
  readonly general: readonly string[];
  /** District name -> note templates (`{street}` and `{district}` placeholders). */
  readonly districts: Readonly<Record<string, readonly string[]>>;
}

function loadArmory(): readonly ArmoryItemDef[] {
  const src = 'armory.json';
  const root = readObject(armoryJson, src, '');
  readVersion(root, src);
  const items = readArray(root['items'], src, 'items', 1);
  const seen = new Set<string>();
  return items.map((raw, i) => {
    const p = `items[${String(i)}]`;
    const o = readObject(raw, src, p);
    const id = readString(o['id'], src, `${p}.id`);
    if (seen.has(id)) fail(src, `${p}.id`, `duplicate id ${id}`);
    seen.add(id);
    const weapon = o['weapon'] === null ? null : readOneOf(o['weapon'], ['sidearm', 'taser'] as const, src, `${p}.weapon`);
    return {
      id,
      label: readString(o['label'], src, `${p}.label`),
      serialPrefix: readString(o['serialPrefix'], src, `${p}.serialPrefix`),
      weapon,
    };
  });
}

function loadUniforms(): readonly UniformDef[] {
  const src = 'locker.json';
  const root = readObject(lockerJson, src, '');
  readVersion(root, src);
  const list = readArray(root['uniforms'], src, 'uniforms', 1);
  const seen = new Set<string>();
  return list.map((raw, i) => {
    const p = `uniforms[${String(i)}]`;
    const o = readObject(raw, src, p);
    const id = readString(o['id'], src, `${p}.id`);
    if (seen.has(id)) fail(src, `${p}.id`, `duplicate id ${id}`);
    seen.add(id);
    return {
      id,
      label: readString(o['label'], src, `${p}.label`),
      top: readColor(o['top'], src, `${p}.top`),
      bottom: readColor(o['bottom'], src, `${p}.bottom`),
    };
  });
}

function loadBriefing(): BriefingData {
  const src = 'briefing.json';
  const root = readObject(briefingJson, src, '');
  readVersion(root, src);
  const general = readArray(root['general'], src, 'general', 1).map((t, i) => readString(t, src, `general[${String(i)}]`));
  const districts = readObject(root['districts'], src, 'districts');
  const out: Record<string, readonly string[]> = {};
  for (const name of DISTRICT_NAMES) {
    const p = `districts.${name}`;
    const notes = readArray(districts[name], src, p, 3).map((t, i) => readString(t, src, `${p}[${String(i)}]`));
    if (notes.length > 5) fail(src, p, `must have at most 5 notes, got ${String(notes.length)}`);
    out[name] = notes;
  }
  for (const key of Object.keys(districts)) {
    if (!(DISTRICT_NAMES as readonly string[]).includes(key)) fail(src, `districts.${key}`, 'is not a district name');
  }
  return { general, districts: out };
}

/** The six armory items in file order (`ARMORY_ITEMS` of the design). */
export const ARMORY_ITEMS: readonly ArmoryItemDef[] = loadArmory();
/** The locker uniform options in file order. */
export const UNIFORMS: readonly UniformDef[] = loadUniforms();
/** Briefing note templates. */
export const BRIEFING_DATA: BriefingData = loadBriefing();
