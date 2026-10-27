import { describe, expect, it } from "vitest";
import {
  LIMITS,
  RUNNABLE_STATES,
  TASK_STATES,
  maxRisk,
  requiredHumanGates,
  transition,
  type TaskContext,
  type TaskEvent,
  type TaskState,
} from "./machine.js";

const ctx = (state: TaskState, overrides: Partial<TaskContext> = {}): TaskContext => ({
  state,
  autonomy: "L2",
  type: "feature",
  risk: "medium",
  questionRounds: 0,
  iterations: 0,
  reviewRounds: 0,
  ...overrides,
});

const next = (c: TaskContext, e: TaskEvent) => {
  const r = transition(c, e);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("gates humaines (WORKFLOW.md §3)", () => {
  it.each([
    ["L0", "high", "feature", false, { h1: false, h2: false }],
    ["L1", "low", "docs", false, { h1: true, h2: true }],
    ["L2", "low", "feature", false, { h1: false, h2: false }],
    ["L2", "medium", "feature", false, { h1: true, h2: false }],
    ["L2", "medium", "bug", false, { h1: false, h2: false }],
    ["L2", "medium", "bug", true, { h1: false, h2: true }],
    ["L2", "high", "chore", false, { h1: true, h2: true }],
    ["L2", undefined, "chore", false, { h1: true, h2: true }],
  ] as const)("%s, risque %s, %s, ADR %s", (autonomy, risk, type, adrPlanned, expected) => {
    expect(requiredHumanGates({ autonomy, risk, type, adrPlanned })).toEqual(expected);
  });

  it("prend le risque le plus élevé", () => {
    expect(maxRisk("low", undefined, "medium")).toBe("medium");
    expect(maxRisk("high", "low")).toBe("high");
    expect(maxRisk()).toBe("low");
  });
});

describe("chemins complets", () => {
  it("feature medium en L2 : attend H1, puis voie rapide en conception", () => {
    let c = ctx("received");
    const path: TaskState[] = [];
    for (const e of [
      { type: "start" },
      { type: "triage_submitted", ready: true, size: "M", taskType: "feature", risk: "medium" },
      { type: "spec_submitted" },
      { type: "approve" },
      { type: "design_submitted", adrPlanned: false },
      { type: "build_submitted" },
      { type: "gates_passed" },
      { type: "review_approved" },
      { type: "pr_closed" },
      { type: "lessons_submitted" },
    ] as TaskEvent[]) {
      const r = next(c, e);
      c = { ...c, ...r.patch, state: r.next };
      path.push(r.next);
    }
    expect(path).toEqual([
      "triaging",
      "specifying",
      "awaiting_spec_approval",
      "designing",
      "building",
      "verifying",
      "reviewing",
      "awaiting_human_review",
      "learning",
      "done",
    ]);
  });

  it("coquille low : voie rapide sans aucune attente humaine avant la PR", () => {
    const c = ctx("specifying", { type: "docs", risk: "low" });
    expect(next(c, { type: "spec_submitted" }).next).toBe("designing");
    expect(
      next({ ...c, state: "designing" }, { type: "design_submitted", adrPlanned: false }).next,
    ).toBe("building");
  });

  it("L0 : s'arrête après la conception", () => {
    const r = next(ctx("designing", { autonomy: "L0", risk: "high" }), {
      type: "design_submitted",
      adrPlanned: true,
    });
    expect(r).toMatchObject({ next: "done", patch: { adrPlanned: true } });
  });

  it("L1 : H1 et H2 quel que soit le risque", () => {
    expect(
      next(ctx("specifying", { autonomy: "L1", risk: "low" }), { type: "spec_submitted" }).next,
    ).toBe("awaiting_spec_approval");
    expect(
      next(ctx("designing", { autonomy: "L1", risk: "low" }), {
        type: "design_submitted",
        adrPlanned: false,
      }).next,
    ).toBe("awaiting_design_approval");
    expect(next(ctx("awaiting_design_approval"), { type: "approve" }).next).toBe("building");
  });

  it("revise renvoie à la phase concernée", () => {
    expect(next(ctx("awaiting_spec_approval"), { type: "revise" }).next).toBe("specifying");
    expect(next(ctx("awaiting_design_approval"), { type: "revise" }).next).toBe("designing");
  });
});

describe("réception et questions", () => {
  it("une issue vague donne des questions, puis reprend après la réponse", () => {
    const asked = next(ctx("triaging"), {
      type: "triage_submitted",
      ready: false,
      size: "S",
      taskType: "bug",
      risk: "low",
    });
    expect(asked).toMatchObject({
      next: "awaiting_info",
      patch: { questionRounds: 1, resumeState: "triaging", type: "bug", risk: "low" },
    });
    const resumed = next(ctx("awaiting_info", { resumeState: "triaging" }), {
      type: "answer_received",
    });
    expect(resumed).toMatchObject({ next: "triaging", patch: { resumeState: null } });
    expect(next(ctx("awaiting_info"), { type: "answer_received" }).next).toBe("triaging");
  });

  it.each(["triaging", "specifying", "designing", "building"] as const)(
    "ask_human en %s passe en awaiting_info",
    (state) => {
      expect(next(ctx(state), { type: "questions_asked" })).toMatchObject({
        next: "awaiting_info",
        patch: { resumeState: state },
      });
    },
  );

  it(`bloque après ${LIMITS.questionRounds} rounds de questions`, () => {
    expect(
      next(ctx("triaging", { questionRounds: LIMITS.questionRounds }), { type: "questions_asked" }),
    ).toMatchObject({
      next: "blocked",
      patch: { resumeState: "triaging" },
    });
  });

  it("une tâche L est bloquée avec une proposition de découpage", () => {
    expect(
      next(ctx("triaging"), {
        type: "triage_submitted",
        ready: true,
        size: "L",
        taskType: "feature",
        risk: "medium",
      }).next,
    ).toBe("blocked");
  });
});

describe("boucles bornées", () => {
  it("revient en développement sur une gate en échec, puis bloque", () => {
    expect(next(ctx("verifying"), { type: "gates_failed" })).toMatchObject({
      next: "building",
      patch: { iterations: 1 },
    });
    expect(
      next(ctx("verifying", { iterations: LIMITS.verificationIterations - 1 }), {
        type: "gates_failed",
      }).next,
    ).toBe("blocked");
  });

  it("borne les rounds de review et escalade", () => {
    expect(next(ctx("reviewing"), { type: "changes_requested" })).toMatchObject({
      next: "building",
      patch: { reviewRounds: 1 },
    });
    expect(
      next(ctx("reviewing", { reviewRounds: LIMITS.reviewRounds }), { type: "changes_requested" })
        .next,
    ).toBe("awaiting_human_review");
    expect(next(ctx("reviewing"), { type: "review_escalated" }).next).toBe("awaiting_human_review");
  });

  it("un retour humain sur la PR relance le développement", () => {
    expect(next(ctx("awaiting_human_review"), { type: "human_changes_requested" }).next).toBe(
      "building",
    );
  });

  it("le learner sans résultat termine quand même la tâche", () => {
    expect(next(ctx("learning"), { type: "run_without_result" }).next).toBe("done");
  });
});

describe("sorties et reprises", () => {
  it.each(TASK_STATES.filter((s) => s !== "done" && s !== "cancelled"))(
    "cancel depuis %s",
    (state) => {
      expect(next(ctx(state), { type: "cancel" }).next).toBe("cancelled");
    },
  );

  it("refuse tout événement sur une tâche terminée", () => {
    expect(transition(ctx("done"), { type: "cancel" })).toEqual({
      ok: false,
      reason: "la tâche est déjà done",
    });
    expect(transition(ctx("cancelled"), { type: "retry" }).ok).toBe(false);
  });

  it("limite atteinte ou erreur système : bloquée ou en échec, reprenable", () => {
    expect(next(ctx("building"), { type: "limit_reached", reason: "budget" })).toMatchObject({
      next: "blocked",
      patch: { resumeState: "building" },
    });
    expect(
      next(ctx("awaiting_info", { resumeState: "specifying" }), {
        type: "system_error",
        reason: "x",
      }),
    ).toMatchObject({
      next: "failed",
      patch: { resumeState: "specifying" },
    });
    expect(
      next(ctx("verifying"), { type: "system_error", reason: "x" }).patch.resumeState,
    ).toBeNull();
  });

  it("retry reprend là où la tâche s'était arrêtée, une seule fois", () => {
    expect(next(ctx("blocked", { resumeState: "building" }), { type: "retry" })).toMatchObject({
      next: "building",
      patch: { resumeState: null },
    });
    expect(next(ctx("failed"), { type: "retry" }).next).toBe("triaging");
    expect(transition(ctx("building"), { type: "retry" }).ok).toBe(false);
  });

  it("panne du fournisseur : attend, puis reprend la même phase", () => {
    const waiting = next(ctx("specifying"), { type: "provider_unavailable" });
    expect(waiting).toMatchObject({
      next: "waiting_provider",
      patch: { resumeState: "specifying" },
    });
    expect(
      next(ctx("waiting_provider", { resumeState: "specifying" }), { type: "provider_recovered" })
        .next,
    ).toBe("specifying");
    expect(transition(ctx("waiting_provider"), { type: "provider_recovered" }).ok).toBe(false);
    expect(transition(ctx("awaiting_info"), { type: "provider_unavailable" }).ok).toBe(false);
  });

  it.each(Object.keys(RUNNABLE_STATES).filter((s) => s !== "learning") as TaskState[])(
    "une exécution sans résultat en %s passe en échec",
    (state) => {
      expect(next(ctx(state), { type: "run_without_result" })).toMatchObject({
        next: "failed",
        patch: { resumeState: state },
      });
    },
  );

  it.each([
    ["received", { type: "approve" }],
    ["triaging", { type: "approve" }],
    ["awaiting_info", { type: "approve" }],
    ["specifying", { type: "build_submitted" }],
    ["awaiting_spec_approval", { type: "spec_submitted" }],
    ["designing", { type: "approve" }],
    ["awaiting_design_approval", { type: "gates_passed" }],
    ["building", { type: "approve" }],
    ["verifying", { type: "approve" }],
    ["reviewing", { type: "approve" }],
    ["awaiting_human_review", { type: "approve" }],
    ["learning", { type: "approve" }],
    ["blocked", { type: "approve" }],
  ] as [TaskState, TaskEvent][])("refuse un événement inattendu en %s", (state, event) => {
    expect(transition(ctx(state), event)).toEqual({
      ok: false,
      reason: `${event.type} inattendu en ${state}`,
    });
  });
});
