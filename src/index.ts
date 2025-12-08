import {
  getIceServers,
  IceServer,
  resolveVoiceTransportMode,
  VoiceTransportMode,
} from "./config";
import { Vector3, VoiceWorkerEnv } from "./types";
import { makeJsonResponse, uuid } from "./utils";
import { WorldShard } from "./worldShard";

type JoinWorldRequest = {
  playerId: string;
  position: Vector3;
  authToken?: string;
};

type JoinWorldResponse = {
  cellId: string;
  cellWebSocketUrl: string;
  sessionToken: string;
  transportMode: VoiceTransportMode;
  iceServers: IceServer[];
};

const CELL_SIZE_METERS = 64;

const deriveCellId = ({ x, y, z }: Vector3): string => {
  const cellX = Math.floor(x / CELL_SIZE_METERS);
  const cellY = Math.floor(y / CELL_SIZE_METERS);
  const cellZ = Math.floor(z / CELL_SIZE_METERS);

  return `cell:${cellX}:${cellY}:${cellZ}`;
};

const parseJoinRequest = async (
  request: Request,
): Promise<JoinWorldRequest> => {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    throw new Error("Invalid JSON");
  }

  if (body == null || typeof body !== "object") {
    throw new Error("Invalid request body");
  }

  const { playerId, position, authToken } = body as Partial<JoinWorldRequest>;

  if (typeof playerId !== "string" || playerId.trim() === "") {
    throw new Error("playerId is required");
  }

  if (
    position == null ||
    typeof position !== "object" ||
    typeof (position as Vector3).x !== "number" ||
    typeof (position as Vector3).y !== "number" ||
    typeof (position as Vector3).z !== "number"
  ) {
    throw new Error("position must be a {x,y,z} object");
  }

  return {
    playerId,
    position: {
      x: (position as Vector3).x,
      y: (position as Vector3).y,
      z: (position as Vector3).z,
    },
    authToken,
  };
};

const buildCellWebSocketUrl = (request: Request, cellId: string): string => {
  const url = new URL(request.url);
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    .trim();
  const protocol = forwardedProto ?? url.protocol.replace(":", "");
  const host = forwardedHost ?? url.host;

  const result = `${protocol === "https" ? "wss" : "ws"}://${host}/cell/${cellId}`;
  console.log("Built cell WebSocket URL:", result);
  return result;
};

const addCorsHeaders = (response: Response): Response => {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "content-type");
  response.headers.set("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
  response.headers.set("access-control-expose-headers", "content-type");
  return response;
};

const handleJoin = async (
  request: Request,
  env: VoiceWorkerEnv,
): Promise<Response> => {
  try {
    const payload = await parseJoinRequest(request);
    const cellId = deriveCellId(payload.position);
    const sessionToken = uuid();
    const stub = env.WORLD_SHARD.get(env.WORLD_SHARD.idFromName(cellId));

    const prepareResponse = await stub.fetch(
      "https://worldshard.internal/prepare",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          playerId: payload.playerId,
          sessionToken,
        }),
      },
    );

    if (!prepareResponse.ok) {
      const message = await prepareResponse.text();

      return makeJsonResponse(
        {
          error: "Failed to prepare session",
          detail: message || prepareResponse.statusText,
        },
        { status: 500 },
      );
    }

    const transportMode = await resolveVoiceTransportMode(env);
    const response: JoinWorldResponse = {
      cellId,
      cellWebSocketUrl: buildCellWebSocketUrl(request, cellId),
      sessionToken,
      transportMode,
      iceServers: getIceServers(env),
    };

    return makeJsonResponse(response, { status: 200 });
  } catch (error) {
    console.error("Join request failed", error);

    return makeJsonResponse(
      { error: (error as Error).message ?? "Invalid request" },
      { status: 400 },
    );
  }
};

const handleCellRequest = (request: Request, env: VoiceWorkerEnv): Response => {
  const url = new URL(request.url);
  const [, , cellId] = url.pathname.split("/");

  if (!cellId) {
    return new Response("Missing cell id", { status: 400 });
  }

  const stub = env.WORLD_SHARD.get(env.WORLD_SHARD.idFromName(cellId));

  return stub.fetch(new Request("https://worldshard.internal/socket", request));
};

export default {
  async fetch(request: Request, env: VoiceWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return addCorsHeaders(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/join" && request.method === "POST") {
      return addCorsHeaders(await handleJoin(request, env));
    }

    if (url.pathname.startsWith("/cell/")) {
      return handleCellRequest(request, env);
    }

    return addCorsHeaders(new Response("Not Found", { status: 404 }));
  },
};

export { WorldShard };
