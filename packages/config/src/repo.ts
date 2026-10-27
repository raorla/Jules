import { parse } from "yaml";
import { z } from "zod";
import { languageSchema } from "./env.js";

// Config d'un repo : `.jules/config.yml`, toujours lue sur la branche par défaut (ARCHITECTURE.md §13).
// Elle ne peut que restreindre : baisser l'autonomie ou le budget, ajouter des chemins sensibles.

export const REPO_CONFIG_PATH = ".jules/config.yml";
/** Playbooks DevOps (ARCHITECTURE.md §9), lus comme la config sur la branche par défaut. */
export const PLAYBOOKS_PATH = ".jules/playbooks.yml";

const globList = z.array(z.string().min(1).max(300)).max(100);

export const repoConfigSchema = z.object({
  version: z.literal(1),
  language: languageSchema.default("fr"),
  autonomy: z.enum(["L0", "L1", "L2"]).optional(),
  commands: z
    .object({
      install: z.string().max(500).nullable().optional(),
      build: z.string().max(500).nullable().optional(),
      lint: z.string().max(500).nullable().optional(),
      typecheck: z.string().max(500).nullable().optional(),
      test: z.string().max(500).nullable().optional(),
      e2e: z.string().max(500).nullable().optional(),
    })
    .default({}),
  coverage: z.object({ report: z.string().max(300).optional() }).default({}),
  gates: z
    .object({
      diff_coverage_min: z.number().min(0).max(100).default(80),
      max_diff_lines: z.number().int().positive().default(600),
    })
    .default({ diff_coverage_min: 80, max_diff_lines: 600 }),
  risk: z
    .object({ high: globList.optional(), medium: globList.optional(), low: globList.optional() })
    .default({}),
  egress: z
    .object({
      allow: z
        .array(
          z
            .string()
            .regex(/^(\*\.)?[a-z0-9.-]+$/i)
            .max(253),
        )
        .max(50)
        .default([]),
    })
    .default({ allow: [] }),
  budgets: z.object({ max_cost_usd: z.number().positive().optional() }).default({}),
  deploy: z.record(z.string(), z.object({ server: z.string(), playbook: z.string() })).optional(),
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const DEFAULT_REPO_CONFIG: RepoConfig = repoConfigSchema.parse({ version: 1 });

export type RepoConfigResult = { config: RepoConfig; errors: string[] };

/** Lit la config ; une config absente ou invalide donne les valeurs par défaut et la liste des erreurs. */
export function parseRepoConfig(source: string | undefined): RepoConfigResult {
  if (source === undefined) {
    return { config: DEFAULT_REPO_CONFIG, errors: [] };
  }
  let raw: unknown;
  try {
    raw = parse(source, { maxAliasCount: 50 });
  } catch (error) {
    return {
      config: DEFAULT_REPO_CONFIG,
      errors: [`YAML invalide : ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const result = repoConfigSchema.safeParse(raw ?? {});
  return result.success
    ? { config: result.data, errors: [] }
    : {
        config: DEFAULT_REPO_CONFIG,
        errors: result.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`),
      };
}

const AUTONOMY_ORDER = ["L0", "L1", "L2"] as const;

/** Autonomie effective : celle de l'admin, que la config du repo peut seulement baisser. */
export function effectiveAutonomy(
  admin: "L0" | "L1" | "L2",
  repo: RepoConfig["autonomy"],
): "L0" | "L1" | "L2" {
  return repo && AUTONOMY_ORDER.indexOf(repo) < AUTONOMY_ORDER.indexOf(admin) ? repo : admin;
}

/** Budget effectif d'une tâche : le plafond global, que la config du repo peut seulement baisser. */
export function effectiveBudget(globalMaxUsd: number, repo: RepoConfig): number {
  return Math.min(globalMaxUsd, repo.budgets.max_cost_usd ?? globalMaxUsd);
}
