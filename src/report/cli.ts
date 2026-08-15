import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type CsvRow = Record<string, string>;

type ReportData = {
  csv: {
    connections: CsvRow[];
    playback: CsvRow[];
    timeline: CsvRow[];
  };
  generatedAt: string;
  metadata: unknown;
  rawStatsBytes: number | null;
  runDirectory: string;
  summary: unknown;
};

type Options = {
  inputDirectory: string;
  outputFile: string;
};

function usage(): string {
  return [
    "Usage: npm run report -- --input <run-directory> [--output <report.html>]",
    "",
    "Creates a standalone HTML report with charts and full CSV tables.",
  ].join("\n");
}

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }
    const [name, inlineValue] = argument.slice(2).split("=", 2);
    const value = inlineValue ?? argv[index + 1];
    if (name === undefined || name.length === 0 || value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (name !== "input" && name !== "output") {
      throw new Error(`Unknown option --${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate option --${name}`);
    }
    values.set(name, value);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  const input = values.get("input");
  if (input === undefined || input.length === 0) {
    throw new Error("--input is required");
  }
  const inputDirectory = resolve(input);
  return {
    inputDirectory,
    outputFile: resolve(values.get("output") ?? join(inputDirectory, "report.html")),
  };
}

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }
    cell += character;
  }
  row.push(cell);
  if (row.some((value) => value.length > 0)) {
    rows.push(row);
  }
  const headers = rows.shift();
  if (headers === undefined) {
    return [];
  }
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
}

async function readCsv(path: string): Promise<CsvRow[]> {
  return parseCsv(await fs.readFile(path, "utf8"));
}

