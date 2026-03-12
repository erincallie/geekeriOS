# GeekeriOS
This is GeekeriOS — a config-driven, multi-agent RevOps platform built on VoltAgent, ruflo, and VoltOps.

## File Organization

- NEVER save to root folder — use the directories below
- Use `/src` for source code files
- Use `/tests` for test files
- Use `/docs` for documentation and markdown files
- Use `/config` for configuration files
- Use `/scripts` for utility scripts
- Use `/examples` for example code

## Architecture

Claude Desktop connects to VoltAgent as an MCP server via stdio. VoltAgent runs a supervisor agent that delegates to sub-agents (real Claude instances). ruflo provides persistent vector memory. VoltOps traces everything.

```
Claude Desktop ←stdio→ VoltAgent MCP Server (:3141)
                              ├── Supervisor (revops-orchestrator)
                              │     ├── Sub-agents (from agents.json)
                              │     ├── Skills injected (from skills.json)
                              │     ├── Built-in tools (from src/index.ts)
                              │     └── ruflo memory tools (MCP client)
                              ├── VoltOps observability (LibSQL)
                              └── MCPServer (stdio + http)
```

## Key Files

- `agents.json` — Agent definitions. Editable by end user via Claude Desktop Chat. Read at startup by `src/index.ts`.
- `skills.json` — Skills (prompt injections) and tool assignments. Same edit pattern.
- `src/index.ts` — Single entry point. Loads both configs, connects ruflo MCP, builds agents, starts VoltAgent.
- `.env` — `ANTHROPIC_API_KEY` (required), optional `VOLTAGENT_PUBLIC_KEY` / `VOLTAGENT_SECRET_KEY`.

## How configs become agents

1. `agents.json` is loaded → each entry in `agents[]` becomes a VoltAgent `Agent` with `subAgents` on the supervisor
2. `skills.json` skills are matched by `appliesTo` → skill `content` is appended to the agent's `instructions` string
3. `skills.json` tools are matched by `appliesTo` + `enabled: true` → resolved from the `builtInTools` map in `src/index.ts`
4. The supervisor gets ruflo memory tools + its own built-in tools + all sub-agents

## Adding a new built-in tool

1. Add to the `builtInTools` record in `src/index.ts` using `createTool` from `@voltagent/core`
2. Use Zod for the `parameters` schema
3. The key in `builtInTools` must match the `id` field in `skills.json`
4. Add a corresponding entry in `skills.json` with `enabled: true` and `appliesTo` listing agent names

Example pattern:

```typescript
"my-tool-id": createTool({
  name: "my_tool_name",
  description: "What it does",
  parameters: z.object({
    input: z.string().describe("What to provide"),
  }),
  execute: async ({ input }) => {
    return { result: "computed value" };
  },
}),
```

Then in `skills.json`:

```json
{
  "id": "my-tool-id",
  "name": "my_tool_name",
  "description": "What it does",
  "appliesTo": ["CRM Analyst"],
  "enabled": true
}
```

## Adding a new agent

Add to the `agents` array in `agents.json`. Required fields: `name`, `purpose`, `instructions`, `model`. The `name` must be used exactly in `skills.json` `appliesTo` arrays for skill/tool assignment. Keep `purpose` short — it goes into the supervisor's system prompt.

## Adding a new skill

Add to the `skills` array in `skills.json`. The `content` field is appended verbatim to matching agents' instructions, prefixed with `--- SKILL: {name} ---`. Write it as actionable methodology, not a description. Use numbered steps, specific thresholds, concrete examples.

## ruflo — what works via MCP

Only these tools have real backends. Everything else creates phantom records with no execution runtime.

**Working:** `memory_store`, `memory_retrieve`, `memory_search`, `memory_list`, `hooks_session-start`, `hooks_session-end`, `hooks_explain`, `swarm_health`, `swarm_status`, `coordination_metrics`

**Filtered out:** `agent_spawn`, `task_create`, `task_list`, `task_update`, `hive-mind_init`, `hive-mind_spawn`, `workflow_create`, `workflow_run`, `agentdb_*`, `system_health`

The filter is the `workingRufloTools` Set in `src/index.ts`. If ruflo fixes these tools in a future release, add them to the Set.

## Work Tracking

This project uses WCP for work tracking (namespace: `ERINWI`).

At the start of sessions, check `wcp_list` for active items. Use `wcp_comment` to log progress and `wcp_update` to change status as work progresses.

## Startup chain

Claude Desktop runs this from `claude_desktop_config.json`:

```
bash -c "
  export PATH=/Users/erin/.nvm/versions/node/v20.19.6/bin:$PATH
  cd /Users/erin/Desktop/geekeriOS
  npx -y ruflo@latest init >/dev/null 2>&1 || true
  npx -y ruflo@latest daemon start >/dev/null 2>&1 || true
  cd revops-voltagent-ruflo
  exec npx tsx src/index.ts
"
```

**Critical:** All commands before the final `exec` must redirect both stdout AND stderr to `/dev/null`. Any non-JSON text on stdout breaks MCP stdio. The `exec` replaces bash with the VoltAgent process so Claude Desktop's stdio pipe connects directly.

## Node.js

Requires Node 20.19+. Claude Desktop defaults to Node 18 via nvm PATH order. The startup chain forces `PATH=/Users/erin/.nvm/versions/node/v20.19.6/bin:$PATH`.

## Commands

```bash
npm run dev        # Start with file watching (development)
npm run build      # Bundle to dist/ via tsdown
npm start          # Run bundled dist/index.js
```

## Ports

- **3141** — VoltAgent HTTP + WebSocket (VoltOps Console connects here)
- ruflo MCP — stdio child process, no port

## Output conventions

- `console.error()` for all logging — stdout is reserved for MCP JSON-RPC
- Pino logger for structured logs
- Startup banner prints to stderr

## Common mistakes to avoid

- **Never write to stdout** from setup code. It corrupts the MCP stdio stream.
- **Never use shell script files** in `claude_desktop_config.json`. macOS Gatekeeper blocks them. Use inline `bash -c` commands.
- **Agent names in skills.json must match agents.json exactly** — case-sensitive string match.
- **Tool IDs in skills.json must match keys in the builtInTools map** — not the tool `name`, the map key.
- **Don't add ruflo's phantom tools** to the `workingRufloTools` set. They create records but nothing executes them. VoltAgent sub-agents handle real orchestration.
- **Keep supervisor `purpose` short.** It's injected into every supervisor LLM call. Put detail in `instructions` instead.
- **Skills are prompt text, not descriptions.** The `content` field is appended directly to agent instructions. Write it as methodology the agent should follow, not a summary of what the skill covers.

## Testing changes

1. Edit `agents.json` or `skills.json`
2. Fully quit Claude Desktop (Cmd+Q on macOS)
3. Relaunch — config is read fresh at startup
4. Open https://console.voltagent.dev to verify agents load and traces appear
5. Check `~/Library/Logs/Claude/` for MCP server logs if connection fails