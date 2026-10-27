import { chmod, rm } from "node:fs/promises";
import { and, eq, gt, isNull, runs, sql, tasks, type Db } from "@jules/db";
import type { Role } from "@jules/policy";
import Fastify from "fastify";
import type { Logger } from "pino";
import { isStopped } from "../controls.js";
import { handleCapability } from "./capabilities.js";
import type { Masker } from "./masking.js";
import { anthropicError, forwardToModel } from "./model-proxy.js";
import { bearer, hashRunToken } from "./tokens.js";

// Broker d'une exécution (ARCHITECTURE.md §4.3). Il écoute sur un socket Unix propre à l'exécution,
// monté dans son sandbox : seul ce sandbox peut le joindre, et seul son jeton y est accepté.

export type BrokerDeps = {
  db: Db;
  log: Logger;
  masker: Masker;
  model: { upstream: string; apiKey: string; fetchImpl?: typeof fetch };
  /** Appelé quand le budget de l'exécution est atteint : le worker tue le sandbox. */
  onBudgetExceeded: (runId: string) => void;
  /** Appelé après plusieurs erreurs consécutives du fournisseur : la tâche passera en `waiting_provider`. */
  onProviderOutage?: (runId: string) => void;
};

/** Erreurs consécutives du fournisseur au-delà desquelles l'exécution est suspendue (§17). */
export const PROVIDER_OUTAGE_THRESHOLD = 3;

export type Broker = { close(): Promise<void> };

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function authenticate(db: Db, runId: string, header: string | undefined) {
  const token = bearer(header);
  if (!token) {
    return undefined;
  }
  const [row] = await db
    .select({ run: runs, task: tasks })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(runs.id, runId),
        eq(runs.tokenHash, hashRunToken(token)),
        isNull(runs.revokedAt),
        gt(runs.tokenExpiresAt, sql`now()`),
      ),
    );
  return row;
}

export async function startBroker(
  deps: BrokerDeps,
  options: { runId: string; socketPath: string },
): Promise<Broker> {
  const { db, log } = deps;
  let consecutiveProviderErrors = 0;
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post<{ Params: { name: string } }>("/capabilities/:name", async (request, reply) => {
    const auth = await authenticate(db, options.runId, request.headers.authorization);
    if (!auth) {
      return reply
        .code(401)
        .type("text/plain")
        .send("Jeton d'exécution invalide, expiré ou révoqué.");
    }
    let input: unknown = {};
    const raw = request.body as Buffer | undefined;
    if (raw && raw.length > 0) {
      try {
        input = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).type("text/plain").send("Entrée invalide : JSON attendu.");
      }
    }
    const stopped = await isStopped(db, auth.run.orgId, { repoId: auth.task.repoId });
    const outcome = await db.transaction((tx) =>
      handleCapability(
        tx,
        {
          orgId: auth.run.orgId,
          runId: auth.run.id,
          taskId: auth.task.id,
          role: auth.run.role as Role,
          stopped,
        },
        request.params.name,
        input,
        deps.masker,
      ),
    );
    log.info(
      {
        runId: auth.run.id,
        capability: request.params.name,
        effect: outcome.decision.effect,
        ruleId: outcome.decision.ruleId,
      },
      "appel d'outil",
    );
    return reply.code(outcome.status).type("text/plain").send(outcome.text);
  });

  app.all("/model/*", async (request, reply) => {
    const auth = await authenticate(db, options.runId, request.headers.authorization);
    const refuse = (status: number, type: string, message: string) => {
      const error = anthropicError(status, type, message);
      return reply.code(error.status).type("application/json").send(error.body);
    };
    if (!auth) {
      return refuse(401, "authentication_error", "jeton d'exécution invalide, expiré ou révoqué");
    }
    if (await isStopped(db, auth.run.orgId, { repoId: auth.task.repoId })) {
      return refuse(403, "permission_error", "arrêt d'urgence actif");
    }
    if (Number(auth.run.costUsd) >= Number(auth.run.budgetUsd)) {
      deps.onBudgetExceeded(auth.run.id);
      return refuse(400, "invalid_request_error", "budget de l'exécution atteint");
    }

    reply.hijack();
    // Compté avant de fermer la réponse : la requête suivante voit déjà le coût de celle-ci.
    const accounting = await forwardToModel(
      { ...deps.model, masker: deps.masker },
      {
        method: request.method,
        path: request.url.replace(/^\/model/, "") || "/",
        headers: request.headers,
        body: request.body as Buffer | undefined,
      },
      reply.raw,
    );
    const [updated] = await db
      .update(runs)
      .set({
        inputTokens: sql`${runs.inputTokens} + ${accounting.usage.inputTokens}`,
        outputTokens: sql`${runs.outputTokens} + ${accounting.usage.outputTokens}`,
        cacheReadTokens: sql`${runs.cacheReadTokens} + ${accounting.usage.cacheReadTokens}`,
        cacheWriteTokens: sql`${runs.cacheWriteTokens} + ${accounting.usage.cacheWriteTokens}`,
        costUsd: sql`${runs.costUsd} + ${accounting.costUsd.toFixed(6)}`,
        modelRequests: sql`${runs.modelRequests} + 1`,
        providerErrors: accounting.providerError
          ? sql`${runs.providerErrors} + 1`
          : runs.providerErrors,
      })
      .where(eq(runs.id, auth.run.id))
      .returning({ costUsd: runs.costUsd, budgetUsd: runs.budgetUsd });
    log.debug(
      {
        runId: auth.run.id,
        model: accounting.model,
        status: accounting.status,
        costUsd: accounting.costUsd,
      },
      "appel modèle",
    );
    if (updated && Number(updated.costUsd) >= Number(updated.budgetUsd)) {
      deps.onBudgetExceeded(auth.run.id);
    }
    consecutiveProviderErrors = accounting.providerError ? consecutiveProviderErrors + 1 : 0;
    if (consecutiveProviderErrors >= PROVIDER_OUTAGE_THRESHOLD) {
      log.warn(
        { runId: auth.run.id, consecutiveProviderErrors },
        "fournisseur de modèle indisponible",
      );
      deps.onProviderOutage?.(auth.run.id);
    }
    reply.raw.end();
  });

  await rm(options.socketPath, { force: true });
  await app.listen({ path: options.socketPath });
  await chmod(options.socketPath, 0o660);
  return {
    async close() {
      await app.close();
      await rm(options.socketPath, { force: true });
    },
  };
}
