import type { DialogueHandlers, DialogueView, SfstView, Tone, CommMode } from '../../src/ui/dialogue/types';

export function view(overrides: Partial<DialogueView> = {}): DialogueView {
  return {
    contactId: 1,
    title: 'Jane Doe',
    subtitle: 'Driver · 34 · calm',
    tone: 'neutral',
    commMode: 'verbal',
    commModes: ['verbal'],
    topics: [
      {
        id: 'greeting',
        label: 'Greeting',
        options: [
          { id: 'greet', label: 'Good evening', enabled: true },
          { id: 'reason', label: 'Explain the stop', enabled: true },
        ],
      },
      {
        id: 'identity',
        label: 'Identity',
        options: [
          { id: 'askName', label: 'Name?', enabled: false, hint: 'Not yet greeted' },
          { id: 'requestId', label: 'May I see your ID?', enabled: true },
          { id: 'askDob', label: 'Date of birth?', enabled: true },
        ],
      },
      { id: 'empty', label: 'Nothing here', options: [] },
    ],
    actions: [
      { id: 'frisk', label: 'Frisk', enabled: false, hint: 'No consent' },
      { id: 'cuff', label: 'Handcuff', enabled: true },
      { id: 'release', label: 'Release', enabled: true },
    ],
    transcript: [],
    statements: [],
    facts: [],
    inconsistencies: [],
    busy: false,
    ...overrides,
  };
}

export interface Calls {
  say: [string, Tone][];
  action: string[];
  mode: CommMode[];
  close: number;
}

export function handlers(): { handlers: DialogueHandlers; calls: Calls } {
  const calls: Calls = { say: [], action: [], mode: [], close: 0 };
  return {
    calls,
    handlers: {
      say: (id, tone) => calls.say.push([id, tone]),
      action: (id) => calls.action.push(id),
      commMode: (mode) => calls.mode.push(mode),
      close: () => {
        calls.close++;
      },
    },
  };
}

export function sfst(overrides: Partial<SfstView> = {}): SfstView {
  return {
    title: 'Horizontal gaze test',
    instruction: 'Follow the stimulus with your eyes.',
    prompt: 'SPACE',
    promptRemaining: 0.5,
    progress: 0.25,
    finished: false,
    summary: [],
    ...overrides,
  };
}

/** A minimal KeyboardEvent for the panels' onKeyDown. */
export function keyEvent(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key, code: key, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra } as KeyboardEvent;
}
