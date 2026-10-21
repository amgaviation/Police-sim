#!/usr/bin/env node
/**
 * Browser performance and memory profile of the production build (Phase 9, design §9.3).
 *
 * Builds the app (`npx vite build`, skipped with PERF_NO_BUILD=1), serves it with `npx vite preview` on port 4174,
 * opens `/?e2e` in headless Chromium with SwiftShader, starts a new game (seed 4242, indoor scenes), completes the
 * station flow, seats the officer in P-101, sets `timescale 8` and drives with a scripted key loop for PERF_MINUTES
 * real minutes (default 4). At checkpoints (0.5 min, 1/3, 2/3 and the end of the run) the heap is collected twice and
 * read through the DevTools protocol (`Runtime.getHeapUsage`, `Memory.getDOMCounters`); PERF_SNAPSHOT=1 also streams a
 * heap snapshot at the first and the last checkpoint to $TMPDIR/patrol-heap-<n>.heapsnapshot.
 *
 * Per-system timings come from `app.profiler` (a SystemProfiler) when the app exposes one; otherwise the page samples
 * `app.systems.timings` once per animation frame, which sees only the last fixed step of each frame (the output says so).
 *
 * Writes docs/perf/browser-profile.json. Exits 1 when the heap after GC grows more than 25 % or 40 MB between the
 * second and the last checkpoint, when DOM nodes or JS event listeners grow more than 20 % between them, or on any
 * console error.
 *
 * Usage: npm run perf  (or: node scripts/perf.mjs). Env: PERF_MINUTES, PERF_SNAPSHOT, PERF_NO_BUILD, PERF_SIZE=WxH.
 */
/* global window, requestAnimationFrame -- functions passed to page.evaluate run in the browser */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4174;
const URL_BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.join(ROOT, 'docs', 'perf');
const SEED = 4242;
const MINUTES = Number(process.env.PERF_MINUTES ?? 4);
const SNAPSHOT = process.env.PERF_SNAPSHOT === '1';
const TIME_SCALE = 8;
/** Draw-call cap of the design (§16). */
const DRAW_CALL_CAP = 300;
/** Verdict limits (design §9.3). */
const HEAP_GROWTH_FRACTION = 0.25;
const HEAP_GROWTH_BYTES = 40 * 1024 * 1024;
const DOM_GROWTH_FRACTION = 0.2;

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

async function waitForServer(url, timeoutMs = 60000) {
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
  throw new Error(`Preview server at ${url} did not come up within ${timeoutMs} ms`);
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`vite build exited with ${code}`))));
  });
}

