import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// DoD M9 : un desktop trop ancien demande une mise à jour ; une approbation DevOps se donne depuis
// une notification. Le pont Tauri est simulé ; tout le reste est réel (api, PKCE, base).

const API = "http://localhost:4310";
const GITHUB = "http://127.0.0.1:4311";

/** La connexion que ferait le shell Tauri : PKCE, navigateur, retour sur l'adresse de bouclage. */
async function pkceLogin(server: string): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const cookies: string[] = [];
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      cookies.push(cookie.split(";")[0] ?? "");
    }
  };
  await fetch(`${GITHUB}/__as`, { method: "POST", body: JSON.stringify({ login: "root" }) });
  const start = await fetch(
    `${server}/v1/auth/github?client=desktop&challenge=${challenge}&redirect=${encodeURIComponent("http://127.0.0.1:59999/callback")}&state=etat-desktop-0123456789`,
    { redirect: "manual" },
  );
  remember(start);
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = await fetch(authorize.headers.get("location") ?? "", {
    redirect: "manual",
    headers: { cookie: cookies.join("; ") },
  });
  const back = new URL(callback.headers.get("location") ?? "");
  expect(back.searchParams.get("state")).toBe("etat-desktop-0123456789");
  return { code: back.searchParams.get("code") ?? "", verifier };
}

async function openDesktop(page: Page, version: string) {
  await page.exposeFunction("julesTestLogin", pkceLogin);
  await page.addInitScript((appVersion) => {
    const w = window as unknown as Record<string, unknown> & {
      julesTestLogin: (s: string) => Promise<unknown>;
    };
    const notifications: unknown[] = [];
    w.__notifications = notifications;
    w.__JULES_DESKTOP_BRIDGE__ = {
      version: appVersion,
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
      login: (server: string) => w.julesTestLogin(server),
      notify: (n: unknown) => Promise.resolve(void notifications.push(n)),
      setTrayCount: (count: number) => Promise.resolve(void (w.__tray = count)),
      openInEditor: () => Promise.resolve(),
      onNavigate: (handler: unknown) => {
        w.__navigate = handler;
        return () => undefined;
      },
    };
  }, version);
  await page.goto("/");
}

test("un desktop trop ancien demande une mise à jour au lieu de se connecter", async ({ page }) => {
  await openDesktop(page, "0.0.9");
  await page.getByRole("textbox", { name: "Adresse de ton serveur Jules" }).fill(API);
  await page.getByRole("button", { name: "Vérifier le serveur" }).click();
  await expect(page.getByRole("alert")).toContainText("Mise à jour requise");
  await expect(page.getByRole("alert")).toContainText("au moins la version 0.1.0");
  await expect(page.getByRole("button", { name: "Se connecter avec GitHub" })).toHaveCount(0);
});

test("connexion par PKCE, puis approbation DevOps depuis une notification", async ({
  page,
  request,
}) => {
  await openDesktop(page, "0.1.0");
  await page.getByRole("textbox", { name: "Adresse de ton serveur Jules" }).fill(API);
  await page.getByRole("button", { name: "Vérifier le serveur" }).click();
  await page.getByRole("button", { name: "Se connecter avec GitHub" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem("token:http://localhost:4310"));
  expect(token).toMatch(/^jds_/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __tray?: number }).__tray))
    .toBeGreaterThan(0);

  // Un nouveau plan de staging arrive : une notification native, qui nomme l'environnement.
  const { id } = (await (await request.post(`${GITHUB}/__plan`)).json()) as { id: string };
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __notifications: { body: string }[] }).__notifications.length,
        ),
      { timeout: 15_000 },
    )
    .toBe(1);
  const [notification] = await page.evaluate(
    () =>
      (window as unknown as { __notifications: { body: string; route: string }[] }).__notifications,
  );
  expect(notification).toEqual({
    title: "Jules",
    body: "Staging · web-staging : approbation demandée",
    route: `/approvals?plan=${id}`,
  });

  // Clic sur la notification : le plan s'ouvre, le bouton d'approbation a le focus.
  await page.evaluate((route) => {
    (window as unknown as { __navigate: (r: string) => void }).__navigate(route);
  }, notification!.route);
  const card = page.locator(".ac", { hasText: "Redémarrer le cache" });
  await expect(card.getByRole("button", { name: "Approuver", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText("Décision envoyée : Jules la vérifie.");
  const commands = (await (await request.get(`${GITHUB}/__commands`)).json()) as {
    name: string;
    source: string;
    decision: string;
  }[];
  expect(commands[0]).toEqual({ name: "approve", source: "desktop", decision: "pending" });
});
