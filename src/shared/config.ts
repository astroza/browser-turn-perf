import type { ServerMessage } from "./protocol";

export type RunMode = "relay" | "direct";
export type VideoSource = "canvas" | "fake-camera" | "webcam";

const MAX_TIMER_DELAY_MS = 0x7fff_ffff;

export const TEST_DURATION_MINUTE_MS = 60_000;
export const DEFAULT_TEST_DURATION_MINUTES = 5;
export const TEST_COMPLETION_GRACE_MS = 120_000;
export const MAX_TEST_DURATION_MINUTES = Math.floor(
  (MAX_TIMER_DELAY_MS - TEST_COMPLETION_GRACE_MS) / TEST_DURATION_MINUTE_MS,
);
export const DEFAULT_TEST_DURATION_MS = DEFAULT_TEST_DURATION_MINUTES * TEST_DURATION_MINUTE_MS;
export const MAX_TEST_DURATION_MS = MAX_TEST_DURATION_MINUTES * TEST_DURATION_MINUTE_MS;
export const TARGET_VIDEO_FPS = 30;
export const MIN_AVERAGE_VIDEO_FPS = 29;
export const MIN_WINDOW_VIDEO_FPS = 28.5;

export type BrowserAgentConfig = {
  agentId: string;
  durationMs: number;
  expectedMembers: number;
  mode: RunMode;
  room: string;
  sampleIntervalMs: number;
  signalOrigin: string;
  turnServer?: string;
  videoSource: VideoSource;
};

export type BrowserAgentEvent =
  | { type: "sample"; sample: BrowserTelemetrySample }
  | { type: "state"; state: BrowserAgentState; detail?: string }
  | { type: "complete"; runId: string }
  | { type: "fatal"; message: string };

export type BrowserAgentState =
  | "initializing"
  | "connecting"
  | "waiting-for-peers"
  | "ready"
  | "running"
  | "finalizing"
  | "complete"
  | "failed";

export type BrowserTelemetrySample = {
  browserTimestampMs: number;
  connections: ConnectionTelemetry[];
  playback: PlaybackTelemetry[];
  runId?: string;
  state: BrowserAgentState;
  videoSource: VideoSourceTelemetry;
};

export type VideoSourceTelemetry = {
  capturedFrames: number;
  missedFrameSlots: number;
};

export type ConnectionTelemetry = {
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  peerId: string;
  stats: Record<string, unknown>[];
};

export type PlaybackTelemetry = {
  droppedVideoFrames: number;
  peerId: string;
  totalVideoFrames: number;
  videoHeight: number;
  videoWidth: number;
};

export type TurnCredentialResponse = {
  iceServers: RTCIceServer[];
  mode: RunMode;
};

export type ServerEvent = ServerMessage;
