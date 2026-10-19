import { randomUUID } from "node:crypto";

import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";

import {
  registerPushDeviceInputSchema,
  unregisterPushDeviceInputSchema,
  sendPushInputSchema,
  checkPushReceiptsInputSchema,
  type PushPort,
  type RegisterPushDeviceInput,
  type RegisterPushDeviceOutput,
  type UnregisterPushDeviceInput,
  type UnregisterPushDeviceOutput,
  type SendPushInput,
  type SendPushOutput,
  type CheckPushReceiptsInput,
  type CheckPushReceiptsOutput,
  type PushReceiptResult,
} from "@th/ports/comms/push";
import { CommsPortError } from "@th/ports/comms/index";
import type {
  PushDevicesRepo,
  PushDeviceRecord,
} from "@th/ports/repos/push-devices";
import type { PushReceiptsRepo } from "@th/ports/repos/push-receipts";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";

import {
  CHANNEL_METRICS,
  composeMetricTags,
  createAdapterLogger,
  chunkArray,
  parseInput,
  recordLatency,
  serializeError,
  withRetries,
  type ParseSchema,
} from "../utils";

const REGISTER_INPUT_SCHEMA =
  registerPushDeviceInputSchema as unknown as ParseSchema;
const UNREGISTER_INPUT_SCHEMA =
  unregisterPushDeviceInputSchema as unknown as ParseSchema;
const SEND_INPUT_SCHEMA = sendPushInputSchema as unknown as ParseSchema;
const CHECK_RECEIPTS_INPUT_SCHEMA =
  checkPushReceiptsInputSchema as unknown as ParseSchema;

const ADAPTER_NAME = "expo";
const VENDOR_NAME = "expo";
const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_SOUND = "default";
const SEND_RETRY_ATTEMPTS = 3;
const HEALTH_RETRY_ATTEMPTS = 2;
const RECEIPTS_RETRY_ATTEMPTS = 3;

/**
 * Max ACTIVE devices a single human may keep registered. Registering beyond
 * the cap disables the oldest-seen active device(s) (evict-oldest, never
 * reject) — see {@link PushDevicesRepo.enforceActiveDeviceCap}. Bounds abuse:
 * an authed user scripting fake `ExponentPushToken[...]` registrations can
 * never accumulate more than this many live rows, so notify() fan-out stays
 * bounded per human.
 */
export const MAX_ACTIVE_DEVICES_PER_HUMAN = 10;

/**
 * How long after a send before its receipt is worth polling. Expo's docs say
 * receipts are typically available ~15 minutes after the ticket is issued.
 */
const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;

const INVALID_TOKEN_ERRORS = new Set([
  "DeviceNotRegistered",
  "InvalidCredentials",
  "InvalidProviderToken",
  "InvalidPushToken",
]);

export interface ExpoPushAdapterOptions {
  repo: PushDevicesRepo;
  /**
   * Pending-receipt outbox. When provided, every ok send ticket is persisted
   * (best-effort) so the scheduled receipt drain can catch the
   * DeviceNotRegistered errors Expo only reports in the receipt phase.
   */
  receiptsRepo?: PushReceiptsRepo;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  expoClient?: Expo;
  accessToken?: string;
  chunkSize?: number;
}

export class ExpoPushAdapter implements PushPort {
  private readonly repo: PushDevicesRepo;
  private readonly receiptsRepo?: PushReceiptsRepo;
  private readonly logger?: LoggerPort;
  private readonly metrics?: MetricsPort;
  private readonly expo: Expo;
  private readonly chunkSize: number;

  constructor(options: ExpoPushAdapterOptions) {
    this.repo = options.repo;
    this.receiptsRepo = options.receiptsRepo;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.expo =
      options.expoClient ?? new Expo({ accessToken: options.accessToken });
    this.chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  }

