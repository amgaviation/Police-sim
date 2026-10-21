#!/usr/bin/env node
/**
 * Browser smoke test (Phases 0-7).
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
 * commands and a save/load keeping CAD, records, radio and equipment. Phase 3: pedestrians downtown,
 * the call stream from the 150+ type catalog, a spawned call's scene (scene panel, knock), the dialogue panel
 * answering to the real keys, weapon keys, an SFST panel run with the keys, foot and vehicle pursuits, and the
 * end-to-end flows through window.patrol (domestic with cage, shoplifting, lie detection, DUI to booking, a false
 * and a duplicate call), a save/load and the Phase 3 console commands. Phase 4: the new shift in the station's
 * locker room (HUD objective, locker, roll call, armory, the garage door), entering a house with the real keys, the
 * interior meshes and lights, flashlight / crouch / lean, a door kick, a domestic call bound to the house with its
 * people inside, evidence markers, the camera (thumbnail), the case file, the deposit at the station's evidence room,
 * a prisoner in a holding cell and the interview room, a v6 save/load and the Phase 4 console commands. Phase 5: the force
 * tool keys (C, mouse 0) and HUD chip, a scripted stop (bodycam, speeding, odor, consent PBT) with a TASER application and
 * its force verdict, arrest, rights, booking and the case in court, `law explain` with citations, the MDT report statements
 * checklist and grade, the Career and Community tabs, the courtroom answered with the real keys, an unlawful frisk and an
 * excessive TASER that open an IA case reviewed with bodycam snapshots from the live canvas, a v7 save/load and the Phase 5
 * console commands. Phase 6: the radio menu's paged Request list (T, 4, 2 and 5), an AI backup officer getting out to cover
 * (HUD line, radio callout, the Backup panel on `,`), a pursuit with the tactics panel (`;`), the supervisor's termination
 * order, the air unit and its FLIR camera (`/`), a mass-casualty incident with the command post, triage, the command
 * panel (`.`) and the MDT Command tab, a barricade with the negotiator and the SWAT team, a v8 save/load and the Phase 6
 * console commands. Phase 7: Create officer (they/them) and New game, the locker's Uniform & gear, the armory's Sign out my
 * loadout, the fleet panel (') checking out S-201 and customizing its livery (a text decal, a polygon shape, the siren) with an
 * export / import of the JSON, the motorcycle ridden, the helicopter climbed with Space, the camera drone (=), a crash with its
 * damage report, the station service, the inspection and End shift charging career points, a v9 save/load and the Phase 7
 * console commands.
 * Writes docs/screenshots/phase1.png, phase1-night.png, phase2.png (cockpit with the
 * in-car MDT), phase2-mdt.png (the MDT overlay), phase3.png (a call scene with people),
 * phase3-dialogue.png (the dialogue panel), phase4.png (an interior with the flashlight and markers),
 * phase4-station.png (the roll-call briefing), phase4-case.png (the case file), phase5-mdt.png (the Career tab),
 * phase5-court.png (the courtroom), phase5-review.png (the evidence review), phase6-backup.png (the Backup panel with a
 * backup officer), phase6-flir.png (the air unit camera), phase6-command.png (the command panel at a mass-casualty scene), phase7-character.png (the character creator),
 * phase7-livery.png (the livery editor on S-201) and phase7-heli.png (the patrol helicopter in the air).
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
  // A flow can leave the officer in the patrol car (a failed cage step enters it): get out before moving the body.
  const onFoot = () => {
    for (let i = 0; i < 3 && s.driving; i++) {
      s.interact();
      step(10);
    }
    return Boolean(s.physics.getBody(s.player));
  };
  const place = (x, z) => {
    if (!onFoot()) return;
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
      if (!onFoot()) break;
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
  let sc = meet(suspect.id);
  s.npc.forceState(suspect.id, 'kneel');
  step(90);
  act(sc, 'cuff', 120);
  // The suspect can wander off or the contact close while the sim is fast-forwarded: face them again (up to twice).
  for (let k = 0; k < 2 && !actor(suspect.id).cuffed; k++) {
    sc = meet(suspect.id);
    s.npc.forceState(suspect.id, 'kneel');
    step(90);
    act(sc, 'cuff', 120);
  }
  const cuffed = actor(suspect.id).cuffed;
  const cuffWhy = () => {
    const a = actor(suspect.id);
    const p = pos();
    const lines = (s.contact.view(sc)?.transcript ?? []).slice(-3).map((l) => String(l.text ?? '')).join(' | ');
    return `state ${a.state}, ${Math.hypot(a.x - p.x, a.z - p.z).toFixed(1)} m, contact ${sc}, last: ${lines}`;
  };
  const cuffDiag = cuffed ? '' : cuffWhy();
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
  note('domesticCage', cuffed && hint === 'cage' && cageResult === 'cage' && s.prisoner() === suspect.personId, `cuffed ${cuffed}, hint ${hint}, interact ${cageResult}, prisoner ${s.prisoner()}${cuffDiag ? ` [${cuffDiag}]` : ''}`);
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
  let tc = meet(thief.id);
  s.npc.forceState(thief.id, 'kneel');
  step(90);
  act(tc, 'cuff', 120);
  for (let k = 0; k < 2 && !actor(thief.id).cuffed; k++) {
    tc = meet(thief.id);
    s.npc.forceState(thief.id, 'kneel');
    step(90);
    act(tc, 'cuff', 120);
  }
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
    // A subject who bolts at the first sight of the officer closes the dialogue: try the next one.
    if (cid < 0 || !s.contact.view(cid)) continue;
    say(cid, 'requestId', 360);
    say(cid, 'askAddress', 360);
    early += s.contact.view(cid)?.inconsistencies.length ?? 0;
    act(cid, 'runName', 360);
    for (const n of s.contact.view(cid)?.inconsistencies ?? []) found.push(`${n.severity}:${n.text}`);
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
  check(roster.units.length === 30 && roster.units[0]?.startsWith('12:'), `CAD roster: player unit 12, six AI units and the 23 Phase 6 resource units (${roster.units.length})`);
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
  // The stop depends on the ambient traffic around the arterial at that moment (and so on timing): up to three attempts.
  const stop = await page.evaluate((stepSrc) => {
    const step = new Function(`return ${stepSrc}`)();
    const app = window.patrol;
    const s = app.session;
    const car = s.drivenVehicle;
    const g = s.city.graph;
    const lane = 58 * 16; // laneRef(58, 0, 0): a straight arterial curb lane
    const d = s.driverInput;
    let result = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      car.lightbar = false;
      const s0 = g.laneStart(lane) + 40;
      const p = g.lanePoint(lane, s0, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
      app.teleport(p.x, p.z, p.yaw);
      step(30);
      const slot = s.traffic.spawnAt(lane, s0 + 14, { speed: 4, behavior: 0, desiredFactor: 0.3 });
      const vehicleId = s.traffic.view.vehicleId[slot];
      car.lightbar = true;
      // Creep after it (stop detection needs the patrol car moving), then brake once it is the stop target.
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
      const eq = s.drivenEquipment;
      const view = s.traffic.view;
      let nearest = Infinity;
      const me = s.playerPosition({ x: 0, z: 0 });
      for (let i = 0; i < view.count; i++) nearest = Math.min(nearest, Math.hypot((view.x[i] ?? 0) - me.x, (view.z[i] ?? 0) - me.z));
      const pu = s.cad.playerUnit();
      const pcall = pu && pu.callId !== null ? s.cad.call(pu.callId) : null;
      const diag = { pcall: pcall ? `${pcall.number}:${pcall.typeId}:${pcall.status}:${pcall.selfInitiated}` : null, status: s.cad.unit(s.dispatcher.playerCallsign)?.status, inPolice: s.playerUnit.inPoliceVehicle, siren: eq?.sirenOn, lightbar: car.lightbar, speed: Number(car.telemetry.speed.toFixed(1)), slotState: view.state[slot], nearest: Number(nearest.toFixed(1)), pulling: s.traffic.stopVehicleId };
      result = { vehicleId, active: st?.outcome === 'active', stopVehicle: st?.vehicleId ?? -1, plate: st?.plate ?? '', seconds: Number((n / 60).toFixed(2)), callId: st?.callId ?? -1, attempt, diag };
      if (result.active) break;
      d.handbrake = true;
      step(60);
      d.handbrake = false;
      s.traffic.clear(true);
    }
    return result;
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
  check(saveLoad.slot === 9, `saved as v9 (${saveLoad.slot})`);
  check(same('calls') && same('docs') && same('units'), 'save/load v6 keeps the CAD (calls, units, documents)');
  check(same('records'), 'save/load v6 keeps the records (touched persons and vehicles, contacts, query log)');
  check(same('radio'), `save/load v6 keeps the radio (${saveLoad.after.radio})`);
  check(same('equipment') && same('kit'), 'save/load v6 keeps the patrol car equipment, trunk and the officer kit');

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
 * A new shift (it starts in the station's locker room) taken through the shift flow at once: duty pistol and taser
 * signed out, out of the building at the station door, on patrol: the state the Phase 1-3 checks were written for.
 */
async function startPatrolShift(page) {
  await page.evaluate(() => {
    const app = window.patrol;
    app.ui.closeAll();
    app.newGame(42);
    app.perf.setVisible(false);
  });
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  await page.evaluate(async () => {
    const s = window.patrol.session;
    s.station.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    s.station.request({ kind: 'armory', item: 'taser', action: 'out' });
    s.station.request({ kind: 'complete', step: 'garage' });
    await new Promise((r) => setTimeout(r, 300));
    s.teleport(s.city.spawn.x, s.city.spawn.z, s.city.spawn.yaw);
    await new Promise((r) => setTimeout(r, 300));
  });
}

/**
 * Phase 3 checks on a fresh shift: pedestrians downtown, the call stream, a spawned call's scene with the scene
 * panel, the dialogue panel answering to the real keys, the weapon keys, the SFST panel, a foot and a vehicle
 * pursuit, the end-to-end flows, a save/load and the Phase 3 console commands. Returns the perf numbers.
 */
