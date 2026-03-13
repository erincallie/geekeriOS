// MUST be first line — redirect all console.log to stderr
// so VoltAgent's startup banner doesn't corrupt MCP stdio
console.log = console.error;

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import {
  VoltAgent,
  Agent,
  MCPConfiguration,
  VoltAgentObservability,
  createTool,
} from "@voltagent/core";
import { MCPServer } from "@voltagent/mcp-server";
import { honoServer } from "@voltagent/server-hono";
import { createPinoLogger } from "@voltagent/logger";
import { LibSQLObservabilityAdapter } from "@voltagent/libsql";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

// ── Logging ────────────────────────────────────────────
const logger = createPinoLogger({
  name: "revops-platform",
  level: "info",
});

// ── Observability ──────────────────────────────────────
const observability = new VoltAgentObservability({
  logger,
  serviceName: "revops-voltagent-ruflo",
  storage: new LibSQLObservabilityAdapter({}),
});

// ── ruflo MCP Client (memory tools) ────────────────────
const rufloMcp = new MCPConfiguration({
  servers: {
    ruflo: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@claude-flow/cli@latest", "mcp", "start"],
      env: {
        ...process.env,
        CLAUDE_FLOW_MODE: "v3",
        CLAUDE_FLOW_HOOKS_ENABLED: "true",
        CLAUDE_FLOW_TOPOLOGY: "hierarchical-mesh",
        CLAUDE_FLOW_MAX_AGENTS: "15",
        CLAUDE_FLOW_MEMORY_BACKEND: "hybrid",
      },
      cwd: "/Users/erin/Desktop/geekeriOS",
    },
  },
});

// ── MCP Server (Claude Desktop connects via stdio) ─────
const mcpServer = new MCPServer({
  name: "revops-platform",
  version: "1.0.0",
  description: "RevOps multi-agent platform with skills, tools, and ruflo memory",
  protocols: { stdio: true, http: true, sse: false },
});

// ── Config types ───────────────────────────────────────
interface AgentConfig {
  name: string;
  purpose: string;
  instructions: string;
  model: string;
}

interface SupervisorConfig {
  name: string;
  purpose: string;
  instructions: string;
  model: string;
  guidelines: string[];
}

interface SkillConfig {
  id: string;
  name: string;
  description: string;
  appliesTo: string[];
  content: string;
}

interface ToolConfig {
  id: string;
  name: string;
  description: string;
  appliesTo: string[];
  enabled: boolean;
  source?: "builtin" | "ruflo"; // default "builtin"
}

interface PlatformConfig {
  agents: AgentConfig[];
  supervisor: SupervisorConfig;
}

interface SkillsConfig {
  skills: SkillConfig[];
  tools: ToolConfig[];
}

// ── Load config files ──────────────────────────────────
const rootDir = resolve(import.meta.dirname ?? ".", "..");

function loadJSON<T>(filename: string): T {
  const raw = readFileSync(resolve(rootDir, filename), "utf-8");
  return JSON.parse(raw) as T;
}

