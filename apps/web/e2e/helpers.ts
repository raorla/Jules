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
