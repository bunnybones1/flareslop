import { VoiceWorkerEnv, Vector3 } from "./types";
import { makeJsonResponse, uuid } from "./utils";

type PrepareSessionPayload = {
  playerId: string;
  sessionToken: string;
};

type PendingSession = PrepareSessionPayload & {
  createdAt: number;
};

type PlayerConnection = {
  id: string;
  playerId: string;
  sessionToken: string;
  socket: WebSocket;
  lastSeen: number;
  lastPositionAt?: number;
  position?: Vector3;
};

type AnonymousConnection = {
  id: string;
  socket: WebSocket;
  lastSeen: number;
};

type RelaySignalMessage = {
  type: "signal";
  targetId: string;
  payload: unknown;
};

type RegisterMessage = {
  type: "register";
  playerId: string;
  sessionToken: string;
};

type HeartbeatMessage = {
  type: "heartbeat";
};

type PositionMessage = {
  type: "position";
  position: Vector3;
};

type IncomingSocketMessage =
  | RegisterMessage
  | HeartbeatMessage
  | PositionMessage
  | RelaySignalMessage;

const SESSION_TTL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;
const POSITION_UPDATE_MIN_INTERVAL_MS = 100; // 10 Hz guardrail
const PROXIMITY_RADIUS_METERS = 45;
const PROXIMITY_DEBOUNCE_MS = 50;
const DISTANCE_CHANGE_EPSILON = 0.5;

