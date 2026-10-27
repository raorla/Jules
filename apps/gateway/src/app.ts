import { DEFAULT_ORG_ID, eq, events, installations, sql, type Db } from "@jules/db";
import { verifyWebhookSignature } from "@jules/forge/webhooks";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

// Le gateway reçoit les webhooks GitHub, vérifie leur signature, les déduplique, les stocke
// et répond. Il ne fait rien d'autre et ne détient que le secret de webhook (ARCHITECTURE.md §4.1).

export type GatewayOptions = {
  db: Db;
  webhookSecret: string;
  logger?: FastifyServerOptions["logger"];
};

/** GitHub plafonne la taille d'un payload à 25 Mo. */
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

async function resolveOrg(db: Db, installationId: number | null): Promise<string> {
  if (installationId === null) {
    return DEFAULT_ORG_ID;
  }
  const [row] = await db
    .select({ orgId: installations.orgId })
    .from(installations)
    .where(eq(installations.githubInstallationId, installationId));
  return row?.orgId ?? DEFAULT_ORG_ID;
}

export function buildGateway(options: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_PAYLOAD_BYTES });
  const { db, webhookSecret } = options;

  app.get("/healthz", () => ({ ok: true }));
  app.get("/readyz", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  void app.register((scope, _opts, done) => {
    // Corps brut : la signature porte sur les octets reçus, pas sur un JSON re-sérialisé.
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, next) => {
      next(null, body);
    });

    scope.post("/webhooks/github", async (request, reply) => {
      const raw = request.body as Buffer;
      const deliveryId = header(request.headers["x-github-delivery"]);
      const event = header(request.headers["x-github-event"]);

      if (
        !verifyWebhookSignature(webhookSecret, raw, header(request.headers["x-hub-signature-256"]))
      ) {
        request.log.warn({ deliveryId }, "webhook refusé : signature invalide");
        return reply.code(401).send({ error: "signature invalide" });
      }
      if (!deliveryId || !DELIVERY_ID.test(deliveryId) || !event || !EVENT_NAME.test(event)) {
        return reply.code(400).send({ error: "en-têtes GitHub manquants ou invalides" });
      }

      let payload: { action?: unknown; installation?: { id?: unknown } };
      try {
        payload = JSON.parse(raw.toString("utf8")) as typeof payload;
      } catch {
        return reply.code(400).send({ error: "JSON invalide" });
      }
      const installationId =
        typeof payload.installation?.id === "number" ? payload.installation.id : null;

      const inserted = await db
        .insert(events)
        .values({
          orgId: await resolveOrg(db, installationId),
          deliveryId,
          event,
          action: typeof payload.action === "string" ? payload.action : null,
          githubInstallationId: installationId,
          payload,
        })
        .onConflictDoNothing({ target: events.deliveryId })
        .returning({ id: events.id });

      if (inserted.length === 0) {
        // Livraison déjà reçue : rejeu ou relivraison en double. Rien n'est retraité.
        request.log.info({ deliveryId, event }, "webhook déjà reçu, ignoré");
        return reply.code(200).send({ status: "duplicate" });
      }
      request.log.info({ deliveryId, event }, "webhook enregistré");
      return reply.code(202).send({ status: "accepted" });
    });
    done();
  });

  return app;
}
