// Findings (WORKFLOW.md §13) : un problème de sécurité sur une cible (repo, serveur, plateforme),
// avec son cycle de vie. Fonctions pures : le worker les applique en base.

export type Severity = "critical" | "high" | "medium" | "low";
export type FindingStatus =
  "open" | "triaged" | "in_remediation" | "resolved" | "accepted_risk" | "false_positive";
export type Scope = "repo" | "server" | "platform" | "image";
export type Category = "dependency" | "secret" | "code" | "config" | "server" | "platform";

export type FindingInput = {
  readonly scope: Scope;
  readonly targetId: string;
  readonly category: Category;
  /** Ce qui est touché : paquet et version, chemin (et ligne), service, réglage. */
  readonly component: string;
  readonly title: string;
  readonly severity: Severity;
  /** Scanner qui l'a produit (`osv`, `secrets`, `infra`, `server-audit`, `platform-audit`, `agent`). */
  readonly scanner: string;
  /** Preuve courte, sans valeur secrète. */
  readonly evidence: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const DAY = 86_400_000;
/** Échéances de correction par défaut (WORKFLOW.md §13.2). */
export const DUE_DAYS: Record<Severity, number | null> = {
  critical: 7,
  high: 30,
  medium: 90,
  low: null,
};

export function dueDate(severity: Severity, from: Date): Date | null {
  const days = DUE_DAYS[severity];
  return days === null ? null : new Date(from.getTime() + days * DAY);
}

/** Clé de déduplication : même catégorie, même composant, même titre (ARCHITECTURE.md §7). */
export function findingKey(
  f: Pick<FindingInput, "scope" | "targetId" | "category" | "component" | "title">,
): string {
  return [f.scope, f.targetId, f.category, f.component, f.title]
    .map((p) => p.trim().toLowerCase())
    .join("|");
}

/** Un finding qui compte : ni accepté, ni faux positif, ni résolu. */
export function isActive(status: FindingStatus): boolean {
  return status === "open" || status === "triaged" || status === "in_remediation";
}

/** Un finding critique ou haut actif bloque les playbooks `deploy*` de sa cible (WORKFLOW.md §13.2). */
export function blocksDeploy(f: { severity: Severity; status: FindingStatus }): boolean {
  return isActive(f.status) && (f.severity === "critical" || f.severity === "high");
}

export type FindingEvent =
  | { type: "triaged" }
  | { type: "remediation_started" }
  | { type: "absent_from_audit" }
  | { type: "seen_again" }
  | { type: "accept_risk" }
  | { type: "false_positive" }
  | { type: "risk_expired" }
  | { type: "reopen" };

/** Cycle de vie (WORKFLOW.md §13.2). Les décisions humaines sont vérifiées ailleurs (rôle, passkey). */
export function findingTransition(
  status: FindingStatus,
  event: FindingEvent,
): { ok: true; next: FindingStatus } | { ok: false; reason: string } {
  const to = (next: FindingStatus) => ({ ok: true as const, next });
  switch (event.type) {
    case "triaged":
      return status === "open" ? to("triaged") : refuse(status, event);
    case "remediation_started":
      return status === "open" || status === "triaged"
        ? to("in_remediation")
        : refuse(status, event);
    case "absent_from_audit":
      // Seul un nouvel audit qui ne le retrouve plus le résout ; un faux positif reste une décision.
      return isActive(status) || status === "accepted_risk"
        ? to("resolved")
        : refuse(status, event);
    case "seen_again":
      return status === "resolved" ? to("open") : refuse(status, event);
    case "accept_risk":
    case "false_positive":
      return status === "open" || status === "triaged"
        ? to(event.type === "accept_risk" ? "accepted_risk" : "false_positive")
        : refuse(status, event);
    case "risk_expired":
      return status === "accepted_risk" ? to("open") : refuse(status, event);
    case "reopen":
      return status === "false_positive" || status === "accepted_risk"
        ? to("open")
        : refuse(status, event);
  }
}

function refuse(status: FindingStatus, event: FindingEvent) {
  return { ok: false as const, reason: `${event.type} impossible depuis ${status}` };
}

export type Existing = {
  readonly id: string;
  readonly key: string;
  readonly status: FindingStatus;
  readonly scanner: string;
};

export type Reconciliation = {
  create: FindingInput[];
  /** Retrouvés : mis à jour (dernière vue, preuve) sans changer leur statut. */
  seen: { id: string; input: FindingInput }[];
  reopen: { id: string; input: FindingInput }[];
  resolve: string[];
};

/**
 * Compare un audit aux findings connus de sa cible. Seuls les scanners que l'audit a fait tourner
 * peuvent résoudre un finding : un audit partiel ne résout pas ce qu'il n'a pas regardé.
 */
export function reconcile(
  existing: readonly Existing[],
  results: readonly FindingInput[],
  scanners: readonly string[],
): Reconciliation {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const found = new Set<string>();
  const out: Reconciliation = { create: [], seen: [], reopen: [], resolve: [] };
  for (const input of results) {
    const key = findingKey(input);
    if (found.has(key)) {
      continue;
    }
    found.add(key);
    const known = byKey.get(key);
    if (!known) {
      out.create.push(input);
    } else if (known.status === "resolved") {
      out.reopen.push({ id: known.id, input });
    } else {
      out.seen.push({ id: known.id, input });
    }
  }
  for (const e of existing) {
    if (
      !found.has(e.key) &&
      scanners.includes(e.scanner) &&
      findingTransition(e.status, { type: "absent_from_audit" }).ok
    ) {
      out.resolve.push(e.id);
    }
  }
  return out;
}
