import { setTimeout as delay } from "node:timers/promises";
import type { ZodTypeAny } from "zod";

import {
  CommsPortError,
  type BatchResult,
  type SendResult,
} from "@th/ports/comms/index";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { IdempotencyPort } from "@th/ports/idempotency";

export const DEFAULT_IDEMPOTENCY_TTL_SEC = 120;

export type ParseSchema = ZodTypeAny;

export type AdapterLogger = LoggerPort | undefined;
export type AdapterMetrics = MetricsPort | undefined;
export type AdapterIdempotency = IdempotencyPort | undefined;

export type CommsChannel = "mail" | "sms" | "inapp" | "push";

export interface ChannelMetricNames {
  sent: string;
  error: string;
  latency: string;
  invalidToken?: string;
}

export const CHANNEL_METRICS: Record<CommsChannel, ChannelMetricNames> = {
  mail: {
    sent: "comms.mail.sent",
    error: "comms.mail.error",
    latency: "comms.mail.latency",
  },
  sms: {
    sent: "comms.sms.sent",
    error: "comms.sms.error",
    latency: "comms.sms.latency",
  },
  inapp: {
    sent: "comms.inapp.published",
    error: "comms.inapp.error",
    latency: "comms.inapp.latency",
  },
  push: {
    sent: "comms.push.sent",
    error: "comms.push.failed",
    latency: "comms.push.latency",
    invalidToken: "comms.push.invalid_token",
  },
};

export const composeMetricTags = (
  channel: CommsChannel,
  extra?: Record<string, string | undefined>,
): Record<string, string> => {
  const base: Record<string, string> = { channel };
  if (!extra) {
    return base;
  }
  const result: Record<string, string> = { channel };
  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === "string" && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
};

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  operation: string;
  logger?: LoggerPort;
  onRetry?: (params: {
    attempt: number;
    error: unknown;
    delayMs: number;
  }) => void;
  onGiveUp?: (params: { attempt: number; error: unknown }) => void;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /**
   * Scrubs text before an error is logged or wrapped in the exhausted error.
   * The SMS adapter passes `redactPhoneNumbers`: provider text can echo the
   * destination. Off by default so mail and push logs keep their digits.
   */
  redact?: (text: string) => string;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_JITTER_MS = 200;

export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY_ATTEMPTS);
  const baseDelay = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelay = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const jitter = options.jitterMs ?? DEFAULT_RETRY_JITTER_MS;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = options.shouldRetry?.(error, attempt) ?? false;
      if (!retryable) {
        throw error;
      }
      if (attempt >= attempts) {
        options.onGiveUp?.({ attempt, error });
        throw createTransientExhaustedError(
          options.operation,
          error,
          attempt,
          options.redact,
        );
      }

      const exponential = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
      const jitterOffset = Math.floor((Math.random() - 0.5) * 2 * jitter);
      const delayMs = Math.max(0, exponential + jitterOffset);

      options.logger?.warn(`${options.operation}.retry`, {
        attempt,
        delayMs,
        error: serializeError(error, options.redact),
      });
      options.onRetry?.({ attempt, error, delayMs });
      await delay(delayMs);
    }
  }

  throw (
    lastError ??
    new CommsPortError("transient", `${options.operation}_failed`, {
      reason: "unknown_error",
    })
  );
}

export function serializeError(
  error: unknown,
  redact?: (text: string) => string,
): Record<string, unknown> {
  if (!error) {
    return { message: "unknown" };
  }
  if (isCommsPortError(error)) {
    return {
      code: error.code,
      message: redact ? redact(error.message) : error.message,
      details: redact
        ? (redactDeep(error.details ?? null, redact) as unknown)
        : (error.details ?? null),
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: redact ? redact(error.message) : error.message,
    };
  }
  if (typeof error === "object") {
    const plain = { ...error } as Record<string, unknown>;
    return redact
      ? (redactDeep(plain, redact) as Record<string, unknown>)
      : plain;
  }
  return { message: redact ? redact(String(error)) : String(error) };
}

const MAX_REDACT_DEPTH = 5;

/** Keys whose values are ids, not free text: a UUID's digit runs can match the phone pattern. */
const REDACT_SKIP_KEYS = new Set(["requestId", "name"]);

/**
 * Applies `redact` to every string inside a plain value, without mutating
 * it. Depth is bounded (a cycle ends in "[truncated]"); Date becomes its ISO
 * string and other non-plain objects (Buffer, Map, Set) become "[object]".
 */
