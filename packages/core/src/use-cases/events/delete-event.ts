import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import type { ReporterPort } from "@th/ports/reporter";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { parseInput } from "../../lib/io";
import { requireOrgMembership, ORG_ADMIN_ROLES } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  eventSearchDocId,
  scrubSearchDocumentsOrThrow,
} from "../search/privacy-scrub";
import { searchForTx } from "../search/tx-bound-search";
import { fail } from "@th/errors";
import {
  collectEventMediaDeletionTargets,
  eventStorageQuotaSubject,
} from "../storage/event-media-targets";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";
import type { EventRecord } from "@th/ports/repos/events";
import {
  runOpenCallNotice,
  type OpenCallNotThisTimeNotice,
  type OpenCallPulledNotice,
} from "./open-calls/_shared/open-call-decision";
import { CLOSE_NOTICES_IN_REQUEST_MAX } from "./open-calls/close-open-call";
import { openCallNoticeWasSent } from "./open-calls/notify-open-call-notices";
import {
  isOpenCallNoticeDead,
  OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES,
  readOpenCallNoticeFailures,
  recordOpenCallNoticeFailure,
} from "./open-calls/_shared/open-call-notice-failures";

/**
 * Most owed open-call notices one delete request sends (the same bound as
 * close's in-request sends, so the request cannot time out). More owed than
 * this → the first batch is sent and the delete is refused; the hourly
 * reconcile (or a retry) drains the rest and a later delete goes through.
 */
export const DELETE_EVENT_OPEN_CALL_NOTICES_MAX = CLOSE_NOTICES_IN_REQUEST_MAX;
const OWED_SCAN_PAGE = 200;
/** Ledger reads in flight at once while classifying a page of decided rows. */
const OWED_LEDGER_READ_CONCURRENCY = 10;

export const deleteEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
});

export const deleteEventOutputSchema = z.object({
  eventId: z.uuid(),
  deleted: z.literal(true),
});

export type DeleteEventInput = z.infer<typeof deleteEventInputSchema>;
export type DeleteEventOutput = z.infer<typeof deleteEventOutputSchema>;

export type DeleteEventDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional search port. Defense-in-depth: a deletable event is a
   * never-published DRAFT (`publishedAt === null`, guarded below), so it was
   * never indexed and removal is normally a no-op. But we still run the
   * upsert-or-delete reindex AFTER the delete commits — by then `getById`
   * returns null, which the reindex resolves as REMOVE — so any drift (e.g. a
   * doc that leaked in) is reconciled promptly instead of lingering until the
   * nightly full reindex. Failures are reported/logged but never block delete.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort Sentry reporter for the fire-and-forget reindex swallow. The
   * reindex never reaches a tRPC/fastify backstop, so without this a dropped
   * index removal is invisible (a bare `logger.warn` is NOT captured). Wire it
   * from `ctx.reportError` (CLAUDE.md error convention).
   */
  reportError?: ReporterPort;
  /**
   * FR-022 (open calls): a draft's POSTED call is retired before the
   * cascade, and NOBODY on it may be cascaded away unheard: every REJECTED
   * application must hold its "not this time" ledger key and every EXPIRED
   * one its "call pulled" key before the delete runs (the cascade removes
   * the rows, so no later reconcile could reach them). These two notifiers
   * (wired from the transport's open-call notifier) send what is owed; the
   * ledger (`openCallNoticeLedger`, the SAME idempotency store the notifier
   * writes) says what already went out. Any of the three unwired while the
   * call has decided applicants → the delete is refused and reported.
   */
  notifyOpenCallPulled?: (notice: OpenCallPulledNotice) => Promise<unknown>;
  notifyOpenCallNotThisTime?: (notice: OpenCallNotThisTimeNotice) => Promise<unknown>;
  openCallNoticeLedger?: IdempotencyPort;
};

/**
 * Auth + "is it a deletable draft", shared by the open-call retire step and
 * the delete transaction (each re-reads under its own transaction).
 */
async function ensureDeletableDraft(
  tx: TxRepos,
  input: DeleteEventInput,
): Promise<EventRecord> {
  const event = await tx.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(
      tx.authz,
      event.humanId,
      input.actorHumanId,
      ORG_ADMIN_ROLES,
    );
  }

  if (event.status !== "DRAFT") {
    throw fail("EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD");
  }

  if (event.publishedAt !== null) {
    throw fail("EVENT_WAS_PUBLISHED");
  }
  return event;
}

