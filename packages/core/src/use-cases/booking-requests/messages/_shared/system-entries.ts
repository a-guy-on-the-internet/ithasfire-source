import { z } from "zod";

import type { TxRepos } from "@th/ports/repos";
import type { BookingRequestMessageRow } from "@th/ports/repos/booking-request-messages";
import type { BookingSystemEntryKind } from "@th/ports/repos/booking-request-messages";

import { fail } from "@th/errors";

import { parseInput } from "../../../../lib/io";
import {
  LEGACY_OWNER_SIDE,
  LEGACY_REQUEST_DIRECTION,
  LEGACY_THREAD_SIDE,
  normalizeCancellerSide,
  normalizeRequestDirection,
  normalizeThreadSide,
} from "../../../../lib/legacy-place-values";
import { messagesIn } from "./thread-access";

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM ENTRIES — the booking-request thread as the booking's LEDGER.
//
// The thread stops being just a chat: human messages interleave with SYSTEM
// entries recording every lifecycle transition, so a reader can watch the
// agreement get hammered out, then watch the event appear, in one column.
//
// An entry is a KIND (`BookingRequestMessage.systemKind`) plus PARAMS
// (`.systemData`), never a sentence. `body` is empty on entries. The sentence
// lives in the en/es i18n catalogs — a hardcoded English string at rest would
// be unlocalizable behind the argument-parity gate, and could not carry the
// links (agreement, event) and locale-formatted dates an entry needs.
//
// THIS FILE IS THE CONTRACT. The kind vocabulary is in
// `@th/types/repos/booking-request-messages` (a plain string union, matching
// the house style for taxonomies — see the migration comment for why not a
// Prisma enum); the PARAMS SHAPE for each kind is here, as zod, so a malformed
// payload cannot reach the ledger.
//
// WHERE THE EMITTERS LIVE. `appendBookingSystemEntry` below is the ONE
// function every emitter calls, from inside its own transition tx:
//   · request kinds   — use-cases/booking-requests/* (create / respond /
//                       claim / withdraw / the expiry sweep);
//   · agreement kinds — use-cases/booking-agreements/* (send-for-review,
//                       respond, pull-back, reopen, cancel, finalize) and
//                       `booking_agreement.fulfilled` from `completeEvent`;
//   · event kinds     — use-cases/events/_shared/booking-event-ledger.ts,
//                       called by the save, publish, cancel and complete
//                       use cases.
//
//   · hold kinds      — use-cases/booking-holds/* (place / reorder / challenge
//                       / extend / answer / release / confirm) and the shared
//                       lapse settler; `booking_hold.released` is also written
//                       by the request-closing paths (decline / withdraw /
//                       expire — FR-009) via `_shared/release-for-request.ts`;
//   · assignment      — use-cases/booking-requests/assign-booking-request.ts
//                       and the first-staff-message auto-assign in
//                       messages/post-message.ts (FR-015).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which human side caused the transition, for entries whose copy names an
 * actor ("Countered by the venue"). SYSTEM entries cannot carry this on
 * `authorSide` — that column is SYSTEM by definition, which is exactly what
 * keeps entries out of unread counts and out of mine/theirs bubble alignment.
 *
 * Stored as `"PLACE"`. The input also takes the old spelling — the thread-side
 * enum writers hold still spells it that way until the Prisma enum is renamed
 * — and writes it as `"PLACE"` (`lib/legacy-place-values`).
 */
const actorSideSchema = z
  .enum(["PLACE", "PERFORMER", LEGACY_THREAD_SIDE])
  .transform((side) => normalizeThreadSide(side));

/**
 * ISO-8601 STRING, never `z.date()`. `systemData` is a Json column: a Date
 * written in goes in as an ISO string and comes back OUT as a string, so a
 * date-typed schema would validate on write and fail on read. Rendering
 * formats it in the viewer's locale.
 */
const isoDateTimeSchema = z.string().datetime();

const idSchema = z.string().uuid();

/** Place-local calendar day, `YYYY-MM-DD` — the DATE column's own shape. */
const isoCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** 1-based line position. */
const positionSchema = z.number().int().min(1);

/** Mirrors `BookingHoldReleaseReason` (types/repos/booking-holds). */
const holdReleaseReasonSchema = z.enum([
  "MANUAL",
  "EXPIRED",
  "CONFIRMED_OTHER",
  "REQUEST_CLOSED",
  "SIBLING_CONFIRMED",
  "PAST_DATE",
  "EVENT_SCHEDULED",
  "BOOKING_CANCELLED",
]);

/**
 * THE reason bound (booking-the-night N18 / FR-013: one reason field wherever
 * a booking ends or is refused, up to 1000 characters). Mirrors the
 * `declineReason` caps in `respond-to-booking-request` and
 * `respond-to-booking-agreement`. The one exception is an act's pass (240,
 * like `BookingRequestAct.declineReason`) — see `booking_request.act_declined`.
 * A saved reason (SavedSnippet body, ≤ 500) always fits.
 *
 * The EMITTER passes text that has ALREADY been sanitized at its own input
 * boundary (`plainTextMultilineRequired`) — this cap is the ledger's own
 * backstop against an unbounded blob landing in Json, not a substitute for
 * sanitizing. Escaping happens at the sink, as everywhere else.
 */
