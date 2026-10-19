import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { BookingIntent, Place as PrismaPlace } from "@prisma/client";

import {
  PLACE_MERGE_ID_SAMPLE_CAP,
  type MovePlaceOperationsInput,
  type MovePlaceOperationsResult,
  type PlaceMergeCounts,
  type PlaceMergeCountsInput,
  type PlaceMergeFillPatch,
  type PlaceMergeIdSample,
  type PlaceMergeIntentCounts,
  type PlaceMergeRepo,
  type PlaceMergeRow,
  type PlaceMergeRowSnapshot,
  type PlaceMergeSide,
  type PlaceMergeStandardDrop,
  type RepointPageRowsResult,
  type RepointPlaceRowsInput,
  type RepointPlaceRowsResult,
} from "@th/ports/repos/place-merge";

import type { PrismaClientOrTx } from "./types";

/** Hold statuses that stand in a line or own a night (not RELEASED). */
const LIVE_HOLD_STATUSES = ["ACTIVE", "CHALLENGED"] as const;
const HELD_STATUSES = ["ACTIVE", "CHALLENGED", "CONFIRMED"] as const;
/**
 * Whether this client's BookingHold has `grantId` (holds-without-a-request
 * FR-001). Read from the generated enum so the merge runs on either schema.
 */
const HOLDS_HAVE_GRANT_ID = "grantId" in Prisma.BookingHoldScalarFieldEnum;

/** Every BookingIntent (enums.prisma), for the standards lock keys. */
const BOOKING_INTENTS = ["PERFORM", "RENT", "USE"] as const satisfies readonly BookingIntent[];
/** Booking requests the open-pair partial unique indexes cover. */
const OPEN_REQUEST_STATUSES = ["PENDING", "VIEWED"] as const;

const sample = (ids: string[]): PlaceMergeIdSample => ({
  count: ids.length,
  ids: ids.slice(0, PLACE_MERGE_ID_SAMPLE_CAP),
});

/** `@db.Date` comes back as UTC midnight; compare calendar days as strings. */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** Dates and nested values → JSON-safe for the audit row. */
function snapshot(row: Record<string, unknown>): PlaceMergeRowSnapshot {
  return JSON.parse(JSON.stringify(row)) as PlaceMergeRowSnapshot;
}

/**
 * A dropped PlaceReviewSession for the audit row, minus its secrets. The
 * merged session collided with a survivor session on (sessionToken,
 * placeId), so the same token is still live on the survivor's row, and
 * AuditLog.data is readable by REVIEWER staff. The token is kept only as a
 * SHA-256 (enough to match it to the surviving row), the email only as
 * whether there was one.
 */
function reviewSessionSnapshot(row: Record<string, unknown>): PlaceMergeRowSnapshot {
  const { sessionToken, email, ...rest } = snapshot(row);
  return {
    ...rest,
    sessionTokenSha256:
      typeof sessionToken === "string"
        ? createHash("sha256").update(sessionToken).digest("hex")
        : null,
    hadEmail: typeof email === "string" && email.length > 0,
  };
}

/**
 * A dropped PlaceOwnership for the audit row: the proof JSON can hold the
 * claimant's email or other evidence, so only its `kind` is kept.
 */
