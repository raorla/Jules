import { changePlanSchema } from "@jules/devops";
import { z } from "zod";
import { designSchema, reviewSchema, specSchema, triageSchema } from "./phases.js";

// Entrées des outils `jules` (ARCHITECTURE.md §7). Le serveur MCP du sandbox les déclare au modèle,
// et le broker les revalide : le sandbox n'est pas digne de confiance.

const line = (max: number) => z.string().trim().min(1).max(max);
const serverName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/)
  .describe("Nom du serveur dans Jules.");

export const capabilityInputs = {
  post_update: z.object({ message: line(2000) }),
  set_plan: z.object({ steps: z.array(line(200)).min(1).max(15) }),
  ask_human: z.object({ questions: z.array(line(1000)).min(1).max(5) }),
  run_checks: z.object({ gates: z.array(z.string().max(20)).max(20).optional() }),
  submit_triage: triageSchema,
  submit_spec: specSchema,
  submit_design: designSchema,
  submit_review: reviewSchema,
  propose_lessons: z.object({
    lessons: z
      .array(
        z.object({
          text: line(500).describe("La leçon, applicable aux tâches futures de ce repo."),
          source: line(300).describe(
            "D'où elle vient : commentaire, commit humain, raison de fermeture.",
          ),
        }),
      )
      .max(3),
  }),
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
  // Agent DevOps (ARCHITECTURE.md §7) : le worker exécute, l'agent ne voit jamais une clé.
  server_exec: z.object({
    server: serverName,
    command: line(2000).describe("Commande shell exacte, une seule ligne de préférence."),
    reason: line(500).describe("Pourquoi cette commande, pour le journal."),
  }),
  server_crontab_read: z.object({ server: serverName }),
  server_run_playbook: z.object({
    server: serverName,
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/),
    params: z.record(z.string().max(40), z.string().max(200)).default({}),
  }),
  submit_change_plan: changePlanSchema,
  server_git: z.object({
    server: serverName,
    operation: z.enum(["pull", "fetch", "clone"]),
    path: z
      .string()
      .regex(/^\/[A-Za-z0-9._/-]{1,200}$/)
      .describe("Dossier du dépôt sur le serveur (chemin absolu)."),
    url: z
      .string()
      .regex(/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._/-]+$/)
      .optional()
      .describe("Pour `clone` seulement."),
  }),
  server_publish_file: z.object({
    server: serverName,
    path: z.string().regex(/^\/[A-Za-z0-9._/-]{1,300}$/),
    label: line(100).optional(),
  }),
  // Agent Sécurité (ARCHITECTURE.md §7) : audits exécutés par le worker, résultats sans valeur secrète.
  audit_repo: z.object({}),
  audit_image: z.object({ image: z.string().max(300) }),
  audit_server: z.object({ server: serverName }),
  audit_platform: z.object({}),
  report_finding: z
    .object({
      findingId: z
        .string()
        .regex(/^[0-9a-f-]{8,36}$/)
        .optional()
        .describe("Finding existant à analyser (les 8 premiers caractères suffisent)."),
      analysis: line(2000).describe("Exploitabilité, priorité, contexte : ton analyse."),
      falsePositive: z
        .boolean()
        .default(false)
        .describe("Proposer un faux positif ; seul un humain le confirme."),
      new: z
        .object({
          scope: z.enum(["repo", "server"]),
          server: serverName.optional(),
          category: z.enum(["dependency", "secret", "code", "config", "server"]),
          component: line(300),
          title: line(300),
          severity: z.enum(["critical", "high", "medium", "low"]),
          evidence: line(1000).describe("Preuve courte, sans aucune valeur secrète."),
        })
        .optional()
        .describe("Nouveau finding, trouvé par toi."),
    })
    .refine((v) => (v.findingId === undefined) !== (v.new === undefined), {
      message: "donne soit findingId, soit new",
    }),
  propose_remediation: z.object({
    findingId: z.string().regex(/^[0-9a-f-]{8,36}$/),
    kind: z.enum(["developer", "devops"]),
    request: line(4000).describe("Ce qu'il faut corriger, pour la tâche de remédiation."),
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
  propose_lessons:
    "Propose au plus 3 leçons pour les prochaines tâches de ce repo, chacune avec sa source. Un humain les validera. Une seule fois ; une liste vide est acceptée.",
  submit_review:
    "Soumet la review : verdict (approve, request_changes, escalate), résumé, statut de chaque critère AC-n (met, partial, missing) et findings (blocker, major, minor, nit) avec fichier et ligne. Une seule fois.",
  submit_build:
    "Termine le développement : résumé du travail, message de commit Conventional Commits, tests ajoutés. Une seule fois.",
  server_exec:
    "Exécute tout de suite une commande en lecture sur un serveur (40 par exécution). Une commande qui modifie le serveur est refusée, sauf en D3 hors production : passe par submit_change_plan. Les commandes dangereuses sont toujours refusées.",
  server_crontab_read: "Lit la crontab de l'utilisateur Jules sur un serveur.",
  server_run_playbook:
    "Lance un playbook relu de .jules/playbooks.yml (D2 et plus, hors production). Sinon, inclus-le dans un plan.",
  submit_change_plan:
    "Soumet un plan de changement : actions exactes (commandes ou playbooks), impact, vérifications en lecture, retour arrière. L'exécution se termine ; le worker exécutera le plan une fois approuvé. Une seule fois.",
  server_git:
    "Opération git sur un serveur : fetch (lecture), pull en fast-forward ou clone (changements). Hooks désactivés.",
  server_publish_file: "Rend un fichier du serveur téléchargeable dans l'interface.",
  audit_repo:
    "Audite le repo de la tâche (secrets, dépendances par OSV, config d'infra) sur la branche par défaut. Les résultats deviennent des findings ; tu reçois leur liste.",
  audit_image: "Audite une image de conteneur.",
  audit_server:
    "Audite un serveur par un script fixe : fichiers de secrets (chemins, droits, noms de variables, jamais de valeur), config SSH, ports, comptes, mises à jour, conteneurs.",
  audit_platform:
    "Audite la config de Jules : passkeys des admins, réglages d'approbation, clés d'hôte, refus récents.",
  report_finding:
    "Analyse un finding existant (findingId) ou enregistre un nouveau finding (new). Tu peux proposer un faux positif ; un humain le confirme.",
  propose_remediation:
    "S1 seulement : crée une tâche de remédiation liée au finding, développeur (type security, risque high) ou DevOps.",
  merge_pull_request: "Merge une pull request.",
  deploy: "Déploie dans un environnement.",
  read_secret: "Lit un secret.",
  git_push: "Pousse une branche.",
};

export function isCapabilityName(name: string): name is CapabilityName {
  return Object.hasOwn(capabilityInputs, name);
}
