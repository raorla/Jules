import { appendAudit } from "@jules/audit";
import {
  capabilityInputs,
  checkDesign,
  checkSpec,
  isCapabilityName,
  type CapabilityName,
  type Design,
  type Spec,
} from "@jules/artifacts";
import { and, artifacts, desc, eq, lessons, tasks, toolCalls, type Tx } from "@jules/db";
import { decide, type Decision, type Role } from "@jules/policy";
import { enqueueEffect } from "../outbox.js";
import { Masker, truncate } from "./masking.js";
import {
  auditImage,
  auditPlatform,
  auditRepo,
  auditServer,
  proposeRemediation,
  reportFinding,
  type SecurityTools,
} from "./security-tools.js";
import {
  serverCrontabRead,
  serverExec,
  serverGit,
  serverPublishFile,
  serverRunPlaybook,
  submitChangePlan,
  type DevopsTools,
  type ToolResult,
} from "./server-tools.js";

// Traitement d'un appel d'outil (ARCHITECTURE.md §7) : validation, limites, policy, audit, effet.
// Tout passe dans une transaction : l'appel journalisé, sa décision et son effet sont écrits ensemble.

export type CallContext = {
  orgId: string;
  runId: string;
  taskId: string;
  role: Role;
  stopped: boolean;
  /** Outils serveur de l'agent DevOps : absents pour les autres rôles. */
  devops?: DevopsTools;
  /** Audits et findings de l'agent Sécurité. */
  security?: SecurityTools;
};

export type CallOutcome = {
  status: number;
  text: string;
  decision: Decision;
  /** Travail à faire après la transaction (commande SSH) ; son texte devient la réponse. */
  after?: () => Promise<string>;
  callId?: string;
};

type Limit = { perRun: number; minIntervalMs?: number };

const LIMITS: Partial<Record<CapabilityName, Limit>> = {
  post_update: { perRun: 25, minIntervalMs: 15_000 },
  set_plan: { perRun: 10 },
  ask_human: { perRun: 1 },
  run_checks: { perRun: 5 },
  submit_build: { perRun: 1 },
  submit_triage: { perRun: 1 },
  submit_spec: { perRun: 1 },
  submit_design: { perRun: 1 },
  submit_review: { perRun: 1 },
  propose_lessons: { perRun: 1 },
  server_exec: { perRun: 40 },
  server_crontab_read: { perRun: 10 },
  server_git: { perRun: 10 },
  server_run_playbook: { perRun: 5 },
  submit_change_plan: { perRun: 1 },
  audit_repo: { perRun: 3 },
  audit_server: { perRun: 10 },
  audit_platform: { perRun: 2 },
  report_finding: { perRun: 50 },
  propose_remediation: { perRun: 5 },
};

async function latest<T>(tx: Tx, taskId: string, kind: string): Promise<T | undefined> {
  const [row] = await tx
    .select({ content: artifacts.content })
    .from(artifacts)
    .where(and(eq(artifacts.taskId, taskId), eq(artifacts.kind, kind)))
    .orderBy(desc(artifacts.version))
    .limit(1);
  return row?.content as T | undefined;
}

/** Gates automatiques G2 et G3 (WORKFLOW.md §5) : vérifiées avant d'accepter l'artefact. */
const VALIDATORS: Partial<
  Record<
    CapabilityName,
    (tx: Tx, ctx: CallContext, input: never) => Promise<{ gate: string; problems: string[] }>
  >