  async registerDevice(
    input: RegisterPushDeviceInput,
  ): Promise<RegisterPushDeviceOutput> {
    const parsed = parseInput<RegisterPushDeviceInput>(
      REGISTER_INPUT_SCHEMA,
      input,
    );
    if (parsed.provider !== "expo") {
      throw new CommsPortError("invalid_input", "unsupported_push_provider", {
        provider: parsed.provider,
      });
    }
    if (!Expo.isExpoPushToken(parsed.token)) {
      throw new CommsPortError("invalid_input", "invalid_push_token", {
        reason: "invalid_format",
      });
    }

    await this.repo.upsert({
      humanId: parsed.humanId,
      provider: parsed.provider,
      token: parsed.token,
      platform: parsed.platform ?? "unknown",
      appId: parsed.appId ?? null,
    });

    // Per-human active-device cap (evict-oldest). The upsert above bumped
    // this device's lastSeenAt, so it always survives the eviction: only
    // stale devices beyond the MAX_ACTIVE_DEVICES_PER_HUMAN newest-seen ones
    // are disabled. Best-effort — a cap-enforcement hiccup must never fail a
    // legitimate registration that already persisted.
    try {
      const evicted = await this.repo.enforceActiveDeviceCap({
        humanId: parsed.humanId,
        maxActive: MAX_ACTIVE_DEVICES_PER_HUMAN,
      });
      if (evicted.length > 0) {
        this.logger?.warn("expo.register.device_cap_evicted", {
          humanId: parsed.humanId,
          maxActive: MAX_ACTIVE_DEVICES_PER_HUMAN,
          evictedDeviceIds: evicted,
        });
      }
    } catch (error) {
      this.logger?.warn("expo.register.device_cap_enforce_failed", {
        humanId: parsed.humanId,
        error: serializeError(error),
      });
    }

    return { ok: true };
  }

  async unregisterDevice(
    input: UnregisterPushDeviceInput,
  ): Promise<UnregisterPushDeviceOutput> {
    const parsed = parseInput<UnregisterPushDeviceInput>(
      UNREGISTER_INPUT_SCHEMA,
      input,
    );
    await this.repo.disableByHumanToken({
      humanId: parsed.humanId,
      token: parsed.token,
    });
    await this.repo.disableByToken({ provider: "expo", token: parsed.token });
    return { ok: true };
  }

  async send(input: SendPushInput): Promise<SendPushOutput> {
    const parsed = parseInput<SendPushInput>(SEND_INPUT_SCHEMA, input);
    if (parsed.topic) {
      throw new CommsPortError("invalid_input", "topic_not_supported", {
        topic: parsed.topic,
      });
    }

    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "send");
    const tags = composeMetricTags("push", {
      provider: ADAPTER_NAME,
      templateKey: parsed.template?.key,
    });

    const devices = await this.resolveTargetDevices(parsed);
    const { messages, context, invalidDevices } = this.buildMessages(
      parsed,
      devices,
      logger,
    );

    if (invalidDevices.length > 0) {
      await this.disableInvalidDevices(invalidDevices, logger, tags);
    }

    if (messages.length === 0) {
      throw new CommsPortError("invalid_input", "no_deliverable_devices", {
        reason: "no_valid_tokens",
      });
    }

    const sendResult = await recordLatency(
      () => this.dispatch(messages, context, logger, tags),
      {
        metrics: this.metrics,
        metricName: CHANNEL_METRICS.push.latency,
        tags,
      },
    );

    await this.markDeliveredDevices(sendResult.deliveredDeviceIds, logger);

    if (sendResult.successCount === 0) {
      throw new CommsPortError("dependency_failed", "push_send_failed", {
        reason: "all_failed",
        errors: sendResult.errors,
      });
    }

    this.metrics?.increment(CHANNEL_METRICS.push.sent, {
      ...tags,
      count: String(sendResult.successCount),
    });

    const id = randomUUID();
    logger?.info("expo.send.success", {
      id,
      succeeded: sendResult.successCount,
      failed: sendResult.errorCount,
      invalid: sendResult.invalidCount,
      humanId: parsed.humanId ?? null,
      deviceIds: parsed.deviceIds ?? null,
    });

