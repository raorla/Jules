import {
  and,
  artifacts,
  auditLog,
  commands,
  eq,
  gte,
  inArray,
  lt,
  repos,
  sql,
  tasks,
  type Db,
} from "@jules/db";

// Métriques (WORKFLOW.md §10) et rapport hebdomadaire (`jules report`). Calculées depuis la base :
// tâches, artefacts (rapports de gates, retours humains, fermeture des PR), commandes et audit.

export type Metrics = {
  repo: string;
  autonomy: string | null;
  tasks: number;
  prsOpened: number;
  merged: number;
  closedWithoutMerge: number;
  /** PR mergées / PR ouvertes. */
  acceptanceRate: number | null;
  mergedWithoutRetouch: number;
  /** Part des tâches vertes dès la première vérification. */
  firstTryGateRate: number | null;
  avgReviewRounds: number | null;
  avgHumanInterventions: number | null;
  avgHoursToReady: number | null;
  avgHoursReadyToMerge: number | null;
  totalCostUsd: number;
  /** Coût total, tâches abandonnées comprises, divisé par le nombre de PR mergées. */
  costPerMergedPr: number | null;
  promotion: string | null;
};

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const mean = (values: number[]) =>
  values.length === 0 ? null : values.reduce((x, y) => x + y, 0) / values.length;
const hours = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 3_600_000;

/** Règle de promotion (WORKFLOW.md §10) : 20 tâches, 80 % d'acceptation, aucun défaut échappé grave. */
export function promotionAdvice(
  m: Pick<Metrics, "autonomy" | "tasks" | "acceptanceRate">,
): string | null {
  if (m.autonomy === "L1" && m.tasks >= 20 && (m.acceptanceRate ?? 0) >= 0.8) {
    return "promotion L1 → L2 possible (vérifie d'abord qu'aucun défaut échappé grave n'est lié à Jules)";
  }
  return null;
}

