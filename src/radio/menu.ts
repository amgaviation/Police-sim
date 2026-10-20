/**
 * Number-key radio menu (design §9.5). A small model: the view is cached per level, mode and context
 * flags, so reading it every frame does not allocate.
 *
 * 1 Status ▸   2 Run plate   3 Location   4 Request ▸   5 Code 4   6 Traffic stop   7 Accept   8 Decline   9 Say again
 *
 * Phase 6: the request submenu (level 'backup') lists `radioRequestTypes()` 8 per page (keys 1-8) and key 9 pages on.
 */
import { codeText } from '../cad/codes';
import type { RadioMode, UnitRequest, UnitStatus } from '../cad/types';
import { PHRASES } from './data';
import { radioRequestTypes, radioRequestTypesRevision } from './requestTypes';

/** Request types per menu page (keys 1-8; key 9 pages on). */
export const REQUEST_PAGE_SIZE = 8;

function pageCount(): number {
  return Math.max(1, Math.ceil(radioRequestTypes().length / REQUEST_PAGE_SIZE));
}

export interface MenuContext {
  readonly mode: RadioMode;
  /** A targeted car (run plate). */
  readonly hasTarget: boolean;
  /** An active traffic stop. */
  readonly hasStop: boolean;
  /** A call is offered to the player. */
  readonly pendingOffer: boolean;
  /** The player unit is on a call. */
  readonly onCall: boolean;
  /** The player's emergency is active. */
  readonly emergency: boolean;
  /** The offered call's id (accept / decline); absent or -1: accept sends "en route". */
  readonly offerCallId?: number;
}

export interface MenuOption {
  readonly key: number;
  readonly label: string;
  readonly enabled: boolean;
}

export interface MenuView {
  readonly title: string;
  readonly options: readonly MenuOption[];
}

export const MENU_LEVELS = ['root', 'status', 'backup'] as const;
export type MenuLevel = (typeof MENU_LEVELS)[number];

const STATUS_ORDER: readonly UnitStatus[] = ['available', 'enRoute', 'onScene', 'busy', 'outOfService', 'transporting'];

