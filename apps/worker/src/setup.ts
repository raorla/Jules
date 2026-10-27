import { BUILTIN_PROTECTED_PATHS } from "@jules/policy";

// `@jules setup` (ARCHITECTURE.md §12) : onboarding déterministe d'un repo. On détecte la stack,
// on propose `.jules/config.yml`, un `AGENTS.md` s'il n'en existe pas et des CODEOWNERS pour les
// chemins sensibles, et on liste les règles de branche qui manquent. Le résultat est une PR normale.

export type RepoFiles = { has(path: string): boolean; read(path: string): string | undefined };

export type Stack = {
  name: string;
  install: string | null;
  build: string | null;
  lint: string | null;
  typecheck: string | null;
  test: string | null;
  coverageReport: string | null;
  egress: string[];
};

export function detectStack(files: RepoFiles): Stack | undefined {
  if (files.has("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts =
        (JSON.parse(files.read("package.json") ?? "{}") as { scripts?: Record<string, string> })
          .scripts ?? {};
    } catch {
      scripts = {};
    }
    const pm = files.has("pnpm-lock.yaml") ? "pnpm" : files.has("yarn.lock") ? "yarn" : "npm";
    const install =
      pm === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : pm === "yarn"
          ? "yarn install --frozen-lockfile"
          : files.has("package-lock.json")
            ? "npm ci"
            : "npm install";
    const run = (script: string) =>
      scripts[script] ? (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`) : null;
    return {
      name: `Node.js (${pm})`,
      install,
      build: run("build"),
      lint: run("lint"),
      typecheck: run("typecheck") ?? run("type-check") ?? run("tsc"),
      test: scripts.test ? (pm === "npm" ? "npm test" : `${pm} test`) : null,
      coverageReport: "coverage/lcov.info",
      egress:
        pm === "yarn" ? ["registry.npmjs.org", "registry.yarnpkg.com"] : ["registry.npmjs.org"],
    };
  }
  if (files.has("pyproject.toml") || files.has("requirements.txt")) {
    return {
      name: "Python",
      install: files.has("requirements.txt")
        ? "pip install -r requirements.txt"
        : "pip install -e .",
      build: null,
      lint: files.read("pyproject.toml")?.includes("ruff") ? "ruff check ." : null,
      typecheck: files.read("pyproject.toml")?.includes("mypy") ? "mypy ." : null,
      test: "pytest --cov --cov-report=lcov:coverage/lcov.info",
      coverageReport: "coverage/lcov.info",
      egress: ["pypi.org", "files.pythonhosted.org"],
    };
  }
  if (files.has("go.mod")) {
    return {
      name: "Go",
      install: "go mod download",
      build: "go build ./...",
      lint: "go vet ./...",
      typecheck: null,
      test: "go test ./...",
      coverageReport: null,
      egress: ["proxy.golang.org", "sum.golang.org"],
    };
  }
  if (files.has("Cargo.toml")) {
    return {
      name: "Rust",
      install: "cargo fetch",
      build: "cargo build",
      lint: "cargo clippy -- -D warnings",
      typecheck: null,
      test: "cargo test",
      coverageReport: null,
      egress: ["crates.io", "static.crates.io", "index.crates.io"],
    };
  }
  return undefined;
}

const yamlValue = (value: string | null) => (value === null ? "null" : JSON.stringify(value));

export function renderRepoConfig(stack: Stack | undefined, language: "fr" | "en"): string {
  const s = stack ?? {
    name: "inconnue",
    install: null,
    build: null,
    lint: null,
    typecheck: null,
    test: null,
    coverageReport: null,
    egress: [],
  };
  return [
    "# Config de Jules pour ce repo, lue sur la branche par défaut (ARCHITECTURE.md §13).",
    `# Stack détectée : ${s.name}. Vérifie les commandes avant de merger.`,
    "version: 1",
    `language: ${language}`,
    "commands:",
    `  install: ${yamlValue(s.install)}`,
    `  build: ${yamlValue(s.build)}`,
    `  lint: ${yamlValue(s.lint)}`,
    `  typecheck: ${yamlValue(s.typecheck)}`,
    `  test: ${yamlValue(s.test)}`,
    "  e2e: null",
    ...(s.coverageReport
      ? ["coverage:", `  report: ${s.coverageReport}`]
      : ["coverage: {}  # report: coverage/lcov.info"]),
    "gates:",
    "  diff_coverage_min: 80",
    "  max_diff_lines: 600",
    "risk:",
    '  high: ["src/auth/**", "src/payments/**"]',
    '  medium: ["src/api/**"]',
    '  low: ["docs/**", "**/*.md"]',
    "egress:",
    `  allow: ${JSON.stringify(s.egress)}`,
    "budgets:",
    "  max_cost_usd: 15",
    "",
  ].join("\n");
}

export function renderAgentsMd(stack: Stack | undefined): string {
  const s = stack;
  return [
    "# AGENTS.md",
    "",
    "Conventions de ce repo pour les agents de code (Jules et les autres). Complète ce fichier : il est injecté dans le contexte de chaque exécution, depuis la branche par défaut.",
    "",
    "## Commandes",
    "",
    ...(s
      ? [s.install, s.build, s.lint, s.typecheck, s.test]
          .filter((c): c is string => c !== null)
          .map((c) => `- \`${c}\``)
      : ["- (à compléter)"]),
    "",
    "## Conventions",
    "",
    "- Messages de commit au format Conventional Commits.",
    "- Tout changement de comportement arrive avec ses tests.",
    "- (Ajoute ici le style, l'architecture et ce qu'un agent doit éviter.)",
    "",
  ].join("\n");
}

/** CODEOWNERS des chemins sensibles intégrés, attribués à la personne qui a lancé l'onboarding. */
export function renderCodeowners(owner: string): string {
  const paths = BUILTIN_PROTECTED_PATHS.filter(
    (p) => !p.startsWith("**/") || p === "**/migrations/**",
  ).map((p) => (p.endsWith("/**") ? `/${p.slice(0, -2)}` : `/${p}`));
  return [
    "# Chemins sensibles : une review du propriétaire est exigée (ARCHITECTURE.md §12).",
    ...[...new Set(paths)].map((p) => `${p.padEnd(24)} @${owner}`),
    "",
  ].join("\n");
}

export type BranchRule = { type: string; parameters?: Record<string, unknown> };

/** Règles de branche recommandées (ARCHITECTURE.md §12) qui ne sont pas actives sur la branche par défaut. */
export function missingRules(rules: readonly BranchRule[]): string[] {
  const missing: string[] = [];
  const pr = rules.find((r) => r.type === "pull_request");
  if (!pr) {
    missing.push("exiger une pull request avant de merger");
  } else {
    if (Number(pr.parameters?.required_approving_review_count ?? 0) < 1) {
      missing.push("exiger au moins une approbation humaine");
    }
    if (pr.parameters?.require_code_owner_review !== true) {
      missing.push("exiger la review des CODEOWNERS");
    }
  }
  const checks = rules.find((r) => r.type === "required_status_checks");
  const contexts = (
    (checks?.parameters?.required_status_checks as { context: string }[] | undefined) ?? []
  ).map((c) => c.context);
  for (const check of ["Jules / gates", "Jules / review"]) {
    if (!contexts.includes(check)) {
      missing.push(`exiger le check \`${check}\``);
    }
  }
  if (!rules.some((r) => r.type === "non_fast_forward")) {
    missing.push("bloquer les force-push");
  }
  return missing;
}
