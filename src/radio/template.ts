/** Phrase template filling: `{name}` from a value table, `{code:<key>}` from the CAD ten-code table. */
import { codeText } from '../cad/codes';
import type { RadioMode } from '../cad/types';

export type TemplateValues = Readonly<Partial<Record<string, string>>>;

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** Fills a template; unknown names become ''. Doubled separators left by empty values are tidied. */
export function fillTemplate(template: string, values: TemplateValues, mode: RadioMode): string {
  const text = template.replace(PLACEHOLDER, (_m, name: string) => {
    if (name.startsWith('code:')) return codeText(name.slice(5), mode);
    return values[name] ?? '';
  });
  return text
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** "21", "21 and 23", "21, 23 and 25". */
export function joinUnits(units: readonly string[]): string {
  if (units.length <= 1) return units[0] ?? '';
  return `${units.slice(0, -1).join(', ')} and ${units[units.length - 1] ?? ''}`;
}
