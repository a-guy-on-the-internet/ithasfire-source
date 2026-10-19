import type { CursorResult } from "./follows";

/**
 * Which side of a booking-request thread authored a message
 * (booking-conversation-and-event-step FR-001). SYSTEM rows are
 * platform-generated LEDGER ENTRIES — see {@link BookingSystemEntryKind}.
 */
export type BookingMessageAuthorSide = "VENUE" | "PERFORMER" | "SYSTEM";

/**
 * A human party to the thread — the two sides that can READ it. SYSTEM
 * authors messages but never reads, so read-receipt inputs take this
 * narrower type.
 */
export type BookingThreadSide = Exclude<BookingMessageAuthorSide, "SYSTEM">;

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM entries — the booking's ledger
//
// The thread is not just a chat: it is the TIMELINE of the booking. Human
// messages interleave with SYSTEM entries recording every lifecycle
// transition, so "we hammered out the agreement, then the event appeared" is
// readable in one place.
//
// An entry is a KIND plus PARAMS, never a sentence. The sentence lives in the
// en/es i18n catalogs (which sit behind an argument-parity gate), because a
// hardcoded English string at rest is unlocalizable AND cannot carry the rich
// bits an entry needs — a link to the agreement, a link to the event, a
// locale-formatted date. `body` is therefore EMPTY on system rows.
//
// PLAIN STRING UNION, NOT A PRISMA ENUM. `BookingRequestMessage.systemKind` is
// a TEXT column validated in app code — the house style already stated on
// `ImageModerationRecord.kind` / `.status`, `PendingObjectDeletion.status` and
// `Settlement.status`. That keeps the taxonomy here, in code, where it can grow
// without a migration.
//
// HOLDS (booking-holds spec 2026-08-25) landed as the pure data addition the
// deferral promised: the `booking_hold.*` kinds below plus their zod schemas
// in the core schema map. No migration, no column.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every system-entry kind, namespaced by the aggregate whose transition it
 * records. The array is the source of truth; {@link BookingSystemEntryKind} is
 * derived from it, and the core schema map is keyed by it exhaustively, so a
 * kind cannot exist without a params schema.
 *
 * Names deliberately mirror the audit-log vocabulary already used by the
 * emitting use cases (`booking_request.accepted`,
 * `booking_agreement.pulled_back`, …) — one word for one transition across
 * the audit trail and the ledger.
 */
