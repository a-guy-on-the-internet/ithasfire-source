import { enqueueEventFollowers } from "../follows/enqueue-event-followers";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  eventAttendanceModeSchema,
  eventStatusSchema,
  eventStewardshipSchema,
} from "@th/schema";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { requirePlatformStaff } from "../../lib/rbac";
import { reindexAfterMutation } from "../search/reindex-after-mutation";
import type { ReporterPort } from "@th/ports/reporter";
import {
  sweepLineupNoticesAfterPublish,
  type LineupNoticeHooks,
} from "../event-humans/notify-lineup-notices";
import { markForSearchReindex } from "../search/search-reindex-marks";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import { settleHeldDatesForEvent } from "../booking-holds/settle-held-dates-for-published-event";
import { COMMUNITY_MODERATION_ROLES } from "./_shared/suggestion-validation";

/**
 * Take a DRAFT community listing live.
 *
 * A community listing used to be born PUBLISHED, which is why nothing like
 * this existed: creation WAS publication. Authoring one in the real
 * `EventBuilder` needs the row to exist before it is public (body images and
 * the hero key to `events/{eventId}/...`), so `createCommunityListing` can now
 * mint a DRAFT and this use case is the single place that flips it.
 *
 * What it owes, all in ONE transaction:
 *  - the status/`publishedAt` write, through the CAS
 *    `events.publishCommunityListingIfDraft` rather than the unconditional
 *    `events.publish`. The read-then-write shape is a real race under READ
 *    COMMITTED: two concurrent publishes both read DRAFT, both write, and the
 *    loser re-stamps `publishedAt`, writes a second audit row and re-runs hold
 *    settlement — re-notifying a line about a publish that already happened.
 *    The status guard in the WHERE is what makes the loser a no-op;
 *  - FR-018 hold settlement — a listing that becomes PUBLISHED takes its dates
 *    from any holds on its calendar. Create used to be the only place a
 *    listing became PUBLISHED and therefore the only place this ran; it now
 *    runs at BOTH. A no-op while community listings carry no calendar, wired
 *    so the rule cannot be missed if they ever do. Ordered AFTER the status
 *    write and against the WRITTEN row, matching `publishEvent`: the update
 *    takes the row lock first, so a concurrent `confirmVenueEvent` either
 *    blocks on us and sees PUBLISHED or we block on its stamp and see it;
 *  - the audit row (attribution for an ownerless listing lives ONLY in the
 *    AuditLog — the row itself never gains an owner).
 *
 * Idempotency: publishing an already-PUBLISHED listing is a SUCCESS with
 * `changed: false`, not a throw. That is the house convention on both sides of
 * this file — `publishEvent` returns a success-shaped echo for an
 * already-PUBLISHED event, and `cancelEventDate` / `restoreEventDate` report a
 * no-op flip as `changed: false`. A double-submit from the builder must not
 * paint a red error over a listing that is, in fact, live. Hold settlement and
 * the audit row are SKIPPED on the replay: the line was taken (or not) by the
 * first publish and re-running it would re-notify.
 *
 * Non-DRAFT, non-PUBLISHED statuses (CANCELLED / COMPLETED / ARCHIVED) are
 * EVENT_NOT_PUBLISHABLE — resurrecting an end-state through here is not a
 * publish, and each of those has its own path.
 */

export const publishCommunityListingInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

