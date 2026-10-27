import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  CheckCircle2,
  FlaskConical,
  LayoutDashboard,
  ListChecks,
  LogOut,
  OctagonX,
  ScrollText,
  Search,
  Settings,
  ShieldAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, type Me } from "./api.js";
import { Chip, Dialog, useSensitiveAction } from "./components.js";

// App shell du skill (components.md §4) : barre latérale flottante, colonne de cartes à 8 px.
// L'arrêt d'urgence reste visible pour les admins, sur chaque écran (DESIGN.md §5).

function NavItem({
  to,
  icon,
  label,
  count,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = to === "/" ? path === "/" : path.startsWith(to);
  return (
    <Link
      to={to}
      className={`nav-item ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      {label}
      {count ? (
        <span className="count">
          <Chip tone="warn">{count}</Chip>
        </span>
      ) : null}
    </Link>
  );
}

function KillSwitch({ me }: { me: Me }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const sensitive = useSensitiveAction();
  const stops = useQuery({ queryKey: ["stop"], queryFn: () => api<unknown[]>("/v1/stop") });
  const stop = useMutation({
    mutationFn: () =>
      api("/v1/stop", { method: "POST", body: { reason: "arrêt depuis l'interface" } }),
    onSuccess: () => {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["stop"] });
    },
  });
  if (me.role !== "admin") return null;
  const active = (stops.data?.length ?? 0) > 0;
  if (active) {
    return (
      <>
        <button
          className="pill ghost-crit"
          onClick={() =>
            void sensitive
              .run("lever l'arrêt d'urgence", () =>
                api("/v1/stop/lift", { method: "POST", body: {} }),
              )
              .then(() => client.invalidateQueries({ queryKey: ["stop"] }))
          }
        >
          <OctagonX aria-hidden="true" />
          {t("top.lift")}
        </button>
        {sensitive.dialog}
      </>
    );
  }
  return (
    <>
      <button className="pill ghost-crit" onClick={() => setOpen(true)}>
        <OctagonX aria-hidden="true" />
        {t("top.stop")}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("stop.title")}
        actions={
          <>
            <button className="pill" onClick={() => setOpen(false)}>
              {t("common.close")}
            </button>
            <button className="pill primary" onClick={() => stop.mutate()}>
              {t("stop.confirm")}
            </button>
          </>
        }
      >
        <p className="ink-2">{t("stop.text")}</p>
      </Dialog>
    </>
  );
}

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const approvals = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<unknown[]>("/v1/approvals"),
  });
  const stops = useQuery({ queryKey: ["stop"], queryFn: () => api<unknown[]>("/v1/stop") });
  return (
    <div className="app">
      <aside className="sidebar" aria-label="Navigation">
        <div className="brand">
          <ShieldAlert aria-hidden="true" />
          Jules
        </div>
        <nav>
          <div className="nav-label">{t("nav.work")}</div>
          <NavItem
            to="/"
            icon={<LayoutDashboard aria-hidden="true" />}
            label={t("nav.dashboard")}
          />
          <NavItem to="/tasks" icon={<ListChecks aria-hidden="true" />} label={t("nav.tasks")} />
          <NavItem
            to="/approvals"
            icon={<CheckCircle2 aria-hidden="true" />}
            label={t("nav.approvals")}
            count={approvals.data?.length ?? 0}
          />
          <div className="nav-label">{t("nav.oversight")}</div>
          <NavItem to="/metrics" icon={<BarChart3 aria-hidden="true" />} label={t("nav.metrics")} />
          <NavItem to="/audit" icon={<ScrollText aria-hidden="true" />} label={t("nav.audit")} />
          <NavItem to="/evals" icon={<FlaskConical aria-hidden="true" />} label={t("nav.evals")} />
          <NavItem
            to="/settings"
            icon={<Settings aria-hidden="true" />}
            label={t("nav.settings")}
          />
        </nav>
      </aside>
      <main className="main">
        <header className="topbar">
          <form
            className="search"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate({ to: "/tasks", search: { q: query } });
            }}
          >
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label={t("top.search")}
              placeholder={t("top.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            <KillSwitch me={me} />
            <span className="chip" title={me.role}>
              {me.login}
            </span>
            <button
              className="pill round"
              aria-label={t("top.logout")}
              onClick={() =>
                void api("/v1/auth/logout", { method: "POST", body: {} }).then(() =>
                  window.location.assign("/"),
                )
              }
            >
              <LogOut aria-hidden="true" />
            </button>
          </div>
        </header>
        {(stops.data?.length ?? 0) > 0 && (
          <div className="banner" role="alert">
            <OctagonX aria-hidden="true" />
            {t("top.stopped")}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
