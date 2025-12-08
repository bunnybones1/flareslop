# Multiplayer Proximity Voice Chat Plan (Cloudflare Workers + Durable Objects)

Goal: Ship reliable proximity voice chat for the 3D world with minimal infrastructure and predictable costs.

Approach

- Default to a WebRTC P2P mesh while Durable Objects handle presence, signaling, and peer selection.
- Keep an SFU path behind a feature flag for dense gatherings or tough NAT scenarios.
- Lean Worker state, client-side audio processing, and guardrails (hysteresis, caps) to control churn and spend.

Phase 1 — Discovery & Signaling

- Objective: connect clients to the right Durable Object and relay signaling safely.
- Key tasks: hash player position → cell id, expose `/join` + `/cell/:id` routes, track players + connections, forward offers/answers/candidates, enforce auth/heartbeats.
- Deliverable: Worker entrypoints, WorldShard DO, and a minimal client SDK that can join and exchange signaling messages.

Phase 2 — Presence & Proximity Logic

- Objective: server decides who can talk to whom.
- Key tasks: accept position updates (≤10 Hz), bucket players in grid cells, compute proximity sets with hysteresis and debounce, emit membership diffs.
- Deliverable: stable peer lists per player and churn metrics to validate tuning.

Phase 3 — Voice Transport

- Objective: move audio between proximate players efficiently.
- Key tasks: maintain RTCPeerConnections only for active peers, cap at ~8, reuse connections during movement, configure STUN + TURN, prefer Opus mono with DTX and browser audio pipelines.
- Deliverable: working voice chat for small groups plus logic to shed far peers gracefully.

Phase 4 — Spatialization & Controls

- Objective: make audio feel grounded in the world and give players simple controls.
- Key tasks: Web Audio API panners per remote stream, distance attenuation + cones, push-to-talk/mute UI, optional VAD, client block/mute list propagated to the Worker.
- Deliverable: spatial audio layer with user-facing controls.

Phase 5 — Production Hardening

- Objective: secure, resilient service that tolerates cell churn and disconnections.
- Key tasks: JWT auth, authorization checks in DO, heartbeats + timeouts, alarms for cleanup, dual-cell handoff during migration, population caps per cell, bitrate/DTX limits.
- Deliverable: hardened Worker + DO code ready for broader testing.

Phase 6 — Monitoring & Cost Control

- Objective: keep visibility on quality and spend.
- Key tasks: metrics for DO population/edges, signaling volume, connect success; sampled logs with correlation ids; client getStats sampling; adjust cell size or peer caps as cost levers.
- Deliverable: dashboards/alerts and documented tuning levers.

Operational Notes

- Data structures: players map, grid buckets, proximity edges, per-target signaling queue.
- Rapid movers: widen hysteresis floor and clamp update rate.
- Dormant tabs: detect visibility changes, downgrade update cadence, pause audio capture.
- Abuse: per-player mute, VAD rate limits, moderator overrides.

Next Steps

- [Done] Feature flag scaffold for mesh/SFU toggle (`workers/voice-chat/wrangler.toml`, `src/voiceChat/featureFlags.ts`, `docs/voice-chat/feature-flags.md`).
- [Done] Phase 1 DO + client SDK skeleton (`workers/voice-chat/src/index.ts`, `src/voiceChat/client.ts`).
- [Done] Stand up TURN and surface ICE config securely (see `workers/voice-chat/src/config.ts`, `/join` response in `workers/voice-chat/src/index.ts`, client handling in `src/voiceChat/client.ts`, and setup docs in `docs/voice-chat/ice-config.md`).
- [Done] Implement peer limit + hysteresis in the client (see `src/voiceChat/peerManager.ts`, `src/voiceChat/client.ts`, and docs in `docs/voice-chat/peer-management.md`).