// ── Built-in tools (referenced by ID in skills.json) ───
const builtInTools: Record<string, ReturnType<typeof createTool>> = {
  "calculate-metrics": createTool({
    name: "calculate_metrics",
    description:
      "Calculate common RevOps metrics. Provide the metric name and input numbers.",
    parameters: z.object({
      metric: z
        .enum([
          "conversion_rate",
          "pipeline_coverage",
          "weighted_pipeline",
          "deal_velocity",
          "win_rate",
          "average_deal_size",
          "sales_cycle_length",
          "net_revenue_retention",
          "cac_payback_months",
          "ltv_to_cac",
          "magic_number",
        ])
        .describe("Which metric to calculate"),
      inputs: z
        .record(z.number())
        .describe(
          "Key-value pairs of input numbers, e.g. {deals_won: 30, deals_total: 100}"
        ),
    }),
    execute: async ({ metric, inputs }) => {
      const i = inputs;
      let result: Record<string, unknown> = { metric };

      switch (metric) {
        case "conversion_rate":
          result.rate =
            ((i.converted ?? 0) / (i.total ?? 1)) * 100;
          result.display = `${(result.rate as number).toFixed(1)}%`;
          break;
        case "pipeline_coverage":
          result.coverage = (i.pipeline ?? 0) / (i.quota ?? 1);
          result.display = `${(result.coverage as number).toFixed(1)}x`;
          result.healthy = (result.coverage as number) >= 3;
          break;
        case "weighted_pipeline":
          result.value = Object.entries(i).reduce(
            (sum, [, val]) => sum + val,
            0
          );
          result.display = `$${(result.value as number).toLocaleString()}`;
          break;
        case "deal_velocity":
          // velocity = (deals × avg_value × win_rate) / cycle_days
          result.velocity =
            ((i.deals ?? 0) *
              (i.avg_value ?? 0) *
              ((i.win_rate ?? 0) / 100)) /
            (i.cycle_days ?? 1);
          result.display = `$${Math.round(result.velocity as number).toLocaleString()}/day`;
          break;
        case "win_rate":
          result.rate =
            ((i.won ?? 0) / ((i.won ?? 0) + (i.lost ?? 0))) * 100;
          result.display = `${(result.rate as number).toFixed(1)}%`;
          break;
        case "average_deal_size":
          result.avg = (i.total_revenue ?? 0) / (i.deal_count ?? 1);
          result.display = `$${Math.round(result.avg as number).toLocaleString()}`;
          break;
        case "sales_cycle_length":
          result.days = (i.total_days ?? 0) / (i.deal_count ?? 1);
          result.display = `${Math.round(result.days as number)} days`;
          break;
        case "net_revenue_retention":
          result.nrr =
            (((i.starting_arr ?? 0) +
              (i.expansion ?? 0) -
              (i.contraction ?? 0) -
              (i.churn ?? 0)) /
              (i.starting_arr ?? 1)) *
            100;
          result.display = `${(result.nrr as number).toFixed(1)}%`;
          result.healthy = (result.nrr as number) >= 110;
          break;
        case "cac_payback_months":
          result.months =
            (i.cac ?? 0) / ((i.arr_per_customer ?? 0) / 12);
          result.display = `${Math.round(result.months as number)} months`;
          result.healthy = (result.months as number) <= 18;
          break;
        case "ltv_to_cac":
          result.ratio = (i.ltv ?? 0) / (i.cac ?? 1);
          result.display = `${(result.ratio as number).toFixed(1)}x`;
          result.healthy = (result.ratio as number) >= 3;
          break;
        case "magic_number":
          result.magic =
            ((i.current_quarter_arr ?? 0) -
              (i.previous_quarter_arr ?? 0)) /
            (i.previous_quarter_sales_spend ?? 1);
          result.display = (result.magic as number).toFixed(2);
          result.healthy = (result.magic as number) >= 0.75;
          break;
        default:
          result.error = "Unknown metric";
      }

      return result;
    },
  }),

  "format-currency": createTool({
    name: "format_currency",
    description: "Format a number as currency with K/M/B notation",
    parameters: z.object({
      amount: z.number().describe("The number to format"),
      currency: z
        .string()
        .default("USD")
        .describe("Currency code"),
    }),
    execute: async ({ amount, currency }) => {
      const abs = Math.abs(amount);
      let formatted: string;
      if (abs >= 1_000_000_000)
        formatted = `$${(amount / 1_000_000_000).toFixed(1)}B`;
      else if (abs >= 1_000_000)
        formatted = `$${(amount / 1_000_000).toFixed(1)}M`;
      else if (abs >= 1_000)
        formatted = `$${(amount / 1_000).toFixed(0)}K`;
      else formatted = `$${amount.toFixed(2)}`;
      return { formatted, raw: amount, currency };
    },
  }),
};

// ── Verified ruflo tool names ──────────────────────────
const workingRufloTools = new Set([
  "memory_store",
  "memory_retrieve",
  "memory_search",
  "memory_list",
  "hooks_session-start",
  "hooks_session-end",
  "hooks_explain",
  "swarm_health",
  "swarm_status",
  "coordination_metrics",
]);

// ── Fallback memory (ruflo-compatible JSON store) ──────
// Writes to ruflo's data directory so ruflo can read it when its MCP is fixed
const MEMORY_DIR = resolve("/Users/erin/Desktop/geekeriOS/.claude-flow/data");
const MEMORY_FILE = resolve(MEMORY_DIR, "memory-store.json");

