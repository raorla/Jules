import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

// DoD M9 : un desktop trop ancien demande une mise à jour ; une approbation DevOps se donne depuis
// une notification ; une action sensible se confirme par une passkey dans le navigateur du système.
// Le pont Tauri est simulé ; tout le reste est réel (api, PKCE, base, cérémonie WebAuthn).

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
      // Comme le shell (apps/desktop/core/src/stepup.rs) : la page de confirmation du serveur.
      openStepUp: (server: string, request: string) => {
        w.__stepUp = `${server}/stepup?request=${request}`;
        return Promise.resolve();
      },
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

test("action sensible du desktop connecté : la passkey se fait dans le navigateur du système", async ({
  page,
  context,
  request,
}) => {
  await openDesktop(page, "0.1.0");
  await page.getByRole("textbox", { name: "Adresse de ton serveur Jules" }).fill(API);
  await page.getByRole("button", { name: "Vérifier le serveur" }).click();
  await page.getByRole("button", { name: "Se connecter avec GitHub" }).click();
  await page.getByRole("link", { name: "Réglages" }).click();
  // La webview n'a pas de passkey : l'app renvoie à l'interface web pour en enregistrer une.
  const passkeys = page.locator(".card", { hasText: "Passkeys" });
  await expect(passkeys).toContainText("interface web de ton serveur");
  await expect(passkeys.getByRole("button", { name: "Ajouter une passkey" })).toHaveCount(0);

  const levels = page.getByRole("group", { name: /^Repos et autonomie / }).first();
  await levels.getByRole("button", { name: "L2" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("la confirmation s'ouvre dans ton navigateur");
  await dialog.getByRole("button", { name: "Ouvrir le navigateur" }).click();
  await expect(
    dialog.getByRole("button", { name: "Confirme dans ton navigateur…" }),
  ).toBeDisabled();
  // L'app ouvre le navigateur une fois la demande créée par l'api.
  const opened = () =>
    page.evaluate(() => (window as unknown as { __stepUp?: string }).__stepUp ?? "");
  await expect.poll(opened).toMatch(/^http:\/\/localhost:4310\/stepup\?request=[A-Za-z0-9_-]{43}$/);
  const url = await opened();

  // Le navigateur du système : une autre page, sur le serveur, avec un authentificateur (CDP).
  const browser = await context.newPage();
  const cdp = await context.newCDPSession(browser);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  // La passkey s'enregistre dans l'interface web, connectée avec le même compte GitHub.
  await request.post(`${GITHUB}/__as`, { data: { login: "root" } });
  await browser.goto(`${API}/`);
  await browser.getByRole("link", { name: "Se connecter avec GitHub" }).click();
  await browser.getByRole("link", { name: "Réglages" }).click();
  await browser.getByRole("button", { name: "Ajouter une passkey" }).click();
  await expect(browser.locator(".card", { hasText: "Passkeys" }).locator(".chip")).not.toHaveCount(
    0,
  );

  await browser.goto(url);
  await expect(browser.getByText("relever l'autonomie")).toBeVisible();
  await browser.getByRole("button", { name: "Utiliser ma passkey" }).click();
  await expect(browser.getByRole("status")).toHaveText(
    "Confirmé. Retourne dans l'app Jules : l'action continue.",
  );
  // De retour dans l'app : la session du desktop est renforcée, l'action rejouée.
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  await expect(levels.getByRole("button", { name: "L2" })).toHaveAttribute("aria-pressed", "true");
  // La demande ne sert qu'une fois.
  await browser.reload();
  await expect(browser.getByRole("alert")).toContainText("demande expirée");
});
