import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { Link, useParams } from "@tanstack/react-router";
import { Fingerprint, Rocket, Server as ServerIcon, Snowflake, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  type Deployment,
  type Dora,
  type Me,
  type Plan,
  type Server,
  type ServerCommand,
} from "./api.js";
import {
  Card,
  Chip,
  EmptyState,
  EnvChip,
  Kpi,
  useSensitiveAction,
  type Tone,
} from "./components.js";

// Écrans DevOps (M7, DESIGN.md §6) : serveurs, plans de changement, déploiements. L'environnement est
// visible sur chaque action serveur ; aucune approbation de production ne se donne sans passkey.

const HOST_KEY_TONE: Record<Server["hostKeyStatus"], Tone> = {
  pending: "info",
  awaiting_validation: "warn",
  trusted: "ok",
  changed: "crit",
  unreachable: "crit",
};
const CLASS_TONE: Record<ServerCommand["commandClass"], Tone> = {
  read: "neutral",
  change: "warn",
  dangerous: "crit",
};
const STATUS_TONE = (status: string): Tone =>
  ["succeeded", "done", "approved"].includes(status)
    ? "ok"
    : ["failed", "rolled_back", "interrupted", "blocked", "rejected", "expired"].includes(status)
      ? "crit"
      : ["pending_approval", "waiting_ci"].includes(status)
        ? "warn"
        : status === "running"
          ? "info"
          : "neutral";

