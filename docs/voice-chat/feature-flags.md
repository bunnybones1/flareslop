# Voice Chat Feature Flags

The voice chat stack defaults to a peer-to-peer mesh transport. The SFU path remains available behind a feature flag so we can switch transports without redeploying client code.

## Worker Configuration

- `FEATURE_SFU_ENABLED` (string): `"false"` by default, forcing the Worker to advertise the P2P mesh mode.
- Optional KV override: bind a namespace as `VOICE_FEATURE_FLAGS` and set the key `feature:voice:transport:sfu` to `"true"` or `"false"`. This value, when present, wins over the environment default and lets you flip the transport mode at runtime.

To enable SFU globally:

```sh
wrangler kv:key put VOICE_FEATURE_FLAGS feature:voice:transport:sfu true
```

To revert to the mesh:

```sh
wrangler kv:key put VOICE_FEATURE_FLAGS feature:voice:transport:sfu false
```

If you omit the KV override, the Worker falls back to the `FEATURE_SFU_ENABLED` value declared in `wrangler.toml`.

## Client Usage

`src/voiceChat/featureFlags.ts` exposes helpers:

- `getVoiceTransportMode()` returns `"p2p"` or `"sfu"`.
- `isSfuEnabled()` returns a boolean.
- `setVoiceFeatureFlags()` lets you inject runtime flags (e.g. from the Worker handshake) and cache them locally.

Without overrides, the client also defaults to the mesh transport. You can pre-seed the flag by uncommenting the `__VOICE_FEATURE_FLAGS__` global in the HTML shell or by shipping a handshake response from the Worker in a future step.