export const BOOKING_SYSTEM_ENTRY_KINDS = [
  // ── Request lifecycle ──────────────────────────────────────────────────────
  /** The request was submitted (`createBookingRequest` / organizer variant). */
  "booking_request.opened",
  /** The receiving side opened it for the first time. */
  "booking_request.viewed",
  /** The expiry sweep aged it out — machine-caused, no actor human. */
  "booking_request.expired",
  /** The sender pulled the request itself. */
  "booking_request.withdrawn",
  /** The receiving side said yes (may mint an agreement). */
  "booking_request.accepted",
  /** The receiving side said no. */
  "booking_request.declined",
  /**
   * The venue-internal assignee changed (booking-holds FR-015). Carries the
   * previous assignee so the copy can say "reassigned from Dana to Sam".
   */
  "booking_request.assigned",
  /**
   * RETIRED (amendment 2026-09-25: unclaimed venues take no requests) —
   * kept READABLE for old rows, never written again (see
   * `RETIRED_BOOKING_SYSTEM_ENTRY_KINDS` in core). The request arrived at an
   * UNCLAIMED place and was parked until someone claimed the venue.
   */
  "booking_request.parked_unclaimed",
  /**
   * RETIRED with `parked_unclaimed` — readable, never written. The place was
   * claimed; the parked request went live for the new owner.
   */
  "booking_request.unparked",
  // ── P3a (unclaimed venues) ──
  /**
   * A request parked at an unclaimed venue before the 2026-09-25 amendment
   * was expired by the one-off cleanup (`expireParkedBookingRequests`). The
   * ONE note its sender gets: "{place} isn't on Ithas Fire yet, so this
   * request can't reach them." Carries a place-name snapshot. Machine-caused.
   */
  "booking_request.expired_unclaimed",
  /**
   * A tagged artist confirmed their spot on the bill (lineup-booking-requests
   * v2, FR-003). Carries the act id and a display-name snapshot.
   */
  "booking_request.act_confirmed",
  /** A tagged artist declined their spot on the bill (terminal on this request). */
  "booking_request.act_declined",
  /**
   * The sender changed the bill — added, removed and/or reordered acts
   * (lineup-booking-requests v3, FR-009). ONE entry per edit call. Visible
   * to both sides; the params are written venue-safe (see the schema).
   */
  "booking_request.bill_changed",
  /**
   * An act joined after the event existed and landed on its lineup by itself
   * (v3 FR-010, L4). Visible to both sides.
   */
  "booking_request.act_joined_lineup",
  /**
   * The venue closed an ACCEPTED request before its night was booked, with
   * a reason (booking-the-night FR-010, N14). Visible to both sides. Before
   * accept, the venue's "no" stays `booking_request.declined`. Rows written
   * before 2026-10-18 carry the old spelling; core's read boundary
   * (`lib/legacy-place-values`) normalises them to this one.
   */
  "booking_request.closed_by_place",
  /**
   * A booked night was cancelled — terms, booked hold and event together —
   * by the venue or the sender, with a reason (booking-the-night FR-009,
   * N13). Visible to both sides. The request itself stays ACCEPTED.
   */
  "booking_request.booking_cancelled",
  // ── P3b (asks) ──
  /**
   * The venue asked the sender for something the night needs (a poster, a
   * rider, a set length — venue-booking-standards v1.1 V9, FR-009). Visible
   * to the VENUE and PERFORMER sides; never to a read-only ACT.
   */
  "booking_request.ask_opened",
  /** The sender answered (or replaced the answer to) an ask. Parties only. */
  "booking_request.ask_answered",
  /** The venue took back an ask that was still open. Parties only. */
  "booking_request.ask_withdrawn",

  // ── Holds (booking-holds spec 2026-08-25) ─────────────────────────────────
  // A BookingHold is its own table hanging off the request; every transition
  // lands on the request's thread. Names mirror the audit vocabulary
  // (`booking_hold.placed` …) — one word per transition, never a sentence.
  /** Staff placed a hold at the end of the line for a calendar+date. */
  "booking_hold.placed",
  /** A hold's position in its line changed (staff reorder or a move-up). */
  "booking_hold.reordered",
  /** Staff challenged the position-1 hold; the act must keep or release. */
  "booking_hold.challenged",
  /** Staff pushed the challenge deadline later. */
  "booking_hold.extended",
  /** The act kept the hold (challenge answered: keep). */
  "booking_hold.kept",
  /** The hold left its line — manual, expired, closed request, lost date … */
  "booking_hold.released",
  /**
   * The night was booked on this hold: by the sender agreeing the terms, or
   * by the venue booking without terms (`withoutTerms`, booking-the-night
   * FR-004). The draft event is minted after commit.
   */
  "booking_hold.confirmed",
  // ── booking-the-night P2d-2 ──
  /**
   * N20 / FR-015: this request moved up to 1st hold on a night it has terms
   * ready for (the act ahead released, or its challenge lapsed) — the venue's
   * one-tap "Send terms" cue. VENUE-INTERNAL.
   */
  "booking_hold.first_ready",

  // ── Agreement negotiation ──────────────────────────────────────────────────
  /** A draft agreement was attached to the request. */
  "booking_agreement.drafted",
  /** The draft was sent to the other side for review (DRAFT → PROPOSED). */
  "booking_agreement.sent_for_review",
  /** The reviewing side countered with changes (→ COUNTERED). */
  "booking_agreement.countered",
  /** The reviewing side accepted the terms (→ ACCEPTED). */
  "booking_agreement.accepted",
  /** The reviewing side declined the terms (→ DECLINED). */
  "booking_agreement.declined",
  /** The proposing side withdrew it from review (→ DRAFT). */
  "booking_agreement.pulled_back",
  /**
   * The terms went back to the venue as a draft after the sender declined
   * them (booking-the-night N16, FR-012): request-linked terms are never
   * DECLINED, they return to DRAFT for the venue to change and resend.
   */
  "booking_agreement.returned_to_draft",
  /**
   * The sender tried to agree the terms, but the agree was refused before
   * the line moved (booking-the-night FR-001): the night had gone to someone
   * else in between (N6), the request's event is on another day, its
   * event-first origin or finalized event was cancelled or archived (N11),
   * or the place is not taking bookings. The terms stay PROPOSED.
   * VENUE-INTERNAL — the venue is told why; the sender already got the
   * refusal on their own tap.
   */
  "booking_agreement.agree_refused",
  /**
   * The sender's "Agree & book" booked the night, but the draft event was
   * not created after the commit (booking-the-night N10, FR-001): the venue
   * person who sent the terms lacks the authority, the venue org is out of
   * events, or a race / outage hit the mint. The night stays booked and the
   * terms ACCEPTED; the venue's "Create event" is the retry. VENUE-INTERNAL.
   */
  "booking_agreement.event_not_created",
  /**
   * The terms editor walked away (DRAFT | PROPOSED | ACCEPTED → CANCELLED).
   * The editor-only terminal exit; the act's own exit is `.declined`.
   */
  "booking_agreement.cancelled",
  /** A settled agreement was reopened for further edits. */
  "booking_agreement.reopened",
  /** Terms activated and the event went live off the agreement. */
  "booking_agreement.finalized",
  /**
   * The show happened: the linked event was COMPLETED, so the agreement is
   * FULFILLED. Written by `completeEvent`, the only writer of that status.
   */
  "booking_agreement.fulfilled",

  // ── Event ──────────────────────────────────────────────────────────────────
  /** An event was minted from the agreement. */
  "booking_event.created",
  /** A field the booking cares about changed on that event. */
  "booking_event.modified",
  /** The event went live (DRAFT → PUBLISHED). */
  "booking_event.published",
  /** The event was cancelled — the arc ends here. */
  "booking_event.cancelled",
  /** The event happened (PUBLISHED → COMPLETED). */
  "booking_event.completed",
  /**
   * The venue vouched for the event at its place (venue-confirmation spec,
   * docs/specs/2026-08-27): `venueConfirmed*` stamped. `ownerSide` says whose
   * event it is — the venue's own (confirmed by construction, stamped for
   * SQL-read consistency) or the requester's. Old rows are normalised to
   * this spelling at read (`lib/legacy-place-values` in core).
   */
  "booking_event.place_confirmed",
  /**
   * The venue withdrew (or declined) its confirmation, with a reason. The
   * event keeps its place and drops to address-only. Old rows are
   * normalised to this spelling at read.
   */
  "booking_event.place_confirmation_withdrawn",
] as const;