export const BOOKING_REASON_MAX = 1000;
const reasonSchema = z.string().max(BOOKING_REASON_MAX).nullable();

/**
 * {@link reasonSchema}'s bound, but required and non-empty: for the
 * booking-the-night transitions that cannot happen without a reason.
 */
const requiredReasonSchema = z.string().min(1).max(BOOKING_REASON_MAX);

/**
 * Params schema per kind. Every schema is `.strict()`: an emitter that adds a
 * field without adding it here fails loudly instead of writing a param no
 * renderer will read.
 *
 * `satisfies Record<BookingSystemEntryKind, …>` is load-bearing — it makes the
 * map EXHAUSTIVE. Adding a kind to the union without a schema here is a
 * compile error, so `appendBookingSystemEntry` can never look up `undefined`.
 */
export const BOOKING_SYSTEM_ENTRY_SCHEMAS = {
  // ── Request lifecycle ──────────────────────────────────────────────────────
  /**
   * Opens the ledger. Carries the two facts the copy branches on: which way
   * the request flows, and whether it arrived through an embed (an anonymous
   * embed inquiry reads differently from a signed-in pitch).
   */
  "booking_request.opened": z
    .object({
      // Stored as `"TO_PLACE"`; the request-direction enum writers pass still
      // spells it the old way, and is written the new way.
      direction: z
        .enum(["TO_PLACE", "TO_PERFORMER", LEGACY_REQUEST_DIRECTION])
        .transform((direction) => normalizeRequestDirection(direction)),
      source: z.enum(["PLATFORM", "EMBED"]),
    })
    .strict(),
  /**
   * The receiving side opened it. No params — WHO viewed it is the entry's
   * `authorHumanId`, and WHEN is its `createdAt`.
   */
  "booking_request.viewed": z.object({}).strict(),
  /**
   * The expiry sweep aged it out. Machine-caused, so the entry's
   * `authorHumanId` is null and the deadline has to live in the params.
   */
  "booking_request.expired": z
    .object({ expiresAt: isoDateTimeSchema })
    .strict(),
  /** The sender pulled it. Actor is the entry's `authorHumanId`. */
  "booking_request.withdrawn": z.object({}).strict(),
  /**
   * The receiving side said yes. `agreementId` is null when the accept did not
   * mint an agreement, so the copy can link the draft when there is one and
   * stay a plain sentence when there is not.
   */
  "booking_request.accepted": z
    .object({ agreementId: idSchema.nullable() })
    .strict(),
  /**
   * The receiving side said no. The reason is COPIED onto the entry rather
   * than read live off `BookingRequest.declineReason`: a ledger entry records
   * what was said at that moment, and the request row is mutable. Null where
   * the direction does not require one (TO_PERFORMER).
   */
  "booking_request.declined": z.object({ reason: reasonSchema }).strict(),
  /**
   * Venue-internal assignee changed (booking-holds FR-015). Both ids are
   * nullable: `null → X` is the first assignment, `X → null` is an unassign.
   * Never shown to the act — the thread renderer gates this kind by side.
   */
  "booking_request.assigned": z
    .object({
      assigneeHumanId: idSchema.nullable(),
      previousAssigneeHumanId: idSchema.nullable(),
    })
    .strict(),

  /**
   * RETIRED — readable for old rows, never written (see
   * {@link RETIRED_BOOKING_SYSTEM_ENTRY_KINDS}). Parked at an unclaimed place
   * (venue-confirmation spec, before the 2026-09-25 amendment). No params.
   */
  "booking_request.parked_unclaimed": z.object({}).strict(),
  /**
   * RETIRED — readable for old rows, never written. The place was claimed
   * and the parked request went live. No params.
   */
  "booking_request.unparked": z.object({}).strict(),
  // ── P3a (unclaimed venues) ──
  /**
   * The one-off cleanup expired a request parked before the 2026-09-25
   * amendment. `placeName` is a display SNAPSHOT (`Place.name` at cleanup
   * time) so the renderer needs no join: "{place} isn't on Ithas Fire yet,
   * so this request can't reach them." Null when the place row was gone (the
   * copy then says "This place"). Machine-caused: no author.
   */
  "booking_request.expired_unclaimed": z
    .object({ placeName: z.string().min(1).max(200).nullable() })
    .strict(),
  /**
   * A tagged artist answered their spot on the bill (lineup-booking-requests
   * v2, FR-003). `actName` is a display SNAPSHOT (the renderer must not need
   * a join, and a later rename must not rewrite history), bounded like
   * `BookingRequestAct.externalName`. The artist is the entry's
   * `authorHumanId` (for a tagged GROUP, the editor who answered for it).
   * `act_declined` is SENDER-ONLY (see {@link SENDER_ONLY_SYSTEM_ENTRY_KINDS}):
   * the venue never sees a passed act (FR-004). Since v3 L19 it carries the
   * pass reason (`reason`, ≤ 240 like `BookingRequestAct.declineReason`, only
   * when one was given) so the sender reads it in the thread, and `left:
   * true` when the act had JOINED and then left the bill (L14) — both stay
   * sender-only with the entry.
   */
  "booking_request.act_confirmed": z
    .object({ actId: idSchema, actName: z.string().min(1).max(120) })
    .strict(),
  "booking_request.act_declined": z
    .object({
      actId: idSchema,
      actName: z.string().min(1).max(120),
      reason: z.string().min(1).max(240).optional(),
      left: z.literal(true).optional(),
    })
    .strict(),
  /**
   * The sender edited the bill (lineup v3, FR-009): ONE entry per edit call.
   * VISIBLE TO BOTH SIDES, and `list-messages` hands the venue the full
   * `systemData` — so every param here is VENUE-SAFE BY CONSTRUCTION, and the
   * schema enforces it rather than trusting emitters or renderers
   * (NFR-002: an invited act never reads as joined; a passed act never
   * appears on anything venue-facing):
   *   · `added[]` — each act that went on. `source` is the row's source and
   *     `state` is DERIVED from it (refined below): SELF ⇒ `joined` (the
   *     sender speaks for their own act), TAGGED ⇒ `invited` (a new tag, or
   *     a restored one — `restoreAct` returns a TAGGED row to PENDING, so a
   *     re-added act is invited again, never joined), EXTERNAL ⇒ `by_name`.
   *     `name` is a display SNAPSHOT like `act_confirmed.actName`.
   *   · `removed[]` — ONLY acts the venue saw as PRESENT: `joined` or
   *     `by_name`, each named. No other state can be written here, so no
   *     `invited` / `passed` marker ever reaches the venue.
   *   · `otherRemovedCount` — how many INVITED acts went off. Opaque on
   *     purpose: the venue saw them on the bill as invited (FR-004), so a
   *     count says nothing new, while a name or state would ("the bill
   *     changed" covers it). Acts that had PASSED are NOT COUNTED ANYWHERE:
   *     the venue never saw them, so their removal is not a change to the
   *     venue's bill.
   *   · `reordered` — whether the order of the venue-visible acts changed
   *     (an emitter computes it over the bill WITHOUT passed acts).
   *   · `roleChanged` — whether an act the venue saw both before and after
   *     the edit (live, not passed — an invited act's role is venue-visible)
   *     changed role or role label. A bare flag: the bill read already
   *     shows the new role, and a passed act's role is never counted.
   * An entry with nothing venue-visible in it (e.g. an edit that only took
   * off passed acts, or re-roled one) is refused: its mere existence would
   * tell the venue something happened. The emitter writes no entry for such
   * an edit.
   */
  "booking_request.bill_changed": z
    .object({
      added: z
        .array(
          z
            .object({
              actId: idSchema,
              name: z.string().min(1).max(120),
              source: z.enum(["SELF", "TAGGED", "EXTERNAL"]),
              state: z.enum(["invited", "by_name", "joined"]),
            })
            .strict()
            .refine(
              (row) =>
                (row.source === "SELF" && row.state === "joined") ||
                (row.source === "TAGGED" && row.state === "invited") ||
                (row.source === "EXTERNAL" && row.state === "by_name"),
              {
                message: "bill_changed_added_state_not_source",
                path: ["state"],
              },
            ),
        )
        .max(12),
      removed: z
        .array(
          z
            .object({
              name: z.string().min(1).max(120),
              wasState: z.enum(["joined", "by_name"]),
            })
            .strict(),
        )
        .max(12),
      otherRemovedCount: z.number().int().min(0).max(12),
      reordered: z.boolean(),
      roleChanged: z.boolean(),
    })
    .strict()
    .refine(
      (entry) =>
        entry.added.length > 0 ||
        entry.removed.length > 0 ||
        entry.otherRemovedCount > 0 ||
        entry.reordered ||
        entry.roleChanged,
      { message: "bill_changed_nothing_venue_visible" },
    ),
  /**
   * An act that joined after the event existed was put on its lineup by
   * itself (v3 FR-010, L4). Visible to both sides. The act is the entry's
   * `authorHumanId` (the joining human); the act row id, the event it
   * landed on and the act's display SNAPSHOT (`actName`, like
   * `act_confirmed.actName` — the renderer must not need a join) are the
   * params. Like `act_confirmed`, the read side hides it once the act is no
   * longer joined (`list-messages`): a later pass must not leave "X is on
   * the lineup" on the venue's thread.
   */
  "booking_request.act_joined_lineup": z
    .object({
      actId: idSchema,
      eventId: idSchema,
      actName: z.string().min(1).max(120),
    })
    .strict(),
  /**
   * The venue closed an ACCEPTED request before the night was booked
   * (booking-the-night FR-010, N14). The reason is required (N18) and COPIED
   * at that moment, like `.declined`. Visible to both sides. The closer is
   * the entry's `authorHumanId`.
   */
  "booking_request.closed_by_place": z
    .object({ reason: requiredReasonSchema })
    .strict(),
  /**
   * A booked night was cancelled (booking-the-night FR-009, N13). `by` says
   * which side cancelled — the venue, or the sender (the side that sent the
   * request; for a solo act pitching themselves, the act). The reason is
   * required (N18) and copied at that moment. Visible to both sides; the
   * canceller is the entry's `authorHumanId`.
   */
  "booking_request.booking_cancelled": z
    .object({
      // Stored as `"place"`; the canceller side `cancelBooking` holds still
      // spells it the old way, and is written the new way.
      by: z
        .enum(["place", "sender", LEGACY_OWNER_SIDE])
        .transform((by) => normalizeCancellerSide(by)),
      reason: requiredReasonSchema,
    })
    .strict(),
  // ── P3b (asks) ── venue-booking-standards v1.1 FR-009b. The ask's `label`
  // (the venue's wording, sanitized at the ask's boundary, ≤ 80) is COPIED
  // at that moment, like a reason; `kind` lets the copy say what was asked
  // for without a join. The actor is the entry's `authorHumanId`.
  "booking_request.ask_opened": z
    .object({
      askId: idSchema,
      kind: z.enum(["IMAGE", "FILE", "LINK", "TEXT", "SET_LENGTH"]),
      label: z.string().min(1).max(80),
    })
    .strict(),
  /** `replaced`: the sender changed an answer they had already given. */
  "booking_request.ask_answered": z
    .object({
      askId: idSchema,
      kind: z.enum(["IMAGE", "FILE", "LINK", "TEXT", "SET_LENGTH"]),
      label: z.string().min(1).max(80),
      replaced: z.boolean(),
    })
    .strict(),
  "booking_request.ask_withdrawn": z
    .object({
      askId: idSchema,
      kind: z.enum(["IMAGE", "FILE", "LINK", "TEXT", "SET_LENGTH"]),
      label: z.string().min(1).max(80),
    })
    .strict(),

  // ── Holds (booking-holds spec 2026-08-25) ─────────────────────────────────
  // Every hold entry carries `holdId` so the renderer can key on the hold; the
  // DATE is snapshotted on `placed` (a hold's date never changes, but the copy
  // must not need a join to say "Oct 13").
  /** Staff placed a hold at `position` on `date`. */
  /**
   * NO calendarId: this entry renders on the ACT's thread too, and the act
   * sees its own date and position only (booking-holds FR-013) — the venue's
   * calendar structure is not part of that. holdId + date + position suffice.
   */
  "booking_hold.placed": z
    .object({
      holdId: idSchema,
      date: isoCalendarDateSchema,
      position: positionSchema,
    })
    .strict(),
  /** Position changed — staff reorder OR a move-up after a release. */
  "booking_hold.reordered": z
    .object({ holdId: idSchema, from: positionSchema, to: positionSchema })
    .strict(),
  /** → CHALLENGED with the keep-or-release deadline (ISO string, Json rule). */
  "booking_hold.challenged": z
    .object({ holdId: idSchema, respondBy: isoDateTimeSchema })
    .strict(),
  /** Deadline pushed later while still CHALLENGED. */
  "booking_hold.extended": z
    .object({ holdId: idSchema, respondBy: isoDateTimeSchema })
    .strict(),
  /**
   * The act kept a challenged hold. Before booking-the-night P2d-2 that was
   * CHALLENGED → ACTIVE and the entry carried `holdId` only. Since FR-014
   * (Keep = commit) a keep on sent terms books the night (the thread shows
   * the agree and the confirm instead), and a keep with no terms sent stays
   * CHALLENGED with a new deadline: `respondBy` is that deadline (by which
   * the act must agree the terms the venue sends) and `challengedAt` the
   * challenge it answers — the key the "already kept?" check matches on, so
   * a keep in an earlier round never counts for a later challenge. Both
   * optional so pre-P2d-2 rows stay valid.
   */
  "booking_hold.kept": z
    .object({
      holdId: idSchema,
      respondBy: isoDateTimeSchema.optional(),
      challengedAt: isoDateTimeSchema.optional(),
    })
    .strict(),
  // ── booking-the-night P2d-2 ──
  /**
   * N20 / FR-015: this request's hold moved up to 1st on `date`, and its
   * terms are ready for that night (drafted, dated there) — the venue can
   * send them now. VENUE-INTERNAL ({@link VENUE_INTERNAL_SYSTEM_ENTRY_KINDS}):
   * it is the venue's cue; the act hears its move through the usual
   * position notice.
   */
  "booking_hold.first_ready": z
    .object({
      holdId: idSchema,
      date: isoCalendarDateSchema,
      agreementId: idSchema,
    })
    .strict(),
  /**
   * → RELEASED. `reason` mirrors the Prisma `BookingHoldReleaseReason` enum
   * so the copy can say why ("the date went to another act", "the request
   * was closed", "the challenge lapsed").
   *
   * `by` says WHO let go and is only set for `reason: "MANUAL"` — both the
   * act (challenge answered: release) and staff (`release-booking-hold`)
   * write MANUAL, and without it the copy cannot tell "you released" from
   * "the venue released". Optional so pre-field rows stay valid; the
   * settle / closure / confirm-driven releases omit it (their `reason`
   * already says why).
   */
  "booking_hold.released": z
    .object({
      holdId: idSchema,
      reason: holdReleaseReasonSchema,
      by: z.enum(["act", "staff"]).optional(),
    })
    .strict(),
  /**
   * → CONFIRMED. `eventId` is nullable: the confirm transaction writes this
   * entry BEFORE the draft event is minted post-commit (the mint runs the
   * existing create-event-from-agreement path, which appends its own
   * `booking_event.created`), so the id is not known yet.
   */
  /**
   * `withoutTerms` (booking-the-night FR-004): true when the venue booked the
   * night straight from the hold, with no agreed terms (N3). Optional so
   * every row written before it stays valid; absent reads as "with terms" or
   * "not known" — never as a booking without terms.
   */
  "booking_hold.confirmed": z
    .object({
      holdId: idSchema,
      eventId: idSchema.nullable(),
      withoutTerms: z.boolean().optional(),
    })
    .strict(),

  // ── Agreement negotiation ──────────────────────────────────────────────────
  // Every agreement entry carries `agreementId` so the copy can link straight
  // to the document the transition is about.
  /**
   * A draft was attached to the request LATER — i.e. not by the accept that
   * minted it. `claim-booking-request` is the only emitter: an anonymous embed
   * inquiry is accepted with no agreement (`booking_request.accepted` carries
   * `agreementId: null`), and the draft arrives in its own transaction when
   * the performer claims the invite.
   *
   * DO NOT re-add this alongside `booking_request.accepted` on the immediate
   * accept paths. It says nothing that entry's own `agreementId` does not, and
   * two entries in one transaction share a `createdAt` (Postgres
   * CURRENT_TIMESTAMP is per-TRANSACTION) so the thread's
   * `[createdAt asc, id asc]` order falls through to a random uuid — the
   * effect renders above its cause roughly half the time.
   */
  "booking_agreement.drafted": z.object({ agreementId: idSchema }).strict(),
  /** DRAFT → PROPOSED. `actorSide` names who sent it. */
  "booking_agreement.sent_for_review": z
    .object({ agreementId: idSchema, actorSide: actorSideSchema })
    .strict(),
  /** → COUNTERED. */
  "booking_agreement.countered": z
    .object({ agreementId: idSchema, actorSide: actorSideSchema })
    .strict(),
  /** → ACCEPTED. */
  "booking_agreement.accepted": z
    .object({ agreementId: idSchema, actorSide: actorSideSchema })
    .strict(),
  /** → DECLINED, with the reason recorded at the moment it was given. */
  "booking_agreement.declined": z
    .object({
      agreementId: idSchema,
      actorSide: actorSideSchema,
      reason: reasonSchema,
    })
    .strict(),
  /** Proposer withdrew it from review (→ DRAFT). */
  "booking_agreement.pulled_back": z
    .object({ agreementId: idSchema, actorSide: actorSideSchema })
    .strict(),
  /**
   * The sender declined request-linked terms and they went back to the venue
   * as a DRAFT (booking-the-night N16, FR-012). `reason` is the sender's,
   * copied at that moment; optional so a return without one (none is planned
   * today) stays writable.
   *
   * EMITTER NOTE: two entries written in one transaction share a `createdAt`
   * (see `booking_agreement.drafted`), so if a decline writes this beside
   * `.declined`, their order in the thread is not guaranteed.
   */
  "booking_agreement.returned_to_draft": z
    .object({
      agreementId: idSchema,
      reason: requiredReasonSchema.optional(),
    })
    .strict(),
  /**
   * The sender's "Agree & book" was refused before the line moved —
   * booking-the-night FR-001: the night had gone to another hold since the
   * terms were sent (N6), the request's event is on another day (NFR-001),
   * its event-first origin or the event the terms were finalized against
   * was cancelled or archived (N11), or the place is not taking bookings.
   * `date` is the place-local night the terms named. The terms stay
   * PROPOSED. VENUE-INTERNAL ({@link VENUE_INTERNAL_SYSTEM_ENTRY_KINDS}):
   * this is the venue being told to pick another night; it names no other
   * party, but the sender's own copy is the refusal they already saw. The
   * sender who tapped is the entry's `authorHumanId`.
   */
  "booking_agreement.agree_refused": z
    .object({
      agreementId: idSchema,
      date: isoCalendarDateSchema,
      /**
       * Why: the night went to someone else (absent — every row written
       * before the field), or the request's event sits on another day than
       * the terms (`event_on_another_night`), for the venue to move one of
       * them, or an event-first request's origin event was cancelled or
       * archived (`event_origin_gone`, spec N11), or the event the terms
       * were finalized against was (`linked_event_gone`), or the place is
       * suspended or retired (`place_not_taking_bookings`).
       */
      reason: z
        .enum([
          "night_taken",
          "event_on_another_night",
          "event_origin_gone",
          "linked_event_gone",
          "place_not_taking_bookings",
        ])
        .optional(),
    })
    .strict(),
  /**
   * The sender's "Agree & book" booked the night, but the draft event was not
   * created after the commit (booking-the-night N10, FR-001; P2b review carry
   * e): the venue person who sent the terms could not mint it (authority, the
   * venue org's event quota) or a race / outage hit the mint. The night stays
   * booked and the terms ACCEPTED; "Create event" is the retry. `date` is the
   * booked place-local night. VENUE-INTERNAL
   * ({@link VENUE_INTERNAL_SYSTEM_ENTRY_KINDS}), like `.agree_refused`: it is
   * the venue's cue to act, and the sender's own tap already succeeded. The
   * sender who tapped is the entry's `authorHumanId`.
   */
  "booking_agreement.event_not_created": z
    .object({
      agreementId: idSchema,
      date: isoCalendarDateSchema,
    })
    .strict(),
  /**
   * → CANCELLED by the terms editor, with the reason recorded at the moment
   * it was given (same posture as `.declined`: COPIED, never read live off
   * the agreement — there is no `cancelledReason` column to read anyway).
   */
  "booking_agreement.cancelled": z
    .object({
      agreementId: idSchema,
      actorSide: actorSideSchema,
      reason: reasonSchema,
    })
    .strict(),
  /** A settled agreement was reopened for edits. */
  "booking_agreement.reopened": z
    .object({ agreementId: idSchema, actorSide: actorSideSchema })
    .strict(),
  /**
   * Terms activated and the event went live. `eventId` is nullable because
   * finalize is the step that stamps it — an entry written before the stamp
   * lands (or for an agreement with no event) still has to be writable.
   */
  "booking_agreement.finalized": z
    .object({ agreementId: idSchema, eventId: idSchema.nullable() })
    .strict(),
  /**
   * ACCEPTED → FULFILLED. Written by `completeEvent` (the ONLY writer of
   * FULFILLED) right after its own `booking_event.completed` entry: money is
   * settled per-payee, not per-event, so "the event happened" is the honest
   * trigger for "the agreement was fulfilled". No `actorSide` — completing
   * the event is an organizer action, not a negotiation move.
   */
  "booking_agreement.fulfilled": z.object({ agreementId: idSchema }).strict(),

  // ── Event ──────────────────────────────────────────────────────────────────
  /**
   * An event was minted from the agreement — the moment the booking becomes a
   * show. `startsAt` is snapshotted so the entry still reads correctly after
   * the event is later moved.
   */
  "booking_event.created": z
    .object({
      eventId: idSchema,
      agreementId: idSchema.nullable(),
      startsAt: isoDateTimeSchema,
    })
    .strict(),
  /**
   * A field the booking cares about changed on that event.
   *
   * `changedFields` is a bounded array of strings at the ledger boundary; the
   * real closed set is `BOOKING_TRACKED_EVENT_FIELDS` in
   * `events/_shared/booking-event-ledger.ts` (the emitter, called from the
   * save path), and the renderer drops any name it does not know. The
   * start-time pair is called out separately because "moved from Fri 8pm to
   * Sat 9pm" is the one change the copy has to render as a before/after, and
   * both sides are null when the change was not a reschedule.
   */
  "booking_event.modified": z
    .object({
      eventId: idSchema,
      changedFields: z.array(z.string().min(1).max(64)).min(1).max(20),
      previousStartsAt: isoDateTimeSchema.nullable(),
      nextStartsAt: isoDateTimeSchema.nullable(),
    })
    .strict(),
  // The three lifecycle transitions below are emitted from the transition's
  // own use case (`publishEvent` / `cancelEvent` / `completeEvent`), inside
  // its own tx, through `_shared/booking-event-ledger.ts`. All are silent
  // no-ops for an event that never came from a booking.
  /**
   * DRAFT → PUBLISHED. `startsAt` is snapshotted (nullable: a row with no
   * start is legal on the event record) so the entry reads correctly after a
   * later reschedule.
   */
  "booking_event.published": z
    .object({ eventId: idSchema, startsAt: isoDateTimeSchema.nullable() })
    .strict(),
  /**
   * → CANCELLED. No reason: `cancelEvent` takes none (the refund bookkeeping
   * is the audit trail), so there is nothing truthful to copy here.
   */
  "booking_event.cancelled": z.object({ eventId: idSchema }).strict(),
  /** PUBLISHED → COMPLETED. Immediately precedes `booking_agreement.fulfilled`. */
  "booking_event.completed": z.object({ eventId: idSchema }).strict(),
  // ── Venue confirmation (docs/specs/2026-08-27) ─────────────────────────────
  // Emitted from `events/confirm-venue-event` / `withdraw-venue-confirmation`
  // inside their own tx, ONLY when the event is linked to a booking request.
  // Both are visible to the requester — the confirmation is the venue
  // answering them.
  /**
   * The venue confirmed the event at its place. `ownerSide` is whose event
   * it is: `"place"` (place-owned — confirmed by construction, stamped for
   * SQL-read consistency) or `"requester"`.
   */
  "booking_event.place_confirmed": z
    .object({
      eventId: idSchema,
      ownerSide: z.enum(["place", "requester"]),
    })
    .strict(),
  /**
   * The venue withdrew its confirmation (or declined a never-confirmed
   * event). `reason` is the venue's own words, already sanitized at the use
   * case's boundary; the event keeps `placeId` and drops to address-only.
   */
  "booking_event.place_confirmation_withdrawn": z
    .object({ eventId: idSchema, reason: reasonSchema })
    .strict(),
} satisfies Record<BookingSystemEntryKind, z.ZodTypeAny>;

