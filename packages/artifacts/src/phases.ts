import { z } from "zod";

// Artefacts des phases 1 à 3 (WORKFLOW.md §6). Les gates automatiques G2 et G3 sont des règles de
// validation : un artefact qui ne les passe pas est refusé au moment de la soumission, avec
// l'erreur, pour que l'agent le corrige dans la même exécution.

const text = (max: number) => z.string().trim().min(1).max(max);
const risk = z.enum(["low", "medium", "high"]);
export const taskTypeSchema = z.enum([
  "bug",
  "feature",
  "refactor",
  "chore",
  "docs",
  "test",
  "security",
]);

export const triageSchema = z
  .object({
    type: taskTypeSchema,
    size: z.enum(["S", "M", "L"]),
    estimatedRisk: risk,
    ready: z.boolean().describe("Definition of Ready satisfaite (gate G1)"),
    questions: z.array(text(1000)).max(5).default([]),
    splitProposal: z
      .array(z.object({ title: text(200), summary: text(1000) }))
      .max(10)
      .optional(),
    likelyAreas: z.array(text(300)).max(30).default([]),
  })
  .superRefine((t, ctx) => {
    if (!t.ready && t.questions.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "une tâche pas prête doit poser au moins une question",
      });
    }
    if (t.size === "L" && !t.splitProposal?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["splitProposal"],
        message: "une tâche de taille L doit proposer un découpage",
      });
    }
  });
export type Triage = z.infer<typeof triageSchema>;

const acId = z.string().regex(/^AC-\d+$/, { message: "identifiant attendu : AC-1, AC-2…" });

export const specSchema = z
  .object({
    problem: text(4000),
    acceptanceCriteria: z
      .array(z.object({ id: acId, given: text(1000), when: text(1000), then: text(1000) }))
      .min(1, { message: "au moins un critère d'acceptation (G2)" })
      .max(30),
    outOfScope: z.array(text(500)).max(30).default([]),
    assumptions: z.array(text(500)).max(30).default([]),
    reproduction: z
      .object({
        steps: z.array(text(500)).min(1).max(30),
        expected: text(1000),
        actual: text(1000),
      })
      .optional(),
  })
  .superRefine((spec, ctx) => {
    const ids = spec.acceptanceCriteria.map((c) => c.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptanceCriteria"],
        message: `identifiant en double : ${duplicate}`,
      });
    }
  });
export type Spec = z.infer<typeof specSchema>;

export const designSchema = z.object({
  approach: text(4000),
  steps: z.array(text(500)).min(1).max(30),
  files: z
    .array(
      z.object({ path: text(300), change: z.enum(["add", "modify", "delete"]), why: text(500) }),
    )
    .min(1)
    .max(60),
  testPlan: z
    .array(z.object({ ac: acId, level: z.enum(["unit", "integration", "e2e"]), test: text(500) }))
    .min(1)
    .max(100),
  migration: z.object({ description: text(2000), rollback: text(2000) }).optional(),
  rollback: text(2000),
  adr: z.object({ title: text(200), context: text(2000), decision: text(2000) }).optional(),
  risks: z.array(text(500)).max(20).default([]),
});
export type Design = z.infer<typeof designSchema>;

/** G2 : en plus du schéma, un bug doit décrire sa reproduction. */
export function checkSpec(spec: Spec, type: z.infer<typeof taskTypeSchema> | undefined): string[] {
  return type === "bug" && !spec.reproduction
    ? ["G2 : un bug doit décrire sa reproduction (étapes, attendu, observé)"]
    : [];
}

/** G3 : chaque critère d'acceptation a au moins un test prévu, et le plan ne cite que des critères connus. */
export function checkDesign(design: Design, spec: Spec | undefined): string[] {
  if (!spec) {
    return [];
  }
  const ids = new Set(spec.acceptanceCriteria.map((c) => c.id));
  const covered = new Set(design.testPlan.map((t) => t.ac));
  const problems = [...ids]
    .filter((id) => !covered.has(id))
    .map((id) => `G3 : ${id} n'a aucun test prévu`);
  problems.push(
    ...[...covered]
      .filter((id) => !ids.has(id))
      .map((id) => `G3 : ${id} n'existe pas dans la spec`),
  );
  return problems;
}
