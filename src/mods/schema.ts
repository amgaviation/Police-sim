/**
 * Mod validation (design §10.3). `validateModBundle` takes untrusted JSON and never throws: it returns the typed bundle
 * or every problem found as `{ mod, path, message }` with a dotted path. The live data modules are imported only by
 * `defaultModContext()`, which wraps their throwing validators; everything else works on a `ModValidationContext`.
 */
import statutesJson from '../data/cad/statutes.json';
import actionsJson from '../data/calls/actions.json';
import familiesJson from '../data/calls/families.json';
import legacyJson from '../data/calls/legacy.json';
import servicesJson from '../data/calls/services.json';
import variantsJson from '../data/calls/variants.json';
import phrasesJson from '../data/radio/phrases.json';
import uniformsJson from '../data/uniform/uniforms.json';
import { CALL_TYPES, DISPOSITIONS, STATUTES, TEN_CODES, validateCallTypes, validateStatutes } from '../cad/data';
import { mergeCadRows } from '../calls/cadRows';
import { CALL_CATALOG, validateCatalog } from '../calls/catalog';
import { CRIME_CATEGORIES } from '../environment/crime';
import { RULESETS, parseRuleset } from '../legal/ruleset';
import { TRUNK_ITEMS } from '../police/inventory';
import { PHRASE_KINDS, validatePhrases } from '../radio/data';
import { BUILTIN_SCRIPTS, defaultScriptContext, parseDispatchScript } from '../training/script';
import { parseUniformData } from '../uniform/data';
import { UNIFORM_CLASSES } from '../uniform/types';
import { VEHICLE_MODELS, parseModVehicle } from '../vehicles/model';
import { DISTRICT_NAMES } from '../world/ids';
import { applyUniformPatches, canonicalJson, checkErrors, mergePhrases, mergeStatutes, type ModValidationContext } from './combine';
import { modOverlay } from './registry';
import {
  MOD_CONTENT_KINDS,
  MOD_FORMAT,
  MOD_FORMAT_VERSION,
  VOICE_PACK_KINDS,
  type ModBundle,
  type ModContent,
  type ModError,
  type VoicePackDef,
} from './types';

export type { ModValidationContext } from './combine';
export { buildOverlay, formatModErrors, modRef, resolveActiveMods, validateCombination } from './combine';

const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const RULESET_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const VEHICLE_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;
const MANIFEST_KEYS = ['format', 'version', 'id', 'name', 'author', 'description', 'modVersion', 'content'];

/** Allowed ranges (design §10.3). */
const CRIME_FACTOR: readonly [number, number] = [0.2, 3];
const TRUST_BASELINE: readonly [number, number] = [0.05, 0.95];
const VOICE_RANGE: readonly [number, number] = [0.5, 2];
const MAX_PREFER = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function show(v: unknown): string {
  return v === undefined ? 'undefined' : (JSON.stringify(v) ?? typeof v);
}

