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
 * commands and a v5 save/load keeping CAD, records, radio and equipment. Phase 3: pedestrians downtown,
 * the call stream from the 150+ type catalog, a spawned call's scene (scene panel, knock), the dialogue panel
 * answering to the real keys, weapon keys, an SFST panel run with the keys, foot and vehicle pursuits, and the
 * end-to-end flows through window.patrol (domestic with cage, shoplifting, lie detection, DUI to booking, a false
 * and a duplicate call), a v5 save/load and the Phase 3 console commands.
 * Writes docs/screenshots/phase1.png, phase1-night.png, phase2.png (cockpit with the
 * in-car MDT), phase2-mdt.png (the MDT overlay), phase3.png (a call scene with people) and
 * phase3-dialogue.png (the dialogue panel).
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

/** Says `id` in the open dialogue panel with the real keys (topic digit, option digit) and waits for the answer. */
async function dialogueSay(page, id) {
  const where = await page.evaluate((utterance) => {
    const c = window.patrol.session.contact;
    const v = c.view(c.active);
    const ti = v.topics.findIndex((t) => t.options.some((o) => o.id === utterance));
    const oi = ti < 0 ? -1 : v.topics[ti].options.findIndex((o) => o.id === utterance);
    return { ti, oi, before: v.transcript.length };
  }, id);
  if (where.ti < 0) throw new Error(`utterance ${id} is not offered`);
  await press(page, 'Backspace'); // back to the topic list
  await press(page, `Digit${where.ti + 1}`);
  await press(page, `Digit${where.oi + 1}`);
  await waitFor(
    page,
    (before) => {
      const c = window.patrol.session.contact;
      const v = c.view(c.active);
      return v !== null && v.transcript.length >= before + 2 && !v.busy;
    },
    where.before,
    20000,
  );
}

/**
 * The end-to-end Phase 3 flows, run in the page with fast-forwarded sim time (`stepSrc` = stepSim): a domestic
 * disturbance (knock, victim ID and account, kneel, cuff, escort, cage), a shoplifting call with its guard and
 * suspect, lie detection on people with fake IDs, a DUI stop (ID, drinking, PBT, SFST, step out, cuff, cage, booking),
 * a false call and a duplicate call. Returns `{ name: { ok, detail } }`.
 */
