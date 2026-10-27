import type { Language } from "@jules/config";
import type { TaskState } from "@jules/db";

// Textes publiés sur GitHub par Jules. La langue vient de `language` (.jules/config.yml, M2) ;
// en M0, c'est la langue par défaut de l'instance.

type StateText = { label: string; phase?: string };

const STATES: Record<Language, Partial<Record<TaskState, StateText>>> = {
  fr: {
    received: { label: "reçue", phase: "1/9 · Réception" },
    triaging: { label: "en triage", phase: "1/9 · Réception" },
    awaiting_info: { label: "en attente de ta réponse" },
    specifying: { label: "spec en cours", phase: "2/9 · Spécification" },
    awaiting_spec_approval: { label: "spec à valider", phase: "2/9 · Spécification (H1)" },
    designing: { label: "conception en cours", phase: "3/9 · Conception" },
    awaiting_design_approval: { label: "conception à valider", phase: "3/9 · Conception (H2)" },
    building: { label: "en développement", phase: "4/9 · Développement" },
    verifying: { label: "en vérification", phase: "5/9 · Vérification" },
    awaiting_human_review: { label: "PR prête pour ta review", phase: "8/9 · Review humaine" },
    diagnosing: { label: "diagnostic en cours", phase: "DevOps · Diagnostic" },
    awaiting_plan_approval: { label: "plan à approuver", phase: "DevOps · Approbation (HC1)" },
    executing: { label: "plan en cours d'exécution", phase: "DevOps · Exécution" },
    waiting_provider: { label: "en attente du fournisseur de modèle" },
    blocked: { label: "bloquée" },
    cancelled: { label: "annulée" },
    failed: { label: "en échec" },
    done: { label: "terminée" },
  },
  en: {
    received: { label: "received", phase: "1/9 · Intake" },
    triaging: { label: "triaging", phase: "1/9 · Intake" },
    awaiting_info: { label: "waiting for your answer" },
    specifying: { label: "writing the spec", phase: "2/9 · Specification" },
    awaiting_spec_approval: { label: "spec to approve", phase: "2/9 · Specification (H1)" },
    designing: { label: "designing", phase: "3/9 · Design" },
    awaiting_design_approval: { label: "design to approve", phase: "3/9 · Design (H2)" },
    building: { label: "building", phase: "4/9 · Build" },
    verifying: { label: "verifying", phase: "5/9 · Verification" },
    awaiting_human_review: { label: "PR ready for your review", phase: "8/9 · Human review" },
    diagnosing: { label: "diagnosing", phase: "DevOps · Diagnosis" },
    awaiting_plan_approval: { label: "plan to approve", phase: "DevOps · Approval (HC1)" },
    executing: { label: "running the plan", phase: "DevOps · Execution" },
    waiting_provider: { label: "waiting for the model provider" },
    blocked: { label: "blocked" },
    cancelled: { label: "cancelled" },
    failed: { label: "failed" },
    done: { label: "done" },
  },
};

const TEXT = {
  fr: {
    title: "Jules",
    task: "Tâche",
    state: "État",
    plan: "Plan",
    journal: "Journal",
    questions: "Questions",
    answer: "Réponds dans un commentaire de cette issue.",
    pr: "Pull request",
    error: "Raison",
    received: "Demande reçue. Ce commentaire sera mis à jour à chaque étape.",
    triage: "Triage",
    spec: "Spec",
    design: "Conception",
    split: "Découpage proposé",
    approve:
      "Réponds `/jules approve` pour valider, ou `/jules revise <ton retour>` pour la faire reprendre.",
    advice: "Mode conseil (L0) : spec et plan publiés, aucun code ne sera poussé.",
    files: "Fichiers",
    footer: "Jules ne merge jamais : chaque PR attend la review d'un humain.",
    changePlan: "Plan de changement",
    goal: "But",
    impact: "Impact",
    actions: "Actions",
    verify: "Vérifications",
    rollback: "Retour arrière",
    approvePlan:
      "Réponds `/jules approve` pour l'exécuter, `/jules revise <ton retour>` pour un autre plan, ou `/jules cancel` pour le refuser. Le plan expire dans 30 min.",
    approveProduction:
      "Production : l'approbation se donne dans l'interface web ou le desktop, avec ta passkey.",
    report: "Exécution du plan",
    diagnosis: "Diagnostic",
  },
  en: {
    title: "Jules",
    task: "Task",
    state: "State",
    plan: "Plan",
    journal: "Log",
    questions: "Questions",
    answer: "Reply in a comment on this issue.",
    pr: "Pull request",
    error: "Reason",
    received: "Request received. This comment will be updated at every step.",
    triage: "Triage",
    spec: "Spec",
    design: "Design",
    split: "Proposed split",
    approve:
      "Reply `/jules approve` to approve, or `/jules revise <your feedback>` to have it redone.",
    advice: "Advisor mode (L0): spec and plan published, no code will be pushed.",
    files: "Files",
    footer: "Jules never merges: every PR waits for a human review.",
    changePlan: "Change plan",
    goal: "Goal",
    impact: "Impact",
    actions: "Actions",
    verify: "Checks",
    rollback: "Rollback",
    approvePlan:
      "Reply `/jules approve` to run it, `/jules revise <your feedback>` for another plan, or `/jules cancel` to refuse it. The plan expires in 30 min.",
    approveProduction:
      "Production: approve it in the web app or the desktop app, with your passkey.",
    report: "Plan execution",
    diagnosis: "Diagnosis",
  },
} as const;

