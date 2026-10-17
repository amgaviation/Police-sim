#!/usr/bin/env node
/**
 * Browser smoke test (Phases 0-2).
 *
 * Starts the Vite dev server (unless SMOKE_URL points at a running one), drives
 * the game in headless Chromium with SwiftShader: a new shift in the city, chunk
 * streaming and traffic, getting into the patrol car and driving it, weather and
 * night, the world console commands, a save/load round trip, settings, and the perf
 * numbers (including a per-frame cost breakdown under software GL). Phase 2: the CAD
 * roster and AI fleet, a generated call reaching the MDT queue and an AI unit driving
 * to it, the MDT opening and closing without pausing, siren / tone / lights / pattern /
 * spotlight keys, a traffic stop (lights behind a car), its plate run (P), the driver
 * contact panel, a citation issued from the MDT, the radio log, the Phase 2 console
 * commands and a v4 save/load keeping CAD, records, radio and equipment.
 * Writes docs/screenshots/phase1.png, phase1-night.png, phase2.png (cockpit with the
 * in-car MDT) and phase2-mdt.png (the MDT overlay).
 *
 * Usage: npm run smoke  (or: node scripts/smoke.mjs)
 */
/* global window, document, getComputedStyle, MouseEvent, KeyboardEvent, requestAnimationFrame -- functions passed to page.evaluate run in the browser */
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

/** Runs `n` fixed steps right now through the app's own loop hook (sim, systems, events), like the loop does. */
function stepSim(n) {
  const app = window.patrol;
  const fixed = app.loop.hooks.fixedUpdate; // private in TypeScript, a plain property at runtime
  for (let i = 0; i < n; i++) fixed(1 / 60, 0);
}

/** Presses `key` (a KeyboardEvent.code) and waits for a frame or two to see it. */
async function press(page, key, holdMs = 0) {
  await page.keyboard.down(key);
  await sleep(holdMs);
  await page.keyboard.up(key);
  await waitFrames(page, 2);
}

/** Waits for `n` animation frames in the page (the game loop updates once per frame, before these callbacks). */
async function waitFrames(page, n) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/**
 * Phase 2 checks on the running (loaded, driving) session. Returns the perf numbers taken on the way.
 */
