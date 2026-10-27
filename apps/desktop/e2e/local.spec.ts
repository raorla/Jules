import { expect, test, type Page } from "@playwright/test";

// M10 : le mode local du desktop. Choix du mode au premier lancement, clé API rangée dans le trousseau,
// pile locale (simulée par le pont), connexion par le secret du trousseau, niveau d'isolation affiché,
// dossiers de la machine, merge par le bouton, puis passage au mode connecté sans réinstaller. L'api,
// la base et les dossiers git sont réels.

const LOCAL_API = "http://localhost:4330";
const CONTROL = "http://127.0.0.1:4331";
const SECRET = "secret-de-connexion-local-des-tests-e2e-0123456789";
const API_KEY = ["sk-ant", "api03", "cle-de-test-e2e-0123456789"].join("-");

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
      // Le trousseau simulé survit au rechargement de la page, comme le vrai.
      const apiKeys = (): string[] =>
        JSON.parse(sessionStorage.getItem("jules.test.apikeys") ?? "[]") as string[];
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
          hasApiKey: () => Promise.resolve(apiKeys().length > 0),
          setApiKey: (key: string) => {
            sessionStorage.setItem("jules.test.apikeys", JSON.stringify([...apiKeys(), key]));
            return Promise.resolve(status);
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
  // La clé API, une fois, avant le premier démarrage : elle va au trousseau, la pile ne démarre qu'après.
  const key = page.getByLabel("Clé API Anthropic");
  await expect(key).toHaveAttribute("type", "password");
  expect(await page.evaluate(() => (window as unknown as { __started: number }).__started)).toBe(0);
  await key.fill(`  ${API_KEY}  `);
  await page.getByRole("button", { name: "Enregistrer dans le trousseau" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __started: number }).__started)).toBe(1);
  const keys = () =>
    page.evaluate(
      () => JSON.parse(sessionStorage.getItem("jules.test.apikeys") ?? "[]") as string[],
    );
  expect(await keys()).toEqual([`  ${API_KEY}  `]);
  const token = await page.evaluate(() => sessionStorage.getItem("token:http://localhost:4330"));
  expect(token).toMatch(/^jds_/);
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

  // La clé se remplace depuis les réglages ; elle n'est jamais réaffichée.
  const apiKey = page.locator(".card", { hasText: "Rangée dans le trousseau du système" });
  await expect(apiKey).not.toContainText(API_KEY);
  await apiKey.getByLabel("Nouvelle clé API Anthropic").fill(`${API_KEY}-2`);
  await apiKey.getByRole("button", { name: "Remplacer la clé" }).click();
  await expect(apiKey.getByRole("status")).toHaveText("Clé remplacée, le worker l'a reçue.");
  await expect(apiKey.getByLabel("Nouvelle clé API Anthropic")).toHaveValue("");
  expect(await keys()).toEqual([`  ${API_KEY}  `, `${API_KEY}-2`]);

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
        hasApiKey: () => Promise.reject(new Error("jamais appelé")),
        setApiKey: () => Promise.reject(new Error("jamais appelé")),
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