export const publishCommunityListingOutputSchema = z
  .object({
    event: z
      .object({
        id: z.uuid(),
        title: z.string(),
        slug: z.string().nullable(),
        shortId: z.string().nullable(),
        status: eventStatusSchema,
        attendanceMode: eventAttendanceModeSchema,
        stewardship: eventStewardshipSchema,
        startsAt: z.date(),
        endsAt: z.date().nullable(),
        timezone: z.string(),
      })
      .strict(),
    /**
     * False when the listing was ALREADY published — the idempotent replay.
     * The client uses it to tell "you just took this live" from "this was
     * already live" without having to read an error.
     */
    changed: z.boolean(),
    /** The go-live stamp. Non-null on both the live flip and the replay. */
    publishedAt: z.date(),
    /**
     * Booking-hold notifications this publish owes (FR-018). Always empty
     * while community listings carry no calendar, and always empty on an
     * idempotent replay (nothing was settled twice). Server-side only.
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents + routing hint stay
 * server-side. Built from the omitted `.shape` (not `.omit()` on the strict
 * object) so `.parse(liveResult)` STRIPS the two keys instead of refusing the
 * result with `unrecognized_keys` the first time a listing actually owes one.
 */
export const publishCommunityListingWireOutputSchema = z.object(
  publishCommunityListingOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type PublishCommunityListingInput = z.infer<
  typeof publishCommunityListingInputSchema
>;
export type PublishCommunityListingOutput = z.infer<
  typeof publishCommunityListingOutputSchema
>;

export type PublishCommunityListingDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  /**
   * Optional: best-effort incremental search-index update after the flip. This
   * is what puts the listing into search/home rails at go-live instead of at
   * the next nightly full-reindex. No-ops when omitted.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /**
   * "You're on the lineup" sweep (owner ruling "option A", 2026-09-30) —
   * `makeLineupNoticeHooks` from event-humans/notify-lineup-notices. A
   * community listing never goes through `publishEvent` (RSVP), so this is
   * where people attached to a DRAFT listing are told. Run, awaited and
   * budgeted, ONLY after a real DRAFT → PUBLISHED flip (`changed`), never on
   * the idempotent replays. Never throws.
   */
  lineupNotices?: Pick<LineupNoticeHooks, "dispatch">;
  /** Reports a swallowed lineup-notice failure; the publish still succeeds. */
  reportError?: ReporterPort;
};

export async function publishCommunityListing(
  deps: PublishCommunityListingDeps,
  rawInput: unknown,
): Promise<PublishCommunityListingOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "publishCommunityListing",
  });

  const execute = async (): Promise<PublishCommunityListingOutput> => {
    const input = parseInput(publishCommunityListingInputSchema, rawInput);

    // Same actor gate as create (FR-005): COMMUNITY_MODERATOR or platform
    // ADMIN. Copied, not re-derived — `createListing` and this must never
    // drift apart.
    await requirePlatformStaff({
      authz: deps.authz,
      actorHumanId: input.actorHumanId,
      roles: COMMUNITY_MODERATION_ROLES,
    });

    const { event, changed, publishedAt, heldDates } = await deps.repos.tx(
      async (tx) => {
        const existing = await tx.events.getById(input.eventId);
        if (!existing) {
          throw fail("EVENT_NOT_FOUND");
        }
        // Publishing THROUGH this path is a COMMUNITY-listing capability.
        // Owned events go through `publishEvent` (payout terms, ticket types,
        // attestation, tax stamping) and must never be short-circuited here.
        // Distinct code rather than a 404 collapse, matching
        // `updateCommunityRecurrence`: the caller already cleared the staff
        // gate, so there is no anonymous oracle to protect and a moderator
        // deserves to know WHY.
        if (existing.stewardship !== "COMMUNITY") {
          throw fail("EVENT_NOT_COMMUNITY");
        }

        const now = deps.clock.now();

        // Idempotent replay — see the use-case doc. No settlement, no audit
        // row, no second `publishedAt`.
        if (existing.status === "PUBLISHED") {
          return {
            event: existing,
            changed: false,
            publishedAt: existing.publishedAt ?? now,
            heldDates: null,
          };
        }

        if (existing.status !== "DRAFT") {
          throw fail("EVENT_NOT_PUBLISHABLE", {
            meta: { status: existing.status },
          });
        }

        // Status + go-live stamp, CAS-guarded on "still DRAFT" (see the
        // use-case doc). Touches nothing else: an ownerless RSVP listing has
        // no currency, attestation or tax stamp to carry.
        const published = await tx.events.publishCommunityListingIfDraft({
          eventId: existing.id,
          publishedAt: now,
        });
        if (!published) {
          // A concurrent publish won the row between our read and this write.
          // Re-read and answer from the row's ACTUAL state: normally the
          // idempotent replay, but an end-state (a race with a cancel) is
          // still a refusal.
          const current = await tx.events.getById(existing.id);
          if (current?.status === "PUBLISHED") {
            return {
              event: current,
              changed: false,
              publishedAt: current.publishedAt ?? now,
              heldDates: null,
            };
          }
          throw fail("EVENT_NOT_PUBLISHABLE", {
            meta: { status: current?.status ?? "MISSING", raced: true },
          });
        }

        // FR-018, on the WRITTEN row and AFTER the status write (see the
        // use-case doc for the lock-ordering reason). An open challenge on one
        // of the lines throws and rolls the whole publish back — the listing
        // stays DRAFT rather than going live over a contested night.
        const settled = await settleHeldDatesForEvent(tx, {
          event: published,
          now,
          actorHumanId: input.actorHumanId,
          // Ownerless listing: the moderator is held to the venue-staff bar.
          owner: { kind: "community" },
        });

        // Attribution for an ownerless listing lives ONLY here — the row
        // itself stays ownerless (the same spec decision create is built on).
        await tx.audit.log({
          entity: "event",
          entityId: published.id,
          action: "community_listing.published",
          data: {
            actorHumanId: input.actorHumanId,
            slug: published.slug,
            startsAt: published.startsAt.toISOString(),
            endsAt: published.endsAt?.toISOString() ?? null,
            // A listing that was unpublished and re-published keeps its
            // ORIGINAL publishedAt; this records what THIS flip stamped.
            publishedAt: now.toISOString(),
          },
          at: now,
        });

        await markForSearchReindex(
          tx,
          [{ kind: "event", id: published.id }],
          now,
        );
        await enqueueEventFollowers(tx, published, now);
        return {
          event: published,
          changed: true,
          publishedAt: published.publishedAt ?? now,
          heldDates: settled,
        };
      },
    );

    // Best-effort incremental search-index update AFTER commit (never index a
    // row that rolled back). Skipped on the idempotent replay — the first
    // publish already indexed it and the nightly full-reindex reconciles any
    // drift. No-ops when `search` is absent.
    if (changed) {
      reindexAfterMutation(
        {
          repos: deps.repos,
          search: deps.search,
          clock: deps.clock,
          logger: deps.logger,
        },
        "publishCommunityListing",
        { kind: "event", id: event.id },
      );
    }

    if (changed) {
      await sweepLineupNoticesAfterPublish(
        {
          lineupNotices: deps.lineupNotices,
          reportError: deps.reportError,
          logger: scopedLogger,
        },
        event.id,
        "publishCommunityListing",
      );
    }

    scopedLogger?.info("publishCommunityListing.completed", {
      eventId: event.id,
      changed,
    });

    return publishCommunityListingOutputSchema.parse({
      event: {
        id: event.id,
        title: event.title,
        slug: event.slug,
        shortId: event.shortId,
        status: event.status,
        attendanceMode: event.attendanceMode,
        stewardship: event.stewardship,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        timezone: event.timezone,
      },
      changed,
      publishedAt,
      ...(heldDates && heldDates.intents.length > 0
        ? {
            notificationIntents: heldDates.intents,
            staffRecipientHint: heldDates.staffRecipientHint,
          }
        : {}),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("publishCommunityListing", execute);
  }

  return execute();
}