interface MemoryEntry {
  key: string;
  value: string;
  namespace: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function loadMemory(): Record<string, MemoryEntry> {
  try {
    if (existsSync(MEMORY_FILE)) {
      return JSON.parse(readFileSync(MEMORY_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveMemory(data: Record<string, MemoryEntry>): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// Built-in memory tools — same interface as ruflo's MCP tools
const memoryBuiltins: Record<string, ReturnType<typeof createTool>> = {
  "ruflo-memory-store": createTool({
    name: "memory_store",
    description:
      "Store key-value data in persistent cross-session memory. Use to save findings, frameworks, client patterns, and reusable insights.",
    parameters: z.object({
      key: z.string().describe("Unique key for this memory entry"),
      value: z.string().describe("The data to store (text, JSON, or any string)"),
      namespace: z.string().default("default").describe("Namespace to organize entries"),
      tags: z.array(z.string()).default([]).describe("Tags for categorization"),
    }),
    execute: async ({ key, value, namespace, tags }) => {
      const data = loadMemory();
      const now = new Date().toISOString();
      const existing = data[key];
      data[key] = {
        key,
        value,
        namespace,
        tags,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      saveMemory(data);
      return { success: true, key, namespace, message: `Stored '${key}' in memory` };
    },
  }),

  "ruflo-memory-retrieve": createTool({
    name: "memory_retrieve",
    description:
      "Retrieve a specific key from persistent memory by exact key name.",
    parameters: z.object({
      key: z.string().describe("The exact key to retrieve"),
    }),
    execute: async ({ key }) => {
      const data = loadMemory();
      const entry = data[key];
      if (!entry) return { found: false, key, message: `No entry found for '${key}'` };
      return { found: true, ...entry };
    },
  }),

  "ruflo-memory-search": createTool({
    name: "memory_search",
    description:
      "Search persistent memory by keyword matching across keys, values, namespaces, and tags. Find past patterns, learnings, and stored analysis by topic.",
    parameters: z.object({
      query: z.string().describe("Search query — matches against keys, values, tags, and namespaces"),
      namespace: z.string().optional().describe("Optional: limit search to a specific namespace"),
    }),
    execute: async ({ query, namespace }) => {
      const data = loadMemory();
      const q = query.toLowerCase();
      const results = Object.values(data).filter((entry) => {
        if (namespace && entry.namespace !== namespace) return false;
        return (
          entry.key.toLowerCase().includes(q) ||
          entry.value.toLowerCase().includes(q) ||
          entry.namespace.toLowerCase().includes(q) ||
          entry.tags.some((t) => t.toLowerCase().includes(q))
        );
      });
      return {
        query,
        resultCount: results.length,
        results: results.map((r) => ({ key: r.key, value: r.value, namespace: r.namespace, tags: r.tags, updatedAt: r.updatedAt })),
      };
    },
  }),

  "ruflo-memory-list": createTool({
    name: "memory_list",
    description:
      "List all stored keys in memory. Useful for reviewing what has been saved across sessions.",
    parameters: z.object({
      namespace: z.string().optional().describe("Optional: filter by namespace"),
    }),
    execute: async ({ namespace }) => {
      const data = loadMemory();
      let entries = Object.values(data);
      if (namespace) entries = entries.filter((e) => e.namespace === namespace);
      return {
        totalEntries: entries.length,
        entries: entries.map((e) => ({
          key: e.key,
          namespace: e.namespace,
          tags: e.tags,
          updatedAt: e.updatedAt,
          preview: e.value.slice(0, 120) + (e.value.length > 120 ? "..." : ""),
        })),
      };
    },
  }),

  "ruflo-session-start": createTool({
    name: "hooks_session-start",
    description: "Begin a tracked session for cross-session memory context.",
    parameters: z.object({
      sessionName: z.string().default("default").describe("Optional session label"),
    }),
    execute: async ({ sessionName }) => {
      const now = new Date().toISOString();
      return { success: true, sessionName, startedAt: now, message: `Session '${sessionName}' started at ${now}` };
    },
  }),

  "ruflo-session-end": createTool({
    name: "hooks_session-end",
    description: "End the current session.",
    parameters: z.object({
      sessionName: z.string().default("default").describe("Session to end"),
    }),
    execute: async ({ sessionName }) => {
      const now = new Date().toISOString();
      return { success: true, sessionName, endedAt: now, message: `Session '${sessionName}' ended at ${now}` };
    },
  }),
};

// ── Main ───────────────────────────────────────────────
async function main() {
  // Load configs
  const agentConfig = loadJSON<PlatformConfig>("agents.json");
  const skillsConfig = loadJSON<SkillsConfig>("skills.json");

  console.error(
    `Config: ${agentConfig.agents.length} agents, ${skillsConfig.skills.length} skills, ${skillsConfig.tools.length} tools`
  );

  // Get ruflo memory tools with retry (ruflo MCP can be slow to register tools)
  let rufloToolMap = new Map<string, (typeof allRufloToolsTyped)[number]>();
  type RufloTool = Awaited<ReturnType<typeof rufloMcp.getTools>>[number];
  let allRufloToolsTyped: RufloTool[] = [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      allRufloToolsTyped = await rufloMcp.getTools();
      const filtered = allRufloToolsTyped.filter((t: RufloTool) =>
        workingRufloTools.has(t.name)
      );
      if (filtered.length > 0) {
        rufloToolMap = new Map(filtered.map((t: RufloTool) => [t.name, t]));
        console.error(
          `ruflo tools: ${filtered.length} connected [${[...rufloToolMap.keys()].join(", ")}] (attempt ${attempt})`
        );
        break;
      }
      console.error(`ruflo tools: 0 on attempt ${attempt}/3, retrying in 2s...`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`ruflo connection error (attempt ${attempt}/3):`, err);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // If ruflo MCP returned 0 tools, activate built-in memory fallback
  const useMemoryFallback = rufloToolMap.size === 0;
  if (useMemoryFallback) {
    console.error(
      `ruflo MCP returned 0 tools — activating built-in memory fallback (writes to ${MEMORY_FILE})`
    );
    // Register fallback tools into builtInTools so getToolsFor resolves them
    Object.assign(builtInTools, memoryBuiltins);
  } else {
    console.error(`ruflo MCP active — using native ruflo memory tools`);
  }

  // Helper: get skills for a given agent name
  function getSkillsFor(agentName: string): string {
    const matching = skillsConfig.skills.filter((s) =>
      s.appliesTo.includes(agentName)
    );
    if (matching.length === 0) return "";
    const block = matching
      .map((s) => `\n--- SKILL: ${s.name} ---\n${s.content}`)
      .join("\n");
    return `\n\nYou have the following specialized skills:\n${block}`;
  }

  // Helper: get enabled tools for a given agent name
  // Resolves from rufloToolMap (if available), then falls back to builtInTools by id
  function getToolsFor(agentName: string) {
    return skillsConfig.tools
      .filter((t) => t.enabled && t.appliesTo.includes(agentName))
      .map((t) => {
        const source = t.source ?? "builtin";
        if (source === "ruflo" && !useMemoryFallback) {
          // ruflo MCP is live — use its tools
          return rufloToolMap.get(t.name);
        }
        // Either builtin source, or ruflo fallback (tools registered in builtInTools)
        return builtInTools[t.id];
      })
      .filter(Boolean);
  }

  // Build sub-agents from config + inject skills + attach tools
  const subAgents = agentConfig.agents.map((def) => {
    const skills = getSkillsFor(def.name);
    const tools = getToolsFor(def.name);
    return new Agent({
      name: def.name,
      purpose: def.purpose,
      instructions: def.instructions + skills,
      model: anthropic(def.model),
      tools: tools.length > 0 ? tools : undefined,
    });
  });

  console.error(`Sub-agents: ${subAgents.map((a) => a.name).join(", ")}`);

  // Log skill and tool assignments for all agents (including supervisor)
  const allAgentNames = [
    ...agentConfig.agents.map((a) => a.name),
    agentConfig.supervisor.name,
  ];
  for (const name of allAgentNames) {
    const skills = skillsConfig.skills
      .filter((s) => s.appliesTo.includes(name))
      .map((s) => s.id);
    const tools = skillsConfig.tools
      .filter((t) => t.enabled && t.appliesTo.includes(name))
      .map((t) => `${t.name}${t.source === "ruflo" ? " [ruflo]" : ""}`);
    if (skills.length > 0 || tools.length > 0) {
      console.error(
        `  ${name}: skills=[${skills.join(",")}] tools=[${tools.join(",")}]`
      );
    }
  }

  // Build supervisor — now uses same config-driven getToolsFor
  const sup = agentConfig.supervisor;
  const supSkills = getSkillsFor(sup.name);
  const supTools = getToolsFor(sup.name);

  const orchestrator = new Agent({
    name: sup.name,
    purpose: sup.purpose,
    instructions: sup.instructions + supSkills,
    model: anthropic(sup.model),
    tools: supTools,
    subAgents,
    supervisorConfig: {
      customGuidelines: sup.guidelines,
      includeAgentsMemory: true,
      fullStreamEventForwarding: {
        types: ["tool-call", "tool-result", "text-delta"],
      },
    },
  });

  // Start VoltAgent
  new VoltAgent({
    agents: { orchestrator },
    server: honoServer({ port: 3141 }),
    mcpServers: { mcpServer },
    logger,
    observability,
  });

  console.error(`
╔══════════════════════════════════════════════════════════╗
║  REVOPS PLATFORM READY                                   ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Agents:  agents.json     (edit via Claude Desktop)      ║
║  Skills:  skills.json     (edit via Claude Desktop)      ║
║                                                          ║
║  ${String(subAgents.length)} sub-agents, ${String(skillsConfig.skills.length)} skills, ${String(supTools.length)} tools loaded              ║
║                                                          ║
║  VoltOps:  https://console.voltagent.dev                 ║
║  → http://localhost:3141                                 ║
║                                                          ║
║  Edit configs in Chat, restart to apply.                 ║
╚══════════════════════════════════════════════════════════╝
  `);
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