/** The validated params shape for one kind — what lands in the column. */
export type BookingSystemEntryData<K extends BookingSystemEntryKind> = z.infer<
  (typeof BOOKING_SYSTEM_ENTRY_SCHEMAS)[K]
>;

/**
 * What a writer may pass for one kind: {@link BookingSystemEntryData}, except
 * a place-valued param may still arrive in its old spelling (see
 * `actorSideSchema`); the schema writes it the new way.
 */
export type BookingSystemEntryInputData<K extends BookingSystemEntryKind> =
  z.input<(typeof BOOKING_SYSTEM_ENTRY_SCHEMAS)[K]>;

export type AppendBookingSystemEntryInput<K extends BookingSystemEntryKind> = {
  bookingRequestId: string;
  kind: K;
  /** Validated against `BOOKING_SYSTEM_ENTRY_SCHEMAS[kind]` before the write. */
  data: BookingSystemEntryInputData<K>;
  /**
   * The human who caused the transition, when there is one. Recorded so the
   * copy can say "Pulled back by Dana" — the name is resolved at render time
   * from this id, never snapshotted (a stored name goes stale and cannot be
   * localized). Omit/null for machine-caused entries: the expiry sweep, a
   * webhook, a backfill. The row's `authorSide` is SYSTEM either way.
   */
  actorHumanId?: string | null;
};