function phase3Flows(stepSrc) {
  const step = new Function(`return ${stepSrc}`)();
  const app = window.patrol;
  const s = app.session;
  const out = {};
  const note = (name, ok, detail = '') => {
    out[name] = { ok: Boolean(ok), detail: String(detail) };
  };
  const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
  const actor = (id) => ({ ...s.npc.actor(id, scratch) });
  const pos = () => s.playerPosition({ x: 0, z: 0 });
  const place = (x, z) => {
    s.physics.getBody(s.player).setTranslation({ x, y: 0.9, z }, true);
    step(1);
  };
  const say = (cid, utterance, n = 300) => {
    s.contact.request({ kind: 'say', contactId: cid, utteranceId: utterance, tone: 'polite' });
    step(n);
  };
  const act = (cid, action, n = 60) => {
    s.contact.request({ kind: 'action', contactId: cid, action });
    step(n);
  };
  const open = (aid) => {
    s.contact.request({ kind: 'open', target: { kind: 'actor', actorId: aid } });
    step(5);
    return s.contact.active;
  };
  const close = (cid) => {
    s.contact.request({ kind: 'close', contactId: cid });
    step(5);
  };
  const meet = (aid) => {
    const a = actor(aid);
    place(a.x - 1.2, a.z);
    step(20);
    return open(aid);
  };
  const walkTo = (x, z, until, max = 6000) => {
    let n = 0;
    for (; n < max && !until(); n++) {
      const p = pos();
      const d = Math.hypot(x - p.x, z - p.z);
      const k = Math.min(1, 0.03 / Math.max(d, 1e-6));
      s.physics.getBody(s.player).setTranslation({ x: p.x + (x - p.x) * k, y: 0.9, z: p.z + (z - p.z) * k }, true);
      step(1);
    }
    return n;
  };
  const yawOf = (eid) => {
    const q = s.physics.getBody(eid).rotation();
    return 2 * Math.atan2(q.y, q.w);
  };
  const rearDoor = (car) => {
    const t = s.physics.getBody(car.eid).translation();
    const yaw = yawOf(car.eid);
    const back = car.model.body.length * 0.15;
    const side = car.model.body.width / 2 + 0.2;
    return { x: t.x + Math.sin(yaw) * back + Math.cos(yaw) * side, z: t.z + Math.cos(yaw) * back - Math.sin(yaw) * side };
  };
  const setCar = (car, x, z) => {
    const b = s.physics.getBody(car.eid);
    b.setTranslation({ x, y: b.translation().y, z }, true);
    b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  };
  const spawnWith = (typeId, roles, variants = [], branch = null) => {
    const at = pos();
    for (let k = 0; k < 40; k++) {
      const id = s.scene.spawnCall(typeId, s.now(), { x: at.x + 30, z: at.z - 30 }, variants);
      const rt = s.scene.runtime(id);
      const ok = rt && roles.every((r) => rt.scenario.participants.some((p) => p.role === r)) && (branch === null || rt.scenario.branch === branch) && (variants.length > 0 || rt.scenario.variants.length === 0);
      if (ok) return id;
      s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
      step(2);
    }
    return 0;
  };
  const goToScene = (callId) => {
    const rt = s.scene.runtime(callId);
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId }, 'key');
    step(5);
    s.teleport(rt.scenario.anchor.x - 15, rt.scenario.anchor.z);
    step(120);
    return rt;
  };
  const actorsOf = (rt) => rt.actorIds.filter((a) => a > 0).map((a) => actor(a));
  const knock = (callId) => {
    const model = s.scene.panelModel(callId);
    const i = model.options.findIndex((o) => o.label.startsWith('Knock'));
    if (i >= 0) s.scene.panelSelect(callId, i);
    step(900);
  };
  const clearCall = (callId) => {
    s.scene.request({ kind: 'clear', callId, disposition: null });
    for (let i = 0; i < 100 && s.cad.call(callId)?.status !== 'closed'; i++) step(600);
  };

  step(60);
  // --- A false call and a duplicate call --------------------------------------------------------
  const fal = s.scene.spawnCall('noiseComplaint', s.now(), { x: pos().x + 30, z: pos().z - 30 }, ['false']);
  const frt = goToScene(fal);
  const roles = frt.scenario.participants.map((p) => p.role);
  const onlyCaller = roles.every((r) => r === 'caller');
  clearCall(fal);
  const fout = s.scene.outcomes().find((o) => o.callId === fal);
  note('falseCall', frt.materialized && frt.scenario.variants.includes('false') && onlyCaller && ['unfounded', 'gone'].includes(fout?.outcomeId), `variants ${frt.scenario.variants.join(',')}, roles ${roles.join(',') || '-'}, outcome ${fout?.outcomeId}`);
  // A duplicate call needs a later 'linked call' timeline entry (the duplicate variant alone may only add callers).
  let dupId = 0;
  for (let k = 0; k < 40 && dupId === 0; k++) {
    const cand = s.scene.spawnCall('loudParty', s.now(), { x: pos().x - 40, z: pos().z + 40 }, ['duplicate']) || s.scene.spawnCall('loudParty', s.now(), undefined, ['duplicate']);
    if (cand !== 0 && s.scene.runtime(cand)?.scenario.timeline.some((e) => e.kind === 'linkedCall')) dupId = cand;
    else if (cand !== 0) {
      s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: cand, disposition: 'unfounded' }, 'key');
      step(2);
    }
  }
  for (let i = 0; i < 40 && (s.cad.call(dupId)?.links.length ?? 0) === 0; i++) step(600);
  const orig = s.cad.call(dupId);
  const dup = s.cad.call(orig?.links[0] ?? -1);
  note('duplicateCall', orig?.links.length > 0 && dup?.status === 'closed' && dup?.disposition === 'duplicate' && dup?.links.includes(dupId), `call ${dupId} ${orig?.status}, timeline ${(s.scene.runtime(dupId)?.scenario.timeline ?? []).map((t) => `${t.kind}@${t.atS}`).join(',') || '-'}, variants ${(s.scene.runtime(dupId)?.scenario.variants ?? []).join(',')}, links ${orig?.links.join(',')}, duplicate ${dup?.status}/${dup?.disposition}`);

  // --- Domestic disturbance ---------------------------------------------------------------------
  const dom = spawnWith('domesticDisturbance', ['victim', 'suspect']);
  const drt = goToScene(dom);
  knock(dom);
  const dactors = actorsOf(drt);
  const victim = dactors.find((a) => a.role === 'victim');
  const suspect = dactors.find((a) => a.role === 'suspect');
  const vc = meet(victim.id);
  say(vc, 'requestId');
  say(vc, 'askAccount', 400);
  const vview = s.contact.view(vc);
  close(vc);
  note('domesticVictim', vview.statements.some((n) => n.text.includes('Account')) && vview.facts.some((f) => f.text.includes('Identity')), `${vview.statements.length} statements, ${vview.facts.length} facts`);
  const sc = meet(suspect.id);
  s.npc.forceState(suspect.id, 'kneel');
  step(90);
  act(sc, 'cuff', 120);
  const cuffed = actor(suspect.id).cuffed;
  act(sc, 'escort', 30);
  close(sc);
  const car0 = s.vehicles[0];
  const here = pos();
  setCar(car0, here.x + 8, here.z);
  step(10);
  const door = rearDoor(car0);
  walkTo(door.x, door.z, () => s.cageCarIndex() >= 0);
  const hint = s.interactHint();
  const cageResult = s.interact();
  step(10);
  note('domesticCage', cuffed && hint === 'cage' && cageResult === 'cage' && s.prisoner() === suspect.personId, `cuffed ${cuffed}, hint ${hint}, interact ${cageResult}, prisoner ${s.prisoner()}`);
  clearCall(dom);
  note('domesticOutcome', s.scene.outcomes().some((o) => o.callId === dom && o.typeId === 'domesticDisturbance'), s.scene.outcomes().filter((o) => o.callId === dom).map((o) => `${o.branch}->${o.outcomeId}`).join(','));
  s.releasePrisoner(suspect.personId);

  // --- Shoplifting: store guard and suspect -----------------------------------------------------
  const shop = spawnWith('shopliftingDetained', ['guard', 'suspect'], [], 'detained');
  const srt = goToScene(shop);
  step(300);
  const sactors = actorsOf(srt);
  const guard = sactors.find((a) => a.role === 'guard');
  const thief = sactors.find((a) => a.role === 'suspect');
  for (const a of [guard, thief]) {
    const cid = meet(a.id);
    say(cid, 'requestId');
    say(cid, 'askAccount', 400);
    close(cid);
  }
  const tc = meet(thief.id);
  s.npc.forceState(thief.id, 'kneel');
  step(90);
  act(tc, 'cuff', 120);
  close(tc);
  note('shoplifting', srt.flags.has('contacted:guard') && srt.flags.has('contacted:suspect') && srt.flags.has('custody:suspect'), [...srt.flags].filter((f) => /contacted|custody/.test(f)).join(','));
  clearCall(shop);
  note('shopliftingOutcome', s.scene.outcomes().some((o) => o.callId === shop && o.outcomeId === 'arrest'), s.scene.outcomes().filter((o) => o.callId === shop).map((o) => o.outcomeId).join(','));

  // --- Lie detection ----------------------------------------------------------------------------
  const liars = [];
  for (let p = 0; p < 40000 && liars.length < 14; p++) {
    const i = s.people.identity(p);
    if (!i.juvenile && i.age > 20 && i.age < 60 && i.hearing === 'normal' && i.language.english === 'fluent' && !i.dementia && i.baseItems.some((x) => x.item === 'fakeId')) liars.push(p);
  }
  const found = [];
  let early = 0;
  const at = pos();
  for (const personId of liars) {
    // Not everybody with a fake ID uses it: ask people until one lies to the officer's face.
    if (found.some((f) => f.startsWith('alert:'))) break;
    if (s.npc.isActivePerson(personId)) continue;
    const aid = s.npc.spawnActor({ personId, x: at.x - 3, z: at.z - 3, yaw: 0, profile: 'suspectNervous', role: 'subject', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1 });
    const cid = open(aid);
    say(cid, 'requestId', 360);
    say(cid, 'askAddress', 360);
    early += s.contact.view(cid).inconsistencies.length;
    act(cid, 'runName', 360);
    for (const n of s.contact.view(cid).inconsistencies) found.push(`${n.severity}:${n.text}`);
    close(cid);
  }
  note('lieDetection', early === 0 && found.some((f) => f.startsWith('alert:')), `${early} before the lookup; after: ${found.join(' | ')}`);

  // --- DUI stop to booking ----------------------------------------------------------------------
  const g = s.city.graph;
  const lane = 58 * 16;
  let stopped = -1;
  for (let attempt = 0; attempt < 60 && stopped < 0; attempt++) {
    const car = s.vehicles[0];
    s.enterVehicle(car);
    const s0 = g.laneStart(lane) + 40;
    const p = g.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    s.teleport(p.x, p.z, p.yaw);
    step(30);
    const slot = s.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior: 0, desiredFactor: 0.3 });
    const vehicleId = s.traffic.view.vehicleId[slot];
    // A calm, hearing, English-speaking driver (consent can be refused; this keeps the flow short).
    const who = s.npc.occupantsOf(vehicleId)[0];
    const idn = who >= 0 ? s.people.identity(who) : null;
    if (!idn || idn.juvenile || idn.hearing !== 'normal' || idn.language.english !== 'fluent' || idn.dementia || idn.temperament !== 'calm' || idn.attitude < 0 || idn.wanted) {
      s.traffic.removeVehicle(vehicleId);
      continue;
    }
    if (!car.lightbar) s.toggleLightbar();
    const d = s.driverInput;
    d.handbrake = false;
    d.brake = 0;
    d.accelerate = 0.35;
    for (let i = 0; i < 900 && s.cad.trafficStop === null; i++) step(1);
    d.accelerate = 0;
    d.brake = 1;
    for (let i = 0; i < 300 && car.telemetry.speed > 0.2; i++) step(1);
    d.brake = 0;
    d.handbrake = true;
    step(30);
    d.handbrake = false;
    if (s.cad.trafficStop?.vehicleId === vehicleId && s.cad.trafficStop.outcome === 'active') {
      stopped = vehicleId;
    } else {
      s.traffic.stopFlee(vehicleId);
      s.traffic.removeVehicle(vehicleId);
      const pu = s.cad.playerUnit();
      if (pu?.callId != null) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: pu.callId, disposition: 'handled' }, 'key');
      step(120);
    }
  }
  const stopInfo = s.cad.trafficStop;
  const driver = stopped >= 0 ? s.npc.occupantsOf(stopped)[0] : -1;
  s.people.setIntoxication(driver, 0.12, 'none');
  s.interact(); // out of the car
  const st = s.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
  // The driver's window: left side a third back from the front; nudged until the game agrees the window is in reach.
  for (const [lx, lz] of [[-1.35, -0.77], [-1.2, -0.5], [-1.5, -1.1], [-1.1, -0.2], [-1.4, 0.2]]) {
    place(st.x + lx * Math.cos(st.yaw) + lz * Math.sin(st.yaw), st.z - lx * Math.sin(st.yaw) + lz * Math.cos(st.yaw));
    if (s.atStoppedDriver()) break;
  }
  step(10);
  const driverHint = s.interactHint();
  s.interact();
  step(10);
  const dc = s.contact.active;
  say(dc, 'greet', 120);
  say(dc, 'requestId');
  say(dc, 'askDrinking');
  // Consent can be refused: reassure and ask again (a refusal re-opens once rapport has grown).
  const hasPbt = () => s.contact.view(dc).facts.some((f) => f.text.includes('Breath test'));
  for (let k = 0; k < 6 && !hasPbt(); k++) {
    say(dc, 'consentPbt');
    act(dc, 'pbt', 200);
    if (!hasPbt()) say(dc, 'reassure', 200);
  }
  say(dc, 'cmdStepOut');
  let driverActor = s.npc.actorOfPerson(driver);
  if (driverActor === 0) driverActor = s.npc.stepOut(stopped, 0);
  for (let k = 0; k < 6 && s.contact.sfstView() === null; k++) {
    say(dc, 'consentSfst');
    act(dc, 'sfst', 30);
    if (s.contact.sfstView() === null) say(dc, 'reassure', 200);
  }
  const sfstTitle = s.contact.sfstView()?.title ?? '';
  for (let i = 0; i < 4000 && s.contact.sfstView() && !s.contact.sfstView().finished; i++) {
    const prompt = s.contact.sfstView().prompt;
    if (prompt) s.contact.request({ kind: 'sfstKey', key: prompt.includes('(A)') ? 'a' : prompt.includes('(D)') ? 'd' : prompt.includes('(W)') ? 'w' : 'space' });
    step(5);
  }
  const sfstSummary = s.contact.sfstView()?.summary ?? [];
  const dview = s.contact.view(dc);
  const odor = dview.facts.some((f) => f.text.includes('odor of alcohol'));
  const pbt = dview.facts.some((f) => f.text.includes('Breath test'));
  // The driver complies with the cuffs (the command roll is the module's business and is covered by its tests).
  s.npc.forceState(driverActor, 'kneel');
  step(90);
  act(dc, 'cuff', 120);
  const arrested = s.people.state(driver).custody === 'arrested' && s.cad.trafficStop?.outcome === 'arrest';
  act(dc, 'escort', 30);
  close(dc);
  const car = s.vehicles[0];
  const rd = rearDoor(car);
  walkTo(rd.x, rd.z, () => s.cageCarIndex() >= 0);
  s.interact();
  step(10);
  const caged = s.prisoner() === driver;
  s.teleport(s.city.spawn.x, s.city.spawn.z);
  step(10);
  const booked = app.mdt.saveDocument('booking', { personId: driver, charges: ['PC-220'], arrestLocation: 'smoke test', callId: stopInfo.callId }, true);
  step(10);
  note('duiOdorPbt', driverHint === 'driver' && odor && pbt, `hint ${driverHint}, odor ${odor}, pbt ${pbt}`);
  note('duiSfst', sfstTitle === 'Horizontal gaze nystagmus' && sfstSummary.length === 3, `${sfstTitle}: ${sfstSummary.join('; ')}`);
  note('duiArrestCageBooking', arrested && caged && booked.errors.length === 0 && s.people.state(driver).custody === 'jailed' && s.prisoner() === -1, `arrested ${arrested}, caged ${caged}, booking ${booked.errors.join(',') || 'ok'}, custody ${s.people.state(driver).custody}`);
  return out;
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
    // A unit may wait out a red signal at the start: give it up to a minute more before judging.
    for (let k = 0; k < 3 && unit && Math.hypot((s.cad.unit(unit)?.x ?? 0) - (from?.x ?? 0), (s.cad.unit(unit)?.z ?? 0) - (from?.z ?? 0)) <= 30; k++) step(60 * 20);
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
  await waitFor(page, () => window.patrol.presenter.dialogue.isOpen, null, 10000);
  const contact = await page.evaluate(() => {
    const app = window.patrol;
    return { open: app.presenter.dialogue.isOpen, text: document.querySelector('.dlg-panel')?.textContent ?? '', active: app.session.contact.active, menus: app.ui.menuStack.map((m) => m.id) };
  });
  check(contact.open && contact.text.includes('Driver') && contact.active >= 0, `E opens the dialogue with the stopped car's driver (${contact.menus.join(',')})`);
  // Ask for ID with the real keys: the dialogue panel answers, the dispatcher is told who the driver says they are.
  await dialogueSay(page, 'requestId');
  await waitFor(page, () => (window.patrol.session.cad.trafficStop?.driverId ?? -1) >= 0, null, 20000);
  const idAnswer = await page.evaluate(() => {
    const c = window.patrol.session.contact;
    const v = c.view(c.active);
    return { lines: v.transcript.map((l) => `${l.speaker}: ${l.text}`), statements: v.statements.map((n) => n.text), facts: v.facts.length, driverId: window.patrol.session.cad.trafficStop?.driverId ?? -1 };
  });
  console.log('driver dialogue:', JSON.stringify(idAnswer));
  check(idAnswer.lines.some((l) => l.startsWith('subject:')) && idAnswer.driverId >= 0, 'the driver answered the ID request and CAD has the identity');
  // Writing the citation opens the MDT form (contact:openForm), prefilled from the stop.
  await page.evaluate(() => {
    const c = window.patrol.session.contact;
    c.request({ kind: 'action', contactId: c.active, action: 'writeCitation' });
  });
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
  await waitFor(page, () => window.patrol.mdt?.isOpen === false, null, 10000);
  // Release the driver: the dialogue's release action sends them back to the car and ends the stop.
  await page.evaluate(() => {
    const c = window.patrol.session.contact;
    c.request({ kind: 'action', contactId: c.active, action: 'release' });
  });
  await waitFor(page, () => window.patrol.session.cad.trafficStop?.outcome === 'released', null, 30000);
  await page.evaluate(() => window.patrol.presenter.dialogue.close());
  await waitFor(page, () => window.patrol.ui.isMenuOpen() === false, null, 10000);
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
  check(saveLoad.slot === 5, `saved as v5 (${saveLoad.slot})`);
  check(same('calls') && same('docs') && same('units'), 'save/load v5 keeps the CAD (calls, units, documents)');
  check(same('records'), 'save/load v5 keeps the records (touched persons and vehicles, contacts, query log)');
  check(same('radio'), `save/load v5 keeps the radio (${saveLoad.after.radio})`);
  check(same('equipment') && same('kit'), 'save/load v5 keeps the patrol car equipment, trunk and the officer kit');

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

