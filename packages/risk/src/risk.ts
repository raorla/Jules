import { BUILTIN_PROTECTED_PATHS, matchesAny } from "@jules/policy";
import { maxRisk, type Risk, type Size, type TaskType } from "@jules/workflow";

// Risque d'une tâche (WORKFLOW.md §3). Calculé deux fois : estimé au triage, puis recalculé sur
// le diff réel par ce code déterministe, qui fait foi. Le risque final est le plus élevé des deux.

export type RepoRiskConfig = {
  readonly high?: readonly string[];
  readonly medium?: readonly string[];
  readonly low?: readonly string[];
};

export type DiffSummary = {
  readonly paths: readonly string[];
  readonly additions: number;
  readonly deletions: number;
};

export type RiskAssessment = { risk: Risk; reasons: string[] };

const MIGRATIONS = ["**/migrations/**", "**/migrate/**", "**/*.migration.*"];
const DEPENDENCY_FILES = [
  "**/package.json",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/bun.lock*",
  "**/requirements*.txt",
  "**/pyproject.toml",
  "**/poetry.lock",
  "**/uv.lock",
  "**/Pipfile*",
  "**/go.mod",
  "**/go.sum",
  "**/Cargo.toml",
  "**/Cargo.lock",
  "**/Gemfile*",
  "**/composer.json",
  "**/composer.lock",
  "**/pom.xml",
  "**/build.gradle*",
];

/** Taille d'un diff : S ≤ 100 lignes et ≤ 3 fichiers, M ≤ 400 lignes et ≤ 10 fichiers, L au-delà. */
export function sizeOf(diff: DiffSummary): Size {
  const lines = diff.additions + diff.deletions;
  const files = diff.paths.length;
  if (lines <= 100 && files <= 3) {
    return "S";
  }
  return lines <= 400 && files <= 10 ? "M" : "L";
}

function assess(input: {
  type: TaskType;
  size: Size;
  paths: readonly string[];
  config: RepoRiskConfig;
}): RiskAssessment {
  const reasons: { risk: Risk; reason: string }[] = [];
  const add = (risk: Risk, reason: string) => reasons.push({ risk, reason });
  const touched = (patterns: readonly string[]) =>
    input.paths.filter((p) => matchesAny(p, patterns));

  const protectedPaths = touched([...BUILTIN_PROTECTED_PATHS, ...(input.config.high ?? [])]);
  if (protectedPaths.length > 0)
    add("high", `chemins sensibles : ${protectedPaths.slice(0, 5).join(", ")}`);
  if (touched(MIGRATIONS).length > 0) add("high", "migration de schéma");
  if (input.type === "security") add("high", "tâche de type security");

  const dependencies = touched(DEPENDENCY_FILES);
  if (dependencies.length > 0)
    add("medium", `dépendances modifiées : ${dependencies.slice(0, 5).join(", ")}`);
  if (input.size !== "S") add("medium", `taille ${input.size}`);
  const mediumPaths = touched(input.config.medium ?? []);
  if (mediumPaths.length > 0)
    add("medium", `chemins déclarés medium : ${mediumPaths.slice(0, 5).join(", ")}`);
  if (input.type === "feature") add("medium", "feature (défaut)");

  const risk = maxRisk(...reasons.map((r) => r.risk));
  const kept = reasons.filter((r) => r.risk === risk).map((r) => r.reason);
  return {
    risk,
    reasons:
      kept.length > 0 ? kept : [`${input.type} de taille ${input.size} sans chemin sensible`],
  };
}

/** Risque réel, sur le diff (après la phase 4). C'est lui qui fait foi. */
export function computeRisk(input: {
  type: TaskType;
  diff: DiffSummary;
  config: RepoRiskConfig;
}): RiskAssessment {
  return assess({
    type: input.type,
    size: sizeOf(input.diff),
    paths: input.diff.paths,
    config: input.config,
  });
}

/** Risque estimé au triage, d'après les zones probables. Ne descend jamais sous l'estimation de l'agent. */
export function estimateRisk(input: {
  type: TaskType;
  size: Size;
  likelyAreas: readonly string[];
  agentEstimate: Risk;
  config: RepoRiskConfig;
}): RiskAssessment {
  const rules = assess({
    type: input.type,
    size: input.size,
    paths: input.likelyAreas,
    config: input.config,
  });
  const risk = maxRisk(rules.risk, input.agentEstimate);
  return risk === rules.risk
    ? rules
    : { risk, reasons: [`estimation de l'agent : ${input.agentEstimate}`] };
}