async function phase3(page, hasRenderer) {
  await startPatrolShift(page);
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
  const catalogSize = Number(/(\d+)\s*Phase 3 call types/.exec(stream.stats)?.[1] ?? /(\d+)\s*(?:call )?types/.exec(stream.stats)?.[1] ?? '0');
  check(stream.generated >= 5 && stream.types.length >= 4, `the CAD received a varied stream: ${stream.generated} calls of ${stream.types.length} types in 20 sim minutes (${stream.types.join(', ')})`);
  check(stream.aiTaken > 0, `AI units took ${stream.aiTaken} of them`);
  check(stream.scenarios > 0, `open calls carry scenarios (${stream.scenarios})`);
  check(catalogSize >= 150, `the catalog holds 150+ call types (${stream.stats})`);

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

  // --- Force tool keys (Phase 5: C cycles the force tools; the migrated shift has the pistol and the TASER signed out) --------------
  const tool = () => page.evaluate(() => window.patrol.session.force.tool);
  await press(page, 'KeyC');
  const w1 = await tool();
  await press(page, 'KeyC');
  const w2 = await tool();
  await waitFor(page, () => /TASER/.test(document.querySelector('#hud')?.textContent ?? ''), null, 3000);
  const chip = await page.evaluate(() => /TASER \d+\/\d+/.exec(document.querySelector('#hud')?.textContent ?? '')?.[0] ?? '');
  await press(page, 'KeyC');
  const w3 = await tool();
  await press(page, 'KeyC');
  const w4 = await tool();
  check(w1 === 'hands' && w2 === 'taser' && w3 === 'firearm' && w4 === 'none' && /^TASER \d+\/\d+$/.test(chip), `C cycles holstered -> hands -> TASER -> sidearm -> holstered (${w1}, ${w2}, ${w3}, ${w4}; chip ${chip})`);

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
  check(dlg.open && dlg.lines.filter((l) => l.startsWith('subject:')).length >= 2, `the dialogue panel answers (${dlg.lines.length} lines, ${dlg.statements} statements)`);
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

  // --- Save / load (v6) --------------------------------------------------------------------------------
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
  check(v5.version === 9, `saved as v9 (${v5.version})`);
  check(v5.before.people.length > 0 && v5.before.people.every((id) => v5.after.people.includes(id)), `save/load v6 keeps the touched people (${v5.before.people.length} -> ${v5.after.people.length})`);
  check(JSON.stringify(v5.before.scenarios) === JSON.stringify(v5.after.scenarios) && v5.before.closed.length === v5.after.closed.length, `save/load v6 keeps the open scenarios (${v5.after.scenarios.length}) and the graded outcomes (${v5.after.closed.length})`);
  check(v5.before.contacts === v5.after.contacts && v5.after.npc, 'save/load v6 keeps the open contacts and the pedestrians/actors');

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

/** Moves the on-foot officer to station point `kind` (inside the station), facing it. */
function placeAtStationPoint(kind) {
  const s = window.patrol.session;
  const p = s.stationPoint(kind);
  if (!p) return null;
  s.physics.getBody(s.player).setTranslation({ x: p.x, y: -40 + 0.9, z: p.z }, true);
  s.controller.yaw = p.yaw;
  return { x: p.x, z: p.z };
}

/** Snapshot of the shift flow, panels and menus for the checks. */
function shiftState() {
  const app = window.patrol;
  const s = app.session;
  return {
    building: s.officerBuilding,
    flow: s.station.flow.step,
    hint: s.interactHint(),
    panel: app.panels.kind,
    menus: app.ui.menuStack.map((m) => m.id),
    status: s.cad.unit(s.dispatcher.playerCallsign)?.status ?? '',
    out: s.station.armory.out(),
  };
}

/**
 * Phase 4 checks on a fresh shift: the shift in the station (locker, roll call, armory, garage door) with the real
 * keys, a house entered with E, the interior meshes and lights, flashlight / crouch / lean, a door kick, a domestic call
 * bound to the house, evidence markers, the camera and its thumbnail, the case file, the deposit at the evidence room,
 * a holding cell and the interview room, a v6 save/load and the console commands. Returns the perf numbers.
 */
async function phase4(page, hasRenderer) {
  await page.evaluate(() => {
    const app = window.patrol;
    app.indoorScenes = true;
    app.ui.closeAll();
    app.newGame(42);
    app.perf.setVisible(false);
  });
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  await page.evaluate(async () => {
    await window.patrol.console.execute('time 10:30');
    await window.patrol.console.execute('weather clear');
  });
  await sleep(1500);

  // --- The shift starts in the station's locker room ---------------------------------------------
  const start = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const st = s.buildings.station();
    return {
      stationId: st?.id ?? -1,
      state: s.officerBuilding,
      flow: s.station.flow.step,
      hint: s.interactHint(),
      status: s.cad.unit(s.dispatcher.playerCallsign)?.status ?? '',
      shiftLine: document.body.innerText.includes('Shift:'),
      location: document.body.innerText.includes('Police station'),
      floorPlan: app.worldView?.minimap.floorPlan !== null,
      carried: s.officerKit.carried('camera') + s.officerKit.carried('evidenceMarkers'),
      interiorDraw: app.phase4.interiorRenderer?.drawCalls ?? 0,
      chunksHidden: app.worldView?.streamer ? !app.worldView.streamer.root.visible : true,
    };
  });
  console.log('shift start:', JSON.stringify(start));
  check(start.stationId >= 0 && start.state === start.stationId, `the new shift starts inside the police station (building ${start.state})`);
  check(start.flow === 'locker' && start.hint === 'locker', `shift flow at the locker (${start.flow}, hint ${start.hint})`);
  check(start.status === 'outOfService', `the unit is out of service until the garage step (${start.status})`);
  check(start.shiftLine && start.location, 'the HUD shows the shift objective and the location chip');
  check(start.floorPlan, 'the minimap draws the station floor plan');
  check(start.carried >= 2, 'the field kit is carried');
  if (hasRenderer) {
    check(start.interiorDraw > 0 && start.interiorDraw <= 6, `the interior mesh draws in at most 6 draw calls (${start.interiorDraw})`);
    check(start.chunksHidden, 'the city chunks are hidden indoors');
  }

  // Locker with the real keys: E opens the panel, 5 cycles the flashlight, 6 is Done.
  await page.evaluate(placeAtStationPoint, 'locker');
  await sleep(500);
  await press(page, 'KeyE');
  const locker = await page.evaluate(shiftState);
  check(locker.panel === 'locker', 'E at the locker opens the locker panel');
  await press(page, 'Digit5');
  await press(page, 'Digit6');
  await sleep(400);
  const afterLocker = { ...(await page.evaluate(shiftState)), flashlight: await page.evaluate(() => window.patrol.session.station.loadout.flashlight) };
  check(afterLocker.flow === 'briefing' && afterLocker.panel === null, `Done in the locker panel completes the locker step (${afterLocker.flow})`);
  check(afterLocker.flashlight === 'mounted', `the locker loadout changed (flashlight ${afterLocker.flashlight})`);

  // Roll call.
  await page.evaluate(placeAtStationPoint, 'briefing');
  await sleep(500);
  await press(page, 'KeyE');
  await sleep(600);
  const briefing = await page.evaluate(() => {
    const app = window.patrol;
    return { open: app.phase4.briefing.isOpen, title: app.phase4.briefing.view?.title ?? '', menus: app.ui.menuStack.map((m) => m.id), paused: app.loop.paused };
  });
  check(briefing.open && briefing.paused, `E at the podium opens the roll-call sheet (${briefing.title})`);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, 'phase4-station.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase4-station.png')}`);
  await press(page, 'Enter');
  await sleep(500);
  const afterBriefing = await page.evaluate(shiftState);
  check(afterBriefing.flow === 'armory' && afterBriefing.menus.length === 0, `closing the sheet completes the briefing step (${afterBriefing.flow})`);

  // Armory: pistol (1), taser (2), Done (7).
  await page.evaluate(placeAtStationPoint, 'armory');
  await sleep(500);
  await press(page, 'KeyE');
  await press(page, 'Digit1');
  await press(page, 'Digit2');
  await press(page, 'Digit7');
  await sleep(400);
  const armory = { ...(await page.evaluate(shiftState)), ...(await page.evaluate(() => ({ weapons: window.patrol.session.station.weaponsAvailable(), log: window.patrol.session.station.armory.entries().length }))) };
  check(armory.out.includes('sidearm') && armory.out.includes('taser') && armory.log === 2, `the armory log records the sign-outs (${armory.out.join(', ')})`);
  check(armory.weapons.sidearm && armory.flow === 'garage', `the duty pistol is available and the flow moves to the garage (${armory.flow})`);

  // The garage door: E at the wide door leaves the building.
  await page.evaluate(() => {
    const s = window.patrol.session;
    const st = s.buildings.station();
    const d = s.interiors.layout(st.id).doors.find((x) => x.kind === 'wide' && x.exit && x.exit.z < st.minZ);
    s.physics.getBody(s.player).setTranslation({ x: d.x, y: -40 + 0.9, z: d.z + 1 }, true);
    s.controller.yaw = 0;
  });
  await sleep(500);
  const garageHint = await page.evaluate(() => window.patrol.session.interactHint());
  await press(page, 'KeyE');
  await waitFor(page, () => window.patrol.session.officerBuilding === -1 && window.patrol.session.interiors.fade === 0, null, 15000);
  await sleep(800);
  const outside = await page.evaluate(shiftState);
  check(garageHint === 'exitBuilding', `the garage door offers Exit (${garageHint})`);
  check(outside.building === -1 && outside.flow === 'onPatrol', `leaving through the garage door completes the garage step (${outside.flow})`);
  check(outside.status === 'available', `the unit goes available on patrol (${outside.status})`);

  // --- A house: E enters with a fade, the interior is drawn --------------------------------------
  const house = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const at = s.playerPosition({ x: 0, z: 0 });
    const out = [];
    s.buildings.near(at.x, at.z, 700, out);
    const houses = out.filter((b) => b.kind === 'house' && s.interiors.layout(b.id) !== null);
    houses.sort((a, b) => Math.hypot(a.door.x - at.x, a.door.z - at.z) - Math.hypot(b.door.x - at.x, b.door.z - at.z));
    const h = houses[0];
    const layout = s.interiors.layout(h.id);
    const main = layout.doors.find((d) => d.main);
    app.teleport(main.exit.x, main.exit.z, main.exit.yaw + Math.PI);
    return { id: h.id, door: main.index, address: h.address, rooms: layout.rooms.length };
  });
  console.log('house:', JSON.stringify(house));
  await waitFor(page, () => (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 30000);
  await sleep(800);

  // A domestic call bound to this house with a victim and a suspect (retried until the roll gives both), then walk in.
  const call = await page.evaluate(async (h) => {
    const app = window.patrol;
    const s = app.session;
    const layout = s.interiors.layout(h.id);
    const main = layout.doors[h.door];
    let callId = 0;
    for (let k = 0; k < 40 && callId === 0; k++) {
      const id = s.scene.spawnCall('domesticDisturbance', s.now(), { x: main.x, z: main.z }, [], h.id);
      const rt = s.scene.runtime(id);
      if (rt && rt.buildingId === h.id && rt.scenario.variants.length === 0 && ['victim', 'suspect'].every((r) => rt.scenario.participants.some((p) => p.role === r))) callId = id;
      else if (id > 0) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
      for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    }
    if (callId === 0) return null;
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId }, 'key');
    return { id: callId, number: s.cad.call(callId)?.number ?? '', bound: s.scene.buildingOf(callId) };
  }, house);
  console.log('call:', JSON.stringify(call));
  check(call !== null && call.bound === house.id, `a domestic call binds to the house (${call?.number ?? '-'})`);
  await page.evaluate(stepSim, 240);
  const people = await page.evaluate((h) => {
    const s = window.patrol.session;
    const ids = s.npc.actorsInBuilding(h.id, []);
    return { inside: ids.length, roles: ids.map((id) => s.npc.actor(id, { id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 })?.role) };
  }, house);
  check(people.inside >= 1 && people.roles.includes('suspect'), `the scene's people stand inside the house (${people.roles.join(', ')})`);

  // The front door is knocked; the resident answers at the door; holding E opens the door panel and 8 enters.
  await page.evaluate((h) => {
    const s = window.patrol.session;
    s.interiors.request({ kind: 'door', buildingId: h.id, door: h.door, action: 'knock' });
  }, house);
  await page.evaluate(stepSim, 900);
  await page.evaluate((h) => {
    const s = window.patrol.session;
    if (s.interiors.doorState(h.id, h.door) === 'locked') s.interiors.setDoorState(h.id, h.door, 'closed');
    const d = s.interiors.layout(h.id).doors[h.door];
    s.physics.getBody(s.player).setTranslation({ x: d.exit.x, y: 0.9, z: d.exit.z }, true);
    s.controller.yaw = d.exit.yaw + Math.PI;
  }, house);
  await sleep(600);
  const enterHint = await page.evaluate(() => window.patrol.session.interactHint());
  // Software GL renders about 3 frames a second: hold the key long enough for a frame past the 0.4 s threshold.
  await press(page, 'KeyE', 1500);
  const doorPanel = await page.evaluate(() => window.patrol.panels.kind);
  check(doorPanel === 'door', `holding E at the door opens the door panel (${doorPanel}; the tap hint was ${enterHint})`);
  await press(page, 'Digit8');
  await waitFor(page, (id) => window.patrol.session.officerBuilding === id && window.patrol.session.interiors.fade === 0, house.id, 20000);
  await sleep(800);
  const inside = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    return {
      building: s.officerBuilding,
      y: s.physics.getBody(s.player).translation().y,
      draw: app.phase4.interiorRenderer?.drawCalls ?? 0,
      total: app.renderer?.stats.drawCalls ?? 0,
      firstPerson: app.phase4.firstPerson(s),
      lights: app.phase4.lightPool?.lights.length ?? 0,
      location: document.body.innerText.includes('House'),
      room: s.officerRoom(),
    };
  });
  console.log('inside:', JSON.stringify(inside));
  check(inside.building === house.id && Math.abs(inside.y - (-40 + 0.9)) < 0.01, `E enters the house after the fade (level y ${inside.y.toFixed(2)})`);
  check(inside.firstPerson && inside.location, 'indoors: first-person camera and the location chip');
  if (hasRenderer) {
    check(inside.draw > 0 && inside.draw <= 6, `the house interior draws in ${inside.draw} draw calls`);
    check(inside.total <= DRAW_CALL_CAP, `total draw calls indoors within the cap (${inside.total})`);
  }

  // Flashlight (F), crouch (X) and lean (Q held) with the real keys.
  await press(page, 'KeyF');
  await press(page, 'KeyX');
  await page.keyboard.down('KeyQ');
  await sleep(700);
  const tactical = await page.evaluate(() => {
    const t = window.patrol.session.tactical;
    return { light: t.flashlightOn, crouched: t.stance.crouched, lean: t.stance.lean, text: document.body.innerText };
  });
  await page.keyboard.up('KeyQ');
  check(tactical.light && tactical.crouched, 'F toggles the flashlight and X crouches');
  check(tactical.lean < -0.3, `Q held leans left (${tactical.lean.toFixed(2)})`);
  check(tactical.text.includes('CROUCH') && tactical.text.includes('LIGHT'), 'the HUD shows the CROUCH and LIGHT chips');

  // A door kick: an interior door is breached (retries: a kick can fail).
  const kick = await page.evaluate(async (h) => {
    const app = window.patrol;
    const s = app.session;
    const layout = s.interiors.layout(h.id);
    const d = layout.doors.find((x) => x.kind === 'interior' && x.b >= 0 && s.interiors.doorState(h.id, x.index) !== 'open');
    if (!d) return { door: -1, state: 'none' };
    // Stand in room d.a, 0.8 m from the opening.
    const room = layout.rooms[d.a].rect;
    for (const sign of [1, -1]) {
      const x = d.axis === 'x' ? d.x : d.x + sign * 0.8;
      const z = d.axis === 'x' ? d.z + sign * 0.8 : d.z;
      if (x > room.minX && x < room.maxX && z > room.minZ && z < room.maxZ) {
        s.physics.getBody(s.player).setTranslation({ x, y: -40 + 0.9, z }, true);
        break;
      }
    }
    let state = s.interiors.doorState(h.id, d.index);
    for (let k = 0; k < 12 && state !== 'broken'; k++) {
      s.interiors.request({ kind: 'door', buildingId: h.id, door: d.index, action: 'kick' });
      await new Promise((r) => setTimeout(r, 120));
      for (let i = 0; i < 70; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
      state = s.interiors.doorState(h.id, d.index);
    }
    return { door: d.index, state };
  }, house);
  check(kick.state === 'broken', `a door kick breaches an interior door (door ${kick.door}: ${kick.state})`);

  // Evidence marker through the tools panel (I, 1) and the camera (O, Space).
  await press(page, 'KeyX'); // stand up for the photo
  await press(page, 'KeyI');
  const tools = await page.evaluate(() => window.patrol.panels.kind);
  check(tools === 'tools', 'I opens the investigation tools panel');
  await press(page, 'Digit1');
  await press(page, 'Escape');
  await sleep(400);
  const marker = await page.evaluate(() => {
    const s = window.patrol.session;
    return s.investigation.store.files().reduce((n, f) => n + f.markers.length, 0);
  });
  check(marker === 1, `the tools panel places a numbered evidence marker (${marker})`);
  await press(page, 'KeyO');
  const camera = await page.evaluate(() => window.patrol.phase4.camera.isOpen);
  check(camera, 'O opens the camera viewfinder');
  await press(page, 'Space');
  const photo = await waitFor(
    page,
    () => {
      const s = window.patrol.session;
      const photos = s.investigation.store.files().flatMap((f) => f.photos);
      return photos.length > 0 && (window.patrol.renderer === null || photos.every((p) => p.thumb !== null)) ? photos.length : 0;
    },
    null,
    15000,
  );
  check(photo === 1, `the shutter records a photograph (${photo})`);
  if (hasRenderer) {
    const thumb = await page.evaluate(() => window.patrol.session.investigation.store.files().flatMap((f) => f.photos)[0]?.thumb ?? '');
    check(thumb.startsWith('data:image/jpeg') && thumb.length < 12000, `the photo has a small JPEG thumbnail (${thumb.length} chars)`);
  }
  await press(page, 'Escape');
  await page.evaluate(() => {
    const s = window.patrol.session;
    s.tactical.setHeld(0, false);
  });

  // Evidence custody: collect, bag, tag (the call's item), then the screenshot with light and markers.
  const evidence = await page.evaluate(async (callId) => {
    const app = window.patrol;
    const s = app.session;
    const inv = s.investigation;
    const door = s.interiors.layout(s.officerBuilding).doors.find((d) => d.main);
    // The scene's own evidence may lie anywhere in the house: put a knife at the front door, as the scene would.
    const id = inv.placeItem({ callId, item: 'knife', label: 'Kitchen knife', x: door.exit.x, y: 0, z: door.exit.z + 0.5, buildingId: -1, room: -1, furniture: -1, container: 'none', concealed: false, ownerPersonId: -1, incriminating: true });
    const item = inv.store.item(id);
    // The item lies outside at the door: walk to the front door, leave and collect it there.
    const entry = s.interiors.layout(s.officerBuilding).entry;
    s.physics.getBody(s.player).setTranslation({ x: entry.x, y: -40 + 0.9, z: entry.z }, true);
    for (let i = 0; i < 6; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.interiors.request({ kind: 'exit', door: door.index });
    for (let i = 0; i < 90; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.physics.getBody(s.player).setTranslation({ x: item.x, y: 0.9, z: item.z }, true);
    // The plain-view scan (2 Hz) flags it as found before it can be collected.
    for (let i = 0; i < 90; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    for (const kind of ['collect', 'bag', 'tag']) {
      inv.request({ kind, itemId: item.id });
      for (let i = 0; i < 6; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    }
    return { item: item.id, ledger: inv.ledger.itemEntries(item.id).length, building: s.officerBuilding };
  }, call?.id ?? 0);
  check(evidence.ledger === 3, `collect, bag and tag are recorded in the custody ledger (${evidence.item}: ${evidence.ledger} entries)`);
  // Back in the house for the screenshots.
  await page.evaluate((h) => {
    const s = window.patrol.session;
    s.interiors.request({ kind: 'enter', buildingId: h.id, door: h.door });
  }, house);
  await waitFor(page, (id) => window.patrol.session.officerBuilding === id && window.patrol.session.interiors.fade === 0, house.id, 20000);
  await page.evaluate(() => {
    const s = window.patrol.session;
    if (!s.tactical.flashlightOn) s.tactical.request({ kind: 'flashlight' });
    s.controller.pitch = 0.05;
    s.investigation.request({ kind: 'marker' });
  });
  await sleep(1500);
  await page.screenshot({ path: path.join(SHOTS, 'phase4.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase4.png')}`);
  await page.evaluate(() => window.patrol.phase4.openCaseFile(window.patrol.session));
  await sleep(800);
  const caseOpen = await page.evaluate(() => ({ open: window.patrol.phase4.caseFile.isOpen, text: document.body.innerText }));
  check(caseOpen.open, 'the case file panel opens');
  await page.screenshot({ path: path.join(SHOTS, 'phase4-case.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase4-case.png')}`);
  await press(page, 'Escape');

  // --- Deposit at the station's evidence room, a prisoner in a cell, the interview room ----------
  const station = await page.evaluate(async (itemId) => {
    const app = window.patrol;
    const s = app.session;
    await app.console.execute('interior enter policeStation');
    await new Promise((r) => setTimeout(r, 1500));
    const p = s.stationPoint('evidence');
    s.physics.getBody(s.player).setTranslation({ x: p.x, y: -40 + 0.9, z: p.z }, true);
    s.controller.yaw = p.yaw;
    await new Promise((r) => setTimeout(r, 500));
    return { building: s.officerBuilding, hint: s.interactHint(), itemId };
  }, evidence.item);
  check(station.hint === 'evidence', `the station evidence point offers Deposit (${station.hint})`);
  await press(page, 'KeyE');
  await sleep(500);
  const deposited = await page.evaluate((itemId) => {
    const inv = window.patrol.session.investigation;
    return { complete: inv.ledger.complete(itemId), verify: window.patrol.session.investigation.ledger.entries().length };
  }, evidence.item);
  check(deposited.complete, 'depositing at the evidence room completes the chain of custody');
  const cells = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    s.station.request({ kind: 'hold', personId: 31337 });
    await new Promise((r) => setTimeout(r, 400));
    const id = s.npc.actorOfPerson(31337);
    const info = id > 0 ? s.npc.actor(id, { id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 }) : null;
    const p = s.stationPoint('interview');
    s.physics.getBody(s.player).setTranslation({ x: p.x, y: -40 + 0.9, z: p.z }, true);
    s.controller.yaw = p.yaw;
    await new Promise((r) => setTimeout(r, 400));
    app.panels.openInterview();
    return { held: s.station.holding.occupants().length, actor: id, building: info?.building ?? -2, role: info?.role ?? '', panel: app.panels.kind };
  });
  check(cells.held === 1 && cells.building >= 0 && cells.role === 'prisoner', `a booked prisoner sits in a holding cell (${cells.role} in building ${cells.building})`);
  check(cells.panel === 'interview', 'the interview panel lists the prisoner');
  await press(page, 'Digit1');
  await sleep(1200);
  const interview = await page.evaluate(() => {
    const s = window.patrol.session;
    return { interviewing: s.station.interviewing, contact: s.contact.active };
  });
  check(interview.interviewing === 31337 && interview.contact >= 0, `bringing the prisoner in opens the interview (contact ${interview.contact})`);
  await page.evaluate(() => window.patrol.ui.closeAll());

  // --- A v6 save / load round trip ---------------------------------------------------------------
  const save = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const before = {
      building: s.officerBuilding,
      files: s.investigation.store.files().length,
      ledger: s.investigation.ledger.entries().length,
      holding: s.station.holding.occupants().length,
      flow: s.station.flow.step,
      broken: 0,
    };
    await app.saveGame('p4');
    const list = await app.saves.list();
    await app.loadGame('p4');
    const l = app.session;
    await new Promise((r) => setTimeout(r, 1500));
    return {
      version: list.find((x) => x.slot === 'p4')?.version ?? 0,
      before,
      after: {
        building: l.officerBuilding,
        files: l.investigation.store.files().length,
        ledger: l.investigation.ledger.entries().length,
        holding: l.station.holding.occupants().length,
        flow: l.station.flow.step,
      },
      verify: l.investigation.ledger.entries().length === 0 ? 'empty' : 'entries',
    };
  });
  console.log('phase 4 save/load:', JSON.stringify(save));
  check(save.version === 9, `the save is written as version 9 (${save.version})`);
  check(save.after.building === save.before.building && save.after.building >= 0, 'the officer is back inside the station after the load');
  check(save.after.files === save.before.files && save.after.ledger === save.before.ledger, `case files and the custody ledger survive (${save.after.files} files, ${save.after.ledger} entries)`);
  check(save.after.holding === save.before.holding && save.after.flow === save.before.flow, 'holding cells and the shift flow survive');

  // --- Console commands ---------------------------------------------------------------------------
  const cmds = await page.evaluate(async () => {
    const c = window.patrol.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    const itemId = window.patrol.session.investigation.store.files().flatMap((f) => f.items)[0]?.id ?? 'E-0-1';
    for (const line of ['building here', 'interior info', 'interior gen house 7', 'interior gen bank 3', 'interior doors', 'shift', 'armory', 'loadout', 'case', 'evidence list', `custody ${itemId}`, 'ledger verify', 'sound debug', 'sound knock', 'partner summon', 'aware', 'tape clear', 'interior exit']) {
      out.push(...(await run(line)));
    }
    return out;
  });
  console.log('phase 4 console commands:\n  ' + cmds.join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 4 console commands ran without errors');
  check(cmds.some((l) => l.includes('deterministic: yes')), 'interior gen reports a deterministic layout');

  // --- Perf ---------------------------------------------------------------------------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    await app.console.execute('interior enter house');
    await new Promise((r) => setTimeout(r, 1500));
  });
  const perf = await page.evaluate(perfSnapshot);
  const extras = await page.evaluate(() => {
    const s = window.patrol.session;
    const out = {};
    for (const [name, ms] of window.patrol.systems.timings) if (['interiors', 'investigation', 'station', 'tactical', 'scene', 'npc'].includes(name)) out[name] = Number(ms.toFixed(4));
    return { systems: out, interiors: { ...s.interiors.stats }, indoorDraw: window.patrol.phase4.interiorRenderer?.drawCalls ?? 0 };
  });
  const frame = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
  console.log('perf phase 4:', JSON.stringify(perf));
  console.log('phase 4 sim costs:', JSON.stringify(extras));
  return { perf, frame, extras };
}

