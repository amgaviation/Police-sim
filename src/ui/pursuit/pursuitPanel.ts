/**
 * Pursuit tactics panel model (Phase 6 design §12.2): pure. The entries come from `PursuitSystem.menu()` (enabled and
 * hint are decided by the pursuit module); a pick becomes a `PursuitRequest` for `PursuitSystem.request`.
 */
import type { PursuitHud, PursuitMenuItem, PursuitRequest } from '../../pursuit/types';
import type { ActionPanelModel, PanelOption } from '../panels/actionPanel';

/** Panel wording per request kind (the pursuit module's own labels are the fallback). */
export const PURSUIT_PANEL_LABELS: Readonly<Record<PursuitRequest['kind'], string>> = {
  requestPit: 'Request PIT authorization',
  spikesAhead: 'Spike strip ahead (AI unit)',
  deployStrip: 'Deploy my spike strip',
  boxIn: 'Box in',
  roadblock: 'Roadblock',
  air: 'Request air unit',
  perimeter: 'Set a perimeter',
};

/** Subtitle without a pursuit. */
export const PURSUIT_IDLE_TEXT = 'No pursuit in progress';

function label(item: PursuitMenuItem): string {
  return PURSUIT_PANEL_LABELS[item.id] ?? item.label;
}

/** Title 'Pursuit tactics', the live pursuit line as subtitle, one row per tactic (disabled rows carry the hint). */
export function pursuitPanelModel(menu: readonly PursuitMenuItem[], hud: PursuitHud | null): ActionPanelModel {
  const options: PanelOption[] = menu.map((m) => {
    if (m.enabled) return m.hint === '' ? { label: label(m) } : { label: label(m), detail: m.hint };
    return { label: label(m), detail: m.hint === '' ? 'Not available' : m.hint, enabled: false };
  });
  const base: ActionPanelModel = { title: 'Pursuit tactics', subtitle: hud ? hud.line : PURSUIT_IDLE_TEXT, options };
  return hud?.verdict ? { ...base, footer: hud.verdict } : base;
}

/** The request of option `index`, null when out of range or disabled. */
export function pursuitPanelPick(index: number, menu: readonly PursuitMenuItem[]): PursuitRequest | null {
  const item = Number.isInteger(index) && index >= 0 ? menu[index] : undefined;
  if (!item?.enabled) return null;
  return { kind: item.id };
}