/** Marqueur invisible qui permet de retrouver le commentaire de statut après un crash. */
export function statusMarker(taskId: string): string {
  return `<!-- jules:status task=${taskId} -->`;
}

export type StatusView = {
  task: {
    id: string;
    state: TaskState;
    prUrl?: string | null;
    lastError?: string | null;
    type?: string | null;
    size?: string | null;
    risk?: string | null;
    autonomy?: string | null;
  };
  plan?: readonly string[];
  updates?: readonly string[];
  questions?: readonly string[];
  split?: readonly { title: string; summary: string }[];
  spec?: {
    problem: string;
    acceptanceCriteria: { id: string; given: string; when: string; then: string }[];
  };
  design?: { approach: string; files: { path: string; change: string }[] };
  changePlan?: {
    server: string;
    environment: string;
    goal: string;
    impact: string;
    actions: (
      | { kind: "command"; command: string; reason: string }
      | { kind: "playbook"; name: string; params: Record<string, string> }
    )[];
    verify: string[];
    rollback: string[];
  };
  planReport?: {
    outcome: string;
    reason: string | null;
    steps: { label: string; phase: string; status: string; exitCode: number | null }[];
  };
  diagnosis?: string;
};

/** Commande d'un agent dans un bloc de code : ni mention, ni rupture de mise en forme. */
function code(text: string): string {
  return `\`${text.replaceAll("`", "'").replace(/\s+/g, " ").trim()}\``;
}

/** Le texte d'un agent ne doit pas pouvoir casser la mise en forme ni mentionner des gens. */
function quoteAgentText(text: string): string {
  return text.replaceAll("@", "@\u200b").replaceAll("<", "&lt;").replace(/\s+/g, " ").trim();
}

