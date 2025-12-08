#!/usr/bin/env node
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { VoicePeerManager } from "../client/voiceChat/peerManager.ts";

const DEFAULT_DELAY = 120;

type Event =
  | { type: "connect"; peerId: string }
  | { type: "disconnect"; peerId: string };

const events: Event[] = [];

const manager = new VoicePeerManager({
  connectRadius: 30,
  disconnectRadiusMultiplier: 1.5,
  maxPeers: 2,
  evaluationDebounceMs: 50,
});

manager.onConnect((peerId) => {
  events.push({ type: "connect", peerId });
});

manager.onDisconnect((peerId) => {
  events.push({ type: "disconnect", peerId });
});

const expectEvents = (expected: Event[], message: string) => {
  assert.deepEqual(events, expected, message);
};

const expectNoChange = async (message: string) => {
  const snapshot = [...events];
  await wait(DEFAULT_DELAY);
  expectEvents(snapshot, message);
};

const main = async () => {
  manager.applyPeerDiff({ type: "peers", added: ["p1", "p2", "p3"] });
  manager.updatePeerDistance("p1", 10);
  manager.updatePeerDistance("p2", 20);
  manager.updatePeerDistance("p3", 25);

  await wait(DEFAULT_DELAY);

  expectEvents(
    [
      { type: "connect", peerId: "p1" },
      { type: "connect", peerId: "p2" },
    ],
    "Should connect the two closest peers within radius",
  );

  await expectNoChange(
    "Hysteresis should keep peers connected while within 1.5× radius",
  );

  manager.updatePeerDistance("p2", 60); // beyond 45m disconnect threshold
  await wait(DEFAULT_DELAY);

  expectEvents(
    [
      { type: "connect", peerId: "p1" },
      { type: "connect", peerId: "p2" },
      { type: "disconnect", peerId: "p2" },
      { type: "connect", peerId: "p3" },
    ],
    "Peer outside hysteresis radius should disconnect and next closest should fill slot",
  );

  manager.updatePeerDistance("p3", 42);
  await expectNoChange("Peer inside hysteresis range should remain connected");

  manager.updatePeerDistance("p3", 55);
  await wait(DEFAULT_DELAY);

  expectEvents(
    [
      { type: "connect", peerId: "p1" },
      { type: "connect", peerId: "p2" },
      { type: "disconnect", peerId: "p2" },
      { type: "connect", peerId: "p3" },
      { type: "disconnect", peerId: "p3" },
    ],
    "Peer exceeding hysteresis radius should disconnect",
  );

  manager.updatePeerDistance("p3", 42); // still within hysteresis (max 45)
  await expectNoChange(
    "Disconnected peer should not reconnect until back within connect radius",
  );

  manager.removePeer("p1");
  await wait(DEFAULT_DELAY);

  expectEvents(
    [
      { type: "connect", peerId: "p1" },
      { type: "connect", peerId: "p2" },
      { type: "disconnect", peerId: "p2" },
      { type: "connect", peerId: "p3" },
      { type: "disconnect", peerId: "p3" },
      { type: "disconnect", peerId: "p1" },
    ],
    "Explicit removal should force disconnect",
  );

  manager.dispose();
  console.log("✅ VoicePeerManager hysteresis test passed");
};

main().catch((error) => {
  manager.dispose();
  console.error("❌ VoicePeerManager hysteresis test failed:", error);
  process.exitCode = 1;
});
