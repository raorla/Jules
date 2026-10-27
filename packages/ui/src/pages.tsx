import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import {
  ClipboardList,
  FileDiff,
  Fingerprint,
  GitPullRequest,
  History,
  KeyRound,
  ListChecks,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  registerPasskey,
  sendCommand,
  type AuditRow,
  type Command,
  type Me,
  type Metrics,
  type Plan,
  type Repo,
  type TaskDetail,
  type TaskSummary,
} from "./api.js";
import { ArtifactCards } from "./artifacts.js";
import { PendingPlans } from "./devops.js";
import { useDesktopSession } from "./desktop.js";
import { DesktopModeCard, LocalMergeCard, LocalModelAccessCard, LocalReposCard } from "./local.js";
import { OrgSettingsCard } from "./security.js";
import {
  Card,
  Chip,
  CostMeter,
  DiffViewer,
  EmptyState,
  GateReport,
  Kpi,
  PhaseTimeline,
  RiskChip,
  StateChip,
  useSensitiveAction,
} from "./components.js";
import { currentTheme, setTheme, type Theme } from "./theme.js";

// Écrans (DESIGN.md §6). Chaque écran a un nombre ou un élément dominant.

const money = (v: number, lng: string) =>
  new Intl.NumberFormat(lng, { style: "currency", currency: "USD" }).format(v);
