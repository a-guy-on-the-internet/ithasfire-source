import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos } from "@th/ports/repos";
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
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

export const unpublishEventInputSchema = z.object({
  actorHumanId: z.uuid(),
  eventId: z.uuid(),
});

export const unpublishEventOutputSchema = z.object({
  eventId: z.uuid(),
  status: z.literal("DRAFT"),
});

export type UnpublishEventInput = z.infer<typeof unpublishEventInputSchema>;
export type UnpublishEventOutput = z.infer<typeof unpublishEventOutputSchema>;

export type UnpublishEventDeps = {
  repos: Repos;
  /**
   * Required (FR-003) — forwarded to the post-write reindex, which resolves
   * every tier's effective price at index time (FR-008).
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional search port. When provided, the just-unpublished (now DRAFT) event
   * is REMOVED from the search index (the incremental event reindex is
   * upsert-or-delete: a non-PUBLISHED event is deleted) so it stops appearing on
   * main search + the search-served embed without waiting for the nightly full
   * reindex. Failures are reported/logged but never block the unpublish.
   */
  search?: MultiSearchPort;
  /**
   * Best-effort Sentry reporter for the fire-and-forget reindex swallow. The
   * reindex never reaches a tRPC/fastify backstop, so without this a dropped
   * index removal is invisible (a bare `logger.warn` is NOT captured). Wire it
   * from `ctx.reportError` (CLAUDE.md error convention).
   */
  reportError?: ReporterPort;
};

/**
 * Reverts a PUBLISHED event back to DRAFT, hiding it from public surfaces
 * without canceling tickets or refunding buyers.
 *
 * **Why this is distinct from cancel:** unpublish is a soft, reversible
 * "I'm not ready" — the organizer hides the listing, fixes something, and
 * re-publishes when ready. Cancel is terminal: refunds everyone, closes
 * the event for good.
 *
 * **Safety guard:** if any tickets have been sold (any non-CANCELLED order
 * exists for the event), unpublish is refused — the buyer would otherwise
 * silently lose visibility on the event detail they paid for. Force the
 * organizer to use cancel (which refunds) in that case.
 */
export async function unpublishEvent(
  deps: UnpublishEventDeps,
  rawInput: unknown,
): Promise<UnpublishEventOutput> {
  const input = parseInput(unpublishEventInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId: event.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ADMIN_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
  } else {
    await ensureActorHoldsHumanEventRole(
      deps.repos.authz,
      event.humanId,
      input.actorHumanId,
      ORG_ADMIN_ROLES,
    );
  }

  if (event.status !== "PUBLISHED") {
    throw fail("EVENT_NOT_PUBLISHED");
  }

  // Refuse if any successful orders exist — those buyers paid expecting
  // to see this event. Use cancel-event (which refunds) instead.
  const orders = await deps.repos.orders.listAll({
    eventId: input.eventId,
    statuses: ["SUCCEEDED", "PART_REFUNDED"],
    limit: 1,
    offset: 0,
  });
  if (orders.total > 0) {
    throw fail("EVENT_HAS_ORDERS_USE_CANCEL_INSTEAD");
  }

  // Unpublish + change-notice outbox row commit atomically so the notification
  // intent is crash-safe. Orders were already refused, so the audience
  // (savers ∪ RSVPers) is always worth telling — a separate drain job fans
  // `event.unlisted` out to them.
  await deps.repos.tx(async (tx) => {
    // Re-check the status UNDER the row lock, first thing in the tx (the
    // pattern `cancelEvent` uses). The check above ran outside the tx and
    // `events.unpublish` is an unconditional flip, so a `cancelEvent` (or
    // `completeEvent`, `archiveEvent`) that committed after our load would
    // otherwise be overwritten: a CANCELLED event, its buyers refunded,
    // flipped back to DRAFT and re-publishable. Those writers take the same
    // FOR UPDATE lock, so whichever commits first is what we see here.
    await tx.events.lockRows({ ids: [event.id], mode: "update" });
    const locked = await tx.events.getById(event.id);
    if (!locked) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (locked.status !== "PUBLISHED") {
      throw fail("EVENT_NOT_PUBLISHED");
    }
    await tx.events.unpublish({ eventId: input.eventId });
    await tx.eventChangeNotices.create({
      eventId: event.id,
      changeType: "UNPUBLISHED",
      // The row as it stands under the lock, not the pre-tx load.
      payload: { eventTitle: locked.title },
    });
    await markForSearchReindex(
      tx,
      [{ kind: "event", id: event.id }],
      deps.clock.now(),
    );
    // Fail-closed removal from search, the LAST step before commit: an
    // unpublished event must not stay listed (with its location) because a
    // best-effort reindex failed. If the delete fails the unpublish rolls
    // back and the organizer retries. See `search/privacy-scrub.ts`.
    await scrubSearchDocumentsOrThrow(searchForTx(deps.search, tx), {
      docIds: [eventSearchDocId(event.id)],
      useCase: "unpublishEvent",
      logger: deps.logger,
      reportError: deps.reportError,
    });
  });

  // Belt and braces after the in-tx delete: the reindex is upsert-or-delete,
  // so it removes the now-DRAFT event again (a no-op unless something wrote
  // it back in between, which the index-write fence rules out).
  reindexAfterMutation(
    {
      repos: deps.repos,
      search: deps.search,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    "unpublishEvent",
    { kind: "event", id: input.eventId },
  );

  deps.logger?.info("Event unpublished", {
    eventId: input.eventId,
    actorHumanId: input.actorHumanId,
  });

  return {
    eventId: input.eventId,
    status: "DRAFT",
  };
}