> = {
  submit_spec: async (tx, ctx, input: Spec) => {
    const [task] = await tx
      .select({ type: tasks.type })
      .from(tasks)
      .where(eq(tasks.id, ctx.taskId));
    return {
      gate: "G2",
      problems: checkSpec(input, task?.type as Parameters<typeof checkSpec>[1]),
    };
  },
  submit_design: async (tx, ctx, input: Design) => ({
    gate: "G3",
    problems: checkDesign(input, await latest<Spec>(tx, ctx.taskId, "spec")),
  }),
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

type Handler = (
  tx: Tx,
  ctx: CallContext,
  input: never,
  callId: string,
) => Promise<string | ToolResult> | ToolResult;

async function storeArtifact(
  tx: Tx,
  ctx: CallContext,
  kind: string,
  content: object,
): Promise<number> {
  const version = await nextVersion(tx, ctx.taskId, kind);
  await tx
    .insert(artifacts)
    .values({ orgId: ctx.orgId, taskId: ctx.taskId, runId: ctx.runId, kind, version, content });
  return version;
}

const handlers: Partial<Record<CapabilityName, Handler>> = {
  server_exec: (tx, ctx, input: { server: string; command: string }) =>
    serverExec(tx, { ...ctx, readOnly: ctx.role === "security" }, input),
  audit_repo: (tx, ctx) => auditRepo(tx, ctx),
  audit_server: (tx, ctx, input: { server: string }) => auditServer(tx, ctx, input),
  audit_platform: (_tx, ctx) => auditPlatform(ctx),
  audit_image: () => auditImage(),
  report_finding: (tx, ctx, input: Parameters<typeof reportFinding>[2]) =>
    reportFinding(tx, ctx, input),
  propose_remediation: (tx, ctx, input: Parameters<typeof proposeRemediation>[2]) =>
    proposeRemediation(tx, ctx, input),
  server_crontab_read: (tx, ctx, input: { server: string }) => serverCrontabRead(tx, ctx, input),
  server_git: (
    tx,
    ctx,
    input: { server: string; operation: "pull" | "fetch" | "clone"; path: string; url?: string },
  ) => serverGit(tx, ctx, input),
  server_run_playbook: (
    tx,
    ctx,
    input: { server: string; name: string; params: Record<string, string> },
  ) => serverRunPlaybook(tx, ctx, input),
  server_publish_file: () => serverPublishFile(),
  submit_change_plan: (tx, ctx, input: Parameters<typeof submitChangePlan>[2]) =>
    submitChangePlan(tx, ctx, input, (content) => storeArtifact(tx, ctx, "change_plan", content)),
  submit_triage: async (tx, ctx, input: object) => {
    const version = await storeArtifact(tx, ctx, "triage", input);
    return `ok: triage v${version} enregistré. Termine maintenant l'exécution.`;
  },
  submit_spec: async (tx, ctx, input: object) => {
    const version = await storeArtifact(tx, ctx, "spec", input);
    return `ok: spec v${version} enregistrée (gate G2 passée). Termine maintenant l'exécution.`;
  },
  propose_lessons: async (tx, ctx, input: { lessons: { text: string; source: string }[] }) => {
    await storeArtifact(tx, ctx, "lessons", input);
    const [task] = await tx
      .select({ repoId: tasks.repoId })
      .from(tasks)
      .where(eq(tasks.id, ctx.taskId));
    if (task && input.lessons.length > 0) {
      await tx.insert(lessons).values(
        input.lessons.map((l) => ({
          orgId: ctx.orgId,
          repoId: task.repoId,
          taskId: ctx.taskId,
          text: l.text,
          source: l.source,
        })),
      );
    }
    return `ok: ${input.lessons.length} leçon(s) proposée(s). Termine maintenant l'exécution.`;
  },
  submit_review: async (tx, ctx, input: object) => {
    const version = await storeArtifact(tx, ctx, "review", input);
    return `ok: review v${version} enregistrée. Termine maintenant l'exécution.`;
  },
  submit_design: async (tx, ctx, input: object) => {
    const version = await storeArtifact(tx, ctx, "design", input);
    return `ok: conception v${version} enregistrée (gate G3 passée). Termine maintenant l'exécution.`;
  },
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
        // La sortie est montrée dans l'interface (transcription) : masquée comme l'entrée.
        output: truncate(masker.mask(outcome.text), 2_000),
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

  const validator = VALIDATORS[name];
  if (validator) {
    const { gate, problems } = await validator(tx, ctx, parsed.data as never);
    if (problems.length > 0) {
      const outcome: CallOutcome = {
        status: 400,
        decision: { effect: "deny", ruleId: `gate.${gate}`, reason: `gate ${gate} non satisfaite` },
        text: `Gate ${gate} non satisfaite, corrige et soumets à nouveau : ${problems.join(" ; ")}`,
      };
      await record(outcome);
      return outcome;
    }
  }

  // L'identifiant de l'appel sert de clé d'idempotence aux effets qu'il déclenche.
  const callId = await record({ status: 200, decision, text: "" });
  const handler = handlers[name];
  const result = handler ? await handler(tx, ctx, parsed.data as never, callId) : "ok";
  const { text, status = 200, after } = typeof result === "string" ? { text: result } : result;
  await tx
    .update(toolCalls)
    .set({ output: truncate(masker.mask(text), 2_000), durationMs: Date.now() - startedAt })
    .where(eq(toolCalls.id, callId));
  return { status, decision, text, ...(after ? { after, callId } : {}) };
}
