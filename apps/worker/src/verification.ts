import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoConfig } from "@jules/config";
import { git, readFileAt, type GitHubApp, type RepoRef } from "@jules/forge";
import {
  COMMIT_LOG_FORMAT,
  changedPackages,
  checkCommits,
  checkRuleDisables,
  checkTestIntegrity,
  diffCoverage,
  diffStats,
  lockfileParser,
  parseCommitLog,
  parseLcov,
  parseUnifiedDiff,
  queryOsv,
  result,
  scanSecrets,
  type FileDiff,
  type GateReport,
  type GateResult,
  type Package,
} from "@jules/gates";
import { BUILTIN_PROTECTED_PATHS, FORBIDDEN_PATHS, matchesAny } from "@jules/policy";
import type { SandboxDriver } from "@jules/sandbox";

// Gate runner (ARCHITECTURE.md §4.3, WORKFLOW.md §5). Il part du commit poussé, avec la config lue
// sur la branche par défaut. Les gates sur le diff tournent dans le worker, sur le pristine ; les
// commandes du repo tournent dans un conteneur de vérification neuf, qui fait lui-même son checkout.

export type VerificationInput = {
  runId: string;
  taskId: string;
  taskType: string | null;
  pristine: string;
  baseSha: string;
  headSha: string;
  config: RepoConfig;
  ref: RepoRef;
  /** Une gate H2 a été approuvée pour cette tâche : chemins protégés acceptés. */
  protectedPathsApproved: boolean;
};

export type VerificationDeps = {
  github: GitHubApp;
  driver: SandboxDriver;
  runsDir: string;
  sandboxImage: string;
  egressAllow: readonly string[];
  osv?: { baseUrl?: string; fetchImpl?: typeof fetch };
  timeoutMs?: number;
};

export type Verification = { report: GateReport; files: FileDiff[] };

/** Étapes exécutées dans le conteneur, dans l'ordre ; la première qui échoue arrête la suite. */
const COMMAND_STEPS: { id: string; key: keyof RepoConfig["commands"] }[] = [
  { id: "G5.1", key: "install" },
  { id: "G5.2", key: "build" },
  { id: "G5.3", key: "lint" },
  { id: "G5.4", key: "typecheck" },
  { id: "G5.5", key: "test" },
  { id: "G5.13", key: "e2e" },
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Script du conteneur : clone propre du commit poussé, puis chaque commande déclarée, puis les tests d'abord. */
export function verificationScript(
  steps: { id: string; command: string }[],
  options: {
    headSha: string;
    coverageReport?: string;
    testsFirstSha?: string;
    testCommand?: string;
  },
): string {
  const lines = [
    "set -u",
    "G='git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c safe.directory=*'",
    "$G clone -q --no-hardlinks /pristine /workspace/repo || exit 90",
    "cd /workspace/repo",
    `$G checkout -q --detach ${options.headSha} || exit 91`,
    "failed=0",
    "run() {",
    "  id=$1; shift",
    "  if [ $failed -ne 0 ]; then echo skip > /out/$id.exit; return; fi",
    "  start=$(date +%s%N)",
    '  sh -c "$1" > /out/$id.log 2>&1',
    "  code=$?",
    "  echo $code > /out/$id.exit",
    "  echo $(( ($(date +%s%N) - start) / 1000000 )) > /out/$id.ms",
    "  [ $code -ne 0 ] && failed=1",
    "  return 0",
    "}",
  ];
  for (const step of steps) {
    lines.push(`run ${step.id} ${shellQuote(step.command)}`);
  }
  if (options.coverageReport) {
    lines.push(
      `[ -f ${shellQuote(options.coverageReport)} ] && cp ${shellQuote(options.coverageReport)} /out/coverage.lcov`,
    );
  }
  if (options.testsFirstSha && options.testCommand) {
    // G5.7 : les tests du commit `test:` doivent échouer sur ce commit seul (base + tests).
    lines.push(
      `$G checkout -q --detach ${options.testsFirstSha} && sh -c ${shellQuote(options.testCommand)} > /out/tests-first.log 2>&1; echo $? > /out/tests-first.exit`,
    );
  }
  lines.push("exit 0");
  return lines.join("\n");
}

async function readOut(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, name), "utf8");
  } catch {
    return undefined;
  }
}

const tail = (text: string | undefined, max = 600) => (text ?? "").trim().slice(-max);

