/** Dialogue, SFST and subtitle view types (design §12.3). Tone and CommMode are identical to dialogue §9.1. */

export type Tone = 'polite' | 'neutral' | 'commanding' | 'aggressive';
export type CommMode = 'verbal' | 'written' | 'gesture' | 'translationApp' | 'interpreter';

export type DialogueTab = 'talk' | 'actions' | 'notes';

export interface DialogueOptionView {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Why the option is disabled, or a short note. */
  readonly hint?: string;
}

export interface DialogueTopicView {
  readonly id: string;
  readonly label: string;
  readonly options: readonly DialogueOptionView[];
}

export interface TranscriptLine {
  readonly id: number;
  readonly speaker: 'officer' | 'subject' | 'system';
  readonly text: string;
  /** The answer is still on its way (shown dimmed). */
  readonly pending: boolean;
}

export interface NoteLine {
  readonly text: string;
  readonly severity: 'info' | 'caution' | 'alert';
}

/** Everything the dialogue panel shows; rebuilt by the contact module when its revision changes. */
export interface DialogueView {
  readonly contactId: number;
  readonly title: string;
  readonly subtitle: string;
  readonly tone: Tone;
  readonly commMode: CommMode;
  readonly commModes: readonly CommMode[];
  readonly topics: readonly DialogueTopicView[];
  readonly actions: readonly DialogueOptionView[];
  readonly transcript: readonly TranscriptLine[];
  readonly statements: readonly NoteLine[];
  readonly facts: readonly NoteLine[];
  readonly inconsistencies: readonly NoteLine[];
  /** An answer is pending: new lines and actions are not sent until it arrives. */
  readonly busy: boolean;
}

export interface DialogueHandlers {
  say(optionId: string, tone: Tone): void;
  action(actionId: string): void;
  commMode(mode: CommMode): void;
  close(): void;
}

export interface DialoguePanelState {
  readonly tab: DialogueTab;
  /** Index into `view.topics`, -1 = the topic list. */
  readonly topic: number;
  readonly tone: Tone;
  /** Highlighted row of the current list. */
  readonly focus: number;
}

export type DialogueEmit =
  | { readonly kind: 'say'; readonly id: string; readonly tone: Tone }
  | { readonly kind: 'action'; readonly id: string }
  | { readonly kind: 'mode'; readonly mode: CommMode }
  | { readonly kind: 'close' };

export interface DialogueKeyResult {
  readonly state: DialoguePanelState;
  readonly emit: DialogueEmit | null;
  readonly consumed: boolean;
}

/** State of the field sobriety test panel. */
export interface SfstView {
  readonly title: string;
  readonly instruction: string;
  /** Key label to press now (e.g. 'SPACE'), null when none is asked. */
  readonly prompt: string | null;
  /** Fraction of the prompt window left, 0..1. */
  readonly promptRemaining: number;
  /** Test progress 0..1. */
  readonly progress: number;
  readonly finished: boolean;
  readonly summary: readonly string[];
}

export interface SfstHandlers {
  key(key: string): void;
  close(): void;
}
