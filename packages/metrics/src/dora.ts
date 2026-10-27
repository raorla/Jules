// Métriques DevOps (DORA, WORKFLOW.md §12.3), calculées sur les déploiements de la période.
// Fonction pure : la requête est faite par l'appelant (api, `jules report`).

export type DoraDeployment = {
  readonly environment: string;
  readonly status: string;
  readonly mergedAt: Date | null;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly repoId: string;
};

export type Dora = {
  days: number;
  /** Déploiements réussis en production, par semaine. */
  deploymentsPerWeek: number;
  /** Médiane, en heures, du merge de la PR à son arrivée en production. */
  leadTimeHours: number | null;
  /** Déploiements de production suivis d'un retour arrière ou d'un échec. */
  changeFailureRate: number | null;
  /** Médiane, en heures, entre un échec en production et le déploiement réussi suivant. */
  timeToRestoreHours: number | null;
  /** Demandes d'approbation humaine par jour : à surveiller contre la fatigue d'approbation. */
  approvalsPerDay: number;
};

const HOUR = 3_600_000;

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);

export function computeDora(
  deployments: readonly DoraDeployment[],
  approvals: readonly { createdAt: Date }[],
  days: number,
): Dora {
  const production = deployments
    .filter((d) => d.environment === "production" && d.endedAt !== null)
    .sort((a, b) => (a.endedAt as Date).getTime() - (b.endedAt as Date).getTime());
  const succeeded = production.filter((d) => d.status === "succeeded");
  const failed = production.filter((d) => d.status === "failed" || d.status === "rolled_back");
  const leadTimes = succeeded
    .filter((d) => d.mergedAt !== null)
    .map((d) => ((d.endedAt as Date).getTime() - (d.mergedAt as Date).getTime()) / HOUR);
  const restores = failed.flatMap((failure) => {
    const next = succeeded.find(
      (d) => d.repoId === failure.repoId && (d.endedAt as Date) > (failure.endedAt as Date),
    );
    return next
      ? [((next.endedAt as Date).getTime() - (failure.endedAt as Date).getTime()) / HOUR]
      : [];
  });
  const attempted = succeeded.length + failed.length;
  return {
    days,
    deploymentsPerWeek: round((succeeded.length * 7) / days) ?? 0,
    leadTimeHours: round(median(leadTimes)),
    changeFailureRate: attempted === 0 ? null : round(failed.length / attempted),
    timeToRestoreHours: round(median(restores)),
    approvalsPerDay: round(approvals.length / days) ?? 0,
  };
}