export async function verify(
  deps: VerificationDeps,
  input: VerificationInput,
): Promise<Verification> {
  const { pristine, baseSha, headSha, config } = input;
  const results: GateResult[] = [];
  const diffText = await git(
    [
      "diff",
      "-U0",
      "--no-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      baseSha,
      headSha,
    ],
    { cwd: pristine },
  );
  const files = parseUnifiedDiff(diffText);
  const commits = parseCommitLog(
    await git(["log", `--format=${COMMIT_LOG_FORMAT}`, `${baseSha}..${headSha}`], {
      cwd: pristine,
    }),
  ).reverse();
  const paths = files.map((f) => f.path);

  // G4.x — avant tout, sur le diff.
  const forbidden = paths.filter((p) => matchesAny(p, FORBIDDEN_PATHS));
  const protectedPaths = paths.filter((p) =>
    matchesAny(p, [...BUILTIN_PROTECTED_PATHS, ...(config.risk.high ?? [])]),
  );
  results.push(
    forbidden.length > 0
      ? result("G4.1", "fail", `chemins interdits : ${forbidden.join(", ")}`)
      : protectedPaths.length > 0 && !input.protectedPathsApproved
        ? result("G4.1", "fail", `chemins protégés sans approbation : ${protectedPaths.join(", ")}`)
        : result(
            "G4.1",
            "pass",
            protectedPaths.length > 0
              ? `chemins protégés approuvés : ${protectedPaths.join(", ")}`
              : "aucun chemin protégé",
          ),
  );
  const secrets = scanSecrets(files);
  results.push(
    secrets.length > 0
      ? result("G4.2", "fail", secrets.map((s) => `${s.path}:${s.line} (${s.kind})`).join(" ; "))
      : result("G4.2", "pass", "aucun secret détecté"),
  );
  const commitProblems = checkCommits(commits, input.taskId);
  results.push(
    commitProblems.length > 0
      ? result("G4.3", "fail", commitProblems.join(" ; "))
      : result("G4.3", "pass", `${commits.length} commit(s) conformes`),
  );
  const stats = diffStats(files);
  const lines = stats.additions + stats.deletions;
  results.push(
    result(
      "G4.4",
      lines > config.gates.max_diff_lines ? "warn" : "pass",
      `${stats.files} fichier(s), +${stats.additions} −${stats.deletions}`,
    ),
  );

  // G5.1 à G5.5 et G5.13 — commandes du repo, dans le conteneur de vérification.
  const steps = COMMAND_STEPS.flatMap((s) => {
    const command = config.commands[s.key];
    return command ? [{ id: s.id, command }] : [];
  });
  const testsCommit = commits.find((c) => /^test(\(|:|!)/.test(c.subject));
  const firstIsTest = commits[0] !== undefined && commits[0] === testsCommit;
  const testCommand = config.commands.test ?? undefined;
  const outDir = join(deps.runsDir, `${input.runId}-verify`, "out");
  const workDir = join(deps.runsDir, `${input.runId}-verify`, "workspace");
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  let lcov: string | undefined;
  let testsFirstExit: number | undefined;
  if (steps.length > 0) {
    const outcome = await deps.driver.run({
      runId: `${input.runId}-verify`,
      image: deps.sandboxImage,
      entrypoint: [
        "sh",
        "-c",
        verificationScript(steps, {
          headSha,
          ...(config.coverage.report ? { coverageReport: config.coverage.report } : {}),
          ...(firstIsTest && testCommand ? { testsFirstSha: testsCommit.sha, testCommand } : {}),
        }),
      ],
      mounts: [
        { source: pristine, target: "/pristine", readOnly: true },
        { source: workDir, target: "/workspace", readOnly: false },
        { source: outDir, target: "/out", readOnly: false },
      ],
      network: {
        kind: "egress",
        allow: [...new Set([...deps.egressAllow, ...config.egress.allow])],
      },
      limits: { timeoutMs: deps.timeoutMs ?? 30 * 60_000 },
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    });
    for (const step of steps) {
      const exit = (await readOut(outDir, `${step.id}.exit`))?.trim();
      const ms = Number((await readOut(outDir, `${step.id}.ms`)) ?? 0);
      const log = tail(await readOut(outDir, `${step.id}.log`));
      results.push(
        exit === "0"
          ? result(step.id, "pass", `\`${step.command}\``, ms)
          : exit === "skip"
            ? result(step.id, "skip", "non exécutée : une gate précédente a échoué", 0)
            : result(
                step.id,
                "fail",
                outcome.timedOut
                  ? "durée maximale dépassée"
                  : `\`${step.command}\` → code ${exit ?? "?"} : ${log}`,
                ms,
              ),
      );
    }
    lcov = await readOut(outDir, "coverage.lcov");
    const firstExit = (await readOut(outDir, "tests-first.exit"))?.trim();
    testsFirstExit = firstExit === undefined ? undefined : Number(firstExit);
  }
  const hasTests = testCommand !== undefined;

  // G5.6 — couverture du diff, avec le seuil de la branche par défaut.
  const coverage = lcov ? diffCoverage(files, parseLcov(lcov, "/workspace/repo")) : undefined;
  if (!hasTests) {
    results.push(
      result("G5.6", "warn", "aucune commande de test déclarée : couverture non mesurée"),
    );
  } else if (!coverage) {
    results.push(
      result(
        "G5.6",
        "fail",
        `rapport de couverture introuvable (${config.coverage.report ?? "coverage.report non déclaré"})`,
      ),
    );
  } else {
    const ok = coverage.percent >= config.gates.diff_coverage_min;
    const missing = coverage.uncovered
      .slice(0, 10)
      .map((u) => `${u.path}:${u.line}`)
      .join(", ");
    results.push(
      result(
        "G5.6",
        ok ? "pass" : "fail",
        `${coverage.percent} % des lignes modifiées couvertes (minimum ${config.gates.diff_coverage_min} %)${missing ? ` ; non couvertes : ${missing}` : ""}`,
      ),
    );
  }

  // G5.7 — tests d'abord : bloquante pour un bug, avertissement sinon.
  const blockingTestsFirst = input.taskType === "bug" && hasTests;
  const testsFirst = (status: "pass" | "fail", details: string) =>
    result("G5.7", status === "fail" && !blockingTestsFirst ? "warn" : status, details);
  if (!hasTests) {
    results.push(result("G5.7", "warn", "aucune commande de test déclarée"));
  } else if (!firstIsTest) {
    results.push(
      testsFirst(
        "fail",
        "le premier commit n'est pas un commit `test:` qui ajoute les tests seuls",
      ),
    );
  } else if (testsFirstExit === undefined) {
    results.push(testsFirst("fail", "les tests du commit `test:` n'ont pas pu être exécutés"));
  } else {
    results.push(
      testsFirstExit === 0
        ? testsFirst("fail", "les tests du commit `test:` passent déjà sans le correctif")
        : result("G5.7", "pass", "les tests échouent sans le correctif et passent avec"),
    );
  }

  // G5.8 et G5.9 — sur le diff.
  const integrity = checkTestIntegrity(files);
  results.push(
    integrity.length > 0
      ? result("G5.8", "fail", integrity.join(" ; "))
      : result("G5.8", "pass", "aucun test supprimé, ignoré ni seuil abaissé"),
  );
  const disables = checkRuleDisables(files);
  results.push(
    disables.length > 0
      ? result("G5.9", "warn", disables.join(" ; "))
      : result("G5.9", "pass", "aucune nouvelle désactivation"),
  );
  results.push(result("G5.10", "skip", "Semgrep n'est pas installé dans l'image de vérification"));

  // G5.11 — dépendances vulnérables, seulement si un lockfile a changé.
  const lockfiles = files.filter((f) => lockfileParser(f.path));
  if (lockfiles.length === 0) {
    results.push(result("G5.11", "pass", "aucun lockfile modifié"));
  } else {
    const changed: Package[] = [];
    for (const file of lockfiles) {
      const parser = lockfileParser(file.path);
      if (!parser) continue;
      const parse = (text: string | undefined) => {
        try {
          return text ? parser(text) : [];
        } catch {
          return [];
        }
      };
      changed.push(
        ...changedPackages(
          parse(await readFileAt(pristine, baseSha, file.path, 20_000_000)),
          parse(await readFileAt(pristine, headSha, file.path, 20_000_000)),
        ),
      );
    }
    try {
      const vulns = await queryOsv(changed, deps.osv ?? {});
      const blocking = vulns.filter((v) => v.severity === "high" || v.severity === "critical");
      const describe = (list: typeof vulns) =>
        list
          .slice(0, 10)
          .map((v) => `${v.package.name}@${v.package.version} ${v.id} (${v.severity})`)
          .join(" ; ");
      results.push(
        blocking.length > 0
          ? result("G5.11", "fail", describe(blocking))
          : vulns.length > 0
            ? result("G5.11", "warn", describe(vulns))
            : result(
                "G5.11",
                "pass",
                `${changed.length} paquet(s) ajouté(s) ou modifié(s), aucune vulnérabilité connue`,
              ),
      );
    } catch (error) {
      results.push(
        result(
          "G5.11",
          "pending",
          `OSV injoignable, nouvelle tentative plus tard : ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  results.push(result("G5.12", "skip", "allowlist de licences pas encore configurée"));

  // G5.14 — CI du projet : les check suites des autres Apps sur ce commit.
  const project = (await deps.github.listCheckRuns(input.ref, headSha)).filter(
    (r) => !r.name.startsWith("Jules /"),
  );
  if (project.length === 0) {
    results.push(result("G5.14", "skip", "aucune CI du projet sur ce commit"));
  } else if (project.some((r) => r.status !== "completed")) {
    results.push(
      result(
        "G5.14",
        "pending",
        `CI en cours : ${project
          .filter((r) => r.status !== "completed")
          .map((r) => r.name)
          .join(", ")}`,
      ),
    );
  } else {
    const failing = project.filter(
      (r) => !["success", "neutral", "skipped"].includes(r.conclusion ?? ""),
    );
    results.push(
      failing.length > 0
        ? result(
            "G5.14",
            "fail",
            `CI en échec : ${failing.map((r) => `${r.name} (${r.conclusion ?? "?"})`).join(", ")}`,
          )
        : result("G5.14", "pass", `${project.length} check(s) au vert`),
    );
  }

  const order = (id: string) =>
    id
      .split(".")
      .map(Number)
      .reduce((a, b) => a * 100 + b, 0);
  return {
    report: { commit: headSha, results: results.sort((a, b) => order(a.id) - order(b.id)) },
    files,
  };
}