    return { id };
  }

  async health() {
    const startedAt = Date.now();
    const logger = createAdapterLogger(this.logger, ADAPTER_NAME, "health");
    const tags = composeMetricTags("push", { provider: ADAPTER_NAME });
    try {
      await withRetries(() => this.expo.getPushNotificationReceiptsAsync([]), {
        operation: "expo.push.health_check",
        logger,
        attempts: HEALTH_RETRY_ATTEMPTS,
        shouldRetry: (error) => isRetryableExpoNetworkError(error),
      });
      return {
        ok: true,
        vendor: VENDOR_NAME,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      this.metrics?.increment(CHANNEL_METRICS.push.error, {
        ...tags,
        errorCode: "health_check_failed",
      });
      logger?.error("expo.health.failed", {
        error: serializeError(error),
      });
      return {
        ok: false,
        vendor: VENDOR_NAME,
        latencyMs,
        message: (error as Error)?.message ?? "unknown",
      };
    }
  }

  private async resolveTargetDevices(
    input: SendPushInput,
  ): Promise<PushDeviceRecord[]> {
    if (input.deviceIds && input.deviceIds.length > 0) {
      const devices = await this.repo.findByIds({ ids: input.deviceIds });
      return devices.filter((device) => device.enabled);
    }
    if (input.humanId) {
      return this.repo.findActiveByHuman({ humanId: input.humanId });
    }
    return [];
  }

  private buildMessages(
    input: SendPushInput,
    devices: PushDeviceRecord[],
    logger?: LoggerPort,
  ) {
    const messages: ExpoPushMessage[] = [];
    const context: PushDeviceRecord[] = [];
    const invalid: PushDeviceRecord[] = [];

    for (const device of devices) {
      if (device.provider !== "expo") {
        continue;
      }
      if (!device.enabled) {
        continue;
      }
      if (!Expo.isExpoPushToken(device.token)) {
        invalid.push(device);
        logger?.warn("expo.send.invalid_token", {
          deviceId: device.id,
          humanId: device.humanId,
        });
        continue;
      }

      const message: ExpoPushMessage = {
        to: device.token,
        title: input.title,
        body: input.body,
        data: input.data,
        sound: DEFAULT_SOUND,
      };

      if (input.collapseKey) {
        (message as { collapseId?: string }).collapseId = input.collapseKey;
      }

      messages.push(message);
      context.push(device);
    }

    return {
      messages,
      context,
      invalidDevices: invalid,
    };
  }

  private async disableInvalidDevices(
    devices: PushDeviceRecord[],
    logger: LoggerPort | undefined,
    tags: Record<string, string>,
  ) {
    if (devices.length === 0) return;
    await Promise.all(
      devices.map(async (device) => {
        try {
          await this.repo.disable({ id: device.id });
          if (CHANNEL_METRICS.push.invalidToken) {
            this.metrics?.increment(CHANNEL_METRICS.push.invalidToken, {
              ...tags,
              errorCode: "invalid_token",
            });
          }
        } catch (error) {
          logger?.error("expo.device.disable_failed", {
            deviceId: device.id,
            error: (error as Error)?.message ?? "unknown",
          });
        }
      }),
    );
  }

  private async markDeliveredDevices(
    deviceIds: string[],
    logger: LoggerPort | undefined,
  ) {
    if (deviceIds.length === 0) return;
    await Promise.all(
      deviceIds.map(async (id) => {
        try {
          await this.repo.markSeen({ id });
        } catch (error) {
          logger?.warn("expo.device.mark_seen_failed", {
            deviceId: id,
            error: serializeError(error),
          });
        }
      }),
    );
  }

  private async dispatch(
    messages: ExpoPushMessage[],
    context: PushDeviceRecord[],
    logger: LoggerPort | undefined,
    tags: Record<string, string>,
  ) {
    let successCount = 0;
    let errorCount = 0;
    let invalidCount = 0;
    const errors: Array<{ deviceId: string; code: string; message: string }> =
      [];
    const invalidDeviceIds = new Set<string>();
    const deliveredDeviceIds: string[] = [];
    const pendingReceipts: Array<{ ticketId: string; pushDeviceId: string }> =
      [];

    if (messages.length === 0) {
      return {
        successCount,
        errorCount,
        invalidCount,
        errors,
        deliveredDeviceIds,
      };
    }

    const expoChunks = this.expo.chunkPushNotifications(messages);
    const chunks = this.chunkSize
      ? expoChunks.flatMap((chunk) => chunkArray(chunk, this.chunkSize))
      : expoChunks;
    let offset = 0;

    // The bookkeeping in `finally` must run even when a LATER chunk throws:
    // a 3-chunk send failing on chunk 3 has already dispatched chunks 1-2, so
    // their ok-tickets must still be queued for the receipt drain and their
    // invalid devices still disabled — otherwise those messages become
    // invisible to the receipt phase. Both halves are internally try/caught
    // (non-fatal), so the finally can never mask the original chunk error.
    try {
      for (const chunk of chunks) {
        const chunkDevices = context.slice(offset, offset + chunk.length);
        offset += chunk.length;

        let tickets: ExpoPushTicket[];
        try {
          tickets = await withRetries(
            () => this.expo.sendPushNotificationsAsync(chunk),
            {
              operation: "expo.push.send_chunk",
              logger,
              attempts: SEND_RETRY_ATTEMPTS,
              shouldRetry: (error) => isRetryableExpoNetworkError(error),
              onRetry: ({ attempt, delayMs, error }) => {
                logger?.warn("expo.send.retry", {
                  attempt,
                  delayMs,
                  error: serializeError(error),
                });
              },
            },
          );
        } catch (error) {
          this.metrics?.increment(CHANNEL_METRICS.push.error, {
            ...tags,
            errorCode: "chunk_send_failed",
          });
          logger?.error("expo.send.chunk_failed", {
            count: chunk.length,
            error: serializeError(error),
          });
          throw new CommsPortError("dependency_failed", "push_send_failed", {
            reason: "chunk_error",
            message: (error as Error)?.message ?? "unknown",
          });
        }

        for (let index = 0; index < tickets.length; index += 1) {
          const ticket = tickets[index]!;
          const device = chunkDevices[index]!;

          if (ticket.status === "ok") {
            successCount += 1;
            deliveredDeviceIds.push(device.id);
            // An ok ticket only means Expo ACCEPTED the message — dead
            // installs (DeviceNotRegistered) often surface in the receipt
            // ~15min later. Queue the ticket for the scheduled receipt drain.
            if (ticket.id) {
              pendingReceipts.push({
                ticketId: ticket.id,
                pushDeviceId: device.id,
              });
            }
            continue;
          }

          errorCount += 1;
          const code = normalizeExpoError(ticket);
          if (code === "invalid_token") {
            invalidCount += 1;
            invalidDeviceIds.add(device.id);
            if (CHANNEL_METRICS.push.invalidToken) {
              this.metrics?.increment(CHANNEL_METRICS.push.invalidToken, {
                ...tags,
                errorCode: "invalid_token",
              });
            }
          } else {
            this.metrics?.increment(CHANNEL_METRICS.push.error, {
              ...tags,
              errorCode: code,
            });
          }

          errors.push({
            deviceId: device.id,
            code,
            message: ticket.message ?? code,
          });

          logger?.error("expo.send.error", {
            deviceId: device.id,
            error: code,
            message: ticket.message ?? null,
            details: serializeTicketDetails(ticket),
          });
        }
      }
    } finally {
      await this.disableInvalidDeviceIds(invalidDeviceIds, logger);
      await this.persistPendingReceipts(pendingReceipts, logger);
    }

    return {
      successCount,
      errorCount,
      invalidCount,
      errors,
      deliveredDeviceIds,
    };
  }

  /**
   * Disables devices whose send tickets came back with an invalid-token
   * error. Per-device try/catch: a disable hiccup is logged and never
   * escapes — this runs inside the dispatch `finally`, where a throw would
   * mask the original chunk error.
   */
  private async disableInvalidDeviceIds(
    deviceIds: Set<string>,
    logger: LoggerPort | undefined,
  ): Promise<void> {
    if (deviceIds.size === 0) return;
    await Promise.all(
      [...deviceIds].map(async (id) => {
        try {
          await this.repo.disable({ id });
        } catch (error) {
          logger?.error("expo.device.disable_failed", {
            deviceId: id,
            error: (error as Error)?.message ?? "unknown",
          });
        }
      }),
    );
  }

  /**
   * Persists ok-tickets into the pending-receipt outbox so the scheduled
   * `push.drain-receipts` job can pick up the DeviceNotRegistered errors Expo
   * only reports in the receipt phase. Strictly best-effort: the push was
   * already accepted by Expo, so a bookkeeping failure here is warn-logged
   * and must NEVER fail the send.
   */
  private async persistPendingReceipts(
    items: Array<{ ticketId: string; pushDeviceId: string }>,
    logger: LoggerPort | undefined,
  ): Promise<void> {
    if (!this.receiptsRepo || items.length === 0) return;
    try {
      await this.receiptsRepo.createMany({
        items,
        checkAfter: new Date(Date.now() + RECEIPT_CHECK_DELAY_MS),
      });
    } catch (error) {
      logger?.warn("expo.receipts.persist_failed", {
        count: items.length,
        error: serializeError(error),
      });
    }
  }

  /**
   * Looks up delivery receipts for previously issued tickets, chunked through
   * Expo's receipt endpoint, with Expo error codes normalized to the port's
   * receipt statuses (`INVALID_TOKEN_ERRORS` → `invalid_token`). Ticket ids
   * Expo no longer knows about (receipts are pruned after ~24h) are simply
   * absent from the result. A chunk failure (after retries) throws so the
   * caller leaves its rows queued for the next drain run.
   */
  async checkReceipts(
    input: CheckPushReceiptsInput,
  ): Promise<CheckPushReceiptsOutput> {
    const parsed = parseInput<CheckPushReceiptsInput>(
      CHECK_RECEIPTS_INPUT_SCHEMA,
      input,
    );
    const logger = createAdapterLogger(
      this.logger,
      ADAPTER_NAME,
      "check_receipts",
    );

    const receipts: PushReceiptResult[] = [];
    const chunks = this.expo.chunkPushNotificationReceiptIds(parsed.ticketIds);

    for (const chunk of chunks) {
      let response: Record<string, ExpoPushReceipt>;
      try {
        response = await withRetries(
          () => this.expo.getPushNotificationReceiptsAsync(chunk),
          {
            operation: "expo.push.get_receipts_chunk",
            logger,
            attempts: RECEIPTS_RETRY_ATTEMPTS,
            shouldRetry: (error) => isRetryableExpoNetworkError(error),
          },
        );
      } catch (error) {
        logger?.error("expo.receipts.chunk_failed", {
          count: chunk.length,
          error: serializeError(error),
        });
        throw new CommsPortError(
          "dependency_failed",
          "push_receipts_fetch_failed",
          {
            reason: "chunk_error",
            message: (error as Error)?.message ?? "unknown",
          },
        );
      }

      for (const [ticketId, receipt] of Object.entries(response)) {
        receipts.push(normalizeExpoReceipt(ticketId, receipt));
      }
    }

    return { receipts };
  }
}

