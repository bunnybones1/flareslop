#!/usr/bin/env node
/* eslint-env node */
/* global console, process, setTimeout, clearTimeout */
import WebSocket from "ws";

const WORKER_BASE_URL =
  process.env.VOICE_WORKER_URL ?? "https://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 2000;

if (typeof globalThis.fetch !== "function") {
  throw new Error(
    "Global fetch is not available. Use Node 18+ or enable experimental fetch.",
  );
}

const fetch = globalThis.fetch.bind(globalThis);

const players = {
  a: { id: "proximity-tester-a", position: { x: 0, y: 0, z: 0 } },
  b: { id: "proximity-tester-b", position: { x: 10, y: 0, z: 0 } }, // within radius
};

const log = (message, ...rest) => {
  console.log(`[voice-proximity] ${message}`, ...rest);
};

const joinWorld = async (player) => {
  const response = await fetch(`${WORKER_BASE_URL}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId: player.id,
      position: player.position,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Join failed for ${player.id}: ${detail || response.statusText}`,
    );
  }

  const json = await response.json();
  const { cellWebSocketUrl, sessionToken } = json;

  if (!cellWebSocketUrl || !sessionToken) {
    throw new Error(`Join response missing fields for ${player.id}`);
  }

  log(`${player.id} -> joined, ws=${cellWebSocketUrl}`);

  return { cellWebSocketUrl, sessionToken };
};

const waitForMessage = (
  ws,
  predicate,
  description,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${description}`));
    }, timeoutMs);

    const onClose = () => {
      cleanup();
      reject(new Error(`Socket closed while waiting for ${description}`));
    };

    const onMessage = (raw) => {
      let parsed;

      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      log(`${ws.__playerId} <=`, parsed);

      if (predicate(parsed)) {
        cleanup();
        resolve(parsed);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("close", onClose);
      ws.off("message", onMessage);
    };

    ws.on("close", onClose);
    ws.on("message", onMessage);
  });
};

const connect = async (player, session) => {
  const ws = new WebSocket(session.cellWebSocketUrl);
  ws.__playerId = player.id;

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.send(
    JSON.stringify({
      type: "register",
      playerId: player.id,
      sessionToken: session.sessionToken,
    }),
  );

  await waitForMessage(
    ws,
    (msg) => msg.type === "registered",
    "registration ack",
  );

  const sendPosition = (position) => {
    ws.send(
      JSON.stringify({
        type: "position",
        position,
      }),
    );
  };

  return { ws, sendPosition };
};

const expectPeers = (message, expectedPeerIds) => {
  if (message.type !== "peers") {
    throw new Error(`Expected peers message, got ${message.type}`);
  }

  const peers = new Set(message.peers ?? []);
  for (const peerId of expectedPeerIds) {
    if (!peers.has(peerId)) {
      throw new Error(`Expected peer ${peerId} in peers list`);
    }
  }
};

const main = async () => {
  const sessionA = await joinWorld(players.a);
  const sessionB = await joinWorld(players.b);

  const connA = await connect(players.a, sessionA);
  const connB = await connect(players.b, sessionB);

  // initial positions within range
  connA.sendPosition(players.a.position);
  connB.sendPosition(players.b.position);

  await waitForMessage(
    connA.ws,
    (msg) => msg.type === "peers" && (msg.peers ?? []).includes(players.b.id),
    "peer add for A",
  );
  const msgB = await waitForMessage(
    connB.ws,
    (msg) => msg.type === "peers" && (msg.peers ?? []).includes(players.a.id),
    "peer add for B",
  );

  expectPeers(msgB, [players.a.id]);

  // move B far away to trigger removal (respect 10 Hz server guardrail)
  await new Promise((resolve) => setTimeout(resolve, 150));
  const farPosition = { x: 200, y: 0, z: 0 };
  connB.sendPosition(farPosition);

  await waitForMessage(
    connA.ws,
    (msg) => msg.type === "peers" && (msg.removed ?? []).includes(players.b.id),
    "peer removal for A",
  );

  connA.ws.close();
  connB.ws.close();
  log("✅ Proximity test passed");
};

main().catch((error) => {
  console.error("❌ Proximity test failed:", error);
  process.exitCode = 1;
});
