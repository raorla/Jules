import type { DesktopBridge } from "@jules/ui";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

// Pont entre l'interface et le shell Tauri (src-tauri). Le jeton de session vit dans le trousseau du
// système ; l'adresse du serveur, qui n'est pas secrète, dans le stockage de la webview.

const SERVER_KEY = "jules.server";

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
    async notify(notification) {
      if (!(await isPermissionGranted()) && (await requestPermission()) !== "granted") {
        return;
      }
      await invoke("notify", { ...notification });
    },
    setTrayCount: (count) => invoke("set_tray_count", { count }),
    openInEditor: (path) => invoke("open_in_editor", { path }),
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
