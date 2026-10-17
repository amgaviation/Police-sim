/**
 * Composer (design §9.3): turns cad:*, dispatch:* and traffic:pullingOver events and the player's
 * requests into queued radio traffic, in the radio mode current at compose time. Draws only from the
 * radio stream.
 *
 * Voicing rule: answers to player requests sent by radio or voice are spoken; answers to MDT / key /
 * automatic requests are silent, except offers, backup, emergencies, status checks and the
 * traffic-stop call-out, which always go on the air. A spoken request is remembered as "pending"
 * until its first answer (or `answerWindowS`), so an answer reported by two events is voiced once.
 */
import type { CadState } from '../cad/cadState';
import { statusLabel, statusText } from '../cad/codes';
import type {
  CadTrafficStopEvent,
  CadUnitAssignedEvent,
  CadUnitStatusEvent,
  DispatchAckEvent,
  DispatchBackupEvent,
  DispatchEmergencyEvent,
  DispatchLocationEvent,
  DispatchOfferEvent,
  DispatchPersonResultEvent,
  DispatchPlateResultEvent,
  DispatchStatusCheckEvent,
} from '../cad/events';
import { UNIT_STATUSES, type RadioMode, type RequestVia, type UnitRequest, type UnitStatus } from '../cad/types';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { plateOf } from '../traffic/registry';
import type { TrafficCarEvent } from '../traffic/events';
import { channelDef, PHRASES, REQUEST_CHANNEL, type FragmentKey, type PhraseKind } from './data';
import type { RadioNet } from './net';
import { fillTemplate, joinUnits, type ModeText, type TemplateValue, type TemplateValues } from './template';
import type { ChannelId, QueuedTransmission, SpeakerKind } from './types';

export interface ComposerHost {
  readonly net: RadioNet;
  readonly rng: Rng;
  readonly cad: CadState;
  readonly seed: number;
  readonly player: string;
  mode(): RadioMode;
  /** "Oak Street at 5th Street" for the player's last known position (a mode fragment when unknown). */
  playerNear(): TemplateValue;
}

export interface PendingAnswer {
  kind: UnitRequest['kind'];
  /** Sim time the request was sent. */
  at: number;
}

export interface ComposerSave {
  pending: PendingAnswer[];
  answered: PendingAnswer[];
  expectLocation: boolean;
  answeringLocation: boolean;
  pulling: number;
}

export function emptyComposerSave(): ComposerSave {
  return { pending: [], answered: [], expectLocation: false, answeringLocation: false, pulling: -1 };
}

interface LineOptions {
  readonly speaker: string;
  readonly speakerKind: SpeakerKind;
  readonly values: TemplateValues;
  readonly channel?: ChannelId;
  /** Seconds from now (ignored with `follows`). */
  readonly delay?: number;
  readonly follows?: { readonly id: number } | null;
  readonly gap?: number;
  readonly to?: string;
  readonly priority?: boolean;
  readonly waitClear?: boolean;
  readonly request?: UnitRequest | null;
  readonly via?: RequestVia | null;
}

/** Routine unit traffic that is dropped, not delayed, by an emergency hold. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set(['enRoute', 'onScene', 'clear', 'status', 'dispatchAck', 'assign', 'unitAck']);

/** CAD call type of the player's emergency (dispatched units are named by the priority broadcast). */
const EMERGENCY_CALL_TYPE = 'officerEmergency';

/** Gap between two of the player's own transmissions (s): one key-up after the other, never over it. */
const OWN_KEY_GAP_S = 0.3;

/** Answers that richer events report; a dispatch:ack for these is not voiced again. */
const ACK_COVERED: ReadonlySet<UnitRequest['kind']> = new Set(['runPlate', 'runPerson', 'backup', 'location', 'emergency', 'repeat', 'stopContact']);

function isRadioVia(via: RequestVia | undefined): boolean {
  return via === 'radio' || via === 'voice';
}

function stripEnd(text: string): string {
  return text.trim().replace(/[.!?]+$/, '');
}

/** A unit status in both radio modes (the template picks the current one). */
function statusValue(status: UnitStatus): ModeText {
  return { tenCode: statusText(status, 'tenCode'), plain: statusText(status, 'plain') };
}

