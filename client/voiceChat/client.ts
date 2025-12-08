import { VoiceTransportMode, setVoiceFeatureFlags } from "./featureFlags";
import { VoicePeerManager } from "./peerManager";
import {
  Vector3,
  PeerDiffMessage,
  SignalMessage,
  CellServerMessage,
} from "./types";

export type JoinWorldOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  playerId: string;
  position: Vector3;
  authToken?: string;
};

export type JoinWorldResult = {
  cellId: string;
  cellWebSocketUrl: string;
  sessionToken: string;
  transportMode: VoiceTransportMode;
  iceServers: RTCIceServer[];
};

export type ConnectCellOptions = {
  url: string;
  playerId: string;
  sessionToken: string;
  webSocketFactory?: typeof WebSocket;
};

type PositionUpdateLoopOptions = {
  intervalMs?: number;
  peerManager?: VoicePeerManager;
  onSend?: (position: Vector3) => void;
};

const DEFAULT_BASE_PATH = "";

const ensureAbsoluteJoinUrl = (baseUrl?: string): string => {
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "");
  }

  if (typeof window !== "undefined") {
    return window.location.origin + DEFAULT_BASE_PATH;
  }

  return DEFAULT_BASE_PATH;
};

const parseJoinResponse = async (
  response: Response,
): Promise<JoinWorldResult> => {
  let json: unknown;

  try {
    json = await response.json();
  } catch {
    throw new Error("Unable to parse join response");
  }

  if (json == null || typeof json !== "object") {
    throw new Error("Join response is malformed");
  }

  const { cellId, cellWebSocketUrl, sessionToken, transportMode, iceServers } =
    json as Partial<JoinWorldResult>;

  if (
    typeof cellId !== "string" ||
    typeof cellWebSocketUrl !== "string" ||
    typeof sessionToken !== "string"
  ) {
    throw new Error("Join response missing fields");
  }

  const mode =
    transportMode === VoiceTransportMode.SFU
      ? VoiceTransportMode.SFU
      : VoiceTransportMode.P2P;

  return {
    cellId,
    cellWebSocketUrl,
    sessionToken,
    transportMode: mode,
    iceServers: Array.isArray(iceServers) ? (iceServers as RTCIceServer[]) : [],
  };
};

