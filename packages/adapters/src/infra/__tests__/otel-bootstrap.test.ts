import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkStartSpy = vi.fn<[], Promise<void>>().mockResolvedValue();
const sdkShutdownSpy = vi.fn<[], Promise<void>>().mockResolvedValue();
const exporterCtorSpy = vi.fn();

vi.mock("@opentelemetry/sdk-node", () => {
  class MockNodeSDK {
    start = sdkStartSpy;
    shutdown = sdkShutdownSpy;
  }

  return { NodeSDK: MockNodeSDK };
});

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => {
  class MockExporter {
    constructor(options?: { url?: string }) {
      exporterCtorSpy(options);
    }
  }

  return { OTLPTraceExporter: MockExporter };
});

vi.mock("@opentelemetry/resources", () => {
  class MockResource {
    attributes: Record<string, unknown>;

    constructor(attrs: Record<string, unknown>) {
      this.attributes = attrs;
    }
  }

  return { Resource: MockResource };
});

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: { SERVICE_NAME: "service.name" },
}));

async function loadBootstrap() {
  return import("../otel-bootstrap");
}

describe("initOpenTelemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
  });

  afterEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
  });

  it("returns telemetry with noop shutdown when OTLP endpoint missing", async () => {
    const { initOpenTelemetry } = await loadBootstrap();

    const bootstrap = await initOpenTelemetry();

    expect(typeof bootstrap.telemetry.withSpan).toBe("function");
    await expect(bootstrap.shutdown()).resolves.toBeUndefined();
    expect(sdkStartSpy).not.toHaveBeenCalled();
    expect(sdkShutdownSpy).not.toHaveBeenCalled();
    expect(exporterCtorSpy).not.toHaveBeenCalled();
  });

  it("starts NodeSDK and wires exporter when endpoint provided", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://collector:4318/v1/traces";
    process.env.OTEL_SERVICE_NAME = "api";

    const { initOpenTelemetry } = await loadBootstrap();
    const bootstrap = await initOpenTelemetry();

    expect(sdkStartSpy).toHaveBeenCalledTimes(1);
    expect(exporterCtorSpy).toHaveBeenCalledWith({
      url: "http://collector:4318/v1/traces",
    });

    await bootstrap.shutdown();
    expect(sdkShutdownSpy).toHaveBeenCalledTimes(1);
  });
});
