import { App } from './app';
import { log } from './core/log';

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
  const app = await App.create();
  if (import.meta.env.DEV) window.patrol = app;
  app.start();
}

main().catch((error: unknown) => {
  log.error('Startup failed:', error);
  showFatal(error);
});
