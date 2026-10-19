/**
 * Evidence data table (design phase 4 §9.5): canvass odds and texts, item labels. Validated at import; every
 * error names the file and the field.
 */
import evidenceJson from '../data/evidence/evidence.json';
import {
  fail,
  readNumber,
  readObject,
  readString,
  readVersion,
} from '../vehicles/json';

export const CANVASS_RESULTS = ['noAnswer', 'nothingSeen', 'refused', 'sawSomething'] as const;
export type CanvassTextKey = (typeof CANVASS_RESULTS)[number];
export const CANVASS_PLACEHOLDERS = ['address', 'description', 'direction'] as const;

export interface EvidenceData {
  /** Chance a resident saw something, by call kind; `default` always present. */
  readonly sawChance: Readonly<Record<string, number>>;
  readonly canvassTexts: Readonly<Record<CanvassTextKey, string>>;
  /** Display labels; `latentPrint` always present. */
  readonly labels: Readonly<Record<string, string>>;
}

const FILE = 'evidence/evidence.json';

function checkPlaceholders(text: string, path: string): void {
  for (const m of text.matchAll(/\{([^}]*)\}/g)) {
    const name = m[1] ?? '';
    if (!(CANVASS_PLACEHOLDERS as readonly string[]).includes(name)) {
      fail(FILE, path, `has unknown placeholder {${name}} (allowed: ${CANVASS_PLACEHOLDERS.join(', ')})`);
    }
  }
}

/** Strict validator; throws `Error` naming the file and the JSON path. */
export function validateEvidenceData(raw: unknown): EvidenceData {
  const root = readObject(raw, FILE, '');
  readVersion(root, FILE);

  const sawRaw = readObject(root.sawChance, FILE, 'sawChance');
  const sawChance: Record<string, number> = {};
  for (const key of Object.keys(sawRaw)) sawChance[key] = readNumber(sawRaw[key], FILE, `sawChance.${key}`, 0, 1);
  if (sawChance.default === undefined) fail(FILE, 'sawChance.default', 'is required');

  const textsRaw = readObject(root.canvassTexts, FILE, 'canvassTexts');
  const texts = {} as Record<CanvassTextKey, string>;
  for (const key of CANVASS_RESULTS) {
    const text = readString(textsRaw[key], FILE, `canvassTexts.${key}`);
    checkPlaceholders(text, `canvassTexts.${key}`);
    texts[key] = text;
  }
  for (const key of Object.keys(textsRaw)) {
    if (!(CANVASS_RESULTS as readonly string[]).includes(key)) fail(FILE, `canvassTexts.${key}`, 'is not a canvass result');
  }

  const labelsRaw = readObject(root.labels, FILE, 'labels');
  const labels: Record<string, string> = {};
  for (const key of Object.keys(labelsRaw)) labels[key] = readString(labelsRaw[key], FILE, `labels.${key}`);
  if (labels.latentPrint === undefined) fail(FILE, 'labels.latentPrint', 'is required');

  return { sawChance, canvassTexts: texts, labels };
}

export const EVIDENCE_DATA: EvidenceData = validateEvidenceData(evidenceJson);

/** Saw-something chance for a call kind, falling back to `default`. */
export function sawChanceFor(kind: string, data: EvidenceData = EVIDENCE_DATA): number {
  return data.sawChance[kind] ?? data.sawChance.default ?? 0;
}

/** Fills a canvass text template; unknown placeholders are left out. */
export function canvassText(
  result: CanvassTextKey,
  vars: { address: string; description?: string; direction?: string },
  data: EvidenceData = EVIDENCE_DATA,
): string {
  return data.canvassTexts[result].replace(/\{(\w+)\}/g, (_, name: string) => {
    if (name === 'address') return vars.address;
    if (name === 'description') return vars.description ?? 'someone';
    return vars.direction ?? 'away';
  });
}
