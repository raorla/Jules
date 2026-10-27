import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { RunContext, RunResult } from "@jules/artifacts";
import { julesMcpServer } from "./tools.js";

export type RunnerEnv = {
  token: string;
  socketPath: string;
  modelBaseUrl: string;
  proxyEnv: Record<string, string>;
  cwd: string;
  onMessage?: (message: unknown) => void;
};

/** Options de l'Agent SDK (ARCHITECTURE.md §4.5). `env` remplace tout l'environnement de Claude Code. */
export function agentOptions(context: RunContext, env: RunnerEnv): Options {
  return {
    model: context.model,
    effort: context.effort,
    ...(context.fallbackModel ? { fallbackModel: context.fallbackModel } : {}),
    systemPrompt: context.systemPrompt,
    tools: context.builtinTools,
    mcpServers: {
      jules: julesMcpServer({
        socketPath: env.socketPath,
        token: env.token,
        capabilities: context.capabilities,
      }),
    },
    strictMcpConfig: true,
    // Acceptable seulement parce que la frontière de sécurité est le conteneur et le broker.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Aucun réglage `.claude/` du repo : un hook versionné s'exécuterait sinon.
    settingSources: [],
    maxTurns: context.maxTurns,
    maxBudgetUsd: context.maxBudgetUsd,
    cwd: env.cwd,
    persistSession: false,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/home/node",
      ANTHROPIC_BASE_URL: env.modelBaseUrl,
      ANTHROPIC_AUTH_TOKEN: env.token,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_AGENT_SDK_CLIENT_APP: "jules/0.1",
      ...env.proxyEnv,
    },
  };
}

export async function runAgent(context: RunContext, env: RunnerEnv): Promise<RunResult> {
  let result: RunResult = {
    subtype: "error_during_execution",
    isError: true,
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    errors: ["aucun résultat reçu de l'Agent SDK"],
  };
  for await (const message of query({
    prompt: context.prompt,
    options: agentOptions(context, env),
  })) {
    env.onMessage?.(message);
    if (message.type === "result") {
      result = {
        subtype: message.subtype,
        isError: message.is_error,
        numTurns: message.num_turns,
        totalCostUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        errors: message.subtype === "success" ? [] : message.errors,
        // Dernier message de l'agent : c'est le rapport d'un diagnostic DevOps.
        ...(message.subtype === "success" ? { text: message.result.slice(0, 20_000) } : {}),
      };
    }
  }
  return result;
}
