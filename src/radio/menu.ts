/**
 * Number-key radio menu (design §9.5). A small model: the view is cached per level, mode and context
 * flags, so reading it every frame does not allocate.
 *
 * 1 Status ▸   2 Run plate   3 Location   4 Backup ▸   5 Code 4   6 Traffic stop   7 Accept   8 Decline   9 Say again
 */
import { codeText } from '../cad/codes';
import type { RadioMode, UnitRequest, UnitStatus } from '../cad/types';
import { PHRASES } from './data';

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

function buildView(level: MenuLevel, ctx: MenuContext): MenuView {
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
      { key: 4, label: 'Backup ▸', enabled: true },
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
  private readonly cache = new Map<number, MenuView>();

  get isOpen(): boolean {
    return this.openFlag;
  }

  get level(): MenuLevel {
    return this.levelValue;
  }

  open(): void {
    this.openFlag = true;
    this.levelValue = 'root';
  }

  close(): void {
    this.openFlag = false;
    this.levelValue = 'root';
  }

  /** Submenu -> main menu; main menu -> closed. */
  back(): void {
    if (this.levelValue !== 'root') this.levelValue = 'root';
    else this.close();
  }

  /** The current level's options (cached per level, mode and context flags). */
  view(ctx: MenuContext): MenuView {
    const key = MENU_LEVELS.indexOf(this.levelValue) * 64 + flags(ctx);
    let v = this.cache.get(key);
    if (v === undefined) {
      v = buildView(this.levelValue, ctx);
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
    if (this.levelValue === 'backup') return { kind: 'backup', code: key === 2 ? 3 : 2 };
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
