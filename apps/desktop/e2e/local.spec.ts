import { expect, test, type Page } from "@playwright/test";

// M10 : le mode local du desktop. Choix du mode au premier lancement, accès au modèle (abonnement
// Claude ou clé API) rangé dans le trousseau, pile locale (simulée par le pont), connexion par le
// secret du trousseau, niveau d'isolation affiché, dossiers de la machine, merge par le bouton, puis
// passage au mode connecté sans réinstaller. L'api, la base et les dossiers git sont réels.

const LOCAL_API = "http://localhost:4330";
const CONTROL = "http://127.0.0.1:4331";
const SECRET = "secret-de-connexion-local-des-tests-e2e-0123456789";
const API_KEY = ["sk-ant", "api03", "cle-de-test-e2e-0123456789"].join("-");
const SUBSCRIPTION = ["sk-ant", "oat01", "jeton-de-test-e2e-0123456789"].join("-");

async function openLocalDesktop(page: Page, second: string) {
  await page.addInitScript(
    ({ api, secret, folder }) => {
      const w = window as unknown as Record<string, unknown>;
      const status = {
        engine: { kind: "docker", version: "29.0.0" },
        isolation: "vm",
        running: true,
        url: api,
      };
      w.__started = 0;
      // Fenêtre native simulée : elle répond selon `__accept`, puis signe comme le shell.
      w.__purposes = [];
      w.__accept = true;
      // Le trousseau simulé survit au rechargement de la page, comme le vrai : chaque accès au modèle
      // enregistré, le dernier étant celui en place.
      const saved = (): { kind: string; secret: string }[] =>
        JSON.parse(sessionStorage.getItem("jules.test.access") ?? "[]") as {
          kind: string;
          secret: string;
        }[];
      w.__JULES_DESKTOP_BRIDGE__ = {
        version: "0.1.0",
        savedServer: () => Promise.resolve(localStorage.getItem("jules.test.server")),
        saveServer: (url: string) => {
          localStorage.setItem("jules.test.server", url);
          return Promise.resolve();
        },
        getToken: (server: string) => Promise.resolve(sessionStorage.getItem(`token:${server}`)),
        setToken: (server: string, token: string) => {
          sessionStorage.setItem(`token:${server}`, token);
          return Promise.resolve();
        },
        clearToken: (server: string) => {
          sessionStorage.removeItem(`token:${server}`);
          return Promise.resolve();
        },
        login: () => Promise.reject(new Error("pas de GitHub en mode local")),
        notify: () => Promise.resolve(),
        setTrayCount: () => Promise.resolve(),
        openInEditor: () => Promise.resolve(),
        onNavigate: () => () => undefined,
        local: {
          savedMode: () => Promise.resolve(localStorage.getItem("jules.test.mode")),
          saveMode: (mode: string | null) => {
            if (mode) localStorage.setItem("jules.test.mode", mode);
            else localStorage.removeItem("jules.test.mode");
            return Promise.resolve();
          },
          status: () => Promise.resolve({ ...status, running: false, url: null }),
          start: () => {
            w.__started = (w.__started as number) + 1;
            return Promise.resolve(status);
          },
          stop: () => Promise.resolve(),
          modelAccess: () => Promise.resolve(saved().at(-1)?.kind ?? null),
          setModelAccess: (kind: string, secret: string) => {
            sessionStorage.setItem(
              "jules.test.access",
              JSON.stringify([...saved(), { kind, secret }]),
            );
            return Promise.resolve(status);
          },
          confirmStepUp: async (challenge: string, purpose: string) => {
            (w.__purposes as string[]).push(purpose);
            if (!w.__accept) {
              return null;
            }
            const key = await crypto.subtle.importKey(
              "jwk",
              {
                kty: "OKP",
                crv: "Ed25519",
                d: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
                x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
              },
              { name: "Ed25519" },
              false,
              ["sign"],
            );
            const signature = new Uint8Array(
              await crypto.subtle.sign(
                { name: "Ed25519" },
                key,
                new TextEncoder().encode(`jules:local-step-up:${challenge}`),
              ),
            );
            return btoa(String.fromCharCode(...signature))
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");
          },
          loginSecret: () => Promise.resolve({ secret, login: "ada" }),
          pickFolder: () => Promise.resolve(folder),
        },
      };
    },
    { api: LOCAL_API, secret: SECRET, folder: second },
  );
  await page.goto("/");
}

