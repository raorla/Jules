import { appendAudit } from "@jules/audit";
import { capabilityInputs, isCapabilityName, type CapabilityName } from "@jules/artifacts";
import { and, artifacts, desc, eq, toolCalls, type Tx } from "@jules/db";
import { decide, type Decision, type Role } from "@jules/policy";
import { enqueueEffect } from "../outbox.js";
import { Masker, truncate } from "./masking.js";

// Traitement d'un appel d'outil (ARCHITECTURE.md §7) : validation, limites, policy, audit, effet.
// Tout passe dans une transaction : l'appel journalisé, sa décision et son effet sont écrits ensemble.

export type CallContext = {
  orgId: string;
  runId: string;
  taskId: string;
  role: Role;
  stopped: boolean;
};

export type CallOutcome = { status: number; text: string; decision: Decision };

type Limit = { perRun: number; minIntervalMs?: number };

const LIMITS: Partial<Record<CapabilityName, Limit>> = {
  post_update: { perRun: 25, minIntervalMs: 15_000 },
  set_plan: { perRun: 10 },
  ask_human: { perRun: 1 },
  run_checks: { perRun: 5 },
  submit_build: { perRun: 1 },
};

const refused = (decision: Decision, status = 403): CallOutcome => ({
  status,
  decision,
  text: `Refusé par la politique du projet : ${decision.reason}. Ne réessaie pas.`,
});

async function nextVersion(tx: Tx, taskId: string, kind: string): Promise<number> {
  const [last] = await tx
    .select({ version: artifacts.version })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind)))
    .orderBy(desc(artifacts.version))
    .limit(1);
  return (last?.version ?? 0) + 1;
}

async function refreshStatus(tx: Tx, ctx: CallContext, reason: string): Promise<void> {
  await enqueueEffect(tx, {
    orgId: ctx.orgId,
    kind: "github.status_comment",
    idempotencyKey: `task:${ctx.taskId}:status:${reason}`,
    serialKey: `task:${ctx.taskId}`,
    payload: { taskId: ctx.taskId },
  });
}

type Handler = (tx: Tx, ctx: CallContext, input: never, callId: string) => Promise<string>;

const handlers: Partial<Record<CapabilityName, Handler>> = {
  post_update: async (tx, ctx, _input: { message: string }, callId) => {
    await refreshStatus(tx, ctx, `update:${callId}`);
    return "ok: mise à jour ajoutée au commentaire de statut";
  },
  set_plan: async (tx, ctx, input: { steps: string[] }, callId) => {
    const version = await nextVersion(tx, ctx.taskId, "plan");
    await tx.insert(artifacts).values({
      orgId: ctx.orgId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      kind: "plan",
      version,
      content: input,
    });
    await refreshStatus(tx, ctx, `plan:${callId}`);
    return `ok: plan v${version} publié (${input.steps.length} étapes)`;
  },
  ask_human: async (tx, ctx, input: { questions: string[] }) => {
    const version = await nextVersion(tx, ctx.taskId, "questions");
    await tx.insert(artifacts).values({
      orgId: ctx.orgId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      kind: "questions",
      version,
      content: input,
    });
    return "ok: questions enregistrées. Termine maintenant l'exécution ; elle reprendra quand l'humain aura répondu.";
  },
  run_checks: () =>
    Promise.resolve(
      "ok: les vérifications rapides ne sont pas encore disponibles ; les gates officielles tourneront sur le commit poussé.",
    ),
  submit_build: async (
    tx,
    ctx,
    input: { summary: string; commitMessage: string; testsAdded: string[] },
  ) => {
    const version = await nextVersion(tx, ctx.taskId, "build");
    await tx.insert(artifacts).values({
      orgId: ctx.orgId,
      taskId: ctx.taskId,
      runId: ctx.runId,
      kind: "build",
      version,
      content: input,
    });
    return "ok: build soumise. Termine maintenant l'exécution : Jules exporte les commits, pousse la branche et ouvre la PR.";
  },
};

