import { DurableObject } from "cloudflare:workers";

const ONE_HOUR_MS = 60 * 60 * 1_000;

export class TurnCredentialLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS issuance_window (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        count INTEGER NOT NULL,
        started_at INTEGER NOT NULL
      )
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/claim") {
      return new Response("Not found", { status: 404 });
    }

    const limit = Number.parseInt(this.env.MAX_TURN_CREDENTIALS_PER_HOUR, 10);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return Response.json({ allowed: false }, { status: 503 });
    }
    const now = Date.now();
    const current = this.ctx.storage.sql.exec<{ count: number; started_at: number }>("SELECT count, started_at FROM issuance_window WHERE id = 1").toArray()[0];
    if (current === undefined || now - current.started_at >= ONE_HOUR_MS) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO issuance_window (id, count, started_at) VALUES (1, 1, ?)",
        now,
      );
      return Response.json({ allowed: true });
    }
    if (current.count >= limit) {
      return Response.json({ allowed: false }, { status: 429 });
    }

    this.ctx.storage.sql.exec("UPDATE issuance_window SET count = count + 1 WHERE id = 1");
    return Response.json({ allowed: true });
  }
}