/**
 * FR-022 before the cascade. A DRAFT event can carry a POSTED open call
 * (the call link works on a draft, FR-003), and deleting the event cascades
 * the call and every application with it, so no later sweep could see them.
 * Here, in its own transaction (auth first): close the call (no new
 * applications), set every UNDECIDED application (PENDING, and WAITLISTED:
 * someone waiting is owed the news as much as someone pending) to EXPIRED,
 * audit it. The notices go out after, in `settleOwedOpenCallNotices`.
 *
 * Accepted: if the delete then fails or is refused, the call stays closed
 * and those applicants are (or will be, by the reconcile) told it was
 * pulled; the organizer can reopen the call. The call page cannot "stay up
 * marked Closed" (FR-022) on a hard delete; that needs a schema change and
 * is reported, not done.
 */
type RetiredOpenCall = { formId: string; title: string; closedAt: Date };

async function retireOpenCallBeforeDelete(
  deps: DeleteEventDeps,
  input: DeleteEventInput,
): Promise<RetiredOpenCall | null> {
  return deps.repos.tx(async (tx) => {
    const event = await ensureDeletableDraft(tx, input);
    const form = await tx.eventApplications.getOpenCall({ kind: "event", eventId: event.id });
    if (!form || !form.postedAt) return null;
    const locked = await tx.eventApplications.lockOpenCallForClose(form.id);
    if (!locked) return null;
    const now = deps.clock.now();
    const closedAt = locked.closedAt ?? now;
    if (!locked.closedAt) {
      await tx.eventApplications.setOpenCallClosed({
        formId: locked.id,
        closedAt,
        closedByHumanId: input.actorHumanId,
      });
    }
    const { ids } = await tx.eventApplications.expireUndecidedOpenCallSubmissions({
      formId: locked.id,
      reviewedAt: now,
    });
    if (ids.length > 0) {
      await tx.audit.log({
        entity: "event",
        entityId: event.id,
        action: "open_call_pulled",
        data: {
          actorHumanId: input.actorHumanId,
          formId: locked.id,
          via: "event_deleted",
          expiredSubmissionIds: ids,
        },
        at: now,
      });
    }
    return { formId: locked.id, title: event.title, closedAt };
  });
}

/** Refuse the delete, logged at error and reported (guarded). */
function refuseForOwedNotices(
  deps: DeleteEventDeps,
  input: DeleteEventInput,
  reason: string,
  extra: Record<string, unknown>,
): never {
  const error = new Error(`deleteEvent: open-call notices still owed (${reason}); delete refused`);
  deps.logger?.error("open_call.delete_refused_notices_owed", {
    eventId: input.eventId,
    reason,
    ...extra,
  });
  try {
    deps.reportError?.(error, {
      tags: { useCase: "deleteEvent", reason },
      extra: { eventId: input.eventId, ...extra },
    });
  } catch {
    // Best-effort: a throwing reporter must never change the outcome.
  }
  throw fail("EVENT_NOT_DELETABLE");
}

type OwedKind = "not-this-time" | "pulled";
type OwedRow = { submissionId: string; kind: OwedKind };
/** A notice that failed OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES times: no longer blocks the delete. */
type DeadRow = OwedRow & { failures: number };

/**
 * Where one decided row stands: told, dead (stops blocking), or owed. A
 * ledger read that throws propagates and fails the delete (fail closed).
 */
async function classifyDecidedRow(
  ledger: IdempotencyPort,
  row: OwedRow,
): Promise<{ state: "sent" } | { state: "dead"; failures: number } | { state: "owed" }> {
  if (await openCallNoticeWasSent(ledger, row.kind, row.submissionId)) return { state: "sent" };
  const failures = await readOpenCallNoticeFailures(ledger, row.kind, row.submissionId);
  return isOpenCallNoticeDead(failures) ? { state: "dead", failures } : { state: "owed" };
}