async function optionalRawStatsSize(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function page(data: ReportData): string {
  const embeddedData = safeJson(data);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WebRTC benchmark report</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0a0d14; color: #e8edf7; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { margin: 0 auto; max-width: 1500px; padding: 32px 24px 64px; }
      h1, h2, h3, p { margin-top: 0; }
      h1 { font-size: clamp(1.8rem, 4vw, 3rem); letter-spacing: -0.04em; margin-bottom: 8px; }
      h2 { font-size: 1.2rem; margin-bottom: 14px; }
      .muted { color: #9aa7bd; }
      .status { border-radius: 999px; display: inline-block; font-size: 0.82rem; font-weight: 700; padding: 5px 10px; text-transform: uppercase; }
      .status.good { background: #0d422f; color: #78e0ad; }
      .status.bad { background: #4a1c2a; color: #ffa2b9; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin: 24px 0; }
      .card, .panel { background: #121827; border: 1px solid #26324a; border-radius: 12px; padding: 18px; }
      .card .label { color: #9aa7bd; font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; }
      .card .value { font-size: 1.65rem; font-weight: 700; margin-top: 6px; overflow-wrap: anywhere; }
      .charts { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(410px, 1fr)); }
      .metric-group { grid-column: 1 / -1; }
      .metric-group + .metric-group { border-top: 1px solid #26324a; padding-top: 26px; }
      .metric-group h2 { margin-bottom: 4px; }
      .chart { min-width: 0; position: relative; }
      .chart h3 { font-size: 0.95rem; margin-bottom: 4px; }
      .chart .axis { color: #9aa7bd; font-size: 0.75rem; }
      svg { background: #0c111d; border-radius: 8px; display: block; height: auto; margin-top: 12px; touch-action: none; width: 100%; }
      .chart-tooltip { background: #101827; border: 1px solid #4d6488; border-radius: 6px; box-shadow: 0 10px 28px #0008; display: none; font-size: 0.75rem; max-width: 230px; padding: 8px 10px; pointer-events: none; position: absolute; z-index: 1; }
      .chart-tooltip strong { display: block; margin-bottom: 5px; }
      .chart-tooltip div { align-items: center; display: flex; gap: 6px; justify-content: space-between; }
      .chart-tooltip i { border-radius: 50%; display: inline-block; flex: 0 0 auto; height: 8px; width: 8px; }
      .legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 10px; }
      .legend span { color: #b8c4d9; font-size: 0.75rem; }
      .legend i { border-radius: 50%; display: inline-block; height: 8px; margin-right: 5px; width: 8px; }
      select, input { background: #0c111d; border: 1px solid #34445f; border-radius: 7px; color: inherit; font: inherit; padding: 8px 10px; }
      .controls { align-items: center; display: flex; gap: 10px; margin: 22px 0 14px; }
      .errors { color: #ffa2b9; margin: 0; padding-left: 20px; }
      .empty { color: #9aa7bd; padding: 42px 12px; text-align: center; }
      details { margin-top: 16px; }
      summary { cursor: pointer; font-weight: 700; }
      .table-tools { margin: 14px 0; }
      .table-wrap { max-height: 620px; overflow: auto; }
      table { border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.76rem; min-width: 100%; }
      th { background: #19233a; position: sticky; top: 0; }
      th, td { border-bottom: 1px solid #26324a; padding: 8px 10px; text-align: left; white-space: nowrap; }
      td { color: #c6d1e4; }
      pre { background: #0c111d; border-radius: 8px; max-height: 460px; overflow: auto; padding: 14px; white-space: pre-wrap; }
      a { color: #83c5ff; }
      @media (max-width: 600px) { main { padding: 22px 14px 44px; } .charts { grid-template-columns: 1fr; } .controls { align-items: flex-start; flex-direction: column; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>WebRTC Benchmark Report</h1>
        <p class="muted" id="subtitle"></p>
      </header>
      <section class="grid" id="summary-cards"></section>
      <section class="panel" id="validation"></section>
      <div class="controls">
        <label for="peer">Peer</label>
        <select id="peer"></select>
        <span class="muted">Hover for values. Scroll to zoom, drag to pan, double-click to reset.</span>
      </div>
      <section class="charts" id="charts"></section>
      <section class="panel">
        <h2>Full Data</h2>
        <p class="muted">All derived CSV rows are embedded in this report. The raw browser stats file remains available beside this HTML report.</p>
        <div id="tables"></div>
      </section>
      <details class="panel">
        <summary>Summary JSON</summary>
        <pre id="summary-json"></pre>
      </details>
    </main>
    <script>
      const REPORT_DATA = ${embeddedData};
      const COLORS = ["#67e8f9", "#a78bfa", "#fbbf24", "#fb7185", "#4ade80", "#f97316", "#60a5fa"];
      const number = (value) => { if (value === undefined || value === null || String(value).trim() === "") return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; };
      const text = (value) => value === undefined || value === null ? "" : String(value);
      const byPeer = (rows, peer) => rows.filter((row) => text(row.peer_id) === peer);
      const element = (name, className) => { const value = document.createElement(name); if (className) value.className = className; return value; };
      const card = (label, value) => { const box = element("article", "card"); const heading = element("div", "label"); heading.textContent = label; const detail = element("div", "value"); detail.textContent = value; box.append(heading, detail); return box; };
      const allRows = [...REPORT_DATA.csv.timeline, ...REPORT_DATA.csv.connections, ...REPORT_DATA.csv.playback];
      const timestamps = allRows.map((row) => number(row.timestamp_ms)).filter((timestamp) => timestamp !== null);
      const runStartMs = timestamps.length === 0 ? 0 : Math.min(...timestamps);
      const elapsedSeconds = (timestamp) => (timestamp - runStartMs) / 1000;
      const elapsedLabel = (seconds) => {
        const milliseconds = Math.max(0, Math.round(seconds * 1000));
        const hours = Math.floor(milliseconds / 3_600_000);
        const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
        const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
        const millis = milliseconds % 1_000;
        const prefix = hours > 0 ? String(hours).padStart(2, "0") + ":" : "";
        return prefix + String(minutes).padStart(2, "0") + ":" + String(wholeSeconds).padStart(2, "0") + "." + String(millis).padStart(3, "0");
      };
      const valueLabel = (value) => {
        const magnitude = Math.abs(value);
        const digits = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
        return value.toLocaleString(undefined, { maximumFractionDigits: digits });
      };
      const svgElement = (name) => document.createElementNS("http://www.w3.org/2000/svg", name);
       const series = (rows, column, labelFor, transform) => {
         const groups = new Map();
        for (const row of rows) {
          const timestamp = number(row.timestamp_ms); const raw = number(row[column]);
          if (timestamp === null || raw === null) continue;
          const label = labelFor(row);
          if (!groups.has(label)) groups.set(label, []);
          groups.get(label).push({ timestamp, x: elapsedSeconds(timestamp), y: transform(raw) });
         }
         return [...groups.entries()].map(([label, points], index) => ({ color: COLORS[index % COLORS.length], label, points: points.sort((left, right) => left.x - right.x) }));
       };
       const counterRateSeries = (rows, column, label, transform) => {
         const points = rows
           .map((row) => ({ timestamp: number(row.timestamp_ms), value: number(row[column]) }))
           .filter((point) => point.timestamp !== null && point.value !== null)
           .sort((left, right) => left.timestamp - right.timestamp);
         const rates = [];
         for (let index = 1; index < points.length; index += 1) {
           const previous = points[index - 1]; const current = points[index];
           const elapsedMs = current.timestamp - previous.timestamp;
           const bytes = current.value - previous.value;
           if (elapsedMs <= 0 || bytes < 0) continue;
           rates.push({ timestamp: current.timestamp, x: elapsedSeconds(current.timestamp), y: transform((bytes * 8_000) / elapsedMs) });
         }
         return rates.length === 0 ? [] : [{ color: COLORS[0], label, points: rates }];
       };
       const hasSamples = (rows, column) => rows.some((row) => number(row[column]) !== null);
      const chart = (title, unit, lines) => {
        lines = lines.map((line, index) => ({ ...line, color: COLORS[index % COLORS.length] }));
        const box = element("article", "panel chart"); const heading = element("h3"); heading.textContent = title; box.append(heading);
        const points = lines.flatMap((line) => line.points);
        if (points.length === 0) { const empty = element("div", "empty"); empty.textContent = "No samples available"; box.append(empty); return box; }
        const xMin = Math.min(...points.map((point) => point.x)); const xMax = Math.max(...points.map((point) => point.x));
        const yMin = Math.min(0, ...points.map((point) => point.y)); const yMax = Math.max(1, ...points.map((point) => point.y));
        const width = 900; const height = 260; const left = 54; const right = 18; const top = 18; const bottom = 32;
        const plotWidth = width - left - right; const plotHeight = height - top - bottom;
        const baseMin = xMin; const baseMax = Math.max(xMin + 1, xMax); const baseSpan = baseMax - baseMin;
        const minimumSpan = Math.min(baseSpan, Math.max(0.25, baseSpan / 200));
        let domainMin = baseMin; let domainMax = baseMax; let drag;
        const scaleY = (value) => height - bottom - ((value - yMin) / Math.max(1, yMax - yMin)) * plotHeight;
        const clampDomain = (minimum, maximum) => {
          const span = Math.min(baseSpan, Math.max(minimumSpan, maximum - minimum));
          let lower = minimum; let upper = lower + span;
          if (lower < baseMin) { lower = baseMin; upper = lower + span; }
          if (upper > baseMax) { upper = baseMax; lower = upper - span; }
          return [lower, upper];
        };
        const scaleX = (value) => left + ((value - domainMin) / Math.max(minimumSpan, domainMax - domainMin)) * plotWidth;
        const svg = svgElement("svg"); svg.setAttribute("aria-label", title + " interactive chart"); svg.setAttribute("role", "img"); svg.setAttribute("tabindex", "0"); svg.setAttribute("viewBox", "0 0 " + width + " " + height);
        const tooltip = element("div", "chart-tooltip"); let crosshair; let markers = [];
        const nearest = (candidates, x) => candidates.reduce((closest, point) => Math.abs(point.x - x) < Math.abs(closest.x - x) ? point : closest);
        const render = () => {
          svg.replaceChildren();
          for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            const y = top + fraction * plotHeight; const grid = svgElement("line"); grid.setAttribute("x1", String(left)); grid.setAttribute("x2", String(width - right)); grid.setAttribute("y1", String(y)); grid.setAttribute("y2", String(y)); grid.setAttribute("stroke", "#26324a"); grid.setAttribute("stroke-width", "1"); svg.append(grid);
            const label = svgElement("text"); label.setAttribute("x", String(left - 7)); label.setAttribute("y", String(y + 4)); label.setAttribute("fill", "#9aa7bd"); label.setAttribute("font-size", "11"); label.setAttribute("text-anchor", "end"); label.textContent = valueLabel(yMax - fraction * (yMax - yMin)); svg.append(label);
          }
          for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
            const x = left + fraction * plotWidth; const grid = svgElement("line"); grid.setAttribute("x1", String(x)); grid.setAttribute("x2", String(x)); grid.setAttribute("y1", String(top)); grid.setAttribute("y2", String(height - bottom)); grid.setAttribute("stroke", "#26324a"); grid.setAttribute("stroke-width", "1"); svg.append(grid);
            const label = svgElement("text"); label.setAttribute("x", String(x)); label.setAttribute("y", String(height - 9)); label.setAttribute("fill", "#9aa7bd"); label.setAttribute("font-size", "11"); label.setAttribute("text-anchor", fraction === 0 ? "start" : fraction === 1 ? "end" : "middle"); label.textContent = elapsedLabel(domainMin + fraction * (domainMax - domainMin)); svg.append(label);
          }
          for (const item of lines) { const path = svgElement("path"); path.setAttribute("d", item.points.map((point, index) => (index === 0 ? "M" : "L") + scaleX(point.x).toFixed(2) + " " + scaleY(point.y).toFixed(2)).join(" ")); path.setAttribute("fill", "none"); path.setAttribute("stroke", item.color); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("stroke-linecap", "round"); path.setAttribute("stroke-width", "2"); svg.append(path); }
          crosshair = svgElement("line"); crosshair.setAttribute("stroke", "#dbeafe"); crosshair.setAttribute("stroke-dasharray", "3 3"); crosshair.setAttribute("stroke-width", "1"); crosshair.style.display = "none"; svg.append(crosshair);
          markers = lines.map((item) => { const marker = svgElement("circle"); marker.setAttribute("fill", "#0c111d"); marker.setAttribute("r", "4"); marker.setAttribute("stroke", item.color); marker.setAttribute("stroke-width", "2"); marker.style.display = "none"; svg.append(marker); return marker; });
          const overlay = svgElement("rect"); overlay.setAttribute("fill", "transparent"); overlay.setAttribute("height", String(plotHeight)); overlay.setAttribute("width", String(plotWidth)); overlay.setAttribute("x", String(left)); overlay.setAttribute("y", String(top)); overlay.style.cursor = "crosshair"; svg.append(overlay);
        };
        const eventPoint = (event) => {
          const bounds = svg.getBoundingClientRect(); const renderedPlotWidth = bounds.width * plotWidth / width;
          const clientX = Math.max(bounds.left + bounds.width * left / width, Math.min(bounds.right - bounds.width * right / width, event.clientX));
          const fraction = (clientX - (bounds.left + bounds.width * left / width)) / renderedPlotWidth;
          return { clientX, x: domainMin + fraction * (domainMax - domainMin) };
        };
        const showTooltip = (event) => {
          const target = nearest(points, eventPoint(event).x); const selected = lines.map((line) => ({ line, point: nearest(line.points, target.x) }));
          const x = scaleX(target.x); crosshair.setAttribute("x1", String(x)); crosshair.setAttribute("x2", String(x)); crosshair.setAttribute("y1", String(top)); crosshair.setAttribute("y2", String(height - bottom)); crosshair.style.display = "";
          markers.forEach((marker, index) => { const point = selected[index].point; marker.setAttribute("cx", String(scaleX(point.x))); marker.setAttribute("cy", String(scaleY(point.y))); marker.style.display = ""; });
          const time = element("strong"); time.textContent = "Elapsed " + elapsedLabel(target.x);
          const rows = selected.map(({ line, point }) => { const row = element("div"); const name = element("span"); const dot = element("i"); dot.style.background = line.color; name.append(dot, document.createTextNode(line.label)); const value = element("span"); value.textContent = valueLabel(point.y) + " " + unit; row.append(name, value); return row; }); tooltip.replaceChildren(time, ...rows);
          const chartBounds = box.getBoundingClientRect(); tooltip.style.display = "block"; tooltip.style.left = Math.max(8, Math.min(chartBounds.width - tooltip.offsetWidth - 8, event.clientX - chartBounds.left + 12)) + "px"; tooltip.style.top = "50px";
        };
        render();
        svg.addEventListener("pointerdown", (event) => { drag = { clientX: event.clientX, domainMin, domainMax }; svg.setPointerCapture(event.pointerId); showTooltip(event); });
        svg.addEventListener("pointermove", (event) => {
          if (drag !== undefined) {
            const bounds = svg.getBoundingClientRect(); const span = drag.domainMax - drag.domainMin; const shift = (event.clientX - drag.clientX) * span / (bounds.width * plotWidth / width);
            [domainMin, domainMax] = clampDomain(drag.domainMin - shift, drag.domainMax - shift); render();
          }
          showTooltip(event);
        });
        svg.addEventListener("pointerup", () => { drag = undefined; });
        svg.addEventListener("pointercancel", () => { drag = undefined; });
        svg.addEventListener("pointerleave", () => { if (drag === undefined) { tooltip.style.display = "none"; crosshair.style.display = "none"; markers.forEach((marker) => { marker.style.display = "none"; }); } });
        svg.addEventListener("wheel", (event) => { event.preventDefault(); const focus = eventPoint(event).x; const span = domainMax - domainMin; const nextSpan = Math.min(baseSpan, Math.max(minimumSpan, span * (event.deltaY < 0 ? 0.8 : 1.25))); const focusPosition = (focus - domainMin) / span; [domainMin, domainMax] = clampDomain(focus - nextSpan * focusPosition, focus + nextSpan * (1 - focusPosition)); render(); showTooltip(event); }, { passive: false });
        svg.addEventListener("dblclick", (event) => { event.preventDefault(); domainMin = baseMin; domainMax = baseMax; render(); showTooltip(event); });
        const legend = element("div", "legend"); for (const item of lines) { const label = element("span"); const dot = element("i"); dot.style.background = item.color; label.append(dot, document.createTextNode(item.label)); legend.append(label); }
        box.append(svg, tooltip, legend); return box;
      };
      const chartGroup = (title, description, charts) => { const group = element("section", "metric-group"); const heading = element("h2"); heading.textContent = title; const detail = element("p", "muted"); detail.textContent = description; const grid = element("div", "charts"); grid.append(...charts); group.append(heading, detail, grid); return group; };
      const table = (title, rows) => {
        const details = element("details"); const summary = element("summary"); summary.textContent = title + " (" + rows.length.toLocaleString() + " rows)"; details.append(summary);
        if (rows.length === 0) { const empty = element("div", "empty"); empty.textContent = "No data file found"; details.append(empty); return details; }
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]; const tools = element("div", "table-tools"); const filter = element("input"); filter.type = "search"; filter.placeholder = "Filter all columns"; tools.append(filter);
        const wrap = element("div", "table-wrap"); const grid = element("table"); const head = element("thead"); const headRow = element("tr"); for (const column of columns) { const cell = element("th"); cell.textContent = column; headRow.append(cell); } head.append(headRow); const body = element("tbody"); grid.append(head, body); wrap.append(grid); const render = () => { const needle = filter.value.toLowerCase(); body.replaceChildren(); for (const row of rows) { if (needle && !columns.some((column) => text(row[column]).toLowerCase().includes(needle))) continue; const line = element("tr"); for (const column of columns) { const cell = element("td"); cell.textContent = text(row[column]); line.append(cell); } body.append(line); } }; filter.addEventListener("input", render); render(); details.append(tools, wrap); return details;
      };
      const renderCharts = (peer) => {
        const area = document.querySelector("#charts"); area.replaceChildren(); const timeline = byPeer(REPORT_DATA.csv.timeline, peer); const connections = byPeer(REPORT_DATA.csv.connections, peer); const playback = byPeer(REPORT_DATA.csv.playback, peer);
        const inbound = timeline.filter((row) => text(row.direction) === "inbound");
        const outbound = timeline.filter((row) => text(row.direction) === "outbound");
        const remoteInbound = timeline.filter((row) => text(row.direction) === "remote-inbound");
        const mediaLabel = (row) => text(row.kind) + (text(row.rid) ? " rid=" + text(row.rid) : "");
        area.append(
          chartGroup("Inbound Media", "Receiver-side WebRTC metrics and the local playback element.", [
            chart("Received media bitrate", "kbps", series(inbound, "bitrate_bps", mediaLabel, (value) => value / 1000)),
            chart("Decoder rate", "fps", series(inbound.filter((row) => text(row.kind) === "video"), "frames_per_second", mediaLabel, (value) => value)),
            chart("Receiver resolution", "pixels", series(inbound.filter((row) => text(row.kind) === "video"), "height", mediaLabel, (value) => value)),
            chart("Network jitter", "ms", series(inbound, "jitter_ms", mediaLabel, (value) => value)),
            chart("Jitter buffer", "ms", [
              ...series(inbound, "jitter_buffer_delay_ms", () => "actual delay", (value) => value),
              ...series(inbound, "jitter_buffer_target_delay_ms", () => "target delay", (value) => value),
            ]),
            chart("Playback element frames", "frames", [
              ...series(playback, "total_video_frames", () => "total", (value) => value),
            ]),
          ]),
          chartGroup("Outbound Media", "Sender-side WebRTC metrics. Remote receiver loss is reported by the peer for this outbound stream.", [
            chart("Sent media bitrate", "kbps", series(outbound, "bitrate_bps", mediaLabel, (value) => value / 1000)),
            chart("Encoder rate", "fps", series(outbound.filter((row) => text(row.kind) === "video"), "frames_per_second", mediaLabel, (value) => value)),
            chart("Sender resolution", "pixels", series(outbound.filter((row) => text(row.kind) === "video"), "height", mediaLabel, (value) => value)),
            chart("Remote receiver packet loss", "%", series(remoteInbound, "packet_loss_fraction", () => "remote receiver", (value) => value * 100)),
          ]),
          chartGroup("Connection Path", "Selected ICE candidate-pair throughput, RTT, and optional browser capacity estimates.", [
            chart("Incoming transport throughput", "kbps", counterRateSeries(connections, "bytes_received", "received", (value) => value / 1000)),
            chart("Outgoing transport throughput", "kbps", counterRateSeries(connections, "bytes_sent", "sent", (value) => value / 1000)),
            ...(hasSamples(connections, "available_incoming_bitrate") ? [
              chart("Available incoming capacity", "kbps", series(connections, "available_incoming_bitrate", () => "available incoming", (value) => value / 1000)),
            ] : []),
            ...(hasSamples(connections, "available_outgoing_bitrate") ? [
              chart("Available outgoing capacity", "kbps", series(connections, "available_outgoing_bitrate", () => "available outgoing", (value) => value / 1000)),
            ] : []),
            chart("Round-trip time", "ms", series(connections, "current_rtt_ms", () => "RTT", (value) => value)),
          ]),
        );
      };
      const metadata = REPORT_DATA.metadata && typeof REPORT_DATA.metadata === "object" ? REPORT_DATA.metadata : {};
      const summary = REPORT_DATA.summary && typeof REPORT_DATA.summary === "object" ? REPORT_DATA.summary : {};
      const validation = summary.validation && typeof summary.validation === "object" ? summary.validation : { valid: false, errors: ["Missing summary validation"] };
      document.querySelector("#subtitle").textContent = text(metadata.room || REPORT_DATA.runDirectory) + " · " + text(metadata.mode || summary.mode || "unknown mode") + " · generated " + REPORT_DATA.generatedAt;
      const cards = document.querySelector("#summary-cards"); cards.append(
        card("Run status", text(summary.status || "unknown")),
        card("Peers", text(metadata.expectedMembers || "?")),
        card("Duration", text(metadata.durationSeconds || "?") + " s"),
        card("Samples", text(summary.sampleCount || "0")),
        card("Video source", text(metadata.videoSource || "canvas")),
        card("Source FPS", text(summary.videoPacing && summary.videoPacing.source && summary.videoPacing.source.averageFps || "n/a")),
        card("Raw stats", REPORT_DATA.rawStatsBytes === null ? "not found" : (REPORT_DATA.rawStatsBytes / 1024 / 1024).toFixed(1) + " MiB"),
      );
      const validationBox = document.querySelector("#validation"); const validationTitle = element("h2"); const badge = element("span", "status " + (validation.valid ? "good" : "bad")); badge.textContent = validation.valid ? "validated" : "failed"; validationTitle.append("Validation ", badge); validationBox.append(validationTitle);
      if (validation.valid) { const message = element("p"); message.textContent = "All run validation checks passed."; validationBox.append(message); } else { const errors = element("ul", "errors"); for (const error of validation.errors || []) { const item = element("li"); item.textContent = text(error); errors.append(item); } validationBox.append(errors); }
      const peers = [...new Set([...REPORT_DATA.csv.timeline, ...REPORT_DATA.csv.connections, ...REPORT_DATA.csv.playback].map((row) => text(row.peer_id)).filter(Boolean))].sort(); const peerSelect = document.querySelector("#peer"); for (const peer of peers) { const option = element("option"); option.value = peer; option.textContent = peer; peerSelect.append(option); } peerSelect.addEventListener("change", () => renderCharts(peerSelect.value)); if (peers.length > 0) renderCharts(peers[0]); else renderCharts("");
      const tables = document.querySelector("#tables"); tables.append(table("Timeline", REPORT_DATA.csv.timeline), table("Connections", REPORT_DATA.csv.connections), table("Playback", REPORT_DATA.csv.playback));
      document.querySelector("#summary-json").textContent = JSON.stringify(REPORT_DATA.summary, null, 2);
    </script>
  </body>
</html>`;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const [summary, metadata, timeline, connections, playback, rawStatsBytes] = await Promise.all([
    readJson(join(options.inputDirectory, "summary.json")),
    readJson(join(options.inputDirectory, "metadata.json")),
    readCsv(join(options.inputDirectory, "timeline.csv")),
    readCsv(join(options.inputDirectory, "connections.csv")),
    readCsv(join(options.inputDirectory, "playback.csv")),
    optionalRawStatsSize(join(options.inputDirectory, "raw-stats.ndjson")),
  ]);
  const data: ReportData = {
    csv: { connections, playback, timeline },
    generatedAt: new Date().toISOString(),
    metadata,
    rawStatsBytes,
    runDirectory: basename(options.inputDirectory),
    summary,
  };
  await fs.mkdir(dirname(options.outputFile), { recursive: true });
  await fs.writeFile(options.outputFile, page(data));
  console.log(JSON.stringify({ input: options.inputDirectory, output: options.outputFile, status: "created" }));
}

void main().catch((error: unknown) => {
  console.error(`Report generation failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(usage());
  process.exitCode = 1;
});
