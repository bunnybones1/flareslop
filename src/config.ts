export const SFU_FLAG_KV_KEY = "feature:voice:transport:sfu";

export enum VoiceTransportMode {
  P2P = "p2p",
  SFU = "sfu",
}

export const DEFAULT_TURN_API_URL = "https://rtc.live.cloudflare.com/v1/turn/credentials";

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

type MaybeKvNamespace = {
  get: (key: string) => Promise<string | null> | string | null;
};

export interface VoiceChatEnv {
  FEATURE_SFU_ENABLED?: string;
  VOICE_FEATURE_FLAGS?: MaybeKvNamespace;
  ICE_SERVERS_JSON?: string;
  TURN_TOKEN_ID?: string;
  TURN_API_TOKEN?: string;
  TURN_API_URL?: string;
  TURN_CACHE_TTL_SECONDS?: string;
}

const toBoolean = (value: string | null | undefined): boolean | undefined => {
  if (value == null) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
};

export const isSfuEnabled = async (env: VoiceChatEnv): Promise<boolean> => {
  const kv = env.VOICE_FEATURE_FLAGS;

  if (kv != null) {
    const kvValue = await kv.get(SFU_FLAG_KV_KEY);
    const parsedKv = toBoolean(
      typeof kvValue === "string" ? kvValue : String(kvValue),
    );

    if (parsedKv !== undefined) {
      return parsedKv;
    }
  }

  const fallback = toBoolean(env.FEATURE_SFU_ENABLED);

  return fallback ?? false;
};

export const resolveVoiceTransportMode = async (
  env: VoiceChatEnv,
): Promise<VoiceTransportMode> => {
  return (await isSfuEnabled(env))
    ? VoiceTransportMode.SFU
    : VoiceTransportMode.P2P;
};

const DEFAULT_ICE_SERVERS: IceServer[] = [
  {
    urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"],
  },
];

export const isIceServerLike = (value: unknown): value is IceServer => {
  if (value == null || typeof value !== "object") {
    return false;
  }

  const { urls, username, credential } = value as Record<string, unknown>;
  const urlsValid =
    typeof urls === "string" ||
    (Array.isArray(urls) && urls.every((entry) => typeof entry === "string"));

  if (!urlsValid) {
    return false;
  }

  if (username != null && typeof username !== "string") {
    return false;
  }

  if (credential != null && typeof credential !== "string") {
    return false;
  }

  return true;
};

export const getIceServers = (env: VoiceChatEnv): IceServer[] => {
  const raw = env.ICE_SERVERS_JSON;

  if (typeof raw === "string" && raw.trim().length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;

      if (Array.isArray(parsed)) {
        const validated = parsed.filter(isIceServerLike) as IceServer[];

        if (validated.length > 0) {
          return validated;
        }
      }
    } catch (error) {
      console.warn("Failed to parse ICE_SERVERS_JSON:", error);
    }
  }

  return DEFAULT_ICE_SERVERS;
};