/**
 * The scripted Phase 5 incident, run in the page with fast-forwarded sim time (`stepSrc` = stepSim). `stage` 1: the
 * bodycam on, a speeding car pulled over (the violation seen before the lights), ID, drinking question (odor), a
 * consent PBT, the driver steps out and fights, the officer faces them from 3 m with the TASER selected. Stage 2:
 * kneel, cuff, rights, a question in custody, the booking(s) (court cases, one of them scheduled), the call cleared.
 * Stage 3: a bystander is frisked without suspicion and tased while compliant (an unlawful frisk, excessive force:
 * an IA case) while the real loop records a few snapshots (the incident is closed from the console afterwards).
 */
function phase5Flow([stepSrc, stage, ids]) {
  const step = new Function(`return ${stepSrc}`)();
  const app = window.patrol;
  const s = app.session;
  const scratch = { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
  const actor = (id) => ({ ...s.npc.actor(id, scratch) });
  const pos = () => s.playerPosition({ x: 0, z: 0 });
  // A flow can leave the officer in the patrol car (a failed cage step enters it): get out before moving the body.
  const onFoot = () => {
    for (let i = 0; i < 3 && s.driving; i++) {
      s.interact();
      step(10);
    }
    return Boolean(s.physics.getBody(s.player));
  };
  const place = (x, z) => {
    if (!onFoot()) return;
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
  const close = (cid) => {
    s.contact.request({ kind: 'close', contactId: cid });
    step(5);
  };
  const faceTo = (tx, tz) => {
    const p = pos();
    s.controller.yaw = Math.atan2(-(tx - p.x), -(tz - p.z));
  };

  if (stage === 1) {
    step(60);
    s.investigation.request({ kind: 'bodycam', on: true });
    step(5);
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
      const who = s.npc.occupantsOf(vehicleId)[0];
      const idn = who >= 0 ? s.people.identity(who) : null;
      if (!idn || idn.juvenile || idn.hearing !== 'normal' || idn.language.english !== 'fluent' || idn.dementia || idn.temperament !== 'calm' || idn.attitude < 0 || idn.wanted) {
        s.traffic.removeVehicle(vehicleId);
        continue;
      }
      // The officer saw the speeding before lighting the car up (the traffic module's own event).
      s.bus.emit('traffic:violation', { eid: 0, vehicleId, kind: 'speeding', x: p.x, z: p.z, speedMph: 52, limitMph: 35 });
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
      if (s.cad.trafficStop?.vehicleId === vehicleId && s.cad.trafficStop.outcome === 'active') stopped = vehicleId;
      else {
        s.traffic.stopFlee(vehicleId);
        s.traffic.removeVehicle(vehicleId);
        const pu = s.cad.playerUnit();
        if (pu?.callId != null) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: pu.callId, disposition: 'handled' }, 'key');
        step(120);
      }
    }
    if (stopped < 0) return { ok: false, detail: 'no car could be stopped' };
    const stop = s.cad.trafficStop;
    const driver = s.npc.occupantsOf(stopped)[0];
    s.people.setIntoxication(driver, 0.12, 'none');
    s.interact();
    const st = s.traffic.stopState({ vehicleId: -1, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 });
    for (const [lx, lz] of [[-1.35, -0.77], [-1.2, -0.5], [-1.5, -1.1], [-1.1, -0.2], [-1.4, 0.2]]) {
      place(st.x + lx * Math.cos(st.yaw) + lz * Math.sin(st.yaw), st.z - lx * Math.sin(st.yaw) + lz * Math.cos(st.yaw));
      if (s.atStoppedDriver()) break;
    }
    step(10);
    s.interact();
    step(10);
    const dc = s.contact.active;
    say(dc, 'greet', 120);
    say(dc, 'requestId');
    say(dc, 'askDrinking');
    const hasPbt = () => s.contact.view(dc).facts.some((f) => f.text.includes('Breath test'));
    for (let k = 0; k < 6 && !hasPbt(); k++) {
      say(dc, 'consentPbt');
      act(dc, 'pbt', 200);
      if (!hasPbt()) say(dc, 'reassure', 200);
    }
    say(dc, 'cmdStepOut');
    let actorId = s.npc.actorOfPerson(driver);
    if (actorId === 0) actorId = s.npc.stepOut(stopped, 0);
    // The driver attacks: the fight state, the officer 3 m away facing them with the TASER selected.
    s.npc.forceState(actorId, 'fight');
    step(30);
    const a = actor(actorId);
    place(a.x - 3, a.z);
    faceTo(a.x, a.z);
    s.force.request({ kind: 'selectTool', tool: 'taser' });
    step(5);
    const pbt = hasPbt();
    // The dialogue panel closes: the controls (mouse 0 = apply the tool) are the player's again.
    close(dc);
    return { ok: pbt, detail: `pbt ${pbt}`, key: s.incidents.current, callId: stop.callId, driver, actorId };
  }

  if (stage === 2) {
    const { actorId, driver, callId, key } = ids;
    s.npc.forceState(actorId, 'kneel');
    step(200);
    const a = actor(actorId);
    place(a.x - 1.2, a.z);
    step(30);
    s.contact.request({ kind: 'open', target: { kind: 'actor', actorId } });
    step(10);
    const dc = s.contact.active;
    act(dc, 'cuff', 200);
    say(dc, 'miranda');
    say(dc, 'askDrugs');
    // Bookings: every case rolls a plea; more bookings are filed until one of them is scheduled for a hearing.
    const booked = [];
    for (let k = 0; k < 12; k++) {
      const t = s.now();
      const draft = s.cad.docs.create('booking', { callId, personId: driver, charges: ['TR-360'], arrestLocation: 'smoke test', arrestedGame: t.game }, t, 'Officer Doe #4071');
      s.cad.docs.finalize(draft.id, t);
      booked.push(true);
      step(30);
      if (s.court.cases().some((c) => c.status === 'scheduled')) break;
    }
    close(dc);
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId, disposition: 'arrestMade' }, 'key');
    step(300);
    const log = s.incidents.log(key);
    return {
      ok: booked[0] === true && log?.closed === true,
      detail: `booked ${booked.length}, closed ${String(log?.closed)}`,
      cases: s.court.cases().map((c) => `${c.id}:${c.status}`),
      scheduled: s.court.cases().find((c) => c.status === 'scheduled')?.id ?? '',
    };
  }

  // stage 3
  const at = pos();
  const personId = 51234;
  const actorId = s.npc.spawnActor({ personId, x: at.x + 6, z: at.z, yaw: 0, profile: 'bystander', role: 'bystander', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1 });
  step(30);
  const a = actor(actorId);
  place(a.x - 1.2, a.z);
  step(20);
  s.contact.request({ kind: 'open', target: { kind: 'actor', actorId } });
  step(10);
  const cid = s.contact.active;
  s.npc.forceState(actorId, 'hold');
  step(10);
  act(cid, 'frisk', 120);
  const key = s.incidents.current;
  // A TASER on a compliant bystander: excessive.
  const b = actor(actorId);
  place(b.x - 3, b.z);
  faceTo(b.x, b.z);
  s.force.request({ kind: 'selectTool', tool: 'taser' });
  step(5);
  const p = pos();
  const len = Math.hypot(b.x - p.x, b.z - p.z);
  s.force.request({ kind: 'apply', dirX: (b.x - p.x) / len, dirZ: (b.z - p.z) / len });
  step(10);
  return { ok: key !== '', detail: `incident ${key}`, key, actorId, contact: cid };
}

/**
 * Phase 5 checks on a fresh outdoor shift: the force tool keys and HUD chip, a scripted stop with a TASER application
 * (real mouse click), the legal line, `law explain`, the MDT report checklist and grade, the Career and Community tabs, a
 * court case through the courtroom with the real keys, an IA case with the evidence review (snapshots from the live
 * canvas), a v7 save / load and the Phase 5 console commands.
 */
