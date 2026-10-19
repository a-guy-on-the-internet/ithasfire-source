import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanStatusCode } from "@opentelemetry/api";

import { createOpenTelemetryTracerAdapter } from "../opentelemetry-tracer";

describe("createOpenTelemetryTracerAdapter", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    exporter.reset();
  });

  it("records attributes and marks span success", async () => {
    const tracer = trace.getTracer("test");
    const adapter = createOpenTelemetryTracerAdapter({ tracer });

    await adapter.withSpan(
      "fetch-hot-events",
      async (span) => {
        span.setAttribute("tickets.count", 5);
        span.addEvent("fetched");
      },
      { attributes: { env: "test" } },
    );

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe("fetch-hot-events");
    expect(span.attributes["tickets.count"]).toBe(5);
    expect(span.attributes.env).toBe("test");
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it("marks spans as error when function throws", async () => {
    const tracer = trace.getTracer("test");
    const adapter = createOpenTelemetryTracerAdapter({ tracer });

    await expect(
      adapter.withSpan("error-span", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("injects and extracts context for propagation", async () => {
    const tracer = trace.getTracer("test");
    const adapter = createOpenTelemetryTracerAdapter({ tracer });

    let extractedContext: ReturnType<typeof adapter.extract>;
    await adapter.withSpan("parent", async () => {
      const carrier: Record<string, string> = {};
      adapter.inject(carrier, (obj, key, value) => {
        if (typeof obj === "object" && obj) {
          (obj as Record<string, string>)[key] = value;
        }
      });

      extractedContext = adapter.extract(carrier, (obj, key) => {
        if (typeof obj !== "object" || !obj) {
          return undefined;
        }
        return (obj as Record<string, string>)[key];
      });

      expect(extractedContext?.traceId).toBeDefined();
    });

    await adapter.withSpan("child", async () => {}, {
      parent: extractedContext,
    });

    const spans = exporter.getFinishedSpans();
    const childSpan = spans.find((span) => span.name === "child");
    expect(childSpan?.spanContext().traceId).toBe(extractedContext?.traceId);
    expect(childSpan?.parentSpanId).toBe(extractedContext?.spanId);
  });
});