/** Entrée journalisée : masquée, et réduite à un aperçu au-delà de 8 000 caractères. */
export function maskedInput(input: unknown, masker: Masker): object {
  const serialized = masker.mask(JSON.stringify(input ?? {}));
  if (serialized.length <= 8_000) {
    try {
      return JSON.parse(serialized) as object;
    } catch {
      // Un masquage a cassé le JSON : on garde le texte.
    }
  }
  return { truncated: serialized.length > 8_000, preview: truncate(serialized, 8_000) };
}

export async function handleCapability(
  tx: Tx,
  ctx: CallContext,
  name: string,
  rawInput: unknown,
  masker: Masker,
): Promise<CallOutcome> {
  const startedAt = Date.now();
  const loggedInput = maskedInput(rawInput, masker);

  const record = async (outcome: CallOutcome) => {
    const [row] = await tx
      .insert(toolCalls)
      .values({
        orgId: ctx.orgId,
        runId: ctx.runId,
        capability: name.slice(0, 100),
        input: loggedInput,
        effect: outcome.decision.effect,
        ruleId: outcome.decision.ruleId,
        reason: outcome.decision.reason,
        output: truncate(outcome.text, 2_000),
        durationMs: Date.now() - startedAt,
      })
      .returning({ id: toolCalls.id });
    await appendAudit(tx, {
      orgId: ctx.orgId,
      actor: { type: "agent", id: ctx.runId },
      action: `capability.${outcome.decision.effect}`,
      target: { type: "run", id: ctx.runId },
      data: { capability: name.slice(0, 100), ruleId: outcome.decision.ruleId },
    });
    return row?.id ?? "";
  };

  const decision = decide({
    action: "capability",
    role: ctx.role,
    capability: name,
    controls: { stopped: ctx.stopped },
  });
  if (decision.effect !== "allow" || !isCapabilityName(name)) {
    const outcome = refused(decision);
    await record(outcome);
    return outcome;
  }

  const parsed = capabilityInputs[name].safeParse(rawInput);
  if (!parsed.success) {
    const outcome: CallOutcome = {
      status: 400,
      decision: { effect: "deny", ruleId: "input.invalid", reason: "entrée invalide" },
      text: `Entrée invalide, corrige-la et réessaie : ${parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; ")}`,
    };
    await record(outcome);
    return outcome;
  }

  const limit = LIMITS[name];
  if (limit) {
    const previous = await tx
      .select({ createdAt: toolCalls.createdAt })
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, ctx.runId),
          eq(toolCalls.capability, name),
          eq(toolCalls.effect, "allow"),
        ),
      )
      .orderBy(desc(toolCalls.createdAt));
    const last = previous[0];
    const tooSoon =
      limit.minIntervalMs !== undefined &&
      last !== undefined &&
      Date.now() - last.createdAt.getTime() < limit.minIntervalMs;
    if (previous.length >= limit.perRun || tooSoon) {
      const outcome = refused(
        {
          effect: "deny",
          ruleId: "limit.rate",
          reason: tooSoon
            ? `${name} : attends ${Math.ceil((limit.minIntervalMs ?? 0) / 1000)} s entre deux appels`
            : `${name} : ${limit.perRun} appel(s) par exécution au maximum`,
        },
        429,
      );
      await record(outcome);
      return outcome;
    }
  }

  // L'identifiant de l'appel sert de clé d'idempotence aux effets qu'il déclenche.
  const callId = await record({ status: 200, decision, text: "" });
  const handler = handlers[name];
  const text = handler ? await handler(tx, ctx, parsed.data as never, callId) : "ok";
  await tx
    .update(toolCalls)
    .set({ output: truncate(text, 2_000), durationMs: Date.now() - startedAt })
    .where(eq(toolCalls.id, callId));
  return { status: 200, decision, text };
}