/**
 * The reason of a refusal for the 'refused' template ("12, unable, {reason}."): the CAD/MDT text without
 * its leading "Unable:", with status labels ("10-8 AVAILABLE") worded in the radio mode.
 */
export function refusalReason(text: string): TemplateValue {
  const full = stripEnd(text);
  const t = full.replace(/^unable:?\s*/i, '');
  if (t === '') return full;
  let tenCode = t;
  let plain = t;
  for (const s of UNIT_STATUSES) {
    const label = statusLabel(s);
    if (!t.includes(label)) continue;
    tenCode = tenCode.split(label).join(statusText(s, 'tenCode'));
    plain = plain.split(label).join(statusText(s, 'plain'));
  }
  return tenCode === plain ? tenCode : { tenCode, plain };
}

export class Composer {
  private readonly host: ComposerHost;
  private readonly offs: (() => void)[] = [];
  private pending: PendingAnswer[] = [];
  private answered: PendingAnswer[] = [];
  private expectLocation = false;
  private answeringLocation = false;
  private pulling = -1;
  /** The last status-check line queued (not saved: the 10-20 question is queued in the same tick). */
  private lastCheckLine: QueuedTransmission | null = null;

  constructor(host: ComposerHost, bus: EventBus<EventMap>) {
    this.host = host;
    this.offs.push(
      bus.on('cad:unitStatus', (e) => this.onUnitStatus(e)),
      bus.on('cad:unitAssigned', (e) => this.onUnitAssigned(e)),
      bus.on('cad:trafficStop', (e) => this.onTrafficStop(e)),
      bus.on('dispatch:offer', (e) => this.onOffer(e)),
      bus.on('dispatch:plateResult', (e) => this.onPlateResult(e)),
      bus.on('dispatch:personResult', (e) => this.onPersonResult(e)),
      bus.on('dispatch:backup', (e) => this.onBackup(e)),
      bus.on('dispatch:emergency', (e) => this.onEmergency(e)),
      bus.on('dispatch:statusCheck', (e) => this.onStatusCheck(e)),
      bus.on('dispatch:location', (e) => this.onLocation(e)),
      bus.on('dispatch:ack', (e) => this.onAck(e)),
      bus.on('traffic:pullingOver', (e: TrafficCarEvent) => {
        this.pulling = e.vehicleId;
      }),
    );
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
  }

  // --- Text -----------------------------------------------------------------------------------

  /** A fragment in both modes (filled in the mode current when the line is composed). */
  fragment(key: FragmentKey): ModeText {
    return PHRASES.fragments[key];
  }

  /**
   * Queues one line of `kind`. One draw picks the template; the air time comes from the ten-code
   * wording of the same pick, so the radio language (a display setting) never changes sim timing.
   */
  line(kind: PhraseKind, o: LineOptions): QueuedTransmission {
    const net = this.host.net;
    const mode = this.host.mode();
    const values: TemplateValues = { player: this.host.player, time: this.clock(), ...o.values };
    const u = this.host.rng.next();
    const lists = PHRASES.kinds[kind];
    const at = (list: readonly string[]): string => list[Math.min(list.length - 1, Math.floor(u * list.length))] ?? '';
    const text = fillTemplate(at(lists[mode]), values, mode);
    const durationText = mode === 'tenCode' ? text : fillTemplate(at(lists.tenCode), values, 'tenCode');
    return net.enqueue({
      channel: o.channel ?? REQUEST_CHANNEL,
      speaker: o.speaker,
      speakerKind: o.speakerKind,
      text,
      durationText,
      kind,
      earliest: net.now + (o.delay ?? 0),
      priority: o.priority ?? false,
      waitClear: o.waitClear ?? true,
      follows: o.follows ? o.follows.id : -1,
      gap: o.gap ?? 0,
      to: o.to ?? '',
      request: o.request ?? null,
      via: o.via ?? null,
    });
  }

