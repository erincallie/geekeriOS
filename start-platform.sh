#!/bin/bash

# ── Force Node 20 ───────────────────────────────
export PATH="/Users/erin/.nvm/versions/node/v20.19.6/bin:$PATH"

# ── Working directory ────────────────────────────
cd /Users/erin/Desktop/geekeriOS

# ── Ruflo bootstrap (silent) ────────────────────
npx -y ruflo@latest init >/dev/null 2>&1 || true
npx -y ruflo@latest doctor --fix >/dev/null 2>&1 || true
npx -y ruflo@latest daemon start >/dev/null 2>&1 || true

# ── Launch the proxy (replaces direct mcp start) ─
# The proxy spawns ruflo mcp, passes stdio through,
# and serves the dashboard on http://localhost:3142
exec node ruflo-proxy.mjs