/** Un plan à approuver : environnement, serveur, actions exactes, impact, vérification, retour arrière. */
export function PlanCard({
  plan,
  actionable = true,
  highlighted = false,
}: {
  plan: Plan;
  actionable?: boolean;
  /** Ouvert depuis une notification : le plan est mis en vue, le bouton d'approbation a le focus. */
  highlighted?: boolean;
}) {
  const approveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (highlighted) {
      approveRef.current?.scrollIntoView({ block: "center" });
      approveRef.current?.focus();
    }
  }, [highlighted]);
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const sensitive = useSensitiveAction();
  const [notice, setNotice] = useState<string | undefined>();
  const production = plan.environment === "production";
  const decide = (decision: "approve" | "reject") =>
    void sensitive
      .run("approuver un plan de production", () =>
        api(`/v1/plans/${plan.id}/decision`, { method: "POST", body: { decision } }),
      )
      .then((ok) => {
        if (ok) {
          setNotice(t("plan.sent"));
          void client.invalidateQueries({ queryKey: ["plans"] });
        }
      });
  const p = plan.plan;
  return (
    <div
      className={plan.status === "pending_approval" && actionable ? "ac" : "card"}
      style={{ padding: 18 }}
    >
      <div className="stack">
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <EnvChip environment={plan.environment} />
          <Chip>
            <ServerIcon width={12} height={12} aria-hidden="true" />
            {plan.server}
          </Chip>
          <Chip tone={STATUS_TONE(plan.status)}>{t(`status.${plan.status}`, plan.status)}</Chip>
          {plan.status === "pending_approval" && (
            <span className="muted">
              {t("plan.expires")} {new Date(plan.expiresAt).toLocaleTimeString(i18n.language)}
            </span>
          )}
        </div>
        <strong>{p.goal}</strong>
        <div className="muted">
          {t("plan.impact")} : {p.impact}
        </div>
        <ol className="ink-2" style={{ margin: 0, paddingLeft: 20 }} aria-label={t("plan.actions")}>
          {p.actions.map((a, i) => (
            <li key={i}>
              {a.kind === "command" ? (
                <>
                  <code>{a.command}</code> <span className="muted">· {a.reason}</span>
                </>
              ) : (
                <>
                  {t("plan.playbook")} <code>{a.name}</code>{" "}
                  {Object.entries(a.params).map(([k, v]) => (
                    <code key={k}>
                      {k}={v}{" "}
                    </code>
                  ))}
                </>
              )}
            </li>
          ))}
        </ol>
        {p.verify.length > 0 && (
          <div className="muted">
            {t("plan.verify")} :{" "}
            {p.verify.map((v) => (
              <code key={v}>{v} </code>
            ))}
          </div>
        )}
        {p.rollback.length > 0 && (
          <div className="muted">
            {t("plan.rollback")} :{" "}
            {p.rollback.map((v) => (
              <code key={v}>{v} </code>
            ))}
          </div>
        )}
        {plan.failureReason && <p className="chip crit">{plan.failureReason}</p>}
        {plan.status === "pending_approval" && actionable && (
          <>
            {production && <p className="muted">{t("plan.production_note")}</p>}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="pill ghost-crit" onClick={() => decide("reject")}>
                {t("plan.reject")}
              </button>
              <button ref={approveRef} className="pill primary" onClick={() => decide("approve")}>
                {production && <Fingerprint aria-hidden="true" />}
                {production ? t("plan.approve_prod") : t("plan.approve")}
              </button>
            </div>
          </>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      {sensitive.dialog}
    </div>
  );
}

export function PendingPlans({ highlight }: { highlight?: string | undefined } = {}) {
  const { t } = useTranslation();
  const plans = useQuery({
    queryKey: ["plans", "pending"],
    queryFn: () => api<Plan[]>("/v1/plans?status=pending_approval"),
  });
  if (!plans.data?.length) {
    return null;
  }
  return (
    <div className="stack" aria-label={t("plan.title")}>
      {plans.data.map((plan) => (
        <PlanCard key={plan.id} plan={plan} highlighted={plan.id === highlight} />
      ))}
    </div>
  );
}

function RegisterServer({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const sensitive = useSensitiveAction();
  const repos = useQuery({
    queryKey: ["repos"],
    queryFn: () => api<{ id: string; fullName: string }[]>("/v1/repos"),
  });
  const empty = {
    name: "",
    host: "",
    port: "22",
    username: "jules",
    environment: "staging",
    repoId: "",
    privateKey: "",
  };
  const [form, setForm] = useState(empty);
  const [notice, setNotice] = useState<string | undefined>();
  return (
    <form
      className="card-body stack"
      onSubmit={(e) => {
        e.preventDefault();
        void sensitive
          .run("enregistrer un serveur", () =>
            api("/v1/servers", {
              method: "POST",
              body: {
                ...form,
                port: Number(form.port),
                ...(form.repoId ? { repoId: form.repoId } : { repoId: undefined }),
              },
            }),
          )
          .then((ok) => {
            if (ok) {
              setNotice(t("servers.saved"));
              setForm(empty);
              onDone();
            }
          });
      }}
    >
      <div className="grid-2" style={{ gap: 8 }}>
        <input
          className="field"
          aria-label={t("servers.name")}
          placeholder={t("servers.name")}
          required
          pattern="[a-z0-9][a-z0-9_.\-]{0,62}"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <select
          className="field"
          aria-label={t("servers.environment")}
          value={form.environment}
          onChange={(e) => setForm({ ...form, environment: e.target.value })}
        >
          {["development", "staging", "production"].map((env) => (
            <option key={env} value={env}>
              {t(`env.${env}`)}
            </option>
          ))}
        </select>
        <input
          className="field"
          aria-label={t("servers.host")}
          placeholder={t("servers.host")}
          required
          value={form.host}
          onChange={(e) => setForm({ ...form, host: e.target.value })}
        />
        <input
          className="field"
          aria-label={t("servers.port")}
          placeholder={t("servers.port")}
          inputMode="numeric"
          value={form.port}
          onChange={(e) => setForm({ ...form, port: e.target.value })}
        />
        <input
          className="field"
          aria-label={t("servers.user")}
          placeholder={t("servers.user")}
          required
          value={form.username}
          onChange={(e) => setForm({ ...form, username: e.target.value })}
        />
        <select
          className="field"
          aria-label={t("servers.repo")}
          value={form.repoId}
          onChange={(e) => setForm({ ...form, repoId: e.target.value })}
        >
          <option value="">{t("servers.none")}</option>
          {(repos.data ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="field"
        aria-label={t("servers.key")}
        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        required
        autoComplete="off"
        spellCheck={false}
        value={form.privateKey}
        onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
      />
      <p className="muted">{t("servers.key_help")}</p>
      <button className="pill primary" type="submit" style={{ alignSelf: "flex-start" }}>
        {t("servers.save")}
      </button>
      {notice && <p role="status">{notice}</p>}
      {sensitive.dialog}
    </form>
  );
}

function ServerRow({ server, me }: { server: Server; me: Me }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const sensitive = useSensitiveAction();
  const [fingerprint, setFingerprint] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["servers"] });
  const admin = me.role === "admin";
  return (
    <div className="row" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
      <Link to="/servers/$id" params={{ id: server.id }} className="title">
        {server.name}
      </Link>
      <EnvChip environment={server.environment} />
      <span className="meta">
        <span>
          {server.username}@{server.host}:{server.port}
        </span>
        {server.repo && <span>{server.repo}</span>}
        <Chip tone={HOST_KEY_TONE[server.hostKeyStatus]}>
          {t("servers.host_key")} {t(`host_key.${server.hostKeyStatus}`)}
        </Chip>
        {server.frozen && (
          <Chip tone="info">
            <Snowflake width={12} height={12} aria-hidden="true" />
            {t("servers.frozen")}
          </Chip>
        )}
        {server.locked && <Chip tone="info">{t("servers.locked")}</Chip>}
      </span>
      <div
        style={{
          gridColumn: "1 / -1",
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div className="seg" role="group" aria-label={`${t("servers.level")} ${server.name}`}>
          {(["D0", "D1", "D2", "D3"] as const).map((level) => (
            <button
              key={level}
              className={server.level === level ? "on" : ""}
              aria-pressed={server.level === level}
              disabled={!admin}
              onClick={() =>
                void sensitive
                  .run("relever le niveau DevOps", () =>
                    api(`/v1/servers/${server.id}`, { method: "PATCH", body: { level } }),
                  )
                  .then(refresh)
              }
            >
              {level}
            </button>
          ))}
        </div>
        {admin && (
          <button
            className="pill sm"
            onClick={() =>
              void sensitive
                .run("dégeler un environnement", () =>
                  api(`/v1/servers/${server.id}`, {
                    method: "PATCH",
                    body: { frozen: !server.frozen },
                  }),
                )
                .then(refresh)
            }
          >
            {server.frozen ? t("servers.unfreeze") : t("servers.freeze")}
          </button>
        )}
      </div>
      {admin &&
        (server.hostKeyStatus === "awaiting_validation" || server.hostKeyStatus === "changed") &&
        server.offeredFingerprint && (
          <form
            style={{ gridColumn: "1 / -1" }}
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void sensitive
                .run("valider une clé d'hôte", () =>
                  api(`/v1/servers/${server.id}/trust`, { method: "POST", body: { fingerprint } }),
                )
                .then(refresh);
            }}
          >
            <span className="muted">
              {t("servers.offered")} ({server.offeredAlgorithm}) :{" "}
              <code>{server.offeredFingerprint}</code>
            </span>
            <span className="muted">{t("servers.validate_help")}</span>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="field"
                style={{ flex: 1, minWidth: 0 }}
                aria-label={t("servers.fingerprint")}
                placeholder={t("servers.fingerprint")}
                value={fingerprint}
                onChange={(e) => setFingerprint(e.target.value)}
              />
              <button className="pill" type="submit">
                <Fingerprint aria-hidden="true" />
                {t("servers.validate")}
              </button>
            </div>
          </form>
        )}
      {sensitive.dialog}
    </div>
  );
}

export function ServersPage({ me }: { me: Me }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api<Server[]>("/v1/servers") });
  return (
    <div className="grid-2">
      <Card title={t("servers.title")} icon={<ServerIcon aria-hidden="true" />}>
        <div className="card-body rows">
          {servers.data?.length === 0 && (
            <EmptyState
              title={t("servers.empty")}
              sub={t("servers.empty_sub")}
              text={t("servers.empty_text")}
            />
          )}
          {(servers.data ?? []).map((server) => (
            <ServerRow key={server.id} server={server} me={me} />
          ))}
        </div>
      </Card>
      {me.role === "admin" && (
        <Card title={t("servers.register")} icon={<Fingerprint aria-hidden="true" />}>
          <RegisterServer onDone={() => void client.invalidateQueries({ queryKey: ["servers"] })} />
        </Card>
      )}
    </div>
  );
}

