import type { NetRole, NetUnit } from '../../net';
import { ActionPanel, type ActionPanelModel, type PanelOption } from '../panels/actionPanel';
import type { UIRoot } from '../ui';
import { LinePrompt } from './prompt';

export interface CoopPanelState {
  members: readonly NetUnit[];
  /** Own callsign. */
  self: string;
  /** Callsign of the current partner, null when none. */
  partner: string | null;
  /** Recent orders, oldest first, already formatted ('N2: respond to 25-0004'). */
  orders: readonly string[];
}

export type CoopIntent = { kind: 'partner'; unit: string } | { kind: 'radio' } | { kind: 'disconnect' };

/** How many recent orders the panel lists. */
export const ORDER_ROWS = 3;

const ROLE_ORDER: readonly NetRole[] = ['patrol', 'dispatcher', 'supervisor'];
const ROLE_NAMES: Readonly<Record<NetRole, string>> = { patrol: 'patrol', dispatcher: 'dispatcher', supervisor: 'supervisor' };

function statusText(status: string): string {
  return status.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Patrol officers first, then the dispatcher and the supervisor; callsigns in natural order. */
export function sortMembers(members: readonly NetUnit[]): NetUnit[] {
  return [...members].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.callsign.localeCompare(b.callsign, 'en', { numeric: true }));
}

function canRequestPartner(s: CoopPanelState, m: NetUnit, selfRole: NetRole | undefined): boolean {
  return selfRole === 'patrol' && m.role === 'patrol' && m.callsign !== s.self && m.callsign !== s.partner;
}

/**
 * The co-op panel as an `ActionPanel` model: one row per member (patrol members you can partner with are selectable),
 * then "Send radio line...", "Disconnect", then the last orders as read-only rows. `coopPanelIntent` maps a picked row
 * back to what to do.
 */
export function coopPanelModel(s: CoopPanelState): ActionPanelModel {
  const members = sortMembers(s.members);
  const selfRole = s.members.find((m) => m.callsign === s.self)?.role;
  const options: PanelOption[] = members.map((m) => {
    const tags = [m.callsign === s.self ? 'you' : null, m.callsign === s.partner ? 'partner' : null].filter((t) => t !== null);
    const label = `${m.callsign} ${m.name}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
    const call = m.callId !== null ? ` · call ${String(m.callId)}` : '';
    return { label, detail: `${ROLE_NAMES[m.role]} · ${statusText(m.status)}${call}`, enabled: canRequestPartner(s, m, selfRole) };
  });
  options.push({ label: 'Send radio line…' }, { label: 'Disconnect' });
  const recent = s.orders.slice(-ORDER_ROWS).reverse();
  if (recent.length === 0) options.push({ label: 'No orders yet', enabled: false });
  else for (const o of recent) options.push({ label: `Order: ${o}`, enabled: false });
  return {
    title: 'Co-op',
    subtitle: `${String(members.length)} online · you are ${s.self}${s.partner !== null ? ` · partner ${s.partner}` : ''}`,
    options,
    footer: 'Pick a patrol officer to ask them to partner · ↑↓ Enter · Esc close',
  };
}

/** What picking row `index` of `coopPanelModel(s)` means; null for rows that do nothing. */
export function coopPanelIntent(s: CoopPanelState, index: number): CoopIntent | null {
  const members = sortMembers(s.members);
  const selfRole = s.members.find((m) => m.callsign === s.self)?.role;
  const m = members[index];
  if (m) return canRequestPartner(s, m, selfRole) ? { kind: 'partner', unit: m.callsign } : null;
  if (index === members.length) return { kind: 'radio' };
  if (index === members.length + 1) return { kind: 'disconnect' };
  return null;
}

/** What the panel needs from the co-op session. */
export interface CoopPanelHost {
  state(): CoopPanelState;
  requestPartner(unit: string): void;
  sendRadio(text: string): void;
  disconnect(): void;
}

/**
 * The non-pausing co-op panel (`coop.menu`): an `ActionPanel` over `coopPanelModel` plus a one-line prompt for the radio
 * line. The app calls `update()` a few times a second while it is open.
 */
export class CoopPanel {
  private readonly host: CoopPanelHost;
  private readonly panel: ActionPanel;
  private readonly prompt: LinePrompt;
  private key = '';

  constructor(ui: UIRoot | null, host: CoopPanelHost) {
    this.host = host;
    this.panel = new ActionPanel(ui);
    this.prompt = new LinePrompt(ui);
  }

  get isOpen(): boolean {
    return this.panel.isOpen || this.prompt.isOpen;
  }

  /** The panel model currently shown (null before the first open). */
  get model(): ActionPanelModel | null {
    return this.panel.model;
  }

  open(): void {
    const model = coopPanelModel(this.host.state());
    this.key = JSON.stringify(model);
    this.panel.open(model, (i) => this.pick(i));
  }

  close(): void {
    this.panel.close();
    this.prompt.close();
  }

  /** Refreshes the rows when the members, partner or orders changed. */
  update(): void {
    if (!this.panel.isOpen) return;
    const model = coopPanelModel(this.host.state());
    const key = JSON.stringify(model);
    if (key === this.key) return;
    this.key = key;
    this.panel.update(model);
  }

  /** Picks row `index` (what a key or click does). */
  pick(index: number): void {
    const intent = coopPanelIntent(this.host.state(), index);
    if (!intent) return;
    switch (intent.kind) {
      case 'partner':
        this.host.requestPartner(intent.unit);
        break;
      case 'radio':
        this.panel.close();
        this.prompt.open((text) => this.host.sendRadio(text));
        break;
      case 'disconnect':
        this.panel.close();
        this.host.disconnect();
        break;
    }
  }
}
