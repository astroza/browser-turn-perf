import { z } from "zod";

export const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const descriptionSchema = z
  .object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(200_000),
  })
  .strict();

const candidateSchema = z
  .object({
    candidate: z.string().max(16_384),
    sdpMid: z.string().max(128).nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  })
  .strict();

const signalPayloadSchema = z
  .object({
    description: descriptionSchema.optional(),
    candidate: candidateSchema.optional(),
  })
  .strict()
  .refine(
    (payload) => Number(payload.description !== undefined) + Number(payload.candidate !== undefined) === 1,
    "A signal must contain exactly one description or candidate",
  );

export const clientMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("join"),
      agentId: identifierSchema,
      expectedMembers: z.number().int().min(2).max(16),
    })
    .strict(),
  z
    .object({
      type: z.literal("signal"),
      to: identifierSchema,
      payload: signalPayloadSchema,
    })
    .strict(),
  z.object({ type: z.literal("ready") }).strict(),
  z.object({ type: z.literal("finished") }).strict(),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

export type ServerMessage =
  | { type: "joined"; peers: string[]; turnCredentialNonce: string }
  | { type: "peer-joined"; agentId: string }
  | { type: "peer-left"; agentId: string }
  | { type: "signal"; from: string; payload: SignalPayload }
  | { type: "start"; runId: string; durationMs: number }
  | { type: "complete"; runId: string }
  | { type: "run-failed"; reason: string }
  | { type: "error"; reason: string };

export type RoomSocketState = {
  agentId: string;
  finished: boolean;
  ready: boolean;
  turnCredentialIssued: boolean;
  turnCredentialNonce: string;
};

export const roomSocketStateSchema = z
  .object({
    agentId: identifierSchema,
    finished: z.boolean(),
    ready: z.boolean(),
    turnCredentialIssued: z.boolean(),
    turnCredentialNonce: z.string().uuid(),
  })
  .strict();
