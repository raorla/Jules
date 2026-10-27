import { describe, expect, it } from "vitest";
import { computeDora, type DoraDeployment } from "./dora.js";

const at = (hours: number) => new Date(Date.UTC(2026, 9, 1) + hours * 3_600_000);
const deploy = (overrides: Partial<DoraDeployment>): DoraDeployment => ({
  environment: "production",
  status: "succeeded",
  mergedAt: at(0),
  startedAt: at(1),
  endedAt: at(2),
  repoId: "r1",
  ...overrides,
});

describe("métriques DORA (WORKFLOW.md §12.3)", () => {
  it("calcule fréquence, délai, taux d'échec et temps de rétablissement", () => {
    const dora = computeDora(
      [
        deploy({ mergedAt: at(0), endedAt: at(4) }),
        deploy({ status: "rolled_back", mergedAt: at(10), endedAt: at(12) }),
        deploy({ mergedAt: at(11), endedAt: at(15) }),
        deploy({ environment: "staging", status: "failed", endedAt: at(20) }),
        deploy({ status: "running", endedAt: null }),
      ],
      [{ createdAt: at(1) }, { createdAt: at(2) }, { createdAt: at(3) }],
      7,
    );
    expect(dora).toEqual({
      days: 7,
      deploymentsPerWeek: 2,
      leadTimeHours: 4,
      changeFailureRate: 0.33,
      timeToRestoreHours: 3,
      approvalsPerDay: 0.43,
    });
  });

  it("reste lisible sans déploiement", () => {
    expect(computeDora([], [], 30)).toEqual({
      days: 30,
      deploymentsPerWeek: 0,
      leadTimeHours: null,
      changeFailureRate: null,
      timeToRestoreHours: null,
      approvalsPerDay: 0,
    });
  });

  it("prend la médiane sur un nombre pair de valeurs", () => {
    const dora = computeDora(
      [deploy({ mergedAt: at(0), endedAt: at(2) }), deploy({ mergedAt: at(0), endedAt: at(6) })],
      [],
      7,
    );
    expect(dora.leadTimeHours).toBe(4);
  });
});
