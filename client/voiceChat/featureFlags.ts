export enum VoiceTransportMode {
  P2P = "p2p",
  SFU = "sfu",
}

export type VoiceFeatureFlags = {
  sfuEnabled: boolean;
};

const DEFAULT_FLAGS: VoiceFeatureFlags = {
  sfuEnabled: false,
};

let cachedFlags: VoiceFeatureFlags | null = null;

const coerceBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }

    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  return undefined;
};

const readFlagsFromRuntime = (): VoiceFeatureFlags => {
  if (typeof globalThis === "undefined") {
    return DEFAULT_FLAGS;
  }

  const maybeWindowFlags = (globalThis as Record<string, unknown>)
    .__VOICE_FEATURE_FLAGS__;
  const sfuEnabledFromWindow =
    maybeWindowFlags != null && typeof maybeWindowFlags === "object"
      ? coerceBoolean((maybeWindowFlags as Record<string, unknown>).sfu)
      : undefined;

  let envFlag: boolean | undefined;

  if (typeof import.meta !== "undefined") {
    const metaWithEnv = import.meta as ImportMeta & {
      env?: Record<string, unknown>;
    };

    envFlag = coerceBoolean(metaWithEnv.env?.VITE_FEATURE_SFU_ENABLED);
  }

  const sfuEnabled =
    sfuEnabledFromWindow ?? envFlag ?? DEFAULT_FLAGS.sfuEnabled;

  return {
    sfuEnabled,
  };
};

export const setVoiceFeatureFlags = (flags: VoiceFeatureFlags): void => {
  cachedFlags = { ...flags };
};

export const getVoiceFeatureFlags = (): VoiceFeatureFlags => {
  if (cachedFlags != null) {
    return cachedFlags;
  }

  cachedFlags = readFlagsFromRuntime();

  return cachedFlags;
};

export const isSfuEnabled = (): boolean => {
  return getVoiceFeatureFlags().sfuEnabled;
};

export const getVoiceTransportMode = (): VoiceTransportMode => {
  return isSfuEnabled() ? VoiceTransportMode.SFU : VoiceTransportMode.P2P;
};
