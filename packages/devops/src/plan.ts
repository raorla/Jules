import type { Environment } from "@jules/policy";
import { z } from "zod";
import { classify } from "./classify.js";
import {
  classifyPlaybook,
  renderPlaybook,
  type Builtins,
  type Playbook,
  type VerifyStep,
} from "./playbooks.js";

// Plan de changement (WORKFLOW.md §12.1) : soumis par l'agent, vérifié par la gate GC1, approuvé par
// un humain (HC1), puis exécuté par le worker. Un plan approuvé autorise ses actions exactes.

const line = (max: number) => z.string().trim().min(1).max(max);

export const changePlanSchema = z.object({
  goal: line(500).describe("Ce que le plan doit obtenir."),
  server: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/)
    .describe("Nom du serveur dans Jules."),
  environment: z.enum(["development", "staging", "production"]),
  actions: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("command"), command: line(2000), reason: line(500) }),
        z.object({
          kind: z.literal("playbook"),
          name: z.string().regex(/^[a-z][a-z0-9_-]{0,60}$/),
          params: z.record(z.string().max(40), z.string().max(200)).default({}),
        }),
      ]),
    )
    .min(1)
    .max(20),
  impact: line(1000).describe("Indisponibilité attendue, services touchés."),
  verify: z
    .array(line(2000))
    .min(1)
    .max(10)
    .describe("Commandes `read` ou URL http(s) à vérifier."),
  rollback: z.array(line(2000)).min(1).max(10).describe("Commandes de retour arrière."),
});
export type ChangePlan = z.infer<typeof changePlanSchema>;

/** Étape exécutable d'un plan, dans l'ordre : ce que le worker lancera exactement. */
export type PlanStep =
  | { readonly phase: "action"; readonly command: string; readonly playbook?: string }
  | { readonly phase: "verify"; readonly check: VerifyStep }
  | { readonly phase: "rollback"; readonly command: string; readonly playbook?: string };

export type PlanContext = {
  readonly serverEnvironment: Environment;
  readonly playbooks: Readonly<Record<string, Playbook>>;
  readonly builtins?: Builtins;
};

const asVerify = (text: string): VerifyStep =>
  /^https?:\/\//.test(text)
    ? { kind: "http", url: text, expectStatus: 200, withinMs: 60_000 }
    : { kind: "command", command: text };

/** Gate GC1 et dépliage du plan en étapes. Le plan est refusé au moindre problème. */
export function expandPlan(
  plan: ChangePlan,
  context: PlanContext,
): { ok: true; steps: PlanStep[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const steps: PlanStep[] = [];
  const rollbackFromPlaybooks: PlanStep[] = [];
  if (plan.environment !== context.serverEnvironment) {
    problems.push(
      `environnement ${plan.environment} déclaré, mais le serveur est en ${context.serverEnvironment}`,
    );
  }
  plan.actions.forEach((action, index) => {
    if (action.kind === "command") {
      const c = classify(action.command);
      if (c.class === "dangerous") {
        problems.push(`action ${index + 1} dangereuse : ${c.reasons.join(", ")}`);
      }
      steps.push({ phase: "action", command: action.command });
      return;
    }
    const playbook = context.playbooks[action.name];
    if (!playbook) {
      problems.push(`action ${index + 1} : playbook inconnu « ${action.name} »`);
      return;
    }
    const rendered = renderPlaybook(action.name, playbook, action.params, context.builtins);
    if (!rendered.ok) {
      problems.push(`action ${index + 1} (${action.name}) : ${rendered.errors.join(", ")}`);
      return;
    }
    const c = classifyPlaybook(rendered.value);
    if (c.class === "dangerous") {
      problems.push(`playbook ${action.name} dangereux : ${c.reasons.join(", ")}`);
    }
    for (const command of rendered.value.steps) {
      steps.push({ phase: "action", command, playbook: action.name });
    }
    for (const check of rendered.value.verify) {
      steps.push({ phase: "verify", check });
    }
    for (const command of rendered.value.rollback) {
      rollbackFromPlaybooks.push({ phase: "rollback", command, playbook: action.name });
    }
  });
  plan.verify.forEach((text, index) => {
    const check = asVerify(text);
    if (check.kind === "command" && classify(check.command).class !== "read") {
      problems.push(`vérification ${index + 1} : seules les commandes en lecture sont permises`);
    }
    steps.push({ phase: "verify", check });
  });
  plan.rollback.forEach((command, index) => {
    if (classify(command).class === "dangerous") {
      problems.push(`retour arrière ${index + 1} dangereux`);
    }
  });
  steps.push(
    ...rollbackFromPlaybooks,
    ...plan.rollback.map((command): PlanStep => ({ phase: "rollback", command })),
  );
  return problems.length > 0 ? { ok: false, problems } : { ok: true, steps };
}

/** Une commande fait-elle partie des actions exactes d'un plan déplié ? Aucune variante n'est admise. */
export function inPlan(steps: readonly PlanStep[], command: string): boolean {
  return steps.some((s) => s.phase !== "verify" && s.command === command);
}