/** One more failed attempt; the new count, or null when the counter could not be written (reported). */
async function countDeleteSendFailure(
  deps: DeleteEventDeps,
  ledger: IdempotencyPort,
  item: OwedRow,
  formId: string,
): Promise<number | null> {
  try {
    const failures = await recordOpenCallNoticeFailure(ledger, item.kind, item.submissionId);
    // Crossing the threshold is reported once (as the sweep does), even if
    // this delete is then refused: the reconcile skips a dead row silently.
    if (failures === OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES) {
      try {
        deps.reportError?.(
          new Error(`open-call notice (${item.kind}) failed ${failures} times; the reconcile stops retrying it`),
          {
            tags: { useCase: "deleteEvent", reason: "notice_undeliverable", kind: item.kind, pass: "delete" },
            extra: { submissionId: item.submissionId, formId, failures },
          },
        );
      } catch {
        // Best-effort: a throwing reporter must never change the outcome.
      }
    }
    return failures;
  } catch (error) {
    deps.logger?.error("open_call.notice_failure_count_failed", {
      useCase: "deleteEvent",
      kind: item.kind,
      submissionId: item.submissionId,
      err: error,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "deleteEvent", reason: "notice_failure_count_failed", kind: item.kind },
        extra: { submissionId: item.submissionId },
      });
    } catch {
      // Best-effort: a throwing reporter must never change the outcome.
    }
    return null;
  }
}

/**
 * After the cascade: each dead notice is reported once, so the people the
 * delete could not reach are findable. Ids and kind only (no guest email,
 * no status token).
 */
function reportUndeliverableOnDelete(
  deps: DeleteEventDeps,
  input: DeleteEventInput,
  formId: string,
  dead: DeadRow[],
): void {
  for (const item of dead) {
    const error = new Error(
      `deleteEvent: open-call notice (${item.kind}) undeliverable after ${item.failures} failures; event deleted anyway`,
    );
    deps.logger?.error("open_call.notice_undeliverable_on_delete", {
      eventId: input.eventId,
      formId,
      submissionId: item.submissionId,
      kind: item.kind,
      failures: item.failures,
    });
    try {
      deps.reportError?.(error, {
        tags: { useCase: "deleteEvent", reason: "open_call.notice_undeliverable_on_delete", kind: item.kind },
        extra: {
          eventId: input.eventId,
          formId,
          submissionId: item.submissionId,
          kind: item.kind,
          failures: item.failures,
        },
      });
    } catch {
      // Best-effort: a throwing reporter must never change the outcome.
    }
  }
}

/**
 * Every notice the retired call still owes, settled BEFORE the cascade:
 * REJECTED → "not this time" (close sends only its first batch in-request;
 * a decline's send can fail), EXPIRED → "call pulled" (the retire above,
 * or an earlier attempt). The notifier is a no-op for a settled key, and
 * the ledger is read first so a settled row costs one read.
 *
 * Refuses with EVENT_NOT_DELETABLE (rows survive, so the hourly reconcile
 * keeps delivering; the organizer retries or cancels) when:
 *   - more than DELETE_EVENT_OPEN_CALL_NOTICES_MAX are owed (the first
 *     batch is sent, so each attempt makes progress);
 *   - any notice sent here did not settle and has failed fewer than
 *     OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES times (the notifier reports which
 *     recipient failed);
 *   - the notifiers or the ledger are not wired while anyone is owed.
 *
 * DEAD notices (owner ruling 2026-10-07): a row whose failure counter has
 * reached the threshold counts as settled-for-delete: no send, and it is
 * returned so the caller reports it once the delete commits. A failed send
 * here counts first, so the third failure inside this delete lets it go on.
 *
 * Ledger reads run OWED_LEDGER_READ_CONCURRENCY at a time per page, and the
 * scan stops once more than the cap are owed (the delete is refused then
 * anyway). Every decided row is still classified before a delete proceeds.
 */
