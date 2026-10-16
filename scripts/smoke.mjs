#!/usr/bin/env node
/**
 * Browser smoke test for Phase 0.
 *
 * Starts the Vite dev server (unless SMOKE_URL points at a running one), drives
 * the game in headless Chromium with SwiftShader, asserts that the simulation
 * runs, saves/loads a slot, and writes docs/screenshots/phase0.png.
 *
 * Usage: npm run smoke  (or: node scripts/smoke.mjs)
 */
/* global window, document, getComputedStyle, MouseEvent, KeyboardEvent -- functions passed to page.evaluate run in the browser */
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 5173);
const URL_BASE = process.env.SMOKE_URL ?? `http://localhost:${PORT}`;
const SCREENSHOT = path.join(ROOT, 'docs', 'screenshots', 'phase0.png');
const SETTLE_MS = 3000;

process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

async function loadPlaywright() {
  try {
    return await import('/opt/node-tools/node_modules/playwright/index.mjs');
  } catch {
    return import('playwright');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Dev server at ${url} did not come up within ${timeoutMs} ms`);
}

function startDevServer() {
  // Detached so the npx wrapper and the vite process it spawns share a group we can kill together.
  const child = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  return child;
}

function killTree(child, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // already gone
  }
}

async function stopDevServer(child) {
  if (!child || child.exitCode !== null) return;
  killTree(child, 'SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
  if (child.exitCode === null) killTree(child, 'SIGKILL');
}

const failures = [];
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
  if (!condition) failures.push(message);
}

async function run() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const consoleErrors = [];
  const consoleLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    if (msg.type() === 'error') consoleErrors.push(line);
  });
  page.on('pageerror', (error) => {
    const line = `[pageerror] ${error.message}`;
    consoleLines.push(line);
    consoleErrors.push(line);
  });

  try {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });

    const hasRenderer = await page.evaluate(() => window.patrol.renderer !== null);
    console.log(`renderer: ${hasRenderer ? 'WebGL available' : 'UNAVAILABLE (headless simulation only)'}`);

    const newGame = page.getByRole('button', { name: 'New game' });
    if (await newGame.count()) {
      await page.fill('#seed', '42');
      await newGame.click();
    } else {
      await page.evaluate(() => window.patrol.newGame(42));
    }
    await sleep(SETTLE_MS);

    const state = await page.evaluate(() => {
      const app = window.patrol;
      return {
        fps: app.loop.stats.fps,
        steps: app.loop.step,
        paused: app.loop.paused,
        entities: app.session ? app.session.entityCount : 0,
        bodies: app.physics.bodyCount,
        drawCalls: app.renderer ? app.renderer.stats.drawCalls : 0,
        seed: app.session ? app.session.seed : null,
        menuOpen: app.ui.isMenuOpen(),
      };
    });
    console.log('state after new game:', JSON.stringify(state));
    check(state.seed === 42, 'session started with seed 42');
    check(state.fps > 0, `loop running (fps ${state.fps.toFixed(1)})`);
    check(state.steps > 0 && !state.paused, `fixed steps advancing (${state.steps})`);
    check(state.entities > 100, `entity count > 100 (${state.entities})`);
    check(state.bodies === state.entities, `physics bodies match entities (${state.bodies})`);
    check(!state.menuOpen, 'menus closed while playing');
    if (hasRenderer) check(state.drawCalls > 0, `renderer drawing (${state.drawCalls} draw calls)`);

    const moved = await page.evaluate(async () => {
      const app = window.patrol;
      const eid = app.session.player;
      const before = app.physics.getBody(eid).translation();
      await new Promise((r) => setTimeout(r, 500));
      const after = app.physics.getBody(eid).translation();
      return { before, after };
    });
    console.log('player idle check:', JSON.stringify(moved));

    const toggles = await page.evaluate(() => {
      const app = window.patrol;
      app.perf.toggle();
      app.console.toggle();
      const perfText = app.perf.renderText();
      const consoleOpen = app.console.isOpen();
      app.console.close();
      return { perfVisible: app.perf.visible, perfText, consoleOpen, consoleClosed: !app.console.isOpen() };
    });
    check(toggles.perfVisible, 'perf overlay toggled on');
    check(toggles.consoleOpen && toggles.consoleClosed, 'debug console toggled open and closed');
    console.log('perf overlay text:\n' + toggles.perfText);

    const saveLoad = await page.evaluate(async () => {
      const app = window.patrol;
      const beforeCount = app.session.entityCount;
      await app.saveGame('smoke');
      const list = await app.saves.list();
      await app.loadGame('smoke');
      return {
        beforeCount,
        afterCount: app.session.entityCount,
        seed: app.session.seed,
        slots: list.map((s) => s.slot),
      };
    });
    console.log('save/load:', JSON.stringify(saveLoad));
    check(saveLoad.slots.includes('smoke'), "slot 'smoke' listed after save");
    check(saveLoad.afterCount === saveLoad.beforeCount, `reloaded entity count matches (${saveLoad.afterCount})`);
    check(saveLoad.seed === 42, 'reloaded seed is 42');

    const commands = await page.evaluate(async () => {
      const app = window.patrol;
      await app.console.execute('entities');
      await app.console.execute('fps');
      await app.console.execute('worker ping');
      await app.console.execute('settings get graphics.fov');
      return app.console.lines.slice(-8).map((l) => `${l.kind}: ${l.text}`);
    });
    console.log('console commands:\n  ' + commands.join('\n  '));
    check(!commands.some((l) => l.startsWith('error:')), 'console commands ran without errors');

    const fixes = await page.evaluate(async () => {
      const app = window.patrol;
      const out = {};
      // Deadzone setting reaches the InputManager.
      await app.console.execute('settings set controls.gamepadDeadzone 0.4');
      out.deadzone = app.input.deadzone;
      await app.console.execute('settings set controls.gamepadDeadzone 0.15');
      // The console pause survives opening and closing a menu.
      await app.console.execute('pause');
      app.pauseMenu.open();
      app.pauseMenu.close();
      out.pausedAfterMenu = app.loop.paused;
      await app.console.execute('pause');
      out.runningAgain = !app.loop.paused;
      // Text size scales the console.
      await app.console.execute('settings set accessibility.textScale 1.6');
      app.console.open();
      out.consoleFont = getComputedStyle(document.querySelector('#debug-console input') ?? document.body).fontSize;
      app.console.close();
      await app.console.execute('settings set accessibility.textScale 1');
      // Escape closes Settings even after a binding removal moved focus.
      app.pauseMenu.open();
      app.settingsMenu.open('controls');
      const remove = document.querySelector('.bindings .x');
      remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.focusAfterRemove = document.activeElement?.tagName ?? null;
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      out.stackAfterEscape = app.ui.menuStack.map((m) => m.id);
      app.settings.reset();
      app.ui.closeAll();
      return out;
    });
    console.log('fix checks:', JSON.stringify(fixes));
    check(fixes.deadzone === 0.4, 'gamepad deadzone setting applied to input');
    check(fixes.pausedAfterMenu && fixes.runningAgain, 'console pause survives a menu open/close');
    check(fixes.consoleFont === '20.8px', `console font follows text size (${fixes.consoleFont})`);
    check(
      fixes.stackAfterEscape.length === 1 && fixes.stackAfterEscape[0] === 'pause',
      `Escape closes Settings after removing a binding (stack ${fixes.stackAfterEscape.join(',')}, focus ${fixes.focusAfterRemove})`,
    );

    await sleep(500);
    await mkdir(path.dirname(SCREENSHOT), { recursive: true });
    await page.screenshot({ path: SCREENSHOT });
    console.log(`screenshot: ${SCREENSHOT}`);

    check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
  } finally {
    console.log('--- browser console ---');
    for (const line of consoleLines) console.log(line);
    console.log('--- end browser console ---');
    await browser.close();
  }
}

let server = null;
try {
  if (!process.env.SMOKE_URL) {
    server = startDevServer();
    await waitForServer(URL_BASE);
  }
  await run();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  await stopDevServer(server);
}

if (failures.length > 0) {
  console.log(`\nSMOKE FAILED: ${failures.length} problem(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nSMOKE PASSED');
process.exit(0);
