import {
  lockfileParser,
  scanSecrets,
  type FileDiff,
  type Package,
  type Vulnerability,
} from "@jules/gates";
import type { FindingInput } from "./findings.js";

// Audit d'un repo (WORKFLOW.md §13.1), sur les fichiers de la branche par défaut. Analyseurs intégrés,
// comme les gates de M3 : secrets (G4.2), dépendances par l'API OSV (G5.11), config d'infra.

export type RepoFile = { readonly path: string; readonly text: string };

const isLockfile = (path: string) => lockfileParser(path) !== undefined;

/** Paquets déclarés par les lockfiles du repo, dédupliqués. */
export function repoPackages(files: readonly RepoFile[]): Package[] {
  const seen = new Map<string, Package>();
  for (const file of files) {
    const parse = lockfileParser(file.path);
    for (const p of parse ? parse(file.text) : []) {
      seen.set(`${p.ecosystem}:${p.name}@${p.version}`, p);
    }
  }
  return [...seen.values()];
}

export function dependencyFindings(
  repoId: string,
  vulns: readonly Vulnerability[],
): FindingInput[] {
  return vulns.map((v): FindingInput => ({
    scope: "repo",
    targetId: repoId,
    category: "dependency",
    component: `${v.package.name}@${v.package.version}`,
    title: v.id,
    // Sans sévérité publiée, une faille connue reste à traiter : `medium` par défaut.
    severity: v.severity === "unknown" ? "medium" : v.severity,
    scanner: "osv",
    evidence: v.summary.slice(0, 300) || v.id,
    details: { advisory: v.id, ecosystem: v.package.ecosystem },
  }));
}

/** Secrets écrits dans le code : le chemin et la ligne, jamais la valeur. */
export function secretFindings(repoId: string, files: readonly RepoFile[]): FindingInput[] {
  const diffs = files
    .filter((f) => !isLockfile(f.path))
    .map((f): FileDiff => ({
      path: f.path,
      status: "A",
      // Tout le fichier, comme s'il venait d'être ajouté : le scanner de G4.2 lit les lignes ajoutées.
      added: f.text.split("\n").map((text, i) => ({ line: i + 1, text })),
      removed: [],
    }));
  return scanSecrets(diffs).map((s): FindingInput => ({
    scope: "repo",
    targetId: repoId,
    category: "secret",
    component: `${s.path}:${s.line}`,
    title: `Secret dans le code : ${s.kind}`,
    severity: "critical",
    scanner: "secrets",
    evidence: `${s.kind} en clair (valeur non reproduite)`,
  }));
}

const RULES: {
  file: RegExp;
  test: RegExp;
  title: string;
  severity: FindingInput["severity"];
  absent?: true;
}[] = [
  {
    file: /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
    test: /^\s*privileged:\s*true\b/m,
    title: "Conteneur privilégié",
    severity: "high",
  },
  {
    file: /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
    test: /^\s*network_mode:\s*["']?host\b/m,
    title: "Conteneur sur le réseau de l'hôte",
    severity: "medium",
  },
  {
    file: /(^|\/)(docker-)?compose[^/]*\.ya?ml$/,
    test: /^\s*-\s*["']?\/var\/run\/docker\.sock/m,
    title: "Socket Docker monté dans un conteneur",
    severity: "high",
  },
  {
    file: /(^|\/)Dockerfile[^/]*$/,
    test: /^\s*USER\s+(?!root\b)\S+/m,
    title: "Image exécutée en root (aucun USER)",
    severity: "medium",
    absent: true,
  },
  {
    file: /(^|\/)Dockerfile[^/]*$/,
    test: /^\s*(ADD|RUN)\s+.*\bcurl\b[^|]*\|\s*(ba)?sh\b/m,
    title: "Script téléchargé et exécuté pendant la construction",
    severity: "medium",
  },
];

/** Config d'infra : règles intégrées sur les Dockerfile et fichiers compose. */
export function infraFindings(repoId: string, files: readonly RepoFile[]): FindingInput[] {
  return files.flatMap((file) =>
    RULES.filter(
      (rule) => rule.file.test(file.path) && rule.test.test(file.text) !== (rule.absent ?? false),
    ).map((rule): FindingInput => ({
      scope: "repo",
      targetId: repoId,
      category: "config",
      component: file.path,
      title: rule.title,
      severity: rule.severity,
      scanner: "infra",
      evidence: `${rule.title} (${file.path})`,
    })),
  );
}
