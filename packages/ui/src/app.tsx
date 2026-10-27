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
import { initI18n } from "./i18n.js";
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
  createRoute({ getParentRoute: () => rootRoute, path: "/approvals", component: ApprovalsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute }),
  createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/metrics", component: MetricsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/evals", component: EvalsPage }),
];
const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function JulesApp({ apiBaseUrl, language }: { apiBaseUrl?: string; language?: string }) {
  configureApi(apiBaseUrl ? { baseUrl: apiBaseUrl } : {});
  initI18n(language);
  applyTheme();
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: true } },
  });
  return (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}