/** Validates untrusted mod JSON (size is measured by the caller against `MOD_MAX_BYTES`). Never throws. */
export function validateModBundle(json: unknown, ctx: ModValidationContext): { ok: true; mod: ModBundle } | { ok: false; errors: ModError[] } {
  if (!isRecord(json)) return { ok: false, errors: [{ mod: '(unknown)', path: '', message: `a mod must be a JSON object, got ${show(json)}` }] };
  const mod = typeof json.id === 'string' && json.id !== '' ? json.id : '(unknown)';
  const errors: ModError[] = [];
  const add = (path: string, message: string): void => {
    errors.push({ mod, path, message });
  };

  // --- generic readers (they record the error and return null) ---
  const unknownKeys = (o: Record<string, unknown>, allowed: readonly string[], path: string): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) add(path === '' ? k : `${path}.${k}`, 'unknown field');
  };
  const text = (v: unknown, path: string, min: number, max: number): string | null => {
    if (v === undefined) {
      add(path, 'is required');
      return null;
    }
    if (typeof v !== 'string') {
      add(path, `must be a string, got ${show(v)}`);
      return null;
    }
    if (v.length < min || v.length > max) {
      add(path, `must be ${min === max ? `${min}` : `${min}..${max}`} characters long, got ${v.length}`);
      return null;
    }
    return v;
  };
  const num = (v: unknown, path: string, range: readonly [number, number]): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      add(path, `must be a number in [${range[0]}, ${range[1]}], got ${show(v)}`);
      return null;
    }
    if (v < range[0] || v > range[1]) {
      add(path, `must be in [${range[0]}, ${range[1]}], got ${v}`);
      return null;
    }
    return v;
  };
  const list = (v: unknown, path: string): unknown[] | null => {
    if (!Array.isArray(v)) {
      add(path, `must be an array, got ${show(v)}`);
      return null;
    }
    if (v.length === 0) {
      add(path, 'must not be empty');
      return null;
    }
    return v as unknown[];
  };
  const slug = (v: unknown, path: string, re: RegExp, what: string): string | null => {
    if (typeof v !== 'string' || !re.test(v)) {
      add(path, `must be ${what}, got ${show(v)}`);
      return null;
    }
    return v;
  };

  // --- manifest ---
  unknownKeys(json, MANIFEST_KEYS, '');
  if (json.format !== MOD_FORMAT) add('format', `must be "${MOD_FORMAT}", got ${show(json.format)}`);
  if (json.version !== MOD_FORMAT_VERSION) add('version', `must be ${MOD_FORMAT_VERSION}, got ${show(json.version)}`);
  if (typeof json.id !== 'string' || !ID_RE.test(json.id)) {
    add('id', `must match ${String(ID_RE)} (2..40 characters: lower-case letters, digits and "-"), got ${show(json.id)}`);
  }
  text(json.name, 'name', 1, 60);
  text(json.author, 'author', 0, 60);
  text(json.description, 'description', 0, 400);
  if (typeof json.modVersion !== 'string' || !VERSION_RE.test(json.modVersion)) {
    add('modVersion', `must look like "1.0.0" (major.minor.patch), got ${show(json.modVersion)}`);
  }

  // --- content ---
  const content = json.content;
  const out: ModContent = {};
  if (content === undefined) add('content', 'is required');
  else if (!isRecord(content)) add('content', `must be an object, got ${show(content)}`);
  else {
    for (const k of Object.keys(content)) {
      if (!(MOD_CONTENT_KINDS as readonly string[]).includes(k)) {
        add(`content.${k}`, `unknown content kind (expected one of ${MOD_CONTENT_KINDS.join(', ')})`);
      }
    }
    if (Object.keys(content).length === 0) add('content', `must contain at least one of ${MOD_CONTENT_KINDS.join(', ')}`);

    const ownTypeIds = new Map<string, string>();
    const flatIds = (kind: string, items: unknown[], reserved: ReadonlySet<string>, idRe: RegExp | null, what: string): Set<number> => {
      // Common id rules of statutes / rulesets / vehicles; returns the indexes with a usable id and no id problem.
      const seen = new Map<string, string>();
      const good = new Set<number>();
      items.forEach((item, i) => {
        const p = `${kind}[${i}]`;
        if (!isRecord(item)) {
          add(p, `must be an object, got ${show(item)}`);
          return;
        }
        const id = item.id;
        if (typeof id !== 'string' || id === '') {
          add(`${p}.id`, `must be a non-empty string, got ${show(id)}`);
          return;
        }
        if (idRe !== null && !idRe.test(id)) {
          add(`${p}.id`, `must be ${what}, got ${show(id)}`);
          return;
        }
        if (reserved.has(id)) {
          add(`${p}.id`, `${show(id)} already exists in the base game`);
          return;
        }
        const other = seen.get(id);
        if (other !== undefined) {
          add(`${p}.id`, `duplicates ${show(id)} (also at ${other}.id)`);
          return;
        }
        seen.set(id, p);
        good.add(i);
      });
      return good;
    };

    // callTypes
    if (content.callTypes !== undefined) {
      const items = list(content.callTypes, 'callTypes');
      if (items) {
        const pending: { file: string; json: unknown }[] = [];
        items.forEach((f, i) => {
          const p = `callTypes[${i}]`;
          if (!isRecord(f)) {
            add(p, `must be an object, got ${show(f)}`);
            return;
          }
          const before = errors.length;
          unknownKeys(f, ['family', 'types'], p);
          if (typeof f.family !== 'string' || !ctx.familyIds.has(f.family)) {
            add(`${p}.family`, `unknown call family ${show(f.family)} (known: ${[...ctx.familyIds].sort().join(', ')})`);
          }
          const types = list(f.types, `${p}.types`);
          types?.forEach((t, j) => {
            const tp = `${p}.types[${j}]`;
            if (!isRecord(t)) {
              add(tp, `must be an object, got ${show(t)}`);
              return;
            }
            const id = t.id;
            if (typeof id !== 'string' || id === '') {
              add(`${tp}.id`, `must be a non-empty string, got ${show(id)}`);
            } else if (ctx.baseCallTypeIds.has(id)) {
              add(`${tp}.id`, `${show(id)} already exists in the base game`);
            } else if (ownTypeIds.has(id)) {
              add(`${tp}.id`, `duplicates ${show(id)} (also at ${ownTypeIds.get(id) ?? ''})`);
            } else ownTypeIds.set(id, `${tp}.id`);
          });
          if (errors.length === before && typeof f.family === 'string' && types) {
            const entry = { file: `mod:${mod}:${i}.json`, json: { version: 1, family: f.family, types } };
            pending.push(entry);
            errors.push(...checkErrors(mod, p, ctx.checkCallTypes([entry])));
          }
        });
        if (pending.length > 1 && errors.length === 0) errors.push(...checkErrors(mod, 'callTypes', ctx.checkCallTypes(pending)));
        out.callTypes = content.callTypes as ModContent['callTypes'];
      }
    }

    // statutes
    if (content.statutes !== undefined) {
      const items = list(content.statutes, 'statutes');
      if (items) {
        const good = flatIds('statutes', items, ctx.baseStatuteIds, null, '');
        if (good.size === items.length) errors.push(...checkErrors(mod, '', ctx.checkStatutes(items)));
        out.statutes = items;
      }
    }

    // rulesets
    if (content.rulesets !== undefined) {
      const items = list(content.rulesets, 'rulesets');
      if (items) {
        const good = flatIds('rulesets', items, ctx.baseRulesetIds, RULESET_ID_RE, 'a ruleset id usable as a file name (/^[a-z][a-z0-9-]{1,39}$/)');
        items.forEach((r, i) => {
          if (good.has(i)) errors.push(...checkErrors(mod, `rulesets[${i}]`, ctx.checkRuleset(r, `${(r as { id: string }).id}.json`)));
        });
        out.rulesets = items;
      }
    }

    // vehicles
    if (content.vehicles !== undefined) {
      const items = list(content.vehicles, 'vehicles');
      if (items) {
        const good = flatIds('vehicles', items, ctx.baseVehicleIds, VEHICLE_ID_RE, 'a vehicle id usable as a file name (/^[a-z][a-z0-9_]{1,39}$/)');
        items.forEach((v, i) => {
          if (good.has(i)) errors.push(...checkErrors(mod, `vehicles[${i}]`, ctx.checkVehicle(v, `${(v as { id: string }).id}.json`)));
        });
        out.vehicles = items;
      }
    }

    // uniforms
    if (content.uniforms !== undefined) {
      const u = content.uniforms;
      if (!isRecord(u)) add('uniforms', `must be an object, got ${show(u)}`);
      else {
        const before = errors.length;
        unknownKeys(u, ['classes', 'department'], 'uniforms');
        if (u.classes === undefined && u.department === undefined) add('uniforms', 'must set classes or department');
        const seen = new Set<string>();
        const classes = u.classes === undefined ? [] : list(u.classes, 'uniforms.classes');
        classes?.forEach((c, i) => {
          const p = `uniforms.classes[${i}]`;
          if (!isRecord(c)) {
            add(p, `must be an object, got ${show(c)}`);
          } else if (typeof c.id !== 'string' || !ctx.uniformClassIds.includes(c.id)) {
            add(`${p}.id`, `unknown uniform class ${show(c.id)} (patches can change: ${ctx.uniformClassIds.join(', ')})`);
          } else if (seen.has(c.id)) {
            add(`${p}.id`, `duplicates ${show(c.id)}`);
          } else seen.add(c.id);
        });
        if (u.department !== undefined && !isRecord(u.department)) add('uniforms.department', `must be an object, got ${show(u.department)}`);
        if (errors.length === before) {
          const patch = { classes: (u.classes ?? []) as ({ id: string } & Record<string, unknown>)[], department: (u.department ?? null) as Record<string, unknown> | null };
          errors.push(...checkErrors(mod, 'uniforms', ctx.checkUniforms([patch])));
        }
        out.uniforms = u;
      }
    }

    // districts
    if (content.districts !== undefined) {
      const d = content.districts;
      if (!isRecord(d)) add('districts', `must be an object, got ${show(d)}`);
      else {
        if (Object.keys(d).length === 0) add('districts', 'must not be empty');
        for (const [key, patch] of Object.entries(d)) {
          const p = `districts.${key}`;
          if (!ctx.districts.includes(key)) {
            add(p, `unknown district ${show(key)} (known: ${ctx.districts.join(', ')})`);
            continue;
          }
          if (!isRecord(patch)) {
            add(p, `must be an object, got ${show(patch)}`);
            continue;
          }
          unknownKeys(patch, ['label', 'crimeFactor', 'trustBaseline'], p);
          if (patch.label === undefined && patch.crimeFactor === undefined && patch.trustBaseline === undefined) {
            add(p, 'must set label, crimeFactor or trustBaseline');
          }
          if (patch.label !== undefined) text(patch.label, `${p}.label`, 1, 40);
          if (patch.crimeFactor !== undefined) num(patch.crimeFactor, `${p}.crimeFactor`, CRIME_FACTOR);
          if (patch.trustBaseline !== undefined) num(patch.trustBaseline, `${p}.trustBaseline`, TRUST_BASELINE);
        }
        out.districts = d as ModContent['districts'];
      }
    }

    // voicePacks
    if (content.voicePacks !== undefined) {
      const items = list(content.voicePacks, 'voicePacks');
      if (items) {
        const seen = new Set<string>();
        items.forEach((pack, i) => {
          const p = `voicePacks[${i}]`;
          if (!isRecord(pack)) {
            add(p, `must be an object, got ${show(pack)}`);
            return;
          }
          const before = errors.length;
          unknownKeys(pack, ['id', 'name', 'voices', 'phrases'], p);
          const id = slug(pack.id, `${p}.id`, ID_RE, 'a pack id (/^[a-z0-9][a-z0-9-]{1,39}$/)');
          if (id !== null) {
            if (seen.has(id)) add(`${p}.id`, `duplicates ${show(id)}`);
            seen.add(id);
          }
          text(pack.name, `${p}.name`, 1, 60);
          if (!isRecord(pack.voices)) add(`${p}.voices`, `must be an object, got ${show(pack.voices)}`);
          else {
            for (const [kind, v] of Object.entries(pack.voices)) {
              const vp = `${p}.voices.${kind}`;
              if (!(VOICE_PACK_KINDS as readonly string[]).includes(kind)) {
                add(vp, `unknown voice kind (expected one of ${VOICE_PACK_KINDS.join(', ')})`);
              } else if (!isRecord(v)) add(vp, `must be an object, got ${show(v)}`);
              else {
                unknownKeys(v, ['pitch', 'rate', 'prefer'], vp);
                for (const key of ['pitch', 'rate'] as const) {
                  const pair = v[key];
                  if (!Array.isArray(pair) || pair.length !== 2) {
                    add(`${vp}.${key}`, `must be a [min, max] pair of numbers, got ${show(pair)}`);
                    continue;
                  }
                  const lo = num(pair[0], `${vp}.${key}[0]`, VOICE_RANGE);
                  const hi = num(pair[1], `${vp}.${key}[1]`, VOICE_RANGE);
                  if (lo !== null && hi !== null && lo > hi) add(`${vp}.${key}`, `min ${lo} must not exceed max ${hi}`);
                }
                if (!Array.isArray(v.prefer)) add(`${vp}.prefer`, `must be an array of strings, got ${show(v.prefer)}`);
                else {
                  if (v.prefer.length > MAX_PREFER) add(`${vp}.prefer`, `must have at most ${MAX_PREFER} entries, got ${v.prefer.length}`);
                  v.prefer.forEach((s, k) => {
                    text(s, `${vp}.prefer[${k}]`, 1, 40);
                  });
                }
              }
            }
          }
          if (pack.phrases !== undefined) {
            const pp = `${p}.phrases`;
            if (!isRecord(pack.phrases)) add(pp, `must be an object, got ${show(pack.phrases)}`);
            else {
              for (const [kind, lines] of Object.entries(pack.phrases)) {
                const kp = `${pp}.${kind}`;
                if (!ctx.phraseKinds.includes(kind)) {
                  add(kp, `unknown phrase kind (expected one of ${ctx.phraseKinds.join(', ')})`);
                } else if (!isRecord(lines)) add(kp, `must be an object, got ${show(lines)}`);
                else {
                  unknownKeys(lines, ['tenCode', 'plain'], kp);
                  if (lines.tenCode === undefined && lines.plain === undefined) add(kp, 'must set tenCode or plain');
                  for (const mode of ['tenCode', 'plain'] as const) {
                    const arr = lines[mode];
                    if (arr === undefined) continue;
                    const lp = `${kp}.${mode}`;
                    const entries = list(arr, lp);
                    entries?.forEach((s, k) => {
                      text(s, `${lp}[${k}]`, 1, 240);
                    });
                  }
                }
              }
            }
          }
          if (errors.length === before && pack.phrases !== undefined) {
            errors.push(...checkErrors(mod, `${p}.phrases`, ctx.checkPhrases(pack.phrases as VoicePackDef['phrases'])));
          }
        });
        out.voicePacks = items as ModContent['voicePacks'];
      }
    }

    // dispatchScripts
    if (content.dispatchScripts !== undefined) {
      const items = list(content.dispatchScripts, 'dispatchScripts');
      if (items) {
        const seen = new Set<string>();
        const extra = [...ownTypeIds.keys()];
        items.forEach((s, i) => {
          const p = `dispatchScripts[${i}]`;
          const before = errors.length;
          errors.push(...checkErrors(mod, p, ctx.checkScript(s, extra)));
          if (errors.length === before && isRecord(s) && typeof s.id === 'string') {
            if (seen.has(s.id)) add(`${p}.id`, `duplicates ${show(s.id)}`);
            else if (ctx.baseScriptIds.includes(s.id)) add(`${p}.id`, `${show(s.id)} already exists in the base game`);
            seen.add(s.id);
          }
        });
        out.dispatchScripts = items;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const bundle = JSON.parse(canonicalJson({ ...json, content: out })) as ModBundle;
  return { ok: true, mod: bundle };
}

// --- Live context ---------------------------------------------------------------------------------------------

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function attempt(fn: () => void): string[] {
  try {
    fn();
    return [];
  } catch (e) {
    return [message(e)];
  }
}

const BASE_TYPE_GLOB = import.meta.glob<unknown>('../data/calls/types/*.json', { eager: true, import: 'default' });

function baseTypeFiles(): { file: string; json: unknown }[] {
  return Object.keys(BASE_TYPE_GLOB)
    .sort()
    .map((path) => ({ file: `types/${path.slice(path.lastIndexOf('/') + 1)}`, json: BASE_TYPE_GLOB[path] }));
}

function idOfDoc(x: unknown): string | null {
  return isRecord(x) && typeof x.id === 'string' ? x.id : null;
}

/** Ids the active overlay added to the live tables (they are not "base game" ids). */
function overlayIds(): { callTypes: Set<string>; statutes: Set<string>; rulesets: Set<string>; vehicles: Set<string> } {
  const o = modOverlay();
  const callTypes = new Set<string>();
  for (const f of o.callTypes) {
    const types = isRecord(f.json) && Array.isArray(f.json.types) ? (f.json.types as unknown[]) : [];
    for (const t of types) {
      const id = idOfDoc(t);
      if (id !== null) callTypes.add(id);
    }
  }
  const ids = (docs: readonly unknown[]): Set<string> => new Set(docs.map(idOfDoc).filter((x): x is string => x !== null));
  return { callTypes, statutes: ids(o.statutes), rulesets: ids(o.rulesets.map((r) => r.json)), vehicles: ids(o.vehicles.map((v) => v.json)) };
}

/**
 * The context for the real game: ids of the base game (without mods that are active right now) and the throwing
 * validators of the data modules wrapped into message lists. This is the only function that uses the live data
 * modules; `boot.ts` must never import this file.
 */
export function defaultModContext(): ModValidationContext {
  const mine = overlayIds();
  const without = (all: Iterable<string>, drop: ReadonlySet<string>): Set<string> => new Set([...all].filter((id) => !drop.has(id)));
  const baseStatutes = (statutesJson as { statutes: unknown[] }).statutes.length;
  const dispositions = DISPOSITIONS.map((d) => d.id);
  const cadCtx = { dispositions, codeKeys: Object.keys(TEN_CODES.codes) };
  return {
    baseCallTypeIds: without(CALL_TYPES.map((t) => t.id), mine.callTypes),
    familyIds: new Set(CALL_CATALOG.families.map((f) => f.id)),
    baseVehicleIds: without(VEHICLE_MODELS.map((m) => m.id), mine.vehicles),
    baseRulesetIds: without(RULESETS.keys(), mine.rulesets),
    baseStatuteIds: without(STATUTES.map((s) => s.id), mine.statutes),
    baseScriptIds: BUILTIN_SCRIPTS.map((x) => x.id),
    districts: [...DISTRICT_NAMES],
    uniformClassIds: [...UNIFORM_CLASSES],
    phraseKinds: [...PHRASE_KINDS],
    checkCallTypes(files) {
      const input = {
        families: familiesJson,
        types: [...baseTypeFiles(), ...files],
        actions: actionsJson,
        services: servicesJson,
        variants: variantsJson,
        legacy: legacyJson,
      };
      const catalog = attempt(() => {
        validateCatalog(input, { dispositions, crimeCategories: CRIME_CATEGORIES, trunkItems: TRUNK_ITEMS.map((t) => t.id) });
      });
      if (catalog.length > 0) return catalog;
      return attempt(() => {
        validateCallTypes({ version: 1, types: mergeCadRows(familiesJson, input.types) }, cadCtx, 'calls/types/*.json');
      });
    },
    checkVehicle: (json, source) =>
      attempt(() => {
        parseModVehicle(json, source);
      }),
    checkRuleset: (json, file) =>
      attempt(() => {
        parseRuleset(json, file);
      }),
    checkStatutes: (rows) =>
      attempt(() => {
        validateStatutes(mergeStatutes(statutesJson, rows));
      }).map((m) => m.replace(/statutes\[(\d+)\]/g, (all, n: string) => (Number(n) >= baseStatutes ? `statutes[${Number(n) - baseStatutes}]` : all))),
    checkUniforms: (patches) =>
      attempt(() => {
        parseUniformData(applyUniformPatches(uniformsJson, patches), 'uniforms.json');
      }),
    checkPhrases: (phrases) =>
      attempt(() => {
        validatePhrases(mergePhrases(phrasesJson, phrases));
      }).map((m) => m.replace(/\bkinds\.(\w+)/, '$1')),
    checkScript(json, extraCallTypeIds = []) {
      const base = defaultScriptContext();
      const r = parseDispatchScript(json, { ...base, callTypeIds: new Set([...base.callTypeIds, ...extraCallTypeIds]) });
      return r.ok ? [] : r.errors;
    },
  };
}