test("mode local : isolation affichée, dossiers, merge par le bouton, puis mode connecté", async ({
  page,
  request,
}) => {
  const { taskId, second } = (await (await request.get(`${CONTROL}/__setup`)).json()) as {
    taskId: string;
    second: string;
  };
  await openLocalDesktop(page, second);

  // Premier lancement : le choix du mode.
  await expect(page.getByRole("group", { name: "Où Jules doit-il travailler ?" })).toBeVisible();
  await page.getByRole("button", { name: /Sur cette machine/ }).click();
  // L'accès au modèle, une fois, avant le premier démarrage : l'abonnement Claude par défaut, avec
  // la commande qui donne le jeton. Il va au trousseau ; la pile ne démarre qu'après.
  const access = page.getByRole("group", { name: "Accès au modèle" });
  await expect(access.getByRole("button", { name: "Abonnement Claude" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByText("claude setup-token")).toBeVisible();
  const token = page.getByLabel("Jeton d'abonnement");
  await expect(token).toHaveAttribute("type", "password");
  expect(await page.evaluate(() => (window as unknown as { __started: number }).__started)).toBe(0);
  await token.fill(`  ${SUBSCRIPTION}  `);
  await page.getByRole("button", { name: "Enregistrer dans le trousseau" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __started: number }).__started)).toBe(1);
  const accesses = () =>
    page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("jules.test.access") ?? "[]") as {
          kind: string;
          secret: string;
        }[],
    );
  expect(await accesses()).toEqual([{ kind: "subscription", secret: `  ${SUBSCRIPTION}  ` }]);
  const session = await page.evaluate(() => sessionStorage.getItem("token:http://localhost:4330"));
  expect(session).toMatch(/^jds_/);
  await expect(page.locator(".topbar")).toContainText("ada");
  // Sous macOS et Windows : la VM de Docker Desktop, sans gVisor, et l'app le dit.
  const badge = page.locator(".isolation");
  await expect(badge).toHaveText("Isolation : VM");
  await expect(badge).toHaveAttribute("title", /sans gVisor/);

  // Les dossiers de la machine : celui de la tâche, puis un autre, choisi dans le sélecteur.
  await page.getByRole("link", { name: "Réglages" }).click();
  const folders = page.locator(".card", { hasText: "Dossiers de cette machine" });
  await expect(folders).toContainText("local/calculs");
  await folders.getByRole("button", { name: "Ajouter un dossier" }).click();
  await expect(folders).toContainText("local/site");
  await expect(folders).toContainText(second);

  // Action sensible : la fenêtre native du shell, sans dialogue dans la page ni passkey.
  await expect(page.locator(".card", { hasText: "Passkeys" })).toContainText("fenêtre du système");
  const levels = page.getByRole("group", { name: "Repos et autonomie local/site" });
  const purposes = () =>
    page.evaluate(() => (window as unknown as { __purposes: string[] }).__purposes);
  await page.evaluate(() => {
    (window as unknown as { __accept: boolean }).__accept = false;
  });
  await levels.getByRole("button", { name: "L1" }).click();
  await expect.poll(purposes).toEqual(["relever l'autonomie"]);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(levels.getByRole("button", { name: "L0" })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    (window as unknown as { __accept: boolean }).__accept = true;
  });
  await levels.getByRole("button", { name: "L1" }).click();
  await expect(levels.getByRole("button", { name: "L1" })).toHaveAttribute("aria-pressed", "true");
  expect(await purposes()).toHaveLength(2);

  // L'accès se remplace depuis les réglages, par une clé API par exemple ; il n'est jamais réaffiché.
  const card = page.locator(".card", { hasText: "Rangé dans le trousseau du système" });
  await expect(card).toContainText("Actuellement : Abonnement Claude");
  await expect(card).not.toContainText(SUBSCRIPTION);
  await card.getByRole("button", { name: "Clé API", exact: true }).click();
  await card.getByLabel("Clé API Anthropic").fill(API_KEY);
  await card.getByRole("button", { name: "Remplacer" }).click();
  await expect(card.getByRole("status")).toHaveText("Accès remplacé, le worker l'a reçu.");
  await expect(card.getByLabel("Clé API Anthropic")).toHaveValue("");
  await expect(card).toContainText("Actuellement : Clé API");
  expect(await accesses()).toEqual([
    { kind: "subscription", secret: `  ${SUBSCRIPTION}  ` },
    { kind: "api_key", secret: API_KEY },
  ]);

  // L'écran de review : diff, puis la demande de merge et son bouton.
  await page.goto(`/tasks/${taskId}`);
  await expect(page.locator(".diff, pre").first()).toContainText("export const mul");
  const merge = page.locator(".ac", { hasText: "Demande de merge !2" });
  await expect(merge).toContainText("jules/1-mul");
  await merge.getByRole("button", { name: "Merger dans la branche de base" }).click();
  await expect(merge.getByRole("status")).toHaveText("Merge en cours dans le dossier…");
  await request.post(`${CONTROL}/__drain`);
  await expect(merge.getByRole("status")).toContainText("Mergée (", { timeout: 10_000 });
  const { main } = (await (await request.get(`${CONTROL}/__folder`)).json()) as { main: string };
  expect(main).toBe("ada Merge !2 : feat: ajoute mul");

  // Passage au mode connecté, sans réinstaller : l'app redemande le mode, puis l'adresse du serveur.
  await page.getByRole("link", { name: "Réglages" }).click();
  await page.getByRole("button", { name: "Changer de mode" }).click();
  await page.getByRole("button", { name: /Avec un serveur Jules/ }).click();
  await expect(page.getByRole("textbox", { name: "Adresse de ton serveur Jules" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("jules.test.mode"))).toBe("server");
});

