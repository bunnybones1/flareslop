# Peer Management & Hysteresis

The client keeps a soft cap on active voice links to avoid browser limits and churn. The `VoicePeerManager` coordinates membership changes from the Worker, orders peers by distance, and applies hysteresis so existing connections are retained until they are well outside the voice radius.

## Usage

```ts
import {
  connectCellWS,
  VoicePeerManager,
  VoicePeerManagerOptions,
} from "../../voiceChat/client";

const MAX_PEERS = 8;
const VOICE_RADIUS = 30;

const manager = new VoicePeerManager({
  connectRadius: VOICE_RADIUS,
  maxPeers: MAX_PEERS,
  disconnectRadiusMultiplier: 1.5, // keep peers until 1.5 × radius
  evaluationDebounceMs: 300,
});

manager.onConnect(async (peerId) => {
  await createPeerConnection(peerId);
});

manager.onDisconnect(async (peerId) => {
  await teardownPeerConnection(peerId);
});

const voice = await connectCellWS({ url, playerId, sessionToken });
const detach = voice.attachPeerManager(manager);

// Whenever local position changes:
manager.updateLocalPosition({ x, y, z });

// Feed remote positions/distances from game or telemetry:
manager.updatePeerPosition(remotePeerId, { x, y, z });
// or if the Worker reports exact distances:
manager.updatePeerDistance(remotePeerId, distance);
```

`VoicePeerManager` consumes the `peers` diff messages pushed over the WebSocket. It debounces evaluations (default 250 ms), sorts candidates by distance, and only initiates new connections when the cap allows. Existing peers remain connected until they exceed `connectRadius × disconnectRadiusMultiplier`.

## Configuration

- `connectRadius`: meters at which the player should start hearing a peer.
- `disconnectRadiusMultiplier`: multiplier applied to the radius before a peer is dropped (defaults to 1.5 for hysteresis).
- `maxPeers`: hard cap on simultaneous WebRTC peers (defaults to 8).
- `evaluationDebounceMs`: optional debounce for membership recalculations (defaults to 250 ms).

You can adjust these values per scene or apply dynamic tuning (e.g., lower `maxPeers` when bandwidth is constrained).

## Cleanup

Call `manager.dispose()` and the `detach()` function returned by `attachPeerManager()` when the player leaves a cell to avoid stale timers.

## Local Test

Run the deterministic harness to validate hysteresis behaviour:

```sh
pnpm install
pnpm run voice:test:peer-manager
```

The script simulates peer diffs, enforces the max-peer cap, and checks that hysteresis delays disconnects until 1.5× the voice radius.