function startPreview() {
  // Detached so the npx wrapper and the vite process it spawns share a group we can kill together.
  const child = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
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

async function stopPreview(child) {
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

async function waitFor(page, fn, arg, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = await page.evaluate(fn, arg);
  while (!value && Date.now() < deadline) {
    await sleep(250);
    value = await page.evaluate(fn, arg);
  }
  return value;
}

const mb = (bytes) => Number((bytes / (1024 * 1024)).toFixed(2));

// --- In-page helpers --------------------------------------------------------------------------------------------

/**
 * Installs the per-frame sampler: draw calls, frame time and steps per frame always; per-system run times from
 * `app.systems.timings` (last fixed step of the frame) when the app has no `app.profiler`. Results in `window.__perf`.
 */
function installSampler() {
  const app = window.patrol;
  const BUCKETS = 64;
  const bucketOf = (ms) => (ms > 0.001 ? Math.min(BUCKETS - 1, Math.max(0, Math.floor(4 * Math.log2(ms / 0.001)))) : 0);
  const series = new Map();
  const add = (name, ms) => {
    let s = series.get(name);
    if (!s) series.set(name, (s = { count: 0, total: 0, max: 0, hist: new Array(BUCKETS).fill(0) }));
    s.count += 1;
    s.total += ms;
    if (ms > s.max) s.max = ms;
    s.hist[bucketOf(ms)] += 1;
  };
  const state = {
    useTimings: !app.profiler,
    frames: 0,
    steps: 0,
    drawCalls: { max: 0, sum: 0 },
    triangles: { max: 0, sum: 0 },
    frameMs: { sum: 0, max: 0 },
    series,
    add,
    running: true,
  };
  window.__perf = state;
  const tick = () => {
    if (!state.running) return;
    const stats = app.loop.stats;
    state.frames += 1;
    state.steps += stats.stepsLastFrame;
    state.frameMs.sum += stats.frameMs;
    if (stats.frameMs > state.frameMs.max) state.frameMs.max = stats.frameMs;
    const r = app.renderer?.stats;
    if (r) {
      state.drawCalls.sum += r.drawCalls;
      state.drawCalls.max = Math.max(state.drawCalls.max, r.drawCalls);
      state.triangles.sum += r.triangles;
      state.triangles.max = Math.max(state.triangles.max, r.triangles);
    }
    if (state.useTimings) {
      if (stats.stepsLastFrame > 0) for (const [name, ms] of app.systems.timings) add(name, ms);
      if (stats.stepsLastFrame > 0) add('phase:sim', stats.simMs);
      if (typeof stats.updateMs === 'number') add('phase:update', stats.updateMs);
      if (typeof stats.renderMs === 'number') add('phase:render', stats.renderMs);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The ProfileReport-shaped result: from `app.profiler` when present, else from the in-page sampler. */
function readProfile() {
  const app = window.patrol;
  if (app.profiler) return { source: 'app.profiler', report: app.profiler.report() };
  const state = window.__perf;
  const p95 = (hist, count) => {
    const rank = Math.ceil(count * 0.95);
    let seen = 0;
    for (let b = 0; b < hist.length; b++) {
      seen += hist[b];
      if (seen >= rank) return 0.001 * 2 ** ((b + 1) / 4);
    }
    return 0.001 * 2 ** 16;
  };
  const rows = [];
  let sum = 0;
  for (const [name, s] of state.series) {
    if (name.startsWith('phase:')) continue;
    rows.push({ name, count: s.count, meanMs: s.total / s.count, p95Ms: p95(s.hist, s.count), maxMs: s.max, totalMs: s.total, share: 0 });
    sum += s.total;
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  for (const r of rows) r.share = sum > 0 ? r.totalMs / sum : 0;
  const phases = ['sim', 'update', 'render'].map((name) => {
    const s = state.series.get(`phase:${name}`);
    return s
      ? { name, count: s.count, meanMs: s.total / s.count, p95Ms: p95(s.hist, s.count), maxMs: s.max, totalMs: s.total, share: 0 }
      : { name, count: 0, meanMs: 0, p95Ms: 0, maxMs: 0, totalMs: 0, share: 0 };
  });
  return { source: 'app.systems.timings sampled once per frame (last fixed step of each frame)', report: { steps: state.steps, frames: state.frames, systems: rows, phases } };
}

/** Clears the profile and the sampler (called when the measured drive starts). */
function resetProfile() {
  const app = window.patrol;
  if (app.profiler) app.profiler.reset();
  const state = window.__perf;
  state.frames = 0;
  state.steps = 0;
  state.drawCalls = { max: 0, sum: 0 };
  state.triangles = { max: 0, sum: 0 };
  state.frameMs = { sum: 0, max: 0 };
  state.series.clear();
}

/** One snapshot of the sampler's frame numbers. */
function readFrames() {
  const state = window.__perf;
  const n = Math.max(1, state.frames);
  return {
    frames: state.frames,
    stepsPerFrame: state.steps / n,
    frameMsMean: state.frameMs.sum / n,
    frameMsMax: state.frameMs.max,
    drawCallsMean: state.drawCalls.sum / n,
    drawCallsMax: state.drawCalls.max,
    trianglesMean: state.triangles.sum / n,
    trianglesMax: state.triangles.max,
  };
}

/** The shift flow smoke phase 7 does: sign out the loadout, complete the station steps, leave at the door. */
async function completeStationFlow() {
  const app = window.patrol;
  const s = app.session;
  for (const item of ['sidearm', 'taser']) s.station.request({ kind: 'armory', item, action: 'out' });
  for (const step of ['locker', 'briefing', 'armory', 'garage']) s.station.request({ kind: 'complete', step });
  for (let i = 0; i < 10; i++) app.loop.hooks.fixedUpdate(1 / 60, 0);
  s.teleport(s.city.spawn.x, s.city.spawn.z, s.city.spawn.yaw);
  await new Promise((r) => setTimeout(r, 500));
}

/** Seats the officer in P-101 (as smoke phase 7 does). */
function seatInPatrolCar() {
  const app = window.patrol;
  const s = app.session;
  const car = s.unitVehicle('P-101');
  if (!car) return { ok: false, reason: 'no P-101' };
  const ok = app.enterVehicle(s.vehicles.indexOf(car));
  return { ok, driving: s.driving };
}

/** Where the officer is and whether the game still runs (for stuck detection). */
function readPose() {
  const s = window.patrol.session;
  const p = s.playerPosition({ x: 0, z: 0 });
  return { x: p.x, z: p.z, driving: s.driving };
}

// --- Driver -----------------------------------------------------------------------------------------------------

/** A repeating steering plan: [key or null, hold ms]. W stays down the whole time. */
const STEER_PLAN = [
  [null, 2500],
  ['KeyA', 450],
  [null, 2000],
  ['KeyD', 700],
  [null, 3000],
  ['KeyD', 350],
  [null, 1500],
  ['KeyA', 600],
];

async function drive(page, endAt, onTick) {
  await page.keyboard.down('KeyW');
  let planIndex = 0;
  let last = await page.evaluate(readPose);
  let lastMoveAt = Date.now();
  try {
    while (Date.now() < endAt) {
      const [key, ms] = STEER_PLAN[planIndex % STEER_PLAN.length];
      planIndex += 1;
      if (key) await page.keyboard.down(key);
      const until = Math.min(endAt, Date.now() + ms);
      while (Date.now() < until) await sleep(Math.min(100, until - Date.now()));
      if (key) await page.keyboard.up(key);
      await onTick();
      // Stuck (against a wall or a kerb): back up with the wheel over, then carry on.
      const pose = await page.evaluate(readPose);
      if (Math.hypot(pose.x - last.x, pose.z - last.z) > 3) {
        last = pose;
        lastMoveAt = Date.now();
      } else if (Date.now() - lastMoveAt > 5000) {
        await page.keyboard.up('KeyW');
        await page.keyboard.down('KeyS');
        await page.keyboard.down('KeyA');
        await sleep(1800);
        await page.keyboard.up('KeyA');
        await page.keyboard.up('KeyS');
        await page.keyboard.down('KeyW');
        last = await page.evaluate(readPose);
        lastMoveAt = Date.now();
      }
    }
  } finally {
    await page.keyboard.up('KeyW');
  }
}

// --- Heap checkpoints -------------------------------------------------------------------------------------------

async function checkpoint(client, tMin, label) {
  await client.send('HeapProfiler.collectGarbage');
  await client.send('HeapProfiler.collectGarbage');
  const heap = await client.send('Runtime.getHeapUsage');
  const dom = await client.send('Memory.getDOMCounters');
  return {
    label,
    tMin: Number(tMin.toFixed(2)),
    heapUsedMb: mb(heap.usedSize),
    heapTotalMb: mb(heap.totalSize),
    heapUsedBytes: heap.usedSize,
    dom: { documents: dom.documents, nodes: dom.nodes, jsEventListeners: dom.jsEventListeners },
  };
}

async function takeSnapshot(client, n) {
  const dir = process.env.TMPDIR ?? os.tmpdir();
  const file = path.join(dir, `patrol-heap-${n}.heapsnapshot`);
  const out = createWriteStream(file);
  const onChunk = ({ chunk }) => out.write(chunk);
  client.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  client.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await new Promise((resolve) => out.end(resolve));
  const { size } = await stat(file);
  // The node count sits in the metadata at the start of the file.
  const fh = await open(file, 'r');
  const head = Buffer.alloc(Math.min(size, 65536));
  await fh.read(head, 0, head.length, 0);
  await fh.close();
  const match = /"node_count":(\d+)/.exec(head.toString('utf8'));
  return { n, file, sizeMb: mb(size), nodes: match ? Number(match[1]) : null };
}

// --- Output -----------------------------------------------------------------------------------------------------

function table(rows, top = 15) {
  const lines = [`  ${'system'.padEnd(20)} ${'mean ms'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)} ${'share'.padStart(7)}`];
  for (const r of rows.slice(0, top)) {
    lines.push(`  ${r.name.padEnd(20).slice(0, 20)} ${r.meanMs.toFixed(3).padStart(8)} ${r.p95Ms.toFixed(3).padStart(8)} ${r.maxMs.toFixed(3).padStart(8)} ${`${(r.share * 100).toFixed(1)}%`.padStart(7)}`);
  }
  return lines.join('\n');
}

async function run() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-precise-memory-info'],
  });
  const [vw, vh] = (process.env.PERF_SIZE ?? '1280x720').split('x').map(Number);
  const page = await browser.newPage({ viewport: { width: vw ?? 1280, height: vh ?? 720 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[console.error] ${msg.text()}`);
  });
  page.on('pageerror', (error) => consoleErrors.push(`[pageerror] ${error.message}`));

  try {
    await page.goto(`${URL_BASE}/?e2e`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(window.patrol), null, { timeout: 60000 });
    const client = await page.context().newCDPSession(page);
    await client.send('HeapProfiler.enable');

    // New game: seed 4242 with indoor scenes, wait for the chunk streamer to settle.
    await page.evaluate((seed) => {
      const app = window.patrol;
      app.indoorScenes = true;
      app.ui.closeAll();
      app.newGame(seed);
      app.perf.setVisible(false);
    }, SEED);
    const ready = await waitFor(page, () => window.patrol.session !== null && (window.patrol.worldView?.streamer?.stats.inFlight ?? 0) === 0, null, 120000);
    check(Boolean(ready), 'new game (seed 4242) loaded and streaming settled');
    await page.evaluate(completeStationFlow);
    const seat = await page.evaluate(seatInPatrolCar);
    check(seat.ok === true, `officer seated in P-101 (${JSON.stringify(seat)})`);
    await page.evaluate(async (scale) => {
      await window.patrol.console.execute(`timescale ${scale}`);
      await window.patrol.console.execute('time 10:00');
      await window.patrol.console.execute('weather clear');
    }, TIME_SCALE);
    await page.evaluate(installSampler);
    const hasProfiler = await page.evaluate(() => Boolean(window.patrol.profiler));
    console.log(hasProfiler ? 'per-system source: app.profiler' : 'per-system source: app.profiler is missing; sampling app.systems.timings once per animation frame (last fixed step of each frame only)');
    await sleep(2000); // warm-up: shaders, first streaming
    await page.evaluate(resetProfile);

    const checkpointsMin = [Math.min(0.5, MINUTES / 4), MINUTES / 3, (2 * MINUTES) / 3, MINUTES];
    const startedAt = Date.now();
    const endAt = startedAt + MINUTES * 60000;
    const checkpoints = [];
    const snapshots = [];
    let next = 0;
    const onTick = async () => {
      const elapsedMin = (Date.now() - startedAt) / 60000;
      while (next < checkpointsMin.length && elapsedMin >= checkpointsMin[next] - 1e-6) {
        const first = next === 0;
        const cp = await checkpoint(client, elapsedMin, `t=${checkpointsMin[next].toFixed(2)}min`);
        checkpoints.push(cp);
        console.log(`checkpoint ${cp.label}: heap ${cp.heapUsedMb} MB (total ${cp.heapTotalMb}), DOM nodes ${cp.dom.nodes}, listeners ${cp.dom.jsEventListeners}, documents ${cp.dom.documents}`);
        if (SNAPSHOT && (first || next === checkpointsMin.length - 1)) {
          const snap = await takeSnapshot(client, snapshots.length + 1);
          snapshots.push(snap);
          console.log(`heap snapshot ${snap.n}: ${snap.sizeMb} MB, ${snap.nodes ?? '?'} nodes -> ${snap.file}`);
        }
        next += 1;
      }
    };
    await drive(page, endAt, onTick);
    // The end checkpoint falls at the end of the drive; take any still missing.
    next = Math.min(next, checkpointsMin.length);
    while (checkpoints.length < checkpointsMin.length) {
      const idx = checkpoints.length;
      const cp = await checkpoint(client, (Date.now() - startedAt) / 60000, `t=${checkpointsMin[idx].toFixed(2)}min`);
      checkpoints.push(cp);
      console.log(`checkpoint ${cp.label}: heap ${cp.heapUsedMb} MB (total ${cp.heapTotalMb}), DOM nodes ${cp.dom.nodes}, listeners ${cp.dom.jsEventListeners}, documents ${cp.dom.documents}`);
      if (SNAPSHOT && idx === checkpointsMin.length - 1) {
        const snap = await takeSnapshot(client, snapshots.length + 1);
        snapshots.push(snap);
        console.log(`heap snapshot ${snap.n}: ${snap.sizeMb} MB, ${snap.nodes ?? '?'} nodes -> ${snap.file}`);
      }
    }

    const profile = await page.evaluate(readProfile);
    const frames = await page.evaluate(readFrames);
    const final = await page.evaluate(() => {
      const app = window.patrol;
      const s = app.session;
      return { driving: s.driving, entities: s.entityCount, simSeconds: s.clock.simTime, traffic: { ...s.traffic.stats } };
    });
    await page.evaluate(() => {
      window.__perf.running = false;
    });

    // --- Report -------------------------------------------------------------------------------------------------
    console.log(`\nDrive: ${MINUTES} real min at timescale ${TIME_SCALE}, ${frames.frames} frames, ${profile.report.steps} fixed steps (${final.simSeconds.toFixed(0)} sim s); driving at end: ${final.driving}`);
    console.log(`per-system source: ${profile.source}`);
    console.log(`\nSystems (ms per fixed step):\n${table(profile.report.systems)}`);
    console.log('\nFrame phases (ms per frame):');
    for (const p of profile.report.phases) console.log(`  ${p.name.padEnd(8)} mean ${p.meanMs.toFixed(3)}  p95 ${p.p95Ms.toFixed(3)}  max ${p.maxMs.toFixed(3)}  (${p.count} samples)`);
    console.log(
      `\nFrames: mean ${frames.frameMsMean.toFixed(1)} ms (max ${frames.frameMsMax.toFixed(1)}), ${frames.stepsPerFrame.toFixed(1)} steps/frame; ` +
        `draw calls mean ${frames.drawCallsMean.toFixed(0)} (max ${frames.drawCallsMax}), triangles mean ${Math.round(frames.trianglesMean)} (max ${frames.trianglesMax})`,
    );
    console.log('\nHeap after GC and DOM counters:');
    for (const cp of checkpoints) console.log(`  ${cp.label.padEnd(12)} heap ${String(cp.heapUsedMb).padStart(7)} MB  nodes ${String(cp.dom.nodes).padStart(6)}  listeners ${String(cp.dom.jsEventListeners).padStart(5)}  documents ${cp.dom.documents}`);

    // --- Verdict ------------------------------------------------------------------------------------------------
    const base = checkpoints[1];
    const last = checkpoints[checkpoints.length - 1];
    const heapGrowth = last.heapUsedBytes - base.heapUsedBytes;
    const heapFraction = base.heapUsedBytes > 0 ? heapGrowth / base.heapUsedBytes : 0;
    const frac = (a, b) => (a > 0 ? (b - a) / a : 0);
    const nodeGrowth = frac(base.dom.nodes, last.dom.nodes);
    const listenerGrowth = frac(base.dom.jsEventListeners, last.dom.jsEventListeners);
    check(!(heapFraction > HEAP_GROWTH_FRACTION || heapGrowth > HEAP_GROWTH_BYTES), `heap after GC, 2nd to last checkpoint: ${mb(heapGrowth)} MB (${(heapFraction * 100).toFixed(1)} %), limit 25 % / 40 MB`);
    check(nodeGrowth <= DOM_GROWTH_FRACTION, `DOM nodes 2nd to last checkpoint: ${base.dom.nodes} -> ${last.dom.nodes} (${(nodeGrowth * 100).toFixed(1)} %), limit 20 %`);
    check(listenerGrowth <= DOM_GROWTH_FRACTION, `JS event listeners 2nd to last checkpoint: ${base.dom.jsEventListeners} -> ${last.dom.jsEventListeners} (${(listenerGrowth * 100).toFixed(1)} %), limit 20 %`);
    check(frames.drawCallsMax <= DRAW_CALL_CAP, `draw calls within the cap (max ${frames.drawCallsMax}, cap ${DRAW_CALL_CAP})`);
    check(consoleErrors.length === 0, `zero console errors (${consoleErrors.length})`);
    for (const line of consoleErrors.slice(0, 20)) console.log(`  ${line}`);

    await mkdir(OUT_DIR, { recursive: true });
    const result = {
      date: new Date().toISOString(),
      minutes: MINUTES,
      timeScale: TIME_SCALE,
      seed: SEED,
      build: 'production (vite build, vite preview)',
      renderer: 'headless Chromium, SwiftShader software GL',
      profileSource: profile.source,
      profile: profile.report,
      frames,
      checkpoints,
      snapshots,
      growth: { heapBytes: heapGrowth, heapFraction, domNodesFraction: nodeGrowth, jsEventListenersFraction: listenerGrowth },
      consoleErrors,
      failures: [...failures],
    };
    await writeFile(path.join(OUT_DIR, 'browser-profile.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`\nwrote ${path.join(OUT_DIR, 'browser-profile.json')}`);
  } finally {
    await browser.close();
  }
}

let server = null;
try {
  if (process.env.PERF_NO_BUILD !== '1') await runBuild();
  server = startPreview();
  await waitForServer(URL_BASE);
  await run();
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(error);
} finally {
  await stopPreview(server);
}

if (failures.length > 0) {
  console.log(`\nPERF FAILED: ${failures.length} problem(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPERF PASSED');
process.exit(0);
