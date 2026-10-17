/**
 * RadioController (design §9.6): per frame, only while gameplay controls are active, maps the radio.*
 * actions to the menu, push-to-talk voice commands, the emergency button (hold) and channel keys.
 * Reuses one state object: allocation-free per frame.
 */
import type { ActionId } from '../input/actions';
import { parseVoiceCommand } from './grammar';
import type { MenuContext, MenuView } from './menu';
import type { RadioSystem } from './radioSystem';
import type { UnitRequest } from '../cad/types';

/** Hold time of the emergency button (s). */
export const EMERGENCY_HOLD_S = 1.2;
/** How long a hint stays up (s). */
export const HINT_S = 3;

export interface RadioControllerState {
  readonly menu: MenuView | null;
  readonly voice: 'off' | 'ready' | 'listening' | 'unavailable';
  readonly hint: string | null;
  /** Bumped by every new hint, so a repeated identical hint (a second "Say again") shows again. */
  readonly hintSeq: number;
  /** Emergency button charge 0..1 while held. */
  readonly emergencyCharge: number;
}

/** What the controller reads from the input manager. */
export interface RadioInput {
  wasPressed(action: ActionId): boolean;
  wasReleased(action: ActionId): boolean;
  isDown(action: ActionId): boolean;
}

/** What the controller uses of `SpeechIn`. */
export interface SpeechInLike {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly listening: boolean;
  start(): boolean;
  stop(): void;
  onResult(fn: (alternatives: readonly { transcript: string; confidence: number }[]) => void): () => void;
  onError(fn: (code: string) => void): () => void;
}

/** What the controller uses of the radio. */
export type RadioLike = Pick<RadioSystem, 'menu' | 'playerRequest' | 'emergencyButton' | 'stepChannel' | 'toggleScan'>;

export interface RadioControllerDeps {
  readonly input: RadioInput;
  readonly radio: RadioLike;
  readonly speechIn: SpeechInLike | null;
}

export type RadioControllerContext = MenuContext & {
  readonly fallbackPlate: string | null;
  /** Vehicle id of the fallback plate (-1 / absent: unknown). */
  readonly fallbackVehicleId?: number;
};

const OPTION_ACTIONS: readonly ActionId[] = [
  'radio.option1', 'radio.option2', 'radio.option3', 'radio.option4', 'radio.option5',
  'radio.option6', 'radio.option7', 'radio.option8', 'radio.option9',
];

export const HINTS = {
  sayAgain: 'Say again',
  noPlate: 'No plate to run',
  micBlocked: 'Microphone blocked',
  voiceUnavailable: 'Voice service unavailable',
} as const;

interface MutableState {
  menu: MenuView | null;
  voice: 'off' | 'ready' | 'listening' | 'unavailable';
  hint: string | null;
  hintSeq: number;
  emergencyCharge: number;
}

export class RadioController {
  private readonly deps: RadioControllerDeps;
  private readonly state: MutableState = { menu: null, voice: 'unavailable', hint: null, hintSeq: 0, emergencyCharge: 0 };
  private readonly offs: (() => void)[] = [];
  private hintTimer = 0;
  private emergencyHeld = 0;
  private emergencyFired = false;
  /** Recognition results waiting for the next update (they arrive asynchronously). */
  private results: readonly { transcript: string; confidence: number }[] | null = null;
  private recognitionError: string | null = null;

  constructor(deps: RadioControllerDeps) {
    this.deps = deps;
    const sin = deps.speechIn;
    if (sin) {
      this.offs.push(
        sin.onResult((alternatives) => {
          this.results = alternatives;
        }),
        sin.onError((code) => {
          this.recognitionError = code;
        }),
      );
    }
  }

