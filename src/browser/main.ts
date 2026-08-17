import { TARGET_VIDEO_FPS } from "../shared/config";
import type {
  BrowserAgentConfig,
  BrowserAgentEvent,
  BrowserAgentState,
  BrowserTelemetrySample,
  ConnectionTelemetry,
  PlaybackTelemetry,
  ServerEvent,
  TurnCredentialResponse,
  VideoSourceTelemetry,
} from "../shared/config";
import type { SignalPayload } from "../shared/protocol";
import { identifierSchema } from "../shared/protocol";
import { overrideTurnServer } from "../shared/turn";

declare global {
  interface Window {
    __WEBRTC_BENCHMARK_CONFIG__?: BrowserAgentConfig;
    __agentEvent?: (event: BrowserAgentEvent) => Promise<void>;
  }
}

const DIRECT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:turn.cloudflare.com:3478" }];
const VIDEO_ENCODING_LEVELS = [
  { maxBitrate: 4_000_000, minimumAvailableBitrate: 2_000_000, scaleResolutionDownBy: 1 },
  { maxBitrate: 1_200_000, minimumAvailableBitrate: 600_000, scaleResolutionDownBy: 2 },
  { maxBitrate: 350_000, minimumAvailableBitrate: 0, scaleResolutionDownBy: 4 },
] as const;
const CONGESTION_PACKET_LOSS_THRESHOLD = 0.03;
const RESOLUTION_CHANGE_INTERVAL_MS = 5_000;
const RESOLUTION_RECOVERY_PERIOD_MS = 15_000;
const statusElement = document.querySelector<HTMLElement>("#status");
const remoteMediaContainer = document.querySelector<HTMLDivElement>("#remote-media");
const manualConfigForm = document.querySelector<HTMLFormElement>("#manual-config");
const setupErrorElement = document.querySelector<HTMLElement>("#setup-error");

type MediaSource = {
  audioTrack: MediaStreamTrack;
  cleanup: () => Promise<void>;
  videoTrack: MediaStreamTrack;
  videoSource: () => VideoSourceTelemetry;
};

type RemoteMedia = {
  audio: HTMLAudioElement;
  stream: MediaStream;
  video: HTMLVideoElement;
};

type PeerSession = {
  disconnectTimer?: number;
  lastResolutionChangeAt?: number;
  pendingCandidates: RTCIceCandidateInit[];
  pc: RTCPeerConnection;
  peerId: string;
  resolutionRecoveryStartedAt?: number;
  remoteMedia: RemoteMedia;
  videoScaleDownBy: number;
  videoSender?: RTCRtpSender;
};

function config(): BrowserAgentConfig {
  const value = window.__WEBRTC_BENCHMARK_CONFIG__;
  if (value === undefined) {
    throw new Error("Missing browser benchmark configuration");
  }
  return value;
}

function setupError(message?: string): void {
  if (setupErrorElement !== null) {
    setupErrorElement.textContent = message ?? "";
  }
}

