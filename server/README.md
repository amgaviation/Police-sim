# Patrol co-op server

Optional server for the co-op mode. It hosts rooms with an authoritative shared CAD (calls, assignments, unit status,
notes, orders, radio text and map presence). Every client still simulates its own world from the room seed.

It is a single Node script with **no npm dependencies**: the built-in `http` and `crypto` modules plus a hand-written
RFC 6455 frame codec (`wsFrames.ts`). The room rules are the same pure code the tests exercise (`src/net/room.ts`).

## Run

Node 22.18 or newer (built-in TypeScript type stripping; the repo is developed on 22.22):

```
npm run server          # node server/main.ts
```

The server prints `Patrol co-op server on ws://127.0.0.1:8787`. In the game open the co-op lobby and connect to that
address (the default `ws://localhost:8787`). Stop it with Ctrl+C (SIGINT) or SIGTERM.

## Environment variables

| Name | Default | Meaning |
|---|---|---|
| `PATROL_SERVER_PORT` | `8787` | TCP port (`0` picks a free one; the real port is printed) |
| `PATROL_SERVER_HOST` | `127.0.0.1` | Interface to bind |
| `PATROL_SERVER_ORIGINS` | unset | Comma separated allowed `Origin` values. Unset: any `http://localhost:*` / `http://127.0.0.1:*` page (or a client that sends no Origin) |
| `PATROL_SERVER_MAX_ROOMS` | `8` | Maximum rooms at once |
| `PATROL_SERVER_LOG` | unset | `1` logs joins, leaves and rejected messages |

There are no secrets, tokens or accounts and nothing is deployed by this repository.

## Rules the server enforces

Each room allows 4 patrol units (`N1`..`N4`), one dispatcher (`DISPATCH`) and one supervisor (`S1`). The first member is
the host. Clients send intents only; the server validates the message schema (`src/net/protocol.ts`), the sender's role
permissions, call and unit state transitions, a rate limit (burst 40, 20 per second; presence at most every 80 ms) and
position plausibility, applies the change and broadcasts the resulting events. A rejected message gets a `reject`
reply and changes nothing. Text messages only (binary or fragmented frames close the socket with 1003), at most 64 KiB
per frame and 8 KiB per message. Sockets that stay silent for 45 s are dropped; empty rooms are deleted.

## Security note

This is a **local network tool**. There is no TLS (`ws://`, not `wss://`), no authentication and no accounts: anybody who
can reach the port can join any room by name. Keep the default `127.0.0.1` bind for play on one machine; bind
`0.0.0.0` only on a network you trust, and set `PATROL_SERVER_ORIGINS` if the game page is served from another host.
Do not expose it to the internet.

## Checks

```
npx tsc -p server/tsconfig.json
npx vitest run test/net test/server
```