function capitalise(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "In service (10-8)" in ten-code mode, "In service" in plain mode. */
function codeLabel(key: string, mode: RadioMode, name?: string): string {
  const plain = capitalise(name ?? codeText(key, 'plain'));
  return mode === 'tenCode' ? `${plain} (${codeText(key, 'tenCode')})` : plain;
}

function flags(ctx: MenuContext): number {
  return (
    (ctx.mode === 'plain' ? 1 : 0) |
    (ctx.hasTarget ? 2 : 0) |
    (ctx.hasStop ? 4 : 0) |
    (ctx.pendingOffer ? 8 : 0) |
    (ctx.onCall ? 16 : 0) |
    (ctx.emergency ? 32 : 0)
  );
}

function buildView(level: MenuLevel, ctx: MenuContext, page: number): MenuView {
  const mode = ctx.mode;
  if (level === 'status') {
    const enabled: Readonly<Record<UnitStatus, boolean>> = {
      available: true,
      enRoute: ctx.onCall || ctx.pendingOffer,
      onScene: ctx.onCall,
      busy: true,
      outOfService: !ctx.onCall,
      transporting: ctx.onCall,
    };
    return {
      title: 'Status',
      options: STATUS_ORDER.map((s, i) => ({ key: i + 1, label: codeLabel(s, mode), enabled: enabled[s] })),
    };
  }
  if (level === 'backup') {
    const types = radioRequestTypes();
    if (types.length > 0) {
      const pages = pageCount();
      const options: MenuOption[] = [];
      for (let i = 0; i < REQUEST_PAGE_SIZE; i++) {
        const t = types[page * REQUEST_PAGE_SIZE + i];
        if (t) options.push({ key: i + 1, label: t.menu, enabled: true });
      }
      if (pages > 1) options.push({ key: 9, label: page < pages - 1 ? 'More ▸' : 'First page ▸', enabled: true });
      return { title: `Request ${page + 1}/${pages}`, options };
    }
    return {
      title: 'Backup',
      options: [
        { key: 1, label: capitalise(PHRASES.fragments.backupCode2[mode]), enabled: true },
        { key: 2, label: capitalise(PHRASES.fragments.backupCode3[mode]), enabled: true },
      ],
    };
  }
  return {
    title: 'Radio',
    options: [
      { key: 1, label: 'Status ▸', enabled: true },
      { key: 2, label: codeLabel('registration', mode, 'run plate'), enabled: ctx.hasTarget || ctx.hasStop },
      { key: 3, label: codeLabel('location', mode), enabled: true },
      { key: 4, label: 'Request ▸', enabled: true },
      { key: 5, label: capitalise(codeText('allOk', mode)), enabled: true },
      { key: 6, label: codeLabel('trafficStop', mode), enabled: ctx.hasStop },
      { key: 7, label: 'Accept offered call', enabled: ctx.pendingOffer },
      { key: 8, label: 'Decline offered call', enabled: ctx.pendingOffer },
      { key: 9, label: codeLabel('repeat', mode), enabled: true },
    ],
  };
}

export class RadioMenu {
  private openFlag = false;
  private levelValue: MenuLevel = 'root';
  private pageValue = 0;
  private readonly cache = new Map<number, MenuView>();
  private cacheRevision = -1;

  get isOpen(): boolean {
    return this.openFlag;
  }

  get level(): MenuLevel {
    return this.levelValue;
  }

  /** Page of the request submenu (0-based). */
  get page(): number {
    this.sync();
    return this.pageValue;
  }

  open(): void {
    this.openFlag = true;
    this.levelValue = 'root';
    this.pageValue = 0;
  }

  close(): void {
    this.openFlag = false;
    this.levelValue = 'root';
    this.pageValue = 0;
  }

  /** Submenu -> main menu (page 0); main menu -> closed. */
  back(): void {
    if (this.levelValue !== 'root') {
      this.levelValue = 'root';
      this.pageValue = 0;
    } else {
      this.close();
    }
  }

  /** The request list changed: drop the cached views and a page that no longer exists. */
  private sync(): void {
    const revision = radioRequestTypesRevision();
    if (revision === this.cacheRevision) return;
    this.cache.clear();
    this.cacheRevision = revision;
    if (this.pageValue >= pageCount()) this.pageValue = 0;
  }

  /** The current level's options (cached per level, page, mode and context flags). */
  view(ctx: MenuContext): MenuView {
    this.sync();
    const key = (this.pageValue * MENU_LEVELS.length + MENU_LEVELS.indexOf(this.levelValue)) * 64 + flags(ctx);
    let v = this.cache.get(key);
    if (v === undefined) {
      v = buildView(this.levelValue, ctx, this.pageValue);
      this.cache.set(key, v);
    }
    return v;
  }

  /**
   * Number key `key` (1..9): opens a submenu (null) or returns the request and closes the menu. A
   * disabled or unknown option, or a closed menu, gives null. A run-plate request carries an empty
   * plate: the caller fills in the target's plate.
   */
  press(key: number, ctx: MenuContext): UnitRequest | null {
    if (!this.openFlag) return null;
    const option = this.view(ctx).options.find((o) => o.key === key);
    if (!option || !option.enabled) return null;
    const req = this.requestFor(key, ctx);
    if (req !== null) this.close();
    return req;
  }

  private requestFor(key: number, ctx: MenuContext): UnitRequest | null {
    if (this.levelValue === 'status') {
      const status = STATUS_ORDER[key - 1];
      return status === undefined ? null : { kind: 'status', status };
    }
    if (this.levelValue === 'backup') {
      const types = radioRequestTypes();
      if (types.length === 0) return { kind: 'backup', code: key === 2 ? 3 : 2 };
      if (key === 9) {
        this.pageValue = (this.pageValue + 1) % pageCount();
        return null;
      }
      return types[this.pageValue * REQUEST_PAGE_SIZE + key - 1]?.request ?? null;
    }
    const offer = ctx.offerCallId ?? -1;
    switch (key) {
      case 1:
        this.levelValue = 'status';
        return null;
      case 2:
        return { kind: 'runPlate', plate: '', vehicleId: -1 };
      case 3:
        return { kind: 'location' };
      case 4:
        this.levelValue = 'backup';
        this.pageValue = 0;
        return null;
      case 5:
        return { kind: 'code4' };
      case 6:
        return { kind: 'trafficStop' };
      case 7:
        return offer >= 0 ? { kind: 'acceptCall', callId: offer } : { kind: 'status', status: 'enRoute' };
      case 8:
        return { kind: 'declineCall', callId: offer };
      case 9:
        return { kind: 'repeat' };
      default:
        return null;
    }
  }
}