export function renderStatusComment(view: StatusView, language: Language): string {
  const t = TEXT[language];
  const { task } = view;
  const state = STATES[language][task.state] ?? { label: task.state };
  const stateLine = state.phase ? `\`${state.label}\` · ${state.phase}` : `\`${state.label}\``;
  const lines = [
    statusMarker(task.id),
    `### ${t.title}`,
    "",
    `**${t.state}** : ${stateLine}  `,
    `**${t.task}** : \`${task.id.slice(0, 8)}\``,
  ];
  if (task.prUrl) {
    lines.push(`**${t.pr}** : ${task.prUrl}`);
  }
  if (task.lastError && ["blocked", "failed", "waiting_provider"].includes(task.state)) {
    lines.push(`**${t.error}** : ${quoteAgentText(task.lastError)}`);
  }
  if (view.questions?.length && task.state === "awaiting_info") {
    lines.push(
      "",
      `#### ${t.questions}`,
      ...view.questions.map((q, i) => `${i + 1}. ${quoteAgentText(q)}`),
      "",
      t.answer,
    );
  }
  if (task.type && task.size && task.risk) {
    lines.push(
      `**${t.triage}** : \`${task.type}\` · taille \`${task.size}\` · risque \`${task.risk}\`${task.autonomy ? ` · autonomie \`${task.autonomy}\`` : ""}`,
    );
  }
  if (view.split?.length) {
    lines.push(
      "",
      `#### ${t.split}`,
      ...view.split.map((s) => `- **${quoteAgentText(s.title)}** : ${quoteAgentText(s.summary)}`),
    );
  }
  if (view.spec) {
    lines.push(
      "",
      `<details${task.state === "awaiting_spec_approval" ? " open" : ""}><summary>${t.spec} (${view.spec.acceptanceCriteria.length} critères)</summary>`,
      "",
      quoteAgentText(view.spec.problem),
      "",
      ...view.spec.acceptanceCriteria.map(
        (c) =>
          `- **${c.id}** : étant donné ${quoteAgentText(c.given)}, quand ${quoteAgentText(c.when)}, alors ${quoteAgentText(c.then)}`,
      ),
      "",
      "</details>",
    );
  }
  if (view.design) {
    lines.push(
      "",
      `<details${task.state === "awaiting_design_approval" || task.state === "done" ? " open" : ""}><summary>${t.design}</summary>`,
      "",
      quoteAgentText(view.design.approach),
      "",
      `${t.files} : ${view.design.files.map((f) => `\`${quoteAgentText(f.path)}\` (${f.change})`).join(", ")}`,
      "",
      "</details>",
    );
  }
  if (task.state === "awaiting_spec_approval" || task.state === "awaiting_design_approval") {
    lines.push("", `> ${t.approve}`);
  }
  if (task.state === "done" && task.autonomy === "L0" && !task.prUrl) {
    lines.push("", t.advice);
  }
  if (view.plan?.length) {
    // Le plan est exécuté dès que la build est livrée.
    const done = ["verifying", "reviewing", "awaiting_human_review", "learning", "done"].includes(
      task.state,
    );
    lines.push(
      "",
      `#### ${t.plan}`,
      ...view.plan.map((step) => `- [${done ? "x" : " "}] ${quoteAgentText(step)}`),
    );
  }
  if (view.updates?.length) {
    lines.push(
      "",
      `<details><summary>${t.journal} (${view.updates.length})</summary>`,
      "",
      ...view.updates.map((u) => `- ${quoteAgentText(u)}`),
      "",
      "</details>",
    );
  }
  if (view.changePlan) {
    const p = view.changePlan;
    lines.push(
      "",
      `<details${task.state === "awaiting_plan_approval" ? " open" : ""}><summary>${t.changePlan} · ${code(p.server)} (${p.environment})</summary>`,
      "",
      `**${t.goal}** : ${quoteAgentText(p.goal)}  `,
      `**${t.impact}** : ${quoteAgentText(p.impact)}`,
      "",
      `${t.actions} :`,
      ...p.actions.map((a, i) =>
        a.kind === "command"
          ? `${i + 1}. ${code(a.command)} : ${quoteAgentText(a.reason)}`
          : `${i + 1}. playbook ${code(a.name)} ${Object.entries(a.params)
              .map(([k, v]) => code(`${k}=${v}`))
              .join(" ")}`,
      ),
      "",
      `${t.verify} : ${p.verify.map(code).join(", ") || "—"}  `,
      `${t.rollback} : ${p.rollback.map(code).join(", ") || "—"}`,
      "",
      "</details>",
    );
    if (task.state === "awaiting_plan_approval") {
      lines.push("", `> ${p.environment === "production" ? t.approveProduction : t.approvePlan}`);
    }
  }
  if (view.planReport) {
    const r = view.planReport;
    const icon = (status: string) =>
      status === "done" ? "✅" : status === "failed" ? "❌" : status === "running" ? "⏳" : "▫️";
    lines.push(
      "",
      `#### ${t.report} : \`${r.outcome}\``,
      ...(r.reason ? [quoteAgentText(r.reason)] : []),
      "",
      ...r.steps
        .filter((s) => s.status !== "pending" && s.status !== "skipped")
        .map(
          (s) =>
            `- ${icon(s.status)} ${s.phase} ${code(s.label)}${s.exitCode !== null ? ` → ${s.exitCode}` : ""}`,
        ),
    );
  }
  if (view.diagnosis) {
    lines.push(
      "",
      `<details open><summary>${t.diagnosis}</summary>`,
      "",
      quoteAgentText(view.diagnosis),
      "",
      "</details>",
    );
  }
  if (task.state === "received") {
    lines.push("", t.received);
  }
  lines.push("", `<sub>${t.footer}</sub>`);
  return lines.join("\n");
}
