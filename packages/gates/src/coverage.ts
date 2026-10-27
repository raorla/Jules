import { isSourceFile } from "./checks.js";
import type { FileDiff } from "./diff.js";

// G5.6 — couverture du diff : part des lignes de code ajoutées qui sont exécutées par les tests.
// Un fichier source modifié absent du rapport compte comme non couvert.

export type LcovFile = { covered: Set<number>; instrumented: Set<number> };

/** Parse un rapport lcov (`SF:`, `DA:ligne,nombre`, `end_of_record`). Les chemins sont relatifs au repo. */
export function parseLcov(text: string, repoRoot = "/workspace"): Map<string, LcovFile> {
  const files = new Map<string, LcovFile>();
  let current: LcovFile | undefined;
  const root = repoRoot.replace(/\/$/, "");
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      let path = line.slice(3).trim();
      if (path.startsWith(`${root}/`)) {
        path = path.slice(root.length + 1);
      }
      current = { covered: new Set(), instrumented: new Set() };
      files.set(path.replace(/^\.\//, ""), current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, hits] = line.slice(3).split(",").map(Number);
      if (lineNo !== undefined && Number.isFinite(lineNo)) {
        current.instrumented.add(lineNo);
        if ((hits ?? 0) > 0) {
          current.covered.add(lineNo);
        }
      }
    } else if (line.startsWith("end_of_record")) {
      current = undefined;
    }
  }
  return files;
}

export type DiffCoverage = {
  covered: number;
  total: number;
  percent: number;
  uncovered: { path: string; line: number }[];
};

export function diffCoverage(
  files: readonly FileDiff[],
  lcov: Map<string, LcovFile>,
): DiffCoverage {
  let covered = 0;
  let total = 0;
  const uncovered: { path: string; line: number }[] = [];
  for (const file of files) {
    if (file.status === "D" || !isSourceFile(file.path)) {
      continue;
    }
    const report = lcov.get(file.path);
    for (const added of file.added) {
      if (added.text.trim() === "") {
        continue;
      }
      // Une ligne non instrumentée (commentaire, accolade) ne compte pas, sauf si le fichier est absent du rapport.
      if (report && !report.instrumented.has(added.line)) {
        continue;
      }
      total += 1;
      if (report?.covered.has(added.line)) {
        covered += 1;
      } else {
        uncovered.push({ path: file.path, line: added.line });
      }
    }
  }
  return {
    covered,
    total,
    percent: total === 0 ? 100 : Math.round((covered / total) * 1000) / 10,
    uncovered,
  };
}
