/// <reference types="node" />
/**
 * Entry point: `node server/main.ts` (Node 22+, built-in type stripping). Configuration is read only from the
 * environment variables listed in server/README.md.
 */
import { startServer } from './wsServer.ts';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer ${min}..${max}, got '${raw}'`);
    process.exit(1);
  }
  return n;
}

const port = envInt('PATROL_SERVER_PORT', 8787, 0, 65535);
const maxRooms = envInt('PATROL_SERVER_MAX_ROOMS', 8, 1, 1000);
const host = process.env.PATROL_SERVER_HOST || '127.0.0.1';
const originsRaw = process.env.PATROL_SERVER_ORIGINS ?? '';
const origins = originsRaw
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const verbose = process.env.PATROL_SERVER_LOG === '1';

const server = await startServer({
  port,
  host,
  allowedOrigins: origins.length > 0 ? origins : null,
  maxRooms,
  log: (line) => {
    if (verbose) console.log(line);
  },
});
console.log(`Patrol co-op server on ws://${host}:${server.port}`);

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
