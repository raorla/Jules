import type { DesktopBridge, DesktopMode, LocalStatus, ModelAccess } from "@jules/ui";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

// Pont entre l'interface et le shell Tauri (src-tauri). Le jeton de session, la clé maître, l'accès au
// modèle et le secret de connexion du mode local vivent dans le trousseau du système ; l'adresse du serveur
// et le mode, qui ne sont pas secrets, dans le stockage de la webview.

const SERVER_KEY = "jules.server";
const MODE_KEY = "jules.mode";

/** Mise à jour signée : le plugin vérifie la signature avec la clé publique embarquée, et refuse le reste. */
async function installUpdate(): Promise<void> {
  try {
    const update = await check();
    if (update) {
      await update.downloadAndInstall();
      await relaunch();
    }
  } catch (error) {
    // Hors ligne, ou signature refusée : l'app continue avec la version installée.
    console.warn("mise à jour impossible", error);
  }
}

export async function tauriBridge(): Promise<DesktopBridge> {
  void installUpdate();
  return {
    version: await getVersion(),
    savedServer: () => Promise.resolve(localStorage.getItem(SERVER_KEY)),
    saveServer: (url) => {
      localStorage.setItem(SERVER_KEY, url);
      return Promise.resolve();
    },
    getToken: (server) => invoke<string | null>("token_get", { server }),
    setToken: (server, token) => invoke("token_set", { server, token }),
    clearToken: (server) => invoke("token_delete", { server }),
    login: (server) => invoke<{ code: string; verifier: string }>("login", { server }),
    openStepUp: (server, request) => invoke("open_step_up", { server, request }),
    async notify(notification) {
      if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") {
        return;
      }
      await invoke("notify", { ...notification });
    },
    setTrayCount: (count) => invoke("set_tray_count", { count }),
    openInEditor: (path) => invoke("open_in_editor", { path }),
    local: {
      // Une app du mode connecté (M9) qui connaît déjà son serveur reste en mode connecté.
      savedMode: () =>
        Promise.resolve(
          (localStorage.getItem(MODE_KEY) as DesktopMode | null) ??
            (localStorage.getItem(SERVER_KEY) ? "server" : null),
        ),
      saveMode: (mode) => {
        if (mode) {
          localStorage.setItem(MODE_KEY, mode);
        } else {
          localStorage.removeItem(MODE_KEY);
        }
        return Promise.resolve();
      },
      status: () => invoke<LocalStatus>("local_status"),
      start: () => invoke<LocalStatus>("local_start"),
      stop: () => invoke("local_stop"),
      modelAccess: () => invoke<ModelAccess | null>("local_model_access"),
      setModelAccess: (kind, secret) =>
        invoke<LocalStatus>("local_set_model_access", { kind, secret }),
      confirmStepUp: (challenge, purpose) =>
        invoke<string | null>("local_confirm_step_up", { challenge, purpose }),
      loginSecret: () => invoke<{ secret: string; login: string }>("local_login_secret"),
      async pickFolder() {
        const path = await open({ directory: true, multiple: false });
        return typeof path === "string" ? invoke<string>("local_container_path", { path }) : null;
      },
    },
    onNavigate(handler) {
      const unlisten = listen<string>("navigate", (event) => {
        handler(event.payload);
      });
      return () => {
        void unlisten.then((stop) => {
          stop();
        });
      };
    },
  };
}
