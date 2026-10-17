#!/usr/bin/env node
/**
 * Browser smoke test (Phase 1).
 *
 * Starts the Vite dev server (unless SMOKE_URL points at a running one), drives
 * the game in headless Chromium with SwiftShader: a new shift in the city, chunk
 * streaming and traffic, getting into the patrol car and driving it, weather and
 * night, the world console commands, a save/load round trip, settings, and the perf
 * numbers (including a per-frame cost breakdown under software GL).
 * Writes docs/screenshots/phase1.png and docs/screenshots/phase1-night.png.
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
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const SEED = 42;
/** Draw-call hard cap of the design (§15); the target is 200. */
const DRAW_CALL_CAP = 300;
/** Frames averaged by each frame-cost breakdown. */
const BREAKDOWN_FRAMES = 10;

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

/** Polls `fn` in the page until it returns truthy or `timeoutMs` passes; returns the last value. */
async function waitFor(page, fn, arg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await page.evaluate(fn, arg);
  while (!value && Date.now() < deadline) {
    await sleep(250);
    value = await page.evaluate(fn, arg);
  }
  return value;
}

/**
 * Average frame cost over `frames` rendered frames, measured by wrapping the loop hooks in the
 * page: sim (fixed steps), update (input, camera, environment, streaming, cars, HUD) and render
 * (mesh sync, the renderer's CPU-side draw submission, perf overlay). The rest of the frame
 * interval is spent waiting for the GPU process (SwiftShader rasterises on the CPU there).
 */
async function frameBreakdown(frames) {
  const app = window.patrol;
  const hooks = app.loop.hooks; // private in TypeScript, a plain property at runtime
  const renderer = app.renderer;
  const original = { fixedUpdate: hooks.fixedUpdate, update: hooks.update, render: hooks.render, draw: renderer?.render };
  const acc = { sim: 0, steps: 0, update: 0, render: 0, draw: 0, frames: 0, firstEnd: 0, lastEnd: 0 };
  hooks.fixedUpdate = (dt, step) => {
    const t0 = performance.now();
    original.fixedUpdate(dt, step);
    acc.sim += performance.now() - t0;
    acc.steps += 1;
  };
  hooks.update = (dt, alpha) => {
    const t0 = performance.now();
    original.update(dt, alpha);
    acc.update += performance.now() - t0;
  };
  hooks.render = (alpha) => {
    const t0 = performance.now();
    original.render(alpha);
    const end = performance.now();
    acc.frames += 1;
    if (acc.frames === 1) {
      // The first frame only starts the clock: drop its costs.
      acc.sim = acc.steps = acc.update = acc.draw = 0;
      acc.firstEnd = end;
      return;
    }
    acc.render += end - t0;
    acc.lastEnd = end;
  };
  if (renderer) {
    renderer.render = (...args) => {
      const t0 = performance.now();
      original.draw.apply(renderer, args);
      acc.draw += performance.now() - t0;
    };
  }
  await new Promise((resolve) => {
    const poll = () => (acc.frames > frames ? resolve() : setTimeout(poll, 50));
    poll();
  });
  hooks.fixedUpdate = original.fixedUpdate;
  hooks.update = original.update;
  hooks.render = original.render;
  if (renderer) renderer.render = original.draw;
  const n = acc.frames - 1;
  const round = (v, d = 2) => Number(v.toFixed(d));
  const frameMs = (acc.lastEnd - acc.firstEnd) / n;
  const cpuMs = (acc.sim + acc.update + acc.render) / n;
  return {
    frames: n,
    fps: round(1000 / frameMs, 1),
    frameMs: round(frameMs, 1),
    simMs: round(acc.sim / n),
    stepsPerFrame: round(acc.steps / n, 1),
    updateMs: round(acc.update / n),
    renderMs: round(acc.render / n),
    drawSubmitMs: round(acc.draw / n),
    gpuWaitMs: round(frameMs - cpuMs, 1),
  };
}

