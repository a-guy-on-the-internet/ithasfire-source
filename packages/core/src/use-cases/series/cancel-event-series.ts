import { randomUUID } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { describeError, parseInput } from "../../lib/io";
import { cancelEvent, type CancelEventDeps } from "../events/cancel-event";
import { ensureSeriesOwnerAccess } from "./permissions";
import { fail, isAppError } from "@th/errors";
import {
  cancelEventSeriesInputSchema,
  cancelEventSeriesResultSchema,
  type CancelEventSeriesInput,
  type CancelEventSeriesResult,
} from "./schemas";

const IDEMPOTENCY_TTL_SECONDS = 600;

export type CancelEventSeriesDeps = {
  repos: Repos;
  /**
   * Passed through to cancelEvent (FR-014 community-takedown override).
   * Series events are always OWNED, so the override never fires here — the
   * dep just satisfies the delegate's contract.
   */
  authz: CancelEventDeps["authz"];
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Forwarded to every occurrence's cancelEvent (its own swallows report
   * through it) and used for this use case's per-occurrence swallow. A
   * throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort;
};

interface StoredCancelSeriesRecord {
  payloadHash: string;
  response: CancelEventSeriesResult;
}

function buildIdempotencyKey(input: CancelEventSeriesInput): string {
  return `series:cancel:${input.seriesId}:${input.actorHumanId}:${input.clientKey}`;
}

function buildPayloadHash(input: CancelEventSeriesInput): string {
  return JSON.stringify({
    seriesId: input.seriesId,
    occurrenceId: input.occurrenceId,
    scope: input.scope,
  });
}