  update(dt: number, active: boolean, ctx: RadioControllerContext): RadioControllerState {
    const { input, radio, speechIn } = this.deps;
    const s = this.state;
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) s.hint = null;
    }
    if (!active) {
      if (speechIn?.listening) speechIn.stop();
      this.emergencyHeld = 0;
      this.emergencyFired = false;
      s.emergencyCharge = 0;
    } else {
      this.menuInput(ctx);
      this.pttInput();
      this.emergencyInput(dt);
      if (input.wasPressed('radio.channelPrev')) radio.stepChannel(-1);
      if (input.wasPressed('radio.channelNext')) radio.stepChannel(1);
      if (input.wasPressed('radio.scan')) radio.toggleScan();
    }
    this.voiceResults(ctx);
    s.menu = radio.menu.isOpen ? radio.menu.view(ctx) : null;
    s.voice = this.voiceState();
    return s;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.deps.speechIn?.listening) this.deps.speechIn.stop();
  }

  private menuInput(ctx: RadioControllerContext): void {
    const { input, radio } = this.deps;
    const menu = radio.menu;
    if (input.wasPressed('radio.menu')) {
      if (!menu.isOpen) menu.open();
      else if (menu.level !== 'root') menu.back();
      else menu.close();
    }
    if (!menu.isOpen) return;
    for (let i = 0; i < OPTION_ACTIONS.length; i++) {
      if (!input.wasPressed(OPTION_ACTIONS[i] as ActionId)) continue;
      const req = menu.press(i + 1, ctx);
      if (req !== null) this.send(req, 'radio', ctx);
      break;
    }
  }

  private pttInput(): void {
    const { input, speechIn } = this.deps;
    if (!speechIn) return;
    if (input.wasPressed('radio.ptt') && speechIn.available && speechIn.enabled && !speechIn.start()) this.setHint(HINTS.voiceUnavailable);
    if (input.wasReleased('radio.ptt') && speechIn.listening) speechIn.stop();
  }

  private emergencyInput(dt: number): void {
    const s = this.state;
    if (!this.deps.input.isDown('radio.emergency')) {
      this.emergencyHeld = 0;
      this.emergencyFired = false;
      s.emergencyCharge = 0;
      return;
    }
    this.emergencyHeld += dt;
    s.emergencyCharge = Math.min(1, this.emergencyHeld / EMERGENCY_HOLD_S);
    if (!this.emergencyFired && this.emergencyHeld >= EMERGENCY_HOLD_S) {
      this.emergencyFired = true;
      this.deps.radio.emergencyButton();
    }
  }

  private voiceResults(ctx: RadioControllerContext): void {
    const err = this.recognitionError;
    if (err !== null) {
      this.recognitionError = null;
      if (err === 'no-match' || err === 'no-speech') this.setHint(HINTS.sayAgain);
      else if (err === 'not-allowed' || err === 'service-not-allowed' || err === 'audio-capture') this.setHint(HINTS.micBlocked);
      // 'network', 'language-not-supported' and the like: no recognition service ('aborted' is our own cancel).
      else if (err !== 'aborted') this.setHint(HINTS.voiceUnavailable);
    }
    const results = this.results;
    if (results === null) return;
    this.results = null;
    for (const alt of results) {
      const req = parseVoiceCommand(alt.transcript, {
        fallbackPlate: ctx.fallbackPlate,
        fallbackVehicleId: ctx.fallbackVehicleId ?? -1,
        offerCallId: ctx.offerCallId ?? -1,
      });
      if (req !== null) {
        this.send(req, 'voice', ctx);
        return;
      }
    }
    this.setHint(HINTS.sayAgain);
  }

  private send(req: UnitRequest, via: 'radio' | 'voice', ctx: RadioControllerContext): void {
    let r = req;
    if (r.kind === 'runPlate' && r.plate === '') {
      if (ctx.fallbackPlate === null || ctx.fallbackPlate === '') {
        this.setHint(HINTS.noPlate);
        return;
      }
      r = { kind: 'runPlate', plate: ctx.fallbackPlate, vehicleId: ctx.fallbackVehicleId ?? -1 };
    }
    this.deps.radio.playerRequest(r, via);
  }

  private setHint(text: string): void {
    this.state.hint = text;
    this.state.hintSeq++;
    this.hintTimer = HINT_S;
  }

  private voiceState(): RadioControllerState['voice'] {
    const sin = this.deps.speechIn;
    if (!sin || !sin.available) return 'unavailable';
    if (!sin.enabled) return 'off';
    return sin.listening ? 'listening' : 'ready';
  }
}
