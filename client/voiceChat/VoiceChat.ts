import {
  Mesh,
  MeshBasicMaterial,
  CapsuleGeometry,
  Color,
  Scene,
  PerspectiveCamera,
} from "three";
import {
  connectCellWS,
  joinWorld,
  VoiceCellConnection,
  VoicePeerManager,
  type Vector3,
} from "./client";

const voicePeerManager = new VoicePeerManager({
  connectRadius: 45, // align with server proximity radius to ensure peers connect
  disconnectRadiusMultiplier: 1.5,
});
const voiceDebug = (...args: unknown[]) => console.log("[voice]", ...args);
const AudioCtx =
  typeof AudioContext !== "undefined"
    ? AudioContext
    : (typeof window !== "undefined" &&
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext) ||
      undefined;
const audioCtx = typeof AudioCtx !== "undefined" ? new AudioCtx() : null;
const voiceBaseUrl =
  (import.meta as { env?: { VITE_VOICE_WORKER_URL?: string } }).env
    ?.VITE_VOICE_WORKER_URL ||
  (typeof window !== "undefined" && window.location.port === "5173"
    ? window.location.origin.replace("5173", "8787")
    : undefined);

export default class VoiceChat {
  constructor(
    private scene: Scene,
    private camera: PerspectiveCamera,
  ) {
    this.init();
  }
  rtcPeers = new Map<string, RTCPeerConnection>();
  peerAudioNodes = new Map<
    string,
    { source: MediaStreamAudioSourceNode; panner: PannerNode; gain: GainNode }
  >();
  peerDataChannels = new Map<string, RTCDataChannel>();
  peerCapsules = new Map<string, Mesh>();
  peerPositions = new Map<string, Vector3>();
  peerCapsuleGeometry = new CapsuleGeometry(0.25, 1, 4, 6);
  baseCapsuleMaterial = new MeshBasicMaterial({ color: new Color("#4af7ff") });
  localStream: MediaStream | null = null;
  iceServers: RTCIceServer[] = [];
  connection: VoiceCellConnection | null = null;
  micReady = false;
  selfId: string | null = null;
  negotiationLocks = new Set<string>();
  voiceUi = document.createElement("div");
  totalPlayers: number | null = null;

  updatePannerPosition(peerId: string) {
    const nodes = this.peerAudioNodes.get(peerId);
    if (!nodes) return;

    const peerPos = voicePeerManager.getPeerPosition(peerId);
    if (!peerPos) {
      return;
    }
    const relPos = this.camera.position.clone().sub(peerPos);

    const distance = relPos.length();
    const clamped = Math.min(Math.max(distance, 1), 80);
    const angle = Math.atan2(relPos.z, relPos.x) - this.camera.rotation.y;
    const x = Math.cos(angle) * clamped;
    const z = Math.sin(angle) * clamped;
    const y = 0;

    nodes.panner.positionX.value = x;
    nodes.panner.positionY.value = y;
    nodes.panner.positionZ.value = z;
  }

