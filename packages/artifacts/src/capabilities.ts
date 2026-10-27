import { z } from "zod";
import { designSchema, specSchema, triageSchema } from "./phases.js";

// Entrées des outils `jules` (ARCHITECTURE.md §7). Le serveur MCP du sandbox les déclare au modèle,
// et le broker les revalide : le sandbox n'est pas digne de confiance.

const line = (max: number) => z.string().trim().min(1).max(max);

export const capabilityInputs = {
  post_update: z.object({ message: line(2000) }),
  set_plan: z.object({ steps: z.array(line(200)).min(1).max(15) }),
  ask_human: z.object({ questions: z.array(line(1000)).min(1).max(5) }),
  run_checks: z.object({ gates: z.array(z.string().max(20)).max(20).optional() }),
  submit_triage: triageSchema,
  submit_spec: specSchema,
  submit_design: designSchema,
  submit_build: z.object({
    summary: line(4000).describe("Ce qui a été fait, pour la description de la PR."),
    commitMessage: z
      .string()
      .trim()
      .regex(
        /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: .+/,
        {
          message: "Conventional Commits attendu, par exemple « fix(api): corrige la pagination »",
        },
      )
      .max(200),
    testsAdded: z.array(z.string().max(300)).max(100).default([]),
    acTests: z
      .array(z.object({ ac: z.string().max(20), tests: z.array(z.string().max(300)).max(20) }))
      .max(30)
      .default([]),
    deviationsFromDesign: z.array(z.string().max(500)).max(20).default([]),
    newDependencies: z
      .array(
        z.object({
          name: z.string().max(200),
          version: z.string().max(50),
          why: z.string().max(500),
        }),
      )
      .max(30)
      .default([]),
  }),
  // Outils pièges (§7) : déclarés pour que la tentative soit refusée proprement et journalisée.
  merge_pull_request: z.object({ number: z.number().int().optional() }),
  deploy: z.object({ environment: z.string().max(50).optional() }),
  read_secret: z.object({ name: z.string().max(200).optional() }),
  git_push: z.object({ branch: z.string().max(200).optional() }),
} as const;

export type CapabilityName = keyof typeof capabilityInputs;
export type CapabilityInput<K extends CapabilityName> = z.infer<(typeof capabilityInputs)[K]>;

export const capabilityDescriptions: Record<CapabilityName, string> = {
  post_update:
    "Ajoute une ligne au journal du commentaire de statut de la tâche (2 000 caractères, 1 toutes les 15 s).",
  set_plan: "Publie ton plan sous forme de checklist (1 à 15 étapes de 200 caractères).",
  ask_human:
    "Pose jusqu'à 5 questions à l'humain et termine l'exécution. N'appelle cet outil que si la demande est impossible à traiter sans réponse.",
  run_checks:
    "Lance les vérifications du repo sur une copie du workspace. Le résultat est indicatif.",
  submit_triage:
    "Soumet le triage : type, taille, risque estimé, Definition of Ready, questions si la demande n'est pas prête, zones probables. Une seule fois.",
  submit_spec:
    "Soumet la spec : problème, critères d'acceptation AC-n (Étant donné / Quand / Alors), hors périmètre, hypothèses, reproduction pour un bug. Une seule fois.",
  submit_design:
    "Soumet la conception : approche, étapes, fichiers, plan de test (chaque AC couvert), retour arrière, migration et ADR s'il y a lieu. Une seule fois.",
  submit_build:
    "Termine le développement : résumé du travail, message de commit Conventional Commits, tests ajoutés. Une seule fois.",
  merge_pull_request: "Merge une pull request.",
  deploy: "Déploie dans un environnement.",
  read_secret: "Lit un secret.",
  git_push: "Pousse une branche.",
};

export function isCapabilityName(name: string): name is CapabilityName {
  return Object.hasOwn(capabilityInputs, name);
}
