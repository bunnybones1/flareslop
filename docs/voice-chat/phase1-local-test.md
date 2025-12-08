# Phase 1 Local Test

This script verifies the Worker ⇆ Durable Object handshake and the basic signaling relay between two simulated players.

## Prerequisites

- Run the Cloudflare Worker locally:
  ```sh
  cd workers/voice-chat
  pnpm dlx wrangler dev --local
  ```
- From another terminal at repo root, install dependencies (only needed once):
  ```sh
  pnpm install
  ```

## Execute the Test

```sh
pnpm run voice:test:phase1
```

What it does:

1. Calls `POST /join` twice to create two player sessions.
2. Opens WebSocket connections to the shared cell.
3. Registers both players, sends heartbeats/positions, and relays a sample signaling payload.
4. Fails the run if any step times out or the Worker responds unexpectedly.

Set `VOICE_WORKER_URL` if your dev Worker runs on a non-default address:

```sh
VOICE_WORKER_URL=http://127.0.0.1:8788 pnpm run voice:test:phase1
```