export function redactDeep(
  value: unknown,
  redact: (text: string) => string,
  depth = 0,
): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, redact, depth + 1));
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return "[object]";
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      REDACT_SKIP_KEYS.has(key) ? item : redactDeep(item, redact, depth + 1),
    ]),
  );
}

const createTransientExhaustedError = (
  operation: string,
  error: unknown,
  attempt: number,
  redact?: (text: string) => string,
) =>
  new CommsPortError("transient", `${operation}_retry_exhausted`, {
    attempt,
    lastError: serializeError(error, redact),
  });

const isCommsPortError = (error: unknown): error is CommsPortError =>
  error instanceof CommsPortError;

export const ensureArray = <T>(value: T | T[]): T[] =>
  Array.isArray(value) ? value : [value];

export function parseInput<T>(schema: ParseSchema, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data as T;
  }

  const issue = parsed.error.issues[0];
  const message = issue?.message ?? "invalid_input";
  throw new CommsPortError("invalid_input", message, {
    path: issue?.path ?? [],
  });
}

export interface IdempotencyResult<T> {
  fresh: boolean;
  result: T;
}

export interface IdempotencySendPayload<T extends SendResult> {
  result: T;
  vendorMessageId?: string;
  metadata?: Record<string, unknown>;
}

export interface IdempotencyOptions<T extends SendResult> {
  key?: string;
  idempotency?: IdempotencyPort;
  ttlSec?: number;
  keepSec?: number;
  logger?: LoggerPort;
  /** Scrubs the failure text stored in the idempotency record. */
  redact?: (text: string) => string;
  run: () => Promise<IdempotencySendPayload<T>>;
}

export async function runWithIdempotency<T extends SendResult>(
  options: IdempotencyOptions<T>,
): Promise<IdempotencyResult<IdempotencySendPayload<T>>> {
  const key = options.key;
  const idem = options.idempotency;

  if (!key || !idem) {
    const freshPayload = await options.run();
    return { fresh: true, result: freshPayload };
  }

  const cached = (await idem.get<IdempotencySendPayload<T>>(key)) ?? null;
  if (cached) {
    return {
      fresh: false,
      result: {
        ...cached,
        result: {
          ...cached.result,
          idempotentReplay: true,
        },
      },
    };
  }

  const ttlSec = options.ttlSec ?? DEFAULT_IDEMPOTENCY_TTL_SEC;
  const acquired = await idem.begin(key, ttlSec);
  if (!acquired) {
    const inFlight = (await idem.get<IdempotencySendPayload<T>>(key)) ?? null;
    if (inFlight) {
      return {
        fresh: false,
        result: {
          ...inFlight,
          result: {
            ...inFlight.result,
            idempotentReplay: true,
          },
        },
      };
    }

    throw new CommsPortError("transient", "idempotency_conflict", {
      key,
    });
  }

  try {
    const payload = await options.run();
    await idem.commit(key, payload, options.keepSec ?? ttlSec);
    return { fresh: true, result: payload };
  } catch (error) {
    const message = (error as Error)?.message ?? "unknown_error";
    await idem.fail(key, options.redact ? options.redact(message) : message);
    throw error;
  }
}

export function buildBatchResult(
  results: SendResult[],
): BatchResult<SendResult> {
  let okCount = 0;
  let errorCount = 0;
  for (const result of results) {
    if (result.success) {
      okCount += 1;
    } else {
      errorCount += 1;
    }
  }

  return {
    results,
    okCount,
    errorCount,
  };
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  if (size <= 0) {
    return [items.slice()];
  }
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  iterator: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = limit > 0 ? Math.min(limit, items.length) : items.length;
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        break;
      }
      nextIndex += 1;
      // currentIndex is within bounds due to guard above.
      const item = items[currentIndex]!;
      results[currentIndex] = await iterator(item, currentIndex);
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}

export function createAdapterLogger(
  logger: LoggerPort | undefined,
  adapter: string,
  op: string,
): LoggerPort | undefined {
  return logger?.child({ adapter, op });
}

export interface LatencyRecorderOptions {
  metrics?: MetricsPort;
  metricName: string;
  tags?: Record<string, string>;
}

export async function recordLatency<T>(
  fn: () => Promise<T>,
  options: LatencyRecorderOptions,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - startedAt;
    options.metrics?.record(options.metricName, duration, options.tags);
  }
}

export function successResult(overrides?: Partial<SendResult>): SendResult {
  return {
    success: true,
    ...overrides,
  };
}

export function errorResult(
  code: SendResult["errorCode"],
  message: string,
  details?: unknown,
): SendResult {
  return {
    success: false,
    errorCode: code,
    errorMessage: message,
    details,
  };
}