function manualConfig(): BrowserAgentConfig {
  if (manualConfigForm === null) {
    throw new Error("Manual configuration form is unavailable");
  }
  const values = new FormData(manualConfigForm);
  const value = (name: string): string => {
    const item = values.get(name);
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${name} is required`);
    }
    return item;
  };
  const signalOrigin = new URL(value("signal-origin"));
  if (signalOrigin.protocol !== "https:" && signalOrigin.protocol !== "http:") {
    throw new Error("Signaling server URL must use HTTPS or HTTP");
  }
  const room = value("room");
  const agentId = value("agent-id");
  if (!identifierSchema.safeParse(room).success || !identifierSchema.safeParse(agentId).success) {
    throw new Error("Room ID and agent ID may contain only letters, digits, _ and -");
  }
  const expectedMembers = Number(value("expected-members"));
  if (!Number.isSafeInteger(expectedMembers) || expectedMembers < 2 || expectedMembers > 8) {
    throw new Error("Expected members must be between 2 and 8");
  }
  const mode = value("mode");
  if (mode !== "relay" && mode !== "direct") {
    throw new Error("Connection mode is invalid");
  }
  const videoSource = value("video-source");
  if (videoSource !== "canvas" && videoSource !== "webcam") {
    throw new Error("Video source is invalid");
  }
  return {
    agentId,
    durationMs: 5 * 60 * 1_000,
    expectedMembers,
    mode,
    room,
    sampleIntervalMs: 1_000,
    signalOrigin: signalOrigin.origin,
    videoSource,
  };
}

async function emit(event: BrowserAgentEvent): Promise<void> {
  try {
    await window.__agentEvent?.(event);
  } catch (error) {
    console.error("Failed to report browser agent event", error);
  }
}

function updateStatus(state: BrowserAgentState, detail?: string): void {
  if (statusElement !== null) {
    statusElement.textContent = detail === undefined ? state : `${state}: ${detail}`;
  }
  void emit({ type: "state", state, ...(detail === undefined ? {} : { detail }) });
}

function signalUrl(runConfig: BrowserAgentConfig): string {
  const url = new URL(`/signal/${encodeURIComponent(runConfig.room)}`, runConfig.signalOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function verifySignalAccess(runConfig: BrowserAgentConfig): Promise<void> {
  const response = await fetch(new URL("/api/session", runConfig.signalOrigin), {
    method: "POST",
    cache: "no-store",
  });
  if (response.ok) {
    return;
  }
  const detail = await response.text();
  throw new Error(`Signaling preflight failed (HTTP ${response.status}): ${detail}`);
}

function drawSourceFrame(context: CanvasRenderingContext2D, width: number, height: number, frame: number): void {
  const time = frame / TARGET_VIDEO_FPS;
  const hue = (frame * 3) % 360;
  context.fillStyle = `hsl(${hue} 60% 16%)`;
  context.fillRect(0, 0, width, height);

  for (let column = 0; column < 16; column += 1) {
    const columnHue = (hue + column * 18) % 360;
    context.fillStyle = `hsl(${columnHue} 80% ${35 + (column % 3) * 15}%)`;
    const x = ((column * width) / 16 + Math.sin(time + column) * 48 + width) % width;
    context.fillRect(x, 0, width / 20, height);
  }

  const boxSize = Math.min(width, height) / 6;
  const boxX = ((Math.sin(time * 1.3) + 1) / 2) * (width - boxSize);
  const boxY = ((Math.cos(time * 0.9) + 1) / 2) * (height - boxSize);
  context.fillStyle = "#ffffff";
  context.fillRect(boxX, boxY, boxSize, boxSize);
  context.fillStyle = "#111111";
  context.font = "bold 64px monospace";
  context.fillText(`FRAME ${frame}`, 40, 90);
  context.fillText(`${width}x${height} @ ${TARGET_VIDEO_FPS}fps`, 40, 170);
}

async function createCameraMedia(): Promise<MediaSource> {
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    throw new Error("Camera capture requires a secure HTTPS page or localhost");
  }
  const source = config().videoSource === "fake-camera" ? "fake camera" : "webcam";
  let cameraStream: MediaStream;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        frameRate: { ideal: TARGET_VIDEO_FPS, max: TARGET_VIDEO_FPS },
        height: { ideal: 720 },
        width: { ideal: 1280 },
      },
    });
  } catch (error) {
    throw new Error(`Unable to access the ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const videoTrack = cameraStream.getVideoTracks()[0];
  if (videoTrack === undefined) {
    cameraStream.getTracks().forEach((track) => track.stop());
    throw new Error(`The ${source} did not provide a video track`);
  }
  videoTrack.contentHint = "motion";

  const monitor = document.createElement("video");
  monitor.autoplay = true;
  monitor.muted = true;
  monitor.playsInline = true;
  monitor.srcObject = new MediaStream([videoTrack]);
  monitor.style.cssText = "height: 1px; left: -1px; opacity: 0; position: fixed; top: -1px; width: 1px";
  document.body.appendChild(monitor);
  await monitor.play();
  let capturedFrames = 0;
  let monitoring = true;
  let callbackId: number | undefined;
  const monitorFrames = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void => {
    capturedFrames = metadata.presentedFrames;
    if (monitoring) {
      callbackId = monitor.requestVideoFrameCallback(monitorFrames);
    }
  };
  callbackId = monitor.requestVideoFrameCallback(monitorFrames);

  const audioContext = new AudioContext({ sampleRate: 48_000 });
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  gain.gain.value = 0.08;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  await audioContext.resume();
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack === undefined) {
    monitoring = false;
    if (callbackId !== undefined) {
      monitor.cancelVideoFrameCallback(callbackId);
    }
    monitor.remove();
    cameraStream.getTracks().forEach((track) => track.stop());
    oscillator.stop();
    await audioContext.close();
    throw new Error("Web Audio did not create an audio track");
  }

  return {
    audioTrack,
    videoTrack,
    videoSource: () => ({ capturedFrames, missedFrameSlots: 0 }),
    cleanup: async () => {
      monitoring = false;
      if (callbackId !== undefined) {
        monitor.cancelVideoFrameCallback(callbackId);
      }
      monitor.srcObject = null;
      monitor.remove();
      cameraStream.getTracks().forEach((track) => track.stop());
      oscillator.stop();
      audioTrack.stop();
      await audioContext.close();
    },
  };
}

