import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  HardDrive,
  KeyRound,
  LogIn,
  RefreshCw,
  Server as ServerIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, configureApi, type Plan } from "./api.js";

// App desktop (M9, ARCHITECTURE.md §4.7) : même interface que le web, plus ce que seul le shell Tauri
// sait faire (trousseau, navigateur du système, notifications natives, barre système, éditeur). Le
// desktop n'a aucun chemin de code propre pour les agents : il envoie les mêmes commandes.

export type DesktopNotification = { title: string; body: string; route: string };

export type DesktopMode = "server" | "local";

/** Isolation des sandboxes en mode local (ARCHITECTURE.md §4.7) : du plus fort au plus faible. */
export type LocalIsolation = "gvisor" | "vm" | "runc";

export type LocalStatus = {
  /** Moteur de conteneurs trouvé ; aucun : l'app aide à en installer un. */
  engine: { kind: "docker" | "podman"; version: string } | null;
  isolation: LocalIsolation | null;
  running: boolean;
  /** Adresse de l'api locale (bouclage) quand la pile tourne. */
  url: string | null;
};

/** Mode local (M10) : la pile Jules sur la machine, pilotée par le shell. */
export type LocalStack = {
  savedMode(): Promise<DesktopMode | null>;
  saveMode(mode: DesktopMode | null): Promise<void>;
  status(): Promise<LocalStatus>;
  /** Lance PostgreSQL, l'api et le worker, puis remet la clé maître et la clé API au worker. */
  start(): Promise<LocalStatus>;
  stop(): Promise<void>;
  /** La clé API du fournisseur est dans le trousseau ; l'interface ne la relit jamais. */
  hasApiKey(): Promise<boolean>;
  /** Range la clé API dans le trousseau ; si la pile tourne, le worker est relancé pour la recevoir. */
  setApiKey(key: string): Promise<LocalStatus>;
  /**
   * Action sensible : fenêtre native du shell, puis signature du défi par la clé du trousseau, que la
   * page ne voit jamais. `null` : la personne a annulé.
   */
  confirmStepUp(challenge: string, purpose: string): Promise<string | null>;
  /** Secret de connexion à l'api locale, tiré au premier lancement et rangé dans le trousseau. */
  loginSecret(): Promise<{ secret: string; login: string }>;
  /** Sélecteur de dossier du système. */
  pickFolder(): Promise<string | null>;
};

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
  /** Mode connecté : ouvre la page de confirmation du serveur dans le navigateur du système. */
  openStepUp(server: string, request: string): Promise<void>;
  notify(notification: DesktopNotification): Promise<void>;
  setTrayCount(count: number): Promise<void>;
  openInEditor(path: string): Promise<void>;
  /** Clic sur une notification ou sur la barre système : la route à afficher. */
  onNavigate(handler: (route: string) => void): () => void;
  /** Absent : le shell ne sait pas lancer la pile locale, seul le mode connecté est proposé. */
  local?: LocalStack;
};

const DesktopContext = createContext<DesktopBridge | undefined>(undefined);
export const useDesktop = () => useContext(DesktopContext);

export type DesktopSession = { mode: DesktopMode; local?: LocalStatus };
const SessionContext = createContext<DesktopSession | undefined>(undefined);
/** Mode du desktop et, en mode local, l'état de la pile ; `undefined` sur le web. */
export const useDesktopSession = () => useContext(SessionContext);

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

type Step =
  | "mode"
  | "server"
  | "checking"
  | "update"
  | "login"
  | "connecting"
  | "local_starting"
  | "local_install"
  | "local_key"
  | "local_failed";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Connexion du desktop. Premier lancement : le choix du mode, connecté (un serveur Jules) ou local
 * (la pile sur cette machine). Puis la compatibilité de version, et la connexion : OAuth avec PKCE
 * pour un serveur, secret du trousseau pour l'api locale. Un desktop trop ancien demande une mise à
 * jour au lieu de se connecter. Changer de mode ne demande aucune réinstallation.
 */
