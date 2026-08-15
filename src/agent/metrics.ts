import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import { MIN_AVERAGE_VIDEO_FPS, MIN_WINDOW_VIDEO_FPS, TARGET_VIDEO_FPS } from "../shared/config";
import type {
  BrowserAgentEvent,
  BrowserTelemetrySample,
  ConnectionTelemetry,
  PlaybackTelemetry,
  VideoSource,
} from "../shared/config";
import type { RunMode } from "../shared/config";

type NumericSnapshot = {
  bytes: number | undefined;
  jitterBufferDelay: number | undefined;
  jitterBufferEmittedCount: number | undefined;
  jitterBufferTargetDelay: number | undefined;
  packetsLost: number | undefined;
  packetsReceived: number | undefined;
  timestamp: number;
};

type StreamSummary = {
  direction: "inbound" | "outbound";
  endBytes: number;
  endTimestamp: number;
  kind: string;
  peerId: string;
  resolutions: string[];
  rid: string | undefined;
  startBytes: number;
  startTimestamp: number;
  statId: string;
};

type CandidatePath = {
  availableIncomingBitrate: number | undefined;
  availableOutgoingBitrate: number | undefined;
  bytesReceived: number | undefined;
  bytesSent: number | undefined;
  currentRoundTripTime: number | undefined;
  localCandidateType: string | undefined;
  peerId: string;
  relayProtocol: string | undefined;
  remoteCandidateType: string | undefined;
  timestamp: number;
  transportProtocol: string | undefined;
};

type PlaybackRange = {
  droppedFrames: number;
  lastHeight: number;
  lastFrames: number;
  lastTimestamp: number;
  lastWidth: number;
  resolutions: string[];
};

type FrameRateRange = {
  firstFrames: number;
  firstTimestamp: number;
  lastFrames: number;
  lastTimestamp: number;
  minimumWindowFps: number | undefined;
  slowWindows: number;
  windowFrames: number | undefined;
  windowTimestamp: number | undefined;
};

type EncoderRange = {
  frameRate: FrameRateRange;
  peerId: string;
  rid: string | undefined;
  statId: string;
};

type DecoderRange = {
  frameRate: FrameRateRange;
  peerId: string;
  resolutions: string[];
  statId: string;
};

type SourceRange = {
  frameRate: FrameRateRange;
  missedFrameSlots: number;
};

type FrameRateSummary = {
  averageFps: number | undefined;
  minimumWindowFps: number | undefined;
  slowWindows: number;
};

type VideoPacingSummary = {
  encoders: Array<FrameRateSummary & { peerId: string; rid: string | undefined; statId: string }>;
  playback: Array<{ droppedFrames: number; peerId: string; resolutions: string[]; totalFrames: number }>;
  receivers: Array<FrameRateSummary & { peerId: string; resolutions: string[]; statId: string }>;
  source: (FrameRateSummary & { capturedFrames: number; missedFrameSlots: number }) | null;
  targetFps: number;
};

const FRAME_RATE_WARMUP_MS = 5_000;
const FRAME_RATE_WINDOW_MS = 10_000;

export type ArtifactMetadata = {
  agentId: string;
  browserVersion: string;
  durationSeconds: number;
  expectedMembers: number;
  mode: RunMode;
  room: string;
  signalOrigin: string;
  startedAt: string;
  videoSource: VideoSource;
};

export type RunSummary = {
  candidatePaths: CandidatePath[];
  completedAt: string;
  mode: RunMode;
  sampleCount: number;
  status: "complete" | "failed";
  streams: Array<StreamSummary & { averageBitrateBps: number }>;
  validation: { errors: string[]; valid: boolean };
  videoPacing: VideoPacingSummary;
};

function numberAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function csv(values: Array<string | number | undefined>): string {
  return values
    .map((value) => {
      const serialized = value === undefined ? "" : String(value);
      return /[",\n]/.test(serialized) ? `"${serialized.replaceAll('"', '""')}"` : serialized;
    })
    .join(",");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function updateFrameRate(range: FrameRateRange | undefined, frames: number, timestamp: number): FrameRateRange {
  if (range === undefined) {
    return {
      firstFrames: frames,
      firstTimestamp: timestamp,
      lastFrames: frames,
      lastTimestamp: timestamp,
      minimumWindowFps: undefined,
      slowWindows: 0,
      windowFrames: undefined,
      windowTimestamp: undefined,
    };
  }

  range.lastFrames = frames;
  range.lastTimestamp = timestamp;
  if (timestamp - range.firstTimestamp < FRAME_RATE_WARMUP_MS) {
    return range;
  }
  if (range.windowFrames === undefined || range.windowTimestamp === undefined) {
    range.windowFrames = frames;
    range.windowTimestamp = timestamp;
    return range;
  }

  const elapsedMs = timestamp - range.windowTimestamp;
  if (elapsedMs < FRAME_RATE_WINDOW_MS) {
    return range;
  }
  const windowFps = ((frames - range.windowFrames) * 1_000) / elapsedMs;
  range.minimumWindowFps = Math.min(range.minimumWindowFps ?? windowFps, windowFps);
  if (windowFps < MIN_WINDOW_VIDEO_FPS) {
    range.slowWindows += 1;
  }
  range.windowFrames = frames;
  range.windowTimestamp = timestamp;
  return range;
}

function summarizeFrameRate(range: FrameRateRange): FrameRateSummary {
  return {
    averageFps:
      range.lastTimestamp > range.firstTimestamp
        ? ((range.lastFrames - range.firstFrames) * 1_000) / (range.lastTimestamp - range.firstTimestamp)
        : undefined,
    minimumWindowFps: range.minimumWindowFps,
    slowWindows: range.slowWindows,
  };
}

function selectedCandidatePath(connection: ConnectionTelemetry, timestamp: number): CandidatePath | undefined {
  const byId = new Map(connection.stats.map((stat) => [stringAt(stat, "id"), stat]));
  const transport = connection.stats.find(
    (stat) => stringAt(stat, "type") === "transport" && stringAt(stat, "selectedCandidatePairId") !== undefined,
  );
  const pairId = transport === undefined ? undefined : stringAt(transport, "selectedCandidatePairId");
  const pair =
    (pairId === undefined ? undefined : byId.get(pairId)) ??
    connection.stats.find(
      (stat) => stringAt(stat, "type") === "candidate-pair" && stat.selected === true,
    );
  if (pair === undefined || stringAt(pair, "type") !== "candidate-pair") {
    return undefined;
  }

  const local = byId.get(stringAt(pair, "localCandidateId"));
  const remote = byId.get(stringAt(pair, "remoteCandidateId"));
  return {
    availableIncomingBitrate: numberAt(pair, "availableIncomingBitrate"),
    availableOutgoingBitrate: numberAt(pair, "availableOutgoingBitrate"),
    bytesReceived: numberAt(pair, "bytesReceived"),
    bytesSent: numberAt(pair, "bytesSent"),
    currentRoundTripTime: numberAt(pair, "currentRoundTripTime"),
    localCandidateType: local === undefined ? undefined : stringAt(local, "candidateType"),
    peerId: connection.peerId,
    relayProtocol: local === undefined ? undefined : stringAt(local, "relayProtocol"),
    remoteCandidateType: remote === undefined ? undefined : stringAt(remote, "candidateType"),
    timestamp,
    transportProtocol: local === undefined ? undefined : stringAt(local, "protocol"),
  };
}

export class ArtifactWriter {
  private readonly candidatePaths = new Map<string, CandidatePath>();
  private readonly connections: WriteStream;
  private readonly decoders = new Map<string, DecoderRange>();
  private readonly encoders = new Map<string, EncoderRange>();
  private failed = false;
  private finalSampleTimestamp: number | undefined;
  private readonly finalConnectionStates = new Map<string, string>();
  private firstSampleTimestamp: number | undefined;
  private readonly metrics: WriteStream;
  private readonly playback: WriteStream;
  private readonly playbackRanges = new Map<string, PlaybackRange>();
  private readonly previous = new Map<string, NumericSnapshot>();
  private readonly rawStats: WriteStream;
  private sampleCount = 0;
  private readonly streams = new Map<string, StreamSummary>();
  private source: SourceRange | undefined;

  private constructor(
    private readonly outputDirectory: string,
    private readonly metadata: ArtifactMetadata,
  ) {
    this.connections = createWriteStream(join(this.outputDirectory, "connections.csv"));
    this.metrics = createWriteStream(join(this.outputDirectory, "timeline.csv"));
    this.playback = createWriteStream(join(this.outputDirectory, "playback.csv"));
    this.rawStats = createWriteStream(join(this.outputDirectory, "raw-stats.ndjson"));
    this.metrics.write(
      "timestamp_ms,peer_id,direction,kind,stat_id,rid,bitrate_bps,packet_loss_fraction,jitter_ms,jitter_buffer_delay_ms,jitter_buffer_target_delay_ms,width,height,frames_per_second,target_bitrate,quality_limitation_reason,packets_lost,packets_received,packets_discarded,nack_count,retransmitted_packets,frames_decoded,frames_encoded,freeze_count\n",
    );
    this.connections.write(
      "timestamp_ms,peer_id,local_candidate_type,remote_candidate_type,transport_protocol,relay_protocol,current_rtt_ms,available_outgoing_bitrate,available_incoming_bitrate,bytes_sent,bytes_received\n",
    );
    this.playback.write(
      "timestamp_ms,peer_id,total_video_frames,dropped_video_frames,video_width,video_height\n",
    );
  }

  static async create(outputDirectory: string, metadata: ArtifactMetadata): Promise<ArtifactWriter> {
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(join(outputDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return new ArtifactWriter(outputDirectory, metadata);
  }

  async writeEvent(event: BrowserAgentEvent): Promise<void> {
    if (event.type === "sample") {
      await this.writeSample(event.sample);
      return;
    }
    if (event.type === "fatal") {
      this.failed = true;
    }
    await this.write(this.rawStats, JSON.stringify({ event, receivedAt: new Date().toISOString(), type: "event" }));
  }

  async finalize(): Promise<RunSummary> {
    const videoPacing = this.videoPacing();
    const validation = this.validate(videoPacing);
    const summary: RunSummary = {
      candidatePaths: [...this.candidatePaths.values()].sort((left, right) => left.peerId.localeCompare(right.peerId)),
      completedAt: new Date().toISOString(),
      mode: this.metadata.mode,
      sampleCount: this.sampleCount,
      status: this.failed || !validation.valid ? "failed" : "complete",
      streams: [...this.streams.values()]
        .map((stream) => ({
          ...stream,
          averageBitrateBps:
            stream.endTimestamp > stream.startTimestamp
              ? ((stream.endBytes - stream.startBytes) * 8_000) / (stream.endTimestamp - stream.startTimestamp)
              : 0,
        }))
        .sort((left, right) => left.peerId.localeCompare(right.peerId) || left.statId.localeCompare(right.statId)),
      validation,
      videoPacing,
    };
    await this.close();
    await fs.writeFile(join(this.outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
  }

  private async writeSample(sample: BrowserTelemetrySample): Promise<void> {
    this.sampleCount += 1;
    this.firstSampleTimestamp ??= sample.browserTimestampMs;
    this.finalSampleTimestamp = sample.browserTimestampMs;
    this.updateSourcePacing(sample);
    await this.write(this.rawStats, JSON.stringify({ type: "sample", sample }));
    for (const connection of sample.connections) {
      this.finalConnectionStates.set(connection.peerId, connection.connectionState);
      const path = selectedCandidatePath(connection, sample.browserTimestampMs);
      if (path !== undefined) {
        this.candidatePaths.set(connection.peerId, path);
        await this.write(
          this.connections,
          csv([
            path.timestamp,
            path.peerId,
            path.localCandidateType,
            path.remoteCandidateType,
            path.transportProtocol,
            path.relayProtocol,
            path.currentRoundTripTime === undefined ? undefined : path.currentRoundTripTime * 1_000,
            path.availableOutgoingBitrate,
            path.availableIncomingBitrate,
            path.bytesSent,
            path.bytesReceived,
          ]),
        );
      }

      for (const stat of connection.stats) {
        const statType = stringAt(stat, "type");
        if (statType !== "inbound-rtp" && statType !== "outbound-rtp" && statType !== "remote-inbound-rtp") {
          continue;
        }
        await this.writeRtpMetric(
          sample.browserTimestampMs,
          connection.peerId,
          stat,
          statType === "inbound-rtp" ? "inbound" : statType === "outbound-rtp" ? "outbound" : "remote-inbound",
        );
      }
    }
    for (const quality of sample.playback) {
      const existing = this.playbackRanges.get(quality.peerId);
      const resolution = `${quality.videoWidth}x${quality.videoHeight}`;
      this.playbackRanges.set(quality.peerId, {
        droppedFrames: quality.droppedVideoFrames,
        lastHeight: quality.videoHeight,
        lastFrames: quality.totalVideoFrames,
        lastTimestamp: sample.browserTimestampMs,
        lastWidth: quality.videoWidth,
        resolutions:
          resolution === "0x0" || existing?.resolutions.at(-1) === resolution
            ? (existing?.resolutions ?? [])
            : [...(existing?.resolutions ?? []), resolution],
      });
      await this.writePlayback(sample.browserTimestampMs, quality);
    }
  }

  private updateSourcePacing(sample: BrowserTelemetrySample): void {
    this.source = {
      frameRate: updateFrameRate(this.source?.frameRate, sample.videoSource.capturedFrames, sample.browserTimestampMs),
      missedFrameSlots: sample.videoSource.missedFrameSlots,
    };
  }

  private videoPacing(): VideoPacingSummary {
    return {
      encoders: [...this.encoders.values()]
        .map((encoder) => ({
          ...summarizeFrameRate(encoder.frameRate),
          peerId: encoder.peerId,
          rid: encoder.rid,
          statId: encoder.statId,
        }))
        .sort((left, right) => left.peerId.localeCompare(right.peerId) || left.statId.localeCompare(right.statId)),
      playback: [...this.playbackRanges.entries()]
        .map(([peerId, playback]) => ({
          droppedFrames: playback.droppedFrames,
          peerId,
          resolutions: playback.resolutions,
          totalFrames: playback.lastFrames,
        }))
        .sort((left, right) => left.peerId.localeCompare(right.peerId)),
      receivers: [...this.decoders.values()]
        .map((decoder) => ({
          ...summarizeFrameRate(decoder.frameRate),
          peerId: decoder.peerId,
          resolutions: decoder.resolutions,
          statId: decoder.statId,
        }))
        .sort((left, right) => left.peerId.localeCompare(right.peerId) || left.statId.localeCompare(right.statId)),
      source:
        this.source === undefined
          ? null
          : {
              ...summarizeFrameRate(this.source.frameRate),
              capturedFrames: this.source.frameRate.lastFrames,
              missedFrameSlots: this.source.missedFrameSlots,
            },
      targetFps: TARGET_VIDEO_FPS,
    };
  }

  private async writeRtpMetric(
    timestamp: number,
    peerId: string,
    stat: Record<string, unknown>,
    direction: "inbound" | "outbound" | "remote-inbound",
  ): Promise<void> {
    const statId = stringAt(stat, "id");
    if (statId === undefined) {
      return;
    }
    const bytes = numberAt(stat, direction === "inbound" ? "bytesReceived" : "bytesSent");
    const packetsReceived = numberAt(stat, "packetsReceived");
    const packetsLost = numberAt(stat, "packetsLost");
    const jitterBufferDelay = numberAt(stat, "jitterBufferDelay");
    const jitterBufferEmittedCount = numberAt(stat, "jitterBufferEmittedCount");
    const jitterBufferTargetDelay = numberAt(stat, "jitterBufferTargetDelay");
    const key = `${peerId}:${statId}`;
    const previous = this.previous.get(key);
    const elapsedMs = previous === undefined ? undefined : timestamp - previous.timestamp;
    const bitrateBps =
      previous === undefined || bytes === undefined || previous.bytes === undefined || elapsedMs === undefined || elapsedMs <= 0
        ? undefined
        : ((bytes - previous.bytes) * 8_000) / elapsedMs;
    const packetLossFraction =
      previous === undefined ||
      packetsLost === undefined ||
      packetsReceived === undefined ||
      previous.packetsLost === undefined ||
      previous.packetsReceived === undefined
        ? numberAt(stat, "fractionLost")
        : (() => {
            const lost = packetsLost - previous.packetsLost;
            const received = packetsReceived - previous.packetsReceived;
            return lost + received > 0 ? lost / (lost + received) : numberAt(stat, "fractionLost");
          })();
    const averageJitterBufferDelayMs =
      previous === undefined ||
      jitterBufferDelay === undefined ||
      jitterBufferEmittedCount === undefined ||
      previous.jitterBufferDelay === undefined ||
      previous.jitterBufferEmittedCount === undefined
        ? undefined
        : (() => {
            const delay = jitterBufferDelay - previous.jitterBufferDelay;
            const emitted = jitterBufferEmittedCount - previous.jitterBufferEmittedCount;
          return emitted > 0 ? (delay * 1_000) / emitted : undefined;
        })();
    const averageJitterBufferTargetDelayMs =
      previous === undefined ||
      jitterBufferTargetDelay === undefined ||
      jitterBufferEmittedCount === undefined ||
      previous.jitterBufferTargetDelay === undefined ||
      previous.jitterBufferEmittedCount === undefined
        ? undefined
        : (() => {
            const targetDelay = jitterBufferTargetDelay - previous.jitterBufferTargetDelay;
            const emitted = jitterBufferEmittedCount - previous.jitterBufferEmittedCount;
            return emitted > 0 ? (targetDelay * 1_000) / emitted : undefined;
          })();

    this.previous.set(key, {
      bytes,
      jitterBufferDelay,
      jitterBufferEmittedCount,
      jitterBufferTargetDelay,
      packetsLost,
      packetsReceived,
      timestamp,
    });
    if (bytes !== undefined) {
      this.updateStreamSummary(timestamp, peerId, stat, direction, bytes);
    }
    if (
      direction === "outbound" &&
      bytes !== undefined &&
      bytes > 0 &&
      (stringAt(stat, "kind") ?? stringAt(stat, "mediaType")) === "video" &&
      numberAt(stat, "framesEncoded") !== undefined
    ) {
      this.updateEncoderPacing(timestamp, peerId, stat, numberAt(stat, "framesEncoded")!);
    }
    if (
      direction === "inbound" &&
      bytes !== undefined &&
      bytes > 0 &&
      (stringAt(stat, "kind") ?? stringAt(stat, "mediaType")) === "video" &&
      numberAt(stat, "framesDecoded") !== undefined
    ) {
      this.updateDecoderPacing(timestamp, peerId, stat, numberAt(stat, "framesDecoded")!);
    }

    await this.write(
      this.metrics,
      csv([
        timestamp,
        peerId,
        direction,
        stringAt(stat, "kind") ?? stringAt(stat, "mediaType"),
        statId,
        stringAt(stat, "rid"),
        bitrateBps,
        packetLossFraction,
        numberAt(stat, "jitter") === undefined ? undefined : numberAt(stat, "jitter")! * 1_000,
        averageJitterBufferDelayMs,
        averageJitterBufferTargetDelayMs,
        numberAt(stat, "frameWidth"),
        numberAt(stat, "frameHeight"),
        numberAt(stat, "framesPerSecond"),
        numberAt(stat, "targetBitrate"),
        stringAt(stat, "qualityLimitationReason"),
        packetsLost,
        packetsReceived,
        numberAt(stat, "packetsDiscarded"),
        numberAt(stat, "nackCount"),
        numberAt(stat, "retransmittedPacketsSent"),
        numberAt(stat, "framesDecoded"),
        numberAt(stat, "framesEncoded"),
        numberAt(stat, "freezeCount"),
      ]),
    );
  }

  private updateEncoderPacing(timestamp: number, peerId: string, stat: Record<string, unknown>, framesEncoded: number): void {
    const statId = stringAt(stat, "id");
    if (statId === undefined) {
      return;
    }
    const key = `${peerId}:${statId}`;
    const existing = this.encoders.get(key);
    this.encoders.set(key, {
      frameRate: updateFrameRate(existing?.frameRate, framesEncoded, timestamp),
      peerId,
      rid: stringAt(stat, "rid"),
      statId,
    });
  }

  private updateDecoderPacing(timestamp: number, peerId: string, stat: Record<string, unknown>, framesDecoded: number): void {
    const statId = stringAt(stat, "id");
    if (statId === undefined) {
      return;
    }
    const key = `${peerId}:${statId}`;
    const existing = this.decoders.get(key);
    const resolution = `${numberAt(stat, "frameWidth") ?? 0}x${numberAt(stat, "frameHeight") ?? 0}`;
    this.decoders.set(key, {
      frameRate: updateFrameRate(existing?.frameRate, framesDecoded, timestamp),
      peerId,
      resolutions:
        resolution === "0x0" || existing?.resolutions.at(-1) === resolution
          ? (existing?.resolutions ?? [])
          : [...(existing?.resolutions ?? []), resolution],
      statId,
    });
  }

  private updateStreamSummary(
    timestamp: number,
    peerId: string,
    stat: Record<string, unknown>,
    direction: "inbound" | "outbound" | "remote-inbound",
    bytes: number,
  ): void {
    const statId = stringAt(stat, "id");
    if (statId === undefined) {
      return;
    }
    const key = `${peerId}:${statId}`;
    const resolution = `${numberAt(stat, "frameWidth") ?? 0}x${numberAt(stat, "frameHeight") ?? 0}`;
    const existing = this.streams.get(key);
    if (existing === undefined) {
      this.streams.set(key, {
        direction: direction === "remote-inbound" ? "outbound" : direction,
        endBytes: bytes,
        endTimestamp: timestamp,
        kind: stringAt(stat, "kind") ?? stringAt(stat, "mediaType") ?? "unknown",
        peerId,
        resolutions: resolution === "0x0" ? [] : [resolution],
        rid: stringAt(stat, "rid"),
        startBytes: bytes,
        startTimestamp: timestamp,
        statId,
      });
      return;
    }

    existing.endBytes = bytes;
    existing.endTimestamp = timestamp;
    if (resolution !== "0x0" && existing.resolutions.at(-1) !== resolution) {
      existing.resolutions.push(resolution);
    }
  }

  private async writePlayback(timestamp: number, quality: PlaybackTelemetry): Promise<void> {
    await this.write(
      this.playback,
      csv([
        timestamp,
        quality.peerId,
        quality.totalVideoFrames,
        quality.droppedVideoFrames,
        quality.videoWidth,
        quality.videoHeight,
      ]),
    );
  }

  private validate(videoPacing: VideoPacingSummary): { errors: string[]; valid: boolean } {
    const errors: string[] = [];
    if (this.sampleCount === 0) {
      errors.push("No stats samples were received");
    }
    if (this.candidatePaths.size === 0) {
      errors.push("No selected ICE candidate pair was observed");
    }
    const expectedPeers = this.metadata.expectedMembers - 1;
    if (this.candidatePaths.size !== expectedPeers) {
      errors.push(`Observed ${this.candidatePaths.size} selected candidate paths; expected ${expectedPeers}`);
    }
    if (
      this.firstSampleTimestamp === undefined ||
      this.finalSampleTimestamp === undefined ||
      this.finalSampleTimestamp - this.firstSampleTimestamp < this.metadata.durationSeconds * 1_000 - 10_000
    ) {
      errors.push("Stats timeline did not cover the full five-minute media phase");
    }
    if (videoPacing.source === null) {
      errors.push("No paced video-source telemetry was received");
    } else {
      this.validateFrameRate(errors, "Video source", videoPacing.source);
    }
    for (const path of this.candidatePaths.values()) {
      if (this.finalConnectionStates.get(path.peerId) !== "connected") {
        errors.push(`Peer ${path.peerId} was not connected in the final stats sample`);
      }
      if ((path.bytesSent ?? 0) + (path.bytesReceived ?? 0) === 0) {
        errors.push(`Selected candidate pair for ${path.peerId} exchanged no bytes`);
      }
      const sustainedMedia = [...this.streams.values()].some(
        (stream) =>
          stream.peerId === path.peerId &&
          stream.endBytes > stream.startBytes &&
          this.finalSampleTimestamp !== undefined &&
          stream.endTimestamp >= this.finalSampleTimestamp - 2_000,
      );
      if (!sustainedMedia) {
        errors.push(`Peer ${path.peerId} did not sustain RTP media through the final sample`);
      }
      const sustainedVideo = [...this.streams.values()].some(
        (stream) =>
          stream.peerId === path.peerId &&
          stream.kind === "video" &&
          stream.endBytes > stream.startBytes &&
          this.finalSampleTimestamp !== undefined &&
          stream.endTimestamp >= this.finalSampleTimestamp - 2_000,
      );
      if (!sustainedVideo) {
        errors.push(`Peer ${path.peerId} did not sustain video RTP through the final sample`);
      }
      const playback = this.playbackRanges.get(path.peerId);
      if (
        playback === undefined ||
        playback.lastFrames === 0 ||
        playback.lastWidth === 0 ||
        playback.lastHeight === 0 ||
        (this.finalSampleTimestamp !== undefined && playback.lastTimestamp < this.finalSampleTimestamp - 2_000)
      ) {
        errors.push(`Peer ${path.peerId} did not expose receiver video dimensions through the final sample`);
      }
      const encoder = videoPacing.encoders
        .filter((candidate) => candidate.peerId === path.peerId)
        .sort((left, right) => (right.averageFps ?? -1) - (left.averageFps ?? -1))[0];
      if (encoder === undefined) {
        errors.push(`Peer ${path.peerId} did not expose outbound video encoder counters`);
      } else {
        this.validateFrameRate(errors, `Encoder peer=${path.peerId}${encoder.rid === undefined ? "" : ` rid=${encoder.rid}`}`, encoder);
      }
      const receiver = videoPacing.receivers
        .filter((candidate) => candidate.peerId === path.peerId)
        .sort((left, right) => (right.averageFps ?? -1) - (left.averageFps ?? -1))[0];
      if (receiver === undefined) {
        errors.push(`Peer ${path.peerId} did not expose inbound video decoder counters`);
      } else {
        this.validateFrameRate(errors, `Decoder peer=${path.peerId}`, receiver);
      }
      if (this.metadata.mode === "relay") {
        if (path.localCandidateType !== "relay" || path.remoteCandidateType !== "relay") {
          errors.push(`Peer ${path.peerId} did not use relay candidates on both sides`);
        }
      } else if (path.localCandidateType === "relay" || path.remoteCandidateType === "relay") {
        errors.push(`Peer ${path.peerId} used a relay candidate in direct mode`);
      }
    }
    return { errors, valid: errors.length === 0 };
  }

  private validateFrameRate(errors: string[], label: string, frameRate: FrameRateSummary): void {
    if (frameRate.averageFps === undefined || frameRate.averageFps < MIN_AVERAGE_VIDEO_FPS) {
      errors.push(
        `${label} averaged ${frameRate.averageFps?.toFixed(1) ?? "no"} fps; expected at least ${MIN_AVERAGE_VIDEO_FPS} fps`,
      );
    }
    if (frameRate.minimumWindowFps === undefined) {
      errors.push(`${label} did not produce a complete ${FRAME_RATE_WINDOW_MS / 1_000}-second FPS window`);
    } else if (frameRate.slowWindows > 0) {
      errors.push(
        `${label} fell below ${MIN_WINDOW_VIDEO_FPS} fps in ${frameRate.slowWindows} ${FRAME_RATE_WINDOW_MS / 1_000}-second window(s)`,
      );
    }
  }

  private async write(stream: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
    if (!stream.write(`${line}\n`)) {
      await new Promise<void>((resolve) => stream.once("drain", resolve));
    }
  }

  private async close(): Promise<void> {
    this.rawStats.end();
    this.metrics.end();
    this.connections.end();
    this.playback.end();
    await Promise.all([finished(this.rawStats), finished(this.metrics), finished(this.connections), finished(this.playback)]);
  }
}