function ownershipSnapshot(row: Record<string, unknown>): PlaceMergeRowSnapshot {
  const out = snapshot(row);
  const proof = out.proof;
  const kind =
    proof && typeof proof === "object" && !Array.isArray(proof)
      ? (proof as Record<string, unknown>).kind
      : undefined;
  out.proof = proof == null ? null : { kind: typeof kind === "string" ? kind : null };
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Place merge (merge-duplicate-places spec, 2026-10-13).
//
// Row mechanics only — core's `mergePlaces` decides what blocks, what fills,
// which ownership rows go. Every method runs on the caller's transaction
// after `lockForMerge`, so the reads below see a stable pair of places.
//
// Collision handling is "drop the merged side's row, then move the rest": the
// drop is by id (computed against the survivor's keys), the move is by the
// merged id, so a row inserted after the read (a polymorphic table with no FK
// to lock) still moves rather than being left pointing at a deleted place.
// Every dropped row is returned in full for the audit row (the reversal
// record). Polymorphic rows that have their own writer lock are covered by
// it: booking standards by the `booking_standards:*` advisory keys
// `lockForMerge` takes (the keys replace-all serialises on); hold lines by
// the `booking_hold_line:*` keys core takes before `lockForMerge`.
// ─────────────────────────────────────────────────────────────────────────────

/** Verification requests that are still open (mirrors place-verification-requests.ts). */
const ACTIVE_VERIFICATION_STATUSES = ["PENDING", "IN_REVIEW"] as const;

function toRow(p: PrismaPlace): PlaceMergeRow {
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    addrLine1: p.addrLine1,
    addrLine2: p.addrLine2,
    city: p.city,
    region: p.region,
    postcode: p.postcode,
    country: p.country,
    addressHash: p.addressHash,
    capacity: p.capacity,
    lat: p.lat,
    lng: p.lng,
    phone: p.phone,
    website: p.website,
    websiteSource: p.websiteSource,
    status: p.status,
    verification: p.verification,
    timezone: p.timezone,
    admissionTaxRateBps: p.admissionTaxRateBps,
    taxRateSource: p.taxRateSource,
    taxRateFetchedAt: p.taxRateFetchedAt,
    locationMode: p.locationMode,
    locationRadiusMeters: p.locationRadiusMeters,
    locationLabel: p.locationLabel,
    listedInDirectory: p.listedInDirectory,
    acceptsBookingRequests: p.acceptsBookingRequests,
    acceptsCommunityListings: p.acceptsCommunityListings,
    attendeeReviewsPublic: p.attendeeReviewsPublic,
    communityReviewsEnabled: p.communityReviewsEnabled,
    defaultPrimaryPayoutTermsId: p.defaultPrimaryPayoutTermsId,
    defaultResalePayoutTermsId: p.defaultResalePayoutTermsId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

const ids = (rows: { id: string }[]): string[] => rows.map((r) => r.id);

export function makePlaceMergeRepo(p: PrismaClientOrTx): PlaceMergeRepo {
  /** The merged place's calendar and space ids (for hold / standards / request reads). */
  async function calendarAndSpaceIds(placeId: string) {
    const [calendars, spaces] = await Promise.all([
      p.calendar.findMany({ where: { placeId }, select: { id: true } }),
      p.space.findMany({ where: { placeId }, select: { id: true } }),
    ]);
    return { calendarIds: ids(calendars), spaceIds: ids(spaces) };
  }

  /**
   * Merged default-calendar holds against the survivor's default line, by
   * calendar day. Both live, or both CONFIRMED → line conflict (core refuses).
   * One CONFIRMED, the other live → same night (core warns).
   */
  async function countHoldOverlaps(
    mergedCalendarId: string | null,
    survivorCalendarId: string | null,
  ): Promise<{ lineConflicts: PlaceMergeIdSample; sameNight: PlaceMergeIdSample }> {
    const none = { lineConflicts: sample([]), sameNight: sample([]) };
    if (!mergedCalendarId || !survivorCalendarId) return none;
    const [mergedHolds, survivorHolds] = await Promise.all([
      p.bookingHold.findMany({
        where: { calendarId: mergedCalendarId, status: { in: [...HELD_STATUSES] } },
        select: { id: true, date: true, status: true },
        orderBy: { id: "asc" },
      }),
      p.bookingHold.findMany({
        where: { calendarId: survivorCalendarId, status: { in: [...HELD_STATUSES] } },
        select: { date: true, status: true },
      }),
    ]);
    if (mergedHolds.length === 0 || survivorHolds.length === 0) return none;
    const isLive = (s: string) => (LIVE_HOLD_STATUSES as readonly string[]).includes(s);
    const survivorLive = new Set<string>();
    const survivorConfirmed = new Set<string>();
    for (const h of survivorHolds) {
      (isLive(h.status) ? survivorLive : survivorConfirmed).add(dayKey(h.date));
    }
    const line: string[] = [];
    const night: string[] = [];
    for (const h of mergedHolds) {
      const day = dayKey(h.date);
      const live = isLive(h.status);
      if (live ? survivorLive.has(day) : survivorConfirmed.has(day)) {
        line.push(h.id);
      } else if (live ? survivorConfirmed.has(day) : survivorLive.has(day)) {
        night.push(h.id);
      }
    }
    return { lineConflicts: sample(line), sameNight: sample(night) };
  }

  /**
   * Merged OPEN requests that would collide with an open survivor request on
   * "BookingRequest_open_pair_key" (performerOwnerType, performerOwnerId,
   * placeId) or "BookingRequest_open_anon_pair_key" (placeId,
   * lower(contactEmail)) WHERE performerOwnerId IS NULL. Both are partial on
   * status PENDING / VIEWED.
   */
  async function countOpenRequestConflicts(
    survivorId: string,
    mergedId: string,
  ): Promise<PlaceMergeIdSample> {
    const select = {
      id: true,
      performerOwnerType: true,
      performerOwnerId: true,
      contactEmail: true,
    } as const;
    const open = { in: [...OPEN_REQUEST_STATUSES] };
    const [mergedOpen, survivorOpen] = await Promise.all([
      p.bookingRequest.findMany({
        where: { placeId: mergedId, status: open },
        select,
        orderBy: { id: "asc" },
      }),
      p.bookingRequest.findMany({
        where: { placeId: survivorId, status: open },
        select,
      }),
    ]);
    if (mergedOpen.length === 0 || survivorOpen.length === 0) return sample([]);
    const performerKey = (r: { performerOwnerType: string | null; performerOwnerId: string | null }) =>
      `${r.performerOwnerType ?? ""}:${r.performerOwnerId}`;
    const survivorPerformers = new Set(
      survivorOpen.filter((r) => r.performerOwnerId !== null).map(performerKey),
    );
    const survivorEmails = new Set(
      survivorOpen
        .filter((r) => r.performerOwnerId === null && r.contactEmail)
        .map((r) => r.contactEmail!.toLowerCase()),
    );
    return sample(
      mergedOpen
        .filter((r) =>
          r.performerOwnerId !== null
            ? survivorPerformers.has(performerKey(r))
            : !!r.contactEmail && survivorEmails.has(r.contactEmail.toLowerCase()),
        )
        .map((r) => r.id),
    );
  }

  /**
   * Merged availability rows that will apply to the survivor's default
   * calendar (the folded default calendar's rows, and place-wide rows) that
   * share a date, or a weekday (both recurring), with a survivor row that
   * applies there (its default calendar's rows and its place-wide rows).
   */
  async function countAvailabilityOverlaps(
    survivorId: string,
    mergedId: string,
    mergedFoldedCalendarId: string | null,
    survivorDefaultCalendarId: string | null,
  ): Promise<PlaceMergeIdSample> {
    const select = { id: true, dayOfWeek: true, date: true } as const;
    const [candidates, survivorRows] = await Promise.all([
      p.calendarAvailability.findMany({
        where: {
          placeId: mergedId,
          OR: [
            { calendarId: null },
            ...(mergedFoldedCalendarId ? [{ calendarId: mergedFoldedCalendarId }] : []),
          ],
        },
        select,
        orderBy: { id: "asc" },
      }),
      p.calendarAvailability.findMany({
        where: {
          placeId: survivorId,
          OR: [
            { calendarId: null },
            ...(survivorDefaultCalendarId
              ? [{ calendarId: survivorDefaultCalendarId }]
              : []),
          ],
        },
        select,
      }),
    ]);
    if (candidates.length === 0 || survivorRows.length === 0) return sample([]);
    const dates = new Set(survivorRows.filter((r) => r.date).map((r) => dayKey(r.date!)));
    const weekdays = new Set(
      survivorRows
        .filter((r) => !r.date && r.dayOfWeek !== null)
        .map((r) => r.dayOfWeek),
    );
    return sample(
      candidates
        .filter((r) =>
          r.date ? dates.has(dayKey(r.date)) : r.dayOfWeek !== null && weekdays.has(r.dayOfWeek),
        )
        .map((r) => r.id),
    );
  }

  async function intentCounts(
    model: "bookingStandardItem" | "bookingPitchExample",
    ownerType: "PLACE" | "CALENDAR",
    ownerId: string | null,
  ): Promise<PlaceMergeIntentCounts> {
    if (!ownerId) return [];
    const where = { ownerType, ownerId };
    const rows =
      model === "bookingStandardItem"
        ? await p.bookingStandardItem.groupBy({
            by: ["intent"],
            where,
            _count: { _all: true },
          })
        : await p.bookingPitchExample.groupBy({
            by: ["intent"],
            where,
            _count: { _all: true },
          });
    return rows
      .map((r) => ({ intent: r.intent as string, count: r._count._all }))
      .sort((a, b) => a.intent.localeCompare(b.intent));
  }

  async function countStandards(
    survivorId: string,
    mergedId: string,
    mergedDefaultCalendarId: string | null,
    survivorDefaultCalendarId: string | null,
  ) {
    const owners = async (model: "bookingStandardItem" | "bookingPitchExample") => {
      const [mergedPlace, mergedDefaultCalendar, survivorPlace, survivorDefaultCalendar] =
        await Promise.all([
          intentCounts(model, "PLACE", mergedId),
          intentCounts(model, "CALENDAR", mergedDefaultCalendarId),
          intentCounts(model, "PLACE", survivorId),
          intentCounts(model, "CALENDAR", survivorDefaultCalendarId),
        ]);
      return { mergedPlace, mergedDefaultCalendar, survivorPlace, survivorDefaultCalendar };
    };
    const [items, examples] = await Promise.all([
      owners("bookingStandardItem"),
      owners("bookingPitchExample"),
    ]);
    return { items, examples };
  }

  return {
    async lockForMerge({ placeIds, lineKeys }) {
      const sorted = [...new Set(placeIds)].sort();
      // One statement per row, in id order: two merges touching the same pair
      // queue on the first row instead of deadlocking.
      for (const id of sorted) {
        await p.$queryRaw`SELECT "id" FROM "Place" WHERE "id" = ${id} FOR UPDATE`;
      }
      // Calendars next. A BookingHold or Event insert takes a key-share lock
      // on its calendar, so an INSERT after this point waits for the merge
      // (and then fails its FK on a folded calendar). This delays the
      // insert only, not a placer's read of the line before it: the
      // line-scoped race is closed by the `booking_hold_line` advisory locks
      // core takes before this method (see mergePlaces).
      const calendars = await p.calendar.findMany({
        where: { placeId: { in: sorted } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const calendar of calendars) {
        await p.$queryRaw`SELECT "id" FROM "Calendar" WHERE "id" = ${calendar.id} FOR UPDATE`;
      }
      // Spaces next: an Event / BookingHold / BookingRequest insert naming a
      // space takes a key-share lock on it, so nothing new lands on a room
      // the merge is moving or folding.
      const spaces = await p.space.findMany({
        where: { placeId: { in: sorted } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const space of spaces) {
        await p.$queryRaw`SELECT "id" FROM "Space" WHERE "id" = ${space.id} FOR UPDATE`;
      }
      // Then the live and confirmed holds on the lines core advisory-locked
      // (the merged default calendar's held days, on both default calendars),
      // line by line in sortLineKeys order, each line in id order. These are
      // the only lines whose membership the merge changes, and the only holds
      // the overlap check reads that matter. Every other hold keeps its line:
      // a re-parented calendar moves with its lines, and the Main Space fold
      // changes spaceId only. Holds elsewhere are NOT locked, so a placer on
      // another line (line lock, then its rows) never waits on the merge.
      const lines = [...lineKeys].sort((a, b) =>
        a.calendarId === b.calendarId
          ? a.date.localeCompare(b.date)
          : a.calendarId < b.calendarId
            ? -1
            : 1,
      );
      for (const line of lines) {
        await p.$queryRaw`
          SELECT "id" FROM "BookingHold"
          WHERE "calendarId" = ${line.calendarId}
            AND "date" = ${line.date}::date
            AND "status" IN ('ACTIVE', 'CHALLENGED', 'CONFIRMED')
          ORDER BY "id"
          FOR UPDATE
        `;
      }
      // Waivers: a waiver toggled mid-merge cannot leave two active ones.
      const waivers = await p.placeWaiver.findMany({
        where: { placeId: { in: sorted } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const w of waivers) {
        await p.$queryRaw`SELECT "id" FROM "PlaceWaiver" WHERE "id" = ${w.id} FOR UPDATE`;
      }
      const pages = await p.entityPage.findMany({
        where: { ownerType: "PLACE", ownerId: { in: sorted } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const page of pages) {
        await p.$queryRaw`SELECT "id" FROM "EntityPage" WHERE "id" = ${page.id} FOR UPDATE`;
      }
      // Booking standards: the advisory keys `replaceItems` / `replaceExamples`
      // serialise on (booking-standards.ts `lockOwnerIntent`), for both places
      // and both default calendars, every intent, both tables, sorted. This
      // protects only saves that commit BEFORE the merge: the merge then
      // reads and moves the lists they wrote. A save already waiting on one
      // of these keys proceeds after the merge commits and can still write
      // to an owner the merge deleted (the folded calendar, the merged
      // place). Follow-up outside this diff: manage-booking-standards should
      // re-check its owner after taking the lock.
      const defaults = await p.calendar.findMany({
        where: { placeId: { in: sorted }, isDefault: true },
        select: { id: true },
      });
      const owners = [
        ...sorted.map((id) => `PLACE:${id}`),
        ...defaults.map((c) => `CALENDAR:${c.id}`),
      ];
      const keys: string[] = [];
      for (const table of ["items", "examples"]) {
        for (const owner of owners) {
          for (const intent of BOOKING_INTENTS) {
            keys.push(`booking_standards:${table}:${owner}:${intent}`);
          }
        }
      }
      keys.sort();
      for (const key of keys) {
        await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      }
    },

    async listFoldLineKeys({ survivorId, mergedId }) {
      const [survivorDefault, mergedDefault] = await Promise.all([
        p.calendar.findFirst({
          where: { placeId: survivorId, isDefault: true },
          select: { id: true },
        }),
        p.calendar.findFirst({
          where: { placeId: mergedId, isDefault: true },
          select: { id: true },
        }),
      ]);
      if (!survivorDefault || !mergedDefault) return [];
      const holds = await p.bookingHold.findMany({
        where: { calendarId: mergedDefault.id, status: { in: [...HELD_STATUSES] } },
        select: { date: true },
        distinct: ["date"],
      });
      return holds.flatMap((h) => [
        { calendarId: survivorDefault.id, date: dayKey(h.date) },
        { calendarId: mergedDefault.id, date: dayKey(h.date) },
      ]);
    },

    async getSide(placeId): Promise<PlaceMergeSide | null> {
      const place = await p.place.findUnique({ where: { id: placeId } });
      if (!place) return null;
      const [defaultCalendar, page, ownerships, calendars, spaces, layouts] = await Promise.all([
        p.calendar.findFirst({
          where: { placeId, isDefault: true },
          select: { id: true, primarySpaceId: true },
        }),
        p.entityPage.findUnique({
          where: { ownerType_ownerId: { ownerType: "PLACE", ownerId: placeId } },
          select: { id: true, slug: true },
        }),
        p.placeOwnership.findMany({
          where: { placeId },
          select: {
            id: true,
            ownerType: true,
            ownerId: true,
            verified: true,
            revokedAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        p.calendar.findMany({
          where: { placeId },
          select: {
            id: true,
            name: true,
            slug: true,
            isDefault: true,
            primarySpaceId: true,
          },
          orderBy: { id: "asc" },
        }),
        p.space.findMany({
          where: { placeId },
          select: { id: true, name: true },
          orderBy: { id: "asc" },
        }),
        p.placeLayout.findMany({
          where: { placeId },
          select: { id: true, name: true },
          orderBy: { id: "asc" },
        }),
      ]);
      return {
        calendars,
        spaces,
        layouts,
        place: toRow(place),
        defaultCalendarId: defaultCalendar?.id ?? null,
        mainSpaceId: defaultCalendar?.primarySpaceId ?? null,
        page: page ?? null,
        ownerships: ownerships.map((o) => ({
          id: o.id,
          ownerType: o.ownerType,
          ownerId: o.ownerId,
          verified: o.verified,
          revoked: o.revokedAt !== null,
        })),
      };
    },

    async count(input: PlaceMergeCountsInput): Promise<PlaceMergeCounts> {
      const { survivorId, mergedId } = input;
      const { calendarIds } = await calendarAndSpaceIds(mergedId);
      // The merged default calendar folds into the survivor's only when both
      // exist (core: `foldsDefaultCalendar`); otherwise nothing lands on the
      // survivor's line and there is nothing to overlap.
      const fold =
        input.mergedDefaultCalendarId !== null &&
        input.survivorDefaultCalendarId !== null;

      const [survivorEmbeds, survivorFeatured, survivorSessions] =
        await Promise.all([
          p.embed.findMany({
            where: { subjectType: "place", subjectId: survivorId },
            select: { domain: true },
          }),
          p.featuredItem.count({
            where: { itemType: "PLACE", itemId: survivorId },
          }),
          p.placeReviewSession.findMany({
            where: { placeId: survivorId },
            select: { sessionToken: true },
          }),
        ]);
      const survivorDomains = survivorEmbeds.map((e) => e.domain);
      const survivorTokens = survivorSessions.map((s) => s.sessionToken);
      const survivorPendingReporters = (
        await p.entityReport.findMany({
          where: {
            subjectType: "PLACE",
            subjectId: survivorId,
            status: "PENDING",
          },
          select: { reporterHumanId: true },
        })
      ).map((r) => r.reporterHumanId);

      const pageCounts = async () => {
        if (!input.mergedPageId) {
          return {
            follows: 0,
            followsDropped: 0,
            eventNotices: 0,
            eventNoticesDropped: 0,
            pageSlugHistory: 0,
          };
        }
        const mergedPageId = input.mergedPageId;
        const [follows, notices, history] = await Promise.all([
          p.entityFollow.findMany({
            where: { entityPageId: mergedPageId },
            select: { followerHumanId: true },
          }),
          p.entityEventNotice.findMany({
            where: { entityPageId: mergedPageId },
            select: { eventId: true },
          }),
          p.pageSlugHistory.count({ where: { pageId: mergedPageId } }),
        ]);
        let followsDropped = 0;
        let eventNoticesDropped = 0;
        if (input.survivorPageId) {
          followsDropped = await p.entityFollow.count({
            where: {
              entityPageId: input.survivorPageId,
              followerHumanId: { in: follows.map((f) => f.followerHumanId) },
            },
          });
          eventNoticesDropped = await p.entityEventNotice.count({
            where: {
              entityPageId: input.survivorPageId,
              eventId: { in: notices.map((n) => n.eventId) },
            },
          });
        }
        return {
          follows: follows.length - followsDropped,
          followsDropped,
          eventNotices: notices.length - eventNoticesDropped,
          eventNoticesDropped,
          pageSlugHistory: history,
        };
      };

      const [
        activeVerificationRequests,
        collidingEmbeds,
        events,
        venueConfirmedEvents,
        eventsOnDefaultCalendar,
        eventsOnMainSpace,
        attendeeReviews,
        postEventPrompts,
        membershipBenefits,
        savedLocations,
        placeReviews,
        placeReviewSessionsTotal,
        placeReviewSessionsDropped,
        volunteerAsks,
        entityReportsTotal,
        entityReportsDropped,
        featuredItemsTotal,
        embeds,
        verificationRequests,
        pages,
        bookingRequests,
        agreements,
        bookingGrants,
        waivers,
        posReaders,
        layouts,
        calendarAvailability,
        bookingHolds,
        placeWideAvailability,
        activeWaiversSurvivor,
        activeWaiversMerged,
        communityEvents,
      ] = await Promise.all([
        p.placeVerificationRequest.count({
          where: {
            placeId: mergedId,
            status: { in: [...ACTIVE_VERIFICATION_STATUSES] },
          },
        }),
        survivorDomains.length > 0
          ? p.embed.count({
              where: {
                subjectType: "place",
                subjectId: mergedId,
                domain: { in: survivorDomains },
              },
            })
          : Promise.resolve(0),
        p.event.count({ where: { placeId: mergedId } }),
        p.event.count({
          where: { placeId: mergedId, venueConfirmedPlaceId: mergedId },
        }),
        fold && input.mergedDefaultCalendarId
          ? p.event.count({
              where: { calendarId: input.mergedDefaultCalendarId },
            })
          : Promise.resolve(0),
        fold && input.mergedMainSpaceId
          ? p.event.count({ where: { spaceId: input.mergedMainSpaceId } })
          : Promise.resolve(0),
        p.attendeeReview.count({ where: { placeId: mergedId } }),
        p.postEventPrompt.count({ where: { placeId: mergedId } }),
        p.membershipBenefit.count({ where: { placeId: mergedId } }),
        p.savedLocation.count({ where: { placeId: mergedId } }),
        p.placeReview.count({ where: { placeId: mergedId } }),
        p.placeReviewSession.count({ where: { placeId: mergedId } }),
        survivorTokens.length > 0
          ? p.placeReviewSession.count({
              where: { placeId: mergedId, sessionToken: { in: survivorTokens } },
            })
          : Promise.resolve(0),
        p.volunteerAsk.count({
          where: { subjectType: "PLACE", subjectId: mergedId },
        }),
        p.entityReport.count({
          where: { subjectType: "PLACE", subjectId: mergedId },
        }),
        survivorPendingReporters.length > 0
          ? p.entityReport.count({
              where: {
                subjectType: "PLACE",
                subjectId: mergedId,
                status: "PENDING",
                reporterHumanId: { in: survivorPendingReporters },
              },
            })
          : Promise.resolve(0),
        p.featuredItem.count({ where: { itemType: "PLACE", itemId: mergedId } }),
        p.embed.count({ where: { subjectType: "place", subjectId: mergedId } }),
        p.placeVerificationRequest.count({
          where: {
            placeId: mergedId,
            status: { notIn: [...ACTIVE_VERIFICATION_STATUSES] },
          },
        }),
        pageCounts(),
        p.bookingRequest.count({ where: { placeId: mergedId } }),
        p.agreement.count({ where: { placeId: mergedId } }),
        p.placeBookingGrant.count({ where: { placeId: mergedId } }),
        p.placeWaiver.count({ where: { placeId: mergedId } }),
        p.posReader.count({ where: { placeId: mergedId } }),
        p.placeLayout.count({ where: { placeId: mergedId } }),
        p.calendarAvailability.count({ where: { placeId: mergedId } }),
        calendarIds.length > 0
          ? p.bookingHold.count({ where: { calendarId: { in: calendarIds } } })
          : Promise.resolve(0),
        p.calendarAvailability.count({
          where: { placeId: mergedId, calendarId: null },
        }),
        p.placeWaiver.count({ where: { placeId: survivorId, isActive: true } }),
        p.placeWaiver.count({ where: { placeId: mergedId, isActive: true } }),
        p.event.count({
          where: { placeId: mergedId, stewardship: "COMMUNITY" },
        }),
      ]);

      const featuredItemsDropped = survivorFeatured > 0 ? featuredItemsTotal : 0;

      const [holds, openRequestConflicts, availabilityOverlaps, standards] =
        await Promise.all([
          countHoldOverlaps(
            fold ? input.mergedDefaultCalendarId : null,
            fold ? input.survivorDefaultCalendarId : null,
          ),
          countOpenRequestConflicts(survivorId, mergedId),
          countAvailabilityOverlaps(
            survivorId,
            mergedId,
            fold ? input.mergedDefaultCalendarId : null,
            input.survivorDefaultCalendarId,
          ),
          countStandards(
            survivorId,
            mergedId,
            input.mergedDefaultCalendarId,
            input.survivorDefaultCalendarId,
          ),
        ]);

      // JSON payloads with `location: { kind: "place", placeId }` (core
      // series/schemas.ts locationSchema); `moveOperations` rewrites them.
      const placeLocation = {
        path: ["location", "placeId"],
        equals: mergedId,
      };
      const [
        series,
        templates,
        occurrences,
        activeGrantRows,
        imageModerationRecords,
        survivorOpenBookingRequests,
        survivorLiveAgreements,
      ] = await Promise.all([
          p.eventSeries.count({ where: { defaults: placeLocation } }),
          p.eventTemplate.count({ where: { defaults: placeLocation } }),
          p.eventSeriesOccurrence.count({ where: { overrides: placeLocation } }),
          p.placeBookingGrant.findMany({
            where: { placeId: mergedId, revokedAt: null },
            select: { id: true, calendarId: true },
            orderBy: { id: "asc" },
          }),
          p.imageModerationRecord.count({
            where: { subjectType: "PLACE", subjectId: mergedId },
          }),
          // Every non-terminal request status: what the incoming owner will control.
          // Same set as INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES today, but it
          // means "under the owner's control", so it is kept separate.
          p.bookingRequest.count({
            where: { placeId: survivorId, status: { in: ["PENDING", "VIEWED", "ACCEPTED"] } },
          }),
          // Every non-terminal agreement status. DISPUTED counts (the new owner
          // takes the dispute over), unlike cancel-booking's AGREEMENT_LIVE_STATUSES.
          p.agreement.count({
            where: {
              placeId: survivorId,
              status: { in: ["DRAFT", "PROPOSED", "COUNTERED", "ACCEPTED", "DISPUTED"] },
            },
          }),
        ]);

      return {
        operations: {
          activeVerificationRequests,
          collidingEmbeds,
          communityEvents,
          holdLineConflicts: holds.lineConflicts,
          holdSameNight: holds.sameNight,
          openRequestConflicts,
          activeWaivers: {
            survivor: activeWaiversSurvivor,
            merged: activeWaiversMerged,
          },
          availabilityOverlaps,
          placeWideAvailability,
          activeGrants: sample(ids(activeGrantRows)),
          wholePlaceGrants: sample(
            ids(activeGrantRows.filter((g) => g.calendarId === null)),
          ),
          survivorControl: {
            openBookingRequests: survivorOpenBookingRequests,
            liveAgreements: survivorLiveAgreements,
          },
          standards,
        },
        moves: {
          events,
          venueConfirmedEvents,
          eventsOnDefaultCalendar,
          eventsOnMainSpace,
          attendeeReviews,
          postEventPrompts,
          membershipBenefits,
          savedLocations,
          placeReviews,
          placeReviewSessions:
            placeReviewSessionsTotal - placeReviewSessionsDropped,
          placeReviewSessionsDropped,
          volunteerAsks,
          entityReports: entityReportsTotal - entityReportsDropped,
          entityReportsDropped,
          featuredItems: featuredItemsTotal - featuredItemsDropped,
          featuredItemsDropped,
          embeds,
          verificationRequests,
          ...pages,
          bookingRequests,
          agreements,
          bookingGrants,
          waivers,
          posReaders,
          layouts,
          calendarAvailability,
          bookingHolds,
          series,
          templates,
          occurrences,
          imageModerationRecords,
        },
      };
    },

    async fillFields(placeId, patch: PlaceMergeFillPatch) {
      if (Object.keys(patch).length === 0) return;
      await p.place.update({ where: { id: placeId }, data: patch });
    },

    async repointPlaceRows(
      input: RepointPlaceRowsInput,
    ): Promise<RepointPlaceRowsResult> {
      const { survivorId, mergedId } = input;

      // ── Events. Calendar / space first, while the ids are still the
      // merged place's; then placeId and the venue confirmation together, so
      // a confirmation (which counts only while placeId equals it) holds.
      const eventsCalendarRepointed = input.calendar
        ? ids(
            await p.event.findMany({
              where: { calendarId: input.calendar.from },
              select: { id: true },
            }),
          )
        : [];
      if (input.calendar) {
        await p.event.updateMany({
          where: { calendarId: input.calendar.from },
          data: { calendarId: input.calendar.to },
        });
      }
      const eventsSpaceRepointed = input.space
        ? ids(
            await p.event.findMany({
              where: { spaceId: input.space.from },
              select: { id: true },
            }),
          )
        : [];
      if (input.space) {
        await p.event.updateMany({
          where: { spaceId: input.space.from },
          data: { spaceId: input.space.to },
        });
      }
      const events = ids(
        await p.event.findMany({
          where: { placeId: mergedId },
          select: { id: true },
        }),
      );
      // The confirmation stamp moves ONLY with an event still at the merged
      // place, in the same statement as its placeId. A lapsed stamp (the
      // event moved elsewhere since) stays as it is: re-pointing it would
      // make it a live confirmation at the survivor that its owner never gave.
      const confirmedHere = { placeId: mergedId, venueConfirmedPlaceId: mergedId };
      const venueConfirmedEvents = ids(
        await p.event.findMany({ where: confirmedHere, select: { id: true } }),
      );
      await p.event.updateMany({
        where: confirmedHere,
        data: { placeId: survivorId, venueConfirmedPlaceId: survivorId },
      });
      await p.event.updateMany({
        where: { placeId: mergedId },
        data: { placeId: survivorId },
      });

      // ── Plain placeId columns and FKs with no unique key on placeId.
      const moveByPlaceId = async (
        find: () => Promise<{ id: string }[]>,
        update: () => Promise<unknown>,
      ): Promise<string[]> => {
        const found = ids(await find());
        await update();
        return found;
      };
      const where = { placeId: mergedId };
      const data = { placeId: survivorId };
      const attendeeReviews = await moveByPlaceId(
        () => p.attendeeReview.findMany({ where, select: { id: true } }),
        () => p.attendeeReview.updateMany({ where, data }),
      );
      const postEventPrompts = await moveByPlaceId(
        () => p.postEventPrompt.findMany({ where, select: { id: true } }),
        () => p.postEventPrompt.updateMany({ where, data }),
      );
      const membershipBenefits = await moveByPlaceId(
        () => p.membershipBenefit.findMany({ where, select: { id: true } }),
        () => p.membershipBenefit.updateMany({ where, data }),
      );
      const savedLocations = await moveByPlaceId(
        () => p.savedLocation.findMany({ where, select: { id: true } }),
        () => p.savedLocation.updateMany({ where, data }),
      );
      const placeReviews = await moveByPlaceId(
        () => p.placeReview.findMany({ where, select: { id: true } }),
        () => p.placeReview.updateMany({ where, data }),
      );
      // Closed verification requests are the place's trust history; they
      // (and their documents) move rather than cascade away. Open ones
      // refuse the merge in core.
      const verificationRequests = await moveByPlaceId(
        () =>
          p.placeVerificationRequest.findMany({
            where: {
              placeId: mergedId,
              status: { notIn: [...ACTIVE_VERIFICATION_STATUSES] },
            },
            select: { id: true },
          }),
        () =>
          p.placeVerificationRequest.updateMany({
            where: {
              placeId: mergedId,
              status: { notIn: [...ACTIVE_VERIFICATION_STATUSES] },
            },
            data,
          }),
      );

      // ── PlaceReviewSession: @@unique([sessionToken, placeId]). A token the
      // survivor already has drops the merged session.
      const survivorTokens = (
        await p.placeReviewSession.findMany({
          where: { placeId: survivorId },
          select: { sessionToken: true },
        })
      ).map((s) => s.sessionToken);
      const placeReviewSessionsDropped =
        survivorTokens.length > 0
          ? ids(
              await p.placeReviewSession.findMany({
                where: { placeId: mergedId, sessionToken: { in: survivorTokens } },
                select: { id: true },
              }),
            )
          : [];
      const placeReviewSessionsDroppedRows =
        placeReviewSessionsDropped.length > 0
          ? await p.placeReviewSession.findMany({
              where: { id: { in: placeReviewSessionsDropped } },
            })
          : [];
      if (placeReviewSessionsDropped.length > 0) {
        await p.placeReviewSession.deleteMany({
          where: { id: { in: placeReviewSessionsDropped } },
        });
      }
      const placeReviewSessions = await moveByPlaceId(
        () => p.placeReviewSession.findMany({ where, select: { id: true } }),
        () => p.placeReviewSession.updateMany({ where, data }),
      );

      // ── VolunteerAsk(PLACE): no unique key on the subject.
      const askWhere = { subjectType: "PLACE" as const, subjectId: mergedId };
      const volunteerAsks = ids(
        await p.volunteerAsk.findMany({ where: askWhere, select: { id: true } }),
      );
      await p.volunteerAsk.updateMany({
        where: askWhere,
        data: { subjectId: survivorId },
      });

      // ── EntityReport(PLACE): SQL-only partial unique (reporter, subject)
      // WHERE PENDING. A reporter with a pending report on both keeps the
      // survivor's.
      const reportWhere = { subjectType: "PLACE" as const, subjectId: mergedId };
      const survivorPendingReporters = (
        await p.entityReport.findMany({
          where: {
            subjectType: "PLACE",
            subjectId: survivorId,
            status: "PENDING",
          },
          select: { reporterHumanId: true },
        })
      ).map((r) => r.reporterHumanId);
      const entityReportsDropped =
        survivorPendingReporters.length > 0
          ? ids(
              await p.entityReport.findMany({
                where: {
                  ...reportWhere,
                  status: "PENDING",
                  reporterHumanId: { in: survivorPendingReporters },
                },
                select: { id: true },
              }),
            )
          : [];
      const entityReportsDroppedRows =
        entityReportsDropped.length > 0
          ? await p.entityReport.findMany({ where: { id: { in: entityReportsDropped } } })
          : [];
      if (entityReportsDropped.length > 0) {
        await p.entityReport.deleteMany({
          where: { id: { in: entityReportsDropped } },
        });
      }
      const entityReports = ids(
        await p.entityReport.findMany({
          where: reportWhere,
          select: { id: true },
        }),
      );
      await p.entityReport.updateMany({
        where: reportWhere,
        data: { subjectId: survivorId },
      });

      // ── FeaturedItem(PLACE): @@unique([itemType, itemId]). The survivor's
      // own curation wins.
      const featuredWhere = { itemType: "PLACE" as const, itemId: mergedId };
      const survivorFeatured = await p.featuredItem.count({
        where: { itemType: "PLACE", itemId: survivorId },
      });
      const mergedFeatured = ids(
        await p.featuredItem.findMany({
          where: featuredWhere,
          select: { id: true },
        }),
      );
      let featuredItems: string[] = [];
      let featuredItemsDropped: string[] = [];
      let featuredItemsDroppedRows: unknown[] = [];
      if (survivorFeatured > 0) {
        featuredItemsDropped = mergedFeatured;
        featuredItemsDroppedRows = await p.featuredItem.findMany({ where: featuredWhere });
        await p.featuredItem.deleteMany({ where: featuredWhere });
      } else {
        featuredItems = mergedFeatured;
        await p.featuredItem.updateMany({
          where: featuredWhere,
          data: { itemId: survivorId },
        });
      }

      // ── Embed(place): @@unique([subjectType, subjectId, domain]). Core has
      // already refused a collision, so a plain move is safe (and a racing
      // insert fails the unique index, rolling the merge back).
      const embedWhere = { subjectType: "place", subjectId: mergedId };
      const embeds = ids(
        await p.embed.findMany({ where: embedWhere, select: { id: true } }),
      );
      await p.embed.updateMany({
        where: embedWhere,
        data: { subjectId: survivorId },
      });

      // ── PlaceOwnership: core picked the rows to drop on either side so no
      // (placeId, ownerType, ownerId) pair collides.
      const ownershipsDropped = [...input.dropOwnershipIds];
      // Closed verification requests hold `ownershipId` with no FK. Point any
      // request (just moved, or the survivor's own) at the kept row of the
      // same owner before the dropped row goes.
      for (const r of input.repointOwnershipIds ?? []) {
        await p.placeVerificationRequest.updateMany({
          where: { placeId: survivorId, ownershipId: r.from },
          data: { ownershipId: r.to },
        });
      }
      const ownershipsDroppedRows =
        ownershipsDropped.length > 0
          ? await p.placeOwnership.findMany({
              where: {
                id: { in: ownershipsDropped },
                placeId: { in: [survivorId, mergedId] },
              },
            })
          : [];
      if (ownershipsDropped.length > 0) {
        await p.placeOwnership.deleteMany({
          where: {
            id: { in: ownershipsDropped },
            placeId: { in: [survivorId, mergedId] },
          },
        });
      }
      const ownerships = await moveByPlaceId(
        () => p.placeOwnership.findMany({ where, select: { id: true } }),
        () => p.placeOwnership.updateMany({ where, data }),
      );

      // ── ImageModerationRecord(subject PLACE): the review queue's deep link
      // follows the place. No FK, no unique key on the subject.
      const moderationWhere = { subjectType: "PLACE", subjectId: mergedId };
      const imageModerationRecords = ids(
        await p.imageModerationRecord.findMany({
          where: moderationWhere,
          select: { id: true },
        }),
      );
      if (imageModerationRecords.length > 0) {
        await p.imageModerationRecord.updateMany({
          where: moderationWhere,
          data: { subjectId: survivorId },
        });
      }

      const snap = (rows: unknown[]) =>
        rows.map((r) => snapshot(r as Record<string, unknown>));
      return {
        imageModerationRecords,
        droppedRows: {
          placeReviewSessions: placeReviewSessionsDroppedRows.map((r) =>
            reviewSessionSnapshot(r as unknown as Record<string, unknown>),
          ),
          entityReports: snap(entityReportsDroppedRows),
          featuredItems: snap(featuredItemsDroppedRows),
          ownerships: ownershipsDroppedRows.map((r) =>
            ownershipSnapshot(r as unknown as Record<string, unknown>),
          ),
        },
        events,
        venueConfirmedEvents,
        eventsCalendarRepointed,
        eventsSpaceRepointed,
        attendeeReviews,
        postEventPrompts,
        membershipBenefits,
        savedLocations,
        placeReviews,
        placeReviewSessions,
        placeReviewSessionsDropped,
        volunteerAsks,
        entityReports,
        entityReportsDropped,
        featuredItems,
        featuredItemsDropped,
        embeds,
        ownerships,
        ownershipsDropped,
        verificationRequests,
      };
    },

    async moveOperations(
      input: MovePlaceOperationsInput,
    ): Promise<MovePlaceOperationsResult> {
      const { survivorId, mergedId, calendar: cal, space: sp } = input;
      const toSurvivor = { placeId: survivorId };
      const atMerged = { placeId: mergedId };

      // Read the full lists BEFORE anything moves (the audit row is the
      // reversal record, so every id is kept, uncapped).
      const mergedCalendarIds = ids(
        await p.calendar.findMany({ where: atMerged, select: { id: true } }),
      );
      const bookingHolds =
        mergedCalendarIds.length > 0
          ? ids(
              await p.bookingHold.findMany({
                where: { calendarId: { in: mergedCalendarIds } },
                select: { id: true },
                orderBy: { id: "asc" },
              }),
            )
          : [];

      /** Find ids, then update the same rows by the same filter. */
      const repoint = async (
        find: () => Promise<{ id: string }[]>,
        update: () => Promise<unknown>,
      ): Promise<string[]> => {
        const found = ids(await find());
        if (found.length > 0) await update();
        return found;
      };

      // ── 1. Holds. Calendar fold, then the Main Space fold on every hold
      // (a hold on a moved calendar may name the folded room). Status,
      // position and every other column are left exactly as they were; core
      // has refused any line the move would break.
      const bookingHoldsCalendarRepointed = cal
        ? await repoint(
            () => p.bookingHold.findMany({ where: { calendarId: cal.from }, select: { id: true } }),
            () =>
              p.bookingHold.updateMany({
                where: { calendarId: cal.from },
                data: { calendarId: cal.to },
              }),
          )
        : [];
      const bookingHoldsSpaceRepointed = sp
        ? await repoint(
            () => p.bookingHold.findMany({ where: { spaceId: sp.from }, select: { id: true } }),
            () =>
              p.bookingHold.updateMany({
                where: { spaceId: sp.from },
                data: { spaceId: sp.to },
              }),
          )
        : [];

      // ── 2. Booking requests (placeId CASCADES from Place: every one moves).
      const bookingRequests = ids(
        await p.bookingRequest.findMany({ where: atMerged, select: { id: true } }),
      );
      const bookingRequestsCalendarRepointed = cal
        ? await repoint(
            () => p.bookingRequest.findMany({ where: { calendarId: cal.from }, select: { id: true } }),
            () =>
              p.bookingRequest.updateMany({
                where: { calendarId: cal.from },
                data: { calendarId: cal.to },
              }),
          )
        : [];
      const bookingRequestsSpaceRepointed = sp
        ? await repoint(
            () => p.bookingRequest.findMany({ where: { spaceId: sp.from }, select: { id: true } }),
            () =>
              p.bookingRequest.updateMany({
                where: { spaceId: sp.from },
                data: { spaceId: sp.to },
              }),
          )
        : [];
      if (bookingRequests.length > 0) {
        await p.bookingRequest.updateMany({ where: atMerged, data: toSurvivor });
      }

      // ── 3. Grants (placeId and calendarId both CASCADE). No unique key:
      // a grantee with a grant on both places keeps both (the authz lookup
      // already picks deterministically among several).
      const bookingGrants = ids(
        await p.placeBookingGrant.findMany({ where: atMerged, select: { id: true } }),
      );
      // Owners not compatible (core): a former owner's grants end. Their
      // prior revokedAt was null by the filter; the ids go to the audit row.
      // A merged place with no calendar to split onto (core): its live
      // whole-place grants end too, or they would cover every survivor room.
      const bookingGrantsRevoked =
        input.revokeMergedGrants || input.revokeWholePlaceGrants
          ? ids(
              await p.placeBookingGrant.findMany({
                where: {
                  ...atMerged,
                  revokedAt: null,
                  ...(input.revokeMergedGrants ? {} : { calendarId: null }),
                },
                select: { id: true },
                orderBy: { id: "asc" },
              }),
            )
          : [];
      if (bookingGrantsRevoked.length > 0) {
        await p.placeBookingGrant.updateMany({
          where: { id: { in: bookingGrantsRevoked } },
          data: { revokedAt: input.now },
        });
      }
      // Whole-place grants still live, split below once the calendars moved.
      // Read in full NOW, before placeId moves: the audit keeps the row as it
      // was before the merge.
      const wholePlaceGrantRows = await p.placeBookingGrant.findMany({
        where: { ...atMerged, calendarId: null, revokedAt: null },
        orderBy: { id: "asc" },
      });
      const bookingGrantsCalendarRepointed = cal
        ? await repoint(
            () =>
              p.placeBookingGrant.findMany({ where: { calendarId: cal.from }, select: { id: true } }),
            () =>
              p.placeBookingGrant.updateMany({
                where: { calendarId: cal.from },
                data: { calendarId: cal.to },
              }),
          )
        : [];
      if (bookingGrants.length > 0) {
        await p.placeBookingGrant.updateMany({ where: atMerged, data: toSurvivor });
      }

      // ── 4. Availability (placeId and calendarId both CASCADE). Place-wide
      // rows stay place-wide; no unique key, overlaps are a core warning.
      const calendarAvailability = ids(
        await p.calendarAvailability.findMany({ where: atMerged, select: { id: true } }),
      );
      const calendarAvailabilityCalendarRepointed = cal
        ? await repoint(
            () =>
              p.calendarAvailability.findMany({
                where: { calendarId: cal.from },
                select: { id: true },
              }),
            () =>
              p.calendarAvailability.updateMany({
                where: { calendarId: cal.from },
                data: { calendarId: cal.to },
              }),
          )
        : [];
      if (calendarAvailability.length > 0) {
        await p.calendarAvailability.updateMany({ where: atMerged, data: toSurvivor });
      }

      // ── 5. Booking standards: polymorphic owner, no FK. Drop the intents
      // core chose (snapshotted in full), then move the rest.
      const dropStandards = async (
        model: "bookingStandardItem" | "bookingPitchExample",
        drops: PlaceMergeStandardDrop[],
      ): Promise<PlaceMergeRowSnapshot[]> => {
        const out: PlaceMergeRowSnapshot[] = [];
        for (const d of drops) {
          const where = {
            ownerType: d.ownerType,
            ownerId: d.ownerId,
            intent: d.intent as BookingIntent,
          };
          const rows =
            model === "bookingStandardItem"
              ? await p.bookingStandardItem.findMany({ where, orderBy: { sortOrder: "asc" } })
              : await p.bookingPitchExample.findMany({ where, orderBy: { sortOrder: "asc" } });
          if (rows.length === 0) continue;
          out.push(...rows.map((r) => snapshot(r as unknown as Record<string, unknown>)));
          const byId = { id: { in: rows.map((r) => r.id) } };
          if (model === "bookingStandardItem") {
            await p.bookingStandardItem.deleteMany({ where: byId });
          } else {
            await p.bookingPitchExample.deleteMany({ where: byId });
          }
        }
        return out;
      };
      const moveStandards = async (
        model: "bookingStandardItem" | "bookingPitchExample",
      ): Promise<string[]> => {
        const owners: { from: { ownerType: "PLACE" | "CALENDAR"; ownerId: string }; to: string }[] = [
          { from: { ownerType: "PLACE", ownerId: mergedId }, to: survivorId },
          ...(cal
            ? [{ from: { ownerType: "CALENDAR" as const, ownerId: cal.from }, to: cal.to }]
            : []),
        ];
        const moved: string[] = [];
        for (const o of owners) {
          if (model === "bookingStandardItem") {
            moved.push(
              ...(await repoint(
                () => p.bookingStandardItem.findMany({ where: o.from, select: { id: true } }),
                () =>
                  p.bookingStandardItem.updateMany({ where: o.from, data: { ownerId: o.to } }),
              )),
            );
          } else {
            moved.push(
              ...(await repoint(
                () => p.bookingPitchExample.findMany({ where: o.from, select: { id: true } }),
                () =>
                  p.bookingPitchExample.updateMany({ where: o.from, data: { ownerId: o.to } }),
              )),
            );
          }
        }
        return moved;
      };
      const bookingStandardItemsDropped = await dropStandards(
        "bookingStandardItem",
        input.dropStandardItems,
      );
      const bookingPitchExamplesDropped = await dropStandards(
        "bookingPitchExample",
        input.dropPitchExamples,
      );
      const bookingStandardItems = await moveStandards("bookingStandardItem");
      const bookingPitchExamples = await moveStandards("bookingPitchExample");

      // ── 6. Place-scoped rows with no unique key on placeId. Agreements and
      // readers would SetNull (orphan), waivers would CASCADE.
      const agreements = await repoint(
        () => p.agreement.findMany({ where: atMerged, select: { id: true } }),
        () => p.agreement.updateMany({ where: atMerged, data: toSurvivor }),
      );
      // Waivers (placeId CASCADES). Nothing references a PlaceWaiver by id;
      // `getActiveForPlace` picks the highest active version, so when core
      // keeps the survivor's waiver authoritative the merged ones move
      // inactive. Each row's prior state goes to the audit row.
      const waiverRows = await p.placeWaiver.findMany({
        where: atMerged,
        select: { id: true, isActive: true },
        orderBy: { id: "asc" },
      });
      const waivers = ids(waiverRows);
      const waiverStates = waiverRows.map((w) => ({ id: w.id, wasActive: w.isActive }));
      const waiversDeactivated = input.deactivateMergedWaivers
        ? waiverRows.filter((w) => w.isActive).map((w) => w.id)
        : [];
      if (waivers.length > 0) {
        await p.placeWaiver.updateMany({
          where: atMerged,
          data: input.deactivateMergedWaivers
            ? { ...toSurvivor, isActive: false }
            : toSurvivor,
        });
      }
      const posReaders = await repoint(
        () => p.posReader.findMany({ where: atMerged, select: { id: true } }),
        () => p.posReader.updateMany({ where: atMerged, data: toSurvivor }),
      );

      // ── 7. Seat maps: @@unique([placeId, name]); core picked free names.
      // Events and seat sections reference the layout by id and come along.
      const layouts: string[] = [];
      for (const l of input.layouts) {
        await p.placeLayout.update({
          where: { id: l.id },
          data: { placeId: survivorId, name: l.name },
        });
        layouts.push(l.id);
      }

      // ── 8. Spaces and calendars that move whole (separate rooms). Core
      // picked free names and slugs ("Calendar_placeId_slug_key").
      const spacesReparented: string[] = [];
      for (const x of input.reparentSpaces) {
        await p.space.update({
          where: { id: x.id },
          data: { placeId: survivorId, name: x.name },
        });
        spacesReparented.push(x.id);
      }
      const calendarsReparented: string[] = [];
      for (const c of input.reparentCalendars) {
        await p.calendar.update({
          where: { id: c.id },
          data: { placeId: survivorId, name: c.name, slug: c.slug },
        });
        calendarsReparented.push(c.id);
      }

      // ── 8b. Split each live whole-place merged grant onto the calendars the
      // merged place brought, so it never covers the survivor's own rooms.
      // The original row narrows to the first calendar (its holds keep
      // pointing at it: grantId is Restrict); a copy per other calendar keeps
      // every other column; holds on those calendars ride the copy.
      const bookingGrantsSplit: MovePlaceOperationsResult["bookingGrantsSplit"] = [];
      const [firstTarget, ...otherTargets] = input.splitWholePlaceGrantsOnto;
      if (firstTarget) {
        for (const original of wholePlaceGrantRows) {
          const grantId = original.id;
          await p.placeBookingGrant.update({
            where: { id: grantId },
            data: { calendarId: firstTarget },
          });
          const created: { id: string; calendarId: string }[] = [];
          const holdsRepointed: { holdId: string; fromGrantId: string; toGrantId: string }[] = [];
          // The copy is of the row as it now stands (placeId on the survivor).
          const { id: _originalId, placeId: _originalPlaceId, ...rest } = original;
          void _originalId;
          void _originalPlaceId;
          const copy = { ...rest, placeId: input.survivorId };
          for (const calendarId of otherTargets) {
            const row = await p.placeBookingGrant.create({
              data: { ...copy, calendarId } as Prisma.PlaceBookingGrantUncheckedCreateInput,
              select: { id: true },
            });
            created.push({ id: row.id, calendarId });
            // BookingHold.grantId arrives with holds-without-a-request
            // (FR-001); before that schema lands no hold rides a grant.
            if (!HOLDS_HAVE_GRANT_ID) continue;
            const riding = ids(
              await p.bookingHold.findMany({
                where: { grantId, calendarId } as unknown as Prisma.BookingHoldWhereInput,
                select: { id: true },
              }),
            );
            if (riding.length > 0) {
              await p.bookingHold.updateMany({
                where: { id: { in: riding } },
                data: { grantId: row.id } as unknown as Prisma.BookingHoldUncheckedUpdateManyInput,
              });
              holdsRepointed.push(
                ...riding.map((holdId) => ({ holdId, fromGrantId: grantId, toGrantId: row.id })),
              );
            }
          }
          bookingGrantsSplit.push({
            original: snapshot(original as unknown as Record<string, unknown>),
            keptOnCalendarId: firstTarget,
            created,
            holdsRepointed,
          });
        }
      }

      // ── 9. Fold the Main Space: every join and primary that named it now
      // names the survivor's Main Space. The primary-is-joined FK is
      // DEFERRABLE INITIALLY DEFERRED, so the order below is free within the
      // transaction; create first, then repoint, then delete.
      const calendarSpaceJoinsCreated: MovePlaceOperationsResult["calendarSpaceJoinsCreated"] = [];
      const calendarSpaceJoinsDeleted: PlaceMergeRowSnapshot[] = [];
      const primarySpaceRepointedCalendars: string[] = [];
      const ensureJoin = async (calendarId: string, spaceId: string) => {
        const existing = await p.calendarSpace.findUnique({
          where: { calendarId_spaceId: { calendarId, spaceId } },
          select: { id: true },
        });
        if (existing) return;
        const row = await p.calendarSpace.create({
          data: { calendarId, spaceId },
          select: { id: true, calendarId: true, spaceId: true },
        });
        calendarSpaceJoinsCreated.push(row);
      };
      if (sp && calendarsReparented.length > 0) {
        const joinsOnFolded = await p.calendarSpace.findMany({
          where: { spaceId: sp.from, calendarId: { in: calendarsReparented } },
        });
        for (const j of joinsOnFolded) await ensureJoin(j.calendarId, sp.to);
        const primaries = ids(
          await p.calendar.findMany({
            where: { id: { in: calendarsReparented }, primarySpaceId: sp.from },
            select: { id: true },
          }),
        );
        if (primaries.length > 0) {
          await p.calendar.updateMany({
            where: { id: { in: primaries } },
            data: { primarySpaceId: sp.to },
          });
          primarySpaceRepointedCalendars.push(...primaries);
        }
        if (joinsOnFolded.length > 0) {
          calendarSpaceJoinsDeleted.push(
            ...joinsOnFolded.map((j) => snapshot(j as unknown as Record<string, unknown>)),
          );
          await p.calendarSpace.deleteMany({
            where: { id: { in: joinsOnFolded.map((j) => j.id) } },
          });
        }
      }

      // ── 10. Fold the default calendar: the rooms it scheduled into (other
      // than the folded Main Space) join the survivor's default calendar, so
      // a moved event or hold on such a room stays a room of its calendar.
      let deletedCalendar: PlaceMergeRowSnapshot | null = null;
      let deletedSpace: PlaceMergeRowSnapshot | null = null;
      if (cal) {
        const folded = await p.calendar.findUnique({
          where: { id: cal.from },
          include: { calendarSpaces: true },
        });
        if (folded) {
          for (const j of folded.calendarSpaces) {
            if (sp && j.spaceId === sp.from) continue;
            await ensureJoin(cal.to, j.spaceId);
          }
          deletedCalendar = snapshot(folded as unknown as Record<string, unknown>);
          // Empty by now: holds (Restrict), events and requests (SetNull),
          // grants and availability (Cascade) all moved above or in
          // repointPlaceRows. A hold that slipped in would fail Restrict and
          // roll the merge back rather than vanish.
          await p.calendar.delete({ where: { id: cal.from } });
        }
      }
      if (sp) {
        const foldedSpace = await p.space.findUnique({ where: { id: sp.from } });
        if (foldedSpace) {
          deletedSpace = snapshot(foldedSpace as unknown as Record<string, unknown>);
          await p.space.delete({ where: { id: sp.from } });
        }
      }

      // ── 11. Events on a calendar that moved whole (their placeId moved in
      // repointPlaceRows); returned for the reindex marks.
      const eventsOnReparentedCalendars =
        calendarsReparented.length > 0
          ? ids(
              await p.event.findMany({
                where: { calendarId: { in: calendarsReparented } },
                select: { id: true },
              }),
            )
          : [];

      // ── 12. Series / template / occurrence location JSON. Archived and
      // inactive rows too: a revived series must not point at a deleted place.
      const placeLocation = { path: ["location", "placeId"], equals: mergedId };
      const rewrite = (json: Prisma.JsonValue): Prisma.InputJsonValue => {
        const obj = (json ?? {}) as Record<string, unknown>;
        const location = (obj.location ?? {}) as Record<string, unknown>;
        return { ...obj, location: { ...location, placeId: survivorId } } as Prisma.InputJsonValue;
      };
      const seriesRows = await p.eventSeries.findMany({
        where: { defaults: placeLocation },
        select: { id: true, defaults: true },
        orderBy: { id: "asc" },
      });
      for (const r of seriesRows) {
        await p.eventSeries.update({ where: { id: r.id }, data: { defaults: rewrite(r.defaults) } });
      }
      const templateRows = await p.eventTemplate.findMany({
        where: { defaults: placeLocation },
        select: { id: true, defaults: true },
        orderBy: { id: "asc" },
      });
      for (const r of templateRows) {
        await p.eventTemplate.update({ where: { id: r.id }, data: { defaults: rewrite(r.defaults) } });
      }
      const occurrenceRows = await p.eventSeriesOccurrence.findMany({
        where: { overrides: placeLocation },
        select: { id: true, overrides: true },
        orderBy: { id: "asc" },
      });
      for (const r of occurrenceRows) {
        await p.eventSeriesOccurrence.update({
          where: { id: r.id },
          data: { overrides: rewrite(r.overrides) },
        });
      }

      return {
        bookingHolds,
        bookingHoldsCalendarRepointed,
        bookingHoldsSpaceRepointed,
        bookingRequests,
        bookingRequestsCalendarRepointed,
        bookingRequestsSpaceRepointed,
        agreements,
        bookingGrants,
        bookingGrantsCalendarRepointed,
        bookingGrantsRevoked,
        bookingGrantsSplit,
        waivers,
        waiverStates,
        waiversDeactivated,
        posReaders,
        layouts,
        calendarAvailability,
        calendarAvailabilityCalendarRepointed,
        bookingStandardItems,
        bookingStandardItemsDropped,
        bookingPitchExamples,
        bookingPitchExamplesDropped,
        calendarsReparented,
        spacesReparented,
        calendarSpaceJoinsCreated,
        calendarSpaceJoinsDeleted,
        primarySpaceRepointedCalendars,
        eventsOnReparentedCalendars,
        series: ids(seriesRows),
        templates: ids(templateRows),
        occurrences: ids(occurrenceRows),
        deletedCalendar,
        deletedSpace,
      };
    },

    async repointPageRows({ fromPageId, toPageId }): Promise<RepointPageRowsResult> {
      // EntityFollow: @@unique([followerHumanId, entityPageId]) — someone who
      // followed both keeps the survivor's follow.
      const targetFollowers = (
        await p.entityFollow.findMany({
          where: { entityPageId: toPageId },
          select: { followerHumanId: true },
        })
      ).map((f) => f.followerHumanId);
      const followsDropped =
        targetFollowers.length > 0
          ? ids(
              await p.entityFollow.findMany({
                where: {
                  entityPageId: fromPageId,
                  followerHumanId: { in: targetFollowers },
                },
                select: { id: true },
              }),
            )
          : [];
      const followsDroppedRows =
        followsDropped.length > 0
          ? await p.entityFollow.findMany({ where: { id: { in: followsDropped } } })
          : [];
      if (followsDropped.length > 0) {
        await p.entityFollow.deleteMany({
          where: { id: { in: followsDropped } },
        });
      }
      const follows = ids(
        await p.entityFollow.findMany({
          where: { entityPageId: fromPageId },
          select: { id: true },
        }),
      );
      await p.entityFollow.updateMany({
        where: { entityPageId: fromPageId },
        data: { entityPageId: toPageId },
      });

      // EntityEventNotice: @@unique([entityPageId, eventId]).
      const targetEvents = (
        await p.entityEventNotice.findMany({
          where: { entityPageId: toPageId },
          select: { eventId: true },
        })
      ).map((n) => n.eventId);
      const eventNoticesDropped =
        targetEvents.length > 0
          ? ids(
              await p.entityEventNotice.findMany({
                where: { entityPageId: fromPageId, eventId: { in: targetEvents } },
                select: { id: true },
              }),
            )
          : [];
      const eventNoticesDroppedRows =
        eventNoticesDropped.length > 0
          ? await p.entityEventNotice.findMany({ where: { id: { in: eventNoticesDropped } } })
          : [];
      if (eventNoticesDropped.length > 0) {
        await p.entityEventNotice.deleteMany({
          where: { id: { in: eventNoticesDropped } },
        });
      }
      const eventNotices = ids(
        await p.entityEventNotice.findMany({
          where: { entityPageId: fromPageId },
          select: { id: true },
        }),
      );
      await p.entityEventNotice.updateMany({
        where: { entityPageId: fromPageId },
        data: { entityPageId: toPageId },
      });

      // PageSlugHistory: slug is globally unique, so a plain re-point is safe.
      // Must run before the source page is deleted (the FK cascades).
      const pageSlugHistory = ids(
        await p.pageSlugHistory.findMany({
          where: { pageId: fromPageId },
          select: { id: true },
        }),
      );
      await p.pageSlugHistory.updateMany({
        where: { pageId: fromPageId },
        data: { pageId: toPageId },
      });

      return {
        follows,
        followsDropped,
        eventNotices,
        eventNoticesDropped,
        pageSlugHistory,
        droppedRows: {
          follows: followsDroppedRows.map((r) =>
            snapshot(r as unknown as Record<string, unknown>),
          ),
          eventNotices: eventNoticesDroppedRows.map((r) =>
            snapshot(r as unknown as Record<string, unknown>),
          ),
        },
      };
    },

    async transferPage({ pageId, toPlaceId }) {
      await p.entityPage.update({
        where: { id: pageId },
        data: { ownerId: toPlaceId },
      });
    },

    async deletePage(pageId) {
      await p.entityPage.delete({ where: { id: pageId } });
    },

    async markPlaceStatsStale(placeId) {
      // Oldest possible stamp: the sweep arm of `listStalePlaceIds` returns
      // rows oldest-first, so this place is recomputed on the next run. The
      // published snapshot stays until then (the delay protects reviewer
      // anonymity, spec FR-005).
      await p.placeStats.updateMany({
        where: { placeId },
        data: { lastCalculatedAt: new Date(0) },
      });
    },

    async deleteDerivedRows(placeId) {
      await p.placeStats.deleteMany({ where: { placeId } });
      await p.reviewAggregate.deleteMany({
        where: { subjectType: "PLACE", subjectId: placeId },
      });
    },

    async deletePlace(placeId) {
      await p.place.delete({ where: { id: placeId } });
    },
  };
}
