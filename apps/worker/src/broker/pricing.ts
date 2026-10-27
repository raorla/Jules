// Prix par million de tokens (USD). Le budget appliqué par le proxy modèle en dépend.
// Un modèle inconnu est compté au prix le plus élevé : mieux vaut couper trop tôt que trop tard.

export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
};
const MOST_EXPENSIVE = PRICES["claude-fable-5-1"] as Price;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function priceOf(model: string): Price {
  const key = Object.keys(PRICES).find(
    (k) => model === k || model.startsWith(`${k}-`) || model.startsWith(`${k}[`),
  );
  return key ? (PRICES[key] as Price) : MOST_EXPENSIVE;
}

export function costUsd(model: string, usage: Usage): number {
  const p = priceOf(model);
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
