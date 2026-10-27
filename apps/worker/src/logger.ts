import pino from "pino";

// Logs JSON. Les chemins qui peuvent porter un secret sont masqués (ARCHITECTURE.md §16).
export function createLogger(level: string) {
  return pino({
    level,
    base: { service: "worker" },
    redact: {
      paths: [
        "*.token",
        "*.privateKey",
        "*.password",
        "*.authorization",
        "*.headers.authorization",
      ],
      censor: "[masqué]",
    },
  });
}
