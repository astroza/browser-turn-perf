# WebRTC TURN Benchmark

Headless Chromium agents join a Cloudflare Worker room, exchange synthetic audio and paced video, and record browser WebRTC and playback metrics for five minutes. The same run can be forced through Cloudflare Realtime TURN or required to use a non-relay direct ICE path.

Media never passes through the Worker. The Worker serves the harness, issues short-lived TURN credentials, and forwards SDP and ICE signaling only.

## Prerequisites

- Node.js 22 or newer.
- Two or more remote Linux hosts for measurement. A same-host direct connection is only a smoke test, not an internet baseline.
- A Cloudflare account with Realtime TURN enabled and a TURN key.
- A deployed Worker hostname, such as `https://webrtc-turn-benchmark.<account>.workers.dev`.

## Install

```bash
npm install
npx playwright install --with-deps chromium
npm run build
```

If Playwright browser downloads are unavailable on a host, install a compatible system Chrome and run the agent with `CHROMIUM_EXECUTABLE_PATH`, for example `CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome`.

## Deterministic Video Input

By default, the agent generates its video from a canvas. To avoid timer-driven canvas rendering, provide a 30 fps Y4M clip with `--video-y4m`. Chromium exposes it as a fake camera and the benchmark publishes that `getUserMedia()` track.

Create a short 720p Y4M clip with FFmpeg. Chromium loops the clip when it reaches the end:

```bash
ffmpeg -stream_loop -1 -i input.mp4 -t 2 \
  -vf "fps=30,scale=1280:720:flags=lanczos,format=yuv420p" \
  -f yuv4mpegpipe benchmark-720p30.y4m
```

Run every agent with a local path to the same clip:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room direct_y4m_001 \
  --agent-id server-1 \
  --expected-members 2 \
  --mode direct \
  --video-y4m /opt/webrtc/benchmark-720p30.y4m \
  --output ./runs/direct_y4m_001/server-1