/**
 * Append ONE system entry to a booking request's ledger. This is the only
 * supported writer of `systemKind` / `systemData`.
 *
 * TRANSACTION PARTICIPATION — the reason this takes `TxRepos` and not `Repos`:
 * the ledger must never disagree with the state it records. Every emitter in
 * step 2 already runs its transition inside a `repos.tx()` (CAS status update,
 * agreement write, audit row), and calls this from INSIDE that same callback:
 *
 *     await deps.repos.tx(async (tx) => {
 *       await tx.bookingRequests.updateStatus({ … });
 *       await appendBookingSystemEntry(tx, { … });
 *       await tx.audit.log({ … });
 *     });
 *
 * so either the transition and its entry both commit or neither does. This
 * function deliberately does NOT open a transaction of its own — doing so
 * would let a committed entry describe a transition that then rolled back.
 *
 * It bumps `BookingRequest.lastMessageAt` in that same transaction, exactly as
 * a human message does (the port mandate on
 * `BookingRequestMessagesRepo.create`): an entry IS activity on the booking,
 * and the denormalized recency stamp must not disagree with the thread.
 *
 * THE BUMP DOES NOT REORDER ANY INBOX TODAY. Every list surface sorts by
 * `BookingRequest.createdAt desc` (all five adapter list methods), so
 * `lastMessageAt` is a stamp nothing currently orders by. Keeping it accurate
 * is the point — a recency-sorted inbox is a plausible future and it must not
 * find a column that only human messages ever moved. Do not write "moves the
 * request up the inbox" here again without an `orderBy` to point at.
 *
 * What the bump explicitly does NOT do is make the request look UNREAD:
 * entries are excluded from `countUnreadByRequest` and `markRead`, so the
 * recency stamp moves and the badge does not.
 *
 * SENDER-ONLY kinds ({@link SENDER_ONLY_SYSTEM_ENTRY_KINDS}) do NOT bump it:
 * the stamp is visible to the venue side too, and a recency move with no
 * visible entry behind it would leak that something the venue must not see
 * (a declined act) happened on the booking.
 *
 * No audit row is written here. The emitters already audit their own
 * transitions (`booking_agreement.pulled_back` etc.); a second row per
 * transition would duplicate the audit trail, and the ledger is a
 * user-facing surface, not a replacement for it.
 *
 * Throws `{ code: "invalid_input" }` (via `parseInput`) when `data` does not
 * match the kind's schema — a programmer error, surfaced at the write rather
 * than as an unrenderable row discovered by a reader months later.
 */