/**
 * Phase 3 checks on a fresh shift: pedestrians downtown, the call stream, a spawned call's scene with the scene
 * panel, the dialogue panel answering to the real keys, the weapon keys, the SFST panel, a foot and a vehicle
 * pursuit, the end-to-end flows, a v5 save/load and the Phase 3 console commands. Returns the perf numbers.
 */
async function phase3(page, hasRenderer) {
  await page.evaluate(() => {
    const app = window.patrol;
    app.ui.closeAll();
    app.newGame(42);
    app.perf.setVisible(false);
  });
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  await page.evaluate(async () => {
    await window.patrol.console.execute('time 12:00');
    await window.patrol.console.execute('weather clear');
  });

  // --- Pedestrians around the station and downtown ----------------------------------------------
  const station = await page.evaluate(async () => {
    const app = window.patrol;
    await new Promise((r) => setTimeout(r, 2500));
    return { peds: app.session.npc.stats.peds, drawn: app.presenter.stats.figures };
  });
  check(station.peds > 0, `pedestrians walk around the station (${station.peds} active, ${station.drawn} drawn)`);
  const downtown = await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const hit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
    let found = null;
    for (let r = 0; r < 1600 && !found; r += 80) {
      for (let a = 0; a < 16 && !found; a++) {
        const x = Math.cos((a / 16) * Math.PI * 2) * r;
        const z = Math.sin((a / 16) * Math.PI * 2) * r;
        if (s.city.districtAt(x, z) !== 0) continue;
        const h = s.city.graph.nearestEdge(x, z, 25, hit);
        if (h) found = { x: h.x, z: h.z };
      }
    }
    if (!found) return null;
    app.teleport(found.x, found.z);
    step(900);
    await new Promise((r) => setTimeout(r, 1500));
    return { ...found, peds: s.npc.stats.peds, view: s.npc.view.count, drawn: app.presenter.stats.figures, drawCalls: app.presenter.stats.drawCalls };
  }, stepSim.toString());
  console.log('downtown:', JSON.stringify(downtown));
  check(downtown !== null && downtown.peds >= 8, `pedestrians fill the downtown sidewalks (${downtown?.peds ?? 0} active at ${downtown ? `${Math.round(downtown.x)}, ${Math.round(downtown.z)}` : '-'})`);
  if (hasRenderer && downtown) check(downtown.drawn > 0 && downtown.drawCalls <= 19, `the people renderer draws them (${downtown.drawn} figures, ${downtown.drawCalls} draw calls)`);

  // --- The call stream: varied types from the catalog, some taken by AI units ---------------------
  const stream = await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const t0 = performance.now();
    for (let m = 0; m < 40; m++) step(60 * 30);
    const calls = s.cad.calls().filter((c) => !c.selfInitiated);
    const types = [...new Set(calls.map((c) => c.typeId))];
    await app.console.execute('catalog stats');
    const lines = app.console.lines.slice(-3).map((l) => l.text);
    return {
      ms: Math.round(performance.now() - t0),
      generated: s.dispatcher.stats.generated,
      types,
      aiTaken: calls.filter((c) => c.units.some((u) => u !== s.dispatcher.playerCallsign)).length,
      scenarios: s.scene.stats.scenarios,
      stats: lines.join(' | '),
    };
  }, stepSim.toString());
  console.log('call stream:', JSON.stringify(stream));
  const catalogSize = Number(/(\d+)\s*(?:call )?types/.exec(stream.stats)?.[1] ?? '0');
  check(stream.generated >= 5 && stream.types.length >= 4, `the CAD received a varied stream: ${stream.generated} calls of ${stream.types.length} types in 20 sim minutes (${stream.types.join(', ')})`);
  check(stream.aiTaken > 0, `AI units took ${stream.aiTaken} of them`);
  check(stream.scenarios > 0, `open calls carry scenarios (${stream.scenarios})`);
  check(catalogSize >= 150 || stream.stats.includes('163'), `the catalog holds 150+ call types (${stream.stats})`);

  // --- A spawned call: accept, walk up, scene panel (Y), knock, people appear ----------------------
  const setup = await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const at = s.playerPosition({ x: 0, z: 0 });
    let id = 0;
    for (let k = 0; k < 40 && id === 0; k++) {
      const cand = s.scene.spawnCall('domesticDisturbance', s.now(), { x: at.x + 30, z: at.z - 30 }, []);
      const rt = s.scene.runtime(cand);
      const roles = rt.scenario.participants.map((p) => p.role);
      if (roles.includes('victim') && roles.includes('suspect') && rt.scenario.variants.length === 0) id = cand;
      else s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: cand, disposition: 'unfounded' }, 'key');
      step(2);
    }
    const rt = s.scene.runtime(id);
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
    step(5);
    app.teleport(rt.scenario.anchor.x - 15, rt.scenario.anchor.z);
    step(120);
    return { id, materialized: rt.materialized, arrived: rt.flags.has('arrived'), roles: rt.scenario.participants.map((p) => p.role), branch: rt.scenario.branch };
  }, stepSim.toString());
  console.log('spawned call:', JSON.stringify(setup));
  check(setup.materialized && setup.arrived, `a spawned domestic call materializes its actors on arrival (${setup.roles.join(', ')}; branch ${setup.branch})`);
  await press(page, 'KeyY');
  await waitFor(page, () => window.patrol.panels.kind === 'scene', null, 10000);
  const panel = await page.evaluate(() => ({ kind: window.patrol.panels.kind, text: document.querySelector('.panel-action')?.textContent ?? '' }));
  check(panel.kind === 'scene' && panel.text.includes('Knock and announce') && panel.text.includes('Clear call'), 'Y opens the scene panel with the call actions');
  await press(page, 'Digit1'); // Knock and announce
  await press(page, 'Escape');
  await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    step(900);
  }, stepSim.toString());
  const knocked = await page.evaluate((id) => ({ flags: [...window.patrol.session.scene.runtime(id).flags] }), setup.id);
  check(knocked.flags.includes('knocked'), `the scene panel's first action knocked (${knocked.flags.filter((f) => /knocked|revealed/.test(f)).join(', ')})`);

  // --- Weapon keys -------------------------------------------------------------------------------
  await press(page, 'KeyC');
  const w1 = await page.evaluate(() => window.patrol.session.scene.officerWeapon);
  await press(page, 'KeyC');
  const w2 = await page.evaluate(() => window.patrol.session.scene.officerWeapon);
  await waitFor(page, () => /TASER|SIDEARM/.test(document.querySelector('#hud')?.textContent ?? ''), null, 3000);
  const chip = await page.evaluate(() => /TASER|SIDEARM/.exec(document.querySelector('#hud')?.textContent ?? '')?.[0] ?? '');
  await press(page, 'KeyC');
  const w3 = await page.evaluate(() => window.patrol.session.scene.officerWeapon);
  check(w1 === 'sidearm' && w2 === 'taser' && w3 === 'none' && chip === 'TASER', `C cycles holstered -> sidearm -> TASER -> holstered (${w1}, ${w2}, ${w3}; chip ${chip})`);

  // --- Dialogue panel with the real keys -----------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const rt = s.scene.runtime(app.session.cad.playerUnit().callId);
    const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
    const id = rt.actorIds.find((a) => a > 0 && s.npc.actor(a, scratch)?.role === 'victim');
    const a = s.npc.actor(id, scratch);
    // 1.5 m west of the victim, facing east (yaw -pi/2 looks along +x).
    s.physics.getBody(s.player).setTranslation({ x: a.x - 1.5, y: 0.9, z: a.z }, true);
    s.controller.yaw = -Math.PI / 2;
    s.controller.pitch = 0.1;
    return { x: a.x, z: a.z };
  });
  await sleep(600);
  const talkHint = await page.evaluate(() => ({ hint: window.patrol.session.interactHint(), hud: document.querySelector('#hud')?.textContent ?? '' }));
  check(talkHint.hint === 'talk' && talkHint.hud.includes('Talk'), `the prompt offers to talk to the person in front (${talkHint.hint ?? 'none'})`);
  await press(page, 'KeyE');
  await waitFor(page, () => window.patrol.presenter.dialogue.isOpen, null, 10000);
  await dialogueSay(page, 'requestId');
  await dialogueSay(page, 'askAccount');
  const dlg = await page.evaluate(() => {
    const app = window.patrol;
    const c = app.session.contact;
    const v = c.view(c.active);
    return {
      open: app.presenter.dialogue.isOpen,
      text: document.querySelector('.dlg-panel')?.textContent ?? '',
      lines: v.transcript.map((l) => `${l.speaker}: ${l.text}`),
      statements: v.statements.length,
      subtitle: app.presenter.lastSubtitle,
      people: app.session.people.touchedCount,
    };
  });
  console.log('dialogue:', JSON.stringify({ lines: dlg.lines, statements: dlg.statements, subtitle: dlg.subtitle }));
  check(dlg.open && dlg.lines.filter((l) => l.startsWith('subject:')).length >= 2 && dlg.statements >= 1, `the dialogue panel answers (${dlg.lines.length} lines, ${dlg.statements} statements)`);
  check(dlg.subtitle !== null && dlg.text.includes('Talk'), 'subtitles follow the spoken lines');
  await sleep(800);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'phase3-dialogue.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase3-dialogue.png')}`);
  // Escape steps back from the option list first, then closes the panel; it never opens the pause menu.
  for (let i = 0; i < 3 && (await page.evaluate(() => window.patrol.presenter.dialogue.isOpen)); i++) await press(page, 'Escape');
  await waitFor(page, () => !window.patrol.presenter.dialogue.isOpen && !window.patrol.ui.isMenuOpen(), null, 10000);
  check(await page.evaluate(() => !window.patrol.presenter.dialogue.isOpen && !window.patrol.ui.isMenuOpen()), 'Escape closes the dialogue panel without opening the pause menu');

  // --- The scene on screen -----------------------------------------------------------------------
  // Stand on the street side, a few metres from the people, looking at them.
  await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const rt = s.scene.runtime(s.cad.playerUnit().callId);
    const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
    const a = s.npc.actor(rt.actorIds.find((id) => id > 0), scratch);
    const hit = s.city.graph.nearestEdge(a.x, a.z, 60, { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
    let dx = hit ? hit.x - a.x : 0;
    let dz = hit ? hit.z - a.z : 4;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    s.physics.getBody(s.player).setTranslation({ x: a.x + dx * 5, y: 0.9, z: a.z + dz * 5 }, true);
    s.controller.yaw = Math.atan2(dx, dz);
    s.controller.pitch = 0.2;
    app.perf.setVisible(false);
  });
  await sleep(2500);
  const scene = await page.evaluate(() => ({ figures: window.patrol.presenter.stats.figures, drawCalls: window.patrol.presenter.stats.drawCalls, props: window.patrol.presenter.stats.props, hud: document.querySelector('#hud')?.textContent ?? '' }));
  if (hasRenderer) check(scene.figures >= 3, `the scene's people are drawn (${scene.figures} figures incl. the officer, ${scene.drawCalls} draw calls)`);
  check(scene.hud.includes('domestic') || scene.hud.includes('Domestic'), 'the call scene shows on the HUD');
  await page.screenshot({ path: path.join(SHOTS, 'phase3.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase3.png')}`);

  // --- Foot pursuit: a forced flee, the pursuit line, a tackle ---------------------------------------
  const flee = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const rt = s.scene.runtime(s.cad.playerUnit().callId);
    const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
    const id = rt.actorIds.find((a) => a > 0 && s.npc.actor(a, scratch)?.role === 'suspect');
    const a = s.npc.actor(id, scratch);
    s.physics.getBody(s.player).setTranslation({ x: a.x - 3, y: 0.9, z: a.z }, true);
    s.npc.forceState(id, 'flee');
    // Hold the real loop (the runner would be gone by the time the HUD line is checked): steps run by hand.
    app.setUserPaused(true);
    const fixed = app.loop.hooks.fixedUpdate;
    for (let i = 0; i < 30; i++) fixed(1 / 60, 0);
    return { id, callId: rt.scenario.callId };
  });
  await waitFor(page, () => /FOOT PURSUIT/.test(document.querySelector('#hud')?.textContent ?? ''), null, 8000);
  const pursuitLine = await page.evaluate(() => /FOOT PURSUIT[^\n]*/.exec(document.querySelector('#hud')?.textContent ?? '')?.[0] ?? '');
  check(pursuitLine.startsWith('FOOT PURSUIT'), `the HUD shows the foot pursuit (${pursuitLine})`);
  const tackle = await page.evaluate((arg) => {
    const app = window.patrol;
    const s = app.session;
    const step = new Function(`return ${arg.stepSrc}`)();
    const rt = s.scene.runtime(arg.callId);
    const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
    // The real loop ran while the HUD line appeared: start the chase close behind the runner again.
    const r0 = s.npc.actor(arg.id, scratch);
    s.physics.getBody(s.player).setTranslation({ x: r0.x - 2.5, y: 0.9, z: r0.z }, true);
    step(1);
    for (let i = 0; i < 1800 && !rt.flags.has('caught:suspect'); i++) {
      const a = s.npc.actor(arg.id, scratch);
      const p = s.playerPosition({ x: 0, z: 0 });
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      const k = Math.min(1, 0.09 / Math.max(d, 1e-6));
      s.physics.getBody(s.player).setTranslation({ x: p.x + (a.x - p.x) * k, y: 0.9, z: p.z + (a.z - p.z) * k }, true);
      s.controller.yaw = Math.atan2(-(a.x - p.x), -(a.z - p.z));
      if (d < 2) s.scene.request({ kind: 'tackle' });
      step(1);
    }
    const end = s.npc.actor(arg.id, scratch);
    app.setUserPaused(false);
    return { caught: rt.flags.has('caught:suspect'), force: rt.flags.has('forceUsed'), state: end ? end.state : -1, flags: [...rt.flags].join(','), weapon: s.scene.officerWeapon, onFoot: !s.driving };
  }, { id: flee.id, callId: flee.callId, stepSrc: stepSim.toString() });
  check(tackle.caught && tackle.force, `the runner was chased down and tackled (${tackle.caught ? 'caught' : `not caught: state ${tackle.state}, weapon ${tackle.weapon}, on foot ${tackle.onFoot}, flags ${tackle.flags}`})`);

  // --- Vehicle pursuit: a forced flee of a stopped car --------------------------------------------------
  const vflee = await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    s.scene.request({ kind: 'clear', callId: s.cad.playerUnit().callId, disposition: null });
    step(60);
    const car = s.trafficCars(1)[0];
    app.teleport(s.playerPosition({ x: 0, z: 0 }).x, s.playerPosition({ x: 0, z: 0 }).z);
    step(120);
    const near = s.trafficCars(1)[0];
    const ok = s.traffic.flee(near.vehicleId);
    step(120);
    return { ok, fleeing: s.traffic.fleeingCount, id: near.vehicleId, hadCar: car !== undefined };
  }, stepSim.toString());
  check(vflee.ok && vflee.fleeing > 0, `a car flees (${vflee.fleeing} fleeing)`);
  await page.evaluate(() => window.patrol.session.traffic.stopFlee(window.patrol.session.trafficCars(1)[0]?.vehicleId ?? -1));

  // --- Scripted end-to-end flows ---------------------------------------------------------------------
  const flows = await page.evaluate(phase3Flows, stepSim.toString());
  console.log('flows:', JSON.stringify(flows));
  const describeFlow = {
    domesticVictim: 'domestic: the victim gave ID and an account (statements and facts recorded)',
    domesticCage: 'domestic: the suspect was cuffed, escorted to the patrol car and caged',
    domesticOutcome: 'domestic: the call was graded when cleared',
    shoplifting: 'shoplifting: the store guard and the suspect were contacted and the suspect cuffed',
    shopliftingOutcome: 'shoplifting: resolved as an arrest',
    lieDetection: 'lie detection: fake IDs show nothing before the lookup and alerts after it',
    falseCall: 'false call: nothing but the caller on scene, graded unfounded / gone',
    duplicateCall: 'duplicate call: linked in CAD and closed as a duplicate',
    duiOdorPbt: 'DUI: odor of alcohol and a PBT reading',
    duiSfst: 'DUI: the field sobriety tests ran',
    duiArrestCageBooking: 'DUI: arrest, cage and booking put the person in jail',
  };
  for (const [key, text] of Object.entries(describeFlow)) {
    const f = flows[key];
    check(Boolean(f?.ok), `${text} (${f?.detail ?? 'missing'})`);
  }

  // --- SFST panel with the real keys (a field contact) ------------------------------------------------
  await page.evaluate(async (stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    s.teleport(s.city.spawn.x + 20, s.city.spawn.z);
    step(60);
    const at = s.playerPosition({ x: 0, z: 0 });
    let pid = 3000;
    while (s.npc.isActivePerson(pid) || s.people.identity(pid).juvenile || s.people.identity(pid).hearing !== 'normal' || s.people.identity(pid).dementia || s.people.identity(pid).language.english !== 'fluent') pid++;
    s.people.setIntoxication(pid, 0.1, 'none');
    const aid = s.npc.spawnActor({ personId: pid, x: at.x - 2, z: at.z, yaw: 1.57, profile: 'subjectIntoxicated', role: 'subject', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1 });
    s.controller.yaw = Math.PI / 2;
    step(5);
    s.contact.request({ kind: 'open', target: { kind: 'actor', actorId: aid } });
    step(5);
    const cid = s.contact.active;
    // A refusal is answered with some reassurance, then the question is asked again.
    for (let k = 0; k < 6 && s.contact.sfstView() === null; k++) {
      s.contact.request({ kind: 'say', contactId: cid, utteranceId: 'consentSfst', tone: 'polite' });
      step(400);
      s.contact.request({ kind: 'action', contactId: cid, action: 'sfst' });
      step(2);
      if (s.contact.sfstView() === null) {
        s.contact.request({ kind: 'say', contactId: cid, utteranceId: 'reassure', tone: 'polite' });
        step(300);
      }
    }
    // The prompts have time windows: hold the real loop while the keys are pressed (steps run between key presses).
    app.setUserPaused(true);
    return { cid, pid };
  }, stepSim.toString());
  // The SFST panel opens above the dialogue panel (which stays open below it).
  const sfstShown = await waitFor(page, () => window.patrol.presenter.sfst.isOpen && window.patrol.ui.top === window.patrol.presenter.sfst, null, 10000);
  check(Boolean(sfstShown), 'the SFST panel opens for the field sobriety tests');
  // Follow the prompts with the real keys until the tests finish (sim time is fast-forwarded between key presses).
  let sfstEnd = { view: null, open: false };
  for (let i = 0; i < 1500; i++) {
    const v = await page.evaluate((stepSrc) => {
      const step = new Function(`return ${stepSrc}`)();
      step(8);
      const c = window.patrol.session.contact.sfstView();
      return c ? { prompt: c.prompt, finished: c.finished, summary: c.summary } : null;
    }, stepSim.toString());
    if (v === null) break;
    if (v.finished) {
      sfstEnd = { view: v, open: await page.evaluate(() => window.patrol.presenter.sfst.isOpen) };
      break;
    }
    if (v.prompt) {
      const key = v.prompt.includes('(A)') ? 'KeyA' : v.prompt.includes('(D)') ? 'KeyD' : v.prompt.includes('(W)') ? 'KeyW' : 'Space';
      await page.keyboard.press(key);
    }
  }
  await page.evaluate(() => window.patrol.setUserPaused(false));
  check(
    sfstEnd.view !== null && sfstEnd.view.finished && sfstEnd.view.summary.length === 3 && !sfstEnd.view.summary.some((l) => l.includes('not administered')),
    `the key presses administered the tests (${sfstEnd.view?.summary.join('; ') ?? 'none'})`,
  );
  await press(page, 'Escape');
  await waitFor(page, () => !window.patrol.presenter.sfst.isOpen, null, 10000);
  await page.evaluate(() => {
    const c = window.patrol.session.contact;
    c.request({ kind: 'close', contactId: c.active });
  });
  await sleep(300);
  await page.evaluate(() => window.patrol.ui.closeAll());

  // --- Save / load v5 --------------------------------------------------------------------------------
  const v5 = await page.evaluate(async () => {
    const app = window.patrol;
    const people = () => app.session.people.serialize().persons.map((p) => p.id).sort((a, b) => a - b);
    const before = {
      people: people(),
      scenarios: app.session.scene.serialize().scenarios.map((x) => x.scenario.callId).sort((a, b) => a - b),
      closed: app.session.scene.serialize().closed.map((o) => o.callId),
      contacts: app.session.contact.serialize().contacts.length,
      npc: app.session.npc.serialize() !== null,
    };
    await app.saveGame('smoke-phase3');
    const list = await app.saves.list();
    await app.loadGame('smoke-phase3');
    const after = {
      people: people(),
      scenarios: app.session.scene.serialize().scenarios.map((x) => x.scenario.callId).sort((a, b) => a - b),
      closed: app.session.scene.serialize().closed.map((o) => o.callId),
      contacts: app.session.contact.serialize().contacts.length,
      npc: app.session.npc.serialize() !== null,
      peds: app.session.npc.stats.peds,
    };
    return { before, after, version: list.find((x) => x.slot === 'smoke-phase3')?.version ?? -1 };
  });
  console.log('phase 3 save/load:', JSON.stringify({ version: v5.version, people: v5.after.people.length, scenarios: v5.after.scenarios, closed: v5.after.closed.length, contacts: v5.after.contacts, peds: v5.after.peds }));
  check(v5.version === 5, `saved as v5 (${v5.version})`);
  check(v5.before.people.length > 0 && v5.before.people.every((id) => v5.after.people.includes(id)), `save/load v5 keeps the touched people (${v5.before.people.length} -> ${v5.after.people.length})`);
  check(JSON.stringify(v5.before.scenarios) === JSON.stringify(v5.after.scenarios) && v5.before.closed.length === v5.after.closed.length, `save/load v5 keeps the open scenarios (${v5.after.scenarios.length}) and the graded outcomes (${v5.after.closed.length})`);
  check(v5.before.contacts === v5.after.contacts && v5.after.npc, 'save/load v5 keeps the open contacts and the pedestrians/actors');

  // --- Console commands ------------------------------------------------------------------------------
  const cmds = await page.evaluate(async () => {
    const c = window.patrol.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    for (const line of ['call types shoplift', 'call spawn shopliftingDetained here', 'call list', 'npc spawn volatile', 'npc info', 'dialogue debug', 'population density 0.5', 'population stats', 'population density 1', 'peds stats', 'actors', 'who 17', 'scene info', 'scene outcomes', 'weapon']) {
      out.push(...(await run(line)));
    }
    return out;
  });
  console.log('phase 3 console commands:\n  ' + cmds.join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 3 console commands ran without errors');

  const perf = await page.evaluate(perfSnapshot);
  const frame = await page.evaluate(frameBreakdown, 8);
  const extras = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    return { npcStepMs: Number(s.npc.stats.stepMs.toFixed(3)), peds: s.npc.stats.peds, actors: s.npc.stats.actors, occupants: s.npc.stats.occupants, people: app.presenter.stats, scene: s.scene.stats };
  });
  return { perf, frame, extras };
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

    // SMOKE_ONLY=3 runs just the Phase 3 checks (a quick loop while working on them); the full run is the default.
    if (process.env.SMOKE_ONLY === '3') {
      const only = await phase3(page, hasRenderer);
      console.log('perf phase 3:', JSON.stringify(only.perf));
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      return;
    }

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
    check(saveLoad.slots.includes('smoke v5'), "slot 'smoke' listed as a v5 save");
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
    const phase3Perf = await phase3(page, hasRenderer);

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
    console.log(describe('Phase 3 scene (people, dialogue closed):', phase3Perf.frame));
    console.log('perf phase 3:', JSON.stringify(phase3Perf.perf));
    console.log('phase 3 sim costs:', JSON.stringify(phase3Perf.extras));
    check(phase3Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls with people within the cap (${phase3Perf.perf.drawCalls})`);
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
