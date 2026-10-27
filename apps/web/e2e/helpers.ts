import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";

const GITHUB = "http://127.0.0.1:4311";

/** Connexion par le vrai parcours OAuth, avec le faux GitHub qui répond pour `login`. */
export async function loginAs(page: Page, request: APIRequestContext, login: string) {
  await request.post(`${GITHUB}/__as`, { data: { login } });
  await page.goto("/");
  await page.getByRole("link", { name: "Se connecter avec GitHub" }).click();
  await page.getByRole("navigation").waitFor();
}

export async function lastCommand(request: APIRequestContext) {
  const rows = (await (await request.get(`${GITHUB}/__commands`)).json()) as {
    name: string;
    source: string;
    decision: string;
  }[];
  return rows[0];
}

/** Authentificateur virtuel de Chromium (CDP) : une vraie cérémonie WebAuthn, sans matériel. */
export async function addVirtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
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
}

/**
 * Demande de confirmation d'un desktop connecté, comme la crée l'app : connexion PKCE du shell, puis
 * `POST /v1/step-up/browser` avec le jeton porteur. La page `/stepup` l'ouvre ensuite sans session.
 */
export async function desktopStepUpRequest(
  request: APIRequestContext,
  login: string,
  purpose: string,
): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await request.post(`${GITHUB}/__as`, { data: { login } });
  const redirect = encodeURIComponent("http://127.0.0.1:59999/callback");
  const start = await request.get(
    `/v1/auth/github?client=desktop&challenge=${challenge}&redirect=${redirect}&state=etat-desktop-0123456789`,
    { maxRedirects: 0 },
  );
  const authorize = await request.get(start.headers().location ?? "", { maxRedirects: 0 });
  const callback = await request.get(authorize.headers().location ?? "", { maxRedirects: 0 });
  const code = new URL(callback.headers().location ?? "").searchParams.get("code");
  const exchange = await request.post("/v1/auth/desktop/token", { data: { code, verifier } });
  const { token } = (await exchange.json()) as { token: string };
  const created = await request.post("/v1/step-up/browser", {
    headers: { authorization: `Bearer ${token}` },
    data: { purpose },
  });
  return ((await created.json()) as { request: string }).request;
}