export async function appendBookingSystemEntry<
  // P3a: a RETIRED kind is readable, never writable (compile-time half).
  K extends WritableBookingSystemEntryKind,
>(
  tx: TxRepos,
  input: AppendBookingSystemEntryInput<K>,
): Promise<BookingRequestMessageRow> {
  // P3a: the runtime half, for a caller that widened the kind past the type.
  if (isRetiredSystemEntry(input.kind)) {
    throw fail("INVALID_INPUT", {
      message: "retired_system_entry_kind",
      meta: { kind: input.kind },
    });
  }
  const schema = BOOKING_SYSTEM_ENTRY_SCHEMAS[input.kind];
  // Validated payload, not the caller's object: `.strict()` guarantees no
  // extra keys, and parsing normalizes what actually lands in the column.
  const data = parseInput(schema, input.data) as Record<string, unknown>;

  const entry = await messagesIn(tx).create({
    bookingRequestId: input.bookingRequestId,
    // SYSTEM regardless of who caused it — see `actorHumanId` above.
    authorSide: "SYSTEM",
    authorHumanId: input.actorHumanId ?? null,
    // The sentence is rendered from kind + params; nothing is stored.
    body: "",
    systemKind: input.kind,
    systemData: data,
  });

  // SAME transaction as the append — port mandate. `entry.createdAt` (the
  // DB-assigned stamp) is the bump value, mirroring `postBookingRequestMessage`
  // so a human message and an entry order identically in the inbox. Skipped
  // for sender-only kinds (see the doc above).
  if (!isSenderOnlySystemEntry(input.kind)) {
    await tx.bookingRequests.touchLastMessageAt({
      id: input.bookingRequestId,
      at: entry.createdAt,
    });
  }

  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Side visibility
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ledger kinds that are VENUE-INTERNAL workflow, never part of the
 * conversation with the act. `list-messages` drops them for the PERFORMER
 * side (the gate lives with the data, not the renderer). Extend deliberately;
 * everything else in the ledger is by design visible to both parties.
 */
export const VENUE_INTERNAL_SYSTEM_ENTRY_KINDS = [
  // booking-holds FR-015: who on the venue side owns the request.
  "booking_request.assigned",
  // booking-the-night FR-001: the sender's agree was refused (the night went
  // elsewhere, the request's event is on another day or was cancelled or
  // archived, or the place is not taking bookings) — the venue's cue to act.
  "booking_agreement.agree_refused",
  // booking-the-night P2c (review carry e): the agree booked the night but
  // its event was not created — the venue's cue to use "Create event".
  "booking_agreement.event_not_created",
  // ── booking-the-night P2d-2 ──
  // N20 / FR-015: the ready request moved up to 1st hold — "Send terms".
  "booking_hold.first_ready",
] as const satisfies readonly BookingSystemEntryKind[];

export function isVenueInternalSystemEntry(systemKind: string | null): boolean {
  return (
    systemKind !== null &&
    (VENUE_INTERNAL_SYSTEM_ENTRY_KINDS as readonly string[]).includes(
      systemKind,
    )
  );
}

/**
 * The mirror of {@link VENUE_INTERNAL_SYSTEM_ENTRY_KINDS}: ledger kinds only
 * the SENDER side may see. `list-messages` drops them for the VENUE side, and
 * `appendBookingSystemEntry` does not bump `lastMessageAt` for them.
 */
export const SENDER_ONLY_SYSTEM_ENTRY_KINDS = [
  // lineup v2 FR-004: a declined act is hidden from every venue-facing render.
  "booking_request.act_declined",
] as const satisfies readonly BookingSystemEntryKind[];

export function isSenderOnlySystemEntry(systemKind: string | null): boolean {
  return (
    systemKind !== null &&
    (SENDER_ONLY_SYSTEM_ENTRY_KINDS as readonly string[]).includes(systemKind)
  );
}

// ── P3b (asks) ──
/**
 * Ledger kinds for the two PARTIES only — the venue side and the sender side.
 * `list-messages` drops them for a read-only ACT on the bill: asks and their
 * answers (files, links, a set length) are the venue's and the sender's
 * business, like the attachments the ACT cannot list either
 * (venue-booking-standards v1.1 FR-009b: "visible to VENUE and PERFORMER").
 */
export const PARTIES_ONLY_SYSTEM_ENTRY_KINDS = [
  "booking_request.ask_opened",
  "booking_request.ask_answered",
  "booking_request.ask_withdrawn",
] as const satisfies readonly BookingSystemEntryKind[];

export function isPartiesOnlySystemEntry(systemKind: string | null): boolean {
  return (
    systemKind !== null &&
    (PARTIES_ONLY_SYSTEM_ENTRY_KINDS as readonly string[]).includes(systemKind)
  );
}

// ── P3a (unclaimed venues) ──
// ─────────────────────────────────────────────────────────────────────────────
// Retired kinds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ledger kinds that stay READABLE (old rows still render, their schemas stay
 * in the map) but are never WRITTEN again. `appendBookingSystemEntry` refuses
 * them at compile time ({@link WritableBookingSystemEntryKind}) and at run
 * time. Parking went with the 2026-09-25 amendment: an unclaimed venue takes
 * no requests, so nothing is parked or unparked any more.
 */
export const RETIRED_BOOKING_SYSTEM_ENTRY_KINDS = [
  "booking_request.parked_unclaimed",
  "booking_request.unparked",
] as const satisfies readonly BookingSystemEntryKind[];

export type RetiredBookingSystemEntryKind =
  (typeof RETIRED_BOOKING_SYSTEM_ENTRY_KINDS)[number];

/** Every kind a writer may append. */
export type WritableBookingSystemEntryKind = Exclude<
  BookingSystemEntryKind,
  RetiredBookingSystemEntryKind
>;

export function isRetiredSystemEntry(systemKind: string | null): boolean {
  return (
    systemKind !== null &&
    (RETIRED_BOOKING_SYSTEM_ENTRY_KINDS as readonly string[]).includes(
      systemKind,
    )
  );
}