async function settleOwedOpenCallNotices(
  deps: DeleteEventDeps,
  input: DeleteEventInput,
  retired: RetiredOpenCall,
): Promise<DeadRow[]> {
  const ledger = deps.openCallNoticeLedger;
  const pulled = deps.notifyOpenCallPulled;
  const notThisTime = deps.notifyOpenCallNotThisTime;
  const owed: OwedRow[] = [];
  const dead: DeadRow[] = [];
  let overCap = false;
  let afterId: string | null = null;
  scan: for (;;) {
    const page = await deps.repos.eventApplications.listOpenCallSubmissionsByFormStatus({
      formId: retired.formId,
      statuses: ["REJECTED", "EXPIRED"],
      afterId,
      limit: OWED_SCAN_PAGE,
    });
    if (page.length === 0) break;
    if (!ledger || !pulled || !notThisTime) {
      refuseForOwedNotices(deps, input, "notice_seams_unwired", {
        formId: retired.formId,
        ledger: Boolean(ledger),
        pulled: Boolean(pulled),
        notThisTime: Boolean(notThisTime),
      });
    }
    for (let i = 0; i < page.length; i += OWED_LEDGER_READ_CONCURRENCY) {
      const chunk = page.slice(i, i + OWED_LEDGER_READ_CONCURRENCY).map(
        (row): OwedRow => ({
          submissionId: row.submissionId,
          kind: row.status === "REJECTED" ? "not-this-time" : "pulled",
        }),
      );
      const states = await Promise.all(chunk.map((row) => classifyDecidedRow(ledger, row)));
      for (const [j, row] of chunk.entries()) {
        const state = states[j]!;
        if (state.state === "sent") continue;
        if (state.state === "dead") {
          dead.push({ ...row, failures: state.failures });
          continue;
        }
        if (owed.length >= DELETE_EVENT_OPEN_CALL_NOTICES_MAX) {
          overCap = true;
          break scan;
        }
        owed.push(row);
      }
      afterId = chunk[chunk.length - 1]!.submissionId;
    }
  }
  if (owed.length === 0) return dead;

  const anchor = { kind: "event" as const, eventId: input.eventId };
  for (const item of owed) {
    if (item.kind === "pulled") {
      await runOpenCallNotice(deps, "deleteEvent", pulled, {
        kind: "open_call_pulled",
        submissionId: item.submissionId,
        formId: retired.formId,
        anchor,
        title: retired.title,
      });
    } else {
      await runOpenCallNotice(deps, "deleteEvent", notThisTime, {
        kind: "open_call_not_this_time",
        submissionId: item.submissionId,
        formId: retired.formId,
        anchor,
        title: retired.title,
        decisionReason: null,
      });
    }
  }

  const unsettled: string[] = [];
  for (const item of owed) {
    // `ledger` is defined: `owed` is only filled past the unwired check.
    if (await openCallNoticeWasSent(ledger!, item.kind, item.submissionId)) continue;
    // Count this failure first: if it makes the row dead, it stops blocking.
    const failures = await countDeleteSendFailure(deps, ledger!, item, retired.formId);
    if (failures !== null && isOpenCallNoticeDead(failures)) {
      dead.push({ ...item, failures });
      continue;
    }
    unsettled.push(item.submissionId);
  }
  if (overCap || unsettled.length > 0) {
    refuseForOwedNotices(deps, input, overCap ? "notices_over_cap" : "notices_unsettled", {
      formId: retired.formId,
      sent: owed.length - unsettled.length,
      unsettled: unsettled.length,
      overCap,
    });
  }
  return dead;
}

/**
 * Permanently removes a never-published DRAFT event. Once an event has been
 * live, publishedAt is preserved as lifecycle history and deletion is refused.
 * The organizer must use cancel-event (which refunds buyers) for any event
 * that has been live.
 *
 * Authorization mirrors unpublish: org admins for org-owned events,
 * the owning human otherwise.
 */
