import { createHmac, timingSafeEqual } from "node:crypto";

// Signature des webhooks GitHub : HMAC-SHA256 du corps brut, en-tête X-Hub-Signature-256.

export function signWebhook(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith("sha256=")) {
    return false;
  }
  const expected = Buffer.from(signWebhook(secret, body), "utf8");
  const received = Buffer.from(header, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
