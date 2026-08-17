import type { ServerMessage } from "./protocol";

export type RunMode = "relay" | "direct";
export type VideoSource = "canvas" | "fake-camera" | "webcam";

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
