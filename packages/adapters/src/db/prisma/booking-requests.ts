import { Prisma } from "@prisma/client";
import type { BookingRequest } from "@prisma/client";
import type {
  BookingRequestsRepo,
  BookingRequestRecord,
  ToPerformerBookingRequestRecord,
  ToVenueBookingRequestRecord,
} from "@th/ports/repos/booking-requests";
import {
  INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES,
  isAnonymousBookingRequestCreateInput,
  OPEN_BOOKING_REQUEST_STATUSES,
} from "@th/ports/repos/booking-requests";
import type {
  BookingInquirerEmailFailure,
  BookingIntent,
  BookingRequestActRecord,
  BookingRequestActRole,
  BookingRequestAttachmentRecord,
  BookingRequestSource,
  BookingTaxFormStatus,
} from "@th/ports/repos/booking-requests";
import type {
  BookingRequestAct,
  BookingRequestAttachment,
} from "@prisma/client";
import type { PerformerOwnerType } from "@th/ports/repos/performer-profiles";
import type { VerifiedStatsSnapshot } from "@th/types/repos/human-stats";

import type { PrismaClientOrTx } from "./types";
// ── P3b (asks) ──
import { makeBookingRequestAskMethods } from "./booking-request-asks";
import { NOTE_SELECT, writeNote } from "./note-columns";

type BookingRequestWithRelated = BookingRequest & {
  place: { name: string } | null;
  organizerOrg: { name: string } | null;
  attachedEvent: { title: string; startsAt: Date } | null;
  calendar: { name: string } | null;
};

/**
 * Denormalized display joins carried on every read: the venue name
 * (TO_VENUE), the sender-org name and the attached event's live title/date
 * (TO_PERFORMER — the request stores the event ID only; title/date render
 * live per organizer-booking-requests FR-003).
 */
const RELATED_INCLUDE = {
  place: { select: { name: true } },
  organizerOrg: { select: { name: true } },
  attachedEvent: { select: { title: true, startsAt: true } },
  // Denormalized for the venue inbox's calendar filter — one join on the
  // page's existing read, not a per-row lookup.
  calendar: { select: { name: true } },
} as const;

