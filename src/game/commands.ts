import type { App } from '../app';
import { normalizeSeed } from '../core/rng';
import { MAX_TIME_SCALE } from '../core/time';
import type { Command } from '../debug/console';
import { entityCount } from '../ecs/world';
import { SETTINGS_PATHS, isSettingsPath } from '../settings/settings';

function parseSeed(text: string): number | string {
  return /^-?\d{1,15}$/.test(text) ? Number(text) : text;
}

/** Console `set` values: JSON when it parses (numbers, booleans, null), otherwise the raw text. */
export function parseConsoleValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function requireSession(app: App) {
  const session = app.session;
  if (!session) throw new Error('No game running. Start one with "seed" or from the main menu.');
  return session;
}

/** Phase 0 debug commands bound to the composition root. */
export function createCommands(app: App): Command[] {
  return [
    {
      name: 'seed',
      description: 'Restart the demo scene with a seed (random when omitted)',
      usage: '[seed]',
      run(args) {
        const raw = args[0];
        const seed = raw === undefined ? Math.floor(Math.random() * 0xffffffff) : parseSeed(raw);
        app.bus.emit('rng:reseed', { seed: normalizeSeed(seed) });
        app.newGame(seed);
        return `Started scene with seed ${String(normalizeSeed(seed))}`;
      },
    },
    {
      name: 'timescale',
      description: `Get or set the simulation time scale (0 to ${MAX_TIME_SCALE})`,
      usage: '[x]',
      run(args) {
        const session = requireSession(app);
        if (args[0] !== undefined) {
          const scale = Number(args[0]);
          if (!Number.isFinite(scale)) throw new Error(`timescale: not a number: ${args[0]}`);
          app.setTimeScale(Math.min(Math.max(scale, 0), MAX_TIME_SCALE));
        }
        return `timescale ${String(session.clock.timeScale)}`;
      },
    },
    {
      name: 'pause',
      description: 'Toggle the fixed-step simulation (stays paused through menus until toggled again)',
      run() {
        app.setUserPaused(!app.userPaused);
        if (app.userPaused) return 'paused';
        return app.loop.paused ? 'unpaused (a menu is still open)' : 'running';
      },
    },
    {
      name: 'save',
      description: 'Save the running game to a slot',
      usage: '<slot>',
      async run(args) {
        const slot = args[0] ?? 'quicksave';
        await app.saveGame(slot);
        return `Saved to '${slot}'`;
      },
    },
    {
      name: 'load',
      description: 'Load a game from a slot',
      usage: '<slot>',
      async run(args) {
        const slot = args[0] ?? 'quicksave';
        await app.loadGame(slot);
        return `Loaded '${slot}'`;
      },
    },
    {
      name: 'saves',
      description: 'List save slots',
      async run() {
        const list = await app.saves.list();
        if (list.length === 0) return 'No saves.';
        return list
          .map((s) => `${s.slot.padEnd(12)} ${s.officerName.padEnd(14)} v${String(s.version)} ${new Date(s.updatedAt).toISOString()}`)
          .join('\n');
      },
    },
    {
      name: 'perf',
      description: 'Toggle the performance overlay',
      run() {
        app.perf.toggle();
        return `perf overlay ${app.perf.visible ? 'on' : 'off'}`;
      },
    },
    {
      name: 'fps',
      description: 'Print the current frame statistics',
      run() {
        const s = app.loop.stats;
        return `fps ${s.fps.toFixed(1)}  frame ${s.frameMs.toFixed(2)} ms  sim ${s.simMs.toFixed(2)} ms  steps ${String(s.stepsLastFrame)}`;
      },
    },
    {
      name: 'spawn',
      description: 'Spawn demo entities, e.g. "spawn box 10"',
      usage: 'box [n]',
      run(args) {
        const session = requireSession(app);
        if (args[0] !== 'box') throw new Error('Usage: spawn box [n]');
        const n = args[1] === undefined ? 1 : Number(args[1]);
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RangeError('n must be an integer in 1..1000');
        const spawned = session.spawnRandomBoxes(n).length;
        const text = `Spawned ${String(spawned)} box${spawned === 1 ? '' : 'es'}`;
        return spawned < n ? `${text} (box pool full)` : text;
      },
    },
    {
      name: 'entities',
      description: 'Print entity, body and mesh counts',
      run() {
        return `entities ${String(entityCount(app.world))}  bodies ${String(app.physics.bodyCount)}  meshes ${String(app.meshes.count)}`;
      },
    },
    {
      name: 'settings',
      description: 'Read or write a setting, e.g. "settings set graphics.fov 90"',
      usage: 'get <path> | set <path> <value> | list',
      run(args) {
        const [verb, path, ...rest] = args;
        if (verb === 'list' || verb === undefined) return SETTINGS_PATHS.join('\n');
        if (!isSettingsPath(path)) throw new Error(`Unknown setting '${path ?? ''}'`);
        if (verb === 'get') return `${path} = ${JSON.stringify(app.settings.get(path))}`;
        if (verb === 'set') {
          if (rest.length === 0) throw new Error('Missing value');
          const value = parseConsoleValue(rest.join(' '));
          if (!app.settings.trySet(path, value)) return `${path} unchanged (invalid value or same as before)`;
          return `${path} = ${JSON.stringify(app.settings.get(path))}`;
        }
        throw new Error('Usage: settings get <path> | set <path> <value> | list');
      },
    },
    {
      name: 'worker',
      description: 'Simulation worker diagnostics',
      usage: 'ping',
      async run(args) {
        if (args[0] !== 'ping') throw new Error('Usage: worker ping');
        const worker = app.worker;
        if (!worker) throw new Error('Worker unavailable');
        const sent = performance.now();
        const reply = await worker.call('ping', { t: sent });
        return `pong in ${(performance.now() - sent).toFixed(2)} ms (worker clock ${reply.workerTime.toFixed(0)} ms)`;
      },
    },
    {
      name: 'debugcam',
      description: 'Toggle the orbiting debug camera',
      run() {
        if (!app.renderer) throw new Error('Renderer unavailable');
        app.renderer.toggleDebugCamera();
        app.refreshPointerLock();
        return `debug camera ${app.renderer.debugCameraEnabled ? 'on' : 'off'}`;
      },
    },
  ];
}