export function DesktopGate({ bridge, children }: { bridge: DesktopBridge; children: ReactNode }) {
  const { t } = useTranslation();
  const [server, setServer] = useState("");
  const [step, setStep] = useState<Step>("checking");
  const [minimum, setMinimum] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [session, setSession] = useState<DesktopSession | undefined>();
  const [local, setLocal] = useState<LocalStatus | undefined>();
  const [apiKey, setApiKey] = useState("");
  const stack = bridge.local;

  /** Version acceptée par ce serveur ; sinon, l'écran de mise à jour. */
  const compatible = async () => {
    const health = await api<{ desktop?: { minVersion?: string } }>("/v1/health");
    const min = health.desktop?.minVersion ?? "0.0.0";
    if (compareVersions(bridge.version, min) < 0) {
      setMinimum(min);
      setStep("update");
      return false;
    }
    return true;
  };

  /** Session déjà rangée dans le trousseau et encore valide. */
  const resume = async (url: string) => {
    const token = await bridge.getToken(url);
    if (!token) {
      return false;
    }
    configureApi({ baseUrl: url, token });
    try {
      await api("/v1/me");
      return true;
    } catch {
      await bridge.clearToken(url);
      configureApi({ baseUrl: url });
      return false;
    }
  };

  const check = async (url: string) => {
    setError(undefined);
    setStep("checking");
    try {
      configureApi({ baseUrl: url });
      if (!(await compatible())) {
        return;
      }
      if (await resume(url)) {
        setSession({ mode: "server" });
        return;
      }
      setStep("login");
    } catch (e) {
      setError(message(e));
      setStep("server");
    }
  };

  const connectLocal = async () => {
    if (!stack) {
      setStep("server");
      return;
    }
    setError(undefined);
    setStep("local_starting");
    try {
      let status = await stack.status();
      setLocal(status);
      if (!status.engine) {
        setStep("local_install");
        return;
      }
      // La clé API du fournisseur est saisie ici, une fois : elle va au trousseau, jamais en base.
      if (!(await stack.hasApiKey())) {
        setStep("local_key");
        return;
      }
      if (!status.running || !status.url) {
        status = await stack.start();
        setLocal(status);
      }
      const url = status.url ?? "";
      configureApi({ baseUrl: url });
      if (!(await compatible())) {
        return;
      }
      if (!(await resume(url))) {
        const credentials = await stack.loginSecret();
        const { token } = await api<{ token: string }>("/v1/auth/local", {
          method: "POST",
          body: credentials,
          anonymous: true,
        });
        await bridge.setToken(url, token);
        configureApi({ baseUrl: url, token });
      }
      setSession({ mode: "local", local: status });
    } catch (e) {
      setError(message(e));
      setStep("local_failed");
    }
  };

  const saveApiKey = async () => {
    if (!stack) {
      return;
    }
    setError(undefined);
    setStep("local_starting");
    try {
      await stack.setApiKey(apiKey);
      setApiKey("");
      await connectLocal();
    } catch (e) {
      setError(message(e));
      setStep("local_key");
    }
  };

  const choose = async (mode: DesktopMode | null) => {
    await stack?.saveMode(mode);
    setError(undefined);
    if (mode === "local") {
      await connectLocal();
    } else if (mode === "server") {
      setStep("server");
    } else {
      setStep("mode");
    }
  };

  useEffect(() => {
    void (async () => {
      const mode = stack ? await stack.savedMode() : "server";
      if (mode === "local") {
        await connectLocal();
        return;
      }
      if (mode === null) {
        setStep("mode");
        return;
      }
      const saved = await bridge.savedServer();
      if (saved) {
        setServer(saved);
        await check(saved);
      } else {
        setStep("server");
      }
    })();
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
      setSession({ mode: "server" });
    } catch (e) {
      setError(message(e));
      setStep("login");
    }
  };

  if (session) {
    return (
      <DesktopContext.Provider value={bridge}>
        <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
      </DesktopContext.Provider>
    );
  }
  const serverStep = ["server", "checking", "login", "connecting"].includes(step);
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card stack" style={{ padding: 32, maxWidth: 520, width: "100%" }}>
        <h1 className="headline">
          Jules
          <br />
          <span>{t("desktop.subtitle")}</span>
        </h1>
        {step === "mode" && (
          <div className="stack" role="group" aria-label={t("desktop.mode_choice")}>
            <button className="choice" onClick={() => void choose("local")}>
              <HardDrive aria-hidden="true" />
              <span>
                <strong>{t("desktop.mode_local")}</strong>
                <span className="ink-2">{t("desktop.mode_local_text")}</span>
              </span>
            </button>
            <button className="choice" onClick={() => void choose("server")}>
              <ServerIcon aria-hidden="true" />
              <span>
                <strong>{t("desktop.mode_server")}</strong>
                <span className="ink-2">{t("desktop.mode_server_text")}</span>
              </span>
            </button>
          </div>
        )}
        {step === "local_starting" && (
          <p className="ink-2" role="status">
            {t("desktop.local_starting")}
          </p>
        )}
        {step === "local_install" && (
          <div className="stack" role="alert">
            <p className="chip warn">{t("desktop.engine_missing")}</p>
            <p className="ink-2">{t("desktop.engine_help")}</p>
            <ul className="ink-2">
              <li>
                <a
                  href="https://docs.docker.com/get-started/get-docker/"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Docker Desktop
                </a>{" "}
                · {t("desktop.engine_docker")}
              </li>
              <li>
                <a
                  href="https://podman.io/docs/installation"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Podman
                </a>{" "}
                · {t("desktop.engine_podman")}
              </li>
            </ul>
          </div>
        )}
        {step === "local_key" && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void saveApiKey();
            }}
          >
            <p className="ink-2">{t("desktop.api_key_text")}</p>
            <label className="stack">
              <span className="muted">{t("desktop.api_key")}</span>
              <input
                className="field"
                type="password"
                required
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </label>
            <button className="pill primary" type="submit">
              <KeyRound aria-hidden="true" />
              {t("desktop.api_key_save")}
            </button>
          </form>
        )}
        {step === "update" && (
          <div className="stack" role="alert">
            <p className="chip warn">{t("desktop.update_required")}</p>
            <p className="ink-2">
              {t("desktop.update_text", { version: bridge.version, minimum: minimum ?? "?" })}
            </p>
          </div>
        )}
        {serverStep && (
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
        <p
          className="muted"
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}
        >
          <span>
            {t("desktop.version")} {bridge.version}
          </span>
          {(step === "update" || step === "local_install" || step === "local_failed") && (
            <button
              className="pill sm"
              onClick={() => void (local ? connectLocal() : check(server))}
            >
              <RefreshCw aria-hidden="true" />
              {t("desktop.retry")}
            </button>
          )}
          {stack && step !== "mode" && step !== "local_starting" && (
            <button className="pill sm" onClick={() => void choose(null)}>
              <ArrowLeftRight aria-hidden="true" />
              {t("desktop.switch_mode")}
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