/**
 * Discriminator stored in `BookingRequestMessage.systemKind`. Null on human
 * messages.
 *
 * READ POSTURE: rows come from a database that may hold a kind this build does
 * not know (a rollback behind a newer writer). Readers must treat an
 * unrecognized kind as RENDERABLE-AS-NOTHING and skip it, never throw — which
 * is why the row type below keeps `systemKind` a plain `string`.
 */
export type BookingSystemEntryKind =
  (typeof BOOKING_SYSTEM_ENTRY_KINDS)[number];

/** Runtime membership test for {@link BookingSystemEntryKind}. */
export function isBookingSystemEntryKind(
  value: string,
): value is BookingSystemEntryKind {
  return (BOOKING_SYSTEM_ENTRY_KINDS as readonly string[]).includes(value);
}

/**
 * One message on a booking-request thread. The request IS the thread — there
 * is no separate thread row; recency is denormalized onto
 * `BookingRequest.lastMessageAt` (mirrors SupportThread.lastMessageAt).
 *
 * Two row shapes share this type: a HUMAN message (`authorSide` VENUE |
 * PERFORMER, non-empty `body`, null `systemKind`) and a SYSTEM ENTRY
 * (`authorSide` SYSTEM, empty `body`, non-null `systemKind`). It is left as
 * one flat interface rather than a discriminated union because the thread is
 * one chronologically-ordered list and every consumer pages it as such.
 */
