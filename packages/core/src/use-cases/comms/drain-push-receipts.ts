import { z } from "zod";

import { fail } from "@th/errors";
import type { PushPort, PushReceiptResult } from "@th/ports/comms/push";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const drainPushReceiptsInputSchema = z
  .object({
    /** Max pending-receipt rows to poll per run (keeps the job bounded). */
    limit: z.number().int().positive().max(5_000).default(1_000),
    /**
     * Polls that found NO receipt before the row is given up on and deleted.
     * Expo prunes receipts after ~24h, so retrying forever is pointless — a
     * receipt that hasn't materialized after a few 15-minute polls never will
     * (or the message was fine and we simply lost visibility; either way the
     * send-phase invalid-token handling already covered the cheap cases).
     */
    maxAttempts: z.number().int().positive().default(3),
    /** Delay before re-polling a row whose receipt is still missing. */
    recheckDelaySeconds: z.number().int().positive().default(900),
  })
  .strict();

export type DrainPushReceiptsInput = z.infer<
  typeof drainPushReceiptsInputSchema
>;

export const drainPushReceiptsOutputSchema = z
  .object({
    /** Pending-receipt rows examined this run. */
    processed: z.number(),
    /** Rows whose receipt came back ok (delivered downstream). */
    delivered: z.number(),
    /** Rows whose receipt reported a dead install (device disabled). */
    invalidTokens: z.number(),
    /** Distinct devices actually disabled this run. */
    disabledDevices: z.number(),
    /** Rows whose receipt reported a message-level (non-token) error. */
    failedMessages: z.number(),
    /** Rows with no receipt yet, rescheduled for a later poll. */
    retried: z.number(),
    /** Rows that exhausted maxAttempts without a receipt and were dropped. */
    expired: z.number(),
  })
  .strict();

export type DrainPushReceiptsOutput = z.infer<
  typeof drainPushReceiptsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type DrainPushReceiptsDeps = {
  repos: Pick<Repos, "pushReceipts" | "pushDevices">;
  /**
   * Push port (Expo adapter in both containers). Must implement the optional
   * `checkReceipts` — a missing port/method surfaces a typed NOT_CONFIGURED
   * instead of a crash.
   */
  push?: PushPort | null;
  logger: LoggerPort;
  clock: ClockPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drains the pending push-receipt outbox: polls Expo's receipt endpoint for
 * due tickets and prunes the devices Expo only reports as dead in the receipt
 * phase (~15min after the send ticket returned ok).
 *
 * Per row:
 *   - receipt `ok`              → delete the row (delivered);
 *   - receipt `invalid_token`   → disable the device, delete the row;
 *   - receipt `error` (message-level: too big, rate-limited, …)
 *                               → log + delete the row (device stays valid);
 *   - receipt missing           → increment attempts + push `checkAfter`
 *                                 back; give up and delete after
 *                                 `maxAttempts` (Expo prunes receipts ~24h).
 *
 * No row leasing — mirrors `drainPendingDeletions`: overlapping runs that
 * re-poll the same rows are harmless because every bookkeeping half is
 * idempotent (deleteMany/updateMany 0-row no-ops on vanished rows, disabling
 * an already-disabled device is a no-op, and a double `reschedule` merely
 * gives up one poll earlier). A device-disable failure (e.g. the row was
 * cascade-deleted with its human) is contained per-device and never aborts
 * the batch; a receipts-endpoint failure throws so the scheduler retries and
 * the rows stay queued untouched.
 */
export async function drainPushReceipts(
  deps: DrainPushReceiptsDeps,
  rawInput: unknown,
): Promise<DrainPushReceiptsOutput> {
  const logger = deps.logger.child({ useCase: "drainPushReceipts" });
  const input = parseInput(drainPushReceiptsInputSchema, rawInput ?? {});

  const result: DrainPushReceiptsOutput = {
    processed: 0,
    delivered: 0,
    invalidTokens: 0,
    disabledDevices: 0,
    failedMessages: 0,
    retried: 0,
    expired: 0,
  };

  const now = deps.clock.now();
  const due = await deps.repos.pushReceipts.listDue({
    now,
    limit: input.limit,
  });
  if (due.length === 0) {
    logger.info("comms.push_receipts.drain_completed", { ...result });
    return result;
  }

  // Resolve the port AFTER the empty short-circuit so unwired environments
  // with nothing queued don't fail their cron for no reason.
  const checkReceipts = deps.push?.checkReceipts?.bind(deps.push);
  if (!checkReceipts) {
    throw fail("NOT_CONFIGURED", { message: "push_receipts_not_configured" });
  }

  result.processed = due.length;

  // The adapter chunks the lookup internally; a failure here throws (rows
  // stay due and the next run retries).
  const { receipts } = await checkReceipts({
    ticketIds: due.map((row) => row.ticketId),
  });
  const receiptsByTicketId = new Map<string, PushReceiptResult>(
    receipts.map((receipt) => [receipt.ticketId, receipt]),
  );

  const toDelete: string[] = [];
  const toReschedule: string[] = [];
  const devicesToDisable = new Set<string>();

  for (const row of due) {
    const receipt = receiptsByTicketId.get(row.ticketId);

    if (!receipt) {
      // No receipt yet (or Expo already pruned it — receipts live ~24h).
      if (row.attempts + 1 >= input.maxAttempts) {
        result.expired += 1;
        toDelete.push(row.id);
      } else {
        result.retried += 1;
        toReschedule.push(row.id);
      }
      continue;
    }

    // Any resolved receipt — whatever its status — retires the row.
    toDelete.push(row.id);

    if (receipt.status === "ok") {
      result.delivered += 1;
      continue;
    }

    if (receipt.status === "invalid_token") {
      result.invalidTokens += 1;
      devicesToDisable.add(row.pushDeviceId);
      continue;
    }

    result.failedMessages += 1;
    logger.warn("comms.push_receipts.message_failed", {
      ticketId: row.ticketId,
      pushDeviceId: row.pushDeviceId,
      errorCode: receipt.errorCode,
      message: receipt.message,
    });
  }

  // Disable dead devices FIRST (per-device containment), then retire rows —
  // if a disable hiccups after its row was already deleted we'd lose the
  // retry, so keep the ordering conservative. Disabling is idempotent, so an
  // overlapping run racing the same device is harmless.
  for (const deviceId of devicesToDisable) {
    try {
      await deps.repos.pushDevices.disable({ id: deviceId });
      result.disabledDevices += 1;
      logger.info("comms.push_receipts.device_disabled", {
        pushDeviceId: deviceId,
      });
    } catch (error) {
      // e.g. the device row vanished via the Human cascade — nothing left to
      // disable; never abort the batch over one device.
      logger.warn("comms.push_receipts.device_disable_failed", {
        pushDeviceId: deviceId,
        error: String(error),
      });
    }
  }

  await deps.repos.pushReceipts.deleteByIds(toDelete);

  if (toReschedule.length > 0) {
    await deps.repos.pushReceipts.reschedule({
      ids: toReschedule,
      checkAfter: new Date(
        now.getTime() + input.recheckDelaySeconds * 1000,
      ),
    });
  }

  logger.info("comms.push_receipts.drain_completed", { ...result });
  return result;
}
