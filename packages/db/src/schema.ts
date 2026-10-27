import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Tables du noyau créées en M0 (ARCHITECTURE.md §14). Les autres arrivent avec leur jalon.
// Chaque table porte un org_id (ADR 0013), même tant qu'il n'y a qu'une organisation.

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const orgId = () =>
  uuid("org_id")
    .notNull()
    .references(() => orgs.id);

export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

/** Personnes et bots vus par Jules. Les données personnelles vivent ici, jamais dans l'audit (§18). */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    githubUserId: bigint("github_user_id", { mode: "number" }),
    login: text("login").notNull(),
    kind: text("kind", { enum: ["human", "bot"] }).notNull(),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_org_github_user_idx").on(t.orgId, t.githubUserId)],
);

export const installations = pgTable("installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  githubInstallationId: bigint("github_installation_id", { mode: "number" }).notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    forge: text("forge", { enum: ["github", "local"] }).notNull(),
    installationId: uuid("installation_id").references(() => installations.id),
    githubRepoId: bigint("github_repo_id", { mode: "number" }),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch"),
    private: boolean("private").notNull(),
    /** Autonomie fixée par l'admin (WORKFLOW.md §3) ; L0 tant que rien n'est promu. */
    autonomy: text("autonomy", { enum: ["L0", "L1", "L2"] })
      .notNull()
      .default("L0"),
    configSha: text("config_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repos_forge_github_repo_idx").on(t.forge, t.githubRepoId)],
);

/** Webhooks bruts dédupliqués par X-GitHub-Delivery. Le payload est purgé après 30 jours, l'identifiant reste. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    deliveryId: text("delivery_id").notNull().unique(),
    event: text("event").notNull(),
    action: text("action"),
    githubInstallationId: bigint("github_installation_id", { mode: "number" }),
    payload: jsonb("payload"),
    status: text("status", { enum: ["received", "processing", "processed", "ignored", "failed"] })
      .notNull()
      .default("received"),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [index("events_status_received_idx").on(t.status, t.receivedAt)],
);

export const TASK_STATES = [
  "received",
  "triaging",
  "awaiting_info",
  "specifying",
  "awaiting_spec_approval",
  "designing",
  "awaiting_design_approval",
  "building",
  "verifying",
  "reviewing",
  "awaiting_human_review",
  "learning",
  "done",
  "waiting_provider",
  "blocked",
  "cancelled",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id),
    agent: text("agent", { enum: ["developer", "devops", "security"] }).notNull(),
    state: text("state", { enum: TASK_STATES }).notNull().default("received"),
    /** Transitions optimistes (ARCHITECTURE.md §4.3). */
    version: integer("version").notNull().default(0),
    issueNumber: integer("issue_number"),
    title: text("title").notNull(),
    request: text("request").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    sourceEventId: uuid("source_event_id")
      .unique()
      .references(() => events.id),
    statusCommentId: bigint("status_comment_id", { mode: "number" }),
    type: text("type"),
    size: text("size"),
    risk: text("risk", { enum: ["low", "medium", "high"] }),
    iterations: integer("iterations").notNull().default(0),
    reviewRounds: integer("review_rounds").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    branch: text("branch"),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    prNumber: integer("pr_number"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }),
    /** En `waiting_provider` : date de la prochaine tentative (ARCHITECTURE.md §17). */
    resumeAfter: timestamp("resume_after", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Une seule tâche active par issue.
    uniqueIndex("tasks_active_issue_idx")
      .on(t.repoId, t.issueNumber)
      .where(sql`${t.state} not in ('done', 'cancelled')`),
  ],
);

/**
 * Effets à produire (§17) : écrits dans la même transaction que le changement d'état,
 * puis exécutés par le worker. La clé d'idempotence empêche tout doublon.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** Les effets d'une même clé (une tâche, par exemple) s'exécutent un par un, dans l'ordre. */
    serialKey: text("serial_key"),
    payload: jsonb("payload").notNull(),
    status: text("status", { enum: ["pending", "running", "done", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    result: jsonb("result"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    doneAt: timestamp("done_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_status_run_after_idx").on(t.status, t.runAfter),
    index("outbox_serial_key_idx").on(t.serialKey, t.createdAt),
  ],
);

/** Livraisons redemandées à GitHub par la réconciliation (§17, webhooks manqués). */
export const webhookRedeliveries = pgTable("webhook_redeliveries", {
  deliveryGuid: text("delivery_guid").primaryKey(),
  orgId: orgId(),
  githubDeliveryId: bigint("github_delivery_id", { mode: "number" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

/**
 * Journal append-only et chaîné : chaque ligne contient le hash de la précédente (packages/audit).
 * Un trigger refuse UPDATE, DELETE et TRUNCATE. Uniquement des identifiants internes (§18).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: orgId(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    data: jsonb("data").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [uniqueIndex("audit_log_org_seq_idx").on(t.orgId, t.seq)],
);

/** Secrets chiffrés par enveloppe (packages/secrets). La clé maître n'est jamais en base. */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    name: text("name").notNull(),
    kekId: text("kek_id").notNull(),
    wrappedDek: text("wrapped_dek").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("secrets_org_name_idx").on(t.orgId, t.name)],
);

export const RUN_STATUSES = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "budget_exceeded",
  "stopped",
  "provider_unavailable",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Une exécution d'agent dans un sandbox. Le jeton d'exécution n'est stocké que haché. */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    role: text("role").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("starting"),
    tokenHash: text("token_hash").notNull().unique(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    containerId: text("container_id"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }).notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheWriteTokens: bigint("cache_write_tokens", { mode: "number" }).notNull().default(0),
    modelRequests: integer("model_requests").notNull().default(0),
    providerErrors: integer("provider_errors").notNull().default(0),
    result: jsonb("result"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("runs_task_idx").on(t.taskId, t.createdAt)],
);

/** Appels d'outils `jules` : entrée masquée et tronquée, décision de la policy, durée. */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id),
    capability: text("capability").notNull(),
    input: jsonb("input").notNull(),
    effect: text("effect", { enum: ["allow", "deny", "require_approval"] }).notNull(),
    ruleId: text("rule_id").notNull(),
    reason: text("reason").notNull(),
    output: text("output"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("tool_calls_run_idx").on(t.runId, t.capability)],
);

/** Artefacts typés de chaque phase (WORKFLOW.md §6), versionnés. */
export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    runId: uuid("run_id").references(() => runs.id),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    content: jsonb("content").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("artifacts_task_kind_version_idx").on(t.taskId, t.kind, t.version)],
);

/** Arrêts d'urgence (§17) : actifs tant que `lifted_at` est vide. */
export const stops = pgTable(
  "stops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    scope: text("scope", { enum: ["global", "repo", "server"] }).notNull(),
    targetId: text("target_id"),
    reason: text("reason").notNull(),
    setBy: text("set_by").notNull(),
    setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: text("lifted_by"),
  },
  (t) => [
    index("stops_active_idx")
      .on(t.orgId, t.scope)
      .where(sql`${t.liftedAt} is null`),
  ],
);
