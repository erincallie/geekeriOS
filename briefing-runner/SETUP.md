# GeekeriOS Briefing Runner — Setup Guide

Automated morning briefings (7 AM MT) and daily wraps (4 PM MT) posted to `#geekerios-briefings` in Slack.

## Architecture

```
launchd (macOS scheduler)
  ├─ 7:00 AM MT, Mon–Fri → runner.ts morning
  └─ 4:00 PM MT, Mon–Fri → runner.ts evening
         │
         ▼
  Anthropic Beta API + MCP Connector
  (mcp-client-2025-11-20)
         │
    ┌────┴────┬──────────┬──────────┐
  HubSpot  GCal     Gmail      Slack
         │
         ▼
  #geekerios-briefings (C0AKUV5LL8P)
  (via MCP or webhook fallback)
```

**Day variants:** Monday AM = week preview • Friday PM = retro + metrics

---

## Quick Start

### 1. Add your API key to `.env`

```bash
cd ~/Desktop/geekeriOS/briefing-runner
# Copy your key from the VoltAgent project:
grep ANTHROPIC_API_KEY ../geekeri-volt/.env >> .env
# Or edit .env manually and paste your key
```

### 2. Install dependencies

```bash
export PATH=/Users/erin/.nvm/versions/node/v20.19.6/bin:$PATH
npm install
```

### 3. Test with a dry run (no MCP tokens needed)

The runner degrades gracefully — it skips any MCP server without a token
and falls back to generating a template-style briefing via the standard API,
then posts via the Slack webhook.

```bash
npx tsx src/runner.ts morning --dry-run
npx tsx src/runner.ts evening --dry-run
```

### 4. Configure MCP auth tokens (for live data)

Edit `.env` and add tokens for each service you want the briefing to pull from.
The runner logs which servers are configured vs. skipped on each run.

**HubSpot:**
1. Go to HubSpot → Settings → Integrations → Private Apps
2. Create a new app with scopes: `crm.objects.deals.read`, `crm.objects.contacts.read`
3. Copy the access token → paste as `HUBSPOT_TOKEN` in `.env`

**Slack MCP:**
1. Go to https://api.slack.com/apps → select your app (or create one)
2. Go to OAuth & Permissions → add scopes: `channels:read`, `channels:history`, `chat:write`, `users:read`, `search:read`
3. Install to workspace → copy the Bot User OAuth Token (xoxb-...) → paste as `SLACK_MCP_TOKEN` in `.env`

**Google Calendar + Gmail:**
The `gcal.mcp.claude.com` and `gmail.mcp.claude.com` servers are Anthropic-managed proxies.
They may not accept standalone API tokens. Try your Google OAuth access token as `GOOGLE_TOKEN`.
If they don't work, we have two options:
- Swap to direct Google Calendar/Gmail API calls in the runner
- Use a third-party MCP server that supports standard OAuth

### 5. Test with live data

```bash
npx tsx src/runner.ts morning --dry-run
# Should show real data from configured services
```

### 6. Test a real Slack post

```bash
npx tsx src/runner.ts morning
# Check #geekerios-briefings
```

### 7. Install the schedules

```bash
cp plists/com.geekerios.morning-briefing.plist ~/Library/LaunchAgents/
cp plists/com.geekerios.daily-wrap.plist ~/Library/LaunchAgents/

launchctl load ~/Library/LaunchAgents/com.geekerios.morning-briefing.plist
launchctl load ~/Library/LaunchAgents/com.geekerios.daily-wrap.plist

# Verify
launchctl list | grep geekerios
```

---

## How It Works

The runner calls the Anthropic Messages API using the **MCP connector beta**
(`mcp-client-2025-11-20`). This feature lets the API connect to remote MCP
servers on your behalf — the same servers you see as connectors in claude.ai.

The API call includes:
- `mcp_servers` array — defines each server's URL and auth token
- `tools` array — `mcp_toolset` entries that enable tools from each server

Claude then uses those tools to gather data (search HubSpot deals, read your
calendar, check Gmail, scan Slack), synthesizes a conversational briefing,
and posts it to your channel.

If MCP fails or a server isn't configured, the runner falls back to the
standard API (no MCP) and posts via the Slack webhook. You always get a
briefing — it just may have less live data.

---

## Managing Schedules

```bash
# Pause/resume
launchctl unload ~/Library/LaunchAgents/com.geekerios.morning-briefing.plist
launchctl load ~/Library/LaunchAgents/com.geekerios.morning-briefing.plist

# Force-run now
launchctl start com.geekerios.morning-briefing
launchctl start com.geekerios.daily-wrap

# Check logs
tail -50 logs/morning.log
tail -50 logs/evening.log
```

---

## Customizing

**Prompts:** Edit `src/prompts.ts` — each template is a plain string.
**Schedule:** Edit Hour/Minute in plist files, then `launchctl unload` + `load`.
**Data sources:** Add MCP server URLs to `src/runner.ts` using the `addServer()` function.

Additional MCP servers you could add:
- Notion: `https://mcp.notion.com/mcp`
- Fireflies: `https://api.fireflies.ai/mcp`
- Supabase: `https://mcp.supabase.com/mcp`

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Extra inputs not permitted" | SDK too old — run `npm install` to get ^0.52.0 |
| "Skipping X — no auth token" | Add the token to `.env` (expected if not configured yet) |
| MCP auth 401/403 | Token may be wrong or expired — check the service's dashboard |
| GCal/Gmail not working | Anthropic proxies may not support standalone tokens — see Step 4 |
| No briefing in Slack | Check `tail -50 logs/morning.log` for errors |
| launchd not firing | `launchctl list \| grep geekerios` — reload if missing |
| Machine was asleep | launchd runs missed jobs on wake (may arrive late) |

## Cost

~$0.02–0.05 per briefing (Sonnet + MCP tool calls). At 10/week: ~$0.20–0.50/week.
