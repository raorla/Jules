import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogIn, RefreshCw, Server as ServerIcon } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, configureApi, type Plan } from "./api.js";

// App desktop (M9, ARCHITECTURE.md §4.7) : même interface que le web, plus ce que seul le shell Tauri
// sait faire (trousseau, navigateur du système, notifications natives, barre système, éditeur). Le
// desktop n'a aucun chemin de code propre pour les agents : il envoie les mêmes commandes.

export type DesktopNotification = { title: string; body: string; route: string };

/** Ce que le shell Tauri fournit à l'interface (apps/desktop/src/bridge.ts). */
export type DesktopBridge = {
  readonly version: string;
  savedServer(): Promise<string | null>;
  saveServer(url: string): Promise<void>;
  getToken(server: string): Promise<string | null>;
  setToken(server: string, token: string): Promise<void>;
  clearToken(server: string): Promise<void>;
  /** OAuth dans le navigateur du système, retour sur l'adresse de bouclage, PKCE (RFC 8252). */
  login(server: string): Promise<{ code: string; verifier: string }>;
  notify(notification: DesktopNotification): Promise<void>;
  setTrayCount(count: number): Promise<void>;
  openInEditor(path: string): Promise<void>;
  /** Clic sur une notification ou sur la barre système : la route à afficher. */
  onNavigate(handler: (route: string) => void): () => void;
};

const DesktopContext = createContext<DesktopBridge | undefined>(undefined);
export const useDesktop = () => useContext(DesktopContext);

/** Comparaison semver simple (majeur.mineur.correctif) ; une pré-version est plus ancienne. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (diff !== 0) {
      return Math.sign(diff);
    }
  }
  return x.pre && !y.pre ? -1 : !x.pre && y.pre ? 1 : 0;
}

/** Texte d'une notification (DESIGN.md §11) : court, et il nomme l'environnement. */
export function approvalText(
  environment: string,
  server: string,
  t: (key: string) => string,
): string {
  const env = t(`env.${environment}`);
  return `${env.charAt(0).toUpperCase()}${env.slice(1)} · ${server} : ${t("desktop.approval_requested")}`;
}

type Step = "server" | "checking" | "update" | "login" | "connecting";

/**
 * Connexion du desktop : adresse du serveur, compatibilité de version, puis OAuth avec PKCE. Un
 * desktop trop ancien demande une mise à jour au lieu de se connecter.
 */
export function DesktopGate({ bridge, children }: { bridge: DesktopBridge; children: ReactNode }) {
  const { t } = useTranslation();
  const [server, setServer] = useState("");
  const [step, setStep] = useState<Step>("checking");
  const [minimum, setMinimum] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [ready, setReady] = useState(false);

  const check = async (url: string) => {
    setError(undefined);
    setStep("checking");
    try {
      configureApi({ baseUrl: url });
      const health = await api<{ desktop?: { minVersion?: string } }>("/v1/health");
      const min = health.desktop?.minVersion ?? "0.0.0";
      if (compareVersions(bridge.version, min) < 0) {
        setMinimum(min);
        setStep("update");
        return;
      }
      const token = await bridge.getToken(url);
      if (token) {
        configureApi({ baseUrl: url, token });
        try {
          await api("/v1/me");
          setReady(true);
          return;
        } catch {
          await bridge.clearToken(url);
          configureApi({ baseUrl: url });
        }
      }
      setStep("login");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("server");
    }
  };

  useEffect(() => {
    void bridge.savedServer().then((saved) => {
      if (saved) {
        setServer(saved);
        void check(saved);
      } else {
        setStep("server");
      }
    });
    // Une seule fois au lancement : la suite dépend des actions de la personne.
  }, []);

  const login = async () => {
    setError(undefined);
    setStep("connecting");
    try {
      const { code, verifier } = await bridge.login(server);
      const { token } = await api<{ token: string }>("/v1/auth/desktop/token", {
        method: "POST",
        body: { code, verifier },
        anonymous: true,
      });
      await bridge.setToken(server, token);
      configureApi({ baseUrl: server, token });
      setReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("login");
    }
  };

  if (ready) {
    return <DesktopContext.Provider value={bridge}>{children}</DesktopContext.Provider>;
  }
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card stack" style={{ padding: 32, maxWidth: 520, width: "100%" }}>
        <h1 className="headline">
          Jules
          <br />
          <span>{t("desktop.subtitle")}</span>
        </h1>
        {step === "update" ? (
          <div className="stack" role="alert">
            <p className="chip warn">{t("desktop.update_required")}</p>
            <p className="ink-2">
              {t("desktop.update_text", { version: bridge.version, minimum: minimum ?? "?" })}
            </p>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              const url = server.trim().replace(/\/+$/, "");
              setServer(url);
              void bridge.saveServer(url).then(() => check(url));
            }}
          >
            <label className="stack">
              <span className="muted">{t("desktop.server")}</span>
              <input
                className="field"
                type="url"
                required
                placeholder="https://jules.example.org"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            </label>
            {step === "server" || step === "checking" ? (
              <button className="pill" type="submit" disabled={step === "checking"}>
                <ServerIcon aria-hidden="true" />
                {t("desktop.connect_server")}
              </button>
            ) : (
              <button
                className="pill primary"
                type="button"
                disabled={step === "connecting"}
                onClick={() => void login()}
              >
                <LogIn aria-hidden="true" />
                {step === "connecting" ? t("desktop.waiting_browser") : t("desktop.login")}
              </button>
            )}
          </form>
        )}
        {error && (
          <p role="alert" className="chip crit">
            {error}
          </p>
        )}
        <p className="muted">
          {t("desktop.version")} {bridge.version}
          {step === "update" && (
            <button
              className="pill sm"
              style={{ marginLeft: 8 }}
              onClick={() => void check(server)}
            >
              <RefreshCw aria-hidden="true" />
              {t("desktop.retry")}
            </button>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Notifications natives et barre système : un plan qui arrive en attente notifie une fois, avec son
 * environnement ; le clic sur la notification ouvre le plan, prêt à être approuvé.
 */
export function useDesktopNotifications(pendingCount: number) {
  const bridge = useDesktop();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const known = useRef<Set<string> | undefined>(undefined);
  const plans = useQuery({
    queryKey: ["plans", "pending"],
    queryFn: () => api<Plan[]>("/v1/plans?status=pending_approval"),
    enabled: bridge !== undefined,
  });

  useEffect(() => {
    if (!bridge || !plans.data) {
      return;
    }
    const ids = new Set(plans.data.map((p) => p.id));
    // Au premier chargement, rien n'est « nouveau » : on ne notifie que ce qui arrive ensuite.
    if (known.current) {
      for (const plan of plans.data.filter((p) => !known.current?.has(p.id))) {
        void bridge.notify({
          title: "Jules",
          body: approvalText(plan.environment, plan.server, t),
          route: `/approvals?plan=${plan.id}`,
        });
      }
    }
    known.current = ids;
  }, [bridge, plans.data, t]);

  useEffect(() => {
    void bridge?.setTrayCount(pendingCount);
  }, [bridge, pendingCount]);

  useEffect(() => {
    if (!bridge) {
      return undefined;
    }
    return bridge.onNavigate((route) => {
      const [path = "/", query = ""] = route.split("?");
      const plan = new URLSearchParams(query).get("plan");
      void navigate({ to: path, ...(plan ? { search: { plan } } : {}) } as Parameters<
        typeof navigate
      >[0]);
    });
  }, [bridge, navigate]);
}
