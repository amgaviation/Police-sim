import { bootMods, enterSafeMode } from './mods/boot';
import { log } from './core/log';
import type { App } from './app';

declare global {
  interface Window {
    /** The running app, exposed in dev builds for the console and smoke tests. */
    patrol?: App;
  }
}

function showFatal(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const box = document.createElement('pre');
  box.className = 'mono';
  box.style.cssText = 'position:fixed;inset:auto 16px 16px 16px;padding:12px;z-index:2000;white-space:pre-wrap';
  box.textContent = `Patrol failed to start.\n${message}`;
  document.body.appendChild(box);
}

// Surface stray promise rejections in the in-game console instead of only in devtools.
window.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled rejection:', event.reason);
});

async function main(): Promise<void> {
  // Enabled mods are applied before anything that reads the data tables is imported (design §20.1): only the boot
  // module and core code may be imported statically here; the app is imported after the overlay is installed.
  const boot = await bootMods({ skip: new URLSearchParams(location.search).has('nomods') });
  let app: App;
  try {
    const { App: AppClass } = await import('./app');
    app = await AppClass.create(boot);
  } catch (error) {
    // A mod that breaks the data tables must not brick the game: reload with the mods switched off.
    if (boot.active.length > 0) {
      log.error('Startup failed with mods active; switching to safe mode:', error);
      enterSafeMode();
      location.reload();
      return;
    }
    throw error;
  }
  if (import.meta.env.DEV) window.patrol = app;
  app.start();
}

main().catch((error: unknown) => {
  log.error('Startup failed:', error);
  showFatal(error);
});
