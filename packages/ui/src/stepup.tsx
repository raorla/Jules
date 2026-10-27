import { ExternalLink, Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api, confirmBrowserRequest } from "./api.js";

// Confirmation d'une action sensible du desktop connecté (ARCHITECTURE.md §4.7), dans le navigateur
// du système : la webview du desktop n'a pas de passkey, et son origine n'est pas celle du serveur.
// La page n'a pas de session : l'identifiant de la demande, à usage unique, désigne la session du
// desktop, et seule une passkey de sa titulaire la renforce.

type State = "loading" | "ready" | "confirming" | "done" | "no_passkey" | "failed";

export function BrowserStepUpPage() {
  const { t } = useTranslation();
  const request = new URLSearchParams(window.location.search).get("request") ?? "";
  const [state, setState] = useState<State>("loading");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | undefined>();
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  useEffect(() => {
    api<{ purpose: string }>("/v1/step-up/browser/options", {
      method: "POST",
      body: { request },
      anonymous: true,
    }).then(
      (opened) => {
        setPurpose(opened.purpose);
        setState("ready");
      },
      (e: unknown) => {
        // Pas encore de passkey : elle s'enregistre dans l'interface web, connectée.
        if (e instanceof ApiError && e.status === 409) {
          setState("no_passkey");
          return;
        }
        setError(message(e));
        setState("failed");
      },
    );
  }, [request]);

  const confirm = () => {
    setError(undefined);
    setState("confirming");
    confirmBrowserRequest(request).then(
      () => {
        setState("done");
      },
      (e: unknown) => {
        setError(message(e));
        setState("ready");
      },
    );
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card stack" style={{ padding: 32, maxWidth: 520, width: "100%" }}>
        <h1 className="headline">
          Jules
          <br />
          <span>{t("stepup_page.subtitle")}</span>
        </h1>
        {state === "loading" && (
          <p className="ink-2" role="status">
            {t("stepup_page.loading")}
          </p>
        )}
        {(state === "ready" || state === "confirming") && (
          <>
            <p className="ink-2">{t("stepup_page.text")}</p>
            <p>
              <strong>{purpose}</strong>
            </p>
            <div>
              <button className="pill primary" disabled={state === "confirming"} onClick={confirm}>
                <Fingerprint aria-hidden="true" />
                {t("stepup.confirm")}
              </button>
            </div>
          </>
        )}
        {state === "no_passkey" && (
          <>
            <p className="ink-2">{t("stepup_page.no_passkey")}</p>
            <div>
              <a className="pill" href="/settings" target="_blank" rel="noopener">
                <ExternalLink aria-hidden="true" />
                {t("stepup_page.open_web")}
              </a>
            </div>
          </>
        )}
        {state === "done" && (
          <p role="status" className="chip ok">
            {t("stepup_page.done")}
          </p>
        )}
        {error && (
          <p role="alert" className="chip crit">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