function normalizeExpoReceipt(
  ticketId: string,
  receipt: ExpoPushReceipt,
): PushReceiptResult {
  if (receipt.status === "ok") {
    return { ticketId, status: "ok", errorCode: null, message: null };
  }
  const details = (receipt as { details?: { error?: string } }).details;
  const errorCode = details?.error ?? null;
  return {
    ticketId,
    status:
      errorCode && INVALID_TOKEN_ERRORS.has(errorCode)
        ? "invalid_token"
        : "error",
    errorCode,
    message: (receipt as { message?: string }).message ?? null,
  };
}

function normalizeExpoError(ticket: ExpoPushTicket): string {
  const details = (ticket as { details?: { error?: string } }).details;
  const detailError = details?.error;
  if (detailError && INVALID_TOKEN_ERRORS.has(detailError)) {
    return "invalid_token";
  }
  if (detailError) {
    return detailError;
  }

  const ticketMessage = (ticket as { message?: string }).message ?? "unknown";
  const message = ticketMessage;
  if (message.toLowerCase().includes("not a registered push recipient")) {
    return "invalid_token";
  }
  if (message.toLowerCase().includes("not a valid expo push token")) {
    return "invalid_token";
  }

  return "unknown";
}

function serializeTicketDetails(ticket: ExpoPushTicket) {
  const details =
    (ticket as { details?: Record<string, unknown> }).details ?? {};
  return {
    status: ticket.status,
    message: (ticket as { message?: string }).message ?? null,
    details,
  };
}

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ESOCKETTIMEDOUT",
]);

const RETRYABLE_STATUS_CODES = new Set([500, 502, 503, 504]);

const RETRYABLE_MESSAGE_PATTERNS = [
  "timeout",
  "timed out",
  "socket hang up",
  "network request failed",
  "fetch failed",
  "503",
  "504",
  "service unavailable",
  "temporarily unavailable",
];

function isRetryableExpoNetworkError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof CommsPortError) {
    return false;
  }
  if (typeof error === "object") {
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === "number" && RETRYABLE_STATUS_CODES.has(status)) {
      return true;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_ERROR_CODES.has(code)) {
      return true;
    }
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return RETRYABLE_MESSAGE_PATTERNS.some((pattern) =>
      message.includes(pattern),
    );
  }
  return false;
}