/** Perf numbers of the running game: loop, renderer, streaming, traffic, cars and per-system timings. */
function perfSnapshot() {
  const app = window.patrol;
  const s = app.session;
  const t0 = performance.now();
  app.renderer?.render();
  const renderMs = performance.now() - t0;
  const timings = {};
  for (const [name, ms] of app.systems.timings) timings[name] = Number(ms.toFixed(3));
  return {
    fps: Number(app.loop.stats.fps.toFixed(1)),
    frameMs: Number(app.loop.stats.frameMs.toFixed(1)),
    simMs: Number(app.loop.stats.simMs.toFixed(2)),
    stepsPerFrame: app.loop.stats.stepsLastFrame,
    renderMs: Number(renderMs.toFixed(1)),
    drawCalls: app.renderer?.stats.drawCalls ?? 0,
    triangles: app.renderer?.stats.triangles ?? 0,
    chunks: app.worldView?.streamer?.stats ?? null,
    traffic: s ? { ...s.traffic.stats } : null,
    cars: app.carRenderer ? { ...app.carRenderer.stats } : null,
    entities: s ? s.entityCount : 0,
    systemsMs: timings,
  };
}

async function run() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const consoleErrors = [];
  const consoleWarnings = [];
  const consoleLines = [];
  page.on('console', (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLines.push(line);
    if (msg.type() === 'error') consoleErrors.push(line);
    // Chromium's own GPU-process notes (e.g. SwiftShader "GPU stall due to ReadPixels") are not the app's.
    if (msg.type() === 'warning' && !msg.text().includes('GL Driver Message')) consoleWarnings.push(line);
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

    // --- New shift ---------------------------------------------------------------
    const newGame = page.getByRole('button', { name: 'New game' });
    const started = Date.now();
    if (await newGame.count()) {
      await page.fill('#seed', String(SEED));
      await newGame.click();
    } else {
      await page.evaluate((seed) => {
        window.patrol.newGame(seed);
      }, SEED);
    }
    const inGame = await waitFor(page, () => window.patrol.session !== null, null, 30000);
    console.log(`new game ready after ${Date.now() - started} ms (city generation + spawn)`);
    check(inGame, 'new shift started from the main menu');

    // Let chunks stream in and traffic settle.
    const streamed = await waitFor(
      page,
      () => {
        const stats = window.patrol.worldView?.streamer?.stats;
        return stats && stats.loaded >= 9 && stats.inFlight === 0;
      },
      null,
      60000,
    );
    if (!streamed) console.log('note: chunk streaming still in progress after 60 s');

    const state = await page.evaluate(() => {
      const app = window.patrol;
      const s = app.session;
      return {
        seed: s?.seed ?? null,
        fps: app.loop.stats.fps,
        steps: app.loop.step,
        paused: app.loop.paused,
        menuOpen: app.ui.isMenuOpen(),
        driving: s?.driving ?? null,
        vehicles: s ? s.vehicles.map((v) => v.model.id) : [],
        chunks: app.worldView?.streamer?.stats.loaded ?? 0,
        traffic: s?.traffic.activeCount ?? 0,
        drawCalls: app.renderer ? app.renderer.stats.drawCalls : 0,
        hudVisible: getComputedStyle(document.querySelector('#hud') ?? document.body).display !== 'none',
        minimap: document.querySelector('#minimap') !== null,
        time: s ? s.env.time.hour : null,
      };
    });
    console.log('state after new game:', JSON.stringify(state));
    check(state.seed === SEED, `session started with seed ${SEED}`);
    check(state.fps > 0, `loop running (fps ${state.fps.toFixed(1)})`);
    check(state.steps > 0 && !state.paused, `fixed steps advancing (${state.steps})`);
    check(!state.menuOpen, 'menus closed while playing');
    check(state.driving === false, 'officer starts on foot');
    check(state.vehicles.join(',') === 'patrol_sedan,patrol_suv', `patrol cars parked at the station (${state.vehicles.join(', ')})`);
    check(state.chunks > 0, `city chunks loaded (${state.chunks})`);
    check(state.traffic > 0, `ambient traffic active (${state.traffic})`);
    check(state.hudVisible && state.minimap, 'HUD and minimap shown');
    if (hasRenderer) {
      check(state.drawCalls > 0, `renderer drawing (${state.drawCalls} draw calls)`);
      check(state.drawCalls <= DRAW_CALL_CAP, `draw calls within the ${DRAW_CALL_CAP} cap (${state.drawCalls})`);
    }
    const perfOnFoot = await page.evaluate(perfSnapshot);
    const frameOnFoot = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);

    const toggles = await page.evaluate(() => {
      const app = window.patrol;
      app.perf.toggle();
      app.console.toggle();
      const consoleOpen = app.console.isOpen();
      app.console.close();
      return { perfVisible: app.perf.visible, consoleOpen, consoleClosed: !app.console.isOpen() };
    });
    check(toggles.perfVisible, 'perf overlay toggled on');
    check(toggles.consoleOpen && toggles.consoleClosed, 'debug console toggled open and closed');

    // --- Drive ---------------------------------------------------------------------
    const entered = await page.evaluate(() => window.patrol.enterVehicle(0));
    check(entered, 'entered the patrol car via window.patrol.enterVehicle(0)');
    const before = await page.evaluate(() => {
      const s = window.patrol.session;
      const body = s.physics.getBody(s.drivenVehicle.eid).translation();
      return { x: body.x, z: body.z, simTime: s.clock.simTime };
    });
    await page.keyboard.down('KeyW');
    let topSpeed = 0;
    const throttleStart = Date.now();
    while (Date.now() - throttleStart < 3000) {
      await sleep(250);
      const speed = await page.evaluate(() => window.patrol.session.drivenVehicle?.telemetry.speed ?? 0);
      topSpeed = Math.max(topSpeed, speed);
    }
    await page.keyboard.up('KeyW');
    const drive = await page.evaluate((from) => {
      const s = window.patrol.session;
      const v = s.drivenVehicle;
      const body = s.physics.getBody(v.eid).translation();
      return {
        speed: v.telemetry.speed,
        gear: v.telemetry.gear,
        rpm: Math.round(v.telemetry.rpm),
        moved: Math.hypot(body.x - from.x, body.z - from.z),
        simSeconds: s.clock.simTime - from.simTime,
        camera: window.patrol.rig.mode,
      };
    }, before);
    console.log(`drive: top speed ${topSpeed.toFixed(2)} m/s over ${drive.simSeconds.toFixed(2)} s of sim time:`, JSON.stringify(drive));
    check(topSpeed > 0 && drive.moved > 0.1, `throttle for 3 s moved the car (top speed ${topSpeed.toFixed(2)} m/s, ${drive.moved.toFixed(2)} m)`);
    check(drive.camera === 1, 'chase camera while driving');
    const perfDriving = await page.evaluate(perfSnapshot);

    // Day screenshot: mid-morning, clear, in the curb lane of the road in front of the station.
    await page.evaluate(async () => {
      const app = window.patrol;
      await app.console.execute('time 10:30');
      await app.console.execute('weather clear');
      const g = app.session.city.graph;
      const station = app.session.city.pois.find((p) => p.kind === 'station');
      const lane = station.entrance.edge * 16; // laneRef(edge, 0, 0): curb lane, from -> to
      const p = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
      g.lanePoint(lane, g.laneStart(lane) + 15, p);
      app.teleport(p.x, p.z, p.yaw);
    });
    await waitFor(page, () => (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 30000);
    await page.keyboard.down('KeyW');
    await sleep(2000);
    await page.keyboard.up('KeyW');
    await sleep(1500);
    await mkdir(SHOTS, { recursive: true });
    await page.evaluate(() => window.patrol.perf.setVisible(true));
    await page.screenshot({ path: path.join(SHOTS, 'phase1.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase1.png')}`);

    // --- World commands, weather and night -------------------------------------------
    const commands = await page.evaluate(async () => {
      const app = window.patrol;
      const c = app.console;
      const run = async (line) => {
        const before = c.lines.length;
        await c.execute(line);
        return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
      };
      const out = [];
      for (const line of ['road', 'car info', 'chunks', 'traffic stats', 'traffic list 5', 'traffic density 1', 'route hospital', 'route off', 'weather rain', 'time 22:00', 'time', 'weather', 'timescale 1', 'entities']) {
        out.push(...(await run(line)));
      }
      const firstPlate = app.session.trafficCars(1)[0]?.plate;
      if (firstPlate) out.push(...(await run(`plate ${firstPlate}`)));
      return out;
    });
    console.log('console commands:\n  ' + commands.join('\n  '));
    check(!commands.some((l) => l.startsWith('error:')), 'world console commands ran without errors');
    const night = await page.evaluate(() => {
      const s = window.patrol.session;
      return { hour: s.env.time.hour, weather: s.env.weather.kind, night: s.env.lighting.nightFactor, headlights: s.drivenVehicle?.headlights ?? false };
    });
    console.log('night:', JSON.stringify(night));
    check(Math.abs(night.hour - 22) < 0.2 && night.weather === 'rain', `time 22:00 + rain applied (${night.hour.toFixed(2)} h, ${night.weather})`);
    await page.keyboard.down('KeyW');
    await sleep(2000);
    await page.keyboard.up('KeyW');
    await sleep(2500);
    await page.screenshot({ path: path.join(SHOTS, 'phase1-night.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase1-night.png')}`);
    const perfNight = await page.evaluate(perfSnapshot);
    const frameNight = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
    // Software GL cost grows with the pixel count: a quarter of the pixels shows how much of the frame is rasterisation.
    await page.evaluate(() => window.patrol.console.execute('settings set graphics.renderScale 0.5'));
    const frameHalfScale = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
    await page.evaluate(() => window.patrol.console.execute('settings set graphics.renderScale 1'));

    // --- Save / load round trip ---------------------------------------------------------
    const saveLoad = await page.evaluate(async () => {
      const app = window.patrol;
      const s = app.session;
      const before = {
        mode: s.modes.mode,
        vehicles: s.vehicles.length,
        traffic: s.traffic.activeCount,
        hour: s.env.time.hour,
        weather: s.env.weather.kind,
        simTime: s.clock.simTime,
      };
      await app.saveGame('smoke');
      const list = await app.saves.list();
      await app.loadGame('smoke');
      const l = app.session;
      return {
        before,
        after: {
          mode: l.modes.mode,
          vehicles: l.vehicles.length,
          traffic: l.traffic.activeCount,
          hour: l.env.time.hour,
          weather: l.env.weather.kind,
          simTime: l.clock.simTime,
        },
        seed: l.seed,
        slots: list.map((x) => `${x.slot} v${x.version}`),
        camera: app.rig.mode,
      };
    });
    console.log('save/load:', JSON.stringify(saveLoad));
    check(saveLoad.slots.includes('smoke v3'), "slot 'smoke' listed as a v3 save");
    check(saveLoad.seed === SEED, `reloaded seed is ${SEED}`);
    check(saveLoad.after.mode === 1 && saveLoad.camera === 1, 'reloaded still driving, chase camera');
    check(saveLoad.after.vehicles === saveLoad.before.vehicles, `vehicles restored (${saveLoad.after.vehicles})`);
    check(saveLoad.after.traffic === saveLoad.before.traffic, `traffic restored (${saveLoad.after.traffic})`);
    check(saveLoad.after.simTime === saveLoad.before.simTime && Math.abs(saveLoad.after.hour - saveLoad.before.hour) < 1e-6, 'clock and time of day restored');
    check(saveLoad.after.weather === 'rain', 'weather override restored');

    // --- Phase 0 regressions -----------------------------------------------------------
    const fixes = await page.evaluate(async () => {
      const app = window.patrol;
      const out = {};
      await app.console.execute('settings set controls.gamepadDeadzone 0.4');
      out.deadzone = app.input.deadzone;
      await app.console.execute('settings set controls.gamepadDeadzone 0.15');
      await app.console.execute('pause');
      app.pauseMenu.open();
      app.pauseMenu.close();
      out.pausedAfterMenu = app.loop.paused;
      await app.console.execute('pause');
      out.runningAgain = !app.loop.paused;
      await app.console.execute('settings set accessibility.textScale 1.6');
      app.console.open();
      out.consoleFont = getComputedStyle(document.querySelector('#debug-console input') ?? document.body).fontSize;
      app.console.close();
      await app.console.execute('settings set accessibility.textScale 1');
      // New bindings appear in the rebinding UI.
      app.pauseMenu.open();
      app.settingsMenu.open('controls');
      out.bindingRows = [...document.querySelectorAll('.binding-row span[title]')].map((e) => e.getAttribute('title'));
      const remove = document.querySelector('.bindings .x');
      remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      out.stackAfterEscape = app.ui.menuStack.map((m) => m.id);
      app.settings.reset();
      app.ui.closeAll();
      // Draw distance drives the streaming radius (fog far).
      await app.console.execute('settings set graphics.drawDistance 400');
      await new Promise((r) => setTimeout(r, 1500));
      out.viewShort = app.envRenderer?.viewDistance ?? 0;
      await app.console.execute('settings set graphics.drawDistance 800');
      await new Promise((r) => setTimeout(r, 1500));
      out.viewDefault = app.envRenderer?.viewDistance ?? 0;
      return out;
    });
    console.log('settings checks:', JSON.stringify({ ...fixes, bindingRows: fixes.bindingRows.length }));
    check(fixes.deadzone === 0.4, 'gamepad deadzone setting applied to input');
    check(fixes.pausedAfterMenu && fixes.runningAgain, 'console pause survives a menu open/close');
    check(fixes.consoleFont === '20.8px', `console font follows text size (${fixes.consoleFont})`);
    check(
      ['vehicle.handbrake', 'vehicle.headlights', 'map.toggle', 'interact'].every((a) => fixes.bindingRows.includes(a)),
      'new driving bindings listed in the rebinding UI',
    );
    check(fixes.stackAfterEscape.length === 1 && fixes.stackAfterEscape[0] === 'pause', `Escape closes Settings (stack ${fixes.stackAfterEscape.join(',')})`);
    if (hasRenderer) {
      check(fixes.viewShort < fixes.viewDefault, `draw distance drives the view/streaming distance (${fixes.viewShort} m < ${fixes.viewDefault} m)`);
    }

    console.log('perf on foot:  ', JSON.stringify(perfOnFoot));
    console.log('perf driving:  ', JSON.stringify(perfDriving));
    console.log('perf night/rain:', JSON.stringify(perfNight));
    const describe = (label, f) =>
      `  ${label.padEnd(34)} ${f.fps} fps, ${f.frameMs} ms/frame = sim ${f.simMs} ms (${f.stepsPerFrame} steps) + update ${f.updateMs} ms` +
      ` + render ${f.renderMs} ms (draw submit ${f.drawSubmitMs} ms) + GPU wait ${f.gpuWaitMs} ms`;
    console.log(`frame breakdown (SwiftShader software GL, 1280x720, ${BREAKDOWN_FRAMES} frames each):`);
    console.log(describe('on foot, day:', frameOnFoot));
    console.log(describe('driving, night + rain:', frameNight));
    console.log(describe('driving, night + rain, scale 0.5:', frameHalfScale));
    check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
    check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
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
