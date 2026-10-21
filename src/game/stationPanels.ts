/** Phase 4 panel models that need the session: the door panel and the partner panel (design §13). */
import type { PartnerCommand } from '../tactical';
import type { ActionPanelModel } from '../ui/panels/actionPanel';
import type { DoorTarget, GameSession } from './session';

/** Door panel rows, in order. */
export const DOOR_ACTIONS = ['knock', 'announce', 'toggle', 'kick', 'ram', 'lock', 'canvass', 'enter'] as const;
export type DoorPanelAction = (typeof DOOR_ACTIONS)[number];

/** Partner panel rows: the command each one sends ('dismiss' becomes 'summon' while the partner is away). */
export const PARTNER_COMMANDS: readonly PartnerCommand[] = ['follow', 'stack', 'clear', 'hold', 'dismiss'];

const KIND_LABEL: Readonly<Record<string, string>> = {
  house: 'House',
  apartment: 'Apartment',
  convenienceStore: 'Convenience store',
  bank: 'Bank',
  bar: 'Bar',
  hospital: 'Hospital',
  school: 'School',
  warehouse: 'Warehouse',
  office: 'Office',
  parkingStructure: 'Parking structure',
  jail: 'Jail',
  policeStation: 'Police station',
};

/** 'House', 'Convenience store'... for a building kind id. */
export function buildingLabel(kind: string): string {
  return KIND_LABEL[kind] ?? 'Building';
}

/** Door panel for `t`: Knock, Announce, Open / Close, Kick, Force entry (needs the ram or a Halligan), Lock / Unlock, Knock (canvass), Enter. */
export function doorPanelModel(session: GameSession, t: DoorTarget): ActionPanelModel {
  const layout = session.interiors.layout(t.buildingId);
  const d = layout?.doors[t.door];
  const state = session.interiors.doorState(t.buildingId, t.door);
  const closed = state === 'closed' || state === 'locked';
  const wide = d?.kind === 'wide';
  // The ram or a Halligan bar forces a door (`InteriorSystem.breach`).
  const hasTool = session.officerKit.carried('ram') > 0 || session.officerKit.carried('halligan') > 0;
  const canvass = t.outdoors && session.canvassAllowed(t.buildingId);
  return {
    title: wide ? 'Opening' : 'Door',
    subtitle: `${buildingLabel(layout?.kind ?? '')} · ${state}`,
    options: [
      { label: 'Knock', enabled: !wide },
      { label: 'Announce "Police!"', enabled: !wide },
      { label: state === 'open' ? 'Close' : 'Open', detail: state === 'locked' ? 'Locked' : state === 'broken' ? 'Broken' : '', enabled: !wide && (state === 'open' || state === 'closed') },
      { label: 'Kick', detail: d && d.strength >= 0.95 ? 'Unbreachable' : '', enabled: !wide && closed && (d?.strength ?? 0) < 0.95 },
      { label: 'Force entry', detail: hasTool ? '' : 'No ram or Halligan (trunk)', enabled: !wide && hasTool && closed && (d?.strength ?? 0) < 0.95 },
      { label: state === 'locked' ? 'Unlock' : 'Lock', detail: d?.lockable ? '' : 'No lock', enabled: !wide && d?.lockable === true && state !== 'broken' && state !== 'open' },
      { label: 'Knock (canvass)', detail: t.outdoors ? (canvass ? 'Neighbour' : 'No call nearby') : 'Outside only', enabled: canvass },
      { label: 'Enter', detail: !t.outdoors ? 'From outside' : state === 'locked' ? 'Locked' : '', enabled: t.outdoors && state !== 'locked' },
    ],
    footer: '1-8 select · Esc close',
  };
}

/** Sends the request of door panel row `index`; returns a HUD line (or null). */
export function doorPanelRequest(session: GameSession, t: DoorTarget, index: number): string | null {
  const action = DOOR_ACTIONS[index];
  if (action === undefined) return null;
  if (action === 'canvass') {
    session.investigation.request({ kind: 'canvass', buildingId: t.buildingId });
    return null;
  }
  if (action === 'enter') {
    session.interiors.request({ kind: 'enter', buildingId: t.buildingId, door: t.door });
    return null;
  }
  const state = session.interiors.doorState(t.buildingId, t.door);
  const req = action === 'toggle' ? (state === 'open' ? 'close' : 'open') : action === 'lock' ? (state === 'locked' ? 'unlock' : 'lock') : action;
  session.interiors.request({ kind: 'door', buildingId: t.buildingId, door: t.door, action: req });
  return null;
}

/** Partner panel: Follow, Stack on door, Clear room, Hold, Dismiss / Summon. */
export function partnerPanelModel(session: GameSession): ActionPanelModel {
  const mode = session.tactical.partner.mode;
  const away = mode === 'away';
  return {
    title: 'Partner',
    subtitle: away ? 'Not on scene' : `Mode: ${mode}`,
    options: [
      { label: 'Follow me', enabled: !away },
      { label: 'Stack on the door', enabled: !away },
      { label: 'Clear the room', enabled: !away },
      { label: 'Hold position', enabled: !away },
      { label: away ? 'Summon' : 'Dismiss' },
    ],
    footer: '1-5 select · Esc close',
  };
}
