import {
  context as otelContext,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  createTraceState,
  type Attributes,
  type AttributeValue,
  type Context,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type TextMapGetter,
  type TextMapSetter,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorage } from "node:async_hooks";

import type {
  TelemetryAttributes,
  TelemetryGetter,
  TelemetryPort,
  TelemetrySetter,
  TelemetrySpan,
  TelemetrySpanContext,
  TelemetrySpanKind,
  TelemetrySpanLink,
  TelemetrySpanOptions,
} from "@th/ports/telemetry";

class OtelSpanAdapter implements TelemetrySpan {
  constructor(private readonly span: Span) {}

  addEvent(name: string, attributes?: TelemetryAttributes): void {
    this.span.addEvent(name, toSpanAttributes(attributes));
  }

  setAttribute(name: string, value: TelemetryAttributes[string]): void {
    const normalized = toSpanAttributeValue(value);
    if (typeof normalized === "undefined") {
      return;
    }
    this.span.setAttribute(name, normalized);
  }

  recordException(error: unknown, attributes?: TelemetryAttributes): void {
    this.span.recordException(error as Error);
    const normalizedAttributes = toSpanAttributes(attributes);
    if (normalizedAttributes) {
      this.span.addEvent("exception", normalizedAttributes);
    }
  }

  end(): void {
    this.span.end();
  }
}

export type CreateOpenTelemetryTracerAdapterOptions = {
  tracer?: Tracer;
};

export function createOpenTelemetryTracerAdapter(
  options: CreateOpenTelemetryTracerAdapterOptions = {},
): TelemetryPort {
  const tracer = options.tracer ?? trace.getTracer("ithasfire");
  return new OpenTelemetryTracerAdapter(tracer);
}

class OpenTelemetryTracerAdapter implements TelemetryPort {
  private readonly spanContextStorage = new AsyncLocalStorage<SpanContext>();

  constructor(private readonly tracer: Tracer) {}

  async withSpan<T>(
    name: string,
    fn: (span: TelemetrySpan) => Promise<T>,
    options?: TelemetrySpanOptions,
  ): Promise<T> {
    const parentContext = options?.parent
      ? trace.setSpanContext(
          otelContext.active(),
          toSpanContext(options.parent),
        )
      : otelContext.active();

    const otelOptions: SpanOptions = {
      attributes: toSpanAttributes(options?.attributes),
      kind: mapSpanKind(options?.kind),
      links: options?.links?.map(toSpanLink),
    };

    const span = this.tracer.startSpan(name, otelOptions, parentContext);
    const spanAdapter = new OtelSpanAdapter(span);

    const runWithContext = async () => {
      try {
        const result = await fn(spanAdapter);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    };

    return this.spanContextStorage.run(span.spanContext(), () =>
      otelContext.with(trace.setSpan(parentContext, span), runWithContext),
    );
  }

  inject(
    carrier: unknown,
    setter: TelemetrySetter,
    context?: TelemetrySpanContext,
  ): void {
    const spanContext = context
      ? toSpanContext(context)
      : (trace.getSpan(otelContext.active())?.spanContext() ??
        this.spanContextStorage.getStore());
    const ctx: Context | undefined = spanContext
      ? trace.setSpanContext(otelContext.active(), spanContext)
      : undefined;
    propagation.inject(
      ctx ?? otelContext.active(),
      carrier,
      toTextMapSetter(setter),
    );
  }

  extract(
    carrier: unknown,
    getter: TelemetryGetter,
  ): TelemetrySpanContext | undefined {
    const ctx = propagation.extract(
      otelContext.active(),
      carrier,
      toTextMapGetter(getter),
    );
    const spanContext = trace.getSpanContext(ctx);
    if (!spanContext) {
      return undefined;
    }
    return fromSpanContext(spanContext);
  }
}

function mapSpanKind(kind?: TelemetrySpanKind): SpanKind | undefined {
  if (!kind) {
    return undefined;
  }

  switch (kind) {
    case "client":
      return SpanKind.CLIENT;
    case "server":
      return SpanKind.SERVER;
    case "producer":
      return SpanKind.PRODUCER;
    case "consumer":
      return SpanKind.CONSUMER;
    default:
      return SpanKind.INTERNAL;
  }
}

function toSpanLink(link: TelemetrySpanLink): Link {
  return {
    context: toSpanContext(link.context),
    attributes: toSpanAttributes(link.attributes),
  };
}

function toSpanContext(context: TelemetrySpanContext) {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags: context.traceFlags ?? TraceFlags.NONE,
    traceState: context.traceState
      ? createTraceState(context.traceState)
      : undefined,
  };
}

function fromSpanContext(spanContext: SpanContext): TelemetrySpanContext {
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    traceFlags: spanContext.traceFlags,
    traceState: spanContext.traceState?.serialize(),
  };
}

function toTextMapSetter(setter: TelemetrySetter): TextMapSetter {
  return {
    set(carrier, key, value) {
      setter(carrier, key, value);
    },
  };
}

function toTextMapGetter(getter: TelemetryGetter): TextMapGetter {
  return {
    get(carrier, key) {
      return getter(carrier, key);
    },
    keys(carrier) {
      if (typeof carrier !== "object" || carrier === null) {
        return [];
      }
      return Object.keys(carrier as Record<string, unknown>);
    },
  };
}

function toSpanAttributes(
  attributes?: TelemetryAttributes,
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const normalized: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const attrValue = toSpanAttributeValue(value);
    if (typeof attrValue === "undefined") {
      continue;
    }
    normalized[key] = attrValue;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function toSpanAttributeValue(
  value: TelemetryAttributes[string],
): AttributeValue | undefined {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [] as string[];
    }
    const firstType = typeof value[0];
    if (
      (firstType === "string" ||
        firstType === "number" ||
        firstType === "boolean") &&
      value.every((item) => typeof item === firstType)
    ) {
      return value as AttributeValue;
    }
    return value.map((item) => String(item)) as string[];
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  return undefined;
}