async function createSyntheticMedia(): Promise<MediaSource> {
  if (config().videoSource !== "canvas") {
    return createCameraMedia();
  }
  const width = 1280;
  const height = 720;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("Canvas 2D context is unavailable");
  }

  const videoTrack = canvas.captureStream(0).getVideoTracks()[0];
  if (videoTrack === undefined || !("requestFrame" in videoTrack)) {
    throw new Error("Canvas did not create a video track");
  }
  videoTrack.contentHint = "motion";
  const requestFrame = (videoTrack as MediaStreamTrack & { requestFrame: () => void }).requestFrame.bind(videoTrack);
  const frameIntervalMs = 1_000 / TARGET_VIDEO_FPS;
  let capturedFrames = 0;
  let frame = 0;
  let frameTimer: number | undefined;
  let missedFrameSlots = 0;
  let nextFrameAt = performance.now();
  const drawAndCaptureFrame = (): void => {
    const now = performance.now();
    if (now > nextFrameAt + frameIntervalMs) {
      const skippedSlots = Math.floor((now - nextFrameAt) / frameIntervalMs);
      missedFrameSlots += skippedSlots;
      frame += skippedSlots;
      nextFrameAt += skippedSlots * frameIntervalMs;
    }
    frame += 1;
    drawSourceFrame(context, width, height, frame);
    requestFrame();
    capturedFrames += 1;
    nextFrameAt += frameIntervalMs;
    frameTimer = window.setTimeout(drawAndCaptureFrame, Math.max(0, nextFrameAt - performance.now()));
  };
  drawAndCaptureFrame();

  const audioContext = new AudioContext({ sampleRate: 48_000 });
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const destination = audioContext.createMediaStreamDestination();
  oscillator.type = "sine";
  oscillator.frequency.value = 440;
  gain.gain.value = 0.08;
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  await audioContext.resume();
  const audioTrack = destination.stream.getAudioTracks()[0];
  if (audioTrack === undefined) {
    oscillator.stop();
    await audioContext.close();
    videoTrack.stop();
    if (frameTimer !== undefined) {
      window.clearTimeout(frameTimer);
    }
    throw new Error("Web Audio did not create an audio track");
  }

  return {
    audioTrack,
    videoTrack,
    videoSource: () => ({ capturedFrames, missedFrameSlots }),
    cleanup: async () => {
      if (frameTimer !== undefined) {
        window.clearTimeout(frameTimer);
      }
      oscillator.stop();
      audioTrack.stop();
      videoTrack.stop();
      await audioContext.close();
    },
  };
}

function makeRemoteMedia(peerId: string): RemoteMedia {
  const stream = new MediaStream();
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  video.autoplay = true;
  video.playsInline = true;
  video.dataset.peerId = peerId;
  video.srcObject = stream;
  audio.autoplay = true;
  audio.dataset.peerId = peerId;
  audio.srcObject = stream;
  remoteMediaContainer?.appendChild(video);
  remoteMediaContainer?.appendChild(audio);
  return { audio, stream, video };
}

function serializeStats(stat: RTCStats): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    id: stat.id,
    timestamp: stat.timestamp,
    type: stat.type,
  };
  const toJson: unknown = Reflect.get(stat, "toJSON");
  if (typeof toJson === "function") {
    Object.assign(serialized, toJson.call(stat));
    return serialized;
  }

  for (const key of Object.keys(stat)) {
    serialized[key] = Reflect.get(stat, key);
  }
  return serialized;
}

