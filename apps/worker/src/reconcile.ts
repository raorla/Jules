import {
  DEFAULT_ORG_ID,
  events,
  inArray,
  installations,
  sql,
  webhookRedeliveries,
} from "@jules/db";
import type { HookDelivery } from "@jules/forge";
import type { WorkerDeps } from "./deps.js";

// Webhooks manqués (ARCHITECTURE.md §17) : GitHub ne relivre jamais seul une livraison échouée.
// On parcourt l'historique des livraisons de l'App et on redemande chaque livraison dont
// l'identifiant n'est pas dans `events`. C'est la base qui fait foi, pas le statut affiché par
// GitHub : une restauration depuis une sauvegarde rattrape aussi les événements perdus depuis.

/** GitHub ne garde l'historique des livraisons, et n'accepte de relivrer, que 3 jours. */
export const GITHUB_DELIVERY_RETENTION_MS = 3 * 24 * 3600 * 1000;

export type ReconcileOptions = {
  /** Jusqu'où remonter dans l'historique. */
  lookbackMs: number;
  /**
   * Une livraison réussie mais absente de la base, plus récente que ce délai, est peut-être en
   * cours d'écriture. Une livraison en échec n'est jamais en cours : elle est redemandée tout de suite.
   */
  graceMs?: number;
  /** Délai avant de redemander une livraison déjà redemandée. */
  retryAfterMs?: number;
  maxAttempts?: number;
  now?: Date;
};

export type ReconcileReport = {
  scanned: number;
  missing: number;
  redelivered: number;
  gaveUp: number;
};

export async function reconcileDeliveries(
  deps: WorkerDeps,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  const now = options.now ?? new Date();
  const since = now.getTime() - Math.min(options.lookbackMs, GITHUB_DELIVERY_RETENTION_MS);
  const graceMs = options.graceMs ?? 60_000;
  const retryAfterMs = options.retryAfterMs ?? 10 * 60_000;
  const maxAttempts = options.maxAttempts ?? 3;

  // Livraison la plus récente de chaque GUID (une relivraison garde le GUID d'origine).
  const latest = new Map<string, HookDelivery>();
  let scanned = 0;
  for await (const delivery of deps.github.listDeliveries()) {
    if (delivery.deliveredAt.getTime() < since) {
      break;
    }
    scanned += 1;
    if (!latest.has(delivery.guid)) {
      latest.set(delivery.guid, delivery);
    }
  }

  const report: ReconcileReport = { scanned, missing: 0, redelivered: 0, gaveUp: 0 };
  const guids = [...latest.keys()];
  if (guids.length === 0) {
    return report;
  }

  const received = new Set<string>();
  const attempts = new Map<string, { attempts: number; lastAttemptAt: Date }>();
  for (let i = 0; i < guids.length; i += 500) {
    const chunk = guids.slice(i, i + 500);
    const rows = await deps.db
      .select({ deliveryId: events.deliveryId })
      .from(events)
      .where(inArray(events.deliveryId, chunk));
    rows.forEach((r) => received.add(r.deliveryId));
    const tried = await deps.db
      .select()
      .from(webhookRedeliveries)
      .where(inArray(webhookRedeliveries.deliveryGuid, chunk));
    tried.forEach((r) => attempts.set(r.deliveryGuid, r));
  }

  const orgByInstallation = new Map(
    (
      await deps.db
        .select({ id: installations.githubInstallationId, orgId: installations.orgId })
        .from(installations)
    ).map((r) => [r.id, r.orgId]),
  );

  for (const [guid, delivery] of latest) {
    const succeeded = delivery.statusCode >= 200 && delivery.statusCode < 300;
    if (
      received.has(guid) ||
      (succeeded && now.getTime() - delivery.deliveredAt.getTime() < graceMs)
    ) {
      continue;
    }
    report.missing += 1;
    const previous = attempts.get(guid);
    if (previous && previous.attempts >= maxAttempts) {
      report.gaveUp += 1;
      continue;
    }
    if (previous && now.getTime() - previous.lastAttemptAt.getTime() < retryAfterMs) {
      continue;
    }

    const log = deps.log.child({
      deliveryGuid: guid,
      githubDeliveryId: delivery.id,
      event: delivery.event,
    });
    try {
      await deps.github.redeliver(delivery.id);
      report.redelivered += 1;
      log.info({ statusCode: delivery.statusCode }, "livraison manquée redemandée à GitHub");
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "relivraison refusée",
      );
    }
    await deps.db
      .insert(webhookRedeliveries)
      .values({
        deliveryGuid: guid,
        orgId:
          (delivery.installationId !== null
            ? orgByInstallation.get(delivery.installationId)
            : undefined) ?? DEFAULT_ORG_ID,
        githubDeliveryId: delivery.id,
        attempts: 1,
        lastAttemptAt: now,
      })
      .onConflictDoUpdate({
        target: webhookRedeliveries.deliveryGuid,
        set: {
          githubDeliveryId: delivery.id,
          attempts: sql`${webhookRedeliveries.attempts} + 1`,
          lastAttemptAt: now,
        },
      });
  }

  return report;
}
