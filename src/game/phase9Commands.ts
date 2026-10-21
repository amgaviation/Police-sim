import type { Command } from '../debug/console';
import type { GameSession } from './session';

/** Script id `tutorial start` runs. */
export const DEFAULT_TUTORIAL = 'firstShift';

/** Phase 9 console commands (design §19.3): `tutorial [status|skip|end|start]`. */
export interface Phase9CommandDeps {
  session(): GameSession | null;
  flash(text: string): void;
}

function need(session: GameSession | null): GameSession {
  if (session === null) throw new Error('No game running');
  return session;
}

export function createPhase9Commands(deps: Phase9CommandDeps): Command[] {
  return [
    {
      name: 'tutorial',
      description: 'The guided first shift: status, skip the current step, end it, or (re)start it',
      usage: '[status|skip|end|start]',
      run: (args) => {
        const s = need(deps.session());
        const sub = (args[0] ?? 'status').toLowerCase();
        const runner = s.phase9.runner;
        if (sub === 'start') {
          if (!s.phase9.start(DEFAULT_TUTORIAL)) throw new Error(`Unknown tutorial '${DEFAULT_TUTORIAL}'`);
          deps.flash('Tutorial started');
          return 'Tutorial started';
        }
        if (sub === 'status') {
          const v = runner?.view;
          if (!v || v.revision < 0) return 'No tutorial in this game (tutorial start)';
          if (v.done) return `Tutorial ${v.completed ? 'complete' : 'ended'}`;
          return `Step ${String(v.index + 1)} of ${String(v.count)}: ${v.step?.title ?? ''} (${v.step?.id ?? ''})${v.step?.skippable === true ? ' - skippable' : ''}`;
        }
        if (sub === 'skip' || sub === 'end') {
          if (!runner || !s.phase9.active) throw new Error('No tutorial running');
          if (sub === 'skip') {
            if (runner.view.step?.skippable !== true) throw new Error('This step cannot be skipped');
            runner.skip();
            return 'Skipping the current step';
          }
          runner.end();
          return 'Ending the tutorial';
        }
        throw new Error('Usage: tutorial [status|skip|end|start]');
      },
    },
  ];
}