function numberFromStat(stat: Record<string, unknown> | undefined, property: string): number | undefined {
  const value = stat?.[property];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringFromStat(stat: Record<string, unknown> | undefined, property: string): string | undefined {
  const value = stat?.[property];
  return typeof value === "string" ? value : undefined;
}

class BenchmarkAgent {
  private collectingSample = false;
  private iceServers: RTCIceServer[] = [];
  private messageQueue: Promise<void> = Promise.resolve();
  private readonly sessions = new Map<string, PeerSession>();
  private mediaSource: MediaSource | undefined;
  private readySent = false;
  private readinessTimer: number | undefined;
  private runId: string | undefined;
  private sampleTimer: number | undefined;
  private state: BrowserAgentState = "initializing";
  private stopTimer: number | undefined;
  private webSocket: WebSocket | undefined;

  async start(): Promise<void> {
    const runConfig = config();
    updateStatus("initializing");
    await verifySignalAccess(runConfig);
    this.mediaSource = await createSyntheticMedia();
    this.readinessTimer = window.setInterval(() => this.maybeReady(), 250);
    this.state = "connecting";
    updateStatus(this.state);

    const socket = new WebSocket(signalUrl(runConfig), ["webrtc-benchmark"]);
    this.webSocket = socket;
    socket.addEventListener("open", () => {
      this.send({
        type: "join",
        agentId: runConfig.agentId,
        expectedMembers: runConfig.expectedMembers,
      });
      this.state = "waiting-for-peers";
      updateStatus(this.state);
    });
    socket.addEventListener("message", (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.handleMessage(event.data))
        .catch((error: unknown) => this.fail(error));
    });
    socket.addEventListener("close", (event) => {
      if (this.state !== "complete" && this.state !== "failed") {
        this.fail(
          new Error(
            `Signaling WebSocket closed unexpectedly (code ${event.code}) after the HTTP preflight succeeded. Check that the Access application token is present on the WebSocket upgrade, then inspect Worker and Durable Object logs for ${runConfig.signalOrigin}.`,
          ),
        );
      }
    });
    socket.addEventListener("error", () => {
      this.fail(
        new Error(
          `Signaling WebSocket upgrade failed after an authenticated preflight. Check Access token propagation on the upgrade, then inspect Worker and Durable Object logs for ${runConfig.signalOrigin}.`,
        ),
      );
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (typeof data !== "string") {
      throw new Error("Received a binary signaling message");
    }
    const message = JSON.parse(data) as ServerEvent;
    switch (message.type) {
      case "joined":
        this.iceServers = await this.loadIceServers(config(), message.turnCredentialNonce);
        await Promise.all(message.peers.map((peerId) => this.makeOffer(peerId)));
        return;
      case "peer-joined":
        this.ensureSession(message.agentId);
        return;
      case "peer-left":
        this.closeSession(message.agentId);
        return;
      case "signal":
        await this.handleSignal(message.from, message.payload);
        return;
      case "start":
        this.beginRun(message.runId, message.durationMs);
        return;
      case "complete":
        await this.completeRun(message.runId);
        return;
      case "run-failed":
      case "error":
        throw new Error(message.reason);
    }
  }

  private ensureSession(peerId: string): PeerSession {
    const existing = this.sessions.get(peerId);
    if (existing !== undefined) {
      return existing;
    }
    if (this.mediaSource === undefined) {
      throw new Error("Media source was not initialized");
    }
    if (this.iceServers.length === 0) {
      throw new Error("ICE server configuration was not initialized");
    }

    const runConfig = config();
    const pc = new RTCPeerConnection({
      bundlePolicy: "max-bundle",
      iceServers: this.iceServers,
      iceTransportPolicy: runConfig.mode === "relay" ? "relay" : "all",
      rtcpMuxPolicy: "require",
    });
    const remoteMedia = makeRemoteMedia(peerId);
    const session: PeerSession = {
      pendingCandidates: [],
      pc,
      peerId,
      remoteMedia,
      videoScaleDownBy: VIDEO_ENCODING_LEVELS[0].scaleResolutionDownBy,
    };
    this.sessions.set(peerId, session);
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate !== null) {
        this.send({ type: "signal", to: peerId, payload: { candidate: event.candidate.toJSON() } });
      }
    });
    pc.addEventListener("connectionstatechange", () => this.handleConnectionState(session));
    pc.addEventListener("track", (event) => {
      if (!remoteMedia.stream.getTracks().some((track) => track.id === event.track.id)) {
        remoteMedia.stream.addTrack(event.track);
      }
      if (event.track.kind === "video") {
        void remoteMedia.video.play().catch((error: unknown) => console.warn("Video playback failed", error));
      } else {
        void remoteMedia.audio.play().catch((error: unknown) => console.warn("Audio playback failed", error));
      }
      this.maybeReady();
    });
    return session;
  }

  private async configureOfferTransceivers(session: PeerSession): Promise<void> {
    if (this.mediaSource === undefined) {
      throw new Error("Media source was not initialized");
    }

    session.pc.addTransceiver(this.mediaSource.audioTrack, { direction: "sendrecv" });
    const initialLevel = VIDEO_ENCODING_LEVELS[0];
    const videoTransceiver = session.pc.addTransceiver(this.mediaSource.videoTrack, {
      direction: "sendrecv",
      sendEncodings: [{
        maxBitrate: initialLevel.maxBitrate,
        maxFramerate: TARGET_VIDEO_FPS,
        scaleResolutionDownBy: initialLevel.scaleResolutionDownBy,
      }],
    });
    session.videoSender = videoTransceiver.sender;
    await this.setVideoSenderParameters(session.videoSender, initialLevel);
  }

  private async configureAnswerTransceivers(session: PeerSession): Promise<void> {
    if (this.mediaSource === undefined) {
      throw new Error("Media source was not initialized");
    }

    const audioTransceiver = session.pc
      .getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "audio");
    const videoTransceiver = session.pc
      .getTransceivers()
      .find((transceiver) => transceiver.receiver.track.kind === "video");
    if (audioTransceiver === undefined || videoTransceiver === undefined) {
      throw new Error("Peer offer is missing an audio or video media section");
    }

    // Remote offers create receiver-only transceivers. Reuse those negotiated m-lines for this peer's send tracks.
    await Promise.all([
      audioTransceiver.sender.replaceTrack(this.mediaSource.audioTrack),
      videoTransceiver.sender.replaceTrack(this.mediaSource.videoTrack),
    ]);
    audioTransceiver.direction = "sendrecv";
    videoTransceiver.direction = "sendrecv";
    session.videoSender = videoTransceiver.sender;
    await this.setVideoSenderParameters(session.videoSender, VIDEO_ENCODING_LEVELS[0]);
  }

  private async setVideoSenderParameters(
    sender: RTCRtpSender,
    level: (typeof VIDEO_ENCODING_LEVELS)[number],
  ): Promise<boolean> {
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    for (const encoding of parameters.encodings) {
      encoding.maxFramerate = TARGET_VIDEO_FPS;
      encoding.maxBitrate = level.maxBitrate;
      encoding.scaleResolutionDownBy = level.scaleResolutionDownBy;
    }
    try {
      await sender.setParameters(parameters);
      return true;
    } catch (error) {
      console.warn("Unable to update video sender parameters", error);
      return false;
    }
  }

  private availableOutgoingBitrate(stats: Record<string, unknown>[]): number | undefined {
    const statsById = new Map(stats.map((stat) => [stringFromStat(stat, "id"), stat]));
    const transport = stats.find(
      (stat) => stringFromStat(stat, "type") === "transport" && stringFromStat(stat, "selectedCandidatePairId") !== undefined,
    );
    const selectedPairId = stringFromStat(transport, "selectedCandidatePairId");
    const selectedPair =
      (selectedPairId === undefined ? undefined : statsById.get(selectedPairId)) ??
      stats.find((stat) => stringFromStat(stat, "type") === "candidate-pair" && stat.selected === true);
    return numberFromStat(selectedPair, "availableOutgoingBitrate");
  }

  private async adaptVideoResolution(session: PeerSession, stats: Record<string, unknown>[]): Promise<void> {
    if (session.videoSender === undefined || session.pc.connectionState !== "connected") {
      return;
    }
    const now = performance.now();
    if (
      session.lastResolutionChangeAt !== undefined &&
      now - session.lastResolutionChangeAt < RESOLUTION_CHANGE_INTERVAL_MS
    ) {
      return;
    }

    const currentLevelIndex = VIDEO_ENCODING_LEVELS.findIndex(
      (level) => level.scaleResolutionDownBy === session.videoScaleDownBy,
    );
    if (currentLevelIndex < 0) {
      return;
    }
    const currentLevel = VIDEO_ENCODING_LEVELS[currentLevelIndex];
    if (currentLevel === undefined) {
      return;
    }
    const outboundVideo = stats.find(
      (stat) =>
        stringFromStat(stat, "type") === "outbound-rtp" &&
        (stringFromStat(stat, "kind") ?? stringFromStat(stat, "mediaType")) === "video",
    );
    const remoteInboundVideo = stats.find(
      (stat) =>
        stringFromStat(stat, "type") === "remote-inbound-rtp" &&
        (stringFromStat(stat, "kind") ?? stringFromStat(stat, "mediaType")) === "video",
    );
    const availableBitrate = this.availableOutgoingBitrate(stats);
    const hasAvailableBitrateEstimate = availableBitrate !== undefined && availableBitrate > 0;
    const packetLoss = numberFromStat(remoteInboundVideo, "fractionLost") ?? 0;
    const bandwidthLimited =
      stringFromStat(outboundVideo, "qualityLimitationReason") === "bandwidth" ||
      packetLoss > CONGESTION_PACKET_LOSS_THRESHOLD ||
      (hasAvailableBitrateEstimate && availableBitrate < currentLevel.minimumAvailableBitrate);

    if (bandwidthLimited) {
      session.resolutionRecoveryStartedAt = undefined;
      const nextLevel = VIDEO_ENCODING_LEVELS[currentLevelIndex + 1];
      if (nextLevel !== undefined) {
        await this.applyVideoResolution(session, nextLevel, "congestion");
      }
      return;
    }

    const higherResolutionLevel = VIDEO_ENCODING_LEVELS[currentLevelIndex - 1];
    if (higherResolutionLevel === undefined) {
      return;
    }
    if (
      hasAvailableBitrateEstimate &&
      availableBitrate < higherResolutionLevel.minimumAvailableBitrate * 1.5
    ) {
      session.resolutionRecoveryStartedAt = undefined;
      return;
    }
    session.resolutionRecoveryStartedAt ??= now;
    if (now - session.resolutionRecoveryStartedAt >= RESOLUTION_RECOVERY_PERIOD_MS) {
      await this.applyVideoResolution(session, higherResolutionLevel, "recovery");
    }
  }

  private async applyVideoResolution(
    session: PeerSession,
    level: (typeof VIDEO_ENCODING_LEVELS)[number],
    reason: "congestion" | "recovery",
  ): Promise<void> {
    if (session.videoSender === undefined || !(await this.setVideoSenderParameters(session.videoSender, level))) {
      return;
    }
    session.lastResolutionChangeAt = performance.now();
    session.resolutionRecoveryStartedAt = undefined;
    session.videoScaleDownBy = level.scaleResolutionDownBy;
    console.info(
      JSON.stringify({
        event: "video_resolution_changed",
        peerId: session.peerId,
        reason,
        scaleResolutionDownBy: level.scaleResolutionDownBy,
      }),
    );
  }

  private async makeOffer(peerId: string): Promise<void> {
    const session = this.ensureSession(peerId);
    await this.configureOfferTransceivers(session);
    const offer = await session.pc.createOffer();
    await session.pc.setLocalDescription(offer);
    if (session.pc.localDescription === null) {
      throw new Error("Local offer description was not set");
    }
    this.send({ type: "signal", to: peerId, payload: { description: session.pc.localDescription } });
  }

  private async loadIceServers(runConfig: BrowserAgentConfig, connectionNonce?: string): Promise<RTCIceServer[]> {
    if (runConfig.mode === "direct") {
      return DIRECT_ICE_SERVERS;
    }
    if (connectionNonce === undefined) {
      throw new Error("TURN credential request is missing its room connection nonce");
    }

    const response = await fetch(new URL("/api/turn-credentials", runConfig.signalOrigin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ agentId: runConfig.agentId, connectionNonce, room: runConfig.room }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`TURN credential request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const body: unknown = await response.json();
    if (!this.isTurnCredentialResponse(body)) {
      throw new Error("TURN credential response was invalid");
    }
    return runConfig.turnServer === undefined ? body.iceServers : overrideTurnServer(body.iceServers, runConfig.turnServer);
  }

  private isTurnCredentialResponse(value: unknown): value is TurnCredentialResponse {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      record.mode === "relay" &&
      Array.isArray(record.iceServers) &&
      record.iceServers.length > 0 &&
      record.iceServers.every((server) => {
        if (typeof server !== "object" || server === null) {
          return false;
        }
        const urls = (server as Record<string, unknown>).urls;
        return typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string"));
      })
    );
  }

  private async handleSignal(peerId: string, payload: SignalPayload): Promise<void> {
    const session = this.ensureSession(peerId);
    if (payload.candidate !== undefined) {
      if (session.pc.remoteDescription === null) {
        session.pendingCandidates.push(payload.candidate);
      } else {
        await session.pc.addIceCandidate(payload.candidate);
      }
      return;
    }

    if (payload.description === undefined) {
      throw new Error("Received an empty signal payload");
    }
    await session.pc.setRemoteDescription(payload.description);
    for (const candidate of session.pendingCandidates.splice(0)) {
      await session.pc.addIceCandidate(candidate);
    }

    if (payload.description.type === "offer") {
      await this.configureAnswerTransceivers(session);
      const answer = await session.pc.createAnswer();
      await session.pc.setLocalDescription(answer);
      if (session.pc.localDescription === null) {
        throw new Error("Local answer description was not set");
      }
      this.send({ type: "signal", to: peerId, payload: { description: session.pc.localDescription } });
    }
  }

  private maybeReady(): void {
    const expectedPeers = config().expectedMembers - 1;
    if (
      this.readySent ||
      this.sessions.size !== expectedPeers ||
      ![...this.sessions.values()].every(
        (session) =>
          session.pc.connectionState === "connected" &&
          session.remoteMedia.stream.getAudioTracks().length > 0 &&
          session.remoteMedia.video.videoWidth > 0,
      )
    ) {
      return;
    }

    this.readySent = true;
    this.state = "ready";
    updateStatus(this.state);
    this.send({ type: "ready" });
  }

  private beginRun(runId: string, durationMs: number): void {
    if (this.state === "running" || this.state === "finalizing" || this.state === "complete") {
      return;
    }
    if (durationMs !== config().durationMs) {
      this.fail(new Error(`Room duration ${durationMs} does not match agent duration ${config().durationMs}`));
      return;
    }

    this.runId = runId;
    this.state = "running";
    updateStatus(this.state, runId);
    void this.collectSample();
    this.sampleTimer = window.setInterval(() => void this.collectSample(), config().sampleIntervalMs);
    this.stopTimer = window.setTimeout(() => void this.finishMediaPhase(), durationMs);
  }

  private async collectSample(): Promise<void> {
    if (this.state !== "running" || this.collectingSample) {
      return;
    }

      this.collectingSample = true;
    try {
      const connections: ConnectionTelemetry[] = await Promise.all(
        [...this.sessions.values()].map(async (session) => {
          const stats = [...(await session.pc.getStats()).values()].map(serializeStats);
          await this.adaptVideoResolution(session, stats);
          return {
            connectionState: session.pc.connectionState,
            iceConnectionState: session.pc.iceConnectionState,
            peerId: session.peerId,
            stats,
          };
        }),
      );
      const playback: PlaybackTelemetry[] = [...this.sessions.values()].map((session) => {
        const quality = session.remoteMedia.video.getVideoPlaybackQuality();
        return {
          droppedVideoFrames: quality.droppedVideoFrames,
          peerId: session.peerId,
          totalVideoFrames: quality.totalVideoFrames,
          videoHeight: session.remoteMedia.video.videoHeight,
          videoWidth: session.remoteMedia.video.videoWidth,
        };
      });
      const sample: BrowserTelemetrySample = {
        browserTimestampMs: performance.timeOrigin + performance.now(),
        connections,
        playback,
        runId: this.runId,
        state: this.state,
        videoSource: this.mediaSource?.videoSource() ?? { capturedFrames: 0, missedFrameSlots: 0 },
      };
      await emit({ type: "sample", sample });
    } finally {
      this.collectingSample = false;
    }
  }

  private async finishMediaPhase(): Promise<void> {
    if (this.state !== "running") {
      return;
    }
    await this.collectSample();
    this.state = "finalizing";
    if (this.sampleTimer !== undefined) {
      window.clearInterval(this.sampleTimer);
    }
    if (this.stopTimer !== undefined) {
      window.clearTimeout(this.stopTimer);
    }
    this.send({ type: "finished" });
    updateStatus(this.state);
  }

  private async completeRun(runId: string): Promise<void> {
    if (this.runId !== runId) {
      throw new Error("Received completion for an unexpected run");
    }
    if (this.state === "running") {
      await this.finishMediaPhase();
    }
    if (this.state !== "finalizing") {
      return;
    }
    this.state = "complete";
    if (this.readinessTimer !== undefined) {
      window.clearInterval(this.readinessTimer);
    }
    updateStatus(this.state);
    await emit({ type: "complete", runId });
    await this.cleanup();
  }

  private closeSession(peerId: string): void {
    const session = this.sessions.get(peerId);
    if (session === undefined) {
      return;
    }
    if (session.disconnectTimer !== undefined) {
      window.clearTimeout(session.disconnectTimer);
    }
    if (this.state === "running") {
      void this.fail(new Error(`Peer ${peerId} left during the run`));
    }
    session.pc.close();
    session.remoteMedia.audio.remove();
    session.remoteMedia.video.remove();
    this.sessions.delete(peerId);
  }

  private handleConnectionState(session: PeerSession): void {
    const state = session.pc.connectionState;
    if (state === "connected" && session.disconnectTimer !== undefined) {
      window.clearTimeout(session.disconnectTimer);
      session.disconnectTimer = undefined;
    }
    if (this.state === "running" && (state === "failed" || state === "closed")) {
      void this.fail(new Error(`Peer ${session.peerId} connection ${state}`));
    }
    if (this.state === "running" && state === "disconnected" && session.disconnectTimer === undefined) {
      session.disconnectTimer = window.setTimeout(() => {
        if (session.pc.connectionState === "disconnected" && this.state === "running") {
          void this.fail(new Error(`Peer ${session.peerId} remained disconnected for 10 seconds`));
        }
      }, 10_000);
    }
    this.maybeReady();
  }

  private send(message: object): void {
    if (this.webSocket?.readyState !== WebSocket.OPEN) {
      throw new Error("Signaling WebSocket is not open");
    }
    this.webSocket.send(JSON.stringify(message));
  }

  private async fail(error: unknown): Promise<void> {
    if (this.state === "failed" || this.state === "complete") {
      return;
    }
    this.state = "failed";
    const message = error instanceof Error ? error.message : String(error);
    console.error("WebRTC benchmark failed", error);
    updateStatus(this.state, message);
    await emit({ type: "fatal", message });
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.sampleTimer !== undefined) {
      window.clearInterval(this.sampleTimer);
    }
    if (this.stopTimer !== undefined) {
      window.clearTimeout(this.stopTimer);
    }
    for (const peerId of [...this.sessions.keys()]) {
      this.closeSession(peerId);
    }
    this.webSocket?.close();
    await this.mediaSource?.cleanup();
  }
}

function startAgent(runConfig: BrowserAgentConfig, manual: boolean): void {
  window.__WEBRTC_BENCHMARK_CONFIG__ = runConfig;
  if (manual) {
    document.body.classList.add("manual-run");
  }
  manualConfigForm?.setAttribute("hidden", "");
  void new BenchmarkAgent().start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to start benchmark agent", error);
    updateStatus("failed", message);
    if (manual) {
      setupError(message);
      manualConfigForm?.removeAttribute("hidden");
    }
    void emit({ type: "fatal", message });
  });
}

const injectedConfig = window.__WEBRTC_BENCHMARK_CONFIG__;
if (injectedConfig !== undefined) {
  startAgent(injectedConfig, false);
} else if (manualConfigForm !== null) {
  const signalOriginInput = manualConfigForm.elements.namedItem("signal-origin");
  if (signalOriginInput instanceof HTMLInputElement) {
    signalOriginInput.value = window.location.origin;
  }
  manualConfigForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      setupError();
      startAgent(manualConfig(), true);
    } catch (error) {
      setupError(error instanceof Error ? error.message : String(error));
    }
  });
}