  /** A dispatcher line on `channel` (default dispatch); null on a channel without a dispatcher. */
  dispatcherLine(kind: PhraseKind, to: string, values: TemplateValues, extra: Partial<LineOptions> = {}): QueuedTransmission | null {
    const channel = extra.channel ?? REQUEST_CHANNEL;
    const name = channelDef(channel).dispatcher;
    if (name === null) return null;
    return this.line(kind, {
      speaker: name,
      speakerKind: 'dispatcher',
      to,
      delay: extra.follows ? undefined : (extra.delay ?? this.replyGap()),
      ...extra,
      channel,
      values: { unit: to, ...values },
    });
  }

  replyGap(): number {
    const [lo, hi] = PHRASES.timing.replyGapS;
    return this.host.rng.nextFloat(lo, hi);
  }

  ackGap(): number {
    const [lo, hi] = PHRASES.timing.ackGapS;
    return this.host.rng.nextFloat(lo, hi);
  }

  clock(): string {
    const day = ((Math.floor(this.host.net.game) % 86400) + 86400) % 86400;
    return `${String(Math.floor(day / 3600)).padStart(2, '0')}:${String(Math.floor((day % 3600) / 60)).padStart(2, '0')}`;
  }

  // --- Player requests ------------------------------------------------------------------------

  /**
   * Queues the player's own transmission for `request` on `channel`: keyed immediately (it may step on
   * someone). The request rides along and is acted on when the transmission ends unblocked.
   */
  playerLine(request: UnitRequest, via: RequestVia, channel: ChannelId): QueuedTransmission {
    const player = this.host.player;
    let kind: PhraseKind = 'generic';
    let values: TemplateValues = {};
    switch (request.kind) {
      case 'status':
        kind = 'status';
        values = { status: statusValue(request.status) };
        break;
      case 'acceptCall':
      case 'selfAssign':
        kind = 'accept';
        break;
      case 'declineCall':
        kind = 'decline';
        break;
      case 'clearCall':
        kind = 'clear';
        break;
      case 'runPlate':
        kind = 'plateRequest';
        values = { plate: request.plate !== '' ? request.plate : this.fragment('noPlate') };
        break;
      case 'runPerson':
        kind = 'personRequest';
        break;
      case 'stopContact':
        kind = request.action === 'license' ? 'personRequest' : 'generic';
        break;
      case 'backup':
        kind = 'backupRequest';
        values = { backupCode: this.fragment(request.code === 3 ? 'backupCode3' : 'backupCode2'), near: this.host.playerNear() };
        break;
      case 'location':
        if (this.expectLocation) {
          // An answer to "what's your 10-20?"; `answeringLocation` is set once it went out unblocked.
          kind = 'locationAnswer';
          values = { near: this.host.playerNear() };
          this.expectLocation = false;
        } else {
          kind = 'locationRequest';
        }
        break;
      case 'code4':
        kind = 'code4';
        break;
      case 'emergency':
        kind = 'playerEmergency';
        values = { near: this.host.playerNear() };
        break;
      case 'trafficStop':
        kind = 'trafficStop';
        values = { plate: this.stopPlate(), near: this.stopNear(this.host.cad.trafficStop?.callId ?? -1) };
        break;
      case 'repeat':
        kind = 'repeatRequest';
        break;
      case 'narrative':
        kind = 'generic';
        break;
    }
    // The player cannot key up over their own transmission (the automatic stop call-out, an earlier
    // request): the new line follows it. A radio-menu request waits for a clear channel (the radio
    // holds the press and keys up first when the channel clears); voice PTT and keys go out at once
    // and can step on other traffic.
    // The emergency pre-empts the channel: it only follows an own transmission already on the air,
    // never a queued routine request (that one goes out after the emergency traffic).
    const own = request.kind === 'emergency' ? this.ownOnAir() : this.ownLatest();
    return this.line(kind, {
      speaker: player,
      speakerKind: 'player',
      channel,
      values: { unit: player, ...values },
      waitClear: via === 'radio' && request.kind !== 'emergency',
      follows: own,
      gap: own ? OWN_KEY_GAP_S : 0,
      priority: request.kind === 'emergency',
      request: request.kind === 'repeat' || request.kind === 'emergency' ? null : request,
      via,
    });
  }

