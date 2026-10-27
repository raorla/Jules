import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { queryOsv } from "@jules/gates";
import {
  dependencyFindings,
  infraFindings,
  repoPackages,
  secretFindings,
  type FindingInput,
  type RepoFile,
} from "@jules/security";
import { z } from "zod";

// Audit de Jules par son propre agent Sécurité (M11, ROADMAP.md) : les mêmes scanners que pour un repo
// géré (secrets, dépendances par OSV, règles d'infra), sur les fichiers suivis du dépôt de Jules. Les
// décisions humaines (faux positif confirmé, risque accepté avec échéance) sont versionnées dans
// `security/exceptions.json` ; un risque accepté expire, et une exception qui ne sert plus est signalée.

const exceptionSchema = z.object({
  path: z.string().min(1),
  /** Titre exact du finding (« Secret dans le code : clé Anthropic », « Socket Docker… »). */
  title: z.string().min(1),
  decision: z.enum(["false_positive", "accept_risk"]),
  note: z.string().min(10),
  until: z.iso.date().optional(),
});
export const exceptionsSchema = z.array(exceptionSchema);
export type SelfAuditException = z.infer<typeof exceptionSchema>;

export type SelfAuditReport = {
  files: number;
  packages: number;
  scanners: string[];
  /** Findings sans décision humaine. */
  open: FindingInput[];
  excepted: { finding: FindingInput; exception: SelfAuditException }[];
  /** Exceptions qui ne correspondent plus à aucun finding : à retirer. */
  stale: SelfAuditException[];
  /** Risques acceptés dont l'échéance est passée : de nouveau ouverts. */
  expired: SelfAuditException[];
};

const MAX_BYTES = 2_000_000;
const BINARY = /\.(png|jpe?g|gif|ico|icns|webp|woff2?|ttf|pdf|zip|gz)$/i;

/** Fichiers suivis par git : rien d'ignoré, rien de généré. */
export function trackedFiles(root: string): RepoFile[] {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split("\0")
    .filter((path) => path && !BINARY.test(path))
    .filter(
      (path) =>
        (statSync(join(root, path), { throwIfNoEntry: false })?.size ?? MAX_BYTES) < MAX_BYTES,
    )
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

const blocking = (f: FindingInput) => f.severity === "critical" || f.severity === "high";

export async function selfAudit(options: {
  root: string;
  exceptions: readonly SelfAuditException[];
  now: Date;
  /** Absent : sans réseau, les dépendances ne sont pas vérifiées. */
  osv?: { baseUrl?: string; fetchImpl?: typeof fetch };
}): Promise<SelfAuditReport> {
  const files = trackedFiles(options.root);
  const packages = repoPackages(files);
  const findings = [...secretFindings("jules", files), ...infraFindings("jules", files)];
  const scanners = ["secrets", "infra"];
  if (options.osv) {
    findings.push(...dependencyFindings("jules", await queryOsv(packages, options.osv)));
    scanners.push("osv");
  }
  const today = options.now.toISOString().slice(0, 10);
  const expired = options.exceptions.filter(
    (e) => e.decision === "accept_risk" && (!e.until || e.until < today),
  );
  const active = options.exceptions.filter((e) => !expired.includes(e));
  const path = (f: FindingInput) => f.component.replace(/:\d+$/, "");
  const open: FindingInput[] = [];
  const excepted: SelfAuditReport["excepted"] = [];
  const used = new Set<SelfAuditException>();
  for (const finding of findings) {
    const exception = active.find((e) => e.path === path(finding) && e.title === finding.title);
    if (exception) {
      used.add(exception);
      excepted.push({ finding, exception });
    } else {
      open.push(finding);
    }
  }
  return {
    files: files.length,
    packages: packages.length,
    scanners,
    open,
    excepted,
    // Une exception de dépendance ne se juge qu'avec OSV.
    stale: active.filter((e) => !used.has(e) && (options.osv || !e.title.startsWith("GHSA-"))),
    expired,
  };
}

/** Code de sortie : 1 si un finding critique ou haut reste ouvert, ou si une exception a expiré. */
export function selfAuditFailed(report: SelfAuditReport): boolean {
  return report.open.some(blocking) || report.expired.length > 0;
}

export function renderSelfAudit(report: SelfAuditReport): string {
  const line = (f: FindingInput) =>
    `  - [${f.severity}] ${f.title} · ${f.component} (${f.scanner})`;
  const blockingOpen = report.open.filter(blocking);
  return [
    `Audit de Jules : ${report.files} fichiers, ${report.packages} paquets, scanners ${report.scanners.join(", ")}.`,
    `Ouverts : ${report.open.length} (dont ${blockingOpen.length} critiques ou hauts).`,
    ...report.open.map(line),
    `Décisions humaines appliquées : ${report.excepted.length}.`,
    ...report.excepted.map(
      ({ finding, exception }) =>
        `  - ${exception.decision === "accept_risk" ? `risque accepté jusqu'au ${exception.until ?? "?"}` : "faux positif"} : ${finding.title} · ${finding.component}`,
    ),
    ...(report.expired.length > 0
      ? [
          "Risques acceptés expirés (à revoir) :",
          ...report.expired.map((e) => `  - ${e.title} · ${e.path}`),
        ]
      : []),
    ...(report.stale.length > 0
      ? [
          "Exceptions sans objet (à retirer) :",
          ...report.stale.map((e) => `  - ${e.title} · ${e.path}`),
        ]
      : []),
  ].join("\n");
}
