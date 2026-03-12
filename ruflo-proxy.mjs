#!/usr/bin/env node

/**
 * ruflo-proxy.mjs
 *
 * Transparent MCP proxy between Claude Desktop and ruflo.
 * - Passes all MCP JSON-RPC through untouched (Claude doesn't know it's there)
 * - Intercepts tools/call requests + responses and logs them
 * - Serves a live HTML dashboard on port 3142
 *
 * Usage: node ruflo-proxy.mjs
 *   (replaces `npx ruflo@latest mcp start` in your startup chain)
 */

import { spawn } from "child_process";
import { createServer } from "http";
import { createInterface } from "readline";

// ── State ──────────────────────────────────────────────
const toolCalls = [];      // Completed calls with timing
const pendingCalls = {};   // In-flight: id → { request, startTime }
let totalTokensEstimate = 0;
const startedAt = new Date().toISOString();

// ── Spawn ruflo MCP server as child ────────────────────
const ruflo = spawn("npx", ["-y", "ruflo@latest", "mcp", "start"], {
  stdio: ["pipe", "pipe", "inherit"],  // inherit stderr so ruflo errors show in logs
  env: { ...process.env },
});

// ── Pipe stdin → ruflo (intercept tools/call requests) ─
const stdinRL = createInterface({ input: process.stdin, crlfDelay: Infinity });
stdinRL.on("line", (line) => {
  // Forward to ruflo
  ruflo.stdin.write(line + "\n");

  // Intercept
  try {
    const msg = JSON.parse(line);
    if (msg.method === "tools/call" && msg.id !== undefined) {
      pendingCalls[msg.id] = {
        request: msg,
        toolName: msg.params?.name || "unknown",
        args: msg.params?.arguments || {},
        startTime: Date.now(),
      };
    }
  } catch {}
});

// ── Pipe ruflo stdout → stdout (intercept responses) ───
const rufloRL = createInterface({ input: ruflo.stdout, crlfDelay: Infinity });
rufloRL.on("line", (line) => {
  // Forward to Claude Desktop
  process.stdout.write(line + "\n");

  // Intercept
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pendingCalls[msg.id]) {
      const pending = pendingCalls[msg.id];
      const duration = Date.now() - pending.startTime;

      // Extract result text
      let resultText = "";
      let success = true;
      if (msg.error) {
        resultText = msg.error.message || JSON.stringify(msg.error);
        success = false;
      } else if (msg.result?.content?.[0]?.text) {
        resultText = msg.result.content[0].text;
      }

      toolCalls.unshift({
        id: msg.id,
        tool: pending.toolName,
        args: pending.args,
        result: resultText,
        success,
        duration,
        timestamp: new Date().toISOString(),
      });

      // Keep last 200 calls
      if (toolCalls.length > 200) toolCalls.pop();

      delete pendingCalls[msg.id];
    }
  } catch {}
});

// ── Handle process lifecycle ───────────────────────────
ruflo.on("exit", (code) => {
  process.exit(code || 0);
});
process.on("SIGTERM", () => { ruflo.kill(); process.exit(0); });
process.on("SIGINT",  () => { ruflo.kill(); process.exit(0); });

// ── Dashboard HTTP server on port 3142 ─────────────────
const PORT = 3142;

const server = createServer((req, res) => {
  if (req.url === "/api/calls") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ calls: toolCalls, pending: Object.keys(pendingCalls).length, startedAt }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DASHBOARD_HTML);
});

server.listen(PORT, "127.0.0.1", () => {
  // Use stderr so it doesn't corrupt MCP stdio
  console.error(`\n  📊 ruflo Dashboard: http://localhost:${PORT}\n`);
});

// ── Dashboard HTML ─────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ruflo Agent Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0d1117; color:#c9d1d9; }
  .header { background:#161b22; border-bottom:1px solid #30363d; padding:16px 24px; display:flex; align-items:center; justify-content:space-between; }
  .header h1 { font-size:18px; color:#58a6ff; }
  .header .stats { display:flex; gap:20px; font-size:13px; color:#8b949e; }
  .stat-val { color:#f0f6fc; font-weight:600; font-size:15px; }
  .container { max-width:1200px; margin:0 auto; padding:16px; }
  .call { background:#161b22; border:1px solid #30363d; border-radius:8px; margin-bottom:8px; overflow:hidden; }
  .call-header { padding:12px 16px; display:flex; align-items:center; gap:12px; cursor:pointer; }
  .call-header:hover { background:#1c2128; }
  .badge { padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600; }
  .badge-ok { background:#1a3a2a; color:#3fb950; }
  .badge-err { background:#3d1f1f; color:#f85149; }
  .badge-pending { background:#2d2a1a; color:#d29922; }
  .tool-name { font-weight:600; color:#f0f6fc; font-size:14px; font-family:ui-monospace,monospace; }
  .duration { color:#8b949e; font-size:12px; margin-left:auto; }
  .timestamp { color:#484f58; font-size:11px; }
  .call-body { display:none; padding:0 16px 12px; border-top:1px solid #21262d; }
  .call-body.open { display:block; padding-top:12px; }
  .section-label { font-size:11px; color:#8b949e; text-transform:uppercase; letter-spacing:0.5px; margin:8px 0 4px; }
  pre { background:#0d1117; border:1px solid #21262d; border-radius:6px; padding:10px; font-size:12px; overflow-x:auto; color:#c9d1d9; white-space:pre-wrap; word-break:break-word; max-height:300px; overflow-y:auto; }
  .empty { text-align:center; padding:60px 20px; color:#484f58; }
  .live-dot { width:8px; height:8px; background:#3fb950; border-radius:50%; display:inline-block; animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
</style>
</head>
<body>
<div class="header">
  <h1>🌊 ruflo Agent Dashboard</h1>
  <div class="stats">
    <div><span class="live-dot"></span> Live</div>
    <div>Calls: <span class="stat-val" id="total">0</span></div>
    <div>Errors: <span class="stat-val" id="errors" style="color:#f85149">0</span></div>
    <div>Pending: <span class="stat-val" id="pending" style="color:#d29922">0</span></div>
  </div>
</div>
<div class="container" id="calls">
  <div class="empty">Waiting for ruflo tool calls from Claude Desktop...</div>
</div>

<script>
let lastCount = 0;

async function refresh() {
  try {
    const r = await fetch("/api/calls");
    const data = await r.json();

    document.getElementById("total").textContent = data.calls.length;
    document.getElementById("errors").textContent = data.calls.filter(c => !c.success).length;
    document.getElementById("pending").textContent = data.pending;

    if (data.calls.length === 0) return;
    if (data.calls.length === lastCount) return;
    lastCount = data.calls.length;

    const container = document.getElementById("calls");
    container.innerHTML = data.calls.map((c, i) => \`
      <div class="call">
        <div class="call-header" onclick="this.nextElementSibling.classList.toggle('open')">
          <span class="badge \${c.success ? 'badge-ok' : 'badge-err'}">\${c.success ? 'OK' : 'ERR'}</span>
          <span class="tool-name">\${esc(c.tool)}</span>
          <span class="duration">\${c.duration}ms</span>
          <span class="timestamp">\${new Date(c.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="call-body">
          <div class="section-label">Arguments</div>
          <pre>\${esc(JSON.stringify(c.args, null, 2))}</pre>
          <div class="section-label">Result</div>
          <pre>\${esc(tryPretty(c.result))}</pre>
        </div>
      </div>
    \`).join("");
  } catch {}
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML;
}

function tryPretty(s) {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

setInterval(refresh, 1000);
refresh();
</script>
</body>
</html>`;
