import { DurableObject } from "cloudflare:workers";

import { DEFAULT_TEST_DURATION_MS } from "../shared/config";
import {
  clientMessageSchema,
  type RoomSocketState,
  roomSocketStateSchema,
  type ServerMessage,
} from "../shared/protocol";

type RoomConfig = {
  durationMs: number;
  endsAt: number | null;
  expectedMembers: number;
  runId: string | null;
  status: "collecting" | "running" | "complete" | "failed";
};

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        expected_members INTEGER NOT NULL,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        run_id TEXT,
        ends_at INTEGER
      )
    `);
    const roomColumns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(room_config)").toArray();
    if (!roomColumns.some((column) => column.name === "duration_ms")) {
      this.ctx.storage.sql.exec("ALTER TABLE room_config ADD COLUMN duration_ms INTEGER");
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/turn-credential") {
      const agentId = url.searchParams.get("agentId");
      const nonce = url.searchParams.get("nonce");
      if (agentId === null || nonce === null) {
        return Response.json({ claimed: false }, { status: 400 });
      }
      return Response.json({ claimed: this.claimTurnCredential(agentId, nonce) });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (client === undefined || server === undefined) {
      throw new Error("Failed to create WebSocket pair");
    }
    this.ctx.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": "webrtc-benchmark" },
      webSocket: client,
    });
  }

  override async alarm(): Promise<void> {
    const config = this.config();
    if (config?.status !== "running" || config.endsAt === null || config.runId === null) {
      return;
    }
    if (config.endsAt > Date.now()) {
      await this.ctx.storage.setAlarm(config.endsAt);
      return;
    }

    this.updateStatus("complete");
    this.broadcast({ type: "complete", runId: config.runId });
  }

  override async webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.send(webSocket, { type: "error", reason: "Binary signaling messages are not supported" });
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(message);
    } catch {
      this.send(webSocket, { type: "error", reason: "Invalid JSON signaling message" });
      return;
    }

    const parsedMessage = clientMessageSchema.safeParse(parsedJson);
    if (!parsedMessage.success) {
      this.send(webSocket, { type: "error", reason: "Invalid signaling message" });
      return;
    }

    const state = this.socketState(webSocket);
    const clientMessage = parsedMessage.data;
    if (clientMessage.type === "join") {
      await this.join(webSocket, state, clientMessage.agentId, clientMessage.expectedMembers, clientMessage.durationMs);
      return;
    }

    if (state === null) {
      this.send(webSocket, { type: "error", reason: "Join the room before signaling" });
      return;
    }

    if (clientMessage.type === "signal") {
      const recipient = this.members().find((member) => member.state.agentId === clientMessage.to);
      if (recipient === undefined) {
        this.send(webSocket, { type: "error", reason: "Signaling recipient is not in the room" });
        return;
      }

      this.send(recipient.webSocket, {
        type: "signal",
        from: state.agentId,
        payload: clientMessage.payload,
      });
      return;
    }

    if (clientMessage.type === "ready") {
      await this.markReady(webSocket, state);
      return;
    }

    webSocket.serializeAttachment({ ...state, finished: true } satisfies RoomSocketState);
  }

  override async webSocketClose(
    webSocket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    const state = this.socketState(webSocket);
    webSocket.close(code, reason);
    if (state === null) {
      return;
    }

    const config = this.config();
    if (state.finished || config?.status === "complete") {
      return;
    }
    if (config?.status === "running") {
      this.updateStatus("failed");
      this.broadcast({ type: "run-failed", reason: `Peer ${state.agentId} disconnected during the run` }, webSocket);
      return;
    }

    this.broadcast({ type: "peer-left", agentId: state.agentId }, webSocket);
  }

  override webSocketError(webSocket: WebSocket, error: unknown): void {
    console.error(JSON.stringify({ event: "websocket_error", error: String(error) }));
    webSocket.close(1011, "WebSocket error");
  }

  private async join(
    webSocket: WebSocket,
    currentState: RoomSocketState | null,
    agentId: string,
    expectedMembers: number,
    durationMs: number,
  ): Promise<void> {
    if (currentState !== null) {
      this.send(webSocket, { type: "error", reason: "A WebSocket can join only once" });
      return;
    }

    const maximumMembers = Number.parseInt(this.env.MAX_ROOM_MEMBERS, 10);
    if (!Number.isSafeInteger(maximumMembers) || expectedMembers > maximumMembers) {
      this.send(webSocket, { type: "error", reason: "Room member limit exceeded" });
      return;
    }

    const existingConfig = this.config();
    if (existingConfig === null) {
      this.ctx.storage.sql.exec(
        "INSERT INTO room_config (id, expected_members, duration_ms, status, run_id, ends_at) VALUES (1, ?, ?, 'collecting', NULL, NULL)",
        expectedMembers,
        durationMs,
      );
    } else if (existingConfig.status !== "collecting") {
      this.send(webSocket, { type: "error", reason: "This room has already started or failed; use a new room name" });
      return;
    } else if (existingConfig.expectedMembers !== expectedMembers) {
      this.send(webSocket, { type: "error", reason: "Room expected member count does not match" });
      return;
    } else if (existingConfig.durationMs !== durationMs) {
      this.send(webSocket, { type: "error", reason: "Room test duration does not match" });
      return;
    }

    const members = this.members();
    if (members.length >= expectedMembers) {
      this.send(webSocket, { type: "error", reason: "Room is full" });
      return;
    }
    if (members.some((member) => member.state.agentId === agentId)) {
      this.send(webSocket, { type: "error", reason: "Agent ID is already connected" });
      return;
    }

    const turnCredentialNonce = crypto.randomUUID();
    webSocket.serializeAttachment({
      agentId,
      finished: false,
      ready: false,
      turnCredentialIssued: false,
      turnCredentialNonce,
    } satisfies RoomSocketState);
    this.send(webSocket, {
      type: "joined",
      peers: members.map((member) => member.state.agentId),
      turnCredentialNonce,
    });
    this.broadcast({ type: "peer-joined", agentId }, webSocket);
  }

  private async markReady(webSocket: WebSocket, state: RoomSocketState): Promise<void> {
    const config = this.config();
    if (config === null || config.status !== "collecting") {
      this.send(webSocket, { type: "error", reason: "The room is not accepting ready events" });
      return;
    }

    webSocket.serializeAttachment({ ...state, ready: true } satisfies RoomSocketState);
    const members = this.members();
    if (members.length !== config.expectedMembers || !members.every((member) => member.state.ready)) {
      return;
    }

    const runId = crypto.randomUUID();
    const endsAt = Date.now() + config.durationMs;
    this.ctx.storage.sql.exec(
      "UPDATE room_config SET status = 'running', run_id = ?, ends_at = ? WHERE id = 1",
      runId,
      endsAt,
    );
    await this.ctx.storage.setAlarm(endsAt);
    this.broadcast({ type: "start", runId, durationMs: config.durationMs });
  }

  private config(): RoomConfig | null {
    const row = this.ctx.storage.sql
      .exec<{
        duration_ms: number | null;
        ends_at: number | null;
        expected_members: number;
        run_id: string | null;
        status: RoomConfig["status"];
      }>(
        "SELECT duration_ms, expected_members, status, run_id, ends_at FROM room_config WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) {
      return null;
    }

    return {
      durationMs: row.duration_ms ?? DEFAULT_TEST_DURATION_MS,
      endsAt: row.ends_at,
      expectedMembers: row.expected_members,
      runId: row.run_id,
      status: row.status,
    };
  }

  private updateStatus(status: RoomConfig["status"]): void {
    this.ctx.storage.sql.exec("UPDATE room_config SET status = ? WHERE id = 1", status);
  }

  private claimTurnCredential(agentId: string, nonce: string): boolean {
    const config = this.config();
    if (config === null || (config.status !== "collecting" && config.status !== "running")) {
      return false;
    }
    const member = this.members().find((candidate) => candidate.state.agentId === agentId);
    if (
      member === undefined ||
      member.state.turnCredentialIssued ||
      member.state.turnCredentialNonce !== nonce
    ) {
      return false;
    }
    member.webSocket.serializeAttachment({ ...member.state, turnCredentialIssued: true } satisfies RoomSocketState);
    return true;
  }

  private members(): Array<{ state: RoomSocketState; webSocket: WebSocket }> {
    return this.ctx
      .getWebSockets()
      .map((webSocket) => {
        const state = this.socketState(webSocket);
        return state === null ? null : { state, webSocket };
      })
      .filter((member): member is { state: RoomSocketState; webSocket: WebSocket } => member !== null);
  }

  private socketState(webSocket: WebSocket): RoomSocketState | null {
    return roomSocketStateSchema.safeParse(webSocket.deserializeAttachment()).data ?? null;
  }

  private broadcast(message: ServerMessage, excluded?: WebSocket): void {
    for (const member of this.members()) {
      if (member.webSocket !== excluded) {
        this.send(member.webSocket, message);
      }
    }
  }

  private send(webSocket: WebSocket, message: ServerMessage): void {
    if (webSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      webSocket.send(JSON.stringify(message));
    } catch (error) {
      console.error(JSON.stringify({ event: "websocket_send_error", error: String(error) }));
    }
  }
}