  /** The player's latest transmission on the air, null when none. */
  private ownOnAir(): { readonly id: number } | null {
    const air = this.host.net.onAir;
    for (let i = air.length - 1; i >= 0; i--) if (air[i]?.speakerKind === 'player') return air[i] ?? null;
    return null;
  }

  /** The player's latest transmission still waiting or on the air, null when none. */
  private ownLatest(): { readonly id: number } | null {
    const net = this.host.net;
    const pending = net.pending;
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i]?.speakerKind === 'player') return pending[i] ?? null;
    return this.ownOnAir();
  }

  /** A request transmitted by radio/voice was acted on: its answer will be spoken. */
  expectAnswer(kind: UnitRequest['kind']): void {
    this.playerActed(kind);
    this.pending.push({ kind, at: this.host.net.now });
  }

  /** The player's answer to "what's your 10-20?" ended: unblocked, dispatch acknowledges it; blocked, the question stands. */
  locationAnswerEnded(blocked: boolean): void {
    if (blocked) {
      this.expectLocation = true;
      this.answeringLocation = false;
    } else {
      this.answeringLocation = true;
    }
  }

  /** Any other player request answers a status check, so a pending "what's your 10-20?" lapses. */
  private playerActed(kind: UnitRequest['kind']): void {
    if (kind !== 'location') this.expectLocation = false;
  }

  // --- Event handlers -------------------------------------------------------------------------

  private onUnitStatus(e: CadUnitStatusEvent): void {
    const unit = this.host.cad.unit(e.callsign);
    if (!unit) return;
    if (unit.kind === 'player') {
      // Automatic changes (assignment, closing) are consequences, answered by their own events.
      if (e.via === 'auto') return;
      this.playerActed('status');
      if (this.answer(['status'], e.via, false)) this.dispatcherLine('dispatchAck', e.callsign, {});
      return;
    }
    if (e.via !== 'auto') return;
    // Radio silence during an emergency: other units' routine status traffic is not voiced.
    if (this.host.net.isHeld(REQUEST_CHANNEL)) return;
    const kind: PhraseKind =
      e.status === 'enRoute' ? 'enRoute' : e.status === 'onScene' ? 'onScene' : e.status === 'available' ? 'clear' : 'status';
    const said = this.line(kind, {
      speaker: e.callsign,
      speakerKind: 'officer',
      values: { unit: e.callsign, status: statusValue(e.status) },
    });
    if (this.host.rng.chance(PHRASES.timing.dispatchAckChance)) {
      this.dispatcherLine('dispatchAck', e.callsign, {}, { follows: said, gap: this.replyGap() });
    }
  }

  private onUnitAssigned(e: CadUnitAssignedEvent): void {
    const cad = this.host.cad;
    const unit = cad.unit(e.callsign);
    const call = cad.call(e.callId);
    if (!unit || !call) return;
    const values: TemplateValues = {
      nature: call.nature,
      address: call.location.text,
      cross: call.location.cross !== '' ? call.location.cross : call.location.near,
      near: call.location.near,
      priority: String(call.priority),
      call: call.number,
    };
    if (unit.kind === 'player') {
      if (call.selfInitiated && e.by === 'self') return;
      if (this.answer(['acceptCall', 'selfAssign', 'status'], undefined, false)) this.dispatcherLine('assign', e.callsign, values);
      return;
    }
    // The assignment's automatic "en route" is announced by the assignment itself.
    const net = this.host.net;
    net.cancel((q) => q.speaker === e.callsign && q.kind === 'enRoute' && q.earliest >= net.now);
    if (e.by !== 'dispatch') return;
    // Units sent to an officer emergency are named by the priority broadcast; nothing routine is
    // voiced while the channel is held (radio silence), so nothing stale airs after Code 4.
    if (call.typeId === EMERGENCY_CALL_TYPE || net.isHeld(REQUEST_CHANNEL)) return;
    const assign = this.dispatcherLine('assign', e.callsign, values);
    this.line('unitAck', {
      speaker: e.callsign,
      speakerKind: 'officer',
      values: { unit: e.callsign },
      follows: assign,
      gap: this.ackGap(),
    });
  }

  private onOffer(e: DispatchOfferEvent): void {
    if (e.callsign !== this.host.player) return;
    const call = this.host.cad.call(e.callId);
    const values: TemplateValues = call
      ? { nature: call.nature, address: call.location.text, near: call.location.near, priority: String(call.priority), call: call.number }
      : {};
    this.dispatcherLine(e.expired ? 'offerTimeout' : 'offer', e.callsign, values);
  }

  private onPlateResult(e: DispatchPlateResultEvent): void {
    if (e.callsign !== this.host.player) return;
    this.playerActed('runPlate');
    if (!this.answer(['runPlate'], e.via, true)) return;
    const r = e.readback;
    const kind: PhraseKind = !r.found ? 'plateNotFound' : r.severity === 'clear' ? 'plateClear' : 'plateHit';
    this.dispatcherLine(kind, e.callsign, {
      plate: r.plate,
      desc: r.description,
      owner: r.owner,
      hits: r.hits.length > 0 ? r.hits.join(', ') : this.fragment('noHits'),
    });
  }

  private onPersonResult(e: DispatchPersonResultEvent): void {
    if (e.callsign !== this.host.player) return;
    if (!this.answer(['runPerson', 'stopContact'], e.via, true)) return;
    const r = e.readback;
    this.dispatcherLine('personReturn', e.callsign, {
      name: r.name,
      dob: r.dob,
      dl: r.dl,
      dlStatus: r.dlStatus,
      hits: r.hits.length > 0 ? r.hits.join(', ') : this.fragment('noHits'),
    });
  }

  private onBackup(e: DispatchBackupEvent): void {
    if (e.requester === this.host.player) this.answer(['backup'], undefined, false);
    if (e.units.length === 0) {
      this.dispatcherLine('noUnits', e.requester, {});
      return;
    }
    const first = e.units[0] as string;
    const sent = this.dispatcherLine(
      'backupDispatch',
      first,
      {
        units: joinUnits(e.units),
        player: e.requester,
        near: e.location,
        backupCode: this.fragment(e.code === 3 ? 'backupCode3' : 'backupCode2'),
      },
      { priority: e.code === 3 },
    );
    this.line('unitAck', { speaker: first, speakerKind: 'officer', values: { unit: first }, follows: sent, gap: this.ackGap() });
  }

  private onEmergency(e: DispatchEmergencyEvent): void {
    const net = this.host.net;
    if (e.callsign === this.host.player) this.answer(['emergency'], undefined, false);
    if (e.active) {
      net.hold(REQUEST_CHANNEL);
      this.dispatcherLine(
        'emergencyAlert',
        e.callsign,
        { near: e.location !== '' ? e.location : this.fragment('unknownLocation'), units: e.units.length > 0 ? joinUnits(e.units) : this.fragment('allUnits') },
        { priority: true, delay: 0.3 },
      );
    } else {
      net.release(REQUEST_CHANNEL);
      // Routine traffic queued before the emergency is stale now; "resume normal traffic" goes first.
      const player = this.host.player;
      net.cancel((q) => q.channel === REQUEST_CHANNEL && (q.ambient || ROUTINE_KINDS.has(q.kind)) && !q.priority && q.to !== player && q.start < 0);
      this.dispatcherLine('emergencyClear', e.callsign, {}, { priority: true });
    }
  }

  private onStatusCheck(e: DispatchStatusCheckEvent): void {
    const kind: PhraseKind = e.escalated ? 'statusEscalate' : e.attempt >= 2 ? 'statusCheckRepeat' : 'statusCheck';
    // Priority: a status check always goes on the air (also through an emergency hold), as the dispatcher's timer runs.
    this.lastCheckLine = this.dispatcherLine(kind, e.callsign, { near: e.location !== '' ? e.location : this.fragment('unknownLocation') }, { priority: true });
  }

  private onLocation(e: DispatchLocationEvent): void {
    if (e.callsign !== this.host.player) return;
    if (e.asked) {
      this.expectLocation = true;
      // "What's your 10-20?" belongs after the status check emitted with it.
      const check = this.lastCheckLine !== null && this.isLive(this.lastCheckLine) ? this.lastCheckLine : null;
      this.dispatcherLine('locationAsk', e.callsign, {}, check ? { follows: check, gap: this.replyGap(), priority: true } : { priority: true });
      return;
    }
    const answering = this.answeringLocation;
    this.answeringLocation = false;
    if (!this.answer(['location'], undefined, false)) return;
    if (answering) this.dispatcherLine('dispatchAck', e.callsign, {});
    else this.dispatcherLine('locationGive', e.callsign, { near: e.text !== '' ? e.text : this.fragment('unknownLocation') });
  }

  private onAck(e: DispatchAckEvent): void {
    if (e.callsign !== this.host.player) return;
    this.playerActed(e.kind);
    if (!e.ok) {
      if (this.answer([e.kind], undefined, false)) this.dispatcherLine('refused', e.callsign, { reason: refusalReason(e.text) });
      return;
    }
    if (ACK_COVERED.has(e.kind)) return;
    if (!this.answer([e.kind], undefined, false)) return;
    this.dispatcherLine(e.kind === 'trafficStop' ? 'trafficStopAck' : 'dispatchAck', e.callsign, {});
  }

  private onTrafficStop(e: CadTrafficStopEvent): void {
    const player = this.host.player;
    if (!e.active) {
      if (this.answer(['clearCall', 'stopContact', 'code4', 'trafficStop'], undefined, false)) this.dispatcherLine('stopClear', player, {});
      this.pulling = -1;
      return;
    }
    this.answer(['trafficStop'], undefined, false);
    const callout = this.line('trafficStop', {
      speaker: player,
      speakerKind: 'player',
      values: { unit: player, plate: this.stopPlate(), near: this.stopNear(e.callId) },
    });
    this.dispatcherLine('trafficStopAck', player, {}, { follows: callout, gap: this.replyGap() });
  }

  // --- Helpers --------------------------------------------------------------------------------

  /** `e` is still waiting or on the air (a follower of it will be started). */
  private isLive(e: QueuedTransmission): boolean {
    const net = this.host.net;
    return net.pending.includes(e) || net.onAir.some((tx) => tx.id === e.id);
  }

  private stopPlate(): TemplateValue {
    const stop = this.host.cad.trafficStop;
    if (stop && stop.plate !== '') return stop.plate;
    return this.pulling >= 0 ? plateOf(this.host.seed, this.pulling) : this.fragment('noPlate');
  }

  private stopNear(callId: number): TemplateValue {
    const call = callId >= 0 ? this.host.cad.call(callId) : null;
    return call ? call.location.near : this.host.playerNear();
  }

  /**
   * True when the answer to a player request of one of `kinds` should be spoken: a pending radio
   * request is consumed, or the event itself says it came by radio/voice (and, unless `always`, no
   * answer of that kind was just voiced).
   */
  private answer(kinds: readonly UnitRequest['kind'][], via: RequestVia | undefined, always: boolean): boolean {
    const now = this.host.net.now;
    const window = PHRASES.timing.answerWindowS;
    this.pending = this.pending.filter((p) => now - p.at <= window);
    this.answered = this.answered.filter((p) => now - p.at <= 3);
    const idx = this.pending.findIndex((p) => kinds.includes(p.kind));
    if (idx >= 0) {
      const [p] = this.pending.splice(idx, 1);
      if (p) this.answered.push({ kind: p.kind, at: now });
      return true;
    }
    if (!isRadioVia(via)) return false;
    if (!always && this.answered.some((p) => kinds.includes(p.kind))) return false;
    this.answered.push({ kind: kinds[0] as UnitRequest['kind'], at: now });
    return true;
  }

  // --- Persistence ----------------------------------------------------------------------------

  serialize(): ComposerSave {
    return {
      pending: this.pending.map((p) => ({ ...p })),
      answered: this.answered.map((p) => ({ ...p })),
      expectLocation: this.expectLocation,
      answeringLocation: this.answeringLocation,
      pulling: this.pulling,
    };
  }

  restore(s: ComposerSave): void {
    this.pending = s.pending.map((p) => ({ ...p }));
    this.answered = s.answered.map((p) => ({ ...p }));
    this.expectLocation = s.expectLocation;
    this.answeringLocation = s.answeringLocation;
    this.pulling = s.pulling;
  }
}