export function ServerPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams({ from: "/servers/$id" });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => api<Server[]>("/v1/servers") });
  const history = useQuery({
    queryKey: ["servers", id, "commands"],
    queryFn: () => api<ServerCommand[]>(`/v1/servers/${id}/commands`),
  });
  const server = servers.data?.find((s) => s.id === id);
  return (
    <div className="stack">
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="headline" style={{ fontSize: 30 }}>
          {server?.name ?? "…"}
          <span> · {server ? `${server.username}@${server.host}` : ""}</span>
        </h1>
        {server && <EnvChip environment={server.environment} />}
        {server && <Chip>{server.level}</Chip>}
      </div>
      <Card title={t("servers.commands")} icon={<Terminal aria-hidden="true" />}>
        <div className="card-body rows">
          {history.data?.length === 0 && <p className="muted">{t("servers.no_commands")}</p>}
          {(history.data ?? []).map((c) => (
            <div className="row" key={c.id}>
              <code className="title" style={{ overflowWrap: "anywhere" }}>
                {c.command}
              </code>
              <Chip tone={c.decision === "allow" ? (c.exitCode === 0 ? "ok" : "crit") : "warn"}>
                {c.decision === "allow"
                  ? `code ${c.exitCode ?? "—"}`
                  : t(`status.${c.decision}`, c.decision)}
              </Chip>
              <span className="meta">
                <Chip tone={CLASS_TONE[c.commandClass]}>{t(`status.${c.commandClass}`)}</Chip>
                <span>{c.source}</span>
                <span>{new Date(c.createdAt).toLocaleString(i18n.language)}</span>
                {c.durationMs !== null && <span className="num">{c.durationMs} ms</span>}
              </span>
              {c.output && (
                <details className="transcript">
                  <summary>{t("artifact.details")}</summary>
                  <pre>{c.output}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

const hours = (value: number | null, t: TFunction) =>
  value === null ? "—" : t("deployments.hours", { value: Math.round(value * 10) / 10 });

export function DeploymentsPage() {
  const { t, i18n } = useTranslation();
  const deployments = useQuery({
    queryKey: ["deployments"],
    queryFn: () => api<Deployment[]>("/v1/deployments"),
  });
  const dora = useQuery({ queryKey: ["dora"], queryFn: () => api<Dora>("/v1/dora?days=30") });
  const d = dora.data;
  return (
    <div className="stack">
      <h1 className="headline">{t("deployments.title")}</h1>
      <div className="kpi-row">
        <Kpi dominant label={t("deployments.per_week")} value={d ? d.deploymentsPerWeek : "…"} />
        <Kpi label={t("deployments.lead_time")} value={d ? hours(d.leadTimeHours, t) : "…"} />
        <Kpi
          label={t("deployments.failure_rate")}
          value={
            d?.changeFailureRate === null || !d ? "—" : `${Math.round(d.changeFailureRate * 100)} %`
          }
        />
        <Kpi
          label={t("deployments.restore")}
          value={d ? hours(d.timeToRestoreHours, t) : "…"}
          sub={d ? `${t("deployments.approvals_day")} ${d.approvalsPerDay}` : undefined}
        />
      </div>
      <Card title={t("deployments.title")} icon={<Rocket aria-hidden="true" />}>
        <div className="card-body rows">
          {deployments.data?.length === 0 && (
            <EmptyState
              title={t("deployments.empty")}
              sub={t("deployments.empty_sub")}
              text={t("deployments.empty_text")}
            />
          )}
          {(deployments.data ?? []).map((dep) => (
            <div className="row" key={dep.id}>
              <span className="title">
                {dep.repo} <code>{dep.ref.slice(0, 7)}</code>
              </span>
              <Chip tone={STATUS_TONE(dep.status)}>{t(`status.${dep.status}`, dep.status)}</Chip>
              <span className="meta">
                <EnvChip environment={dep.environment} />
                <span>{dep.server}</span>
                <span>{dep.playbook}</span>
                {dep.pullRequests.length > 0 && (
                  <span>
                    {t("deployments.prs")} {dep.pullRequests.map((n) => `#${n}`).join(", ")}
                  </span>
                )}
                <span>{new Date(dep.createdAt).toLocaleString(i18n.language)}</span>
                {dep.reason && <span>{dep.reason}</span>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