export const joinWorld = async (
  options: JoinWorldOptions,
): Promise<JoinWorldResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = ensureAbsoluteJoinUrl(options.baseUrl);
  const response = await fetchImpl(`${baseUrl}/join`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      playerId: options.playerId,
      position: options.position,
      authToken: options.authToken,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Join failed: ${detail || response.statusText}`);
  }

  const joinResult = await parseJoinResponse(response);

  setVoiceFeatureFlags({
    sfuEnabled: joinResult.transportMode === VoiceTransportMode.SFU,
  });

  return joinResult;
};

type HandlerDisposer = () => void;

export class VoiceCellConnection {
  private readonly ws: WebSocket;
  private readonly playerId: string;
  private readonly sessionToken: string;
  private readonly peerHandlers = new Set<(message: PeerDiffMessage) => void>();
  private readonly signalHandlers = new Set<(message: SignalMessage) => void>();
  private readonly deliveryFailureHandlers = new Set<
    (targetId: string) => void
  >();
  private readonly errorHandlers = new Set<(message: string) => void>();
  private isRegistered = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private positionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(socket: WebSocket, playerId: string, sessionToken: string) {
    this.ws = socket;
    this.playerId = playerId;
    this.sessionToken = sessionToken;

    this.ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }

      this.handleServerMessage(event.data);
    });

    this.ws.addEventListener("close", () => {
      this.stopHeartbeat();
      this.stopPositionUpdates();
      console.log("[voice] ws close", this.playerId, this.ws.readyState);
    });
  }

  register(): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }

    this.ws.send(
      JSON.stringify({
        type: "register",
        playerId: this.playerId,
        sessionToken: this.sessionToken,
      }),
    );
  }

  sendHeartbeat(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }

  sendPosition(position: Vector3): void {
    if (this.ws.readyState !== WebSocket.OPEN || !this.isRegistered) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: "position",
        position,
      }),
    );
  }

  sendSignal(targetId: string, payload: unknown): void {
    const ready = this.ws.readyState;
    const registered = this.isRegistered;
    if (ready !== WebSocket.OPEN || !registered) {
      console.warn(
        "[voice] skip sendSignal, ws not open or not registered",
        "readyState",
        ready,
        "registered",
        registered,
      );
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: "signal",
        targetId,
        payload,
      }),
    );
    console.log(
      "[voice] send signal",
      "target",
      targetId,
      payload && (payload as { type?: string }).type,
      "readyState",
      ready,
    );
  }

  onPeersChange(handler: (message: PeerDiffMessage) => void): HandlerDisposer {
    this.peerHandlers.add(handler);
    return () => {
      this.peerHandlers.delete(handler);
    };
  }

  onSignal(handler: (message: SignalMessage) => void): HandlerDisposer {
    this.signalHandlers.add(handler);
    return () => {
      this.signalHandlers.delete(handler);
    };
  }

  onSignalDeliveryFailed(handler: (targetId: string) => void): HandlerDisposer {
    this.deliveryFailureHandlers.add(handler);
    return () => {
      this.deliveryFailureHandlers.delete(handler);
    };
  }

  onError(handler: (message: string) => void): HandlerDisposer {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }

  startHeartbeat(intervalMs = 10_000): () => void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    return () => this.stopHeartbeat();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startPositionUpdates(
    getPosition: () => Vector3 | null | undefined,
    options: PositionUpdateLoopOptions = {},
  ): () => void {
    const intervalMs = Math.max(options.intervalMs ?? 150, 100); // respect 10 Hz server limit
    let sentCount = 0;
    const loop = () => {
      if (this.ws.readyState !== WebSocket.OPEN || !this.isRegistered) {
        if (sentCount === 0) {
          console.log(
            "[voice] skip position send (ws not ready or not registered)",
          );
        }
        return;
      }

      const position = getPosition();
      if (!position) {
        return;
      }

      this.sendPosition(position);
      options.peerManager?.updateLocalPosition(position);
      options.onSend?.(position);
      if (sentCount < 5 || sentCount % 50 === 0) {
        console.log("[voice] send position", position, "count", sentCount + 1);
      }
      sentCount += 1;
    };

    loop(); // send immediately

    if (this.positionTimer != null) {
      clearInterval(this.positionTimer);
    }

    this.positionTimer = setInterval(loop, intervalMs);

    return () => this.stopPositionUpdates();
  }

  private stopPositionUpdates(): void {
    if (this.positionTimer != null) {
      clearInterval(this.positionTimer);
      this.positionTimer = null;
    }
  }

  attachPeerManager(manager: VoicePeerManager): () => void {
    const disposers: HandlerDisposer[] = [];

    disposers.push(
      this.onPeersChange((message) => {
        manager.applyPeerDiff(message);
      }),
    );

    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }

  private handleServerMessage(raw: string): void {
    let parsed: CellServerMessage | null = null;

    try {
      parsed = JSON.parse(raw) as CellServerMessage;
    } catch {
      parsed = null;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { type?: unknown }).type !== "string"
    ) {
      return;
    }

    switch (parsed.type) {
      case "registered":
        console.log("[voice] registered", this.playerId);
        this.isRegistered = true;
        break;
      case "signal":
        console.log(
          "[voice] signal from server",
          parsed.from,
          parsed.payload && (parsed.payload as { type?: string }).type,
        );
        for (const handler of this.signalHandlers) {
          handler(parsed);
        }
        break;
      case "signal-delivery-failed":
        console.warn("[voice] signal delivery failed", parsed.targetId);
        for (const handler of this.deliveryFailureHandlers) {
          handler(parsed.targetId);
        }
        break;
      case "error":
        console.warn("[voice] server error", parsed.message);
        for (const handler of this.errorHandlers) {
          handler(parsed.message);
        }
        break;
      case "peers":
        for (const handler of this.peerHandlers) {
          handler(parsed);
        }
        break;
      default:
        break;
    }
  }
}

export const connectCellWS = async (
  options: ConnectCellOptions,
): Promise<VoiceCellConnection> => {
  const WebSocketCtor = options.webSocketFactory ?? WebSocket;
  const ws = new WebSocketCtor(options.url);
  const connection = new VoiceCellConnection(
    ws,
    options.playerId,
    options.sessionToken,
  );

  await new Promise<void>((resolve, reject) => {
    const handleOpen = (): void => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleCloseBeforeOpen);
      resolve();
    };

    const handleError = (event: Event): void => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleCloseBeforeOpen);
      reject(new Error(`WebSocket error: ${event.type}`));
    };

    const handleCloseBeforeOpen = (event: CloseEvent): void => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
      ws.removeEventListener("close", handleCloseBeforeOpen);
      reject(
        new Error(
          `WebSocket closed before open: ${event.code} ${event.reason}`,
        ),
      );
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
    ws.addEventListener("close", handleCloseBeforeOpen);
  });

  connection.register();

  return connection;
};

export type {
  Vector3,
  PeerDiffMessage,
  SignalMessage,
  CellServerMessage,
} from "./types";
export { VoicePeerManager } from "./peerManager";
export type { VoicePeerManagerOptions } from "./peerManager";
