import type { Review, Spec } from "@jules/artifacts";
import type { GateReport } from "@jules/gates";

// Description de la PR (WORKFLOW.md §9) : la matrice de traçabilité relie chaque critère
// d'acceptation aux tests qui le vérifient et au verdict du reviewer.

export type PullRequestContext = {
  task: { id: string; title: string; risk: string | null; costUsd: string };
  issueNumber: number;
  spec?: Spec | undefined;
  build?:
    | {
        summary: string;
        commitMessage: string;
        acTests?: { ac: string; tests: string[] }[];
        deviationsFromDesign?: string[];
        newDependencies?: { name: string; version: string; why: string }[];
      }
    | undefined;
  gates?: GateReport | undefined;
  review?: Review | undefined;
  versions: { spec?: number; design?: number; prompts: string[] };
};

const AC_ICON = { met: "✅", partial: "⚠️", missing: "❌" } as const;
const GATE_ICON: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skip: "⏭️",
  pending: "⏳",
};
const SHOWN_GATES = ["G5.2", "G5.3", "G5.4", "G5.5", "G5.6", "G4.2", "G5.11", "G5.14"];

/** Texte venu d'un agent : il ne doit ni casser le tableau, ni mentionner quelqu'un. */
function cell(text: string): string {
  return text
    .replaceAll("|", "\\|")
    .replaceAll("@", "@​")
    .replaceAll("<", "&lt;")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderPullRequestBody(ctx: PullRequestContext): string {
  const lines = [
    `Closes #${ctx.issueNumber}`,
    "",
    "## Résumé",
    cell(ctx.build?.summary ?? ctx.task.title),
  ];

  if (ctx.spec) {
    lines.push(
      "",
      "## Critères d'acceptation",
      "| AC | Critère | Tests | Statut |",
      "|---|---|---|---|",
    );
    for (const ac of ctx.spec.acceptanceCriteria) {
      const tests = ctx.build?.acTests?.find((t) => t.ac === ac.id)?.tests ?? [];
      const verdict = ctx.review?.acVerdicts.find((v) => v.ac === ac.id);
      const status = verdict ? AC_ICON[verdict.status] : "⏳";
      lines.push(
        `| ${ac.id} | Étant donné ${cell(ac.given)}, quand ${cell(ac.when)}, alors ${cell(ac.then)} | ${tests.length ? tests.map((t) => `\`${cell(t)}\``).join("<br>") : "_aucun déclaré_"} | ${status} |`,
      );
    }
  }

  if (ctx.gates) {
    const shown = ctx.gates.results.filter(
      (r) => SHOWN_GATES.includes(r.id) && r.status !== "skip",
    );
    const coverage = ctx.gates.results.find((r) => r.id === "G5.6");
    lines.push(
      "",
      "## Vérifications",
      shown
        .map(
          (r) =>
            `${r.name}${r.id === "G5.6" && coverage ? ` ${/^[\d.]+ %/.exec(coverage.details)?.[0] ?? ""}` : ""} ${GATE_ICON[r.status] ?? ""}`,
        )
        .join(" · "),
    );
  }
  if (ctx.review) {
    lines.push("", "## Review IA", cell(ctx.review.summary));
  }
  lines.push(
    "",
    "## Risque",
    `${ctx.task.risk ?? "inconnu"}${ctx.build?.newDependencies?.length ? ` : ${ctx.build.newDependencies.length} dépendance(s) ajoutée(s) (${ctx.build.newDependencies.map((d) => cell(`${d.name}@${d.version}`)).join(", ")})` : ""}`,
  );
  const deviations = ctx.build?.deviationsFromDesign ?? [];
  lines.push(
    "",
    "## Écarts par rapport au plan",
    deviations.length ? deviations.map((d) => `- ${cell(d)}`).join("\n") : "Aucun.",
  );
  const cost = Number(ctx.task.costUsd).toFixed(2).replace(".", ",");
  lines.push(
    "",
    `<sub>Jules · tâche ${ctx.task.id.slice(0, 8)}${ctx.versions.spec ? ` · spec v${ctx.versions.spec}` : ""}${ctx.versions.design ? ` · design v${ctx.versions.design}` : ""} · prompts ${ctx.versions.prompts.join(", ")} · coût ${cost} $ · Jules ne merge jamais.</sub>`,
  );
  return lines.join("\n");
}

/** Corps de la review GitHub (type COMMENT) : verdict, critères, findings sans ligne. */
export function renderReviewBody(review: Review, marker: string, problems: string[]): string {
  const verdict = {
    approve: "✅ favorable",
    request_changes: "❌ changements demandés",
    escalate: "⚠️ escaladée à un humain",
  }[review.verdict];
  const lines = [marker, `### Review Jules : ${verdict}`, "", cell(review.summary)];
  if (review.acVerdicts.length) {
    lines.push(
      "",
      "| AC | Statut | Note |",
      "|---|---|---|",
      ...review.acVerdicts.map(
        (a) => `| ${a.ac} | ${AC_ICON[a.status]} ${a.status} | ${cell(a.note)} |`,
      ),
    );
  }
  const withoutLine = review.findings.filter((f) => f.line === undefined);
  if (withoutLine.length) {
    lines.push(
      "",
      ...withoutLine.map((f) => `- **${f.severity}** \`${cell(f.file)}\` : ${cell(f.comment)}`),
    );
  }
  if (problems.length) {
    lines.push("", "**Gate G6** : " + problems.map(cell).join(" ; "));
  }
  lines.push(
    "",
    "<sub>Review IA de Jules (type COMMENT) : elle ne compte pas dans les approbations requises.</sub>",
  );
  return lines.join("\n");
}