async function phase5(page, hasRenderer) {
  await page.evaluate(() => {
    const app = window.patrol;
    app.indoorScenes = false;
    app.ui.closeAll();
    app.newGame(42, 'generic');
    app.perf.setVisible(false);
  });
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  await page.evaluate(async () => {
    await window.patrol.console.execute('time 10:30');
    await window.patrol.console.execute('weather clear');
    // The shift starts in the station: the duty pistol and the TASER are signed out at the armory (Phase 4 keys).
    const st = window.patrol.session.station;
    st.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    st.request({ kind: 'armory', item: 'taser', action: 'out' });
    st.request({ kind: 'complete', step: 'garage' });
  });
  await sleep(1500);

  // --- C cycles the force tools (the TASER is available: the armory log has it signed out) -----------------
  const tools = [];
  for (let k = 0; k < 8; k++) {
    await press(page, 'KeyC');
    const t = await page.evaluate(() => window.patrol.session.force.tool);
    tools.push(t);
    if (t === 'taser') break;
  }
  await waitFor(page, () => /TASER/.test(document.querySelector('#hud')?.textContent ?? ''), null, 3000);
  const chip = await page.evaluate(() => /TASER \d+\/\d+/.exec(document.querySelector('#hud')?.textContent ?? '')?.[0] ?? '');
  console.log(`phase 5 tools: ${tools.join(' > ')}; chip "${chip}"`);
  check(tools.at(-1) === 'taser' && /TASER/.test(chip), `C cycles the force tools to the TASER with a HUD chip (${tools.join(', ')}; "${chip}")`);

  // --- The scripted stop up to the TASER ---------------------------------------------------------------
  const s1 = await page.evaluate(phase5Flow, [stepSim.toString(), 1, null]);
  console.log('phase 5 stage 1:', JSON.stringify(s1));
  check(s1.ok, `stop: speeding car pulled over, ID, odor and a consent PBT (${s1.detail})`);
  const beforeFire = await page.evaluate(() => window.patrol.session.force.hud.ammo);
  await waitFrames(page, 3);
  // Headless Chromium never grants pointer lock, and the input layer swallows the click that asks for it: the lock is
  // switched off for this one click, which then reaches the game as mouse 0 (officer.fire).
  await page.evaluate(() => window.patrol.input.setPointerLockEnabled(false));
  await page.mouse.click(640, 360);
  const clicked = await waitFor(page, () => window.patrol.session.force.hud.attached, null, 4000);
  if (!clicked) {
    console.log('note: the mouse click did not fire the TASER; applying through the force system');
    await page.evaluate((ids) => {
      const s = window.patrol.session;
      const a = s.npc.actor(ids.actorId, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 });
      const p = s.playerPosition({ x: 0, z: 0 });
      const len = Math.hypot(a.x - p.x, a.z - p.z);
      s.force.request({ kind: 'apply', dirX: (a.x - p.x) / len, dirZ: (a.z - p.z) / len });
    }, s1);
    await waitFor(page, () => window.patrol.session.force.hud.attached, null, 4000);
  }
  const legalLine = await waitFor(page, () => /within policy|questionable|excessive/.test(document.querySelector('#hud')?.textContent ?? ''), null, 4000);
  const afterFire = await page.evaluate(() => ({ ammo: window.patrol.session.force.hud.ammo, attached: window.patrol.session.force.hud.attached, text: /TASER on[^\n]*/.exec(document.body.innerText)?.[0] ?? '' }));
  console.log('phase 5 fire:', JSON.stringify({ beforeFire, ...afterFire, clicked, legalLine }));
  check(afterFire.attached, `the TASER fired at the fighting driver, probes attached (${clicked ? 'mouse 0' : 'force request'})`);
  check(legalLine && /within policy/.test(afterFire.text), `the HUD shows the force verdict (${afterFire.text})`);

  // --- Arrest and booking, the call cleared ---------------------------------------------------------------
  const s2 = await page.evaluate(phase5Flow, [stepSim.toString(), 2, { ...s1 }]);
  console.log('phase 5 stage 2:', JSON.stringify(s2));
  check(s2.ok, `arrest: cuffed, rights, a custodial question, booking and the call cleared (${s2.detail})`);
  check(s2.scheduled !== '' || s2.cases.length > 0, `the booking opened court cases (${s2.cases.join(', ')})`);
  const explained = await page.evaluate(async (key) => {
    const c = window.patrol.console;
    const before = c.lines.length;
    await c.execute(`law explain ${key}`);
    return c.lines.slice(before).map((l) => l.text).join('\n');
  }, s1.key);
  console.log('law explain:\n  ' + explained.split('\n').join('\n  '));
  check(/GS-\d/.test(explained) && /detention/.test(explained) && /force #\d+ taser vs assaultive: justified/.test(explained), 'law explain lists the determinations with citations and the justified TASER');

  // --- The report with the statements checklist --------------------------------------------------------------
  const report = await page.evaluate(async (ids) => {
    const app = window.patrol;
    const s = app.session;
    const mdt = app.mdt;
    mdt.open('reports');
    const opened = mdt.openForm('report', { callId: ids.callId, title: 'Traffic stop with arrest', location: '95 S Park Avenue', narrative: 'Stopped a speeding car, smelled alcohol, the driver fought and was tased, then arrested.' });
    await new Promise((r) => setTimeout(r, 200));
    const choices = s.incidents.reportChoices(ids.key);
    const trueIds = choices.filter((c) => c.key === true).map((c) => c.id);
    const boxes = [...document.querySelectorAll('.mdt-statements input')];
    for (const b of boxes) if (trueIds.includes(b.value)) b.checked = true;
    const shown = boxes.length;
    const result = mdt.submitForm(true);
    await new Promise((r) => setTimeout(r, 600));
    const docId = result.doc?.id ?? '';
    const grade = s.conduct.reportGrade(docId);
    return { opened, shown, hidden: JSON.stringify(boxes.map((b) => b.outerHTML)).includes('truth'), ticked: trueIds.length, errors: result.errors, grade: grade ? { score: grade.score, letter: grade.letter, completeness: grade.completeness } : null };
  }, s1);
  console.log('phase 5 report:', JSON.stringify(report));
  check(report.opened && report.shown > 0 && !report.hidden, `the report form lists the statements of fact without the truth (${report.shown} boxes)`);
  check(report.errors.length === 0 && report.grade !== null && report.grade.score > 0, `the report was graded (${report.grade ? `${report.grade.letter} ${report.grade.score}` : 'no grade'})`);

  // --- Career and Community tabs ------------------------------------------------------------------------------
  const tabs = await page.evaluate(async () => {
    const mdt = window.patrol.mdt;
    mdt.open('career');
    await new Promise((r) => setTimeout(r, 400));
    const career = { sections: mdt.careerSections?.sections.map((x) => x.id) ?? [], text: document.querySelector('#ui')?.innerText ?? '' };
    mdt.open('community');
    await new Promise((r) => setTimeout(r, 300));
    const community = mdt.communityRows.map((r) => `${r.label} ${r.percent}`);
    mdt.open('career');
    await new Promise((r) => setTimeout(r, 300));
    return { career: career.sections, hasCal: /Calendar|Court/i.test(career.text), community };
  });
  console.log('phase 5 tabs:', JSON.stringify(tabs));
  check(tabs.career.includes('duty') && tabs.community.length >= 8, `the Career tab (${tabs.career.join(', ')}) and Community tab (${tabs.community.length} districts) render`);
  await page.screenshot({ path: path.join(SHOTS, 'phase5-mdt.png') });
  console.log(`screenshot: ${path.join(SHOTS, 'phase5-mdt.png')}`);
  await page.evaluate(() => window.patrol.mdt.close());

  // --- Court: advance a scheduled case, attend, answer with the real keys ---------------------------------------
  const court = await page.evaluate(async (scheduled) => {
    const app = window.patrol;
    const s = app.session;
    if (scheduled === '') return { skipped: true };
    await app.console.execute(`court advance ${scheduled}`);
    await new Promise((r) => setTimeout(r, 400));
    const can = s.court.canAttend(scheduled, s.env.time.totalSeconds);
    app.mdt.open('career');
    const attended = app.mdt.attendCase(scheduled);
    await new Promise((r) => setTimeout(r, 600));
    const panel = app.phase5.courtroom;
    return { skipped: false, can, attended, open: panel.isOpen, questions: panel.view?.questions.length ?? 0, status: s.court.case(scheduled)?.status };
  }, s2.scheduled);
  console.log('phase 5 court:', JSON.stringify(court));
  if (court.skipped) {
    console.log('note: every case was settled by a plea; the courtroom is covered by the unit tests');
  } else {
    check(court.can && court.attended && court.open, `the hearing opens the courtroom (${JSON.stringify(court)})`);
    await page.screenshot({ path: path.join(SHOTS, 'phase5-court.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase5-court.png')}`);
    await press(page, 'Enter');
    for (let k = 0; k < court.questions; k++) await press(page, 'Digit1');
    await press(page, 'Enter');
    const verdict = await waitFor(page, (id) => window.patrol.session.court.case(id)?.verdict != null, s2.scheduled, 6000);
    const done = await page.evaluate((id) => ({ open: window.patrol.phase5.courtroom.isOpen, c: window.patrol.session.court.case(id) }), s2.scheduled);
    console.log('phase 5 verdict:', JSON.stringify({ verdict: done.c?.verdict, reason: done.c?.reason, status: done.c?.status }));
    check(verdict && !done.open, `the testimony ends in a verdict (${done.c?.verdict} / ${done.c?.reason})`);
  }

  await page.evaluate(() => window.patrol.mdt.close());

  // --- An unlawful frisk and an excessive TASER: IA, with snapshots from the live canvas ---------------------------
  const s3 = await page.evaluate(phase5Flow, [stepSim.toString(), 3, null]);
  console.log('phase 5 stage 3:', JSON.stringify(s3));
  check(s3.ok, `field contact: a bystander frisked and tased without cause (${s3.detail})`);
  // Real time with the bodycam recording: the scheduler takes frames of the live canvas.
  if (hasRenderer) await sleep(3000);
  const snaps = await page.evaluate(async (key) => {
    const app = window.patrol;
    const list = await app.phase5.media.list(app.phase5.tag, key);
    return { count: list.length, bytes: list.reduce((n, m) => n + m.bytes, 0), key, current: app.session.incidents.current, paused: app.loop.paused, menus: app.ui.menuStack.map((m) => m.id), cam: app.session.incidents.cam.bits };
  }, s3.key);
  console.log('phase 5 snapshots:', JSON.stringify(snaps));
  if (hasRenderer) check(snaps.count >= 1, `the bodycam took snapshots of the live canvas (${snaps.count}, ${snaps.bytes} bytes)`);
  const ia = await page.evaluate(async (key) => {
    const app = window.patrol;
    const s = app.session;
    await app.console.execute(`incident close ${key}`);
    // The close, the assessment (one per step) and the conduct step that opens the IA case run in the live loop.
    for (let i = 0; i < 80 && !(s.incidents.log(key)?.closed && s.incidents.assessment(key) !== null && s.conduct.career.ia.length > 0); i++) await new Promise((r) => setTimeout(r, 100));
    const legal = [];
    const c = app.console;
    const before = c.lines.length;
    await c.execute(`law explain ${key}`);
    legal.push(...c.lines.slice(before).map((l) => l.text));
    const cases = s.conduct.career.ia;
    return { legal: legal.join('\n'), cases: cases.map((x) => `${x.id}:${x.key}:${x.status}`), id: cases.find((x) => x.key === key)?.id ?? cases[0]?.id ?? '' };
  }, s3.key);
  console.log('phase 5 frisk:\n  ' + ia.legal.split('\n').join('\n  '));
  check(/\[unlawful\] frisk/.test(ia.legal) && /vs compliant: excessive/.test(ia.legal), 'law explain shows the unlawful frisk and the excessive TASER of the field contact');
  check(ia.cases.length > 0, `an internal-affairs case was opened (${ia.cases.join(', ')})`);
  if (ia.id !== '') {
    const review = await page.evaluate(async (id) => {
      const app = window.patrol;
      app.phase5.openIa(id);
      await new Promise((r) => setTimeout(r, 800));
      const panel = app.phase5.review;
      return { open: panel.isOpen, menus: app.ui.menuStack.map((m) => m.id), text: (document.querySelector('.rev-root, [class*="rev-"]')?.textContent ?? '').slice(0, 200) };
    }, ia.id);
    console.log('phase 5 review:', JSON.stringify(review));
    check(review.open, 'the evidence review opens for the IA case');
    // End of the footage: the nearest snapshot shows where the first frame has none yet.
    await press(page, 'End');
    await sleep(500);
    await page.screenshot({ path: path.join(SHOTS, 'phase5-review.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase5-review.png')}`);
    // The review pauses the game: the statement is a queued request that conduct applies once the world runs again.
    await press(page, 'Digit1');
    await press(page, 'Escape');
    const closed = await page.evaluate(() => !window.patrol.phase5.review.isOpen);
    check(closed, 'Escape closes the evidence review');
    const decided = await waitFor(page, (id) => window.patrol.session.conduct.iaCase(id)?.statement != null, ia.id, 6000);
    const statement = await page.evaluate((id) => ({ statement: window.patrol.session.conduct.iaCase(id)?.statement ?? null, finding: window.patrol.session.conduct.iaCase(id)?.finding ?? null }), ia.id);
    console.log('phase 5 IA statement:', JSON.stringify(statement));
    check(decided, `the officer's statement was recorded from the review footer (${JSON.stringify(statement)})`);
  }

  // --- A v7 save / load round trip ---------------------------------------------------------------------------------
  const save = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const before = {
      keys: s.incidents.keys().length,
      cases: s.court.cases().length,
      ia: s.conduct.career.ia.length,
      trust: s.conduct.trustRows().map((r) => r.value.toFixed(5)).join(','),
      reports: s.conduct.career.reports.length,
    };
    await app.saveGame('p5');
    const list = await app.saves.list();
    await app.loadGame('p5');
    const l = app.session;
    await new Promise((r) => setTimeout(r, 800));
    return {
      version: list.find((x) => x.slot === 'p5')?.version ?? 0,
      before,
      after: {
        keys: l.incidents.keys().length,
        cases: l.court.cases().length,
        ia: l.conduct.career.ia.length,
        trust: l.conduct.trustRows().map((r) => r.value.toFixed(5)).join(','),
        reports: l.conduct.career.reports.length,
      },
    };
  });
  console.log('phase 5 save/load:', JSON.stringify(save));
  check(save.version === 9, `the save is written as version 9 (${save.version})`);
  check(JSON.stringify(save.before) === JSON.stringify(save.after), 'incident logs, court cases, IA cases, report grades and trust survive the load');

  // --- Console commands -------------------------------------------------------------------------------------------------
  const cmds = await page.evaluate(async () => {
    const c = window.patrol.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    for (const line of ['law ruleset', 'law ruleset strict', 'jurisdiction', 'law ruleset generic', 'law list', 'incident list', 'incident show', 'legal', 'force stats', 'force test', 'trust', 'trust downtown', 'career', 'ia list', 'court list', 'court next', 'cam status', 'cam mute on', 'cam mute off', 'media stats']) {
      out.push(`> ${line}`, ...(await run(line)));
    }
    return out;
  });
  console.log('phase 5 console commands:\n  ' + cmds.map((l) => l.slice(0, 160)).join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 5 console commands ran without errors');
  const strict = await page.evaluate(async () => {
    const app = window.patrol;
    await app.console.execute('law ruleset strict');
    await new Promise((r) => setTimeout(r, 300));
    const id = app.session.incidents.ruleset.id;
    await app.console.execute('law ruleset generic');
    return id;
  });
  check(strict === 'strict', 'the jurisdiction can be swapped to the strict ruleset from the console');

  // --- Perf -----------------------------------------------------------------------------------------------------------------
  const perf = await page.evaluate(perfSnapshot);
  const extras = await page.evaluate(() => {
    const out = {};
    for (const [name, ms] of window.patrol.systems.timings) if (['force', 'incidents', 'conduct', 'court', 'scene', 'contact'].includes(name)) out[name] = Number(ms.toFixed(4));
    const s = window.patrol.session;
    let events = 0;
    for (const k of s.incidents.keys()) events += s.incidents.log(k)?.events.length ?? 0;
    return { systems: out, incidents: s.incidents.keys().length, events };
  });
  const frame = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
  console.log('perf phase 5:', JSON.stringify(perf));
  console.log('phase 5 sim costs:', JSON.stringify(extras));
  return { perf, frame, extras };
}


/**
 * Phase 6 checks on a fresh shift: backup requested with the radio menu (T, 4, 2) and a K9 (T, 4, 5) at a call, an AI
 * officer getting out to cover with the HUD backup line and the Backup panel (`,`), a pursuit with the tactics panel (`;`)
 * and the air unit's FLIR camera (`/`), a mass-casualty incident with the command post, triage and the command panel
 * (`.`) and the MDT Command tab, a barricade with the negotiator and SWAT, a v8 save / load and the Phase 6 console
 * commands. Sim time is fast-forwarded in the page where units have to drive for minutes.
 */