export interface BookingRequestMessageRow {
  id: string;
  bookingRequestId: string;
  authorSide: BookingMessageAuthorSide;
  /**
   * The human who authored the message, when applicable. Null for anonymous
   * performer-side messages. A plain id, no FK relation (mirrors
   * SupportMessage.authorHumanId) — system/guest messages never couple to a
   * Human row.
   *
   * SYSTEM entries DO carry this when a human caused the transition, so the
   * copy can say "Pulled back by Dana" — the name is resolved at render time
   * from the id (the same batch `humans.getByIds` the inbox already does),
   * never snapshotted as a string that would go stale and be unlocalizable.
   * Null when nothing human caused it: the expiry sweep, a webhook, a
   * backfill. `authorSide` stays SYSTEM either way.
   */
  authorHumanId: string | null;
  /** Human message text. ALWAYS `""` on a SYSTEM entry — see the module doc. */
  body: string;
  /**
   * SYSTEM-entry discriminator; null on human messages. Typed `string` and not
   * {@link BookingSystemEntryKind} on purpose — see that type's READ POSTURE
   * note. Narrow with {@link isBookingSystemEntryKind} before switching.
   */
  systemKind: string | null;
  /**
   * The params the entry's copy interpolates; null on human messages. Shape is
   * per-kind and zod-validated ON WRITE by the single append helper in core.
   *
   * NOT re-validated on read: the column is Prisma `Json?`, which also admits
   * arrays and scalars, so the adapter's mapper guards non-object JSON to
   * `null` (typeof + Array.isArray) exactly like `CalendarRow.eventTemplate`.
   * Timestamps inside are ISO-8601 STRINGS — Json has no date type.
   */
  systemData: Record<string, unknown> | null;
  /**
   * Simple read receipt — set when the counterparty has seen the message.
   * NEVER set on a SYSTEM entry: entries are excluded from both `markRead` and
   * `countUnreadByRequest`, so this stays null on them forever.
   */
  readAt: Date | null;
  createdAt: Date;
}

export interface CreateBookingRequestMessageInput {
  bookingRequestId: string;
  authorSide: BookingMessageAuthorSide;
  authorHumanId?: string | null;
  /** Pass `""` for a SYSTEM entry — the sentence is rendered, never stored. */
  body: string;
  /**
   * SYSTEM entries only. Callers MUST NOT set these by hand: the ONLY
   * supported writer is `appendBookingSystemEntry`
   * (packages/core/src/use-cases/booking-requests/messages/_shared/system-entries.ts),
   * which validates the params against the kind's schema first. A hand-rolled
   * write can put a malformed payload on the ledger that no renderer can read.
   */
  systemKind?: BookingSystemEntryKind | null;
  systemData?: Record<string, unknown> | null;
}

export interface ListBookingRequestMessagesInput {
  bookingRequestId: string;
  cursor?: string | null;
  limit?: number;
}

export interface MarkBookingRequestMessagesReadInput {
  bookingRequestId: string;
  /**
   * The READER's side. Only the COUNTERPARTY's messages get their `readAt`
   * stamped; the reader's own messages are never touched, and neither are
   * SYSTEM entries.
   *
   * SYSTEM ENTRIES ARE NEVER STAMPED (changed with the system-entry
   * migration; previously "any other side" swept them in). An entry can never
   * be unread — see {@link CountUnreadByRequestInput.side} — so a `readAt` on
   * one would be a receipt for a state that does not exist. Leaving the column
   * null on entries keeps this method the EXACT complement of the unread count,
   * which is the invariant that stops a list badge and the thread it opens from
   * disagreeing. The alternative (stamp them but do not count them) leaves an
   * unreadable-by-definition row wearing a read receipt, which reads as a bug
   * to anyone auditing the table.
   *
   * NOTE — read state is PER-SIDE, not per-human. There is one shared `readAt`
   * per message and no per-human read table, so ANY teammate on your side
   * opening the thread stamps it for EVERYONE on that side. Accepted v1
   * trade-off; per-human read state would need its own join table.
   */
  side: BookingThreadSide;
  /** Only messages with `createdAt <= upToCreatedAt` are stamped. */
  upToCreatedAt: Date;
}

