import type { Language } from "@jules/config";
import type { TaskState } from "@jules/db";

// Textes publiés sur GitHub par Jules. La langue vient de `language` (.jules/config.yml, M2) ;
// en M0, c'est la langue par défaut de l'instance.

type StateText = { label: string; phase?: string };

const STATES: Record<Language, Partial<Record<TaskState, StateText>>> = {
  fr: {
    received: { label: "reçue", phase: "1/9 · Réception" },
    triaging: { label: "en triage", phase: "1/9 · Réception" },
    waiting_provider: { label: "en attente du fournisseur de modèle" },
    blocked: { label: "bloquée" },
    cancelled: { label: "annulée" },
    failed: { label: "en échec" },
    done: { label: "terminée" },
  },
  en: {
    received: { label: "received", phase: "1/9 · Intake" },
    triaging: { label: "triaging", phase: "1/9 · Intake" },
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
    received: "Demande reçue. Ce commentaire sera mis à jour à chaque étape.",
    footer: "Jules ne merge jamais : chaque PR attend la review d'un humain.",
  },
  en: {
    title: "Jules",
    task: "Task",
    state: "State",
    received: "Request received. This comment will be updated at every step.",
    footer: "Jules never merges: every PR waits for a human review.",
  },
} as const;

/** Marqueur invisible qui permet de retrouver le commentaire de statut après un crash. */
export function statusMarker(taskId: string): string {
  return `<!-- jules:status task=${taskId} -->`;
}

export function renderStatusComment(
  task: { id: string; state: TaskState },
  language: Language,
): string {
  const t = TEXT[language];
  const state = STATES[language][task.state] ?? { label: task.state };
  const stateLine = state.phase ? `\`${state.label}\` · ${state.phase}` : `\`${state.label}\``;
  return [
    statusMarker(task.id),
    `### ${t.title}`,
    "",
    `**${t.state}** : ${stateLine}  `,
    `**${t.task}** : \`${task.id.slice(0, 8)}\``,
    "",
    t.received,
    "",
    `<sub>${t.footer}</sub>`,
  ].join("\n");
}
