import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "./webhooks.js";

// Vecteur de test publié par GitHub (« Validating webhook deliveries »).
const secret = "It's a Secret to Everybody";
const body = Buffer.from("Hello, World!");
const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("signature des webhooks", () => {
  it("reproduit le vecteur de GitHub", () => {
    expect(signWebhook(secret, body)).toBe(signature);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
  });

  it.each([
    ["absente", undefined],
    ["sans préfixe", signature.slice(7)],
    ["en SHA-1", "sha1=757107ea0eb2509fc211221cce984b8a37570b6d"],
    ["tronquée", signature.slice(0, -2)],
    ["fausse", signature.replace("757", "758")],
  ])("refuse une signature %s", (_, header) => {
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it("refuse un corps modifié ou un autre secret", () => {
    expect(verifyWebhookSignature(secret, Buffer.from("Hello, World?"), signature)).toBe(false);
    expect(verifyWebhookSignature("autre", body, signature)).toBe(false);
  });
});
