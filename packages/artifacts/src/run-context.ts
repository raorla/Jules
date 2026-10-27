import { z } from "zod";

// Contexte d'une exécution, écrit par le worker dans /run/jules/context.json et lu par l'agent-runner.
// Il ne contient aucun secret : le jeton d'exécution arrive par l'environnement et n'ouvre que le broker.

export const SANDBOX_PATHS = {
  dir: "/run/jules",
  context: "/run/jules/context.json",
  result: "/run/jules/result.json",
  transcript: "/run/jules/transcript.jsonl",
  brokerSocket: "/run/jules/broker.sock",
  workspace: "/workspace",
} as const;

export const effortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const runContextSchema = z.object({
  version: z.literal(1),
  runId: z.uuid(),
  taskId: z.uuid(),
  role: z.string(),
  model: z.string(),
  effort: effortSchema,
  fallbackModel: z.string().optional(),
  promptVersion: z.string(),
  systemPrompt: z.string(),
  prompt: z.string(),
  /** Outils intégrés de Claude Code autorisés pour ce rôle (ARCHITECTURE.md §6). */
  builtinTools: z.array(z.string()),
  /** Outils `jules` exposés par le serveur MCP, outils pièges compris. */
  capabilities: z.array(z.string()),
  maxTurns: z.number().int().positive(),
  maxBudgetUsd: z.number().positive(),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const runResultSchema = z.object({
  subtype: z.string(),
  isError: z.boolean(),
  numTurns: z.number(),
  totalCostUsd: z.number(),
  durationMs: z.number(),
  errors: z.array(z.string()),
});
export type RunResult = z.infer<typeof runResultSchema>;