const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)} %`);

function TaskRow({ task }: { task: TaskSummary }) {
  return (
    <Link to="/tasks/$id" params={{ id: task.id }} className="row">
      <span className="title">{task.title}</span>
      <StateChip state={task.state} />
      <span className="meta">
        <span>{task.repo}</span>
        {task.issueNumber !== null && <span>#{task.issueNumber}</span>}
        <RiskChip risk={task.risk} />
        {task.autonomy && <Chip>{task.autonomy}</Chip>}
        <span className="num">{task.costUsd.toFixed(2)} $</span>
      </span>
    </Link>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api<TaskSummary[]>("/v1/tasks") });
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<TaskSummary[]>("/v1/approvals"),
  });
  const metrics = useQuery({
    queryKey: ["metrics", 30],
    queryFn: () => api<Metrics[]>("/v1/metrics?days=30"),
  });
  const list = tasks.data ?? [];
  const running = list.filter((x) => !["done", "cancelled", "failed"].includes(x.state));
  const merged = (metrics.data ?? []).reduce((s, m) => s + m.merged, 0);
  const opened = (metrics.data ?? []).reduce((s, m) => s + m.prsOpened, 0);
  const cost = (metrics.data ?? []).reduce((s, m) => s + m.totalCostUsd, 0);
  return (
    <div className="stack">
      <h1 className="headline">
        {t("dashboard.title")}
        <span>.</span>
      </h1>
      <div className="kpi-row">
        <Kpi dominant label={t("dashboard.pending")} value={approvals.data?.length ?? "…"} />
        <Kpi label={t("dashboard.running")} value={running.length} />
        <Kpi label={t("dashboard.cost")} value={money(cost, i18n.language)} />
        <Kpi label={t("dashboard.acceptance")} value={pct(opened ? merged / opened : null)} />
      </div>
      <Card title={t("dashboard.recent")} icon={<ListChecks aria-hidden="true" />}>
        <div className="card-body">
          {list.length === 0 ? (
            <EmptyState
              title={t("dashboard.empty_title")}
              sub={t("dashboard.empty_sub")}
              text={t("dashboard.empty_text")}
            />
          ) : (
            <div className="rows">
              {list.slice(0, 8).map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export function TasksPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const search = useSearch({ from: "/tasks" });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api<TaskSummary[]>("/v1/tasks") });
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<Repo[]>("/v1/repos") });
  const [form, setForm] = useState({ repoId: "", title: "", body: "" });
  const [notice, setNotice] = useState<string | undefined>();
  const create = useMutation({
    mutationFn: () =>
      api("/v1/tasks", {
        method: "POST",
        body: { ...form, repoId: form.repoId || repos.data?.[0]?.id },
      }),
    onSuccess: () => {
      setNotice(t("tasks.created"));
      setForm({ repoId: "", title: "", body: "" });
      void client.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const q = (search.q ?? "").toLowerCase();
  const list = (tasks.data ?? []).filter(
    (x) => !q || x.title.toLowerCase().includes(q) || x.repo.toLowerCase().includes(q),
  );
  return (
    <div className="grid-2">
      <Card title={t("tasks.title")} icon={<ListChecks aria-hidden="true" />}>
        <div className="card-body rows">
          {list.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      </Card>
      <Card title={t("tasks.new")} icon={<Plus aria-hidden="true" />}>
        <form
          className="card-body stack"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="stack">
            <span className="muted">{t("tasks.repo")}</span>
            <select
              className="field"
              value={form.repoId}
              onChange={(e) => setForm({ ...form, repoId: e.target.value })}
            >
              {(repos.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </label>
          <label className="stack">
            <span className="muted">{t("tasks.task_title")}</span>
            <input
              className="field"
              required
              minLength={3}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label className="stack">
            <span className="muted">{t("tasks.body")}</span>
            <textarea
              className="field"
              required
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </label>
          <button className="pill primary" type="submit" disabled={create.isPending}>
            {t("tasks.create")}
          </button>
          {notice && <p role="status">{notice}</p>}
        </form>
      </Card>
    </div>
  );
}

function TaskActions({ detail }: { detail: TaskDetail }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [feedback, setFeedback] = useState("");
  const [notice, setNotice] = useState<string | undefined>();
  const send = useMutation({
    mutationFn: (command: Command) => sendCommand(detail.task.id, command),
    onSuccess: () => {
      setNotice(t("task.sent"));
      void client.invalidateQueries({ queryKey: ["task", detail.task.id] });
    },
  });
  const sensitive = useSensitiveAction();
  const state = detail.task.state;
  const awaiting =
    state === "awaiting_spec_approval" ||
    state === "awaiting_design_approval" ||
    state === "awaiting_plan_approval";
  // Un plan de production demande la passkey : l'api le signale, le dialogue s'ouvre.
  const approve = () =>
    void sensitive
      .run("approuver un plan de production", () =>
        sendCommand(detail.task.id, { name: "approve" }),
      )
      .then((ok) => {
        if (ok) {
          setNotice(t("task.sent"));
          void client.invalidateQueries({ queryKey: ["task", detail.task.id] });
        }
      });
  return (
    <div className={awaiting ? "ac" : "card"} style={{ padding: 18 }}>
      <div className="stack">
        {awaiting && (
          <>
            <textarea
              className="field"
              aria-label={t("task.revise_placeholder")}
              placeholder={t("task.revise_placeholder")}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className="pill"
                disabled={!feedback.trim()}
                onClick={() => send.mutate({ name: "revise", feedback })}
              >
                {t("task.revise")}
              </button>
              <button className="pill primary" onClick={approve}>
                {t("task.approve")}
              </button>
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(state === "blocked" || state === "failed") && (
            <button className="pill" onClick={() => send.mutate({ name: "retry" })}>
              {t("task.retry")}
            </button>
          )}
          <button className="pill sm" onClick={() => send.mutate({ name: "pause" })}>
            {t("task.pause")}
          </button>
          <button className="pill sm" onClick={() => send.mutate({ name: "resume" })}>
            {t("task.resume")}
          </button>
          {!["done", "cancelled"].includes(state) && (
            <button className="pill sm ghost-crit" onClick={() => send.mutate({ name: "cancel" })}>
              {t("task.cancel")}
            </button>
          )}
        </div>
        {notice && (
          <p role="status" className="muted">
            {notice}
          </p>
        )}
        {send.error && (
          <p role="alert" className="chip crit">
            {send.error.message}
          </p>
        )}
        {sensitive.dialog}
      </div>
    </div>
  );
}

type ToolCall = {
  id: string;
  capability: string;
  input: unknown;
  effect: "allow" | "deny" | "require_approval";
  reason: string;
  output: string | null;
};

/** Transcription d'une exécution, chargée à l'ouverture. Le worker l'a masquée à l'écriture. */
function RunTranscript({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const calls = useQuery({
    queryKey: ["tool-calls", runId],
    enabled: open,
    queryFn: () => api<ToolCall[]>(`/v1/runs/${runId}/tool-calls`),
  });
  return (
    <details
      className="transcript"
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>{t("task.transcript")}</summary>
      {calls.data?.length === 0 && <p className="muted">{t("task.no_calls")}</p>}
      {calls.data?.map((c) => (
        <div className="call" key={c.id}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code>{c.capability}</code>
            <Chip tone={c.effect === "allow" ? "ok" : c.effect === "deny" ? "crit" : "warn"}>
              {t(`status.${c.effect}`)}
            </Chip>
          </div>
          <pre>{JSON.stringify(c.input, null, 2)}</pre>
          {c.output && <pre>{c.output}</pre>}
        </div>
      ))}
    </details>
  );
}

/** Chronologie : changements d'état et commandes humaines, dans l'ordre. */
function Timeline({ detail }: { detail: TaskDetail }) {
  const { t, i18n } = useTranslation();
  const items = [
    ...detail.timeline.map((e) => ({ at: e.at, kind: "transition" as const, e })),
    ...detail.commands.map((c) => ({ at: c.createdAt, kind: "command" as const, c })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <Card title={t("task.timeline")} icon={<History aria-hidden="true" />}>
      <div className="card-body rows">
        {items.length === 0 && <p className="muted">{t("task.no_events")}</p>}
        {items.map((item, i) => (
          <div className="row" key={i}>
            {item.kind === "transition" ? (
              <>
                <span className="title">
                  {item.e.data.to ? t(`state.${item.e.data.to}`, item.e.data.to) : item.e.action}
                </span>
                {item.e.data.from && (
                  <Chip>{t(`state.${item.e.data.from}`, item.e.data.from)}</Chip>
                )}
              </>
            ) : (
              <>
                <span className="title">
                  /jules {item.c.name}
                  {item.c.login ? ` · ${item.c.login}` : ""}
                </span>
                <Chip
                  tone={
                    item.c.decision === "applied"
                      ? "ok"
                      : item.c.decision === "pending"
                        ? "info"
                        : "crit"
                  }
                >
                  {t(`status.${item.c.decision}`)}
                </Chip>
              </>
            )}
            <span className="meta">
              <span>{new Date(item.at).toLocaleString(i18n.language)}</span>
              {item.kind === "command" && <span>{item.c.source}</span>}
              {item.kind === "command" && item.c.reason && <span>{item.c.reason}</span>}
              {item.kind === "transition" && item.e.data.reason && (
                <span>{item.e.data.reason}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function TaskPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: "/tasks/$id" });
  const detail = useQuery({
    queryKey: ["task", id],
    queryFn: () => api<TaskDetail>(`/v1/tasks/${id}`),
  });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  if (!detail.data) return <p className="muted">{t("common.loading")}</p>;
  const { task, artifacts, runs } = detail.data;
  // Une tâche qui attend ton accord montre la décision en premier, avant les artefacts (aussi sur mobile).
  const deciding =
    task.state === "awaiting_spec_approval" || task.state === "awaiting_design_approval";
  const gates = artifacts.filter((a) => a.kind === "gate_report").at(-1)?.content as
    { results: Parameters<typeof GateReport>[0]["results"] } | undefined;
  const diff = artifacts.filter((a) => a.kind === "diff").at(-1)?.content as
    { text: string } | undefined;
  return (
    <div className="stack">
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h1 className="headline" style={{ fontSize: 30 }}>
          {task.title}
          <span> · {task.repo}</span>
        </h1>
        <StateChip state={task.state} />
        <RiskChip risk={task.risk} />
        {task.autonomy && <Chip>{task.autonomy}</Chip>}
      </div>
      <Card title={t("task.phases")}>
        <PhaseTimeline state={task.state} agent={task.agent} />
      </Card>
      {task.lastError &&
        ["blocked", "failed", "waiting_provider", "awaiting_design_approval"].includes(
          task.state,
        ) && (
          <div className="banner" role="status">
            {t("task.reason")} : {task.lastError}
          </div>
        )}
      {deciding && <TaskActions detail={detail.data} />}
      <div className="grid-2">
        <div className="stack">
          <ArtifactCards artifacts={artifacts} />
          {gates && (
            <Card title={t("task.gates")} icon={<ShieldCheck aria-hidden="true" />}>
              <GateReport results={gates.results} />
            </Card>
          )}
          <Card title={t("task.diff")} icon={<FileDiff aria-hidden="true" />}>
            {diff ? (
              <DiffViewer text={diff.text} />
            ) : (
              <p className="card-body muted">{t("task.no_diff")}</p>
            )}
          </Card>
        </div>
        <div className="stack">
          {!deciding && <TaskActions detail={detail.data} />}
          <CostMeter cost={task.costUsd} budget={task.budgetUsd} />
          {task.prUrl?.startsWith("local:")
            ? me.data && <LocalMergeCard detail={detail.data} me={me.data} />
            : task.prUrl && (
                <a className="pill" href={task.prUrl} target="_blank" rel="noreferrer noopener">
                  <GitPullRequest aria-hidden="true" />
                  {t("task.pr")}
                </a>
              )}
          <Card title={t("task.runs")} icon={<ClipboardList aria-hidden="true" />}>
            <div className="card-body rows">
              {runs.map((r) => (
                <div className="row" key={r.id}>
                  <span className="title">{r.role}</span>
                  <Chip
                    tone={
                      r.status === "succeeded"
                        ? "ok"
                        : r.status === "running"
                          ? "info"
                          : r.status === "failed"
                            ? "crit"
                            : "neutral"
                    }
                  >
                    {t(`status.${r.status}`, r.status)}
                  </Chip>
                  <span className="meta">
                    <span>{r.model}</span>
                    <span>{r.promptVersion}</span>
                    <span className="num">{r.costUsd.toFixed(3)} $</span>
                  </span>
                  <RunTranscript runId={r.id} />
                </div>
              ))}
            </div>
          </Card>
          <Timeline detail={detail.data} />
        </div>
      </div>
    </div>
  );
}

export function ApprovalsPage() {
  const search = useSearch({ from: "/approvals" });
  const { t } = useTranslation();
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<TaskSummary[]>("/v1/approvals"),
  });
  const plans = useQuery({
    queryKey: ["plans", "pending"],
    queryFn: () => api<Plan[]>("/v1/plans?status=pending_approval"),
  });
  // Une tâche DevOps en attente est montrée par son plan (actions exactes, environnement).
  const list = (approvals.data ?? []).filter((task) => task.state !== "awaiting_plan_approval");
  return (
    <div className="stack">
      <h1 className="headline">
        {t("approvals.title")}
        <span> · {list.length + (plans.data?.length ?? 0)}</span>
      </h1>
      <PendingPlans highlight={search.plan} />
      {list.length === 0 && (plans.data?.length ?? 0) > 0 ? null : list.length === 0 ? (
        <Card>
          <EmptyState
            title={t("approvals.empty_title")}
            sub={t("approvals.empty_sub")}
            text={t("approvals.empty_text")}
          />
        </Card>
      ) : (
        list.map((task) => (
          <div className="ac" key={task.id}>
            <div className="stack">
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <StateChip state={task.state} />
                <RiskChip risk={task.risk} />
                <span className="muted">{task.repo}</span>
              </div>
              <strong>{task.title}</strong>
              <Link
                to="/tasks/$id"
                params={{ id: task.id }}
                className="pill primary"
                style={{ alignSelf: "flex-start" }}
              >
                {t("task.approve")} / {t("task.revise")}
              </Link>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function SettingsPage({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const sensitive = useSensitiveAction();
  const [secret, setSecret] = useState({ name: "", value: "" });
  const [notice, setNotice] = useState<string | undefined>();
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const repos = useQuery({ queryKey: ["repos"], queryFn: () => api<Repo[]>("/v1/repos") });
  const desktop = useDesktopSession();
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: () => api<{ id: string; label: string }[]>("/v1/passkeys"),
  });
  const secrets = useQuery({
    queryKey: ["secrets"],
    enabled: me.role === "admin",
    queryFn: () => api<{ secrets: { name: string }[]; pending: { name: string }[] }>("/v1/secrets"),
  });
  return (
    <div className="grid-2">
      <div className="stack">
        <DesktopModeCard />
        <LocalModelAccessCard me={me} />
        <LocalReposCard me={me} />
        <Card title={t("settings.repos")}>
          <div className="card-body rows">
            {(repos.data ?? []).map((repo) => (
              <div className="row" key={repo.id}>
                <span className="title">{repo.fullName}</span>
                <div
                  className="seg"
                  role="group"
                  aria-label={`${t("settings.repos")} ${repo.fullName}`}
                >
                  {(["L0", "L1", "L2"] as const).map((level) => (
                    <button
                      key={level}
                      className={repo.autonomy === level ? "on" : ""}
                      aria-pressed={repo.autonomy === level}
                      disabled={me.role !== "admin"}
                      onClick={() =>
                        void sensitive
                          .run("relever l'autonomie", () =>
                            api(`/v1/repos/${repo.id}`, {
                              method: "PATCH",
                              body: { autonomy: level },
                            }),
                          )
                          .then(() => client.invalidateQueries({ queryKey: ["repos"] }))
                      }
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
        {me.role === "admin" && (
          <Card title={t("settings.secrets")} icon={<KeyRound aria-hidden="true" />}>
            <form
              className="card-body stack"
              onSubmit={(e) => {
                e.preventDefault();
                void sensitive
                  .run("modifier un secret", () =>
                    api(`/v1/secrets/${secret.name}`, {
                      method: "PUT",
                      body: { value: secret.value },
                    }),
                  )
                  .then((ok) => {
                    if (ok) {
                      setNotice(t("settings.secret_saved"));
                      setSecret({ name: "", value: "" });
                      void client.invalidateQueries({ queryKey: ["secrets"] });
                    }
                  });
              }}
            >
              <p className="muted">{t("settings.write_only")}</p>
              <input
                className="field"
                aria-label={t("settings.secret_name")}
                placeholder={t("settings.secret_name")}
                pattern="[a-z0-9_]{3,64}"
                required
                value={secret.name}
                onChange={(e) => setSecret({ ...secret, name: e.target.value })}
              />
              <input
                className="field"
                type="password"
                autoComplete="off"
                aria-label={t("settings.secret_value")}
                placeholder={t("settings.secret_value")}
                required
                value={secret.value}
                onChange={(e) => setSecret({ ...secret, value: e.target.value })}
              />
              <button className="pill primary" type="submit">
                {t("settings.secret_save")}
              </button>
              {notice && <p role="status">{notice}</p>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[...(secrets.data?.secrets ?? []), ...(secrets.data?.pending ?? [])].map((s) => (
                  <Chip key={s.name}>{s.name}</Chip>
                ))}
              </div>
            </form>
          </Card>
        )}
      </div>
      <div className="stack">
        <Card title={t("settings.passkeys")} icon={<Fingerprint aria-hidden="true" />}>
          <div className="card-body stack">
            {desktop?.mode !== "local" &&
              (passkeys.data ?? []).map((p) => (
                <Chip key={p.id} tone="ok">
                  {p.label}
                </Chip>
              ))}
            {/* La webview du desktop n'a pas de passkey : enregistrement dans l'interface web. */}
            {desktop ? (
              <p className="ink-2">
                {desktop.mode === "local"
                  ? t("settings.passkeys_local")
                  : t("settings.passkeys_desktop")}
              </p>
            ) : (
              <button
                className="pill"
                onClick={() =>
                  void registerPasskey(navigator.platform || "Passkey").then(() =>
                    client.invalidateQueries({ queryKey: ["passkeys"] }),
                  )
                }
              >
                {t("settings.passkey_add")}
              </button>
            )}
          </div>
        </Card>
        {me.role === "admin" && <OrgSettingsCard />}
        <Card title={t("settings.theme")}>
          <div className="card-body">
            <div className="seg" role="group" aria-label={t("settings.theme")}>
              {(["system", "dark", "light"] as Theme[]).map((option) => (
                <button
                  key={option}
                  className={theme === option ? "on" : ""}
                  aria-pressed={theme === option}
                  onClick={() => {
                    setTheme(option);
                    setThemeState(option);
                  }}
                >
                  {t(`settings.${option}`)}
                </button>
              ))}
            </div>
          </div>
        </Card>
        <Card title={t("settings.language")}>
          <div className="card-body">
            <div className="seg" role="group" aria-label={t("settings.language")}>
              {["fr", "en"].map((lng) => (
                <button
                  key={lng}
                  className={i18n.language === lng ? "on" : ""}
                  aria-pressed={i18n.language === lng}
                  onClick={() => void i18n.changeLanguage(lng)}
                >
                  {lng.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
      {sensitive.dialog}
    </div>
  );
}

export function AuditPage() {
  const { t, i18n } = useTranslation();
  const rows = useQuery({
    queryKey: ["audit"],
    queryFn: () => api<AuditRow[]>("/v1/audit?limit=200"),
  });
  const verify = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; checked?: number; seq?: number; reason?: string }>("/v1/audit/verify"),
  });
  return (
    <Card
      title={t("audit.title")}
      actions={
        <button className="pill sm" onClick={() => verify.mutate()}>
          {t("audit.verify")}
        </button>
      }
    >
      <div className="card-body stack">
        {verify.data && (
          <p role="status" className={`chip ${verify.data.ok ? "ok" : "crit"}`}>
            {verify.data.ok
              ? t("audit.ok", { count: verify.data.checked })
              : t("audit.broken", { seq: verify.data.seq, reason: verify.data.reason })}
          </p>
        )}
        <div className="rows">
          {(rows.data ?? []).map((r) => (
            <div className="row" key={r.seq}>
              <span className="title">{r.action}</span>
              <span className="num muted">#{r.seq}</span>
              <span className="meta">
                <span>{new Date(r.at).toLocaleString(i18n.language)}</span>
                <span>
                  {r.actorType} {r.actorId.slice(0, 8)}
                </span>
                {r.targetType && (
                  <span>
                    {r.targetType} {r.targetId?.slice(0, 8)}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function MetricsPage() {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(30);
  const metrics = useQuery({
    queryKey: ["metrics", days],
    queryFn: () => api<Metrics[]>(`/v1/metrics?days=${days}`),
  });
  const list = metrics.data ?? [];
  const merged = list.reduce((s, m) => s + m.merged, 0);
  const opened = list.reduce((s, m) => s + m.prsOpened, 0);
  return (
    <div className="stack">
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h1 className="headline">{t("metrics.title")}</h1>
        <div className="seg" role="group" aria-label="période">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={days === d ? "on" : ""}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
            >
              {d} j
            </button>
          ))}
        </div>
      </div>
      <div className="kpi-row">
        <Kpi
          dominant
          label={t("metrics.acceptance")}
          value={pct(opened ? merged / opened : null)}
          sub={`${merged} / ${opened}`}
        />
        <Kpi label={t("metrics.first_try")} value={pct(list[0]?.firstTryGateRate ?? null)} />
        <Kpi
          label={t("metrics.cost_per_pr")}
          value={
            list[0]?.costPerMergedPr === null || !list[0]
              ? "—"
              : money(list[0].costPerMergedPr, i18n.language)
          }
        />
        <Kpi label={t("metrics.tasks")} value={list.reduce((s, m) => s + m.tasks, 0)} />
      </div>
      <Card title="Repos">
        <div className="card-body rows">
          {list.length === 0 && <p className="muted">{t("metrics.empty")}</p>}
          {list.map((m) => (
            <div className="row" key={m.repo}>
              <span className="title">{m.repo}</span>
              <Chip>{m.autonomy}</Chip>
              <span className="meta">
                <span>
                  {t("metrics.acceptance")} {pct(m.acceptanceRate)}
                </span>
                <span>
                  {t("metrics.merged")} {m.merged}
                </span>
                {m.promotion && <Chip tone="ok">{m.promotion}</Chip>}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function EvalsPage() {
  const { t } = useTranslation();
  const runs = useQuery({
    queryKey: ["evals"],
    queryFn: () =>
      api<{ id: string; label: string; total: string; createdAt: string }[]>("/v1/evals"),
  });
  return (
    <Card title={t("evals.title")}>
      <div className="card-body rows">
        {(runs.data ?? []).length === 0 && <p className="muted">{t("evals.empty")}</p>}
        {(runs.data ?? []).map((r) => (
          <div className="row" key={r.id}>
            <span className="title">{r.label}</span>
            <span className="num">
              {t("evals.score")} {r.total}/100
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card" style={{ padding: 32, maxWidth: 520 }}>
        <h1 className="headline">
          {t("login.title")}
          <br />
          <span>{t("login.subtitle")}</span>
        </h1>
        <p className="lede">{t("login.lede")}</p>
        <a className="pill primary" href="/v1/auth/github">
          {t("login.button")}
        </a>
      </div>
    </div>
  );
}