```

The fake camera replaces only the video source; outgoing WebRTC media is still encoded by the browser. This option applies to the Playwright agent. The manual browser page continues to use the canvas source.

## Configure Cloudflare

Create a dedicated Cloudflare Realtime TURN key for this benchmark environment. Set its identifier as the non-secret Worker variable `CF_TURN_KEY_ID` and set these Worker secrets interactively:

```bash
npx wrangler secret put CF_TURN_API_TOKEN
```

`CF_TURN_API_TOKEN` must be allowed to generate credentials for the configured TURN key. Do not put it in `wrangler.jsonc`, command-line arguments, or source control.

The Worker only mints one credential for an admitted WebSocket agent, bound to an unguessable connection nonce that is never placed in a URL. The singleton credential limiter defaults to 32 credentials per hour through `MAX_TURN_CREDENTIALS_PER_HOUR`; raise that Worker variable before large test batches.

For local direct-mode development, create an untracked `.dev.vars` file:

```text
CF_TURN_API_TOKEN=only-needed-for-local-relay-tests
```

Set `CF_TURN_KEY_ID` in the dashboard or replace its placeholder in `wrangler.jsonc` before deploying. Deploy the application:

```bash
npm run deploy
```

The credential endpoint calls Cloudflare's documented TURN credential API with a ten-minute TTL and a unique `room:agent:run` custom identifier.

### Cloudflare Access

Protect the Worker hostname with a hostname-based Cloudflare Access self-hosted application. The Access policy must allow the user who authorizes the agent, and it must cover the harness page, `/api/session`, `/api/turn-credentials`, and `/signal/*` on the same hostname. The Worker relies on Access for admission control; it has no application-level shared token.

Cloudflare documents that Worker-level Access policies reject WebSocket upgrades. If the manual test page on this hostname can join successfully, its existing hostname-based Access configuration is already suitable and does not need to change.

Add `--access-login` to the agent command:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room access_20260814_001 \
  --agent-id server-1 \
  --expected-members 2 \
  --mode relay \
  --access-login \
  --output ./runs/access_20260814_001/server-1
```

The agent uses Cloudflare Access's browser authorization and encrypted token-transfer protocol directly. It prints a unique URL and polls for up to ten minutes while a user completes SSO in a browser. The returned application token exists only in memory. The agent sends it both as `cf-access-token` and as the secure, HttpOnly `CF_Authorization` cookie, matching the manual browser session on HTTP requests and WebSocket upgrades. It is not written to artifacts or logs. No `cloudflared` binary is required.

Use this user-delegated flow for attended benchmark runs.

## Run A TURN Test

Start one command per host with the same room, mode, and expected-member count. The first agent waits until all peers are media-ready before the Durable Object starts the five-minute timer.

Host 1:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room relay_20260814_001 \
  --agent-id server-1 \
  --expected-members 2 \
  --mode relay \
  --output ./runs/relay_20260814_001/server-1
```

Host 2:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room relay_20260814_001 \
  --agent-id server-2 \
  --expected-members 2 \
  --mode relay \
  --output ./runs/relay_20260814_001/server-2
```

Relay mode requests Cloudflare TURN credentials and uses `iceTransportPolicy: "relay"`. A run fails unless the selected candidate pair exchanged bytes and both candidate stats are `relay`.

## Manual Browser Test

After deploying, open the Worker root URL in a normal desktop browser:

```text
https://webrtc-turn-benchmark.<account>.workers.dev/
```

The page presents a manual test form. The signaling URL is prefilled from the current page, so leave it unchanged unless intentionally testing a different deployment. On two browser profiles or devices, enter:

- The same room ID, expected-member count, and mode.
- A distinct agent ID for each participant, such as `browser-1` and `browser-2`.
- `Force Cloudflare TURN relay` for a relay smoke test, or `Direct connection, no TURN` for a direct smoke test.
- `Synthetic canvas test pattern` to avoid camera access, or `This browser's webcam` to publish the selected camera after granting the browser permission prompt.

Click **Join five-minute test** in each browser. Remote videos become visible when tracks arrive; the page runs for five minutes and closes its room connection when the room timer completes. Cloudflare Access authenticates the page, API requests, and WebSocket upgrade.

Manual mode is intended for connectivity and visual checks. It does not write local artifact files; use the Playwright agent for `raw-stats.ndjson`, CSV timelines, and validated summaries. In Chrome, open `chrome://webrtc-internals` in another tab before joining to inspect the manual session.

If the page fails before joining, verify that the Access policy admits the browser or agent, then validate the signaling preflight:

```bash
curl -X POST https://webrtc-turn-benchmark.<account>.workers.dev/api/session \
  --fail-with-body
```

The expected response is `{"ok":true}`. A `401` or `403` means Cloudflare Access did not admit the request. If the preflight succeeds but the WebSocket still fails, inspect `npx wrangler tail`, the Access application logs, and Cloudflare WAF events for the Worker hostname.

## Run A Direct Baseline

Use two separate hosts and start one agent on each host with the same new room name. The agents wait for all expected members, so start the second command while the first is waiting. Direct mode configures STUN only and uses `iceTransportPolicy: "all"`; it never requests or uses TURN credentials.

Host 1:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room direct_20260814_001 \
  --agent-id server-1 \
  --expected-members 2 \
  --mode direct \
  --output ./runs/direct_20260814_001/server-1
```

Host 2:

```bash
npm run agent -- \
  --signal-url https://webrtc-turn-benchmark.example.workers.dev \
  --room direct_20260814_001 \
  --agent-id server-2 \
  --expected-members 2 \
  --mode direct \
  --output ./runs/direct_20260814_001/server-2
```

The only values that differ are `--agent-id` and `--output`. Each peer sends one 720p, 30 fps video stream so the test can establish a stable local encoder baseline. A direct run fails if either selected candidate is a relay candidate. A direct connection may legitimately fail for restrictive NATs; report it as unavailable rather than treating it as a TURN performance result.

## Three-Peer Mesh

Run the same command on three hosts with `--expected-members 3` and unique agent IDs. Each agent creates one peer connection to each other member, so bandwidth, CPU, and encoder load grow with the mesh. Use a separate room for every attempt.

## Artifacts

Every agent writes only locally:

- `metadata.json`: non-secret run and Chromium metadata.
- `raw-stats.ndjson`: every stats object returned by each `RTCPeerConnection.getStats()` call, plus run events.
- `timeline.csv`: derived RTP bitrate, packet loss, jitter, jitter-buffer delay, resolution, quality limitation, frame, and retransmission metrics.
- `connections.csv`: selected candidate types, selected-pair RTT, optional browser-reported available bitrate, and transport bytes. Chromium may omit `availableIncomingBitrate`; this is a browser capability limitation, not a missing sample.
- `playback.csv`: `HTMLVideoElement.getVideoPlaybackQuality()` frame counts and decoded display resolution. In the headless agent, the receiver is an off-screen 1px element, so its dropped-frame counter can rise even while WebRTC `framesDecoded` is healthy. Treat decoder metrics as the media-health signal; retain playback counters for diagnostics.
- `summary.json`: average bitrate per stream, receiver resolution sequence, source/encoder/decoder FPS, selected path verification, and final validity.

`raw-stats.ndjson` also retains browser-specific metrics such as audio concealment, `media-playout`, quality-limitation duration, codec, transport, and remote RTP reports when Chromium exposes them.

`jitterBufferDelay` and `jitterBufferTargetDelay` in raw WebRTC stats are cumulative seconds, so they grow throughout a healthy call. `timeline.csv` converts their counter deltas to `jitter_buffer_delay_ms` and `jitter_buffer_target_delay_ms` per emitted frame; use those derived values when comparing runs.

## View A Run

Generate a standalone visual report from an agent output directory:

```bash
npm run report -- --input ./runs/direct_20260814_001/server-1
```

This writes `report.html` beside the artifacts. Open it in a browser to inspect validation results, separate inbound and outbound bitrate/FPS/resolution charts, selected-pair transport throughput, optional browser-reported capacity, RTT, jitter-buffer delay, and playback quality. Hover a chart to inspect elapsed time and values; scroll to zoom, drag to pan, and double-click to reset. The report embeds all rows from `timeline.csv`, `connections.csv`, and `playback.csv`, with searchable tables for each dataset.

Use `--output` to write the report elsewhere:

```bash
npm run report -- \
  --input ./runs/direct_20260814_001/server-1 \
  --output ./reports/direct-server-1.html
```

## Interpretation

Each peer sends one `1280x720` video encoding capped at 30 fps and 4 Mbps. Its canvas uses manual capture (`captureStream(0)` plus `requestFrame()`) and an absolute 30 fps schedule; delayed source slots are counted rather than emitted in a burst. The sender uses `maintain-framerate` and reduces its encoding to `640x360`, then `320x180`, when its available bitrate, packet loss, or bandwidth quality limitation indicates congestion. It returns to a higher resolution only after sustained recovery.

The benchmark fails when source, local encoder, or receiver decoder averages below 29 fps, or falls below 28.5 fps in a 10-second window after warm-up. Receiver-side decoded resolution transitions are reported in `summary.json` under `videoPacing.receivers[].resolutions` and are sampled in `playback.csv`.

A mesh has no SFU. Do not interpret a resolution change alone as congestion control. For an adaptation finding, correlate encoded bitrate, selected-pair `availableOutgoingBitrate`, receiver-side decoded dimensions, loss/RTT, and `qualityLimitationReason: "bandwidth"`. Label CPU-limited runs separately.

Repeat direct and relay runs from the same endpoint hosts, browser revision, media source, peer count, and network conditions. Compare distributions across repetitions, not a single five-minute result.

## Development And Validation

```bash
npm run check
npm test
npm run build
npx wrangler check startup
```

Start a local Worker with `npm run dev`. Local relay tests still require a valid Cloudflare TURN key and API token; direct-mode smoke tests do not.