  async init() {
    const renderUi = () => {
      const status = this.micReady
        ? "Voice: mic ready"
        : "Voice: tap to enable mic";
      const count =
        typeof this.totalPlayers === "number"
          ? ` • players: ${Math.max(this.totalPlayers, 1)}`
          : "";
      this.voiceUi.textContent = `${status}${count}`;
    };

    const setupUi = (requestMic: () => void) => {
      this.voiceUi.style.position = "fixed";
      this.voiceUi.style.left = "12px";
      this.voiceUi.style.bottom = "12px";
      this.voiceUi.style.padding = "8px 10px";
      this.voiceUi.style.background = "rgba(0,0,0,0.5)";
      this.voiceUi.style.color = "#fff";
      this.voiceUi.style.fontSize = "12px";
      this.voiceUi.style.borderRadius = "6px";
      this.voiceUi.style.cursor = "pointer";
      this.voiceUi.addEventListener("click", requestMic);
      document.body.appendChild(this.voiceUi);
    };

    const ensureLocalStream = async (): Promise<MediaStream | null> => {
      if (this.localStream) return this.localStream;
      if (!navigator.mediaDevices?.getUserMedia) {
        console.warn("Voice chat: getUserMedia not available");
        return null;
      }

      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            noiseSuppression: false,
            echoCancellation: false,
            autoGainControl: true,
          },
          video: false,
        });
        voiceDebug("mic stream acquired", this.localStream.id);
        return this.localStream;
      } catch (error) {
        console.warn("Voice chat: mic capture failed", error);
        return null;
      }
    };

    const stableAngleForPeer = (peerId: string): number => {
      let hash = 0;
      for (let i = 0; i < peerId.length; i += 1) {
        hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
      }
      return (hash / 0xffffffff) * Math.PI * 2;
    };

    const ensurePeerCapsule = (peerId: string): Mesh => {
      let mesh = this.peerCapsules.get(peerId);
      if (mesh) {
        return mesh;
      }
      const angle = stableAngleForPeer(peerId);
      const color = new Color().setHSL(
        (angle / (Math.PI * 2)) * 0.9,
        0.6,
        0.55,
      );
      const material = this.baseCapsuleMaterial.clone();
      material.color = color;

      mesh = new Mesh(this.peerCapsuleGeometry, material);
      mesh.name = `peer-${peerId}`;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.peerCapsules.set(peerId, mesh);
      return mesh;
    };

    const removePeerCapsule = (peerId: string) => {
      const mesh = this.peerCapsules.get(peerId);
      if (!mesh) return;
      this.scene.remove(mesh);
      if (mesh.material) {
        const material = mesh.material as MeshBasicMaterial;
        material.dispose();
      }
      this.peerCapsules.delete(peerId);
      this.peerPositions.delete(peerId);
    };

    const updatePeerCapsulePosition = (peerId: string, position: Vector3) => {
      const mesh = ensurePeerCapsule(peerId);
      mesh.position.set(position.x, position.y, position.z);
      mesh.updateMatrixWorld();
      this.peerPositions.set(peerId, position);
    };

    const isVector3 = (value: unknown): value is Vector3 => {
      return (
        value != null &&
        typeof value === "object" &&
        typeof (value as Vector3).x === "number" &&
        typeof (value as Vector3).y === "number" &&
        typeof (value as Vector3).z === "number"
      );
    };

    const handleIncomingPeerPosition = (peerId: string, payload: unknown) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        (payload as { type?: unknown }).type !== "position" ||
        !isVector3((payload as { position?: unknown }).position)
      ) {
        return;
      }

      const position = (payload as { position: Vector3 }).position;
      voicePeerManager.updatePeerPosition(peerId, position);
      updatePeerCapsulePosition(peerId, position);

      if (this.peerAudioNodes.has(peerId)) {
        this.updatePannerPosition(peerId);
      }
    };

    const setupPositionDataChannel = (
      peerId: string,
      channel: RTCDataChannel,
    ) => {
      this.peerDataChannels.set(peerId, channel);
      channel.onmessage = (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        try {
          const parsed = JSON.parse(event.data) as unknown;
          handleIncomingPeerPosition(peerId, parsed);
        } catch {
          // Ignore malformed payloads
        }
      };
      channel.onopen = () => {
        voiceDebug("datachannel open", peerId, channel.label);
      };
      channel.onerror = (event) => {
        voiceDebug("datachannel error", peerId, event);
      };
      channel.onclose = () => {
        this.peerDataChannels.delete(peerId);
        voiceDebug("datachannel closed", peerId, channel.label);
      };
    };

    const broadcastPositionToPeers = (position: Vector3) => {
      const payload = JSON.stringify({ type: "position", position });
      for (const [peerId, channel] of this.peerDataChannels.entries()) {
        if (channel.readyState !== "open") {
          if (
            channel.readyState === "closed" ||
            channel.readyState === "closing"
          ) {
            this.peerDataChannels.delete(peerId);
          }
          continue;
        }
        try {
          channel.send(payload);
        } catch (error) {
          voiceDebug("datachannel send failed", peerId, error);
        }
      }
    };

    const attachRemoteAudio = (peerId: string, stream: MediaStream) => {
      if (!audioCtx) {
        return;
      }

      const existing = this.peerAudioNodes.get(peerId);
      if (existing) {
        existing.source.disconnect();
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const gain = audioCtx.createGain();
      const panner = audioCtx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "exponential";
      panner.refDistance = 1;
      panner.maxDistance = 80;
      panner.rolloffFactor = 1;
      source.connect(gain).connect(panner).connect(audioCtx.destination);
      this.peerAudioNodes.set(peerId, { source, gain, panner });
      this.updatePannerPosition(peerId);
      voiceDebug("remote track attached", peerId);
    };

    const cleanupPeer = (peerId: string) => {
      const pc = this.rtcPeers.get(peerId);
      if (pc) {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
      }
      this.rtcPeers.delete(peerId);

      const nodes = this.peerAudioNodes.get(peerId);
      if (nodes) {
        nodes.source.disconnect();
        nodes.gain.disconnect();
        nodes.panner.disconnect();
        this.peerAudioNodes.delete(peerId);
      }
      const channel = this.peerDataChannels.get(peerId);
      if (channel) {
        try {
          channel.close();
        } catch {
          // ignore
        }
        this.peerDataChannels.delete(peerId);
      }
      removePeerCapsule(peerId);
    };

    const createPeerConnection = async (
      peerId: string,
    ): Promise<RTCPeerConnection | null> => {
      voiceDebug(
        "createPeerConnection",
        peerId,
        "existing?",
        this.rtcPeers.has(peerId),
      );
      if (this.rtcPeers.has(peerId)) {
        return this.rtcPeers.get(peerId)!;
      }

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      voiceDebug("pc config", peerId, pc.getConfiguration());
      this.rtcPeers.set(peerId, pc);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.connection?.sendSignal(peerId, {
            type: "candidate",
            candidate: event.candidate,
          });
          voiceDebug(
            "send candidate to",
            peerId,
            event.candidate.candidate,
            event.candidate.protocol,
            event.candidate.address,
          );
        } else {
          voiceDebug("icecandidate null (end)", peerId);
        }
      };
      pc.onicecandidateerror = (event) => {
        voiceDebug(
          "icecandidateerror",
          peerId,
          "code",
          event.errorCode,
          "text",
          event.errorText,
        );
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (stream) {
          attachRemoteAudio(peerId, stream);
        }
      };

      pc.oniceconnectionstatechange = () => {
        voiceDebug("ice state", peerId, pc.iceConnectionState);
      };
      pc.onsignalingstatechange = () => {
        voiceDebug("signaling state", peerId, pc.signalingState);
      };
      pc.onicegatheringstatechange = () => {
        voiceDebug("ice gathering state", peerId, pc.iceGatheringState);
      };
      pc.ondatachannel = (event) => {
        voiceDebug("datachannel received", peerId, event.channel.label);
        setupPositionDataChannel(peerId, event.channel);
      };

      pc.onnegotiationneeded = async () => {
        voiceDebug(
          "negotiationneeded",
          peerId,
          "locked?",
          this.negotiationLocks.has(peerId),
        );
        if (this.negotiationLocks.has(peerId)) {
          return;
        }
        this.negotiationLocks.add(peerId);
        try {
          const offer = await pc.createOffer({ offerToReceiveAudio: true });
          await pc.setLocalDescription(offer);
          voiceDebug("setLocalDescription offer", peerId, pc.signalingState);
          this.connection?.sendSignal(peerId, {
            type: "offer",
            sdp: offer.sdp,
          });
          voiceDebug("renegotiation offer sent to", peerId);
        } catch (error) {
          console.warn("Voice chat: renegotiation failed", error);
        } finally {
          this.negotiationLocks.delete(peerId);
        }
      };

      pc.onconnectionstatechange = () => {
        voiceDebug("pc state", peerId, pc.connectionState);
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          cleanupPeer(peerId);
        }
      };

      if (
        this.selfId &&
        isInitiatorFor(this.selfId, peerId) &&
        !this.peerDataChannels.has(peerId)
      ) {
        const channel = pc.createDataChannel("position");
        setupPositionDataChannel(peerId, channel);
      }

      const stream = await ensureLocalStream();
      if (stream) {
        for (const track of stream.getAudioTracks()) {
          pc.addTrack(track, stream);
          voiceDebug("addTrack to new peer", peerId, track.id);
        }
      }

      return pc;
    };

    const attachLocalToExistingPeers = async () => {
      const stream = await ensureLocalStream();
      if (!stream) return;

      const tracks = stream.getAudioTracks();
      for (const pc of this.rtcPeers.values()) {
        const senders = pc.getSenders();
        const hasTrack = senders.some(
          (s) => s.track && s.track.kind === "audio",
        );
        if (hasTrack) continue;
        for (const track of tracks) {
          try {
            pc.addTrack(track, stream);
            voiceDebug("backfill track to existing peer", track.id);
          } catch (error) {
            console.warn(
              "Voice chat: failed to add track to existing peer",
              error,
            );
          }
        }
      }
    };

    const isInitiatorFor = (selfId: string, peerId: string) => selfId < peerId;

    const getPosition = () => {
      const { x, y, z } = this.camera.position;
      return { x, y, z };
    };

    const getPlayerId = () => {
      try {
        const sessionKey = "voicePlayerIdSession";
        const baseKey = "voicePlayerIdBase";

        const sessionCached = sessionStorage.getItem(sessionKey);
        if (sessionCached) return sessionCached;

        let base = localStorage.getItem(baseKey);
        if (!base) {
          base = `player-${crypto.randomUUID().slice(0, 6)}`;
          localStorage.setItem(baseKey, base);
        }

        const sessionId = `${base}-${crypto.randomUUID().slice(0, 4)}`;
        sessionStorage.setItem(sessionKey, sessionId);
        return sessionId;
      } catch {
        return `player-${Math.random().toString(16).slice(2, 10)}`;
      }
    };

    try {
      setupUi(async () => {
        const stream = await ensureLocalStream();
        this.micReady = !!stream;
        renderUi();
        await audioCtx?.resume().catch(() => {});
        await attachLocalToExistingPeers();
        // Resume audio graph if needed
        for (const peerId of this.peerAudioNodes.keys()) {
          this.updatePannerPosition(peerId);
        }
      });
      renderUi();

      const playerId = getPlayerId();
      this.selfId = playerId;
      const startPosition = getPosition();

      const joinResult = await joinWorld({
        baseUrl: voiceBaseUrl,
        playerId,
        position: startPosition,
      });
      voiceDebug(
        "joined cell",
        joinResult.cellId,
        "transport",
        joinResult.transportMode,
        "ws",
        joinResult.cellWebSocketUrl,
      );
      this.iceServers = joinResult.iceServers;

      this.connection = await connectCellWS({
        url: joinResult.cellWebSocketUrl,
        playerId,
        sessionToken: joinResult.sessionToken,
      });
      voiceDebug("ws connected", joinResult.cellWebSocketUrl);

      this.connection.attachPeerManager(voicePeerManager);
      this.connection.startHeartbeat();
      this.connection.startPositionUpdates(getPosition, {
        intervalMs: 50,
        peerManager: voicePeerManager,
        onSend: broadcastPositionToPeers,
      });
      this.connection.onPeersChange((message) => {
        voiceDebug(
          "peers message",
          "peers",
          message.peers,
          "added",
          message.added,
          "removed",
          message.removed,
          "distances",
          message.distances,
          "positions",
          message.positions,
        );
        if (message.distances) {
          for (const [peerId] of Object.entries(message.distances)) {
            this.updatePannerPosition(peerId);
          }
        }
        if (message.positions) {
          for (const [peerId, pos] of Object.entries(message.positions)) {
            voicePeerManager.updatePeerPosition(peerId, pos);
            updatePeerCapsulePosition(peerId, pos);
          }
        }
        if (message.removed) {
          for (const peerId of message.removed) {
            voicePeerManager.updatePeerPosition(peerId, null);
            removePeerCapsule(peerId);
          }
        }
        if (typeof message.totalPlayers === "number") {
          this.totalPlayers = message.totalPlayers;
          renderUi();
        }
      });
      this.connection.onSignal(async (message) => {
        const { from, payload } = message;
        voiceDebug(
          "signal recv",
          from,
          payload && (payload as { type?: string }).type,
        );
        const pc = (await createPeerConnection(from))!;

        if (!payload || typeof payload !== "object") {
          return;
        }

        if ((payload as { type?: string }).type === "offer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription(payload as RTCSessionDescriptionInit),
          );
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.connection?.sendSignal(from, {
            type: "answer",
            sdp: answer.sdp,
          });
          voiceDebug("received offer from", from);
          return;
        }

        if ((payload as { type?: string }).type === "answer") {
          await pc.setRemoteDescription(
            new RTCSessionDescription({
              type: "answer",
              sdp: (payload as { sdp?: string }).sdp,
            }),
          );
          voiceDebug("received answer from", from);
          return;
        }

        if ((payload as { candidate?: unknown }).candidate) {
          try {
            await pc.addIceCandidate(payload as RTCIceCandidateInit);
            voiceDebug("received candidate from", from);
          } catch (error) {
            console.warn("Voice chat: failed to add ICE candidate", error);
          }
        }
      });
      this.connection.onSignalDeliveryFailed((targetId) => {
        voiceDebug("signal delivery failed", targetId);
      });
      this.connection.onError((msg) => {
        voiceDebug("cell error", msg);
      });

      voicePeerManager.onConnect(async (peerId) => {
        voiceDebug(
          "voicePeerManager onConnect",
          peerId,
          "distance",
          voicePeerManager.getPeerDistance(peerId),
        );
        const existingPos = this.peerPositions.get(peerId);
        if (existingPos) {
          updatePeerCapsulePosition(peerId, existingPos);
        } else {
          ensurePeerCapsule(peerId);
        }
        const pc = await createPeerConnection(peerId);
        if (!pc) return;
        if (!isInitiatorFor(playerId, peerId)) {
          voiceDebug("not initiator for peer", peerId);
          return;
        }

        try {
          const offer = await pc.createOffer({ offerToReceiveAudio: true });
          await pc.setLocalDescription(offer);
          voiceDebug(
            "setLocalDescription offer (init)",
            peerId,
            pc.signalingState,
          );
          this.connection?.sendSignal(peerId, {
            type: "offer",
            sdp: offer.sdp,
          });
          voiceDebug("sent offer to", peerId);
        } catch (error) {
          console.warn("Voice chat: failed to create offer", error);
        }
      });

      voicePeerManager.onDisconnect((peerId) => {
        cleanupPeer(peerId);
        removePeerCapsule(peerId);
        voiceDebug("peer disconnect event", peerId);
      });

      // Trigger mic permission upfront so peers can connect without delay
      const stream = await ensureLocalStream();
      this.micReady = !!stream;
      renderUi();
      await attachLocalToExistingPeers();
      await audioCtx?.resume().catch(() => {});
      for (const peerId of this.peerAudioNodes.keys()) {
        this.updatePannerPosition(peerId);
      }
    } catch (error) {
      console.warn("Voice chat initialization failed", error);
      this.voiceUi.textContent = "Voice: failed to init";
    }
  }

  update() {
    for (const peerId of this.peerAudioNodes.keys()) {
      this.updatePannerPosition(peerId);
    }
  }
}
