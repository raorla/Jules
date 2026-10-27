// Machine à états du développeur (WORKFLOW.md §2). Code pur, sans I/O : l'orchestrateur lui donne
// l'état courant, le contexte et un événement ; elle renvoie l'état suivant ou un refus motivé.
// Les transitions et les gardes ne sont jamais décidées par un modèle.

export const TASK_STATES = [
  "received",
  "triaging",
  "awaiting_info",
  "specifying",
  "awaiting_spec_approval",
  "designing",
  "awaiting_design_approval",
  "building",
  "verifying",
  "reviewing",
  "awaiting_human_review",
  "learning",
  "done",
  "waiting_provider",
  "blocked",
  "cancelled",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type Risk = "low" | "medium" | "high";
export type TaskType = "bug" | "feature" | "refactor" | "chore" | "docs" | "test" | "security";
export type Size = "S" | "M" | "L";
export type Autonomy = "L0" | "L1" | "L2";
export type Role = "triager" | "specifier" | "architect" | "developer" | "reviewer" | "learner";

/** États où une exécution d'agent doit tourner, et le rôle qui l'exécute. */
export const RUNNABLE_STATES: Readonly<Partial<Record<TaskState, Role>>> = {
  triaging: "triager",
  specifying: "specifier",
  designing: "architect",
  building: "developer",
  reviewing: "reviewer",
  learning: "learner",
};

export const TERMINAL_STATES: readonly TaskState[] = ["done", "cancelled"];
/** États qui attendent une commande humaine (`/jules retry` ou `/jules cancel`). */
export const HALTED_STATES: readonly TaskState[] = ["blocked", "failed"];

export const LIMITS = {
  questionRounds: 2,
  verificationIterations: 3,
  reviewRounds: 2,
} as const;

export type TaskContext = {
  readonly state: TaskState;
  readonly autonomy: Autonomy;
  readonly type?: TaskType | undefined;
  readonly risk?: Risk | undefined;
  /** L'architecte a prévu un ADR (H2 en risque `medium`). */
  readonly adrPlanned?: boolean | undefined;
  readonly questionRounds: number;
  readonly iterations: number;
  readonly reviewRounds: number;
  /** Phase à reprendre après `awaiting_info`, `waiting_provider`, `blocked` ou `failed`. */
  readonly resumeState?: TaskState | null | undefined;
};

export type TaskEvent =
  | { type: "start" }
  | { type: "triage_submitted"; ready: boolean; size: Size; taskType: TaskType; risk: Risk }
  | { type: "questions_asked" }
  | { type: "answer_received" }
  | { type: "spec_submitted" }
  | { type: "design_submitted"; adrPlanned: boolean }
  | { type: "approve" }
  | { type: "revise" }
  | { type: "build_submitted" }
  /** Chemins protégés touchés (G4.1) ou risque réel au-delà de ce qui a été approuvé : H2 redemandée. */
  | { type: "approval_required"; resume: "building" | "reviewing" }
  | { type: "gates_passed" }
  | { type: "gates_failed" }
  | { type: "review_approved" }
  | { type: "changes_requested" }
  | { type: "review_escalated" }
  | { type: "human_changes_requested" }
  | { type: "pr_closed" }
  | { type: "lessons_submitted" }
  | { type: "run_without_result" }
  | { type: "limit_reached"; reason: string }
  | { type: "provider_unavailable" }
  | { type: "provider_recovered" }
  | { type: "system_error"; reason: string }
  | { type: "cancel" }
  | { type: "retry" };

export type TransitionResult =
  | {
      ok: true;
      next: TaskState;
      /** Champs du contexte à mettre à jour avec l'état. */
      patch: Partial<
        Pick<
          TaskContext,
          | "questionRounds"
          | "iterations"
          | "reviewRounds"
          | "resumeState"
          | "type"
          | "risk"
          | "adrPlanned"
        >
      >;
      reason: string;
    }
  | { ok: false; reason: string };

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(...risks: (Risk | undefined)[]): Risk {
  return risks.reduce<Risk>((acc, r) => (r && RISK_ORDER[r] > RISK_ORDER[acc] ? r : acc), "low");
}

/** Gates humaines H1 et H2 exigées (WORKFLOW.md §3). En L0, aucune : rien n'est codé. */
export function requiredHumanGates(
  ctx: Pick<TaskContext, "autonomy" | "type" | "risk" | "adrPlanned">,
): {
  h1: boolean;
  h2: boolean;
} {
  if (ctx.autonomy === "L0") {
    return { h1: false, h2: false };
  }
  if (ctx.autonomy === "L1") {
    return { h1: true, h2: true };
  }
  const risk = ctx.risk ?? "high";
  return {
    h1: risk === "high" || (risk === "medium" && ctx.type === "feature"),
    h2: risk === "high" || (risk === "medium" && ctx.adrPlanned === true),
  };
}

type Accepted = Extract<TransitionResult, { ok: true }>;

const ok = (next: TaskState, reason: string, patch: Accepted["patch"] = {}): Accepted => ({
  ok: true,
  next,
  patch,
  reason,
});
const refuse = (reason: string): TransitionResult => ({ ok: false, reason });

function afterDesign(ctx: TaskContext, adrPlanned: boolean): TransitionResult {
  if (ctx.autonomy === "L0") {
    return ok("done", "L0 : spec et plan publiés, aucun code", { adrPlanned });
  }
  return requiredHumanGates({ ...ctx, adrPlanned }).h2
    ? ok("awaiting_design_approval", "H2 requise", { adrPlanned })
    : ok("building", "voie rapide après la conception", { adrPlanned });
}

function afterSpec(ctx: TaskContext): TransitionResult {
  return requiredHumanGates(ctx).h1
    ? ok("awaiting_spec_approval", "H1 requise")
    : ok("designing", "voie rapide après la spec");
}

export function transition(ctx: TaskContext, event: TaskEvent): TransitionResult {
  const { state } = ctx;

  if (TERMINAL_STATES.includes(state)) {
    return refuse(`la tâche est déjà ${state}`);
  }

  // Événements valables depuis presque tous les états.
  switch (event.type) {
    case "cancel":
      return ok("cancelled", "annulée par un humain");
    case "system_error":
      return ok("failed", event.reason, { resumeState: resumable(ctx) });
    case "limit_reached":
      return ok("blocked", event.reason, { resumeState: resumable(ctx) });
    case "provider_unavailable":
      return RUNNABLE_STATES[state]
        ? ok("waiting_provider", "fournisseur de modèle indisponible", { resumeState: state })
        : refuse("aucune exécution en cours");
    case "provider_recovered":
      return state === "waiting_provider" && ctx.resumeState
        ? ok(ctx.resumeState, "fournisseur de nouveau disponible", { resumeState: null })
        : refuse("la tâche n'attend pas le fournisseur");
    case "retry":
      return HALTED_STATES.includes(state)
        ? ok(ctx.resumeState ?? "triaging", "relancée par un humain", { resumeState: null })
        : refuse("seule une tâche bloquée ou en échec peut être relancée");
    default:
      break;
  }

  switch (state) {
    case "received":
      return event.type === "start"
        ? ok("triaging", "réception")
        : refuse(`${event.type} inattendu en ${state}`);

    case "triaging":
      if (event.type === "questions_asked") {
        return askQuestions(ctx);
      }
      if (event.type === "triage_submitted") {
        const patch = { type: event.taskType, risk: event.risk };
        if (event.size === "L") {
          return ok("blocked", "taille L : découpage proposé", {
            ...patch,
            resumeState: "triaging",
          });
        }
        if (!event.ready) {
          const asked = askQuestions(ctx);
          return { ...asked, patch: { ...patch, ...asked.patch } };
        }
        return ok("specifying", "Definition of Ready satisfaite (G1)", patch);
      }
      break;

    case "awaiting_info":
      if (event.type === "answer_received") {
        return ok(ctx.resumeState ?? "triaging", "réponse reçue", { resumeState: null });
      }
      break;

    case "specifying":
      if (event.type === "questions_asked") {
        return askQuestions(ctx);
      }
      if (event.type === "spec_submitted") {
        return afterSpec(ctx);
      }
      break;

    case "awaiting_spec_approval":
      if (event.type === "approve") {
        return ok("designing", "spec approuvée (H1)");
      }
      if (event.type === "revise") {
        return ok("specifying", "spec à reprendre");
      }
      break;

    case "designing":
      if (event.type === "questions_asked") {
        return askQuestions(ctx);
      }
      if (event.type === "design_submitted") {
        return afterDesign(ctx, event.adrPlanned);
      }
      break;

    case "awaiting_design_approval":
      if (event.type === "approve") {
        // Après une H2 redemandée en cours de route, on reprend là où elle a été exigée.
        return ctx.resumeState
          ? ok(ctx.resumeState, "approbation donnée (H2)", { resumeState: null })
          : ok("building", "conception approuvée (H2)");
      }
      if (event.type === "revise") {
        return ok("designing", "conception à reprendre");
      }
      break;

    case "building":
      if (event.type === "questions_asked") {
        return askQuestions(ctx);
      }
      if (event.type === "build_submitted") {
        return ok("verifying", "build soumise");
      }
      if (event.type === "approval_required") {
        return ok(
          "awaiting_design_approval",
          "chemins protégés : approbation humaine requise (G4.1)",
          { resumeState: event.resume },
        );
      }
      break;

    case "verifying":
      if (event.type === "gates_passed") {
        return ok("reviewing", "gates vertes");
      }
      if (event.type === "approval_required") {
        return ok(
          "awaiting_design_approval",
          "risque réel au-delà de ce qui a été approuvé : H2 requise",
          { resumeState: event.resume },
        );
      }
      if (event.type === "gates_failed") {
        return ctx.iterations + 1 >= LIMITS.verificationIterations
          ? ok("blocked", `${LIMITS.verificationIterations} itérations sans gates vertes`, {
              iterations: ctx.iterations + 1,
              resumeState: "building",
            })
          : ok("building", "gate en échec", { iterations: ctx.iterations + 1 });
      }
      break;

    case "reviewing":
      if (event.type === "review_approved" || event.type === "review_escalated") {
        return ok(
          "awaiting_human_review",
          event.type === "review_approved" ? "review IA favorable" : "review IA escaladée",
        );
      }
      if (event.type === "changes_requested") {
        return ctx.reviewRounds + 1 > LIMITS.reviewRounds
          ? ok("awaiting_human_review", "rounds de review épuisés : escaladé à un humain", {
              reviewRounds: ctx.reviewRounds + 1,
            })
          : ok("building", "changements demandés par la review", {
              reviewRounds: ctx.reviewRounds + 1,
            });
      }
      break;

    case "awaiting_human_review":
      if (event.type === "human_changes_requested") {
        return ok("building", "retour humain sur la PR");
      }
      if (event.type === "pr_closed") {
        return ok("learning", "PR mergée ou fermée");
      }
      break;

    case "learning":
      if (event.type === "lessons_submitted" || event.type === "run_without_result") {
        return ok("done", "retour d'expérience terminé");
      }
      break;

    default:
      break;
  }

  if (event.type === "run_without_result" && RUNNABLE_STATES[state]) {
    return ok("failed", "l'exécution n'a rien soumis", { resumeState: state });
  }
  return refuse(`${event.type} inattendu en ${state}`);
}

function askQuestions(ctx: TaskContext): Accepted {
  if (ctx.questionRounds >= LIMITS.questionRounds) {
    return ok("blocked", `${LIMITS.questionRounds} rounds de questions sans réponse suffisante`, {
      questionRounds: ctx.questionRounds + 1,
      resumeState: ctx.state,
    });
  }
  return ok("awaiting_info", "questions posées", {
    questionRounds: ctx.questionRounds + 1,
    resumeState: ctx.state,
  });
}

/** État où reprendre après un blocage : la phase en cours, ou celle qui était attendue. */
function resumable(ctx: TaskContext): TaskState | null {
  if (RUNNABLE_STATES[ctx.state]) {
    return ctx.state;
  }
  return ctx.resumeState ?? null;
}
