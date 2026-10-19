import type { TelemetryPort } from "@th/ports/telemetry";
import { createOpenTelemetryTracerAdapter } from "./opentelemetry-tracer";

// Lazy import SDK pieces to avoid pulling heavy deps during build-time
// or in environments that don't use the SDK (e.g., some tests).
type NodeSDK = import("@opentelemetry/sdk-node").NodeSDK;

export type OtelBootstrap = {
  telemetry: TelemetryPort;
  shutdown: () => Promise<void>;
};

/**
 * Initialize the OpenTelemetry Node SDK with an OTLP HTTP exporter.
 *
 * Environment variables considered:
 * - OTEL_SERVICE_NAME (fallback: "ithasfire")
 * - OTEL_EXPORTER_OTLP_ENDPOINT (OTLP HTTP endpoint)
 * - OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG (sampling)
 */
export async function initOpenTelemetry(): Promise<OtelBootstrap> {
  const telemetry = createOpenTelemetryTracerAdapter();

  // If there's no OTLP endpoint configured, return a no-op shutdown but
  // keep the adapter so code can still create spans (they'll be no-ops
  // until an SDK/exporter is registered).
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpEndpoint) {
    return {
      telemetry,
      shutdown: async () => Promise.resolve(),
    };
  }

  // Dynamically import SDK and exporter so packages that don't run the
  // full SDK don't need the dependencies at runtime.
  const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
  ]);

  const { Resource } = await import("@opentelemetry/resources");
  const { SemanticResourceAttributes } =
    await import("@opentelemetry/semantic-conventions");

  const serviceName = process.env.OTEL_SERVICE_NAME ?? "ithasfire";

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
  }) as unknown as NodeSDK;

  // Start the SDK so exporters/processors are registered with the
  // OpenTelemetry global API used by the adapter.
  await sdk.start();

  return {
    telemetry,
    shutdown: async () => {
      try {
        await sdk.shutdown();
      } catch (err) {
        // Best-effort: log and swallow to avoid crashing shutdown paths.
        // Application logger isn't available here; use console as fallback.
        // eslint-disable-next-line no-console
        console.error("otel sdk shutdown error:", err);
      }
    },
  };
}
