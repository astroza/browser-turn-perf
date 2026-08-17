import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

import { authorizeCloudflareAccess } from "./access";
import { ArtifactWriter, type ArtifactMetadata } from "./metrics";
import type { BrowserAgentConfig, BrowserAgentEvent, RunMode, VideoSource } from "../shared/config";
import { identifierSchema } from "../shared/protocol";

type AgentOptions = {
  accessLogin: boolean;
  agentId: string;
  durationSeconds: number;
  expectedMembers: number;
  mode: RunMode;
  outputDirectory: string;
  room: string;
  signalOrigin: string;
  turnServer: string | undefined;
  videoY4mPath: string | undefined;
};

function usage(): string {
  return [
    "Usage: npm run agent -- --signal-url https://signal.example --room run-001 --agent-id server-1 --expected-members 2 --mode relay --output ./runs/run-001/server-1",
    "",
    "Options:",
    "  --signal-url <URL>        Worker origin serving the harness",
    "  --room <ID>                Shared room ID (letters, digits, _ and -)",
    "  --agent-id <ID>            Unique ID for this host",
    "  --expected-members <N>     Number of agents in the mesh",
    "  --mode <relay|direct>      Force TURN relay or forbid relay candidates",
    "  --turn-server <URL>        Replace Cloudflare's TURN URL but retain its credentials",
    "  --access-login              Print an Access URL and wait for user authorization",
    "  --video-y4m <PATH>         Use a Y4M file through Chromium's fake camera",
    "  --output <PATH>            Local artifact directory",
    "  --duration-seconds <N>     Must be 300; default: 300",
  ].join("\n");
}

function parseArguments(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  const flagOptions = new Set(["access-login"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }
    const parsed = argument.slice(2).split("=", 2);
    const name = parsed[0];
    const inlineValue = parsed[1];
    if (name === undefined || name.length === 0) {
      throw new Error("Argument name cannot be empty");
    }
    if (flagOptions.has(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} does not accept a value`);
      }
      if (values.has(name)) {
        throw new Error(`Duplicate option --${name}`);
      }
      values.set(name, "true");
      continue;
    }
    const nextValue = inlineValue ?? argv[index + 1];
    if (nextValue === undefined || nextValue.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate option --${name}`);
    }
    values.set(name, nextValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }
  return values;
}

function requiredOption(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function integerOption(values: Map<string, string>, name: string, fallback?: number): number {
  const raw = values.get(name);
  if (raw === undefined && fallback !== undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

function identifierOption(values: Map<string, string>, name: string): string {
  const value = requiredOption(values, name);
  if (!identifierSchema.safeParse(value).success) {
    throw new Error(`--${name} must contain only letters, digits, _ and -`);
  }
  return value;
}

function turnServerOption(values: Map<string, string>): string | undefined {
  const value = values.get("turn-server");
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "turn:" && url.protocol !== "turns:") {
      throw new Error();
    }
  } catch {
    throw new Error("--turn-server must be a valid turn or turns URL");
  }
  return value;
}

function optionsFrom(argv: string[]): AgentOptions {
  const values = parseArguments(argv);
  const knownOptions = new Set([
    "agent-id",
    "access-login",
    "duration-seconds",
    "expected-members",
    "mode",
    "output",
    "room",
    "signal-url",
    "turn-server",
    "video-y4m",
  ]);
  for (const option of values.keys()) {
    if (!knownOptions.has(option)) {
      throw new Error(`Unknown option --${option}`);
    }
  }

  const parsedUrl = new URL(requiredOption(values, "signal-url"));
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("--signal-url must use http or https");
  }
  if (values.has("access-login") && parsedUrl.protocol !== "https:") {
    throw new Error("--access-login requires an https --signal-url");
  }
  const expectedMembers = integerOption(values, "expected-members");
  if (expectedMembers < 2 || expectedMembers > 8) {
    throw new Error("--expected-members must be between 2 and 8, matching the deployed room limit");
  }
  const durationSeconds = integerOption(values, "duration-seconds", 300);
  if (durationSeconds !== 300) {
    throw new Error("--duration-seconds must be 300 because the room starts fixed five-minute runs");
  }
  const mode = requiredOption(values, "mode");
  if (mode !== "relay" && mode !== "direct") {
    throw new Error("--mode must be relay or direct");
  }
  const turnServer = turnServerOption(values);
  if (turnServer !== undefined && mode !== "relay") {
    throw new Error("--turn-server requires --mode relay");
  }

  return {
    accessLogin: values.has("access-login"),
    agentId: identifierOption(values, "agent-id"),
    durationSeconds,
    expectedMembers,
    mode,
    outputDirectory: requiredOption(values, "output"),
    room: identifierOption(values, "room"),
    signalOrigin: parsedUrl.origin,
    turnServer,
    videoY4mPath: values.has("video-y4m") ? resolve(requiredOption(values, "video-y4m")) : undefined,
  };
}