export function makeBookingRequestsRepo(
  p: PrismaClientOrTx,
): BookingRequestsRepo {
  return {
    async create(input) {
      const anonymous = isAnonymousBookingRequestCreateInput(input);
      try {
        const created = await p.bookingRequest.create({
          data: {
            placeId: input.placeId,
            // Calendar routing (venue-hierarchy FR-008) — resolved by the use
            // case before the repo call; null only for pre-hierarchy callers.
            calendarId: input.calendarId ?? null,
            // Sender: exactly one identity per row — the performer owner pair
            // (owned) or the contact fields (anonymous embed inquiry).
            performerOwnerType: anonymous ? null : input.performerOwnerType,
            performerOwnerId: anonymous ? null : input.performerOwnerId,
            contactName: anonymous ? input.contactName : null,
            // Callers are contractually obliged to lowercase (see the input
            // type doc); lowercase defensively anyway so mixed case never
            // lands at rest — the plain (placeId, contactEmail) index does
            // equality lookups.
            contactEmail: anonymous ? input.contactEmail.toLowerCase() : null,
            source: input.source ?? "PLATFORM",
            embedId: input.embedId ?? null,
            message: input.message,
            preferredDates: input.preferredDates,
            expectedDraw: input.expectedDraw ?? null,
            genre: input.genre ?? null,
            // Legacy generic `links` is superseded by the typed link* columns
            // below; new rows are never written it, so the column's
            // @default("[]") applies. (Removed from the create input type.)
            actName: input.actName ?? null,
            lineupSize: input.lineupSize ?? null,
            setLengthMinutes: input.setLengthMinutes ?? null,
            contactPhone: input.contactPhone ?? null,
            techNeeds: input.techNeeds ?? null,
            feeType: input.feeType ?? null,
            feeAmountCents: input.feeAmountCents ?? null,
            feeCurrency: input.feeCurrency ?? null,
            linkMusic: input.linkMusic ?? null,
            linkVideo: input.linkVideo ?? null,
            linkSocial: input.linkSocial ?? null,
            linkEpk: input.linkEpk ?? null,
            // Triage labels (venue-hierarchy FR-008) — sanitized + capped by
            // the use case. `undefined` lets the column's @default([]) apply.
            ...(input.tags !== undefined ? { tags: input.tags } : {}),
            // Intent + the room + the window (venue-confirmation spec). The
            // RENT/USE shape — the WINDOW is required, the room is NOT
            // (ruling 2026-09-22) — is the use case's obligation; the SQL
            // CHECK "BookingRequest_intent_shape_check" backstops it and
            // surfaces a miss as a raw constraint error.
            // `undefined` intent lets the column's @default(PERFORM) apply.
            ...(input.intent !== undefined ? { intent: input.intent } : {}),
            spaceId: input.spaceId ?? null,
            requestedStartsAt: input.requestedStartsAt ?? null,
            requestedEndsAt: input.requestedEndsAt ?? null,
            purpose: input.purpose ?? null,
            expectedAttendance: input.expectedAttendance ?? null,
            originEventId: input.originEventId ?? null,
            // `parkedUnclaimedAt` is never written (amendment 2026-09-25:
            // unclaimed venues take no requests); the column defaults null.
            // Lineup v3 L12: a request created WITH a bill (see the column).
            billRecorded: input.billRecorded ?? false,
            verifiedStatsSnapshot:
              !anonymous && input.verifiedStatsSnapshot
                ? (input.verifiedStatsSnapshot as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            expiresAt: input.expiresAt,
          },
          include: RELATED_INCLUDE,
        });
        return toToVenueRecord(created);
      } catch (error) {
        // P2002 on create can only come from the SQL-only partial unique
        // indexes "BookingRequest_open_pair_key" (one open request per
        // performer×place) or "BookingRequest_open_anon_pair_key" (one open
        // anonymous request per place×lower(email)) — see agreement.prisma:
        // `id` is a fresh uuid, `agreementId` is never set at create, and
        // `claimTokenHash` is only written post-accept. Map the race loser to
        // the same domain error as the use-case pre-check either way.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_open_request",
            message: "duplicate_open_request",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async createToPerformer(input) {
      try {
        const created = await p.bookingRequest.create({
          data: {
            direction: "TO_PERFORMER",
            // No venue anchor in this direction (DB CHECK-enforced) — an
            // attached event's venue feeds the minted Agreement instead.
            placeId: null,
            organizerOrgId: input.organizerOrgId,
            attachedEventId: input.attachedEventId ?? null,
            // The act pair identifies the TARGET here (FR-001 semantics —
            // never role-swapped).
            performerOwnerType: input.performerOwnerType,
            performerOwnerId: input.performerOwnerId,
            source: "PLATFORM",
            message: input.message,
            preferredDates: input.preferredDates,
            setLengthMinutes: input.setLengthMinutes ?? null,
            feeType: input.feeType ?? null,
            feeAmountCents: input.feeAmountCents ?? null,
            feeCurrency: input.feeCurrency ?? null,
            expiresAt: input.expiresAt,
          },
          include: RELATED_INCLUDE,
        });
        return toToPerformerRecord(created);
      } catch (error) {
        // P2002 here can only be the SQL-only partial unique
        // "BookingRequest_open_organizer_pair_key" (one open request per
        // organizer org × act): `id` is a fresh uuid, `agreementId` is never
        // set at create, the claim-token column is never written in this
        // direction, and the TO_VENUE pair index requires a non-null placeId.
        // Map the race loser to the same domain error as the use-case
        // pre-check.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_open_request",
            message: "duplicate_open_request",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async getById(id) {
      const row = await p.bookingRequest.findUnique({
        where: { id },
        include: RELATED_INCLUDE,
      });
      return row ? toRecord(row) : null;
    },

    async listForPlace({ placeId, statuses }) {
      const rows = await p.bookingRequest.findMany({
        where: {
          placeId,
          // Repo-level direction scope (NFR-001). Belt-and-braces — a
          // TO_PERFORMER row's placeId is NULL by CHECK constraint anyway.
          direction: "TO_VENUE",
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        include: RELATED_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toToVenueRecord);
    },

    /**
     * Org-wide venue inbox in ONE query (see the port doc). The empty-set
     * short circuit is explicit: Prisma would happily run `IN ()`, but an org
     * that owns no venues must cost zero round trips.
     */
    async listForPlaces({ placeIds, statuses }) {
      if (placeIds.length === 0) return [];

      const rows = await p.bookingRequest.findMany({
        where: {
          placeId: { in: [...placeIds] },
          // Load-bearing direction scope (NFR-001) — identical to
          // `listForPlace`, so the org inbox and the per-venue inbox can never
          // show different row sets for the same venue.
          direction: "TO_VENUE",
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        include: RELATED_INCLUDE,
        // `id` tiebreaks because rows from several venues interleave here.
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(toToVenueRecord);
    },

    async listForPerformer({ ownerType, ownerId, statuses }) {
      const rows = await p.bookingRequest.findMany({
        where: {
          performerOwnerType: ownerType,
          performerOwnerId: ownerId,
          // Load-bearing direction scope (NFR-001): the act pair also
          // identifies the TARGET on TO_PERFORMER rows, so without this a
          // received organizer request would leak into the "sent" list.
          direction: "TO_VENUE",
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        include: RELATED_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toToVenueRecord);
    },

    async listForOrganizer({ organizerOrgId, statuses }) {
      const rows = await p.bookingRequest.findMany({
        where: {
          organizerOrgId,
          direction: "TO_PERFORMER",
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        include: RELATED_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toToPerformerRecord);
    },

    async listForPerformerInbox({ ownerType, ownerId, statuses }) {
      const rows = await p.bookingRequest.findMany({
        where: {
          performerOwnerType: ownerType,
          performerOwnerId: ownerId,
          direction: "TO_PERFORMER",
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
        include: RELATED_INCLUDE,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toToPerformerRecord);
    },

    // ── Counting twins of the two performer lists ───────────────────────────
    // Both keep the list queries' load-bearing `direction` scope (NFR-001) and
    // fold the owner set into ONE query via OR, so the settings nav pays a
    // single count per direction instead of one per administered group.
    // `owners: []` short-circuits: Prisma would translate `OR: []` to a
    // false-y filter, but an explicit 0 documents the intent and skips the
    // round trip.
    async countForPerformer({ owners, statuses }) {
      if (owners.length === 0) return 0;
      return p.bookingRequest.count({
        where: {
          direction: "TO_VENUE",
          OR: owners.map((owner) => ({
            performerOwnerType: owner.ownerType,
            performerOwnerId: owner.ownerId,
          })),
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
      });
    },

    async countForPerformerInbox({ owners, statuses }) {
      if (owners.length === 0) return 0;
      return p.bookingRequest.count({
        where: {
          direction: "TO_PERFORMER",
          OR: owners.map((owner) => ({
            performerOwnerType: owner.ownerType,
            performerOwnerId: owner.ownerId,
          })),
          ...(statuses?.length ? { status: { in: statuses } } : {}),
        },
      });
    },

    /**
     * Per-place open counts in ONE grouped query (booking-inbox-placement
     * FR-006). `groupBy` + `_count`, never findMany-and-map: the org Bookings
     * badges must not pay for full rows, and the old per-place list fan-out
     * was capped (venues past the cap silently lost their badge).
     *
     * Statuses default to the shared open set so the method can't be called
     * into counting terminal rows; `placeId` is non-null on every TO_VENUE row
     * (CHECK constraint) but `groupBy` still types it nullable, so the null
     * group is dropped defensively.
     */
    async countOpenByPlace({ placeIds, statuses }) {
      if (placeIds.length === 0) return [];

      const groups = await p.bookingRequest.groupBy({
        by: ["placeId"],
        where: {
          direction: "TO_VENUE",
          placeId: { in: [...placeIds] },
          status: {
            in: statuses?.length
              ? statuses
              : [...OPEN_BOOKING_REQUEST_STATUSES],
          },
        },
        _count: { _all: true },
      });

      const counts: { placeId: string; openCount: number }[] = [];
      for (const group of groups) {
        if (!group.placeId) continue;
        counts.push({ placeId: group.placeId, openCount: group._count._all });
      }
      return counts;
    },

    async findOpenByPerformerAndPlace({ ownerType, ownerId, placeId }) {
      const row = await p.bookingRequest.findFirst({
        where: {
          placeId,
          direction: "TO_VENUE",
          performerOwnerType: ownerType,
          performerOwnerId: ownerId,
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
        },
        include: RELATED_INCLUDE,
      });
      return row ? toToVenueRecord(row) : null;
    },

    async findOpenByOrganizerAndPerformer({
      organizerOrgId,
      ownerType,
      ownerId,
    }) {
      const row = await p.bookingRequest.findFirst({
        where: {
          organizerOrgId,
          direction: "TO_PERFORMER",
          performerOwnerType: ownerType,
          performerOwnerId: ownerId,
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
        },
        include: RELATED_INCLUDE,
      });
      return row ? toToPerformerRecord(row) : null;
    },

    async findOpenByContactEmailAndPlace({ placeId, contactEmail }) {
      const row = await p.bookingRequest.findFirst({
        where: {
          placeId,
          direction: "TO_VENUE",
          // UNCLAIMED rows only — a CLAIMED row (a real party attached itself
          // via the invite token) has left the inquiry dedupe scope.
          //
          // Deliberately `claimedAt: null`, NOT `performerOwnerId: null`,
          // even though the partial index's predicate is the latter: since
          // booking-inquirer-outreach an unclaimed inquiry the venue replied
          // to carries a SHADOW owner pair, which drops it out of
          // "BookingRequest_open_anon_pair_key" without any index taking over
          // (the row's new home, "BookingRequest_open_pair_key", is keyed on
          // the shadow, not the address). Widening this PRE-CHECK is what
          // keeps "one open inquiry per (place, email)" true across that
          // window — and it is also what stops a second inquiry from later
          // colliding on the pair index when the venue replies to it.
          claimedAt: null,
          // Plain equality on the LOWERCASED argument — NOT mode:"insensitive"
          // (Prisma compiles that to ILIKE, where `_`/`%` in an email's local
          // part act as wildcards: a crafted probe could false-match another
          // submitter's open inquiry, and ILIKE can't use the indexes). All
          // adapter-written rows are lowercased at rest; a mixed-case
          // out-of-band row simply falls through this best-effort pre-check
          // to the authoritative lower(contactEmail) unique index.
          contactEmail: contactEmail.toLowerCase(),
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
        },
        include: RELATED_INCLUDE,
      });
      return row ? toToVenueRecord(row) : null;
    },

    async findByAgreementId(agreementId) {
      const row = await p.bookingRequest.findUnique({
        where: { agreementId },
        include: RELATED_INCLUDE,
      });
      return row ? toRecord(row) : null;
    },

    async findManyByAgreementIds(agreementIds) {
      if (agreementIds.length === 0) return [];
      const rows = await p.bookingRequest.findMany({
        where: { agreementId: { in: [...agreementIds] } },
        include: RELATED_INCLUDE,
      });
      return rows.map(toRecord);
    },

    async findByOriginEventId(originEventId) {
      const row = await p.bookingRequest.findUnique({
        where: { originEventId },
        include: RELATED_INCLUDE,
      });
      // `originEventId` is only ever written by the event-first create,
      // which is TO_VENUE by construction; the guard keeps the narrowed
      // return type honest if a row is ever patched out of band.
      return row && row.direction === "TO_VENUE" ? toToVenueRecord(row) : null;
    },

    async findByClaimTokenHash(claimTokenHash) {
      // Exact equality on the unique hash column. Constant-time-safe despite
      // the index probe: the raw token carries 256 bits of entropy, so timing
      // differences reveal nothing an attacker could enumerate (see the port
      // doc). Hashing happens in core — this only ever sees the sha256 hex.
      const row = await p.bookingRequest.findUnique({
        where: { claimTokenHash },
        include: RELATED_INCLUDE,
      });
      return row ? toRecord(row) : null;
    },

    async setClaimToken(input) {
      try {
        // Guarded CAS UPDATE (never part of create — the blanket
        // P2002→duplicate_open_request mapping on `create` depends on the
        // token only ever being written here). The UNCLAIMED predicate travels
        // with the write so a racing claim can never have its consumed token
        // resurrected by a resend rotation.
        //
        // The guard is `claimedAt IS NULL` + a contact-bearing row, NOT
        // `performerOwnerId IS NULL`: since booking-inquirer-outreach an
        // unclaimed inquiry the venue has replied to carries a SHADOW owner
        // pair (see `attachInquirerOwner`), and an owner-null guard would
        // silently kill invite-to-claim for exactly the inquiries a venue
        // engaged with. `claimedAt` is stamped ONLY by `claim`, so it remains
        // the authoritative single-use marker this CAS always meant.
        const result = await p.bookingRequest.updateMany({
          where: {
            id: input.id,
            status: { in: [...input.expectedFrom] },
            contactEmail: { not: null },
            claimedAt: null,
          },
          data: {
            claimTokenHash: input.claimTokenHash,
            claimTokenExpiresAt: input.claimTokenExpiresAt,
          },
        });
        if (result.count === 0) {
          throw {
            code: "conflict",
            message: "booking_request_status_changed",
          } as const;
        }
        return await refetch(p, input.id);
      } catch (error) {
        // P2002 here can only be the unique "BookingRequest_claimTokenHash_key"
        // (a 256-bit token collision — astronomically unlikely). Surfaced as a
        // distinct conflict message so core retries ONCE with a fresh token
        // instead of failing the venue's accept (documented dependency-error
        // choice: retry-once in core, typed conflict if it somehow repeats).
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "conflict",
            message: "claim_token_hash_collision",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async claim(input) {
      // Single-use redeem CAS: the WHERE re-checks the token hash, the
      // unclaimed marker AND the ACCEPTED status at write time, so two
      // concurrent redeems (or a redeem racing a rotation) produce exactly
      // one winner. Backfilling the owner pair cannot trip
      // "BookingRequest_open_pair_key" — that partial index only covers
      // status IN ('PENDING','VIEWED') and this row is CAS-pinned to
      // ACCEPTED — so no P2002 mapping is needed here.
      const result = await p.bookingRequest.updateMany({
        where: {
          id: input.id,
          claimTokenHash: input.expectedClaimTokenHash,
          claimedAt: null,
          status: "ACCEPTED",
        },
        data: {
          performerOwnerType: input.performerOwnerType,
          performerOwnerId: input.performerOwnerId,
          claimedAt: input.claimedAt,
          claimTokenHash: null,
          claimTokenExpiresAt: null,
        },
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_already_claimed",
        } as const;
      }
      return refetch(p, input.id);
    },

    async attachInquirerOwner(input) {
      try {
        // Idempotent CAS: only an inquiry that is still OWNERLESS and
        // UNCLAIMED gets a shadow owner. A second venue reply matches zero
        // rows and returns null — the caller treats that as "already done".
        // `contactEmail: { not: null }` keeps the write inside the anonymous
        // family and, with the all-or-nothing owner pair, keeps the DB CHECK
        // "BookingRequest_sender_identity_check" satisfied.
        const result = await p.bookingRequest.updateMany({
          where: {
            id: input.id,
            performerOwnerId: null,
            claimedAt: null,
            contactEmail: { not: null },
          },
          data: {
            performerOwnerType: input.performerOwnerType,
            performerOwnerId: input.performerOwnerId,
          },
        });
        if (result.count === 0) return null;
        return await refetch(p, input.id);
      } catch (error) {
        // While the row is open (PENDING | VIEWED) this write moves it out of
        // "BookingRequest_open_anon_pair_key" and into
        // "BookingRequest_open_pair_key". A P2002 therefore means the shadow
        // already holds an open request at this place. Same domain shape as
        // `create` so callers have one thing to catch — and the caller MUST
        // still send the email; a dedupe collision never justifies dropping a
        // venue's reply.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "duplicate_open_request",
            message: "duplicate_open_request",
            cause: error,
          } as const;
        }
        throw error;
      }
    },

    async setInquirerEmailMessageId(input) {
      // First-write-wins: two concurrent replies must not leave the mail
      // thread root oscillating between two ids. The loser threads under the
      // winner's root on its next send.
      const result = await p.bookingRequest.updateMany({
        where: { id: input.id, inquirerEmailMessageId: null },
        data: { inquirerEmailMessageId: input.messageId },
      });
      return result.count > 0;
    },

    async markInquirerEmailUndeliverable(input) {
      // Address-keyed (all the provider webhook knows) and lowercased at rest,
      // so plain equality matches the "BookingRequest_contactEmail_idx".
      //
      // THE FAN-IN IS DELIBERATELY NARROW. A bounce event names an address and
      // nothing else — not a place, not a request — so the WHERE has to do the
      // narrowing the provider cannot:
      //   - `inquirerEmailMessageId: { not: null }` → only rows THIS feature
      //     actually mailed. Without it, one bounce of a venue's reply would
      //     also stamp that person's open inquiries at every OTHER venue, which
      //     were never mailed, and a bounced GUEST TICKET RECEIPT to the same
      //     address would stamp all of them.
      //   - `status: OPEN + ACCEPTED` → a DECLINED / WITHDRAWN / EXPIRED row
      //     is finished; annotating it with "we could not reach them" is noise
      //     about a conversation nobody is waiting on. ACCEPTED is IN and is
      //     NOT covered by "still open": the venue said yes, the
      //     invite-to-claim mail went to this same address, and a bounce there
      //     means the inquirer will never redeem the token and never show up —
      //     precisely when the venue needs to know the address is dead. See
      //     `INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES`.
      //   - `claimedAt: null` → a claimed row has a real account and the
      //     platform's own deliverability machinery.
      // Two venues that BOTH mailed the same still-open address are still
      // stamped together; that is irreducible without per-send correlation the
      // provider does not give us on bounce.
      const email = input.contactEmail.toLowerCase();
      const result = await p.bookingRequest.updateMany({
        where: {
          contactEmail: email,
          claimedAt: null,
          inquirerEmailMessageId: { not: null },
          status: { in: [...INQUIRER_REACHABLE_BOOKING_REQUEST_STATUSES] },
          // Monotonic: an out-of-order provider replay must not overwrite a
          // newer stamp with a stale status.
          OR: [
            { inquirerEmailUndeliverableAt: null },
            { inquirerEmailUndeliverableAt: { lt: input.at } },
          ],
        },
        data: {
          inquirerEmailUndeliverableAt: input.at,
          inquirerEmailUndeliverableStatus: input.status,
        },
      });
      return result.count;
    },

    async markViewed({ id, now, expectedFrom }) {
      // Guarded compare-and-swap (as `expireIfDue` does): the WHERE
      // re-checks status at write time so a concurrent DECLINED/EXPIRED
      // commit can't be resurrected to VIEWED.
      const result = await p.bookingRequest.updateMany({
        where: { id, status: { in: [...expectedFrom] } },
        data: { status: "VIEWED", viewedAt: now },
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      return refetch(p, id);
    },

    async updateStatus(input) {
      const data: Prisma.BookingRequestUncheckedUpdateInput = {
        status: input.status,
      };
      if (input.respondedAt !== undefined) data.respondedAt = input.respondedAt;
      if (input.declineReason !== undefined)
        data.declineReason = input.declineReason;
      if (input.agreementId !== undefined) data.agreementId = input.agreementId;

      // Guarded compare-and-swap: under READ COMMITTED an in-tx re-read takes
      // no lock, so the status WHERE must travel with the write. A blocked
      // concurrent transition (accept vs withdraw, respond vs expire, …)
      // matches zero rows and surfaces as a conflict instead of clobbering
      // the committed state.
      const result = await p.bookingRequest.updateMany({
        where: { id: input.id, status: { in: [...input.expectedFrom] } },
        data,
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      return refetch(p, input.id);
    },

    async setAssignee(input) {
      // No status guard (port contract): assignment is a workflow field that
      // may change in any state. updateMany so a missing row is a count of 0
      // (not a Prisma P2025) and maps to a domain error.
      const result = await p.bookingRequest.updateMany({
        where: { id: input.id },
        data: { assigneeHumanId: input.assigneeHumanId },
      });
      if (result.count === 0) {
        throw {
          code: "not_found",
          message: "booking_request_not_found",
        } as const;
      }
      return refetch(p, input.id);
    },

    async listExpiryCandidates({ cutoff, limit }) {
      // A pre-filter (port doc): no lock, so a CONFIRMED hold still in an
      // uncommitted transaction is invisible here. `expireIfDue`, under the
      // request's booking lock, is the check that counts.
      const due = await p.bookingRequest.findMany({
        where: {
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
          expiresAt: { lte: cutoff },
          holds: { none: { status: "CONFIRMED" } },
        },
        select: { id: true },
        // Oldest deadline first, bounded (port doc): a backlog drains over
        // several runs, in order.
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      return due.map((row) => row.id);
    },

    async expireIfDue({ id, cutoff }) {
      // booking-the-night P2c (review round 3, B1) + P2d-2 (carry a): an open
      // request whose night is BOOKED (a CONFIRMED hold — an event-first
      // request a venue confirm booked before anyone answered it) is NOT
      // expired. The relation filter alone does not make that true under
      // READ COMMITTED: this statement's snapshot cannot see a confirm that
      // is still uncommitted, and the confirm never touches this row, so no
      // row lock re-evaluates it. What does is the caller's
      // `lockRequestBooking(id)` (port contract): every booking path takes
      // it before writing a CONFIRMED hold, so by the time this statement
      // runs, any confirm of this request has either committed (and is seen
      // here) or not started (and will find the request closed).
      const result = await p.bookingRequest.updateMany({
        where: {
          id,
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
          expiresAt: { lte: cutoff },
          holds: { none: { status: "CONFIRMED" } },
        },
        data: { status: "EXPIRED" },
      });
      if (result.count === 0) return null;
      return refetch(p, id);
    },

    // ── Conversation + attachments (venue-hierarchy Step 2 interface; see
    // the port docs). Minimal implementations added alongside the interface
    // extension so the repo keeps compiling — the Step-4/5 work builds the
    // use cases (and integration tests) on top of these. ─────────────────────

    async touchLastMessageAt({ id, at }) {
      // Monotonic guard (port doc): concurrent posts may commit out of order,
      // and the denormalized stamp must never move backwards.
      await p.bookingRequest.updateMany({
        where: {
          id,
          OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: at } }],
        },
        data: { lastMessageAt: at },
      });
    },

    async listOpenParked({ limit }) {
      const rows = await p.bookingRequest.findMany({
        where: {
          direction: "TO_VENUE",
          parkedUnclaimedAt: { not: null },
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
        },
        include: RELATED_INCLUDE,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      return rows.map(toToVenueRecord);
    },

    async expireParked({ id }) {
      // Same guard shape as `expireIfDue`, keyed on the parked stamp instead
      // of the deadline (a parked row may carry no `expiresAt` at all). The
      // stamp is cleared in the SAME statement: it is the fence that makes a
      // re-run a no-op. Only OPEN rows are cleared here; a closed row that
      // still carries a stamp is left for the column-drop migration.
      const result = await p.bookingRequest.updateMany({
        where: {
          id,
          direction: "TO_VENUE",
          parkedUnclaimedAt: { not: null },
          status: { in: [...OPEN_BOOKING_REQUEST_STATUSES] },
          holds: { none: { status: "CONFIRMED" } },
        },
        data: { status: "EXPIRED", parkedUnclaimedAt: null },
      });
      if (result.count === 0) return null;
      return refetch(p, id);
    },

    async addAttachment(input) {
      // CLAIM-ONCE on storageKey (Step-6 review; interim until the Step-8
      // upload-session mint scopes keys server-side): the key is client-
      // asserted, so the FIRST row to register it owns it forever. ANY
      // existing row — live OR soft-deleted, on ANY request — blocks
      // re-registration; without this, a participant could re-claim a key
      // (a soft-deleted one especially, whose GC enqueue may already be in
      // flight) and later have the soft-delete GC destroy bytes they never
      // uploaded. The check rides the caller's transaction client (`p` is
      // the tx when invoked via `repos.tx()`), same-tx with the insert.
      const claimed = await p.bookingRequestAttachment.findFirst({
        where: { storageKey: input.storageKey },
        select: { id: true },
      });
      if (claimed) {
        throw { code: "conflict", message: "attachment_key_taken" } as const;
      }
      const row = await p.bookingRequestAttachment.create({
        data: {
          bookingRequestId: input.bookingRequestId,
          storageKey: input.storageKey,
          fileName: input.fileName,
          contentType: input.contentType,
          sizeBytes: input.sizeBytes,
          // Uploader provenance (uploader-or-venue delete posture). The input
          // type is VENUE | PERFORMER only — SYSTEM never uploads (app-level
          // guarantee documented on the record type).
          uploadedBySide: input.uploadedBySide,
          uploadedByHumanId: input.uploadedByHumanId ?? null,
          // ── P3b (asks) ── the ask this file answers (FR-009a).
          askId: input.askId ?? null,
        },
      });
      return toAttachmentRecord(row);
    },

    async listAttachments(bookingRequestId) {
      const rows = await p.bookingRequestAttachment.findMany({
        where: { bookingRequestId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toAttachmentRecord);
    },

    async softDeleteAttachment({ id, bookingRequestId }) {
      // Idempotent stamp — the `deletedAt: null` guard makes a repeat call a
      // no-op instead of moving the stamp. `bookingRequestId` in the WHERE is
      // the IDOR backstop (port doc): an id from another request matches zero
      // rows. The CALLER must enqueue the returned record's storageKey on the
      // PendingObjectDeletion outbox in the SAME transaction, ONLY when
      // `didStamp` is true — this repo has no storage access, and a repeat
      // call must not double-enqueue the GC.
      const { count } = await p.bookingRequestAttachment.updateMany({
        where: { id, bookingRequestId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const row = await p.bookingRequestAttachment.findFirst({
        where: { id, bookingRequestId },
      });
      if (!row) return null; // No row in scope (bad id or another request's).
      return { record: toAttachmentRecord(row), didStamp: count > 0 };
    },

    async addActs(bookingRequestId, acts) {
      if (acts.length === 0) return [];
      // SELF rows copy the REQUEST ROW's owner pair — never a caller-supplied
      // one — read on the same client (the tx when invoked via `repos.tx()`),
      // so a SELF row can only ever name the sender.
      let sender: { ownerType: string; ownerId: string } | null = null;
      if (acts.some((act) => act.source === "SELF")) {
        const request = await p.bookingRequest.findUnique({
          where: { id: bookingRequestId },
          select: { performerOwnerType: true, performerOwnerId: true },
        });
        if (!request) {
          throw {
            code: "not_found",
            message: "booking_request_not_found",
          } as const;
        }
        if (
          request.performerOwnerType === null ||
          request.performerOwnerId === null
        ) {
          // An unclaimed anonymous inquiry has no sender pair to put on the
          // bill; core never asks for SELF on one (programmer error).
          throw {
            code: "invalid_input",
            message: "booking_request_self_act_without_sender",
          } as const;
        }
        sender = {
          ownerType: request.performerOwnerType,
          ownerId: request.performerOwnerId,
        };
      }
      // One create per act, in the caller's order, on the caller's client:
      // the returned rows come back in input order without relying on
      // createManyAndReturn's ordering. Bills are capped at 12 rows in total
      // (self included) by core, so N round trips inside one tx is fine.
      const out: BookingRequestActRecord[] = [];
      for (const act of acts) {
        const common = {
          bookingRequestId,
          source: act.source,
          role: act.role ?? "PERFORMER",
          // NULL unless role = OTHER is a SQL CHECK; core nulls it.
          customRoleLabel: act.customRoleLabel ?? null,
          sortOrder: act.sortOrder,
        } as const;
        const data: Prisma.BookingRequestActUncheckedCreateInput =
          act.source === "EXTERNAL"
            ? {
                ...common,
                externalName: act.externalName,
                externalUrl: act.externalUrl ?? null,
                // No one to ask — CONFIRMED at insert (SQL CHECK
                // "BookingRequestAct_pending_only_tagged_check").
                confirmation: "CONFIRMED",
              }
            : act.source === "SELF"
              ? {
                  ...common,
                  // Non-null: resolved above whenever any act is SELF.
                  actOwnerType: sender!.ownerType,
                  actOwnerId: sender!.ownerId,
                  // The sender speaks for their own act.
                  confirmation: "CONFIRMED",
                }
              : {
                  ...common,
                  actOwnerType: act.actOwnerType,
                  actOwnerId: act.actOwnerId,
                  confirmation: "PENDING",
                  invitedAt: act.invitedAt ?? null,
                };
        try {
          const row = await p.bookingRequestAct.create({ data });
          out.push(toActRecord(row));
        } catch (error) {
          // P2002 here can only be "BookingRequestAct_bookingRequestId_
          // actOwnerType_actOwnerId_key" (`id` is a fresh uuid): the same
          // platform act twice on one request — including re-tagging a human
          // whose DECLINED row still holds the key. Inside a transaction this
          // has already ABORTED it (port doc): the typed error is for the
          // caller to propagate, never to catch and continue.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          ) {
            throw {
              code: "conflict",
              message: "booking_request_act_duplicate",
              cause: error,
            } as const;
          }
          throw error;
        }
      }
      return out;
    },

    async listActsForRequests(bookingRequestIds, options) {
      if (bookingRequestIds.length === 0) return [];
      const rows = await p.bookingRequestAct.findMany({
        where: {
          bookingRequestId: { in: [...bookingRequestIds] },
          // Live bill only unless asked (v3 FR-001): a sender-removed act is
          // on no reader's bill.
          ...(options?.includeRemoved ? {} : { removedAt: null }),
        },
        // createdAt then id break sortOrder ties deterministically (rows
        // created in one tx can share a createdAt). Core assigns distinct
        // sortOrders, so the tiebreaks only ever order a corrupt bill.
        orderBy: [
          { bookingRequestId: "asc" },
          { sortOrder: "asc" },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      });
      return rows.map(toActRecord);
    },

    async getActForOwner(
      { bookingRequestId, actOwnerType, actOwnerId },
      options,
    ) {
      // By the platform-act unique key — an act is only reachable by naming
      // its owner (IDOR backstop; there is no get-by-act-id on the port).
      const row = await p.bookingRequestAct.findUnique({
        where: {
          bookingRequestId_actOwnerType_actOwnerId: {
            bookingRequestId,
            actOwnerType,
            actOwnerId,
          },
        },
      });
      if (!row) return null;
      // A removed row still holds the key; it is off the bill unless asked.
      if (row.removedAt !== null && !options?.includeRemoved) return null;
      return toActRecord(row);
    },

    async setActConfirmation(input) {
      // Guarded compare-and-swap, same discipline as `updateStatus`, scoped
      // to the OWNER: request + owner pair + expected state all travel with
      // the write, so another human's id, a concurrent confirm-vs-decline, or
      // a missing row all match zero rows → conflict.
      const where = {
        bookingRequestId: input.bookingRequestId,
        actOwnerType: input.actOwnerType,
        actOwnerId: input.actOwnerId,
      };
      const result = await p.bookingRequestAct.updateMany({
        // `source: TAGGED` — consent exists only for tagged artists; a SELF
        // row (the sender's own act) can never be answered or withdrawn.
        // `removedAt: null` — a sender-removed act can no longer answer.
        where: {
          ...where,
          source: "TAGGED",
          confirmation: input.expectedFrom,
          removedAt: null,
        },
        data: {
          confirmation: input.to,
          respondedAt: input.respondedAt,
          declineReason:
            input.to === "DECLINED" ? (input.declineReason ?? null) : null,
        },
      });
      if (result.count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const row = await p.bookingRequestAct.findUniqueOrThrow({
        where: { bookingRequestId_actOwnerType_actOwnerId: where },
      });
      return toActRecord(row);
    },

    async lockBill(bookingRequestId) {
      // Transaction-scoped: released at COMMIT/ROLLBACK, so it only
      // serializes anything when `p` is the tx client (port doc). The key is
      // a bound parameter (tagged template), never interpolated SQL.
      await p.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`booking_request_bill:${bookingRequestId}`}))`;
    },

    async promoteActToSelf({ bookingRequestId, actId }) {
      // The SELF owner pair comes off the REQUEST ROW, read on this same
      // client — exactly like a SELF insert in `addActs`.
      const request = await p.bookingRequest.findUnique({
        where: { id: bookingRequestId },
        select: { performerOwnerType: true, performerOwnerId: true },
      });
      if (!request) {
        throw {
          code: "not_found",
          message: "booking_request_not_found",
        } as const;
      }
      if (
        request.performerOwnerType === null ||
        request.performerOwnerId === null
      ) {
        throw {
          code: "invalid_input",
          message: "booking_request_self_act_without_sender",
        } as const;
      }
      let count: number;
      try {
        // Scoped by request AND source: a foreign act id, or a row that is
        // not free text, matches zero rows. The data is the full SELF shape
        // the SQL CHECK requires (owner pair set, externalName NULL,
        // CONFIRMED — the sender speaks for their own act).
        ({ count } = await p.bookingRequestAct.updateMany({
          where: {
            id: actId,
            bookingRequestId,
            source: "EXTERNAL",
            removedAt: null,
          },
          data: {
            source: "SELF",
            actOwnerType: request.performerOwnerType,
            actOwnerId: request.performerOwnerId,
            externalName: null,
            externalUrl: null,
            confirmation: "CONFIRMED",
          },
        }));
      } catch (error) {
        // The sender already holds a platform row on this request. Same
        // mapping (and the same abort-the-transaction caveat) as `addActs`.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw {
            code: "conflict",
            message: "booking_request_act_duplicate",
            cause: error,
          } as const;
        }
        throw error;
      }
      if (count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const row = await p.bookingRequestAct.findUniqueOrThrow({
        where: { id: actId },
      });
      return toActRecord(row);
    },

    // ── Bill editing (lineup v3, FR-009) ──────────────────────────────────
    // Addressed by act id but always scoped by request in the WHERE, so a
    // foreign id matches zero rows. Every write is a guarded updateMany:
    // zero rows → the typed conflict, never a silent no-op.

    async softRemoveAct({ bookingRequestId, actId, at }) {
      const { count } = await p.bookingRequestAct.updateMany({
        where: { id: actId, bookingRequestId, removedAt: null },
        data: { removedAt: at },
      });
      if (count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const row = await p.bookingRequestAct.findUniqueOrThrow({
        where: { id: actId },
      });
      return toActRecord(row);
    },

    async restoreAct({ bookingRequestId, actId, sortOrder, invitedAt }) {
      // Read the source first: the restore stamps consent the way an insert
      // does (port doc), and that depends on it. The CAS below re-checks
      // every condition, so a concurrent change between the two statements
      // still matches zero rows.
      const current = await p.bookingRequestAct.findFirst({
        where: {
          id: actId,
          bookingRequestId,
          removedAt: { not: null },
          // A pass is final (L14): a DECLINED row never comes back.
          confirmation: { not: "DECLINED" },
        },
        select: { source: true },
      });
      const { count } = current
        ? await p.bookingRequestAct.updateMany({
            where: {
              id: actId,
              bookingRequestId,
              source: current.source,
              removedAt: { not: null },
              confirmation: { not: "DECLINED" },
            },
            data:
              current.source === "TAGGED"
                ? {
                    removedAt: null,
                    sortOrder,
                    // Consent is asked again (port doc).
                    confirmation: "PENDING",
                    respondedAt: null,
                    declineReason: null,
                    invitedAt: invitedAt ?? null,
                  }
                : { removedAt: null, sortOrder },
          })
        : { count: 0 };
      if (count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const row = await p.bookingRequestAct.findUniqueOrThrow({
        where: { id: actId },
      });
      return toActRecord(row);
    },

    async setActSortOrders({ bookingRequestId, orderedActIds }) {
      // The caller must name the live bill exactly (port doc) — checked
      // BEFORE any write, so a stale plan changes nothing.
      const live = await p.bookingRequestAct.findMany({
        where: { bookingRequestId, removedAt: null },
        select: { id: true },
      });
      const liveIds = new Set(live.map((row) => row.id));
      const named = new Set(orderedActIds);
      if (
        named.size !== orderedActIds.length ||
        named.size !== liveIds.size ||
        [...named].some((id) => !liveIds.has(id))
      ) {
        throw {
          code: "conflict",
          message: "booking_request_bill_changed",
        } as const;
      }
      // ≤ 12 live rows (core's cap): one scoped update each, in order.
      for (const [index, id] of orderedActIds.entries()) {
        const { count } = await p.bookingRequestAct.updateMany({
          where: { id, bookingRequestId, removedAt: null },
          data: { sortOrder: index },
        });
        if (count === 0) {
          throw {
            code: "conflict",
            message: "booking_request_bill_changed",
          } as const;
        }
      }
      const rows = await p.bookingRequestAct.findMany({
        where: { bookingRequestId, removedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      return rows.map(toActRecord);
    },

    async setActRole({ bookingRequestId, actId, role, customRoleLabel }) {
      const { count } = await p.bookingRequestAct.updateMany({
        where: { id: actId, bookingRequestId, removedAt: null },
        data: { role, customRoleLabel },
      });
      if (count === 0) {
        throw {
          code: "conflict",
          message: "booking_request_act_state_changed",
        } as const;
      }
      const row = await p.bookingRequestAct.findUniqueOrThrow({
        where: { id: actId },
      });
      return toActRecord(row);
    },

    async setActName({ id, actName }) {
      // updateMany so a missing row is a count (not a P2025) — same posture
      // as `setAssignee`.
      const { count } = await p.bookingRequest.updateMany({
        where: { id },
        data: { actName },
      });
      if (count === 0) {
        throw {
          code: "not_found",
          message: "booking_request_not_found",
        } as const;
      }
      return refetch(p, id);
    },
    // ── P3b (asks) ── venue-booking-standards v1.1 FR-009
    async getAttachment({ id, bookingRequestId }) {
      const row = await p.bookingRequestAttachment.findFirst({
        where: { id, bookingRequestId },
      });
      return row ? toAttachmentRecord(row) : null;
    },
    ...makeBookingRequestAskMethods(p),
    // holds-without-a-request FR-012: the shared note (note-columns.ts).
    async setNote(input) {
      return writeNote(
        {
          update: async (where, data) =>
            (
              await p.bookingRequest.updateMany({
                where: { id: input.id, ...where },
                data,
              })
            ).count,
          read: () =>
            p.bookingRequest.findUnique({
              where: { id: input.id },
              select: NOTE_SELECT,
            }),
        },
        input,
      );
    },
  };
}

/** Prisma row → DTO (adapters never leak Prisma models). */
function toActRecord(row: BookingRequestAct): BookingRequestActRecord {
  return {
    id: row.id,
    bookingRequestId: row.bookingRequestId,
    source: row.source,
    // "human" | "organization" is DB-enforced by
    // "BookingRequestAct_source_shape_check".
    actOwnerType: (row.actOwnerType as PerformerOwnerType | null) ?? null,
    actOwnerId: row.actOwnerId ?? null,
    externalName: row.externalName ?? null,
    externalUrl: row.externalUrl ?? null,
    role: row.role as BookingRequestActRole,
    customRoleLabel: row.customRoleLabel ?? null,
    sortOrder: row.sortOrder,
    confirmation: row.confirmation,
    invitedAt: row.invitedAt ?? null,
    respondedAt: row.respondedAt ?? null,
    declineReason: row.declineReason ?? null,
    removedAt: row.removedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Prisma row → DTO (adapters never leak Prisma models). */
function toAttachmentRecord(
  row: BookingRequestAttachment,
): BookingRequestAttachmentRecord {
  return {
    id: row.id,
    bookingRequestId: row.bookingRequestId,
    storageKey: row.storageKey,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    // The DB column reuses the 3-value BookingMessageAuthorSide enum but the
    // record type promises VENUE | PERFORMER | null — an out-of-contract
    // SYSTEM row (impossible through this repo's write path) maps to null,
    // which the delete posture treats as venue-managed.
    uploadedBySide:
      row.uploadedBySide === "VENUE" || row.uploadedBySide === "PERFORMER"
        ? row.uploadedBySide
        : null,
    uploadedByHumanId: row.uploadedByHumanId ?? null,
    // ── P3b (asks) ──
    askId: row.askId ?? null,
    deletedAt: row.deletedAt ?? null,
    createdAt: row.createdAt,
  };
}

/** Post-updateMany re-read (updateMany can't `include`). */
async function refetch(
  p: PrismaClientOrTx,
  id: string,
): Promise<BookingRequestRecord> {
  const row = await p.bookingRequest.findUniqueOrThrow({
    where: { id },
    include: RELATED_INCLUDE,
  });
  return toRecord(row);
}

/**
 * Row → discriminated record. The direction shape (TO_VENUE ⇒ placeId set /
 * organizer columns null; TO_PERFORMER ⇒ the inverse, owned act pair) is
 * DB-guaranteed by "BookingRequest_direction_shape_check" — a violation here
 * means the row bypassed the migration's CHECK and is treated as corrupt
 * (invariant throw, mirroring `getBookingRequestSender`).
 */
function toRecord(row: BookingRequestWithRelated): BookingRequestRecord {
  const common = {
    id: row.id,
    placeName: row.place?.name ?? null,
    calendarName: row.calendar?.name ?? null,
    organizerOrgName: row.organizerOrg?.name ?? null,
    attachedEventTitle: row.attachedEvent?.title ?? null,
    attachedEventStartsAt: row.attachedEvent?.startsAt ?? null,
    intent: row.intent as BookingIntent,
    spaceId: row.spaceId ?? null,
    requestedStartsAt: row.requestedStartsAt ?? null,
    requestedEndsAt: row.requestedEndsAt ?? null,
    purpose: row.purpose ?? null,
    expectedAttendance: row.expectedAttendance ?? null,
    originEventId: row.originEventId ?? null,
    parkedUnclaimedAt: row.parkedUnclaimedAt ?? null,
    billRecorded: row.billRecorded ?? false,
    performerOwnerType:
      (row.performerOwnerType as PerformerOwnerType | null) ?? null,
    performerOwnerId: row.performerOwnerId ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
    source: row.source as BookingRequestSource,
    embedId: row.embedId ?? null,
    claimTokenHash: row.claimTokenHash ?? null,
    claimTokenExpiresAt: row.claimTokenExpiresAt ?? null,
    claimedAt: row.claimedAt ?? null,
    inquirerEmailMessageId: row.inquirerEmailMessageId ?? null,
    inquirerEmailUndeliverableAt: row.inquirerEmailUndeliverableAt ?? null,
    inquirerEmailUndeliverableStatus:
      (row.inquirerEmailUndeliverableStatus as BookingInquirerEmailFailure | null) ??
      null,
    message: row.message,
    preferredDates: toStringArray(row.preferredDates),
    expectedDraw: row.expectedDraw ?? null,
    genre: row.genre ?? null,
    links: toStringArray(row.links),
    actName: row.actName ?? null,
    lineupSize: row.lineupSize ?? null,
    setLengthMinutes: row.setLengthMinutes ?? null,
    contactPhone: row.contactPhone ?? null,
    techNeeds: row.techNeeds ?? null,
    feeType: row.feeType ?? null,
    feeAmountCents: row.feeAmountCents ?? null,
    feeCurrency: row.feeCurrency ?? null,
    linkMusic: row.linkMusic ?? null,
    linkVideo: row.linkVideo ?? null,
    linkSocial: row.linkSocial ?? null,
    linkEpk: row.linkEpk ?? null,
    calendarId: row.calendarId ?? null,
    tags: row.tags,
    assigneeHumanId: row.assigneeHumanId ?? null,
    taxFormStatus: row.taxFormStatus as BookingTaxFormStatus,
    lastMessageAt: row.lastMessageAt ?? null,
    status: row.status,
    viewedAt: row.viewedAt ?? null,
    respondedAt: row.respondedAt ?? null,
    declineReason: row.declineReason ?? null,
    agreementId: row.agreementId ?? null,
    verifiedStatsSnapshot:
      (row.verifiedStatsSnapshot as VerifiedStatsSnapshot | null) ?? null,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  if (row.direction === "TO_PERFORMER") {
    if (
      row.organizerOrgId === null ||
      row.performerOwnerType === null ||
      row.performerOwnerId === null ||
      row.placeId !== null
    ) {
      throw new Error(
        `booking_request_direction_invariant: TO_PERFORMER row ${row.id} violates the direction shape`,
      );
    }
    return {
      ...common,
      direction: "TO_PERFORMER",
      placeId: null,
      placeName: null,
      calendarId: null,
      calendarName: null,
      organizerOrgId: row.organizerOrgId,
      attachedEventId: row.attachedEventId ?? null,
      performerOwnerType: row.performerOwnerType as PerformerOwnerType,
      performerOwnerId: row.performerOwnerId,
      contactName: null,
      contactEmail: null,
      claimTokenHash: null,
      claimTokenExpiresAt: null,
      claimedAt: null,
      inquirerEmailMessageId: null,
      inquirerEmailUndeliverableAt: null,
      inquirerEmailUndeliverableStatus: null,
      verifiedStatsSnapshot: null,
    };
  }

  if (row.placeId === null) {
    throw new Error(
      `booking_request_direction_invariant: TO_VENUE row ${row.id} has no placeId`,
    );
  }
  return {
    ...common,
    direction: "TO_VENUE",
    placeId: row.placeId,
    organizerOrgId: null,
    organizerOrgName: null,
    attachedEventId: null,
    attachedEventTitle: null,
    attachedEventStartsAt: null,
  };
}

/** As {@link toRecord} but asserting the TO_VENUE branch (typed lists). */
function toToVenueRecord(
  row: BookingRequestWithRelated,
): ToVenueBookingRequestRecord {
  const record = toRecord(row);
  if (record.direction !== "TO_VENUE") {
    throw new Error(
      `booking_request_direction_invariant: expected TO_VENUE, got ${record.direction} for ${row.id}`,
    );
  }
  return record;
}

/** As {@link toRecord} but asserting the TO_PERFORMER branch (typed lists). */
function toToPerformerRecord(
  row: BookingRequestWithRelated,
): ToPerformerBookingRequestRecord {
  const record = toRecord(row);
  if (record.direction !== "TO_PERFORMER") {
    throw new Error(
      `booking_request_direction_invariant: expected TO_PERFORMER, got ${record.direction} for ${row.id}`,
    );
  }
  return record;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