/**
 * BATCH unread-count input for a list surface (venue inbox / performer sent
 * list). One call covers the whole page — a per-row count is an N+1 and is
 * banned here for the same reason `listBookingRequests` batch-resolves display
 * names in one `humans.getByIds` + one `organizations.getByIds`.
 */
export interface CountUnreadByRequestInput {
  /**
   * The requests on the page. An EMPTY array is a valid, common input (an
   * empty inbox) and must short-circuit to an empty result WITHOUT a query.
   *
   * THESE IDS MUST ALREADY BE AUTHORIZED BY THE CALLER. This repo performs NO
   * tenancy check — it never loads the request row, so it will happily count
   * (and thereby confirm the existence of) ANY request's messages, for any
   * org. Derive them from an already-gated list (see `resolveUnreadCounts` in
   * `list-booking-requests.ts`, which maps ids off records the scope's authz
   * gate already returned), NEVER from client input. A procedure that accepted
   * ids over the wire and passed them straight here would be a cross-org IDOR
   * oracle with no org check anywhere in the path.
   */
  bookingRequestIds: string[];
  /**
   * The VIEWER's side — the mirror image of
   * {@link MarkBookingRequestMessagesReadInput}. Unread = messages authored by
   * the COUNTERPARTY whose `readAt` is still null.
   *
   * SYSTEM ENTRIES NEVER COUNT AS UNREAD. Product decision, and a reversal of
   * the original `authorSide != side` rule: UNREAD MEANS "A HUMAN IS WAITING ON
   * YOU". Under the old rule the ledger lit up its own author's inbox — you
   * accept your own agreement, the platform logs
   * `booking_agreement.accepted`, and the badge on the OTHER side (and yours,
   * once entries flowed) claims unread mail nobody sent. With every lifecycle
   * transition about to become an entry, that badge would have been noise
   * within a day.
   *
   * PER-SIDE, NOT PER-HUMAN — the same v1 trade-off spelled out on the
   * mark-read input, kept identical so the badge can never disagree with what
   * mark-read stamps. There is one shared `readAt` per message, so any
   * teammate on your side opening the thread drops the count to 0 for everyone
   * on that side.
   *
   * Note the enum's `VENUE` slot means "the non-act party" in BOTH directions
   * (TO_VENUE: the place's owners/staff; TO_PERFORMER: the sender organizer
   * org), so the organizer sent-list viewer is `VENUE`, not `PERFORMER`.
   */
  side: BookingThreadSide;
}

/**
 * "Has this request's ledger already recorded `kind`?" — the at-most-once
 * guard for entries whose transition is not itself idempotent.
 *
 * ONLY meaningful for kinds a booking can legitimately record at most once
 * (`booking_request.expired`, `.withdrawn`, `.accepted`, `.declined`). Plenty
 * of kinds repeat by design — `booking_request.viewed`,
 * `booking_agreement.sent_for_review` / `.pulled_back` / `.countered`,
 * `booking_event.modified` — and asking this about one of those and skipping
 * on `true` would silently drop real history. That asymmetry is exactly why
 * there is NO blanket `UNIQUE (bookingRequestId, systemKind)` constraint.
 */
export interface HasBookingSystemEntryInput {
  bookingRequestId: string;
  kind: BookingSystemEntryKind;
  /**
   * Narrow to entries whose `systemData` has EVERY listed top-level key equal
   * to the given string (booking-the-night P2d-2: "was THIS challenge of
   * THIS hold already kept?" — `{ holdId, challengedAt }`). Omitted = any
   * entry of the kind. This is how a repeatable kind gets an at-most-once
   * question scoped to one occurrence, without a blanket constraint.
   */
  dataMatch?: Readonly<Record<string, string>>;
}

export type { CursorResult };