async function validateVideoY4m(path: string | undefined): Promise<void> {
  if (path === undefined) {
    return;
  }
  const stat = await fs.stat(path);
  if (!stat.isFile()) {
    throw new Error(`--video-y4m must be a file: ${path}`);
  }
  if (!path.toLowerCase().endsWith(".y4m")) {
    throw new Error("--video-y4m must reference a .y4m file");
  }
}

function eventIsValid(value: unknown): value is BrowserAgentEvent {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).type === "string";
}

async function main(): Promise<void> {
  const options = optionsFrom(process.argv.slice(2));
  await validateVideoY4m(options.videoY4mPath);
  if (options.turnServer !== undefined) {
    console.log(`Overriding TURN server with ${options.turnServer}`);
  }
  const cloudflareAccessToken = options.accessLogin
    ? await authorizeCloudflareAccess(options.signalOrigin, {
        onAuthorizationUrl: (url) => {
          console.log("Cloudflare Access authorization is required. Open this URL and complete SSO:");
          console.log(url);
        },
      })
    : undefined;
  const videoSource: VideoSource = options.videoY4mPath === undefined ? "canvas" : "fake-camera";
  const browser = await chromium.launch({
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      ...(options.videoY4mPath === undefined
        ? []
        : ["--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${options.videoY4mPath}`]),
    ],
    ...(process.env.CHROMIUM_EXECUTABLE_PATH === undefined
      ? { channel: "chromium" as const }
      : { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }),
    headless: true,
  });
  const metadata: ArtifactMetadata = {
    agentId: options.agentId,
    browserVersion: browser.version(),
    durationSeconds: options.durationSeconds,
    expectedMembers: options.expectedMembers,
    mode: options.mode,
    room: options.room,
    signalOrigin: options.signalOrigin,
    startedAt: new Date().toISOString(),
    videoSource,
  };
  const artifacts = await ArtifactWriter.create(options.outputDirectory, metadata);
  const browserConfig: BrowserAgentConfig = {
    agentId: options.agentId,
    durationMs: options.durationSeconds * 1_000,
    expectedMembers: options.expectedMembers,
    mode: options.mode,
    room: options.room,
    sampleIntervalMs: 1_000,
    signalOrigin: options.signalOrigin,
    turnServer: options.turnServer,
    videoSource,
  };
  let complete = false;
  let fatalMessage: string | undefined;
  let resolveCompletion: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const context = await browser.newContext({
    viewport: { height: 720, width: 1280 },
    ...(cloudflareAccessToken === undefined ? {} : { extraHTTPHeaders: { "cf-access-token": cloudflareAccessToken } }),
  });
  if (cloudflareAccessToken !== undefined) {
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: cloudflareAccessToken,
        url: options.signalOrigin,
        httpOnly: true,
        sameSite: "None",
        secure: true,
      },
    ]);
  }
  if (videoSource === "fake-camera") {
    await context.grantPermissions(["camera"], { origin: options.signalOrigin });
  }
  const page = await context.newPage();
  await page.addInitScript((value: BrowserAgentConfig) => {
    window.__WEBRTC_BENCHMARK_CONFIG__ = value;
  }, browserConfig);
  await page.exposeBinding("__agentEvent", async (_source, event: unknown) => {
    if (!eventIsValid(event)) {
      fatalMessage = "Browser emitted an invalid telemetry event";
      resolveCompletion?.();
      return;
    }
    await artifacts.writeEvent(event);
    if (event.type === "fatal") {
      fatalMessage = event.message;
      resolveCompletion?.();
    }
    if (event.type === "complete") {
      complete = true;
      resolveCompletion?.();
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      console.error(`[browser:${message.type()}] ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(`[browser:http] ${response.status()} ${response.request().resourceType()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => {
    fatalMessage ??= error.message;
    resolveCompletion?.();
  });

  let runError: unknown;
  const timeout = setTimeout(() => {
    resolveCompletion?.();
    fatalMessage ??= "Timed out waiting for benchmark completion";
  }, options.durationSeconds * 1_000 + 120_000);
  try {
    await page.goto(new URL("/", options.signalOrigin).toString(), { waitUntil: "domcontentloaded" });
    await completion;
  } catch (error) {
    runError = error;
  } finally {
    clearTimeout(timeout);
    await context.close();
    await browser.close();
  }

  const summary = await artifacts.finalize();
  if (runError !== undefined || !complete || fatalMessage !== undefined || !summary.validation.valid) {
    const failures = [
      runError instanceof Error ? runError.message : runError === undefined ? undefined : String(runError),
      fatalMessage,
      ...summary.validation.errors,
    ].filter((value): value is string => value !== undefined);
    throw new Error(failures.join("; ") || "Benchmark did not complete");
  }
  console.log(JSON.stringify({ output: options.outputDirectory, status: summary.status, streams: summary.streams.length }));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Benchmark agent failed: ${message}`);
  process.exitCode = 1;
});
