#!/usr/bin/env node
/* eslint-env node */
/* global console, process, setTimeout, clearTimeout */
import WebSocket from "ws";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { URL } from "url";

const WORKER_BASE_URL =
  process.env.VOICE_WORKER_URL ?? "https://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 2000;

if (typeof globalThis.fetch !== "function") {
  throw new Error(
    "Global fetch is not available. Use Node 18+ or enable experimental fetch.",
  );
}

const fetch = globalThis.fetch.bind(globalThis);
let fetchAgent;
let wsOptions;

const players = [
  {
    id: "phase1-tester-a",
    position: { x: 0, y: 0, z: 0 },
  },
  {
    id: "phase1-tester-b",
    position: { x: 5, y: 0, z: 0 },
  },
];

const log = (message, ...rest) => {
  console.log(`[voice-test] ${message}`, ...rest);
};

const workerUrl = new URL(WORKER_BASE_URL);
if (workerUrl.protocol !== "https:") {
  throw new Error(
    `Insecure protocol in VOICE_WORKER_URL: ${workerUrl.protocol}`,
  );
}
const caPath = process.env.NODE_EXTRA_CA_CERTS;
console.log("NODE_EXTRA_CA_CERTS:", caPath);
if (!caPath) {
  throw new Error(
    "NODE_EXTRA_CA_CERTS is not set. Set it to a valid CA PEM file.",
  );
}
const resolved = path.resolve(caPath);
try {
  const ca = fs.readFileSync(resolved);
  log(`Using TLS certificate for verification: ${resolved}`);
  fetchAgent = {
    https: new https.Agent({ keepAlive: true, ca, rejectUnauthorized: true }),
  };
  wsOptions = { ca, rejectUnauthorized: true };
} catch (error) {
  throw new Error(
    `Failed to read TLS certificate at ${resolved}. Set NODE_EXTRA_CA_CERTS to a valid CA PEM. (${error?.message ?? error})`,
  );
}

const joinWorld = async (player) => {
  const response = await fetch(`${WORKER_BASE_URL}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId: player.id,
      position: player.position,
    }),
    agent: fetchAgent,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Join failed for ${player.id}: ${detail || response.statusText}`,
    );
  }

  const json = await response.json();
  const { cellId, cellWebSocketUrl, sessionToken, transportMode, iceServers } =
    json;

  if (!cellId || !cellWebSocketUrl || !sessionToken) {
    throw new Error(`Join response missing fields for ${player.id}`);
  }

  log(
    `${player.id} -> joined ${cellId}, transport=${transportMode ?? "p2p"} ws=${cellWebSocketUrl}`,
  );
  log(
    `${player.id} -> iceServers`,
    Array.isArray(iceServers) ? iceServers : "(default or missing)",
  );

  return {
    cellId,
    cellWebSocketUrl,
    sessionToken,
    transportMode,
    iceServers: Array.isArray(iceServers) ? iceServers : [],
  };
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
        log(`${ws.__playerId} <= (invalid json) ${raw}`);
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

const sendJson = (ws, payload) => {
  log(`${ws.__playerId} =>`, payload);
  ws.send(JSON.stringify(payload));
};

const connectPlayer = async (player, joinResult) => {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(joinResult.cellWebSocketUrl, undefined, wsOptions);
    ws.__playerId = player.id;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout opening WebSocket for ${player.id}`));
    }, DEFAULT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("message", onMessage);
      ws.off("open", onOpen);
    };

    const onError = (error) => {
      cleanup();
      reject(
        new Error(
          `WebSocket error for ${player.id}: ${error?.message ?? error}`,
        ),
      );
    };

    const onClose = () => {
      cleanup();
      reject(new Error(`WebSocket closed before register for ${player.id}`));
    };

    const onMessage = (raw) => {
      let parsed;

      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        log(`${player.id} <= (invalid json) ${raw}`);
        return;
      }

      log(`${player.id} <=`, parsed);

      if (parsed.type === "registered") {
        cleanup();
        resolve(ws);
      }
    };

    const onOpen = () => {
      sendJson(ws, {
        type: "register",
        playerId: player.id,
        sessionToken: joinResult.sessionToken,
      });
    };

    ws.on("error", onError);
    ws.on("close", onClose);
    ws.on("message", onMessage);
    ws.on("open", onOpen);
  });
};

const closeSocket = async (ws) => {
  if (!ws) {
    return;
  }

  if (
    ws.readyState === WebSocket.CLOSED ||
    ws.readyState === WebSocket.CLOSING
  ) {
    return;
  }

  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, DEFAULT_TIMEOUT_MS);

    ws.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });

    ws.close(1000, "test complete");
  });
};

const main = async () => {
  log(`Target Worker: ${WORKER_BASE_URL}`);
  const [playerA, playerB] = players;
  const sockets = [];

  try {
    const joinA = await joinWorld(playerA);
    const joinB = await joinWorld(playerB);

    const wsA = await connectPlayer(playerA, joinA);
    const wsB = await connectPlayer(playerB, joinB);
    sockets.push(wsA, wsB);

    sendJson(wsA, { type: "heartbeat" });
    sendJson(wsB, { type: "heartbeat" });

    sendJson(wsA, { type: "position", position: { x: 1, y: 0, z: 0 } });
    sendJson(wsB, { type: "position", position: { x: 6, y: 0, z: 0 } });

    const signalPayload = { test: "hello" };
    sendJson(wsA, {
      type: "signal",
      targetId: playerB.id,
      payload: signalPayload,
    });

    await waitForMessage(
      wsB,
      (message) => message.type === "signal" && message.from === playerA.id,
      "signal relay",
    );

    log("✅ Phase 1 flow succeeded");
  } catch (error) {
    log("❌ Phase 1 flow failed:", error);
    process.exitCode = 1;
  } finally {
    await Promise.all(sockets.map(closeSocket));
  }
};

await main();
