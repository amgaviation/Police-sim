import { isActionId } from '../input/actions';

const TOKEN = /\{([A-Za-z][A-Za-z0-9_.]*)\}/g;

/**
 * Replaces `{actionId}` tokens with `labelOf(actionId)` (the current key label). Unknown tokens (not an `ActionId`, or
 * a label that comes back empty) stay as written. Pure.
 */
export function formatTutorialText(text: string, labelOf: (actionId: string) => string): string {
  return text.replace(TOKEN, (whole: string, id: string) => {
    if (!isActionId(id)) return whole;
    const label = labelOf(id);
    return label === '' ? whole : label;
  });
}

/** The distinct `{token}` ids of a text, in order of first appearance (for validation and tests). */
export function tutorialTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const id = m[1];
    if (id !== undefined && !out.includes(id)) out.push(id);
  }
  return out;
}
