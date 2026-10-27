import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, FolderPlus, GitMerge, HardDrive, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type Me, type TaskDetail } from "./api.js";
import { Card, Chip } from "./components.js";
import { useDesktop, useDesktopSession, type LocalIsolation } from "./desktop.js";

// Mode local du desktop (M10, ARCHITECTURE.md §4.7, §11) : niveau d'isolation affiché en permanence,
// dossiers git comme repos, et le merge d'une demande locale par un bouton (action humaine).

const ISOLATION_TONE: Record<LocalIsolation, "ok" | "warn" | "crit"> = {
  gvisor: "ok",
  vm: "warn",
  runc: "crit",
};

/** Badge de la barre latérale : l'isolation des sandboxes, toujours visible en mode local. */
export function IsolationBadge() {
  const { t } = useTranslation();
  const session = useDesktopSession();
  const isolation = session?.local?.isolation;
  if (session?.mode !== "local" || !isolation) {
    return null;
  }
  return (
    <div className="isolation" title={t(`local.isolation_text.${isolation}`)}>
      <Chip tone={ISOLATION_TONE[isolation]}>
        <ShieldCheck aria-hidden="true" />
        {t(`local.isolation.${isolation}`)}
      </Chip>
    </div>
  );
}

/** Réglages du desktop : le mode, l'isolation et le passage d'un mode à l'autre. */
export function DesktopModeCard() {
  const { t } = useTranslation();
  const bridge = useDesktop();
  const session = useDesktopSession();
  if (!bridge || !session) {
    return null;
  }
  const isolation = session.local?.isolation;
  return (
    <Card title={t("local.mode_title")} icon={<HardDrive aria-hidden="true" />}>
      <div className="card-body stack">
        <p>
          {session.mode === "local" ? t("desktop.mode_local") : t("desktop.mode_server")}
          {session.local?.engine && (
            <span className="muted">
              {" "}
              · {session.local.engine.kind} {session.local.engine.version}
            </span>
          )}
        </p>
        {isolation && (
          <p className="ink-2">
            <Chip tone={ISOLATION_TONE[isolation]}>{t(`local.isolation.${isolation}`)}</Chip>{" "}
            {t(`local.isolation_text.${isolation}`)}
          </p>
        )}
        {bridge.local && (
          <div>
            <button
              className="pill"
              onClick={() =>
                void bridge.local?.saveMode(null).then(() => {
                  window.location.reload();
                })
              }
            >
              <ArrowLeftRight aria-hidden="true" />
              {t("desktop.switch_mode")}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

type LocalRepo = { id: string; fullName: string; path: string; defaultBranch: string | null };

/** Dossiers git de la machine que Jules peut traiter (admin). */
export function LocalReposCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const bridge = useDesktop();
  const session = useDesktopSession();
  const client = useQueryClient();
  const [error, setError] = useState<string | undefined>();
  const local = session?.mode === "local";
  const repos = useQuery({
    queryKey: ["local-repos"],
    enabled: local,
    queryFn: () => api<LocalRepo[]>("/v1/local/repos"),
  });
  const add = useMutation({
    mutationFn: async () => {
      const path = await bridge?.local?.pickFolder();
      if (path) {
        await api("/v1/local/repos", { method: "POST", body: { path } });
      }
    },
    onSuccess: () => {
      setError(undefined);
      void client.invalidateQueries({ queryKey: ["local-repos"] });
      void client.invalidateQueries({ queryKey: ["repos"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  if (!local) {
    return null;
  }
  return (
    <Card title={t("local.repos")} icon={<FolderPlus aria-hidden="true" />}>
      <div className="card-body rows">
        {(repos.data ?? []).map((repo) => (
          <div className="row" key={repo.id}>
            <span className="title">{repo.fullName}</span>
            <code>{repo.path}</code>
          </div>
        ))}
        {repos.data?.length === 0 && <p className="muted">{t("local.no_repos")}</p>}
        {me.role === "admin" && (
          <div>
            <button className="pill" disabled={add.isPending} onClick={() => add.mutate()}>
              <FolderPlus aria-hidden="true" />
              {t("local.add_repo")}
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="chip crit">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}

type MergeStatus = {
  status: "none" | "pending" | "merged" | "refused" | "failed";
  sha?: string | null;
  reason?: string | null;
};

/**
 * Écran de review local : diff, artefacts et gates sont déjà sur la page de la tâche ; cette carte
 * porte la demande de merge et le bouton. Le merge est fait par le worker, jamais par un agent.
 */
export function LocalMergeCard({ detail, me }: { detail: TaskDetail; me: Me }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { task } = detail;
  const number = task.prUrl?.split("#").at(-1);
  const status = useQuery({
    queryKey: ["merge", task.id],
    queryFn: () => api<MergeStatus>(`/v1/tasks/${task.id}/merge`),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 1000 : false),
  });
  const merge = useMutation({
    mutationFn: () => api(`/v1/tasks/${task.id}/merge`, { method: "POST", body: {} }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["merge", task.id] });
    },
  });
  const state = status.data?.status ?? "none";
  const allowed = me.role === "admin" || me.role === "maintainer";
  return (
    <div className="ac" style={{ padding: 18 }}>
      <div className="stack">
        <p style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <GitMerge aria-hidden="true" width={16} height={16} />
          <strong>{t("local.merge_request", { number })}</strong>
          {task.branch && <code>{task.branch}</code>}
        </p>
        {state === "merged" && (
          <p role="status" className="chip ok">
            {t("local.merged", { sha: status.data?.sha?.slice(0, 8) ?? "" })}
          </p>
        )}
        {(state === "refused" || state === "failed") && (
          <p role="alert" className="chip crit">
            {t("local.merge_refused")} : {status.data?.reason}
          </p>
        )}
        {state === "pending" && (
          <p role="status" className="ink-2">
            {t("local.merging")}
          </p>
        )}
        {task.state === "awaiting_human_review" && state !== "merged" && allowed && (
          <div>
            <button
              className="pill primary"
              disabled={state === "pending" || merge.isPending}
              onClick={() => merge.mutate()}
            >
              <GitMerge aria-hidden="true" />
              {t("local.merge")}
            </button>
          </div>
        )}
        {task.state === "awaiting_human_review" && !allowed && (
          <p className="muted">{t("local.merge_role")}</p>
        )}
      </div>
    </div>
  );
}
