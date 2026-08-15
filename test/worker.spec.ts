import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { clientMessageSchema } from "../src/shared/protocol";
import { normalizeCloudflareIceServers } from "../src/worker/index";

describe("signaling Worker", () => {
  it("requires a WebSocket upgrade for a valid room", async () => {
    const response = await SELF.fetch("https://example.test/signal/run_001");

    expect(response.status).toBe(426);
  });

  it("rejects invalid room names instead of serving a static asset", async () => {
    const response = await SELF.fetch("https://example.test/signal/room%20name");

    expect(response.status).toBe(400);
  });

  it("does not report Chrome's automatic favicon request as a missing asset", async () => {
    const response = await SELF.fetch("https://example.test/favicon.ico");

    expect(response.status).toBe(204);
  });

  it("rejects a TURN credential request without a room claim", async () => {
    const response = await SELF.fetch("https://example.test/api/turn-credentials", { method: "POST" });

    expect(response.status).toBe(400);
  });

  it("accepts a signaling preflight after Cloudflare Access", async () => {
    const response = await SELF.fetch("https://example.test/api/session", { method: "POST" });

    expect(response.status).toBe(200);
  });
});

describe("signaling protocol", () => {
  it("normalizes Cloudflare's single ICE server credential shape", () => {
    const iceServers = normalizeCloudflareIceServers({
      iceServers: {
        credential: "credential",
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "username",
      },
    });

    expect(iceServers).toEqual([
      {
        credential: "credential",
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "username",
      },
    ]);
  });

  it("keeps an array of ICE servers unchanged", () => {
    const iceServers = normalizeCloudflareIceServers({
      iceServers: [{ urls: "turn:turn.cloudflare.com:3478?transport=tcp" }],
    });

    expect(iceServers).toEqual([{ urls: "turn:turn.cloudflare.com:3478?transport=tcp" }]);
  });

  it("accepts a bounded ICE candidate signal", () => {
    const result = clientMessageSchema.safeParse({
      payload: {
        candidate: {
          candidate: "candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host",
          sdpMLineIndex: 0,
          sdpMid: "0",
        },
      },
      to: "server-2",
      type: "signal",
    });

    expect(result.success).toBe(true);
  });

  it("rejects spoofable signals containing both a candidate and description", () => {
    const result = clientMessageSchema.safeParse({
      payload: {
        candidate: { candidate: "candidate:1" },
        description: { sdp: "v=0", type: "offer" },
      },
      to: "server-2",
      type: "signal",
    });

    expect(result.success).toBe(false);
  });
});