export async function cancelEventSeries(
  deps: CancelEventSeriesDeps,
  rawInput: unknown,
): Promise<CancelEventSeriesResult> {
  const scopedLogger = deps.logger?.child({ useCase: "cancelEventSeries" });

  const execute = async () => {
    const input = parseInput(cancelEventSeriesInputSchema, rawInput);
    const payloadHash = buildPayloadHash(input);
    const idempotencyKey = buildIdempotencyKey(input);

    // ── Idempotency check ─────────────────────────────────────────────
    const replay =
      await deps.idempotency.get<StoredCancelSeriesRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
    const claimOwnerToken = randomUUID();
    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
      claimOwnerToken,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredCancelSeriesRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    let rawResult: unknown;
    try {
      // ── Load series + verify access ───────────────────────────────────
      const series = await deps.repos.series.getById(input.seriesId);
      if (!series) {
        throw fail("SERIES_NOT_FOUND");
      }

      await ensureSeriesOwnerAccess(
        deps.repos,
        series.ownerScope,
        series.ownerId,
        input.actorHumanId,
        { purpose: "edit" },
        scopedLogger,
      );

      // ── Load pivot occurrence ─────────────────────────────────────────
      const pivot = await deps.repos.seriesOccurrences.getById(
        input.occurrenceId,
      );
      if (!pivot || pivot.seriesId !== input.seriesId) {
        throw fail("OCCURRENCE_NOT_FOUND");
      }

      // ── Determine target occurrences ──────────────────────────────────
      const cancellableStatuses = [
        "PLANNED",
        "GENERATED",
        "PUBLISHED",
      ] as const;
      let targets: Array<{
        id: string;
        eventId: string | null;
        status: string;
      }>;

      if (input.scope === "this_only") {
        targets = [pivot];
      } else {
        const afterDate =
          input.scope === "this_and_future"
            ? new Date(pivot.startsAt.getTime() - 1)
            : new Date(0);

        targets = await deps.repos.seriesOccurrences.listBySeriesAndStatuses(
          input.seriesId,
          [...cancellableStatuses],
          afterDate,
        );
      }

      // ── Process each occurrence ───────────────────────────────────────
      const cancelEventDeps: CancelEventDeps = {
        repos: deps.repos,
        authz: deps.authz,
        payments: deps.payments,
        idempotency: deps.idempotency,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
      };

      let cancelledCount = 0;
      let refundedEventCount = 0;
      let failedEventCount = 0;
      let skippedCount = 0;
      const failedEventIds: string[] = [];

      for (const occ of targets) {
        if (occ.status === "CANCELLED" || occ.status === "DETACHED") {
          skippedCount++;
          continue;
        }

        if (!occ.eventId) {
          // PLANNED occurrence with no linked event — just flip status
          await deps.repos.seriesOccurrences.markStatus({
            occurrenceId: occ.id,
            status: "CANCELLED",
            updatedAt: deps.clock.now(),
          });
          cancelledCount++;
          continue;
        }

        // Occurrence has a linked event — delegate to cancelEvent
        const derivedClientKey = `${input.clientKey}:occ:${occ.id}`;
        try {
          await cancelEvent(cancelEventDeps, {
            eventId: occ.eventId,
            actorHumanId: input.actorHumanId,
            clientKey: derivedClientKey,
          });
          refundedEventCount++;
        } catch (err: unknown) {
          const errObj = err as { message?: string };
          // Already cancelled is not a failure. `fail()` sets the message
          // to the CODE ("EVENT_ALREADY_CANCELLED"), so match the code; the
          // lowercase message match alone never fired.
          if (
            (isAppError(err) && err.code === "EVENT_ALREADY_CANCELLED") ||
            errObj?.message === "event_already_cancelled"
          ) {
            skippedCount++;
            continue;
          }
          scopedLogger?.error("cancel_series_event_failed", {
            seriesId: input.seriesId,
            occurrenceId: occ.id,
            eventId: occ.eventId,
            error: describeError(err),
          });
          // Swallowed so the rest of the series still cancels: report it
          // (CLAUDE.md error convention), guarded.
          reportSwallow(deps, err, "cancel_occurrence", {
            seriesId: input.seriesId,
            occurrenceId: occ.id,
            eventId: occ.eventId,
          });
          failedEventIds.push(occ.eventId);
          failedEventCount++;
          continue;
        }

        // Mark occurrence as cancelled after successful event cancel
        try {
          await deps.repos.seriesOccurrences.markStatus({
            occurrenceId: occ.id,
            status: "CANCELLED",
            updatedAt: deps.clock.now(),
          });
        } catch (markErr) {
          // Non-fatal — the event is cancelled, occurrence status is cosmetic.
          // Still visible: error + report (warn is not captured by Sentry).
          scopedLogger?.error("cancel_series_mark_occurrence_failed", {
            occurrenceId: occ.id,
            error: describeError(markErr),
          });
          reportSwallow(deps, markErr, "mark_occurrence", {
            seriesId: input.seriesId,
            occurrenceId: occ.id,
          });
        }
        cancelledCount++;
      }

      // ── Archive series if scope is "all" ──────────────────────────────
      let seriesArchived = false;
      if (input.scope === "all") {
        try {
          await deps.repos.series.archive({
            seriesId: input.seriesId,
            archivedAt: deps.clock.now(),
            archivedByHumanId: input.actorHumanId,
          });
          seriesArchived = true;
        } catch (archiveErr) {
          scopedLogger?.error("cancel_series_archive_failed", {
            seriesId: input.seriesId,
            error: describeError(archiveErr),
          });
          reportSwallow(deps, archiveErr, "archive_series", {
            seriesId: input.seriesId,
          });
        }
      }

      // ── Audit ─────────────────────────────────────────────────────────
      await deps.repos.audit.log({
        entity: "event_series",
        entityId: input.seriesId,
        action: "cancelled",
        data: {
          actorHumanId: input.actorHumanId,
          scope: input.scope,
          cancelledCount,
          refundedEventCount,
          failedEventCount,
          skippedCount,
          seriesArchived,
          failedEventIds,
        },
        at: deps.clock.now(),
      });

      rawResult = {
        seriesId: input.seriesId,
        scope: input.scope,
        cancelledCount,
        refundedEventCount,
        failedEventCount,
        skippedCount,
        seriesArchived,
      };

    } catch (error) {
      // Release, not `fail`: a `failed` record would lock the owner's
      // same-key retry out for 15 minutes (lib/idempotency-claim.ts). A
      // retry is safe: an occurrence the earlier attempt cancelled is either
      // marked CANCELLED (skipped up front) or replays cancelEvent's stored
      // result under the same derived client key; one still mid-cancel
      // re-enters it with the same Stripe refund keys.
      await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
        useCase: "cancelEventSeries",
        logger: scopedLogger,
        reportError: deps.reportError,
      });
      throw asKnownError("cancel_event_series", error);
    }

    // Outside the abandon path: the occurrences are cancelled and the audit
    // is written, so a throw here leaves the claim standing until its TTL
    // rather than freeing the key for a retry that redoes the run. The parse
    // keeps the error shape it had inside the attempt.
    let result: CancelEventSeriesResult;
    try {
      result = cancelEventSeriesResultSchema.parse(rawResult);
    } catch (error) {
      throw asKnownError("cancel_event_series", error);
    }
    await deps.idempotency.commit<StoredCancelSeriesRecord>(idempotencyKey, {
      payloadHash,
      response: result,
    });

    return result;
  };

  if (scopedLogger) {
    return scopedLogger.withTime("cancelEventSeries", execute);
  }

  return execute();
}

/** Guarded report for this use case's deliberate swallows. */
function reportSwallow(
  deps: Pick<CancelEventSeriesDeps, "reportError">,
  error: unknown,
  stage: "cancel_occurrence" | "mark_occurrence" | "archive_series",
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(error, {
      tags: { useCase: "cancelEventSeries", stage },
      extra,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}