export async function computeMetrics(
  db: Db,
  period: { since: Date; until: Date },
): Promise<Metrics[]> {
  const rows = await db
    .select({ task: tasks, repo: repos.fullName, autonomy: repos.autonomy })
    .from(tasks)
    .innerJoin(repos, eq(repos.id, tasks.repoId))
    .where(
      and(
        gte(tasks.createdAt, period.since),
        lt(tasks.createdAt, period.until),
        eq(tasks.agent, "developer"),
      ),
    );
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((r) => r.task.id);
  const facts = await db
    .select({
      taskId: artifacts.taskId,
      kind: artifacts.kind,
      version: artifacts.version,
      content: artifacts.content,
      createdAt: artifacts.createdAt,
    })
    .from(artifacts)
    .where(
      and(
        inArray(artifacts.taskId, ids),
        inArray(artifacts.kind, ["pr_closed", "gate_report", "human_input"]),
      ),
    );
  const decided = await db
    .select({ taskId: commands.taskId, n: sql<number>`count(*)::int` })
    .from(commands)
    .where(and(inArray(commands.taskId, ids), eq(commands.decision, "applied")))
    .groupBy(commands.taskId);
  const readyAt = await db
    .select({ taskId: auditLog.targetId, at: sql<Date>`min(${auditLog.at})` })
    .from(auditLog)
    .where(
      and(
        inArray(auditLog.targetId, ids),
        eq(auditLog.action, "task.transition"),
        sql`${auditLog.data}->>'to' = 'awaiting_human_review'`,
      ),
    )
    .groupBy(auditLog.targetId);

  const byRepo = new Map<string, typeof rows>();
  for (const row of rows) {
    byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
  }
  const factsOf = (taskId: string, kind: string) =>
    facts.filter((f) => f.taskId === taskId && f.kind === kind);
  const commandsOf = (taskId: string) => decided.find((d) => d.taskId === taskId)?.n ?? 0;
  const readyOf = (taskId: string) => {
    const at = readyAt.find((r) => r.taskId === taskId)?.at;
    return at ? new Date(at) : undefined;
  };

  return [...byRepo.entries()].map(([repo, list]) => {
    const opened = list.filter((r) => r.task.prNumber !== null);
    const closed = list
      .map((r) => ({ row: r, fact: factsOf(r.task.id, "pr_closed")[0] }))
      .filter((c) => c.fact);
    const merged = closed.filter((c) => (c.fact?.content as { merged?: boolean }).merged === true);
    const fixes = (taskId: string) =>
      factsOf(taskId, "human_input").filter((h) => (h.content as { kind: string }).kind === "fix")
        .length;
    const withGates = list.filter((r) => factsOf(r.task.id, "gate_report").length > 0);
    const firstTry = withGates.filter((r) => {
      const first = factsOf(r.task.id, "gate_report").sort((a, b) => a.version - b.version)[0];
      return !(first?.content as { results: { status: string }[] }).results.some(
        (g) => g.status === "fail",
      );
    });
    const totalCostUsd = list.reduce((sum, r) => sum + Number(r.task.costUsd), 0);
    const metrics: Metrics = {
      repo,
      autonomy: list[0]?.autonomy ?? null,
      tasks: list.length,
      prsOpened: opened.length,
      merged: merged.length,
      closedWithoutMerge: closed.length - merged.length,
      acceptanceRate: ratio(merged.length, opened.length),
      mergedWithoutRetouch: merged.filter((m) => fixes(m.row.task.id) === 0).length,
      firstTryGateRate: ratio(firstTry.length, withGates.length),
      avgReviewRounds: mean(opened.map((r) => r.task.reviewRounds + fixes(r.task.id))),
      avgHumanInterventions: mean(
        list.map((r) => commandsOf(r.task.id) + factsOf(r.task.id, "human_input").length),
      ),
      avgHoursToReady: mean(
        list.flatMap((r) => {
          const at = readyOf(r.task.id);
          return at ? [hours(r.task.createdAt, at)] : [];
        }),
      ),
      avgHoursReadyToMerge: mean(
        merged.flatMap((m) => {
          const at = readyOf(m.row.task.id);
          return at && m.fact ? [hours(at, m.fact.createdAt)] : [];
        }),
      ),
      totalCostUsd,
      costPerMergedPr: merged.length === 0 ? null : totalCostUsd / merged.length,
      promotion: null,
    };
    return { ...metrics, promotion: promotionAdvice(metrics) };
  });
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)} %`);
const num = (v: number | null, digits = 1) =>
  v === null ? "—" : v.toFixed(digits).replace(".", ",");
const usd = (v: number | null) => (v === null ? "—" : `${v.toFixed(2).replace(".", ",")} $`);

export function renderMetrics(
  list: readonly Metrics[],
  period: { since: Date; until: Date },
): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  if (list.length === 0) {
    return `Rapport Jules du ${day(period.since)} au ${day(period.until)} : aucune tâche.\n`;
  }
  const lines = [`Rapport Jules du ${day(period.since)} au ${day(period.until)}`, ""];
  for (const m of list) {
    lines.push(
      `${m.repo} (autonomie ${m.autonomy ?? "?"})`,
      `  tâches ${m.tasks} · PR ouvertes ${m.prsOpened} · mergées ${m.merged} · fermées sans merge ${m.closedWithoutMerge}`,
      `  taux d'acceptation ${pct(m.acceptanceRate)} · merges sans retouche ${m.mergedWithoutRetouch} · gates au premier essai ${pct(m.firstTryGateRate)}`,
      `  rounds de review ${num(m.avgReviewRounds)} · interventions humaines par tâche ${num(m.avgHumanInterventions)}`,
      `  délai jusqu'à la PR prête ${num(m.avgHoursToReady)} h · de prête à mergée ${num(m.avgHoursReadyToMerge)} h`,
      `  coût total ${usd(m.totalCostUsd)} · coût par PR mergée ${usd(m.costPerMergedPr)}`,
      ...(m.promotion ? [`  → ${m.promotion}`] : []),
      "",
    );
  }
  lines.push("Défauts échappés : à relier aux issues `bug` (pas encore mesuré automatiquement).");
  return `${lines.join("\n")}\n`;
}
