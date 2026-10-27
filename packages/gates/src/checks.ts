import picomatch from "picomatch";
import type { Commit, FileDiff } from "./diff.js";

// Gates déterministes sur le diff (WORKFLOW.md §5). Chaque fonction renvoie la liste des problèmes
// trouvés ; une liste vide veut dire que la gate passe.

const TEST_PATTERNS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/test/**",
  "**/tests/**",
  "test/**",
  "tests/**",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_test.go",
  "**/*Test.java",
  "**/*Tests.cs",
];

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((p) => picomatch.isMatch(path, p, { dot: true }));
}

const SOURCE_EXTENSIONS = /\.(c|m)?(j|t)sx?$|\.(py|go|rb|java|kt|cs|php|rs|swift|vue|svelte)$/;

export function isSourceFile(path: string): boolean {
  return (
    SOURCE_EXTENSIONS.test(path) &&
    !isTestFile(path) &&
    !/(^|\/)(dist|build|vendor|node_modules)\//.test(path)
  );
}

// G4.2 — secrets. Motifs des fournisseurs courants, plus les affectations à forte entropie.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["clé AWS", /\bAKIA[0-9A-Z]{16}\b/],
  ["jeton GitHub", /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/],
  ["clé Anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["clé OpenAI", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ["jeton Slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ["clé Stripe", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["clé Google", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["clé privée", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
];
const ASSIGNMENT =
  /(password|passwd|pwd|secret|api[_-]?key|access[_-]?key|token|private[_-]?key)["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i;
const PLACEHOLDER =
  /^(x+|\*+|changeme|example|placeholder|dummy|test|secret|password|<.*>|\$\{.*\}|\{\{.*\}\}|process\.env.*)$/i;

export function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

export type SecretFinding = { path: string; line: number; kind: string };

export function scanSecrets(files: readonly FileDiff[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    for (const added of file.added) {
      const provider = SECRET_PATTERNS.find(([, pattern]) => pattern.test(added.text));
      if (provider) {
        findings.push({ path: file.path, line: added.line, kind: provider[0] });
        continue;
      }
      const assignment = ASSIGNMENT.exec(added.text);
      const value = assignment?.[2];
      if (value && !PLACEHOLDER.test(value) && entropy(value) >= 3.5) {
        findings.push({
          path: file.path,
          line: added.line,
          kind: `valeur secrète (${assignment[1]?.toLowerCase() ?? "?"})`,
        });
      }
    }
  }
  return findings;
}

// G4.3 — messages de commit.
const CONVENTIONAL =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: \S.{0,98}$/;

export function checkCommits(commits: readonly Commit[], taskId: string): string[] {
  const problems: string[] = [];
  if (commits.length === 0) {
    problems.push("aucun commit");
  }
  for (const commit of commits) {
    const short = commit.sha.slice(0, 8);
    if (!CONVENTIONAL.test(commit.subject)) {
      problems.push(
        `${short} : « ${commit.subject.slice(0, 80)} » n'est pas au format Conventional Commits`,
      );
    }
    if (!new RegExp(`^Jules-Task: ${taskId}$`, "m").test(commit.body)) {
      problems.push(`${short} : trailer Jules-Task manquant`);
    }
  }
  return problems;
}

// G5.8 — intégrité des tests : aucun test supprimé ou ignoré, aucun seuil abaissé.
const SKIP_MARKERS =
  /\b(?:it|test|describe|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|test|describe)\s*\(|@Disabled\b|@Ignore\b|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip\(|\bskip\s*\(\s*["']/;
const THRESHOLD_FILES = [
  "**/vitest.config.*",
  "**/vite.config.*",
  "**/jest.config.*",
  "**/package.json",
  "**/.nycrc*",
  "**/.c8rc*",
  "**/karma.conf.*",
  "**/pyproject.toml",
  "**/setup.cfg",
  "**/.coveragerc",
  "**/codecov.yml",
  "**/tox.ini",
];
const THRESHOLD_LINE =
  /(threshold\w*|coverage\w*|lines|branches|functions|statements|fail[_-]?under|min\w*)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i;

export function checkTestIntegrity(files: readonly FileDiff[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (file.status === "D" && isTestFile(file.path)) {
      problems.push(`test supprimé : ${file.path}`);
      continue;
    }
    if (isTestFile(file.path)) {
      for (const added of file.added) {
        if (SKIP_MARKERS.test(added.text)) {
          problems.push(
            `${file.path}:${added.line} : test ignoré ou isolé (${added.text.trim().slice(0, 60)})`,
          );
        }
      }
      const removedTests = file.removed.filter((l) => /\b(?:it|test)\s*\(/.test(l)).length;
      const addedTests = file.added.filter((a) => /\b(?:it|test)\s*\(/.test(a.text)).length;
      if (removedTests > addedTests) {
        problems.push(`${file.path} : ${removedTests - addedTests} test(s) retiré(s)`);
      }
    }
    if (THRESHOLD_FILES.some((p) => picomatch.isMatch(file.path, p, { dot: true }))) {
      for (const removed of file.removed) {
        const before = THRESHOLD_LINE.exec(removed);
        if (!before) {
          continue;
        }
        const after = file.added
          .map((a) => THRESHOLD_LINE.exec(a.text))
          .find((m) => m?.[1]?.toLowerCase() === before[1]?.toLowerCase());
        if (after && Number(after[2]) < Number(before[2])) {
          problems.push(
            `${file.path} : seuil ${before[1] ?? "?"} abaissé de ${before[2] ?? "?"} à ${after[2] ?? "?"}`,
          );
        }
      }
    }
  }
  return problems;
}

// G5.9 — désactivations de règles (avertissement, transmis au reviewer).
const DISABLES =
  /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|#\s*noqa|\/\/\s*nolint|#\s*type:\s*ignore|#\s*pylint:\s*disable|@SuppressWarnings|#\[allow\(/;

export function checkRuleDisables(files: readonly FileDiff[]): string[] {
  return files.flatMap((file) =>
    file.added
      .filter((a) => DISABLES.test(a.text))
      .map((a) => `${file.path}:${a.line} : ${a.text.trim().slice(0, 80)}`),
  );
}
