import { SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

// Traces OpenTelemetry (ARCHITECTURE.md §16) : tâche → phase → exécution → appel d'outil, appel
// modèle ou effet. Sans SDK démarré (OTEL_EXPORTER_OTLP_ENDPOINT absent), l'API ne fait rien.

const tracer = trace.getTracer("jules-worker");

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Démarre le SDK seulement si un collecteur est configuré ; renvoie de quoi l'arrêter proprement. */
export async function startTracing(
  env: Record<string, string | undefined>,
): Promise<(() => Promise<void>) | undefined> {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return undefined;
  }
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const sdk = new NodeSDK({
    serviceName: env.OTEL_SERVICE_NAME ?? "jules-worker",
    traceExporter: new OTLPTraceExporter(),
  });
  sdk.start();
  return () => sdk.shutdown();
}
