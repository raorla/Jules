import { SEVERITIES, isActive, type FindingStatus, type Severity } from "./findings.js";

// Métriques Sécurité (WORKFLOW.md §13.3).

export type FindingRow = {
  readonly severity: Severity;
  readonly status: FindingStatus;
  readonly scanner: string;
  readonly scope: string;
  readonly dueAt: Date | null;
  readonly firstSeenAt: Date;
  readonly resolvedAt: Date | null;
  readonly reopenCount: number;
};

export type SecurityMetrics = {
  openBySeverity: Record<Severity, number>;
  openByScope: Record<string, number>;
  overdueShare: number | null;
  meanDaysToFix: Record<Severity, number | null>;
  reopened: number;
  falsePositiveRate: Record<string, number>;
};

export function securityMetrics(rows: readonly FindingRow[], now: Date): SecurityMetrics {
  const active = rows.filter((r) => isActive(r.status));
  const openBySeverity = Object.fromEntries(
    SEVERITIES.map((s) => [s, active.filter((r) => r.severity === s).length]),
  ) as Record<Severity, number>;
  const openByScope: Record<string, number> = {};
  for (const r of active) {
    openByScope[r.scope] = (openByScope[r.scope] ?? 0) + 1;
  }
  const overdue = active.filter((r) => r.dueAt !== null && r.dueAt < now).length;
  const meanDaysToFix = Object.fromEntries(
    SEVERITIES.map((s) => {
      const fixed = rows.filter((r) => r.severity === s && r.resolvedAt !== null);
      const days = fixed.map(
        (r) => ((r.resolvedAt as Date).getTime() - r.firstSeenAt.getTime()) / 86_400_000,
      );
      return [
        s,
        days.length === 0
          ? null
          : Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10,
      ];
    }),
  ) as Record<Severity, number | null>;
  const falsePositiveRate: Record<string, number> = {};
  for (const scanner of new Set(rows.map((r) => r.scanner))) {
    const all = rows.filter((r) => r.scanner === scanner);
    falsePositiveRate[scanner] =
      Math.round((all.filter((r) => r.status === "false_positive").length / all.length) * 100) /
      100;
  }
  return {
    openBySeverity,
    openByScope,
    overdueShare: active.length === 0 ? null : Math.round((overdue / active.length) * 100) / 100,
    meanDaysToFix,
    reopened: rows.filter((r) => r.reopenCount > 0).length,
    falsePositiveRate,
  };
}
