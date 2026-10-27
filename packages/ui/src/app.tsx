import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { api, configureApi, useLiveUpdates, type Me } from "./api.js";
import { DeploymentsPage, ServerPage, ServersPage } from "./devops.js";
import { DesktopGate, type DesktopBridge } from "./desktop.js";
import { initI18n } from "./i18n.js";
import { SecurityPage } from "./security.js";
import {
  ApprovalsPage,
  AuditPage,
  DashboardPage,
  EvalsPage,
  LoginPage,
  MetricsPage,
  SettingsPage,
  TaskPage,
  TasksPage,
} from "./pages.js";
import { Shell } from "./shell.js";
import { applyTheme } from "./theme.js";

// L'application, partagée par le web (apps/web) et le desktop (apps/desktop, Tauri).

function Root() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me"), retry: false });
  if (me.isLoading) return null;
  if (!me.data) return <LoginPage />;
  return <Authenticated me={me.data} />;
}

function Authenticated({ me }: { me: Me }) {
  useLiveUpdates();
  return (
    <Shell me={me}>
      <Outlet />
    </Shell>
  );
}

function ServersRoute() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  return me.data ? <ServersPage me={me.data} /> : null;
}

function SecurityRoute() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  return me.data ? <SecurityPage me={me.data} /> : null;
}

function SettingsRoute() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  return me.data ? <SettingsPage me={me.data} /> : null;
}

const rootRoute = createRootRoute({ component: Root });
const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
    component: TasksPage,
    validateSearch: (s: Record<string, unknown>) => ({
      q: typeof s.q === "string" ? s.q : undefined,
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tasks/$id", component: TaskPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    component: ApprovalsPage,
    // `?plan=` : le plan ouvert depuis une notification du desktop.
    validateSearch: (s: Record<string, unknown>) => ({
      plan: typeof s.plan === "string" ? s.plan : undefined,
    }),
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/metrics", component: MetricsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/evals", component: EvalsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/servers", component: ServersRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: "/servers/$id", component: ServerPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/deployments",
    component: DeploymentsPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/security", component: SecurityRoute }),
];
const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function JulesApp({
  apiBaseUrl,
  language,
  desktop,
}: {
  apiBaseUrl?: string;
  language?: string;
  /** Shell Tauri (apps/desktop) : connexion par PKCE, jeton porteur, fonctions natives. */
  desktop?: DesktopBridge;
}) {
  if (!desktop) {
    configureApi(apiBaseUrl ? { baseUrl: apiBaseUrl } : {});
  }
  initI18n(language);
  applyTheme();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
  });
  const app = (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return (
    <StrictMode>{desktop ? <DesktopGate bridge={desktop}>{app}</DesktopGate> : app}</StrictMode>
  );
}
