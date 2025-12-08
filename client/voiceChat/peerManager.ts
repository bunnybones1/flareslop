import { PeerDiffMessage, Vector3 } from "./types";

const debug = (...args: unknown[]) => console.log("[voice-peer]", ...args);

export interface VoicePeerManagerOptions {
  connectRadius: number;
  disconnectRadiusMultiplier?: number;
  maxPeers?: number;
  evaluationDebounceMs?: number;
}

export type PeerConnectionListener = (peerId: string) => void;

type PeerState = {
  id: string;
  distance: number;
  lastUpdated: number;
  hasExplicitDistance: boolean;
};

const DEFAULT_OPTIONS: Required<
  Omit<VoicePeerManagerOptions, "connectRadius">
> & {
  connectRadius: number;
} = {
  connectRadius: 30,
  disconnectRadiusMultiplier: 1.5,
  maxPeers: 8,
  evaluationDebounceMs: 250,
};

const distanceBetween = (a: Vector3, b: Vector3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export class VoicePeerManager {
  private readonly options: Required<VoicePeerManagerOptions>;
  private readonly candidateIds = new Set<string>();
  private readonly peerStates = new Map<string, PeerState>();
  private readonly connectedPeers = new Set<string>();
  private readonly connectListeners = new Set<PeerConnectionListener>();
  private readonly disconnectListeners = new Set<PeerConnectionListener>();
  private localPosition: Vector3 | null = null;
  private readonly peerPositions = new Map<string, Vector3>();
  private evaluateTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: VoicePeerManagerOptions) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  dispose(): void {
    if (this.evaluateTimer != null) {
      clearTimeout(this.evaluateTimer);
      this.evaluateTimer = null;
    }

    this.connectListeners.clear();
    this.disconnectListeners.clear();
    this.disposed = true;
  }

  onConnect(listener: PeerConnectionListener): () => void {
    this.connectListeners.add(listener);
    return () => {
      this.connectListeners.delete(listener);
    };
  }

  onDisconnect(listener: PeerConnectionListener): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  getActivePeers(): string[] {
    return Array.from(this.connectedPeers);
  }

  hasPeer(peerId: string): boolean {
    return this.connectedPeers.has(peerId);
  }

  getPeerDistance(peerId: string): number | null {
    const state = this.peerStates.get(peerId);
    return state ? state.distance : null;
  }

  getPeerPosition(peerId: string): Vector3 | undefined {
    return this.peerPositions.get(peerId);
  }

  updateLocalPosition(position: Vector3): void {
    this.localPosition = position;
    for (const [peerId, remotePosition] of this.peerPositions.entries()) {
      this.setDistance(
        peerId,
        distanceBetween(position, remotePosition),
        false,
      );
    }

    this.scheduleEvaluate();
  }

  updatePeerPosition(peerId: string, position: Vector3 | null): void {
    if (position == null) {
      this.peerPositions.delete(peerId);
      const state = this.peerStates.get(peerId);
      if (state) {
        state.hasExplicitDistance = false;
        this.setDistance(peerId, Number.POSITIVE_INFINITY, false);
      }

      this.scheduleEvaluate();
      return;
    }

    this.peerPositions.set(peerId, position);

    if (this.localPosition != null) {
      this.setDistance(
        peerId,
        distanceBetween(this.localPosition, position),
        false,
      );
    } else {
      this.setDistance(peerId, Number.POSITIVE_INFINITY, false);
    }

    this.scheduleEvaluate();
  }

  updatePeerDistance(peerId: string, distance: number | null): void {
    const normalized = distance == null ? Number.POSITIVE_INFINITY : distance;
    this.setDistance(peerId, normalized, true);
    this.scheduleEvaluate();
  }

  applyPeerDiff(diff: PeerDiffMessage): void {
    debug(
      "applyPeerDiff",
      "peers",
      diff.peers,
      "added",
      diff.added,
      "removed",
      diff.removed,
      "distances",
      diff.distances,
    );
    if (diff.peers) {
      const newSet = new Set(diff.peers);
      for (const peerId of this.candidateIds) {
        if (!newSet.has(peerId)) {
          this.candidateIds.delete(peerId);
        }
      }

      for (const peerId of diff.peers) {
        this.candidateIds.add(peerId);
      }
    } else {
      if (diff.added) {
        for (const peerId of diff.added) {
          this.candidateIds.add(peerId);
        }
      }

      if (diff.removed) {
        for (const peerId of diff.removed) {
          this.candidateIds.delete(peerId);
        }
      }
    }

    if (diff.distances) {
      for (const [peerId, distance] of Object.entries(diff.distances)) {
        this.updatePeerDistance(peerId, distance);
      }
    }

    if (diff.positions) {
      for (const [peerId, position] of Object.entries(diff.positions)) {
        this.updatePeerPosition(peerId, position);
      }
    }

    if (diff.removed) {
      for (const peerId of diff.removed) {
        this.updatePeerPosition(peerId, null);
      }
    }

    this.scheduleEvaluate();
  }

  removePeer(peerId: string): void {
    this.candidateIds.delete(peerId);
    this.peerPositions.delete(peerId);
    this.peerStates.delete(peerId);

    if (this.connectedPeers.delete(peerId)) {
      this.emitDisconnect(peerId);
    }
  }

  private setDistance(
    peerId: string,
    distance: number,
    explicit: boolean,
  ): void {
    const existing = this.peerStates.get(peerId);
    if (existing) {
      existing.distance = distance;
      existing.lastUpdated = Date.now();
      existing.hasExplicitDistance = explicit;
    } else {
      this.peerStates.set(peerId, {
        id: peerId,
        distance,
        lastUpdated: Date.now(),
        hasExplicitDistance: explicit,
      });
    }
  }

  private scheduleEvaluate(): void {
    if (this.disposed) {
      return;
    }

    if (this.evaluateTimer != null) {
      return;
    }

    this.evaluateTimer = setTimeout(() => {
      this.evaluateTimer = null;
      this.evaluate();
    }, this.options.evaluationDebounceMs);
  }

  private evaluate(): void {
    if (this.disposed) {
      return;
    }

    const connectThreshold = this.options.connectRadius;
    const disconnectThreshold =
      connectThreshold * this.options.disconnectRadiusMultiplier;
    const now = Date.now();

    const keepConnected = new Set<string>();
    const toDisconnect: string[] = [];

    for (const peerId of this.connectedPeers) {
      if (!this.candidateIds.has(peerId)) {
        toDisconnect.push(peerId);
        continue;
      }

      const state = this.peerStates.get(peerId);
      const distance = state?.distance ?? Number.POSITIVE_INFINITY;

      if (distance <= disconnectThreshold) {
        keepConnected.add(peerId);
      } else {
        toDisconnect.push(peerId);
      }
    }

    for (const peerId of toDisconnect) {
      if (this.connectedPeers.delete(peerId)) {
        this.emitDisconnect(peerId);
      }
    }

    const remainingSlots = Math.max(
      this.options.maxPeers - keepConnected.size,
      0,
    );

    if (remainingSlots === 0) {
      return;
    }

    const candidates: PeerState[] = [];

    for (const peerId of this.candidateIds) {
      if (keepConnected.has(peerId) || this.connectedPeers.has(peerId)) {
        continue;
      }

      const state = this.peerStates.get(peerId);

      if (!state) {
        continue;
      }

      const distance = state.distance;

      if (distance > connectThreshold) {
        continue;
      }

      candidates.push(state);
    }

    candidates.sort((a, b) => a.distance - b.distance);

    // debug(
    //   "evaluate",
    //   "localPos",
    //   this.localPosition,
    //   "candidates",
    //   candidates.map((c) => [c.id, c.distance.toFixed(2)]),
    //   "connected",
    //   Array.from(this.connectedPeers)
    // );

    for (let i = 0; i < Math.min(remainingSlots, candidates.length); i += 1) {
      const peerId = candidates[i].id;

      this.connectedPeers.add(peerId);
      keepConnected.add(peerId);
      this.emitConnect(peerId);
    }

    // Prune stale state to keep memory bounded.
    for (const [peerId, state] of this.peerStates.entries()) {
      if (now - state.lastUpdated > 60_000 && !this.candidateIds.has(peerId)) {
        this.peerStates.delete(peerId);
        this.peerPositions.delete(peerId);
      }
    }
  }

  private emitConnect(peerId: string): void {
    for (const listener of this.connectListeners) {
      listener(peerId);
    }
  }

  private emitDisconnect(peerId: string): void {
    for (const listener of this.disconnectListeners) {
      listener(peerId);
    }
  }
}
