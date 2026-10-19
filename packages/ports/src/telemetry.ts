export type TelemetryAttributePrimitive = string | number | boolean;
export type TelemetryAttributeValue =
  | TelemetryAttributePrimitive
  | TelemetryAttributePrimitive[];
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export type TelemetrySpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";

export type TelemetrySpanContext = {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  traceState?: string;
};

export type TelemetrySpanLink = {
  context: TelemetrySpanContext;
  attributes?: TelemetryAttributes;
};

export type TelemetrySpanOptions = {
  kind?: TelemetrySpanKind;
  attributes?: TelemetryAttributes;
  links?: TelemetrySpanLink[];
  parent?: TelemetrySpanContext;
};

export interface TelemetrySpan {
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  setAttribute(name: string, value: TelemetryAttributeValue): void;
  recordException(error: unknown, attributes?: TelemetryAttributes): void;
  end(): void;
}

export type TelemetryGetter = (
  carrier: unknown,
  key: string,
) => undefined | string | string[];
export type TelemetrySetter = (
  carrier: unknown,
  key: string,
  value: string,
) => void;

export interface TelemetryPort {
  withSpan<T>(
    name: string,
    fn: (span: TelemetrySpan) => Promise<T>,
    options?: TelemetrySpanOptions,
  ): Promise<T>;
  inject(
    carrier: unknown,
    setter: TelemetrySetter,
    context?: TelemetrySpanContext,
  ): void;
  extract(
    carrier: unknown,
    getter: TelemetryGetter,
  ): TelemetrySpanContext | undefined;
}