test("mode local : sans Docker ni Podman, l'app aide à en installer un", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jules.test.mode", "local");
    (window as unknown as Record<string, unknown>).__JULES_DESKTOP_BRIDGE__ = {
      version: "0.1.0",
      savedServer: () => Promise.resolve(null),
      saveServer: () => Promise.resolve(),
      getToken: () => Promise.resolve(null),
      setToken: () => Promise.resolve(),
      clearToken: () => Promise.resolve(),
      login: () => Promise.reject(new Error("non")),
      notify: () => Promise.resolve(),
      setTrayCount: () => Promise.resolve(),
      openInEditor: () => Promise.resolve(),
      onNavigate: () => () => undefined,
      local: {
        savedMode: () => Promise.resolve(localStorage.getItem("jules.test.mode")),
        saveMode: () => Promise.resolve(),
        status: () => Promise.resolve({ engine: null, isolation: null, running: false, url: null }),
        start: () => Promise.reject(new Error("jamais appelé")),
        stop: () => Promise.resolve(),
        modelAccess: () => Promise.reject(new Error("jamais appelé")),
        setModelAccess: () => Promise.reject(new Error("jamais appelé")),
        confirmStepUp: () => Promise.reject(new Error("jamais appelé")),
        loginSecret: () => Promise.reject(new Error("jamais appelé")),
        pickFolder: () => Promise.resolve(null),
      },
    };
  });
  await page.goto("/");
  const help = page.getByRole("alert");
  await expect(help).toContainText("Ni Docker ni Podman n'est installé");
  await expect(help.getByRole("link", { name: "Docker Desktop" })).toHaveAttribute(
    "href",
    "https://docs.docker.com/get-started/get-docker/",
  );
  await expect(help.getByRole("link", { name: "Podman" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Changer de mode" })).toBeVisible();
});
