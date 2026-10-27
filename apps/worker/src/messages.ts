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
    building: { label: "en développement", phase: "4/9 · Développement" },
    verifying: { label: "en vérification", phase: "5/9 · Vérification" },
    awaiting_human_review: { label: "PR prête pour ta review", phase: "8/9 · Review humaine" },
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
    building: { label: "building", phase: "4/9 · Build" },
    verifying: { label: "verifying", phase: "5/9 · Verification" },
    awaiting_human_review: { label: "PR ready for your review", phase: "8/9 · Human review" },
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
    footer: "Jules ne merge jamais : chaque PR attend la review d'un humain.",
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
    footer: "Jules never merges: every PR waits for a human review.",
  },
} as const;

/** Marqueur invisible qui permet de retrouver le commentaire de statut après un crash. */
export function statusMarker(taskId: string): string {
  return `<!-- jules:status task=${taskId} -->`;
}

export type StatusView = {
  task: { id: string; state: TaskState; prUrl?: string | null; lastError?: string | null };
  plan?: readonly string[];
  updates?: readonly string[];
  questions?: readonly string[];
};

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
  if (view.plan?.length) {
    const done = task.state === "awaiting_human_review" || task.state === "done";
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
  if (task.state === "received") {
    lines.push("", t.received);
  }
  lines.push("", `<sub>${t.footer}</sub>`);
  return lines.join("\n");
}
