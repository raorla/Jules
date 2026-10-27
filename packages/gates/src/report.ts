// Rapport de gates (WORKFLOW.md §6, `GateReport`), publié dans le check run `Jules / gates`.

export type GateStatus = "pass" | "fail" | "warn" | "skip" | "pending";
export type GateResult = {
  id: string;
  name: string;
  status: GateStatus;
  durationMs: number;
  details: string;
};
export type GateReport = { commit: string; results: GateResult[] };

export const GATE_NAMES: Record<string, string> = {
  "G4.1": "Chemins protégés",
  "G4.2": "Aucun secret dans le diff",
  "G4.3": "Messages de commit",
  "G4.4": "Taille du diff",
  "G5.1": "Installation (lockfile figé)",
  "G5.2": "Build",
  "G5.3": "Lint et format",
  "G5.4": "Types",
  "G5.5": "Tests",
  "G5.6": "Couverture du diff",
  "G5.7": "Tests d'abord",
  "G5.8": "Intégrité des tests",
  "G5.9": "Désactivations de règles",
  "G5.10": "Analyse de sécurité du code",
  "G5.11": "Dépendances vulnérables",
  "G5.12": "Licences",
  "G5.13": "Tests e2e",
  "G5.14": "CI du projet",
};

export function result(
  id: string,
  status: GateStatus,
  details: string,
  durationMs = 0,
): GateResult {
  return { id, name: GATE_NAMES[id] ?? id, status, durationMs, details };
}

export function verdict(report: GateReport): "pass" | "fail" | "pending" {
  if (report.results.some((r) => r.status === "fail")) {
    return "fail";
  }
  return report.results.some((r) => r.status === "pending") ? "pending" : "pass";
}

const ICONS: Record<GateStatus, string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "⏭️",
  pending: "⏳",
};

export function renderReport(report: GateReport): string {
  const rows = report.results.map(
    (r) =>
      `| ${r.id} | ${r.name} | ${ICONS[r.status]} ${r.status} | ${(r.durationMs / 1000).toFixed(1)} s | ${r.details.replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 300)} |`,
  );
  return [
    `Commit \`${report.commit.slice(0, 12)}\``,
    "",
    "| Gate | Nom | Statut | Durée | Détail |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}
