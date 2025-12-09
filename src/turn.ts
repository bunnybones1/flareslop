import { IceServer, VoiceChatEnv, isIceServerLike } from "./config";

type TurnCredentialsResponse = {
  iceServers?: unknown;
  ttl?: number;
  expiresAt?: string;
};

const DEFAULT_TURN_CACHE_MS = 60_000;
const MIN_TTL_MS = 5_000;
const MAX_TTL_MS = 3_600_000; // 1 hour

const clampTtl = (ms: number): number => {
  if (Number.isNaN(ms) || !Number.isFinite(ms)) {
    return DEFAULT_TURN_CACHE_MS;
  }

  return Math.min(Math.max(ms, MIN_TTL_MS), MAX_TTL_MS);
};

let cached: { iceServers: IceServer[]; expiresAt: number } | null = null;

const computeCacheMs = (
  payload: TurnCredentialsResponse,
  envTtlSeconds: number | undefined,
  now: number,
): number => {
  if (payload.ttl && payload.ttl > 0) {
    return clampTtl(payload.ttl * 1000);
  }

  if (payload.expiresAt) {
    const expiresAtMs = Date.parse(payload.expiresAt);
    if (!Number.isNaN(expiresAtMs)) {
      return clampTtl(expiresAtMs - now - 5000);
    }
  }

  if (envTtlSeconds && envTtlSeconds > 0) {
    return clampTtl(envTtlSeconds * 1000);
  }

  return DEFAULT_TURN_CACHE_MS;
};

export const resolveTurnIceServers = async (
  env: VoiceChatEnv,
): Promise<IceServer[] | null> => {
  const tokenId = env.TURN_TOKEN_ID?.trim();
  const apiToken = env.TURN_API_TOKEN?.trim();

  if (!tokenId || !apiToken) {
    return null;
  }

  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.iceServers;
  }

  const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${tokenId}/credentials/generate-ice-servers`;

  const ttlSeconds = env.TURN_CACHE_TTL_SECONDS
    ? Number.parseInt(env.TURN_CACHE_TTL_SECONDS, 10)
    : undefined;

  let response: Response;
  const params = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type:": "application/json",
    },
    body: JSON.stringify({ ttl: 86400 }),
    // curl \
    // -H "Authorization: Bearer 91fac345ae6591e317eb7d81b352cfa3ed83c41b36b7fbf68c9733196a84e261" \
    // -H "Content-Type: application/json" -d '{"ttl": 86400}' \
  };
  try {
    response = await fetch(url, params);
  } catch (error) {
    console.error(
      "TURN credentials request failed",
      error,
      JSON.stringify(params),
    );
    return null;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(
      "TURN credentials request returned non-OK",
      response.status,
      detail,
    );
    return null;
  }

  let payload: TurnCredentialsResponse;
  try {
    payload = (await response.json()) as TurnCredentialsResponse;
  } catch (error) {
    console.error("Failed to parse TURN credentials response", error);
    return null;
  }

  if (!Array.isArray(payload.iceServers)) {
    console.error("TURN credentials response missing iceServers array");
    return null;
  }

  const validated = payload.iceServers.filter(isIceServerLike) as IceServer[];

  if (validated.length === 0) {
    console.error("TURN credentials response contained no valid ICE servers");
    return null;
  }

  const cacheMs = computeCacheMs(payload, ttlSeconds, now);
  cached = {
    iceServers: validated,
    expiresAt: now + cacheMs,
  };

  console.log(
    `Fetched ${validated.length} TURN ICE servers, caching for ${cacheMs} ms`,
  );
  console.debug("TURN ICE servers:", validated);

  return validated;
};