async function phase6(page, hasRenderer) {
  await page.evaluate(() => {
    const app = window.patrol;
    app.indoorScenes = true;
    app.ui.closeAll();
    app.newGame(42, 'generic');
    app.perf.setVisible(false);
  });
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  await page.evaluate(async () => {
    await window.patrol.console.execute('time 10:30');
    await window.patrol.console.execute('weather clear');
    const st = window.patrol.session.station;
    st.request({ kind: 'armory', item: 'sidearm', action: 'out' });
    st.request({ kind: 'complete', step: 'garage' });
    // Phase 6 topics of interest are recorded for the checks.
    const log = [];
    window.__p6 = log;
    for (const t of ['pursuit:order', 'pursuit:tactic', 'backup:callout', 'backup:swat', 'command:flash', 'resource:dispatched', 'resource:arrived', 'command:post', 'command:triage', 'command:negotiation', 'scene:pursuit']) {
      window.patrol.bus.on(t, (e) => log.push({ t, sim: window.patrol.session.now().sim, e }));
    }
  });
  await sleep(1500);

  // --- Radio menu: T, 4 (Request), 2 (priority backup) and 5 (K9) --------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.enterVehicle(0);
    const s = app.session;
    const at = s.playerPosition({ x: 0, z: 0 });
    // A suspicious-person call at the officer's position, assigned to the officer (the player's call).
    const id = s.scene.spawnCall('suspiciousPerson', s.now(), at, [], -1);
    s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
    window.__p6Call = id;
  });
  await sleep(500);
  await press(page, 'KeyE'); // gets out of the (stationary) patrol car
  await page.evaluate(() => { for (let i = 0; i < 240; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0); });
  const menu0 = await page.evaluate(() => ({ driving: window.patrol.session.driving, call: window.patrol.session.cad.unit(window.patrol.session.dispatcher.playerCallsign)?.callId ?? 0, status: window.patrol.session.cad.unit(window.patrol.session.dispatcher.playerCallsign)?.status }));
  console.log('phase 6 start:', JSON.stringify(menu0));
  await press(page, 'KeyT');
  await press(page, 'Digit4');
  const menuTitle = await page.evaluate(() => window.patrol.radioMenuView.view?.title ?? '');
  await press(page, 'Digit2');
  // The request goes out when the officer's radio transmission ends: let the sim run for it.
  await page.evaluate(() => { for (let i = 0; i < 60 * 12; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0); });
  await waitFrames(page, 3);
  const afterBackup = await page.evaluate(() => window.patrol.session.cad.units().filter((u) => u.kind === 'ai' && u.status === 'enRoute').map((u) => u.callsign));
  console.log('phase 6 radio menu title:', menuTitle, '; units en route:', afterBackup.join(','));
  check(/^Request \d\/\d/.test(menuTitle), `T then 4 opens the paged Request menu (${menuTitle})`);
  check(afterBackup.length > 0, `Request > priority backup sends AI units (${afterBackup.join(', ')})`);
  await press(page, 'KeyT');
  await press(page, 'Digit4');
  await press(page, 'Digit5');
  await page.evaluate(() => { for (let i = 0; i < 60 * 12; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0); });
  await waitFrames(page, 3);
  const k9 = await waitFor(page, () => ['turnout', 'enRoute'].includes(window.patrol.session.cad.unit('K9-1')?.status ?? ''), null, 5000);
  check(k9, 'Request > K9 sends K9-1 from the station');
  // The HUD shows the soonest unit coming to the call.
  await page.evaluate(() => { for (let i = 0; i < 120; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0); });
  await waitFrames(page, 12);
  const eta = await page.evaluate(() => ({ text: window.patrol.session.phase6.resources.hud().next, hud: /ETA \d/.test(document.querySelector('#hud')?.textContent ?? '') }));
  console.log('phase 6 resource ETA:', JSON.stringify(eta));
  check(eta.text !== null && eta.hud, `the HUD shows a unit's ETA (${eta.text ?? '-'})`);

  // --- A backup officer gets out and covers (the dispatched units start close to the scene) ----------------------------------
  await page.evaluate(() => {
    const s = window.patrol.session;
    const at = s.playerPosition({ x: 0, z: 0 });
    for (const u of s.cad.units()) {
      if (u.kind !== 'ai' || u.status !== 'enRoute') continue;
      s.cad.setUnitPosition(u.callsign, at.x + 60, at.z);
      s.traffic.removeFleetCar(u.fleetIndex);
    }
  });
  const out = await page.evaluate(() => {
    const s = window.patrol.session;
    for (let i = 0; i < 60 * 150 && s.phase6.backup.officers().length === 0; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
    return s.phase6.backup.officers().map((o) => ({ cs: o.callsign, name: o.name, role: o.role, state: o.state }));
  });
  console.log('phase 6 backup officers:', JSON.stringify(out));
  check(out.length > 0, `an AI backup officer gets out of the car (${out.map((o) => `${o.cs} ${o.role}`).join(', ')})`);
  await page.evaluate(() => { for (let i = 0; i < 900; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0); });
  await waitFrames(page, 14);
  const hudLine = await page.evaluate(() => /COVER|SECONDARY/.test(document.querySelector('#hud')?.textContent ?? ''));
  const callout = await page.evaluate(() => window.__p6.some((x) => x.t === 'backup:callout'));
  check(hudLine, 'the HUD shows the backup officer line');
  check(callout, 'the backup officer calls out over the radio');
  await press(page, 'Comma');
  const backupPanel = await page.evaluate(() => ({ open: window.patrol.phase6.panel.isOpen, title: window.patrol.phase6.panel.model?.title ?? '', rows: window.patrol.phase6.panel.model?.options.length ?? 0 }));
  check(backupPanel.open && backupPanel.title === 'Backup', `, opens the Backup panel (${backupPanel.title}, ${backupPanel.rows} rows)`);
  await press(page, 'Digit1'); // select the first officer
  await press(page, 'Digit1');
  await waitFrames(page, 4);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase6-backup.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase6-backup.png')}`);
  }
  await press(page, 'Escape');
  check(await page.evaluate(() => !window.patrol.phase6.panel.isOpen), 'Escape closes the Backup panel');

  // --- A pursuit: tactics panel, supervisor order, air unit with FLIR ---------------------------------------------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    // Clear the call and get back in the car on the highway: a straight road for the chase.
    const call = s.cad.unit(s.dispatcher.playerCallsign)?.callId;
    if (call) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: call, disposition: 'handled' }, 'key');
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    app.enterVehicle(0);
    const lane = 58 * 16;
    const p = s.city.graph.lanePoint(lane, s.city.graph.laneStart(lane) + 40, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    app.teleport(p.x, p.z, p.yaw);
    // Evening rush hour: busy roads make the chase riskier (the supervisor weighs traffic density).
    await app.console.execute('time 17:30');
    for (let i = 0; i < 60; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    if (!s.drivenVehicle?.lightbar) s.toggleLightbar();
    await app.console.execute('pursuit spawn');
  });
  await waitFrames(page, 6);
  const started = await page.evaluate(() => ({ hud: window.patrol.session.phase6.pursuit.hud(), active: window.patrol.session.phase6.pursuit.active() }));
  console.log('phase 6 pursuit:', JSON.stringify(started));
  check(started.active && started.hud !== null, `pursuit spawn starts a pursuit with a HUD line (${started.hud?.line ?? '-'})`);
  await press(page, 'Semicolon');
  const pursuitPanel = await page.evaluate(() => ({ open: window.patrol.phase6.panel.isOpen, title: window.patrol.phase6.panel.model?.title ?? '', rows: window.patrol.phase6.panel.model?.options.length ?? 0 }));
  check(pursuitPanel.open && pursuitPanel.rows === 7, `; opens the pursuit tactics panel (${pursuitPanel.title}, ${pursuitPanel.rows} rows)`);
  await press(page, 'Digit6'); // request the air unit
  await press(page, 'Escape');
  await page.evaluate(async () => {
    await window.patrol.console.execute('pursuit spikes');
    // Spikes are refused when no unit can set them in time; a box-in attempt is always judged.
    await window.patrol.console.execute('pursuit box');
    for (let i = 0; i < 60 * 240 && !(window.__p6.some((x) => x.t === 'pursuit:order') && window.__p6.some((x) => x.t === 'pursuit:tactic')); i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  const sup = await page.evaluate(() => ({
    order: window.__p6.some((x) => x.t === 'pursuit:order' && x.e.order === 'terminate'),
    tactics: window.__p6.filter((x) => x.t === 'pursuit:tactic').map((x) => `${x.e.tactic}:${x.e.verdict}`),
    sgt: window.__p6.some((x) => x.t === 'resource:dispatched' && x.e.typeId === 'supervisor'),
    air: window.__p6.some((x) => x.t === 'resource:dispatched' && x.e.typeId === 'air'),
    line: document.querySelector('#hud')?.textContent ?? '',
  }));
  console.log('phase 6 pursuit events:', JSON.stringify({ ...sup, line: undefined }));
  check(sup.sgt, 'a sergeant is sent to the pursuit');
  check(sup.order, 'the supervisor orders the pursuit terminated (risk outweighs the offense)');
  check(sup.tactics.length > 0, `tactics are judged (${sup.tactics.join(', ')})`);
  check(sup.air, 'the air unit was requested from the tactics panel (key 6)');
  await page.evaluate(() => {
    // Let the chase end and the bail-out perimeter go up.
    for (let i = 0; i < 60 * 60; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
  });

  // --- A mass-casualty incident: command post, triage, the command panel and the MDT Command tab ------------------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    for (const c of s.cad.openCalls()) {
      if (s.cad.unit(s.dispatcher.playerCallsign)?.callId === c.id) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: c.id, disposition: 'handled' }, 'key');
    }
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    // Back to the city centre (the units' bases are there): the chase ended on the far highway.
    app.teleport(s.city.spawn.x + 40, s.city.spawn.z + 20, 0);
    await app.console.execute('time 13:00');
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  await press(page, 'KeyE'); // out of the patrol car: assessments are made on foot
  const mci = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    await app.console.execute('mci start multiVehicleCrash');
    for (let i = 0; i < 60 * 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const call = s.cad.unit(s.dispatcher.playerCallsign)?.callId ?? 0;
    const loc = s.cad.call(call)?.location;
    if (loc) app.teleport(loc.x, loc.z, 0);
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await app.console.execute('ics post');
    for (let i = 0; i < 60; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const v = s.phase6.command.board().victims[0];
    const a = v ? s.npc.actor(v.actorId, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 }) : null;
    if (a) app.teleport(a.x + 1.2, a.z, 0);
    for (let i = 0; i < 60; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await app.console.execute('ics needs');
    return { call, post: s.phase6.command.post(), victims: s.phase6.command.board().victims.length };
  });
  console.log('phase 6 mci:', JSON.stringify(mci));
  check(mci.post !== null && mci.victims >= 5, `the command post is established with ${mci.victims} patients on the board`);
  await press(page, 'Period');
  const cmdPanel = await page.evaluate(() => ({ open: window.patrol.phase6.panel.isOpen, title: window.patrol.phase6.panel.model?.title ?? '', rows: window.patrol.phase6.panel.model?.options.length ?? 0 }));
  check(cmdPanel.open && /command|ICS|Triage/i.test(cmdPanel.title), `. opens the command panel (${cmdPanel.title}, ${cmdPanel.rows} rows)`);
  // Row 1 (establish) is disabled with the post open, so 2 is "Assess nearest victim".
  await press(page, 'Digit2');
  await page.evaluate(() => {
    for (let i = 0; i < 60 * 8; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  await waitFrames(page, 14);
  const triage = await page.evaluate(() => ({ prompt: window.patrol.session.phase6.command.triage(), title: window.patrol.phase6.panel.model?.title ?? '' }));
  console.log('phase 6 triage:', JSON.stringify({ title: triage.title, label: triage.prompt?.label, progress: triage.prompt?.progress }), JSON.stringify(await page.evaluate(() => window.__p6.filter((x) => x.t === 'command:flash').slice(-3).map((x) => x.e.text))));
  check(triage.prompt !== null, `the assessment opens a triage prompt (${triage.title})`);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase6-command.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase6-command.png')}`);
  }
  const tagged = await page.evaluate(async () => {
    const s = window.patrol.session;
    const t = s.phase6.command.triage();
    if (t) await window.patrol.console.execute(`triage tag ${String(t.personId)} red`);
    for (let i = 0; i < 60; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
    return window.__p6.some((x) => x.t === 'command:triage' && x.e.by === 'player');
  });
  check(tagged, 'a patient is tagged with the triage command');
  await press(page, 'Escape');
  const mdt = await page.evaluate(() => {
    const m = window.patrol.mdt;
    m.open('command');
    m.update(performance.now() + 5000);
    return { tab: m.tab, model: m.commandModel !== null };
  });
  check(mdt.tab === 'command' && mdt.model, 'the MDT Command tab shows the ICS board');
  await page.evaluate(() => window.patrol.mdt.close());
  const ems = await page.evaluate(() => {
    // The ambulance comes from the hospital: its trip depends on the traffic, so run until it has worked (at most 10 minutes).
    const worked = () => window.__p6.some((x) => x.t === 'resource:arrived' && x.e.typeId === 'ems') && window.__p6.some((x) => x.t === 'command:triage' && x.e.by === 'ems');
    for (let i = 0; i < 60 * 600 && !worked(); i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
    return { dispatched: window.__p6.some((x) => x.t === 'resource:dispatched' && x.e.typeId === 'ems'), arrived: window.__p6.some((x) => x.t === 'resource:arrived' && x.e.typeId === 'ems'), emsTags: window.__p6.filter((x) => x.t === 'command:triage' && x.e.by === 'ems').length };
  });
  console.log('phase 6 EMS:', JSON.stringify(ems));
  check(ems.dispatched && ems.arrived && ems.emsTags > 0, `EMS arrives and triages the other patients (${ems.emsTags} tags)`);

  // The air unit is requested for the scene (about three minutes), then `/` puts the camera on it.
  await page.evaluate(async () => {
    await window.patrol.console.execute('request air');
  });
  const airUp = await page.evaluate(() => {
    const s = window.patrol.session;
    const air = () => s.phase6.resources.units().find((u) => u.callsign === 'AIR-1');
    for (let i = 0; i < 60 * 400 && air()?.status !== 'onScene'; i++) window.patrol.loop.hooks.fixedUpdate(1 / 60, 0);
    return { status: air()?.status ?? '-', view: s.phase6.resources.airView() !== null };
  });
  console.log('phase 6 air unit:', JSON.stringify(airUp));
  check(airUp.status === 'onScene' && airUp.view, `AIR-1 is on station over the scene (${airUp.status})`);
  await waitFrames(page, 4);
  const preFlir = await page.evaluate(() => ({ air: window.patrol.session.phase6.resources.airView() !== null, menu: window.patrol.ui.isMenuOpen(), paused: window.patrol.loop.paused, top: window.patrol.ui.top?.id ?? null }));
  console.log('phase 6 before FLIR:', JSON.stringify(preFlir));
  await press(page, 'Slash');
  await waitFrames(page, 6);
  const flir = await page.evaluate(() => ({
    on: window.patrol.phase6.flirOn,
    cls: window.patrol.renderer?.canvas.classList.contains('flir-on') ?? false,
    fov: window.patrol.renderer?.camera.fov ?? 0,
    hud: /FLIR/.test(document.querySelector('#hud')?.textContent ?? ''),
  }));
  console.log('phase 6 FLIR:', JSON.stringify(flir));
  check(flir.on && (!hasRenderer || flir.cls), `/ puts the camera on the air unit (FLIR on, canvas filter ${flir.cls}, fov ${flir.fov})`);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase6-flir.png') });
    console.log(`screenshot: ${path.join(SHOTS, 'phase6-flir.png')}`);
  }
  await press(page, 'Slash');
  const flirOff = await page.evaluate(() => ({ on: window.patrol.phase6.flirOn, fov: window.patrol.renderer?.camera.fov ?? 0, base: window.patrol.settings.get('graphics.fov') }));
  check(!flirOff.on && (!hasRenderer || Math.abs(flirOff.fov - flirOff.base) < 0.01), `/ again restores the normal camera (fov ${flirOff.fov})`);

  // --- A barricade: containment, the negotiator and SWAT ---------------------------------------------------------------------
  const bar = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const call = s.cad.unit(s.dispatcher.playerCallsign)?.callId;
    if (call) s.dispatcher.request(s.dispatcher.playerCallsign, { kind: 'clearCall', callId: call, disposition: 'handled' }, 'key');
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    app.teleport(s.city.spawn.x + 40, s.city.spawn.z + 20, 0);
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await app.console.execute('swat test');
    for (let i = 0; i < 60 * 20; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const id = s.cad.unit(s.dispatcher.playerCallsign)?.callId ?? 0;
    const door = s.scene.buildingOfCall(id) >= 0 ? s.buildings.building(s.scene.buildingOfCall(id))?.door : null;
    if (door) app.teleport(door.x, door.z + 8, 0);
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await app.console.execute('ics post');
    await app.console.execute('request negotiator');
    // The teams drive in from their bases: run until both are on scene (at most 15 minutes).
    const onScene = (cs) => s.phase6.resources.units().some((u) => u.callsign === cs && u.status === 'onScene');
    for (let i = 0; i < 60 * 900 && !(onScene('TAC-1') && onScene('NEG-1')); i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    for (let i = 0; i < 60 * 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return { id, phase: s.phase6.backup.swatPhase(id), units: s.phase6.resources.units().filter((u) => u.status === 'onScene').map((u) => u.callsign) };
  });
  console.log('phase 6 barricade:', JSON.stringify(bar));
  check(bar.phase !== null && bar.units.includes('TAC-1') && bar.units.includes('NEG-1'), `the negotiator and the SWAT team are on scene (${bar.units.join(', ')}; SWAT ${bar.phase})`);
  const neg = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    await app.console.execute('negotiate open');
    for (let i = 0; i < 60; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const view = s.phase6.command.negotiationView();
    const open = app.phase6.negotiation.isOpen;
    return { view: view !== null, topics: view?.topics.length ?? 0, open };
  });
  await waitFrames(page, 6);
  const negOpen = await page.evaluate(() => window.patrol.phase6.negotiation.isOpen);
  console.log('phase 6 negotiation:', JSON.stringify({ ...neg, negOpen }));
  check(neg.view && neg.topics > 0, `negotiation opens with the subject's topics (${neg.topics})`);
  check(negOpen, 'the negotiation dialogue panel is open');
  await press(page, 'Escape');
  const swat = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const phases = [];
    for (const cmd of ['stack', 'breach', 'clear']) {
      await app.console.execute(`swat ${cmd}`);
      for (let i = 0; i < 60 * 25; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
      const id = s.cad.unit(s.dispatcher.playerCallsign)?.callId ?? 0;
      phases.push(`${cmd}:${s.phase6.backup.swatPhase(id) ?? '-'}`);
    }
    return { phases, swatEvents: window.__p6.filter((x) => x.t === 'backup:swat').length };
  });
  console.log('phase 6 SWAT:', JSON.stringify(swat));
  check(swat.swatEvents > 0, `the SWAT team answers the commands (${swat.phases.join(', ')}; ${swat.swatEvents} reports)`);

  // --- A v8 save / load round trip ----------------------------------------------------------------------------------------------
  const save = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const before = {
      roster: s.roster.callsigns().length,
      stress: s.roster.dynamic('21')?.stress.toFixed(5),
      units: s.cad.units().filter((u) => u.kind === 'resource').length,
      post: s.phase6.command.post()?.callId ?? 0,
      victims: s.phase6.command.board().victims.length,
    };
    await app.saveGame('p6');
    const list = await app.saves.list();
    await app.loadGame('p6');
    const l = app.session;
    await new Promise((r) => setTimeout(r, 800));
    return {
      version: list.find((x) => x.slot === 'p6')?.version ?? 0,
      before,
      after: {
        roster: l.roster.callsigns().length,
        stress: l.roster.dynamic('21')?.stress.toFixed(5),
        units: l.cad.units().filter((u) => u.kind === 'resource').length,
        post: l.phase6.command.post()?.callId ?? 0,
        victims: l.phase6.command.board().victims.length,
      },
    };
  });
  console.log('phase 6 save/load:', JSON.stringify(save));
  check(save.version === 9, `the save is written as version 9 (${save.version})`);
  check(JSON.stringify(save.before) === JSON.stringify(save.after), 'the roster, resource units, command post and victims survive the load');

  // --- Console commands -------------------------------------------------------------------------------------------------------------
  const cmds = await page.evaluate(async () => {
    const c = window.patrol.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    for (const line of ['units', 'units roster', 'units ems', 'roster', 'roster 21', 'stress 21 0.4', 'eta K9-1', 'backup list', 'pursuit status', 'ics status', 'triage list', 'flir']) {
      out.push(`> ${line}`, ...(await run(line)));
    }
    return out;
  });
  console.log('phase 6 console commands:\n  ' + cmds.map((l) => l.slice(0, 160)).join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 6 console commands ran without errors');

  // --- Perf ------------------------------------------------------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    for (let i = 0; i < 60 * 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  const perf = await page.evaluate(perfSnapshot);
  const extras = await page.evaluate(() => {
    const out = {};
    for (const [name, ms] of window.patrol.systems.timings) if (['resources', 'pursuit', 'backup', 'command', 'dispatch', 'scene'].includes(name)) out[name] = Number(ms.toFixed(4));
    return { systems: out };
  });
  const frame = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
  console.log('perf phase 6:', JSON.stringify(perf));
  console.log('phase 6 sim costs:', JSON.stringify(extras));
  return { perf, frame, extras };
}

/**
 * Phase 7 checks (fleet, uniforms, customization): from the title screen "Create officer..." (they/them, body sliders) and
 * New game, the locker's Uniform & gear (tactical, ball cap), the armory's Sign out my loadout, the fleet panel (') checking
 * out S-201 and customizing its livery (a text decal, a polygon shape, the siren), the livery exported and imported again,
 * the motorcycle ridden, the helicopter climbed with Space, the camera drone (=), a crash with its damage report, the station
 * service, the inspection and End shift charging career points, a v9 save / load and the Phase 7 console commands.
 * Writes docs/screenshots/phase7-character.png, phase7-livery.png and phase7-heli.png. Returns the perf numbers.
 */
async function phase7(page, hasRenderer) {
  // --- Title screen: Create officer (they/them, body sliders), New game ------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.indoorScenes = true;
    if (app.inGame) app.quitToTitle();
  });
  await waitFor(page, () => document.querySelector('#seed') !== null, null, 10000);
  await page.getByRole('button', { name: /Create officer/ }).click();
  const creatorOpen = await waitFor(page, () => window.patrol.ui.top?.id === 'character-creator', null, 10000);
  check(creatorOpen, 'the title screen opens the character creator (Create officer)');
  const made = await page.evaluate(() => {
    const c = window.patrol.ui.top;
    c.dispatch({ kind: 'setText', field: 'firstName', value: 'Robin' });
    c.dispatch({ kind: 'setText', field: 'lastName', value: 'Vale' });
    c.dispatch({ kind: 'setText', field: 'badge', value: '5203' });
    c.dispatch({ kind: 'setPronounPreset', preset: 'they' });
    c.dispatch({ kind: 'setBody', field: 'heightM', value: 1.66 });
    c.dispatch({ kind: 'setBody', field: 'build', value: 1.12 });
    c.dispatch({ kind: 'setHairStyle', style: 'bun' });
    const ok = c.done();
    return { ok, chosen: window.patrol.mainMenu.character?.profile.lastName ?? '' };
  });
  check(made.ok && made.chosen === 'Vale', `the creator makes Robin Vale (they/them) and Done keeps the officer (${made.chosen})`);
  await page.fill('#seed', String(SEED));
  await page.getByRole('button', { name: 'New game' }).click();
  await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  const first = await page.evaluate(() => {
    const s = window.patrol.session;
    return { name: s.officer.name, badge: s.officer.badge, pronouns: s.character.pronouns.id, height: s.character.body.heightM, inStation: s.officerBuilding >= 0 };
  });
  console.log('phase 7 new game:', JSON.stringify(first));
  check(first.name === 'Officer Robin Vale' && first.badge === '5203' && first.pronouns === 'they' && first.height === 1.66, `New game starts as ${first.name} #${first.badge} (${first.pronouns}, ${first.height} m)`);
  check(first.inStation, 'the shift starts in the station locker room');

  // --- Locker: Uniform & gear (tactical, ball cap) ------------------------------------------------------------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    await app.console.execute('time 10:30');
    await app.console.execute('weather clear');
    app.panels.openLocker();
  });
  await waitFrames(page, 3);
  await press(page, 'Digit7'); // the locker's seventh row: Uniform & gear...
  const lockerCreator = await waitFor(page, () => window.patrol.ui.top?.id === 'character-creator', null, 10000);
  check(lockerCreator, 'the locker row "Uniform & gear" opens the character creator');
  await page.evaluate(() => {
    const c = window.patrol.ui.top;
    c.dispatch({ kind: 'tab', tab: 'uniform' });
    c.dispatch({ kind: 'setUniform', uniform: 'tactical' });
    c.dispatch({ kind: 'setHat', hat: 'ballCap' });
  });
  await waitFrames(page, 4);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase7-character.png') });
    console.log('screenshot: docs/screenshots/phase7-character.png');
  }
  const lockerDone = await page.evaluate(() => {
    const c = window.patrol.ui.top;
    const ok = c.done();
    const s = window.patrol.session;
    return { ok, uniform: s.character.outfit.uniform, hat: s.character.outfit.hat, outfits: s.phase7.outfits.defs.length };
  });
  check(lockerDone.ok && lockerDone.uniform === 'tactical' && lockerDone.hat === 'ballCap', `Done applies the tactical uniform with a ball cap (${lockerDone.uniform}, ${lockerDone.hat}; ${lockerDone.outfits} outfits in the table)`);

  // --- Armory: Sign out my loadout -------------------------------------------------------------------------------------------
  const armory = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    app.panels.openArmory();
    const items = s.gear.armoryItems();
    const model = s.station.armoryModel(items);
    const row = model.options.findIndex((o) => o.label === 'Sign out my loadout');
    app.panels.select('armory', row);
    for (let i = 0; i < 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return { row, items, out: s.station.armory.out().map((o) => (typeof o === 'string' ? o : (o.item ?? o.id))) };
  });
  console.log('phase 7 armory:', JSON.stringify(armory));
  check(armory.row >= 0 && armory.items.length > 0 && armory.items.every((i) => armory.out.includes(i)), `Sign out my loadout signs out ${armory.items.join(', ')}`);
  await page.evaluate(() => {
    const app = window.patrol;
    app.panels.close();
    const s = app.session;
    for (const step of ['locker', 'briefing', 'armory', 'garage']) s.station.request({ kind: 'complete', step });
    for (let i = 0; i < 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.teleport(s.city.spawn.x, s.city.spawn.z, s.city.spawn.yaw);
  });
  await sleep(500);

  // --- Fleet panel (') : check out S-201, customize its livery ------------------------------------------------------------
  await press(page, 'Quote');
  const garage = await page.evaluate(() => ({ kind: window.patrol.phase7.panelKind, text: document.querySelector('.panel-action')?.textContent ?? '' }));
  check(garage.kind === 'garage' && garage.text.includes('S-201') && garage.text.includes('M-601') && garage.text.includes('AIR-2'), `' opens the fleet panel with every unit (${garage.kind})`);
  const out = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const row = s.fleet.units().findIndex((u) => u.id === 'S-201');
    app.phase7.pick(row); // opens the unit's rows; Check out is the next one
    app.phase7.pick(row + 1);
    for (let i = 0; i < 5; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const v = s.unitVehicle('S-201');
    return { out: v !== null, model: v?.model.id ?? '' };
  });
  check(out.out && out.model === 'supervisor_suv', `the fleet panel checks out S-201 (${out.model})`);
  const customize = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const t = s.physics.getBody(s.unitVehicle('S-201').eid).translation();
    s.physics.getBody(s.player)?.setTranslation({ x: t.x - 4, y: 0.9, z: t.z }, true);
    for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    app.phase7.openGarage();
    const row = s.fleet.units().findIndex((u) => u.id === 'S-201');
    app.phase7.pick(row); // expand; the rows are Check out, Return, Customize, Service, Inspect
    app.phase7.pick(row + 3);
    return { editor: app.phase7.editorOpen, top: app.ui.top?.id ?? '' };
  });
  check(customize.editor && customize.top === 'livery-editor', `Customize opens the livery editor on the unit (${customize.top})`);
  const edited = await page.evaluate(() => {
    const ed = window.patrol.phase7.editor;
    const before = ed.state.doc.layers.length;
    ed.dispatch({ kind: 'addLayer', layer: 'text' });
    ed.dispatch({ kind: 'updateLayer', index: ed.state.selected, patch: { text: 'SUPERVISOR {unit}' } });
    ed.dispatch({ kind: 'addLayer', layer: 'shape' });
    ed.dispatch({ kind: 'updateLayer', index: ed.state.selected, patch: { shape: 'polygon', points: [[-0.8, 0.8], [0.8, 0.8], [0, -0.9]] } });
    ed.dispatch({ kind: 'setLights', patch: { siren: 'yelp' } });
    ed.dispatch({ kind: 'rename', name: 'Smoke supervisor' });
    return { before, after: ed.state.doc.layers.length, errors: ed.state.errors, canSave: ed.canSave, shape: ed.state.doc.layers.at(-1)?.shape };
  });
  console.log('phase 7 editor:', JSON.stringify(edited));
  check(edited.after === edited.before + 2 && edited.errors.length === 0 && edited.canSave && edited.shape === 'polygon', `the editor adds a text decal and a polygon shape without errors (${edited.before} -> ${edited.after} layers)`);
  await waitFrames(page, 8);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase7-livery.png') });
    console.log('screenshot: docs/screenshots/phase7-livery.png');
  }
  const saved = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const ed = app.phase7.editor;
    const text = ed.exportText();
    const ok = ed.save();
    for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const doc = s.fleet.livery('S-201');
    const eq = s.equipmentOf(s.unitVehicle('S-201'));
    return { ok, text, id: doc.id, layers: doc.layers.length, tone: eq?.tone, name: doc.name, library: s.fleet.library().length };
  });
  check(saved.ok && saved.layers >= 3 && saved.tone === 'yelp' && saved.name === 'Smoke supervisor', `Save stores the livery in the library and applies it (${saved.id}, ${saved.layers} layers, ${saved.tone})`);
  const imported = await page.evaluate(async (text) => {
    const app = window.patrol;
    const s = app.session;
    const c = app.console;
    const before = c.lines.length;
    await c.execute(`livery import '${text.replace(/'/g, '')}' U-301`);
    const lines = c.lines.slice(before).map((l) => l.text);
    return { lines, layers: s.fleet.livery('U-301').layers.length, name: s.fleet.livery('U-301').name };
  }, saved.text);
  check(imported.name === 'Smoke supervisor' && imported.layers >= 3, `the exported JSON imports again onto U-301 (${imported.lines.join(' / ').slice(0, 100)})`);
  const bad = await page.evaluate(async () => {
    const c = window.patrol.console;
    const before = c.lines.length;
    await c.execute(`livery import '{"format":"nope"}'`);
    return c.lines.slice(before).map((l) => l.text).join(' | ');
  });
  check(/Rejected/.test(bad), `a malformed livery file is rejected with errors (${bad.slice(0, 80)})`);

  // --- The motorcycle: check out and ride (the rider shows) -------------------------------------------------------------
  const bike = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    await app.console.execute('fleet checkout M-601');
    const v = s.unitVehicle('M-601');
    const t = s.physics.getBody(v.eid).translation();
    s.physics.getBody(s.player)?.setTranslation({ x: t.x - 1.5, y: 0.9, z: t.z }, true);
    for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const entered = app.enterVehicle(s.vehicles.indexOf(v));
    s.driverInput.accelerate = 1;
    for (let i = 0; i < 150; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const speed = v.telemetry.speed;
    s.driverInput.accelerate = 0;
    s.driverInput.brake = 1;
    for (let i = 0; i < 240; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.brake = 0;
    return { entered, speed, lean: Math.abs(v.telemetry.lean), upright: v.telemetry.lean < 1 };
  });
  console.log('phase 7 motorcycle:', JSON.stringify(bike));
  check(bike.entered && bike.speed > 8 && bike.upright, `M-601 is checked out and ridden (${bike.speed.toFixed(1)} m/s, lean ${bike.lean.toFixed(2)})`);
  await waitFrames(page, 4);
  const rider = await page.evaluate(() => {
    const f = window.patrol.presenter.officerFigure;
    return { anchor: f.anchor[0], eid: window.patrol.session.drivenVehicle?.eid ?? 0, flags: f.flags[0] };
  });
  check(rider.anchor === rider.eid && rider.anchor > 0 && (rider.flags & 2) === 0, 'the officer shows as the motorcycle rider (figure anchored to the bike)');
  await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    app.input.update();
    s.exitVehicle();
    s.checkIn('M-601');
  });

  // --- The helicopter: Space climbs ---------------------------------------------------------------------------------------
  const heli = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const v = s.unitVehicle('AIR-2');
    const t = s.physics.getBody(v.eid).translation();
    s.physics.getBody(s.player)?.setTranslation({ x: t.x - 3, y: 0.9, z: t.z }, true);
    for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return { entered: app.enterVehicle(s.vehicles.indexOf(v)), parkedEngine: false };
  });
  check(heli.entered, 'the officer boards AIR-2 on the helipad');
  await page.keyboard.down('Space');
  await waitFrames(page, 6);
  const lift = await page.evaluate(() => window.patrol.session.driverInput.lift ?? 0);
  await page.keyboard.up('Space');
  check(lift > 0.5, `Space is the climb control in the helicopter (lift ${lift})`);
  const climb = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const v = s.drivenVehicle;
    s.driverInput.lift = 1;
    for (let i = 0; i < 300; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const alt = v.telemetry.altitudeM;
    const exit = s.exitVehicle();
    return { alt, exit };
  });
  await waitFrames(page, 4);
  console.log('phase 7 helicopter:', JSON.stringify(climb));
  check(climb.alt > 5 && climb.exit === 'exitBlocked', `AIR-2 climbs (${climb.alt.toFixed(1)} m) and the officer cannot leave it in the air`);
  if (hasRenderer) {
    await page.screenshot({ path: path.join(SHOTS, 'phase7-heli.png') });
    console.log('screenshot: docs/screenshots/phase7-heli.png');
  }
  const landed = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const v = s.drivenVehicle;
    // A gentle descent: a hard landing damages the helicopter (a fleet incident of its own).
    s.driverInput.lift = -0.25;
    for (let i = 0; i < 4000 && v.telemetry.altitudeM > 0.3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.lift = 0;
    for (let i = 0; i < 90; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return { alt: v.telemetry.altitudeM, exit: s.exitVehicle() };
  });
  check(landed.alt < 0.5 && landed.exit === 'exited', `landed, the officer gets out (${landed.alt.toFixed(2)} m, ${landed.exit})`);

  // --- The camera drone: = deploys from S-201's trunk, = recalls ---------------------------------------------------------
  await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    // Checking out M-601 earlier stored S-201 (it stood at the garage exit); it comes back with its saved livery.
    if (!s.unitVehicle('S-201')) await app.console.execute('fleet checkout S-201');
    const v = s.unitVehicle('S-201');
    const t = s.physics.getBody(v.eid).translation();
    s.physics.getBody(s.player)?.setTranslation({ x: t.x - 4, y: 0.9, z: t.z }, true);
    for (let i = 0; i < 3; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  await press(page, 'Equal');
  const up = await page.evaluate(() => {
    const s = window.patrol.session;
    return { remote: s.remote, mode: s.modes.mode, model: s.droneVehicle?.model.id ?? '' };
  });
  check(up.remote && up.model === 'police_drone', `= launches the camera drone from the trunk (${up.model})`);
  const flown = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const d = s.droneVehicle;
    const at0 = s.physics.getBody(d.eid).translation();
    s.driverInput.accelerate = 1;
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.accelerate = 0;
    const at1 = s.physics.getBody(d.eid).translation();
    return { moved: Math.hypot(at1.x - at0.x, at1.z - at0.z), battery: d.telemetry.fuelFraction };
  });
  check(flown.moved > 3 && flown.battery < 1 && flown.battery > 0.9, `the drone flies on the driver input (${flown.moved.toFixed(1)} m, battery ${(flown.battery * 100).toFixed(0)} %)`);
  await press(page, 'Equal');
  const down = await page.evaluate(() => {
    const s = window.patrol.session;
    return { remote: s.remote, droneOut: s.unitVehicle('D-1') !== null, kit: s.officerKit.carried('drone') };
  });
  check(!down.remote && !down.droneOut && down.kit === 1, '= recalls the drone: the item is back in the officer kit');

  // --- A crash with its damage report, service, inspection and End shift ---------------------------------------------------
  const crash = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const car = s.unitVehicle('P-101');
    const tw = s.buildings.station();
    app.enterVehicle(s.vehicles.indexOf(car));
    s.teleport((tw.minX + tw.maxX) / 2, tw.minZ - 30, Math.PI);
    for (let i = 0; i < 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.accelerate = 1;
    for (let i = 0; i < 360; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.accelerate = 0;
    s.driverInput.brake = 1;
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.driverInput.brake = 0;
    for (let i = 0; i < 600; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const incidents = s.fleet.incidents().filter((i) => i.unitId === 'P-101');
    return { n: incidents.length, unit: incidents[0]?.unitId ?? '', closed: incidents[0]?.closed ?? false, cost: incidents[0]?.cost ?? 0, damaged: car.needsRepair, open: s.fleet.openReports() };
  });
  console.log('phase 7 crash:', JSON.stringify(crash));
  check(crash.n > 0 && crash.unit === 'P-101' && crash.closed && crash.open > 0, `the crash is a damage incident of P-101 ($${crash.cost}, ${crash.open} unreported)`);
  await waitFrames(page, 8);
  const chip = await page.evaluate(() => document.querySelector('.hud')?.textContent ?? document.body.textContent ?? '');
  check(chip.includes('damage report due'), 'the HUD fleet chip says a damage report is due');
  const flow = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const points0 = s.conduct.career.points;
    const id = s.fleet.incidents().find((i) => i.unitId === 'P-101').id;
    await app.console.execute(`fleet report ${id}`);
    // Service happens in the yard only: the wreck is refused where it stands, then driven back to the garage exit.
    const wasInYard = s.unitInYard('P-101');
    await app.console.execute('fleet service all P-101');
    const refused = wasInYard || s.fleet.ledger.departmentCost === 0;
    s.teleport(s.yard.garage.x, s.yard.garage.z, 0);
    for (let i = 0; i < 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await app.console.execute('fleet service all P-101');
    const input = s.inspectionInput('P-101');
    s.fleet.request({ kind: 'inspect', unitId: 'P-101', input });
    for (let i = 0; i < 5; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const inspected = s.fleet.lastInspection();
    await app.console.execute('fleet endshift');
    for (let i = 0; i < 5; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return {
      report: s.fleet.reports()[0]?.text ?? '',
      serviced: !s.unitVehicle('P-101').needsRepair,
      refused,
      inYard: s.unitInYard('P-101'),
      cost: s.fleet.ledger.departmentCost,
      rows: inspected?.rows.length ?? 0,
      points0,
      points1: s.conduct.career.points,
      summary: app.phase7.panelKind,
    };
  });
  console.log('phase 7 shift end:', JSON.stringify({ ...flow, report: flow.report.slice(0, 80) }));
  check(flow.report.includes('Robin Vale') && flow.report.includes('they/them'), 'the damage report names the officer with their pronouns');
  check(flow.refused && flow.inYard, 'a wreck outside the yard is not serviced; back in the yard it can be');
  check(flow.serviced && flow.cost > 0, `the station service repairs P-101 and the department ledger records $${flow.cost}`);
  check(flow.rows >= 8, `the inspection checklist runs (${flow.rows} checks)`);
  check(flow.points1 <= flow.points0 && flow.summary === 'summary', `End shift applies the career charge (${flow.points0} -> ${flow.points1}) and opens the shift summary`);
  await page.evaluate(() => {
    window.patrol.phase7.panel.close();
    // Phase 8: End shift also opened the career summary (a pausing screen); this run goes on with the same shift.
    window.patrol.phase8.summary.close();
  });

  // --- A v9 save / load round trip ---------------------------------------------------------------------------------------------
  const save = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const snap = (x) => ({
      name: x.officer.name,
      uniform: x.character.outfit.uniform,
      livery: x.fleet.livery('S-201').name,
      layers: x.fleet.livery('S-201').layers.length,
      library: x.fleet.library().length,
      units: x.fleet.units().filter((u) => u.spawned).map((u) => u.id).join(','),
      gear: x.gear.loadout.items.length,
      ledger: x.fleet.ledger.entries().length,
      points: x.conduct.career.points,
    });
    const before = snap(s);
    await app.saveGame('p7');
    const list = await app.saves.list();
    await app.loadGame('p7');
    await new Promise((r) => setTimeout(r, 800));
    return { version: list.find((x) => x.slot === 'p7')?.version ?? 0, before, after: snap(app.session) };
  });
  console.log('phase 7 save/load:', JSON.stringify(save));
  check(save.version === 9, `the save is written as version 9 (${save.version})`);
  check(JSON.stringify(save.before) === JSON.stringify(save.after), 'the character, gear, saved liveries, checked-out units and ledger survive the load');

  // --- Console commands ---------------------------------------------------------------------------------------------------------
  const cmds = await page.evaluate(async () => {
    const c = window.patrol.console;
    const run = async (line) => {
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    for (const line of ['fleet list', 'fleet spawn motor', 'fleet ledger', 'livery list', 'livery export patrolMarked', 'gear show', 'loadout show', 'gear validate', 'gear retention 3', 'uniform motor motorHelmet', 'char show', 'char pronouns she', 'wear oil 0.2', 'hit 20', 'fleet checkin M-601']) {
      out.push(`> ${line}`, ...(await run(line)));
    }
    return out;
  });
  console.log('phase 7 console commands:\n  ' + cmds.map((l) => l.slice(0, 160)).join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 7 console commands ran without errors');

  // --- Perf -----------------------------------------------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    for (let i = 0; i < 60 * 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  const perf = await page.evaluate(perfSnapshot);
  const extras = await page.evaluate(() => {
    const out = {};
    for (const [name, ms] of window.patrol.systems.timings) if (['fleet', 'vehicles.pre', 'vehicles.post', 'force', 'conduct'].includes(name)) out[name] = Number(ms.toFixed(4));
    const l = window.patrol.phase7.liveries?.stats;
    return { systems: out, liveries: l ? { ...l } : null, gearBoxes: window.patrol.presenter.renderer?.stats.gearBoxes ?? 0 };
  });
  const frame = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
  console.log('perf phase 7:', JSON.stringify(perf));
  console.log('phase 7 sim costs:', JSON.stringify(extras));
  return { perf, frame, extras };
}


/** Starts `node server/main.ts` on a free port; resolves { child, port }. */
async function startCoopServer() {
  const child = spawn('node', ['server/main.ts'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATROL_SERVER_PORT: '0' } });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the co-op server did not report its port')), 15000);
    child.stdout.on('data', (d) => {
      const m = String(d).match(/ws:\/\/[^:]+:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code) => reject(new Error(`the co-op server exited with ${code}`)));
  });
  return { child, port };
}

