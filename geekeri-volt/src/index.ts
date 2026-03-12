// MUST be first line — redirect all console.log to stderr
// so VoltAgent's startup banner doesn't corrupt MCP stdio
console.log = console.error;

import "dotenv/config";
import { readFileSync } from "fs";
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
      args: ["-y", "ruflo@latest", "mcp", "start"],
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
          result.display = `${result.rate.toFixed(1)}%`;
          break;
        case "pipeline_coverage":
          result.coverage = (i.pipeline ?? 0) / (i.quota ?? 1);
          result.display = `${result.coverage.toFixed(1)}x`;
          result.healthy = result.coverage >= 3;
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
          result.display = `${result.rate.toFixed(1)}%`;
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
          result.display = `${result.nrr.toFixed(1)}%`;
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
          result.display = `${result.ratio.toFixed(1)}x`;
          result.healthy = (result.ratio as number) >= 3;
          break;
        case "magic_number":
          result.magic =
            ((i.current_quarter_arr ?? 0) -
              (i.previous_quarter_arr ?? 0)) /
            (i.previous_quarter_sales_spend ?? 1);
          result.display = result.magic.toFixed(2);
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

// ── Main ───────────────────────────────────────────────
async function main() {
  // Load configs
  const agentConfig = loadJSON<PlatformConfig>("agents.json");
  const skillsConfig = loadJSON<SkillsConfig>("skills.json");

  console.error(
    `Config: ${agentConfig.agents.length} agents, ${skillsConfig.skills.length} skills, ${skillsConfig.tools.length} tools`
  );

  // Get ruflo memory tools
  const allRufloTools = await rufloMcp.getTools();
  const rufloMemoryTools = allRufloTools.filter((t) =>
    workingRufloTools.has(t.name)
  );
  console.error(`ruflo tools: ${rufloMemoryTools.length} connected`);

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

  // Helper: get enabled built-in tools for a given agent name
  function getToolsFor(agentName: string) {
    return skillsConfig.tools
      .filter((t) => t.enabled && t.appliesTo.includes(agentName))
      .map((t) => builtInTools[t.id])
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

  // Log skill assignments
  for (const agent of agentConfig.agents) {
    const skills = skillsConfig.skills
      .filter((s) => s.appliesTo.includes(agent.name))
      .map((s) => s.id);
    const tools = skillsConfig.tools
      .filter((t) => t.enabled && t.appliesTo.includes(agent.name))
      .map((t) => t.name);
    if (skills.length > 0 || tools.length > 0) {
      console.error(
        `  ${agent.name}: skills=[${skills.join(",")}] tools=[${tools.join(",")}]`
      );
    }
  }

  // Build supervisor
  const sup = agentConfig.supervisor;
  const supSkills = getSkillsFor(sup.name);
  const supTools = [
    ...rufloMemoryTools,
    ...getToolsFor(sup.name),
  ];

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