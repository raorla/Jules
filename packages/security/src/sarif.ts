import type { FindingInput, Severity } from "./findings.js";

// Export SARIF 2.1.0 des failles du code, pour l'onglet Security des repos privés (WORKFLOW.md §13.2).

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
};

export function toSarif(findings: readonly FindingInput[]): object {
  const rules = [...new Map(findings.map((f) => [`${f.category}/${f.title}`, f])).values()];
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Jules",
            informationUri: "https://github.com",
            rules: rules.map((f) => ({
              id: `${f.category}/${f.title}`,
              name: f.title,
              shortDescription: { text: f.title },
            })),
          },
        },
        results: findings.map((f) => {
          const [path = f.component, line] = f.component.split(/:(?=\d+$)/);
          const isFile = f.category !== "dependency";
          return {
            ruleId: `${f.category}/${f.title}`,
            level: LEVEL[f.severity],
            message: { text: `${f.title} : ${f.evidence}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: isFile ? path : "package.json" },
                  ...(isFile && line ? { region: { startLine: Number(line) } } : {}),
                },
              },
            ],
          };
        }),
      },
    ],
  };
}