/** Runs a console line in the page and returns its output lines. */
async function consoleRun(page, line) {
  return page.evaluate(async (l) => {
    const c = window.patrol.console;
    const before = c.lines.length;
    await c.execute(l);
    return c.lines.slice(before).map((x) => `${x.kind}: ${x.text}`);
  }, line);
}

/**
 * Phase 8 checks (career, persistent world, modes, mods, accessibility, co-op): New career from the title screen and the
 * academy (a quiz and a defensive drill answered with the real keys, the range, a report exercise), the driving course,
 * graduation, End shift -> summary -> apartment -> Report for duty -> the next shift with premise history, dispatch-only
 * with the friday-night script, the scenario editor, the mod manager with the example mod, colour vision and the left-hand
 * layout, co-op against a local server (two pages: patrol and dispatcher), a v10 save/load and the Phase 8 console commands.
 */
async function phase8(page, hasRenderer, browser, watch) {
  await mkdir(SHOTS, { recursive: true });

  // --- Title screen sections and New career ---------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.quitToTitle();
    app.settings.set('accessibility.colorblind', 'none');
  });
  await waitFrames(page, 3);
  const title = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
  console.log('title buttons:', JSON.stringify(title));
  check(['New career', 'New game', 'Academy drills', 'Report writing', 'Driving academy', 'Dispatch-only', 'Scenario editor', 'Co-op lobby…', 'Manage mods…'].every((b) => title.includes(b)), 'the title screen offers career, training, multiplayer and mods');
  await page.fill('#seed', String(SEED));
  await page.getByRole('button', { name: 'New career' }).click();
  await waitFor(page, () => window.patrol.session?.phase8.modeId === 'career' && window.patrol.phase8.academy.isOpen, null, 90000);
  await waitFor(page, () => (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  const academy = await page.evaluate(() => {
    const app = window.patrol;
    const v = app.session.phase8.career.view;
    return { stage: v.stage, open: app.phase8.academy.isOpen, ui: app.ui.menuStack.map((m) => m.id), rows: app.phase8.academy.model.rows.map((r) => r.module), paused: app.loop.paused };
  });
  console.log('academy:', JSON.stringify(academy));
  check(academy.stage === 'academy' && academy.open && academy.rows.length === 5 && academy.paused, 'New career starts in the academy hub with five modules (the game is paused)');
  await waitFrames(page, 3);
  await page.screenshot({ path: path.join(SHOTS, 'phase8-academy.png') });

  // The legal quiz, answered with the real keys.
  const quiz = await page.evaluate(() => {
    const screen = window.patrol.phase8.academy.launch('legal');
    return { total: screen?.state.total ?? 0, id: screen?.id ?? null };
  });
  check(quiz.id === 'legal-quiz' && quiz.total > 0, `the legal quiz opens (${quiz.total} questions)`);
  for (let i = 0; i < quiz.total * 2 + 4; i++) {
    const done = await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.state.done ?? true);
    if (done) break;
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
  }
  const quizDone = await page.evaluate(() => ({ done: window.patrol.phase8.academy.activeScreen?.state.done ?? null, best: window.patrol.session.phase8.career.view.academy.legal }));
  console.log('quiz:', JSON.stringify(quizDone));
  check(quizDone.done === true && quizDone.best.attempts === 1 && quizDone.best.best >= 0, `the quiz result is recorded in the career (${quizDone.best.best})`);
  await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.close());

  // The defensive-tactics drill.
  const defensive = await page.evaluate(() => {
    const screen = window.patrol.phase8.academy.launch('defensive');
    return { total: screen?.state.total ?? 0 };
  });
  for (let i = 0; i < defensive.total * 2 + 4; i++) {
    const done = await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.state.drill === null);
    if (done) break;
    await page.keyboard.press('1');
    await page.keyboard.press('Enter');
  }
  const defRec = await page.evaluate(() => window.patrol.session.phase8.career.view.academy.defensive);
  console.log('defensive:', JSON.stringify(defRec));
  check(defRec.attempts === 1, `the defensive drill is recorded (${defRec.best})`);
  await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.close());

  // The firearms range: scripted shots at the visible targets.
  const range = await page.evaluate(() => {
    const screen = window.patrol.phase8.academy.launch('firearms');
    const run = screen.state;
    run.start();
    let shots = 0;
    for (let i = 0; i < 4000 && run.phase !== 'done'; i++) {
      screen.advance(0.05);
      const t = run.visible([])[0];
      if (t && i % 6 === 0) {
        run.movePointer(t.x, t.y);
        if (run.fire()) shots++;
      }
    }
    screen.advance(0.05);
    return { shots, score: run.result()?.score ?? -1, rec: window.patrol.session.phase8.career.view.academy.firearms };
  });
  console.log('range:', JSON.stringify(range));
  check(range.shots > 0 && range.score >= 0 && range.rec.attempts === 1, `the range runs with scripted shots (${range.shots} shots, score ${range.score}) and the score is recorded`);
  await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.close());

  // A report-writing exercise.
  const report = await page.evaluate(() => {
    const screen = window.patrol.phase8.academy.launch('report');
    for (const st of screen.state.statements().slice(0, 3)) screen.toggle(st.id);
    const fb = screen.submit();
    return { feedback: !!fb, rec: window.patrol.session.phase8.career.view.academy.report };
  });
  check(report.feedback && report.rec.attempts === 1, `the report exercise grades a report and records it (${report.rec.best})`);
  await page.evaluate(() => window.patrol.phase8.academy.activeScreen?.close());

  // --- The driving course: the car is placed, the cones are drawn, scripted driving along the axis -------------------------------
  const course = await page.evaluate(async () => {
    const app = window.patrol;
    app.phase8.academy.close();
    await app.console.execute('course start basic');
    const s = app.session;
    const m = s.phase8.mode;
    return { driving: s.driving, courseId: m.courseId, hasAnchor: m.anchor !== null, length: m.anchor?.length ?? 0, cones: app.phase8.cones?.count ?? -1 };
  });
  console.log('course start:', JSON.stringify(course));
  check(course.driving && course.courseId === 'basic' && course.hasAnchor && course.length >= 320, `the driving course starts on a straight road of ${Math.round(course.length)} m with the officer seated`);
  if (hasRenderer) check(course.cones > 0, `the cones are drawn (${course.cones})`);
  const drive = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    const run = () => s.phase8.mode.course;
    // Throttle along the axis; the car starts facing it.
    for (let i = 0; i < 60 * 90 && run() && !run().done && !run().aborted; i++) {
      s.driverInput.accelerate = 0.6;
      app.loop.hooks.fixedUpdate(1 / 60, 0);
    }
    s.driverInput.accelerate = 0;
    const r = run()?.done || run()?.aborted ? run().result() : null;
    // The frame loop turns the finished run into a result (the score goes to the academy in a career).
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { result: r, left: s.phase8.mode.course === null, academy: s.phase8.career.view.academy.driving };
  });
  console.log('course run:', JSON.stringify(drive));
  check(drive.left && drive.academy.attempts >= 1, `the course score reaches the academy record (${JSON.stringify(drive.academy)})`);
  await page.evaluate(() => window.patrol.phase8.academy.close());

  // --- Graduation ----------------------------------------------------------------------------------------------------------
  await consoleRun(page, 'career academy * 100');
  const grad = await page.evaluate(() => {
    const app = window.patrol;
    const can = app.phase8.academy.graduate();
    return { can, stage: app.session.phase8.career.view.stage, shift: app.session.phase8.career.view.shift };
  });
  console.log('graduation:', JSON.stringify(grad));
  check(grad.stage === 'probation' && grad.shift.onDuty && grad.shift.shiftNo === 1, 'graduating starts probation with the first shift');
  await page.evaluate(() => window.patrol.ui.closeAll());

  // --- A shift: premise history, then End shift -> summary -> apartment -> Report for duty --------------------------------------
  const prep = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    for (let i = 0; i < 60 * 20; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    // A closed call at an address becomes premise history; the officer's chip shows wellbeing numbers after a long shift.
    const call = s.dispatcher.createCall('noiseComplaint', s.now());
    for (let i = 0; i < 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    s.cad.closeCall(call.id, 'handled', s.now());
    for (let i = 0; i < 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    return { text: call.location.text, history: s.phase8.world.premiseHistory(call.location.text).length };
  });
  check(prep.history === 1, `a closed call becomes premise history (${prep.text})`);
  const ended = await page.evaluate(async () => {
    const app = window.patrol;
    await app.console.execute('fleet endshift');
    for (let i = 0; i < 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await new Promise((r) => setTimeout(r, 500));
    return { ui: app.ui.menuStack.map((m) => m.id), off: app.session.phase8.career.view.offDuty !== null, calls: app.session.phase8.career.view.stats.calls };
  });
  console.log('end shift:', JSON.stringify(ended));
  check(ended.ui.includes('shift-summary') && ended.off, 'End shift opens the career summary and the off-duty period');
  await page.getByRole('button', { name: 'Continue' }).click();
  await waitFor(page, () => window.patrol.phase8.apartment.isOpen, null, 5000);
  const plan = await page.evaluate(() => {
    const c = window.patrol.session.phase8.career;
    return [c.planActivity('rest', 5).ok, c.planActivity('family', 2).ok];
  });
  check(plan[0] && plan[1], 'the apartment accepts rest and family time');
  await waitFrames(page, 3);
  await page.screenshot({ path: path.join(SHOTS, 'phase8-apartment.png') });
  await page.getByRole('button', { name: 'Report for duty' }).click();
  await waitFor(page, () => window.patrol.session?.phase8.career.view.shift.shiftNo === 2 && window.patrol.session.station.flow.step === 'locker', null, 60000);
  await waitFor(page, () => (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 60000);
  const next = await page.evaluate(() => {
    const app = window.patrol;
    const s = app.session;
    const v = s.phase8.career.view;
    // A new call at the remembered address: the MDT call tab shows the premise history.
    const mdt = app.mdt;
    const old = s.phase8.world.serialize().premises[0];
    const call = s.dispatcher.createScriptedCall({ typeId: 'noiseComplaint', x: old.x, z: old.z }, s.now());
    for (let i = 0; i < 20; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    mdt.open('call');
    mdt.selectCall(call.id);
    return { shift: v.shift.shiftNo, onDuty: v.shift.onDuty, game: s.now().game, start: v.shift.startGame, premises: s.phase8.world.serialize().premises.length, history: s.phase8.world.premiseHistory(call.location.text).length, flow: s.station.flow.step };
  });
  await waitFrames(page, 6);
  next.shown = await page.evaluate(() => window.patrol.mdt.premiseModelShown?.entries.length ?? -1);
  console.log('next shift:', JSON.stringify(next));
  check(next.shift === 2 && next.onDuty && next.game >= next.start, `Report for duty starts shift 2 at the new shift time (${next.game - next.start} s in)`);
  check(next.premises >= 1 && next.history >= 1 && next.shown >= 1, `premise history survived the rollover and shows in the MDT (${next.shown} entries)`);
  await page.evaluate(() => window.patrol.mdt.close());

  // --- Dispatch-only with the friday-night script --------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.mainMenu.seed = '42';
    app.startTraining('dispatchOnly', 'friday-night');
  });
  await waitFor(page, () => window.patrol.session?.phase8.modeId === 'dispatchOnly' && window.patrol.phase8.console?.isOpen, null, 90000);
  const dispatch = await page.evaluate(async () => {
    const app = window.patrol;
    const s = app.session;
    for (let i = 0; i < 60 * 200; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const port = app.phase8.console;
    const open = s.cad.openCalls().filter((c) => c.units.length === 0);
    const units = s.cad.units().filter((u) => u.kind === 'ai' && u.status === 'available');
    let assigned = 0;
    // Two manual assignments through the console's own buttons (the keyboard shortcut A assigns the first suggestion).
    for (let i = 0; i < Math.min(2, open.length, units.length); i++) {
      app.phase8.console.model.sel = { callId: open[i].id, unit: null };
      assigned += s.dispatcher.assignUnit(units[i].callsign, open[i].id, s.now()) ? 1 : 0;
    }
    for (let i = 0; i < 60 * 30; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    await new Promise((r) => setTimeout(r, 400));
    return { mode: s.phase8.modeId, console: port?.isOpen ?? false, open: open.length, assigned, script: s.phase8.mode.script?.script.id, scored: s.phase8.mode.dispatch?.serialize().calls.length ?? 0, manual: s.cad.units().filter((u) => u.kind === 'ai' && u.callId !== null).length };
  });
  console.log('dispatch-only:', JSON.stringify(dispatch));
  check(dispatch.mode === 'dispatchOnly' && dispatch.console && dispatch.script === 'friday-night' && dispatch.open >= 2, `dispatch-only runs the friday-night script with the console open (${dispatch.open} calls waiting)`);
  check(dispatch.assigned === 2 && dispatch.manual >= 2 && dispatch.scored >= 2, `two manual assignments sent AI units (${dispatch.manual} busy) and the calls are scored (${dispatch.scored})`);
  await waitFrames(page, 4);
  await page.screenshot({ path: path.join(SHOTS, 'phase8-dispatch.png') });

  // --- Scenario editor: place, export, run -----------------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.mainMenu.seed = '42';
    app.startTraining('sandbox');
  });
  await waitFor(page, () => window.patrol.session?.phase8.modeId === 'sandbox' && window.patrol.phase8.editor?.dirty !== undefined, null, 90000);
  const editor = await page.evaluate(async () => {
    const app = window.patrol;
    const ed = app.phase8.editor;
    const a = ed.state.doc.anchor;
    ed.setTool('npc');
    ed.state.place('npc', a.x + 6, a.z + 4, { profile: 'suspectNervous', role: 'suspect' });
    ed.state.place('npc', a.x - 6, a.z + 4, { profile: 'witnessReluctant', role: 'witness' });
    ed.state.place('vehicle', a.x + 12, a.z, { modelId: 'compact' });
    ed.state.place('evidence', a.x + 3, a.z + 2, { item: 'knife' });
    ed.state.setCall('disturbance', 3);
    const doc = ed.state.doc;
    const exported = ed.state.exportJson();
    const errors = ed.state.validate();
    const vehiclesBefore = app.session.vehicles.length;
    ed.run();
    await new Promise((r) => setTimeout(r, 600));
    for (let i = 0; i < 120; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
    const s = app.session;
    return { errors, npcs: doc.npcs.length, exported: exported.includes('patrol-scenario'), vehicles: s.vehicles.length - vehiclesBefore, calls: s.cad.openCalls().length, scenario: s.phase8.mode.scenario?.id ?? null, closed: !ed.isOpen };
  });
  console.log('editor:', JSON.stringify(editor));
  check(editor.errors.length === 0 && editor.npcs === 2 && editor.exported, 'the scenario editor places two NPCs, a vehicle and evidence, validates the scenario and exports it as JSON');
  check(editor.vehicles === 1 && editor.calls >= 1 && editor.scenario !== null && editor.closed, 'Run spawns the vehicle and the call into the world and stores the scenario in the mode');

  // --- Mod manager with the example mod -----------------------------------------------------------------------------------------
  await page.evaluate(() => window.patrol.quitToTitle());
  await waitFrames(page, 3);
  const mods = await page.evaluate(async () => {
    const app = window.patrol;
    const text = await (await fetch('/examples/mods/night-shift-pack.json')).text();
    const file = new File([text], 'night-shift-pack.json', { type: 'application/json' });
    const manager = app.phase8.modManager;
    await manager.open();
    const results = await manager.install([file], 'files');
    manager.setEnabled('night-shift-pack', true);
    return { results: results.map((r) => ({ ok: r.ok, id: r.id, errors: r.errors })), rows: manager.rows.map((r) => ({ id: r.id, enabled: r.enabled })), messages: [...manager.messages] };
  });
  console.log('mods:', JSON.stringify(mods));
  check(mods.results.length === 1 && mods.results[0].ok, 'the example mod validates and installs');
  check(mods.rows.some((r) => r.id === 'night-shift-pack' && r.enabled), 'the mod is enabled in the manager');
  await waitFrames(page, 3);
  await page.screenshot({ path: path.join(SHOTS, 'phase8-mods.png') });
  // Apply: store the enabled list as "Save & reload" does, then reload (mods apply at page load).
  await page.evaluate(async () => {
    const { ModStore } = await import('/src/mods/store.ts');
    await new ModStore().setEnabled(['night-shift-pack']);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });
  const modActive = await page.evaluate(async () => {
    const app = window.patrol;
    app.newGame(42);
    await new Promise((r) => setTimeout(r, 500));
    const out = [];
    const c = app.console;
    const before = c.lines.length;
    await c.execute('mods list');
    await c.execute('fleet list');
    for (const l of c.lines.slice(before)) out.push(l.text);
    const { modOverlay } = await import('/src/mods/registry.ts');
    return { refs: modOverlay().refs.map((r) => r.id), boot: app.boot.active.map((r) => r.id), lines: out.slice(0, 40) };
  });
  console.log('mod active:', JSON.stringify({ refs: modActive.refs, boot: modActive.boot }));
  check(modActive.refs.includes('night-shift-pack') && modActive.boot.includes('night-shift-pack'), 'after the reload the mod is applied at page load (boot + overlay)');
  check(modActive.lines.some((l) => l.includes('night-shift-pack')), 'mods list names the active mod');
  const modCar = await page.evaluate(async () => {
    const app = window.patrol;
    await app.console.execute('car spawn night_courier');
    return app.session.vehicles.some((v) => v.model.id === 'night_courier');
  });
  check(modCar, 'the mod vehicle spawns with the car command');
  // Disable the mod again so the rest of the run (and later runs) use the base game.
  await page.evaluate(async () => {
    const { ModStore } = await import('/src/mods/store.ts');
    await new ModStore().setEnabled([]);
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });

  // --- Colour vision and the left-hand layout -----------------------------------------------------------------------------------
  const access = await page.evaluate(async () => {
    const app = window.patrol;
    app.settings.set('accessibility.colorblind', 'protanopia');
    app.settings.set('accessibility.oneHanded', 'left');
    const { paletteMode, semanticColor } = await import('/src/a11y/index.ts');
    const root = document.documentElement;
    return { mode: paletteMode(), attr: root.dataset.colorblind ?? '', emergency: semanticColor('emergency'), hand: app.settings.get('accessibility.oneHanded') };
  });
  console.log('accessibility:', JSON.stringify(access));
  check(access.mode === 'protanopia' && access.attr === 'protanopia', `protanopia switches the palette and the CSS (${access.emergency})`);
  check(access.hand === 'left', 'the left-hand layout setting is stored');
  const layout = await page.evaluate(async () => {
    const { layoutBindings } = await import('/src/a11y/index.ts');
    const b = layoutBindings('left');
    const { ACTION_IDS } = await import('/src/input/actions.ts');
    return { count: Object.keys(b).length, actions: ACTION_IDS.length, career: b['career.menu'], coop: b['coop.menu'], dispatch: b['dispatch.console'] };
  });
  check(layout.count >= layout.actions && layout.career && layout.coop && layout.dispatch, `the left-hand layout binds every action including the three new ones (${layout.count}/${layout.actions})`);
  await page.evaluate(() => {
    const app = window.patrol;
    app.settings.set('accessibility.colorblind', 'none');
    app.settings.set('accessibility.oneHanded', 'off');
  });

  // --- Co-op against a local server: a patrol page and a dispatcher page ---------------------------------------------------------
  const { child, port } = await startCoopServer();
  const page2 = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  watch(page2, 'dispatcher');
  try {
    await page2.goto(URL_BASE, { waitUntil: 'load' });
    await page2.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });
    const join = async (p, role, name) => {
      await p.evaluate(({ port: pt, role: r, name: n }) => {
        const app = window.patrol;
        app.phase8.lobby.open();
        app.phase8.lobby.setForm({ url: `ws://127.0.0.1:${pt}`, room: 'smoke', name: n, role: r });
        app.phase8.lobby.connect();
      }, { port, role, name });
      await p.waitForFunction(() => window.patrol.phase8.lobbyClient?.state === 'joined', null, { timeout: 15000 });
    };
    await join(page, 'patrol', 'Alex');
    await join(page2, 'dispatcher', 'Dana');
    await Promise.all([page, page2].map((p) => p.evaluate(() => window.patrol.phase8.lobby.start())));
    await Promise.all([page, page2].map((p) => p.waitForFunction(() => window.patrol.phase8.coop !== null && window.patrol.session !== null, null, { timeout: 90000 })));
    const roles = await Promise.all([page, page2].map((p) => p.evaluate(() => ({ self: window.patrol.phase8.coop.self, role: window.patrol.phase8.coop.role, members: window.patrol.phase8.coop.units.size, console: window.patrol.phase8.console?.isOpen ?? false, mode: window.patrol.session.phase8.modeId }))));
    console.log('coop joined:', JSON.stringify(roles));
    check(roles[0].self === 'N1' && roles[1].self === 'DISPATCH' && roles[0].members === 2 && roles[1].members === 2, 'two pages join one room as N1 and the dispatcher');
    check(roles[1].console && !roles[0].console && roles[0].mode === 'coop', 'the dispatcher page opens the console with the net port');
    // The dispatcher creates a call; the patrol client sees it in its MDT queue and in its CAD.
    await page2.evaluate(() => {
      window.patrol.phase8.coop.send({ t: 'callCreate', ref: 'smoke1', typeId: 'noiseComplaint', label: 'Noise complaint', priority: 3, x: 120, z: 80, address: '100 Smoke Street', narrative: 'Loud music reported', origin: 'dispatcher' });
    });
    await page.waitForFunction(() => window.patrol.session.cad.openCalls().length >= 1, null, { timeout: 90000 });
    const callId = await page2.evaluate(() => [...window.patrol.phase8.coop.calls.keys()][0]);
    await page2.evaluate((id) => window.patrol.phase8.coop.send({ t: 'callAssign', callId: id, unit: 'N1' }), callId);
    await page.waitForFunction(() => [...window.patrol.phase8.coop.calls.values()].some((c) => c.units.includes('N1')), null, { timeout: 90000 });
    const shared = await page.evaluate(() => {
      const app = window.patrol;
      const call = app.session.cad.openCalls()[0];
      app.mdt.open('queue');
      const rows = app.mdt.queueRows ? app.mdt.queueRows.length : -1;
      app.mdt.close();
      return { type: call?.typeId, address: call?.location.text, net: [...app.phase8.coop.calls.values()].map((c) => [c.status, c.units.join(',')]), rows };
    });
    console.log('coop shared CAD:', JSON.stringify(shared));
    check(shared.type === 'noiseComplaint' && shared.net[0][1] === 'N1', 'the patrol client sees the dispatcher call and its assignment in the shared CAD');
    // An illegal action is rejected by the server: patrol units cannot create dispatcher calls or assign others.
    const rej = await page.evaluate(async () => {
      const c = window.patrol.phase8.coop;
      c.send({ t: 'callCreate', ref: 'bad1', typeId: 'noiseComplaint', label: 'x', priority: 1, x: 1, z: 1, address: 'a', narrative: 'n', origin: 'dispatcher' });
      c.send({ t: 'callAssign', callId: 1, unit: 'DISPATCH' });
      c.send({ t: 'callPriority', callId: 1, priority: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      return c.rejections.slice();
    });
    console.log('coop rejections:', JSON.stringify(rej));
    check(rej.length >= 3, `the server rejects illegal patrol actions (${rej.length} rejections)`);
    const status = await consoleRun(page, 'mp status');
    check(status.some((l) => l.includes('Connected as N1')), 'mp status reports the connection');
    const presence = await page2.evaluate(() => [...window.patrol.phase8.coop.units.values()].find((u) => u.callsign === 'N1'));
    check(presence && Number.isFinite(presence.x), 'presence reaches the dispatcher');
    await page.screenshot({ path: path.join(SHOTS, 'phase8-coop.png') });
    await page.evaluate(() => window.patrol.phase8.coop.disconnect());
    const off = await page.evaluate(() => ({ connected: window.patrol.phase8.coop.connected, mode: window.patrol.session.phase8.modeId }));
    check(!off.connected && off.mode === 'freePatrol', 'disconnecting leaves the session running offline');
  } finally {
    await page2.close().catch(() => undefined);
    child.kill('SIGINT');
  }

  // --- v10 save / load round trip and the Phase 8 console ---------------------------------------------------------------------------
  const save = await page.evaluate(async () => {
    const app = window.patrol;
    app.newGame(42, undefined, undefined, { mode: 'career' });
    await new Promise((r) => setTimeout(r, 500));
    app.phase8.academy.close();
    await app.console.execute('career academy driving 91');
    await app.console.execute('career graduate');
    await app.console.execute('career academy firearms 100');
    await app.saveGame('p8');
    const before = JSON.stringify(app.serializeGame().career);
    await app.loadGame('p8');
    const s = app.session;
    const data = app.serializeGame();
    return { version: (await app.saves.load('p8')).version, same: JSON.stringify(data.career) === before, stage: s.phase8.career.view.stage, mods: data.mods, mode: data.mode.id, world: !!data.worldState };
  });
  console.log('v10 save:', JSON.stringify(save));
  check(save.version === 10 && save.same && save.mode === 'career' && save.world && Array.isArray(save.mods), 'a v10 save round-trips the career, world, mode and mod list');
  await page.evaluate(() => window.patrol.ui.closeAll());
  const cmds = await page.evaluate(async () => {
    const run = async (line) => {
      const c = window.patrol.console;
      const before = c.lines.length;
      await c.execute(line);
      return c.lines.slice(before).map((l) => `${l.kind}: ${l.text}`);
    };
    const out = [];
    for (const line of ['career show', 'career set sergeant', 'career stress 0.2', 'world cases', 'world offenders', 'world evolve 2', 'world news', 'course list', 'script list', 'scenario list', 'mods list', 'mp status', 'coop status']) {
      out.push(`> ${line}`, ...(await run(line)));
    }
    return out;
  });
  console.log('phase 8 console commands:\n  ' + cmds.map((l) => l.slice(0, 160)).join('\n  '));
  check(!cmds.some((l) => l.startsWith('error:')), 'Phase 8 console commands ran without errors');

  // --- Perf -------------------------------------------------------------------------------------------------------------------
  await page.evaluate(() => {
    const app = window.patrol;
    app.ui.closeAll();
    for (let i = 0; i < 60 * 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  });
  const perf = await page.evaluate(perfSnapshot);
  const extras = await page.evaluate(() => {
    const out = {};
    for (const [name, ms] of window.patrol.systems.timings) if (['career', 'worldstate', 'training', 'dispatch', 'scene'].includes(name)) out[name] = Number(ms.toFixed(4));
    const w = window.patrol.session.phase8.world.serialize();
    return { systems: out, premises: w.premises.length, offenders: w.offenders.length };
  });
  const frame = await page.evaluate(frameBreakdown, BREAKDOWN_FRAMES);
  console.log('perf phase 8:', JSON.stringify(perf));
  console.log('phase 8 sim costs:', JSON.stringify(extras));
  return { perf, frame, extras };
}

async function run() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  // SMOKE_SIZE=640x360 renders fewer pixels under software GL (a quicker loop while working on the checks).
  const [vw, vh] = (process.env.SMOKE_SIZE ?? '1280x720').split('x').map(Number);
  const page = await browser.newPage({ viewport: { width: vw ?? 1280, height: vh ?? 720 } });

  const consoleErrors = [];
  const consoleWarnings = [];
  const consoleLines = [];
  // Console capture for the main page and for any extra page a phase opens (the co-op dispatcher).
  const watch = (p, label = '') => {
    p.on('console', (msg) => {
      const line = `[${label}${msg.type()}] ${msg.text()}`;
      consoleLines.push(line);
      if (msg.type() === 'error') consoleErrors.push(line);
      // Chromium's own GPU-process notes (e.g. SwiftShader "GPU stall due to ReadPixels") are not the app's.
      if (msg.type() === 'warning' && !msg.text().includes('GL Driver Message')) consoleWarnings.push(line);
    });
    p.on('pageerror', (error) => {
      const line = `[${label}pageerror] ${error.message}`;
      consoleLines.push(line);
      consoleErrors.push(line);
    });
  };
  watch(page);

  try {
    await page.goto(URL_BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });

    const hasRenderer = await page.evaluate(() => window.patrol.renderer !== null);
    console.log(`renderer: ${hasRenderer ? 'WebGL available' : 'UNAVAILABLE (headless simulation only)'}`);

    // SMOKE_ONLY=8 runs just the Phase 8 checks.
    if (process.env.SMOKE_ONLY === '8') {
      const only = await phase8(page, hasRenderer, browser, watch);
      console.log('phase 8 frame:', JSON.stringify(only.frame));
      check(only.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 8 within the cap (${only.perf.drawCalls})`);
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      console.log('--- browser console ---');
      for (const line of consoleLines) console.log(line);
      return;
    }

    // SMOKE_ONLY=7 runs just the Phase 7 checks.
    if (process.env.SMOKE_ONLY === '7') {
      const only = await phase7(page, hasRenderer);
      console.log('phase 7 frame:', JSON.stringify(only.frame));
      check(only.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 7 within the cap (${only.perf.drawCalls})`);
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      console.log('--- browser console ---');
      for (const line of consoleLines) console.log(line);
      return;
    }

    // SMOKE_ONLY=6 runs just the Phase 6 checks.
    if (process.env.SMOKE_ONLY === '6') {
      const only = await phase6(page, hasRenderer);
      console.log('phase 6 frame:', JSON.stringify(only.frame));
      check(only.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 6 within the cap (${only.perf.drawCalls})`);
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      console.log('--- browser console ---');
      for (const line of consoleLines) console.log(line);
      return;
    }

    // SMOKE_ONLY=5 runs just the Phase 5 checks.
    if (process.env.SMOKE_ONLY === '5') {
      const only = await phase5(page, hasRenderer);
      console.log('phase 5 frame:', JSON.stringify(only.frame));
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      console.log('--- browser console ---');
      for (const line of consoleLines) console.log(line);
      return;
    }

    // SMOKE_ONLY=4 runs just the Phase 4 checks.
    if (process.env.SMOKE_ONLY === '4') {
      const only = await phase4(page, hasRenderer);
      check(only.perf.drawCalls <= DRAW_CALL_CAP, `draw calls indoors within the cap (${only.perf.drawCalls})`);
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      console.log('--- browser console ---');
      for (const line of consoleLines) console.log(line);
      return;
    }

    // SMOKE_ONLY=3 runs just the Phase 3 checks (a quick loop while working on them); the full run is the default.
    if (process.env.SMOKE_ONLY === '3') {
      await page.evaluate(() => {
        window.patrol.indoorScenes = false;
      });
      const only = await phase3(page, hasRenderer);
      console.log('perf phase 3:', JSON.stringify(only.perf));
      check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
      check(consoleWarnings.length === 0, `zero app console warnings (${consoleWarnings.length})`);
      return;
    }

    // The Phase 1-3 checks were written for outdoor call scenes; Phase 4 turns the interiors on again.
    await page.evaluate(() => {
      window.patrol.indoorScenes = false;
    });

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
    check(state.vehicles.join(',') === 'patrol_sedan,patrol_suv,patrol_boat,police_helicopter', `fleet parked at the station, the harbor slip and the helipad (${state.vehicles.join(', ')})`);
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
    check(saveLoad.slots.includes('smoke v9'), "slot 'smoke' listed as a v9 save");
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

    // A phase that throws is a failed check, not the end of the run: the later phases still run.
    const guarded = async (name, fn) => {
      try {
        return await fn();
      } catch (error) {
        failures.push(`${name} aborted: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        console.error(error);
        return null;
      }
    };
    const phase2Perf = await guarded('phase 2', () => phase2(page, hasRenderer));
    const phase3Perf = await guarded('phase 3', () => phase3(page, hasRenderer));
    const phase4Perf = await guarded('phase 4', () => phase4(page, hasRenderer));
    const phase5Perf = await guarded('phase 5', () => phase5(page, hasRenderer));
    const phase6Perf = await guarded('phase 6', () => phase6(page, hasRenderer));
    const phase7Perf = await guarded('phase 7', () => phase7(page, hasRenderer));
    const phase8Perf = await guarded('phase 8', () => phase8(page, hasRenderer, browser, watch));

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
    if (phase2Perf) {
      console.log(describe('cockpit + in-car MDT, day:', phase2Perf.frameCockpit));
      console.log(describe('MDT overlay open, day:', phase2Perf.frameMdt));
      console.log('perf phase 2 (cockpit):', JSON.stringify(phase2Perf.perf));
    }
    if (phase3Perf) {
      console.log(describe('Phase 3 scene (people, dialogue closed):', phase3Perf.frame));
      console.log('perf phase 3:', JSON.stringify(phase3Perf.perf));
      console.log('phase 3 sim costs:', JSON.stringify(phase3Perf.extras));
      check(phase3Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls with people within the cap (${phase3Perf.perf.drawCalls})`);
    }
    if (phase4Perf) {
      console.log(describe('Phase 4 interior (house, flashlight):', phase4Perf.frame));
      console.log('perf phase 4:', JSON.stringify(phase4Perf.perf));
      console.log('phase 4 sim costs:', JSON.stringify(phase4Perf.extras));
      check(phase4Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls indoors within the cap (${phase4Perf.perf.drawCalls})`);
    }
    if (phase5Perf) {
      console.log(describe('Phase 5 patrol (HUD additions, bodycam):', phase5Perf.frame));
      console.log('perf phase 5:', JSON.stringify(phase5Perf.perf));
      console.log('phase 5 sim costs:', JSON.stringify(phase5Perf.extras));
      check(phase5Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 5 within the cap (${phase5Perf.perf.drawCalls})`);
    }
    if (phase6Perf) {
      console.log(describe('Phase 6 patrol (HUD, air unit, command):', phase6Perf.frame));
      console.log('perf phase 6:', JSON.stringify(phase6Perf.perf));
      console.log('phase 6 sim costs:', JSON.stringify(phase6Perf.extras));
      check(phase6Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 6 within the cap (${phase6Perf.perf.drawCalls})`);
    }
    if (phase7Perf) {
      console.log(describe('Phase 7 patrol (fleet, liveries, outfits):', phase7Perf.frame));
      console.log('perf phase 7:', JSON.stringify(phase7Perf.perf));
      console.log('phase 7 sim costs:', JSON.stringify(phase7Perf.extras));
      check(phase7Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 7 within the cap (${phase7Perf.perf.drawCalls})`);
    }
    if (phase8Perf) {
      console.log(describe('Phase 8 patrol (career, world, HUD chips):', phase8Perf.frame));
      console.log('perf phase 8:', JSON.stringify(phase8Perf.perf));
      console.log('phase 8 sim costs:', JSON.stringify(phase8Perf.extras));
      check(phase8Perf.perf.drawCalls <= DRAW_CALL_CAP, `draw calls in Phase 8 within the cap (${phase8Perf.perf.drawCalls})`);
    }
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