export async function deleteEvent(
  deps: DeleteEventDeps,
  rawInput: unknown,
): Promise<DeleteEventOutput> {
  const input = parseInput(deleteEventInputSchema, rawInput);

  // Open calls FR-022: only when the event has a POSTED call (a draft call
  // takes no applications). The delete transaction below re-checks.
  const openCall = await deps.repos.eventApplications.getOpenCall({
    kind: "event",
    eventId: input.eventId,
  });
  let retired: RetiredOpenCall | null = null;
  let undeliverable: DeadRow[] = [];
  if (openCall?.postedAt) {
    retired = await retireOpenCallBeforeDelete(deps, input);
    if (retired) undeliverable = await settleOwedOpenCallNotices(deps, input, retired);
  }

  const result = await deps.repos.tx(async (tx) => {
    const event = await ensureDeletableDraft(tx, input);

    // Nobody may be cascaded away unheard. The owed notices were settled
    // against the call as retired above; if it was posted after that
    // check, or reopened since (closedAt cleared or re-stamped: new
    // applications and decisions may exist), or anyone is undecided now,
    // refuse. A retry retires and settles it first.
    const call = await tx.eventApplications.getOpenCall({ kind: "event", eventId: event.id });
    if (call?.postedAt) {
      const locked = await tx.eventApplications.lockOpenCallForClose(call.id);
      const unchanged =
        retired !== null &&
        locked !== null &&
        locked.id === retired.formId &&
        locked.closedAt !== null &&
        locked.closedAt.getTime() === retired.closedAt.getTime();
      if (!unchanged) throw fail("EVENT_NOT_DELETABLE");
      const undecided = await tx.eventApplications.countSubmissionsByForm({
        formId: call.id,
        statuses: ["PENDING", "WAITLISTED"],
      });
      if (undecided > 0) throw fail("EVENT_NOT_DELETABLE");
    }

    // Collect storage keys BEFORE the DB cascade removes the child rows.
    const storageTargets = await collectEventMediaDeletionTargets(
      tx,
      input.eventId,
    );

    // Enqueue the deletion intent in the SAME transaction as the cascade so it
    // commits atomically. The drain job (storage.drain-pending-deletions) then
    // removes the objects durably with retries — no best-effort post-commit
    // delete that could orphan bytes if it fails after the rows are gone.
    const deletionItems: EnqueuePendingObjectDeletionItem[] = [
      ...storageTargets.exactKeys.map(
        (targetKey): EnqueuePendingObjectDeletionItem => ({
          targetKey,
          targetKind: "KEY",
          source: "event_delete",
          sourceId: input.eventId,
        }),
      ),
      ...storageTargets.prefixes.map(
        (targetKey): EnqueuePendingObjectDeletionItem => ({
          targetKey,
          targetKind: "PREFIX",
          source: "event_delete",
          sourceId: input.eventId,
        }),
      ),
    ];
    await tx.pendingObjectDeletions.enqueueMany(deletionItems);

    // Credit the owner's storage quota back for the freed media bytes (audio +
    // images), mirroring the upload-side increment. Same subject, negative
    // delta — freeing, not consuming, so no enforceQuota. In the same tx so the
    // credit commits atomically with the cascade.
    const freedBytes = storageTargets.audioBytes + storageTargets.imageBytes;
    const quotaSubject = eventStorageQuotaSubject(event);
    if (freedBytes > 0n && quotaSubject) {
      await incrementResourceUsage(tx, {
        ...quotaSubject,
        delta: -freedBytes,
      });
    }

    const deleted = await tx.events.delete({ eventId: input.eventId });
    if (!deleted) {
      throw fail("EVENT_NOT_DELETABLE");
    }

    await tx.audit.log({
      entity: "event",
      entityId: input.eventId,
      action: "event_deleted",
      data: {
        actorHumanId: input.actorHumanId,
        orgId: event.orgId,
        humanId: event.humanId,
        status: event.status,
      },
      at: deps.clock.now(),
    });

    await markForSearchReindex(
      tx,
      [{ kind: "event", id: input.eventId }],
      deps.clock.now(),
    );

    // Fail-closed removal from search, the LAST step before commit. A
    // deletable event was never published, so this is normally a no-op
    // delete; it is here so a document that leaked in cannot outlive its row
    // (after the commit nothing is left to reindex it from).
    await scrubSearchDocumentsOrThrow(searchForTx(deps.search, tx), {
      docIds: [eventSearchDocId(input.eventId)],
      useCase: "deleteEvent",
      logger: deps.logger,
      reportError: deps.reportError,
    });

    return {
      eventId: input.eventId,
      deleted: true as const,
    };
  });

  // The applicants the delete could not reach (dead notices) are gone with
  // the rows now: report each so they are findable.
  if (retired && undeliverable.length > 0) {
    reportUndeliverableOnDelete(deps, input, retired.formId, undeliverable);
  }

  // Best-effort reconciliation: the event row is now gone, so the
  // upsert-or-delete reindex resolves `getById` → null → REMOVE. Runs AFTER the
  // delete commits so it can never race the cascade. See the `search` dep note.
  reindexAfterMutation(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    "deleteEvent",
    { kind: "event", id: input.eventId },
  );

  deps.logger?.info("Event deleted", {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
  });

  return deleteEventOutputSchema.parse(result);
}