async function phase2(page, hasRenderer) {
  // --- Shift state: CAD roster, AI fleet, equipped patrol cars, radio log ---------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    app.ui.closeAll();
    app.perf.setVisible(false); // the Phase 2 screenshots show the MDT and the cockpit unobstructed
    await app.console.execute('time 10:00');
    await app.console.execute('weather clear');
  });
  const roster = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    let fleet = 0;
    for (let i = 0; i < 16; i++) if (s.traffic.fleetEntity(i) !== 0) fleet++;
    return {
      units: s.cad.units().map((u) => `${u.callsign}:${u.status}`),
      fleet,
      equipped: s.vehicles.map((v) => s.equipmentOf(v) !== null),
      driving: s.driving,
      mdt: app.mdt !== null,
      radioPanel: app.radioPanel !== null,
    };
  });
  console.log('patrol roster:', JSON.stringify(roster));
  check(roster.units.length === 7 && roster.units[0]?.startsWith('12:'), `CAD roster: player unit 12 and six AI units (${roster.units.join(', ')})`);
  check(roster.fleet === 6, `AI units drive fleet cars (${roster.fleet})`);
  check(roster.equipped.every(Boolean), 'both patrol cars carry equipment (siren, light bar, spotlight, rack, cage, trunk, MDT)');

  // --- A generated call reaches the queue and an AI unit drives to it ------------------------
  const callFlow = await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const before = s.dispatcher.stats.generated;
    let steps = 0;
    while (s.dispatcher.stats.generated === before && steps < 60 * 400) {
      step(60);
      steps += 60;
    }
    const generated = s.cad.calls().filter((c) => !c.selfInitiated && c.status !== 'closed');
    const call = generated[generated.length - 1];
    if (!call) return { generated: s.dispatcher.stats.generated - before, simSeconds: steps / 60 };
    let unit = null;
    for (let k = 0; k < 200 && unit === null; k++) {
      const c = s.cad.call(call.id);
      if (!c || c.status === 'closed') break;
      // Offers to the player go to the AI units once declined (here through the MDT's own request).
      if (c.offeredTo === s.dispatcher.playerCallsign) app.mdt.declineCall(c.id);
      unit = c.units.find((u) => u !== s.dispatcher.playerCallsign) ?? null;
      if (unit === null) step(30);
    }
    const u0 = unit ? s.cad.unit(unit) : null;
    const from = u0 ? { x: u0.x, z: u0.z } : null;
    const fs = { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
    const left0 = u0 ? (s.traffic.fleetState(u0.fleetIndex, fs)?.routeLeftM ?? -1) : -1;
    step(60 * 20);
    const u1 = unit ? s.cad.unit(unit) : null;
    const left1 = u1 ? (s.traffic.fleetState(u1.fleetIndex, fs)?.routeLeftM ?? -1) : -1;
    return {
      generated: s.dispatcher.stats.generated - before,
      simSeconds: Math.round(steps / 60),
      call: `${call.number} P${call.priority} ${call.nature} at ${call.location.text}`,
      callNumber: call.number,
      unit,
      status: u1?.status ?? null,
      mode: fs.mode,
      moved: from && u1 ? Math.round(Math.hypot(u1.x - from.x, u1.z - from.z)) : 0,
      left0: Math.round(left0),
      left1: Math.round(left1),
    };
  }, stepSim.toString());
  console.log('call flow:', JSON.stringify(callFlow));
  check(callFlow.generated > 0 && typeof callFlow.callNumber === 'string', `the generator created a call (${callFlow.call ?? 'none'}, after ${callFlow.simSeconds} sim s)`);
  check(callFlow.unit !== null && callFlow.unit !== undefined, `an AI unit was dispatched to it (${callFlow.unit ?? 'none'}, ${callFlow.status ?? '-'})`);
  check(
    callFlow.moved > 30 && (callFlow.left1 < callFlow.left0 || callFlow.status === 'onScene'),
    `the AI unit drove towards the call (${callFlow.mode}, moved ${callFlow.moved} m, route left ${callFlow.left0} m -> ${callFlow.left1} m)`,
  );

  // --- The MDT opens with Tab (driving a patrol car), shows the queue, and closes with Escape without pausing ---
  await press(page, 'Tab');
  await waitFor(page, () => window.patrol.mdt?.isOpen === true, null, 10000);
  const mdtOpen = await page.evaluate(async (callNumber) => {
    const app = window.patrol;
    const steps0 = app.loop.step;
    await new Promise((r) => setTimeout(r, 2500));
    const root = app.mdt.element;
    return {
      open: app.mdt.isOpen,
      paused: app.loop.paused,
      advanced: app.loop.step - steps0,
      tab: app.mdt.tab,
      queueHasCall: callNumber !== null && root.textContent.includes(callNumber),
      covered: getComputedStyle(root).display !== 'none',
      // Non-pausing overlays get the light, blur-free layer (Menu.pausesGame === false).
      live: root.closest('.menu-layer')?.classList.contains('menu-layer-live') === true,
    };
  }, callFlow.callNumber ?? null);
  console.log('MDT open:', JSON.stringify(mdtOpen));
  check(mdtOpen.open && mdtOpen.tab === 'queue', 'Tab opens the MDT on the Queue tab');
  check(
    !mdtOpen.paused && mdtOpen.advanced > 0 && mdtOpen.live,
    `the world keeps running behind the MDT (not paused, ${mdtOpen.advanced} steps, ${mdtOpen.live ? 'live layer' : 'dimmed layer'})`,
  );
  check(mdtOpen.queueHasCall, `the generated call is in the MDT queue (${callFlow.callNumber ?? '-'})`);
  await page.evaluate(() => window.patrol.mdt.setTab('map'));
  await sleep(1200);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'phase2-mdt.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase2-mdt.png')}`);
  const frameMdt = await page.evaluate(frameBreakdown, 5);
  await page.evaluate(() => window.patrol.mdt.setTab('queue'));
  await press(page, 'Escape');
  await waitFor(page, () => window.patrol.mdt?.isOpen === false, null, 10000);
  const mdtClosed = await page.evaluate(() => ({ open: window.patrol.mdt.isOpen, paused: window.patrol.loop.paused, stack: window.patrol.ui.menuStack.map((m) => m.id) }));
  check(!mdtClosed.open && !mdtClosed.paused && mdtClosed.stack.length === 0, `Escape closes the MDT without opening the pause menu (stack: ${mdtClosed.stack.join(',') || 'empty'})`);

  // --- Siren, tone, lights, pattern and spotlight keys ------------------------------------------
  await press(page, 'KeyQ');
  await press(page, 'KeyR');
  await press(page, 'KeyL');
  await press(page, 'KeyK');
  await press(page, 'KeyJ');
  await waitFor(page, () => /SIREN YELP/.test(document.querySelector('#hud')?.textContent ?? ''), null, 8000);
  const kit = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const eq = s.drivenEquipment;
    const hud = document.querySelector('#hud')?.textContent ?? document.body.textContent;
    return {
      siren: eq.sirenOn,
      tone: eq.tone,
      lights: s.drivenVehicle.lightbar,
      pattern: eq.pattern,
      spot: eq.spotOn,
      hudPolice: /SIREN YELP/.test(hud) && /SPOT/.test(hud),
      audio: { available: app.audio.available, unlocked: app.audio.unlocked, voices: app.audio.stats.voices, active: app.audio.stats.active },
    };
  });
  console.log('equipment keys:', JSON.stringify(kit));
  check(kit.siren && kit.tone === 'yelp', `Q switches the siren on, R cycles the tone (${kit.tone})`);
  check(kit.lights && kit.pattern === 1, `L switches the light bar on, K cycles the pattern (index ${kit.pattern})`);
  check(kit.spot, 'J switches the spotlight on');
  check(kit.hudPolice, 'HUD police line shows the siren tone and the spotlight');
  check(!kit.audio.available || (kit.audio.unlocked && kit.audio.active >= 1), `siren audio plays in the cabin (${kit.audio.active}/${kit.audio.voices} voices)`);
  await press(page, 'KeyQ'); // siren off: lights alone stop a car (lights + siren make traffic yield)

  // --- Traffic stop: lights behind a car ------------------------------------------------------
  const stop = await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const car = s.drivenVehicle;
    car.lightbar = false;
    const g = s.city.graph;
    const lane = 58 * 16; // laneRef(58, 0, 0): a straight arterial curb lane
    const s0 = g.laneStart(lane) + 40;
    const p = g.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    app.teleport(p.x, p.z, p.yaw);
    step(30);
    const slot = s.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior: 0, desiredFactor: 0.3 });
    const vehicleId = s.traffic.view.vehicleId[slot];
    car.lightbar = true;
    // Creep after it (stop detection needs the patrol car moving), then brake once it is the stop target.
    const d = s.driverInput;
    d.handbrake = false;
    d.brake = 0;
    d.accelerate = 0.35;
    let n = 0;
    while (s.cad.trafficStop === null && n < 900) {
      step(1);
      n++;
    }
    // Brake only while still rolling forwards (a held brake at a standstill is reverse), then hold the handbrake.
    d.accelerate = 0;
    d.brake = 1;
    for (let i = 0; i < 300 && car.telemetry.speed > 0.2; i++) step(1);
    d.brake = 0;
    d.handbrake = true;
    step(30);
    d.handbrake = false;
    const st = s.cad.trafficStop;
    return { vehicleId, active: st?.outcome === 'active', stopVehicle: st?.vehicleId ?? -1, plate: st?.plate ?? '', seconds: Number((n / 60).toFixed(2)), callId: st?.callId ?? -1 };
  }, stepSim.toString());
  console.log('traffic stop:', JSON.stringify(stop));
  check(stop.active && stop.stopVehicle === stop.vehicleId, `the car ahead pulled over for the light bar (${stop.plate}, ${stop.seconds} s)`);

  // Get out and stand behind the stopped car looking at it: the reticle locks it and P runs its plate.
  await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const s = window.patrol.session;
    // The handbrake, not the brake: a held brake at a standstill reverses the car.
    s.driverInput.handbrake = true;
    for (let i = 0; i < 300 && s.drivenVehicle.telemetry.groundSpeed > 0.3; i++) step(1);
  }, stepSim.toString());
  await press(page, 'KeyE');
  const gotOut = await waitFor(page, () => window.patrol.session.driving === false, null, 10000);
  await page.evaluate(() => {
    window.patrol.session.driverInput.handbrake = false;
  });
  check(Boolean(gotOut), 'E got out of the car at the stop');
  if (!gotOut) throw new Error('still in the car: cannot walk up to the stopped car');
  await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const s = window.patrol.session;
    const st = s.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
    // 7 m behind the car (its rear is +z in its frame), facing the way it faces.
    s.physics.getBody(s.player).setTranslation({ x: st.x + 7 * Math.sin(st.yaw), y: 0.9, z: st.z + 7 * Math.cos(st.yaw) }, true);
    s.controller.yaw = st.yaw;
    s.controller.pitch = 0.15;
    step(2);
  }, stepSim.toString());
  const locked = await waitFor(page, (id) => window.patrol.target?.vehicleId === id, stop.vehicleId, 10000);
  check(Boolean(locked), `the reticle locks the stopped car (${await page.evaluate(() => window.patrol.target?.plate ?? 'none')})`);
  await press(page, 'KeyP');
  await waitFor(page, () => window.patrol.session.cad.trafficStop?.plateRun === true, null, 15000);
  const plateRun = await page.evaluate((id) => {
    const app = window.patrol;
    const run = app.policeFeed.plateRun(id);
    return { plateRun: app.session.cad.trafficStop?.plateRun ?? false, result: run?.result ?? '', severity: run?.severity ?? 'none' };
  }, stop.vehicleId);
  console.log('plate run:', JSON.stringify(plateRun));
  check(plateRun.plateRun && plateRun.result !== '', `P ran the stopped car's plate (${plateRun.result}, ${plateRun.severity})`);
  await waitFor(page, (plate) => (document.querySelector('#hud')?.textContent ?? '').includes(plate), stop.plate, 5000);
  const hudTarget = await page.evaluate((plate) => (document.querySelector('#hud')?.textContent ?? '').includes(plate), stop.plate);
  check(hudTarget, `HUD target line shows the plate and its result (${stop.plate})`);

  // Walk to the driver window and use the contact panel: licence, then write a citation in the MDT.
  const atWindow = await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const s = window.patrol.session;
    const st = s.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
    // Driver door / window: left side (local -x), a third back from the front, just outside the body (sedan-sized).
    const lx = -(0.95 + 0.4);
    const lz = -2.3 / 3;
    const x = st.x + lx * Math.cos(st.yaw) + lz * Math.sin(st.yaw);
    const z = st.z - lx * Math.sin(st.yaw) + lz * Math.cos(st.yaw);
    s.physics.getBody(s.player).setTranslation({ x, y: 0.9, z }, true);
    step(2);
    return { hint: s.interactHint(), phase: st.phase };
  }, stepSim.toString());
  check(atWindow.hint === 'driver', `on foot at the stopped car's window the prompt offers the driver (${atWindow.hint ?? 'none'})`);
  await press(page, 'KeyE');
  await waitFor(page, () => window.patrol.panels.kind === 'contact', null, 10000);
  const contact = await page.evaluate(() => ({ kind: window.patrol.panels.kind, text: document.querySelector('.panel-action')?.textContent ?? '' }));
  check(contact.kind === 'contact' && contact.text.includes('Request licence'), 'E opens the driver contact panel');
  await press(page, 'Digit1'); // Request licence
  await waitFor(page, () => (window.patrol.session.cad.trafficStop?.driverId ?? -1) >= 0, null, 15000);
  await press(page, 'Digit3'); // Write citation -> MDT citation form
  await waitFor(page, () => window.patrol.mdt?.isOpen === true && window.patrol.mdt.formKind === 'citation', null, 10000);
  await page.getByRole('button', { name: 'Add violation' }).click();
  await page.getByRole('button', { name: 'Issue citation' }).click();
  await waitFor(page, () => window.patrol.session.cad.docs.list('citation').some((d) => d.status === 'final'), null, 10000);
  await waitFor(page, () => (window.patrol.session.cad.trafficStop?.citations.length ?? 0) > 0, null, 15000);
  const citation = await page.evaluate(() => {
    const app = window.patrol;
    const doc = app.session.cad.docs.list('citation').find((d) => d.status === 'final');
    return { id: doc?.id ?? '', total: doc?.totalFine ?? 0, violations: doc?.violations.map((v) => v.statuteId) ?? [], person: doc?.personId ?? -1, message: app.mdt.message, onStop: app.session.cad.trafficStop?.citations ?? [] };
  });
  console.log('citation:', JSON.stringify(citation));
  check(citation.id !== '' && citation.violations.length > 0 && citation.onStop.includes(citation.id), `citation ${citation.id} issued from the MDT ($${citation.total}, ${citation.violations.join(', ')})`);
  await press(page, 'Escape');
  await waitFor(page, () => window.patrol.ui.isMenuOpen() === false, null, 10000);
  // Release the driver from the contact panel.
  await press(page, 'KeyE');
  await waitFor(page, () => window.patrol.panels.kind === 'contact', null, 10000);
  await press(page, 'Digit5');
  await waitFor(page, () => window.patrol.session.cad.trafficStop?.outcome === 'released', null, 15000);
  const released = await page.evaluate((callId) => {
    const s = window.patrol.session;
    return { outcome: s.cad.trafficStop?.outcome ?? '', disposition: s.cad.call(callId)?.disposition ?? null, menus: window.patrol.ui.menuStack.length };
  }, stop.callId);
  check(released.outcome === 'released' && released.disposition === 'citationIssued', `released: the stop call closed as ${released.disposition}`);

  // --- Radio log ------------------------------------------------------------------------------
  const radio = await page.evaluate(() => {
    const app = window.patrol;
    return {
      lines: app.radioPanel.lines.length,
      shown: document.querySelectorAll('.radio-line:not([hidden])').length,
      log: app.session.radio.log.length,
      sample: app.radioPanel.lines.slice(-3).map((l) => `${l.clock} ${l.channel} ${l.speaker}: ${l.text}`),
    };
  });
  console.log('radio:', JSON.stringify(radio));
  check(radio.lines > 0 && radio.shown > 0 && radio.log > 0, `radio log has lines (${radio.lines} in the panel, ${radio.log} in the log)`);

  // --- Phase 2 console commands -----------------------------------------------------------------
  const commands = await page.evaluate(async () => {
    const app = window.patrol;
    const c = app.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    const plate = app.session.records.registration(4711).plate;
    for (const line of ['cad call alarm', 'cad units', 'cad calls', `lookup plate ${plate}`, 'lookup person 17', 'radio say Smoke test, radio check', 'radio channel tac', 'radio channel dispatch', 'siren wail', 'siren off', 'lights quad', 'equip', 'platestates 1', 'dispatch stats', 'dispatch units', 'fleet', 'docs']) {
      out.push(...(await run(line)));
    }
    return out;
  });
  console.log('phase 2 console commands:\n  ' + commands.join('\n  '));
  check(!commands.some((l) => l.startsWith('error:')), 'Phase 2 console commands ran without errors');

  // --- Save / load v4 keeps CAD, records, radio and equipment -----------------------------------
  const saveLoad = await page.evaluate(async () => {
    const app = window.patrol;
    const snap = () => {
      const s = app.session;
      return {
        calls: s.cad.calls().map((c) => `${c.number}:${c.status}`).join(','),
        docs: s.cad.docs.list().map((d) => `${d.id}:${d.status}`).join(','),
        records: JSON.stringify(s.records.serialize()),
        radio: `${s.radio.selected}:${s.radio.scanning}:${s.radio.log.length}`,
        equipment: JSON.stringify(s.vehicles.map((v) => s.equipmentOf(v)?.serialize() ?? null)),
        kit: JSON.stringify(s.officerKit.serialize()),
        units: s.cad.units().map((u) => `${u.callsign}:${u.status}`).join(','),
      };
    };
    app.session.radio.toggleScan();
    const before = snap();
    await app.saveGame('smoke-phase2');
    const list = await app.saves.list();
    await app.loadGame('smoke-phase2');
    const after = snap();
    return { before, after, slot: list.find((x) => x.slot === 'smoke-phase2')?.version ?? -1 };
  });
  const same = (k) => saveLoad.before[k] === saveLoad.after[k];
  console.log('phase 2 save/load:', JSON.stringify({ slot: saveLoad.slot, calls: saveLoad.after.calls, docs: saveLoad.after.docs, radio: saveLoad.after.radio, units: saveLoad.after.units }));
  check(saveLoad.slot === 4, `saved as v4 (${saveLoad.slot})`);
  check(same('calls') && same('docs') && same('units'), 'save/load v4 keeps the CAD (calls, units, documents)');
  check(same('records'), 'save/load v4 keeps the records (touched persons and vehicles, contacts, query log)');
  check(same('radio'), `save/load v4 keeps the radio (${saveLoad.after.radio})`);
  check(same('equipment') && same('kit'), 'save/load v4 keeps the patrol car equipment, trunk and the officer kit');

  // --- Cockpit with the in-car MDT --------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    if (!app.session.driving) app.enterVehicle(0);
    app.rig.setVehicleMode(3); // CAMERA_MODE.cockpit
    app.session.cameraMode = 3;
    app.rig.orbitYaw.value = -0.42; // look right, at the laptop (private in TypeScript)
    app.rig.orbitPitch.value = 0.12;
  });
  await sleep(4000);
  const cockpit = await page.evaluate(() => ({
    mode: window.patrol.rig.mode,
    drawCalls: window.patrol.cockpit?.stats.drawCalls ?? 0,
    screen: window.patrol.mdtScreen.canvas !== null,
  }));
  if (hasRenderer) check(cockpit.mode === 3 && cockpit.drawCalls > 0 && cockpit.drawCalls <= 6, `cockpit interior drawn in cockpit view (${cockpit.drawCalls} draw calls)`);
  await page.screenshot({ path: path.join(SHOTS, 'phase2.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase2.png')}`);
  const perf = await page.evaluate(perfSnapshot);
  const frameCockpit = await page.evaluate(frameBreakdown, 5);
  await page.evaluate(() => {
    const app = window.patrol;
    app.rig.setVehicleMode(1);
    app.session.cameraMode = 1;
    app.perf.setVisible(true);
  });
  return { perf, frameCockpit, frameMdt };
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
    check(saveLoad.slots.includes('smoke v4'), "slot 'smoke' listed as a v4 save");
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

    const phase2Perf = await phase2(page, hasRenderer);

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
    console.log(describe('cockpit + in-car MDT, day:', phase2Perf.frameCockpit));
    console.log(describe('MDT overlay open, day:', phase2Perf.frameMdt));
    console.log('perf phase 2 (cockpit):', JSON.stringify(phase2Perf.perf));
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
