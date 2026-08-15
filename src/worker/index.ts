import { identifierSchema } from "../shared/protocol";
import type { RunMode, TurnCredentialResponse } from "../shared/config";
import { Room } from "./room";
import { TurnCredentialLimiter } from "./turn-credential-limiter";

export { Room } from "./room";
export { TurnCredentialLimiter } from "./turn-credential-limiter";

const TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;

type TurnCredentialRequest = {
  agentId: string;
  connectionNonce: string;
  room: string;
};

type CloudflareIceServer = {
  credential?: string;
  credentialType?: "oauth" | "password";
  urls: string | string[];
  username?: string;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function requiredSecret(env: Env, name: "CF_TURN_API_TOKEN"): string {
  const value: unknown = Reflect.get(env, name);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function roomFromPath(pathname: string): string | null {
  const match = /^\/signal\/([^/]+)$/.exec(pathname);
  if (match?.[1] === undefined) {
    return null;
  }

  try {
    return identifierSchema.safeParse(decodeURIComponent(match[1])).data ?? null;
  } catch {
    return null;
  }
}

function isTurnCredentialRequest(value: unknown): value is TurnCredentialRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    identifierSchema.safeParse(record.room).success &&
    identifierSchema.safeParse(record.agentId).success &&
    typeof record.connectionNonce === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.connectionNonce)
  );
}

function isIceServer(value: unknown): value is CloudflareIceServer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const urls = record.urls;
  const validUrls = typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string"));
  return (
    validUrls &&
    (record.username === undefined || typeof record.username === "string") &&
    (record.credential === undefined || typeof record.credential === "string") &&
    (record.credentialType === undefined || record.credentialType === "password" || record.credentialType === "oauth")
  );
}

export function normalizeCloudflareIceServers(value: unknown): CloudflareIceServer[] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const iceServers = (value as Record<string, unknown>).iceServers;
  const servers = Array.isArray(iceServers) ? iceServers : [iceServers];
  return servers.length > 0 && servers.every(isIceServer) ? servers : null;
}

async function claimTurnCredential(env: Env, room: string, agentId: string, connectionNonce: string): Promise<boolean> {
  const response = await env.ROOMS.getByName(room).fetch(
    `https://room.internal/internal/turn-credential?agentId=${encodeURIComponent(agentId)}&nonce=${encodeURIComponent(connectionNonce)}`,
  );
  if (!response.ok) {
    return false;
  }
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).claimed === true;
}

async function withinTurnCredentialLimit(env: Env): Promise<boolean> {
  const response = await env.TURN_CREDENTIAL_LIMITER.getByName("global").fetch("https://limiter.internal/claim", {
    method: "POST",
  });
  if (!response.ok) {
    return false;
  }
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && (body as Record<string, unknown>).allowed === true;
}

async function turnCredentials(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON request body" }, 400);
  }
  if (!isTurnCredentialRequest(body)) {
    return json({ error: "Invalid credential request" }, 400);
  }

  const turnKeyId = env.CF_TURN_KEY_ID;
  if (turnKeyId === "set-in-dashboard-or-wrangler-vars") {
    return json({ error: "CF_TURN_KEY_ID is not configured" }, 503);
  }
  if (!(await claimTurnCredential(env, body.room, body.agentId, body.connectionNonce))) {
    return json({ error: "Join the room before requesting one TURN credential" }, 403);
  }
  if (!(await withinTurnCredentialLimit(env))) {
    return json({ error: "TURN credential issuance limit reached" }, 429);
  }

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(turnKeyId)}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredSecret(env, "CF_TURN_API_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ttl: TURN_CREDENTIAL_TTL_SECONDS,
        customIdentifier: `${body.room}:${body.agentId}:${crypto.randomUUID()}`,
      }),
    },
  );
  if (!upstream.ok) {
    const upstreamRay = upstream.headers.get("cf-ray");
    console.error(JSON.stringify({ event: "turn_credential_error", status: upstream.status, upstreamRay }));
    return json(
      {
        error: "TURN credential generation failed",
        upstreamRay,
        upstreamStatus: upstream.status,
      },
      502,
    );
  }

  const upstreamBody: unknown = await upstream.json();
  const iceServers = normalizeCloudflareIceServers(upstreamBody);
  if (iceServers === null) {
    console.error(JSON.stringify({ event: "turn_credential_shape_error" }));
    return json({ error: "TURN credential service returned an unexpected iceServers shape" }, 502);
  }

  const response: TurnCredentialResponse = {
    iceServers,
    mode: "relay" satisfies RunMode,
  };
  console.log(
    JSON.stringify({
      agentId: body.agentId,
      event: "turn_credential_issued",
      iceServerCount: response.iceServers.length,
      room: body.room,
    }),
  );
  return json(response);
}

function sessionPreflight(): Response {
  return json({ ok: true });
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/turn-credentials") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      try {
        return await turnCredentials(request, env);
      } catch (error) {
        console.error(JSON.stringify({ event: "turn_credential_exception", error: String(error) }));
        return json({ error: "TURN credential configuration is invalid" }, 503);
      }
    }
    if (url.pathname === "/api/session") {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }
      return sessionPreflight();
    }

    const roomName = roomFromPath(url.pathname);
    if (roomName !== null) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      return env.ROOMS.getByName(roomName).fetch(request);
    }
    if (url.pathname.startsWith("/signal/")) {
      return new Response("Invalid room name", { status: 400 });
    }
    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;
