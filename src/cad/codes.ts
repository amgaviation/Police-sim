/** Ten-code / plain-language text of coded phrases and unit statuses (design §6.2). */
import { TEN_CODES } from './data';
import type { PlateReadback, RadioMode, UnitStatus } from './types';

/** "10-8" (tenCode) or "in service" (plain); throws on an unknown key. */
export function codeText(key: string, mode: RadioMode): string {
  const c = Object.hasOwn(TEN_CODES.codes, key) ? TEN_CODES.codes[key] : undefined;
  if (!c) throw new Error(`Unknown ten-code key "${key}"`);
  return mode === 'tenCode' ? c.code : c.plain;
}

export function statusText(status: UnitStatus, mode: RadioMode): string {
  return codeText(TEN_CODES.statusKeys[status], mode);
}

/** "enRoute" -> "EN ROUTE". */
function statusWords(status: UnitStatus): string {
  return status.replace(/([A-Z])/g, ' $1').toUpperCase();
}

const LABELS = new Map<UnitStatus, string>();

/** "10-8 AVAILABLE", "10-76 EN ROUTE" for UIs (cached, no allocation after the first call). */
export function statusLabel(status: UnitStatus): string {
  let label = LABELS.get(status);
  if (label === undefined) {
    label = `${statusText(status, 'tenCode')} ${statusWords(status)}`;
    LABELS.set(status, label);
  }
  return label;
}

/** CAD narrative line of a plate run on a traffic stop ("Plate ABC 1234: 2019 BLACK SEDAN, RO DOE, JOHN - HIT; HIT"). */
export function plateRunNarrative(r: PlateReadback): string {
  const hits = r.hits.length > 0 ? ` - ${r.hits.join('; ')}` : '';
  return r.found ? `Plate ${r.plate}: ${r.description.toUpperCase()}, RO ${r.owner}${hits}` : `Plate ${r.plate}: NO RECORD`;
}