const distanceBetween = (a: Vector3, b: Vector3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const decodeSocketMessage = (raw: string): IncomingSocketMessage | null => {
  try {
    const parsed = JSON.parse(raw) as IncomingSocketMessage;

    if (
      parsed == null ||
      typeof parsed !== "object" ||
      typeof parsed.type !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

export class WorldShard {
  private readonly pendingSessionsByToken = new Map<string, PendingSession>();
  private readonly pendingSessionsByPlayer = new Map<string, string>();
  private readonly connectionsByPlayer = new Map<string, PlayerConnection>();
  private readonly anonymousConnections = new Map<
    string,
    AnonymousConnection
  >();
  private readonly peerViewByPlayer = new Map<string, Set<string>>();
  private readonly peerDistancesByPlayer = new Map<
    string,
    Map<string, number>
  >();
  private proximityTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly _state: unknown,
    private readonly _env: VoiceWorkerEnv,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/prepare":
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }

        return this.handlePrepare(request);
      case "/socket":
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return new Response("Expected WebSocket upgrade", { status: 426 });
        }

        return this.handleSocket(request);
      default:
        return new Response("Not Found", { status: 404 });
    }
  }

  private async handlePrepare(request: Request): Promise<Response> {
    let payload: PrepareSessionPayload;

    try {
      payload = (await request.json()) as PrepareSessionPayload;
    } catch {
      return makeJsonResponse({ error: "Invalid JSON" }, { status: 400 });
    }

    if (
      payload == null ||
      typeof payload !== "object" ||
      typeof payload.playerId !== "string" ||
      typeof payload.sessionToken !== "string"
    ) {
      return makeJsonResponse({ error: "Invalid payload" }, { status: 400 });
    }

    this.pruneExpiredSessions();

    const existingToken = this.pendingSessionsByPlayer.get(payload.playerId);

    if (existingToken) {
      this.pendingSessionsByToken.delete(existingToken);
      this.pendingSessionsByPlayer.delete(payload.playerId);
    }

    this.pendingSessionsByToken.set(payload.sessionToken, {
      ...payload,
      createdAt: Date.now(),
    });
    this.pendingSessionsByPlayer.set(payload.playerId, payload.sessionToken);

    return makeJsonResponse({ ok: true }, { status: 200 });
  }

  private handleSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = uuid();

    this.anonymousConnections.set(connectionId, {
      id: connectionId,
      socket: server,
      lastSeen: Date.now(),
    });

    server.accept();

    server.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        server.send(
          JSON.stringify({
            type: "error",
            message: "Messages must be JSON string",
          }),
        );
        return;
      }

      const parsed = decodeSocketMessage(event.data);

      if (parsed == null) {
        server.send(
          JSON.stringify({ type: "error", message: "Invalid message format" }),
        );
        return;
      }

      this.handleSocketMessage(connectionId, parsed);
    });

    const closeConnection = () => {
      this.handleDisconnect(connectionId);
    };

    server.addEventListener("close", closeConnection);
    server.addEventListener("error", closeConnection);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private handleSocketMessage(
    connectionId: string,
    message: IncomingSocketMessage,
  ): void {
    console.log("[voice-worker] incoming", connectionId, message.type);

    switch (message.type) {
      case "register":
        this.handleRegister(connectionId, message);
        break;
      case "heartbeat":
        this.handleHeartbeat(connectionId);
        break;
      case "position":
        this.handlePosition(connectionId, message);
        break;
      case "signal":
        this.handleSignalRelay(connectionId, message);
        break;
      default:
        this.sendToConnection(connectionId, {
          type: "error",
          message: "Unknown message type",
        });
    }
  }

  private handleRegister(connectionId: string, message: RegisterMessage): void {
    const connection = this.anonymousConnections.get(connectionId);

    if (!connection) {
      this.sendToConnection(connectionId, {
        type: "error",
        message: "Connection not found",
      });
      return;
    }

    const expectedToken = this.pendingSessionsByToken.get(message.sessionToken);

    if (!expectedToken || expectedToken.playerId !== message.playerId) {
      connection.socket.send(
        JSON.stringify({ type: "error", message: "Invalid session token" }),
      );
      connection.socket.close(4001, "Invalid session token");
      this.anonymousConnections.delete(connectionId);
      return;
    }

    this.pendingSessionsByToken.delete(message.sessionToken);
    this.pendingSessionsByPlayer.delete(message.playerId);

    const registeredConnection: PlayerConnection = {
      id: connectionId,
      playerId: message.playerId,
      sessionToken: message.sessionToken,
      socket: connection.socket,
      lastSeen: Date.now(),
    };

    this.anonymousConnections.delete(connectionId);
    this.connectionsByPlayer.set(message.playerId, registeredConnection);
    this.scheduleCleanup();
    this.scheduleProximityRecalc();

    console.log(
      "[voice-worker] registered",
      message.playerId,
      "conn",
      connectionId,
    );
    console.log(
      "[voice-worker] active players",
      Array.from(this.connectionsByPlayer.keys()),
    );

    registeredConnection.socket.send(
      JSON.stringify({ type: "registered", playerId: message.playerId }),
    );
  }

  private handleHeartbeat(connectionId: string): void {
    const connection = this.lookupConnection(connectionId);

    if (!connection) {
      return;
    }

    connection.lastSeen = Date.now();
  }

  private handlePosition(connectionId: string, message: PositionMessage): void {
    const connection = this.lookupConnection(connectionId);

    if (!connection) {
      return;
    }

    const now = Date.now();

    if (
      connection.lastPositionAt &&
      now - connection.lastPositionAt < POSITION_UPDATE_MIN_INTERVAL_MS
    ) {
      connection.lastSeen = now;
      return;
    }

    connection.position = message.position;
    connection.lastSeen = now;
    connection.lastPositionAt = now;
    this.scheduleProximityRecalc();

    if (!("positionsLogged" in connection)) {
      (
        connection as PlayerConnection & { positionsLogged: number }
      ).positionsLogged = 0;
    }
    const loggedConn = connection as PlayerConnection & {
      positionsLogged: number;
    };
    if (
      loggedConn.positionsLogged < 5 ||
      loggedConn.positionsLogged % 100 === 0
    ) {
      console.log(
        "[voice-worker] position",
        connection.playerId,
        JSON.stringify(message.position),
        "count",
        loggedConn.positionsLogged + 1,
      );
    }
    loggedConn.positionsLogged += 1;
  }

  private handleSignalRelay(
    connectionId: string,
    message: RelaySignalMessage,
  ): void {
    console.log("[voice-worker] handle signal relay");
    const source = this.lookupConnection(connectionId);

    if (!source) {
      console.log(
        "[voice-worker] signal source missing",
        connectionId,
        "target",
        message.targetId,
      );
      return;
    }

    const target = this.connectionsByPlayer.get(message.targetId);

    if (!target) {
      console.log(
        "[voice-worker] signal target missing",
        source.playerId,
        "->",
        message.targetId,
        message.payload && (message.payload as { type?: string }).type,
        "active",
        Array.from(this.connectionsByPlayer.keys()),
      );
      source.socket.send(
        JSON.stringify({
          type: "signal-delivery-failed",
          targetId: message.targetId,
        }),
      );
      return;
    }

    console.log(
      "[voice-worker] signal relay attempt",
      source.playerId,
      "->",
      target.playerId,
      "payload",
      message.payload && (message.payload as { type?: string }).type,
      "lastSeen",
      {
        src: source.lastSeen,
        tgt: target.lastSeen,
      },
    );

    console.log(
      "[voice-worker] relay signal",
      source.playerId,
      "->",
      target.playerId,
      message.payload && (message.payload as { type?: string }).type,
    );

    target.socket.send(
      JSON.stringify({
        type: "signal",
        from: source.playerId,
        payload: message.payload,
      }),
    );
  }

  private handleDisconnect(connectionId: string): void {
    if (this.anonymousConnections.delete(connectionId)) {
      return;
    }

    for (const [playerId, connection] of this.connectionsByPlayer.entries()) {
      if (connection.id === connectionId) {
        this.connectionsByPlayer.delete(playerId);
        connection.socket.close(1001, "Connection closed");
        this.peerViewByPlayer.delete(playerId);
        this.peerDistancesByPlayer.delete(playerId);
        this.scheduleProximityRecalc();
        break;
      }
    }
  }

  private lookupConnection(connectionId: string): PlayerConnection | undefined {
    for (const connection of this.connectionsByPlayer.values()) {
      if (connection.id === connectionId) {
        return connection;
      }
    }

    return undefined;
  }

  private sendToConnection(connectionId: string, payload: unknown): void {
    const anon = this.anonymousConnections.get(connectionId);

    if (anon) {
      anon.socket.send(JSON.stringify(payload));
      return;
    }

    const connection = this.lookupConnection(connectionId);

    if (!connection) {
      return;
    }

    connection.socket.send(JSON.stringify(payload));
  }

  private pruneExpiredSessions(): void {
    const threshold = Date.now() - SESSION_TTL_MS;

    for (const [token, session] of this.pendingSessionsByToken.entries()) {
      if (session.createdAt < threshold) {
        this.pendingSessionsByToken.delete(token);

        const currentToken = this.pendingSessionsByPlayer.get(session.playerId);

        if (currentToken === token) {
          this.pendingSessionsByPlayer.delete(session.playerId);
        }
      }
    }
  }

  private pruneInactiveConnections(): void {
    const threshold = Date.now() - HEARTBEAT_TIMEOUT_MS;
    for (const connection of Array.from(this.connectionsByPlayer.values())) {
      if (connection.lastSeen < threshold) {
        this.handleDisconnect(connection.id);
      }
    }
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer != null) {
      return;
    }

    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null;
      this.pruneInactiveConnections();
      if (this.connectionsByPlayer.size > 0) {
        this.scheduleCleanup();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private scheduleProximityRecalc(): void {
    if (this.proximityTimer != null) {
      return;
    }

    this.proximityTimer = setTimeout(() => {
      this.proximityTimer = null;
      this.recalculateProximities();
    }, PROXIMITY_DEBOUNCE_MS);
  }

  private recalculateProximities(): void {
    const players = Array.from(this.connectionsByPlayer.values());

    for (const player of players) {
      const peers = new Set<string>();
      const distances: Record<string, number> = {};
      const positions: Record<string, Vector3> = {};

      if (player.position) {
        for (const other of players) {
          if (other.playerId === player.playerId || !other.position) {
            continue;
          }

          const distance = distanceBetween(player.position, other.position);

          if (distance <= PROXIMITY_RADIUS_METERS) {
            peers.add(other.playerId);
            distances[other.playerId] = distance;
            positions[other.playerId] = other.position;
          }
        }
      }

      this.publishPeerDiff(player.playerId, peers, distances, positions);
    }
  }

  private publishPeerDiff(
    playerId: string,
    nextPeers: Set<string>,
    distances: Record<string, number>,
    positions: Record<string, Vector3>,
  ): void {
    const connection = this.connectionsByPlayer.get(playerId);

    if (!connection) {
      return;
    }

    const previousPeers =
      this.peerViewByPlayer.get(playerId) ?? new Set<string>();
    const previousDistances =
      this.peerDistancesByPlayer.get(playerId) ?? new Map<string, number>();

    const added: string[] = [];
    const removed: string[] = [];

    for (const peer of nextPeers) {
      if (!previousPeers.has(peer)) {
        added.push(peer);
      }
    }

    for (const peer of previousPeers) {
      if (!nextPeers.has(peer)) {
        removed.push(peer);
      }
    }

    let distanceChanged = false;
    const nextDistanceMap = new Map<string, number>();

    for (const [peerId, distance] of Object.entries(distances)) {
      nextDistanceMap.set(peerId, distance);
      const prev = previousDistances.get(peerId);
      if (
        prev === undefined ||
        Math.abs(prev - distance) > DISTANCE_CHANGE_EPSILON
      ) {
        distanceChanged = true;
      }
    }

    if (added.length === 0 && removed.length === 0 && !distanceChanged) {
      return;
    }

    this.peerViewByPlayer.set(playerId, nextPeers);
    this.peerDistancesByPlayer.set(playerId, nextDistanceMap);

    console.log(
      "[voice-worker] peers update",
      playerId,
      "peers",
      Array.from(nextPeers),
      "distances",
      distances,
      "positions",
      positions,
    );

    connection.socket.send(
      JSON.stringify({
        type: "peers",
        peers: Array.from(nextPeers),
        added: added.length > 0 ? added : undefined,
        removed: removed.length > 0 ? removed : undefined,
        distances: Object.keys(distances).length > 0 ? distances : undefined,
        positions: Object.keys(positions).length > 0 ? positions : undefined,
        totalPlayers: this.connectionsByPlayer.size,
      }),
    );
  }
}
