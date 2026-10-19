import { describe, expect, it, vi } from "vitest";

import {
  BOOKING_SYSTEM_ENTRY_KINDS,
  isBookingSystemEntryKind,
} from "@th/ports/repos/booking-request-messages";
import type { TxRepos } from "@th/ports/repos";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import {
  BOOKING_SYSTEM_ENTRY_SCHEMAS,
  SENDER_ONLY_SYSTEM_ENTRY_KINDS,
  VENUE_INTERNAL_SYSTEM_ENTRY_KINDS,
  RETIRED_BOOKING_SYSTEM_ENTRY_KINDS,
  appendBookingSystemEntry,
  isRetiredSystemEntry,
  isSenderOnlySystemEntry,
  // ── P3b (asks) ──
  isPartiesOnlySystemEntry,
} from "../messages/_shared/system-entries";
import { AGREEMENT_ID, ACTOR_ID, REQUEST_ID } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// `appendBookingSystemEntry` — the one writer of the booking ledger (step 1:
// schema + contract; nothing emits entries yet).
//
// What is worth pinning here is the CONTRACT, not "it inserts a row":
//   - params are validated PER KIND, so a malformed payload can never reach a
//     column no renderer can read;
//   - the entry and the `lastMessageAt` bump happen in the SAME transaction the
//     caller is already in — the ledger must not disagree with the state it
//     records, and an entry must move the request up the inbox;
//   - an entry never counts as unread (the owner decision).
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function buildTx() {
  const messages = createFakeBookingRequestMessagesRepo();
  const touched: Array<{ id: string; at: Date }> = [];
  const bookingRequests = {
    touchLastMessageAt: vi.fn(async (input: { id: string; at: Date }) => {
      touched.push(input);
    }),
  };
  const tx = {
    bookingRequestMessages: messages,
    bookingRequests,
  } as unknown as TxRepos;
  return { tx, messages, bookingRequests, touched };
}

describe("BOOKING_SYSTEM_ENTRY_SCHEMAS", () => {
  it("has a schema for every kind, and no schema without a kind", () => {
    // The `satisfies Record<BookingSystemEntryKind, …>` on the map makes this a
    // compile-time guarantee; asserted at runtime too so a widened type
    // annotation can never quietly re-open the gap.
    expect(Object.keys(BOOKING_SYSTEM_ENTRY_SCHEMAS).sort()).toEqual(
      [...BOOKING_SYSTEM_ENTRY_KINDS].sort(),
    );
  });

  it("covers the request, agreement and event families the timeline needs", () => {
    // Guards against a kind being deleted in a refactor: these are the
    // transitions the product asked to see on the thread.
    for (const kind of [
      "booking_request.opened",
      "booking_request.viewed",
      "booking_request.expired",
      "booking_request.withdrawn",
      "booking_request.accepted",
      "booking_request.declined",
      "booking_agreement.drafted",
      "booking_agreement.sent_for_review",
      "booking_agreement.countered",
      "booking_agreement.accepted",
      "booking_agreement.declined",
      "booking_agreement.pulled_back",
      "booking_agreement.cancelled",
      "booking_agreement.reopened",
      "booking_agreement.finalized",
      "booking_agreement.fulfilled",
      "booking_event.created",
      "booking_event.modified",
      "booking_event.published",
      "booking_event.cancelled",
      "booking_event.completed",
      // booking-holds spec 2026-08-25 — the deferred seam, now filled.
      "booking_request.assigned",
      "booking_hold.placed",
      "booking_hold.reordered",
      "booking_hold.challenged",
      "booking_hold.extended",
      "booking_hold.kept",
      "booking_hold.released",
      "booking_hold.confirmed",
      // venue-confirmation spec 2026-08-27 — confirm / withdraw on the event.
      "booking_event.place_confirmed",
      "booking_event.place_confirmation_withdrawn",
      // venue-confirmation spec 2026-08-27 — unclaimed-venue parking.
      // RETIRED by the 2026-09-25 amendment: readable, never written.
      "booking_request.parked_unclaimed",
      "booking_request.unparked",
      // ── P3a (unclaimed venues) ── the parked-request cleanup's one note.
      "booking_request.expired_unclaimed",
      // lineup-booking-requests v2 — a tagged act answers its spot.
      "booking_request.act_confirmed",
      "booking_request.act_declined",
      // lineup-booking-requests v3 — the sender edits the bill; a late join
      // lands on the event lineup.
      "booking_request.bill_changed",
      "booking_request.act_joined_lineup",
      // booking-the-night — the venue closes an accepted request, a booked
      // night is cancelled, declined terms go back to draft.
      "booking_request.closed_by_place",
      "booking_request.booking_cancelled",
      "booking_agreement.returned_to_draft",
      // booking-the-night P2b — the sender's agree was refused (venue-only).
      "booking_agreement.agree_refused",
      // booking-the-night P2c — the agree booked the night, the event was not
      // created (venue-only).
      "booking_agreement.event_not_created",
      // ── booking-the-night P2d-2 — the ready request moved up to 1st hold
      // ("Send terms", venue-only).
      "booking_hold.first_ready",
    ]) {
      expect(isBookingSystemEntryKind(kind)).toBe(true);
    }
    // Forty-three kinds and no more — a stray addition shows up here, not in prod.
    expect(BOOKING_SYSTEM_ENTRY_KINDS).toHaveLength(
      43 +
        // ── P3a (unclaimed venues) ── booking_request.expired_unclaimed
        1 +
        // ── P3b (asks) ── ask_opened, ask_answered, ask_withdrawn
        3,
    );
  });

  // ── P3b (asks) ──
  describe("ask kinds (venue-booking-standards v1.1 FR-009b)", () => {
    const ASK_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    it("are known kinds, visible to the parties only", () => {
      for (const kind of [
        "booking_request.ask_opened",
        "booking_request.ask_answered",
        "booking_request.ask_withdrawn",
      ]) {
        expect(isBookingSystemEntryKind(kind)).toBe(true);
        expect(isPartiesOnlySystemEntry(kind)).toBe(true);
      }
      expect(isPartiesOnlySystemEntry("booking_request.opened")).toBe(false);
    });
    it("take the copied label and the kind; answered says whether it replaced", () => {
      const opened = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.ask_opened"];
      expect(opened.safeParse({ askId: ASK_ID, kind: "IMAGE", label: "Poster" }).success).toBe(true);
      expect(opened.safeParse({ askId: ASK_ID, kind: "POSTER", label: "Poster" }).success).toBe(false);
      expect(opened.safeParse({ askId: ASK_ID, kind: "IMAGE", label: "" }).success).toBe(false);
      expect(opened.safeParse({ askId: ASK_ID, kind: "IMAGE", label: "x".repeat(81) }).success).toBe(false);
      const answered = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.ask_answered"];
      expect(answered.safeParse({ askId: ASK_ID, kind: "SET_LENGTH", label: "Set length", replaced: true }).success).toBe(true);
      expect(answered.safeParse({ askId: ASK_ID, kind: "SET_LENGTH", label: "Set length" }).success).toBe(false);
    });
  });

  describe("booking_request.bill_changed (lineup v3 FR-009)", () => {
    const schema = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.bill_changed"];
    const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    const entry = (over: Record<string, unknown>) => ({
      added: [],
      removed: [],
      otherRemovedCount: 0,
      reordered: false,
      roleChanged: false,
      ...over,
    });

    it("accepts added acts whose state matches their source, and a reorder flag", () => {
      expect(
        schema.safeParse(
          entry({
            added: [
              { actId: ACT_ID, name: "Maren Sky", source: "TAGGED", state: "invited" },
              { actId: ACT_ID, name: "Junco", source: "EXTERNAL", state: "by_name" },
              { actId: ACT_ID, name: "Hollow Bones", source: "SELF", state: "joined" },
            ],
            reordered: true,
          }),
        ).success,
      ).toBe(true);
    });

    it("never records a TAGGED add as joined (a re-added act is invited again)", () => {
      // NFR-002 invariant 1: restoreAct returns a TAGGED row to PENDING, so
      // the only honest state for any TAGGED add is `invited`.
      for (const [source, state] of [
        ["TAGGED", "joined"],
        ["TAGGED", "by_name"],
        ["SELF", "invited"],
        ["EXTERNAL", "joined"],
      ] as const) {
        expect(
          schema.safeParse(
            entry({ added: [{ actId: ACT_ID, name: "Della", source, state }] }),
          ).success,
        ).toBe(false);
      }
      // A passed act is never ADDED (a pass is final).
      expect(
        schema.safeParse(
          entry({
            added: [{ actId: ACT_ID, name: "Della", source: "TAGGED", state: "passed" }],
          }),
        ).success,
      ).toBe(false);
    });

    it("removed[] holds only acts the venue saw as present, named", () => {
      for (const wasState of ["joined", "by_name"] as const) {
        expect(
          schema.safeParse(entry({ removed: [{ name: "Paper Moth", wasState }] })).success,
        ).toBe(true);
      }
      // NFR-002 invariant 3: no `invited` / `passed` marker can be written to
      // the venue-visible entry at all — named or not.
      for (const wasState of ["invited", "passed"] as const) {
        expect(
          schema.safeParse(entry({ removed: [{ name: "Della", wasState }] })).success,
        ).toBe(false);
        expect(
          schema.safeParse(entry({ removed: [{ name: null, wasState }] })).success,
        ).toBe(false);
      }
      // A nameless removal is not a row shape either.
      expect(
        schema.safeParse(entry({ removed: [{ name: null, wasState: "joined" }] })).success,
      ).toBe(false);
    });

    it("counts removed INVITED acts opaquely; the count is the only trace", () => {
      expect(schema.safeParse(entry({ otherRemovedCount: 2 })).success).toBe(true);
      expect(schema.safeParse(entry({ otherRemovedCount: -1 })).success).toBe(false);
      expect(schema.safeParse(entry({ otherRemovedCount: 1.5 })).success).toBe(false);
      expect(schema.safeParse(entry({ otherRemovedCount: 13 })).success).toBe(false);
    });

    it("refuses an entry with nothing venue-visible (e.g. only passed acts removed)", () => {
      // Removing a passed act is not a change to the venue's bill; an empty
      // entry would still tell the venue that something happened.
      expect(schema.safeParse(entry({})).success).toBe(false);
    });

    it("records a role-only edit with the bare roleChanged flag (v3 L13)", () => {
      // A role change on an act the venue sees is a visible change on its
      // own — no names, no ids: the bill read already shows the new role.
      expect(schema.safeParse(entry({ roleChanged: true })).success).toBe(true);
      // The flag is part of the contract: an emitter must always say.
      const { roleChanged: _omit, ...withoutFlag } = entry({ reordered: true });
      expect(schema.safeParse(withoutFlag).success).toBe(false);
      expect(schema.safeParse(entry({ roleChanged: "yes" })).success).toBe(false);
    });

    it("is strict and bounded", () => {
      // No act id on a removed row.
      expect(
        schema.safeParse(
          entry({ removed: [{ name: "Paper Moth", wasState: "joined", actId: ACT_ID }] }),
        ).success,
      ).toBe(false);
      expect(schema.safeParse(entry({ reordered: true, reason: "x" })).success).toBe(false);
      expect(
        schema.safeParse(
          entry({
            added: [
              { actId: ACT_ID, name: "x".repeat(121), source: "EXTERNAL", state: "by_name" },
            ],
          }),
        ).success,
      ).toBe(false);
      expect(
        schema.safeParse({ added: [], removed: [], reordered: true, roleChanged: false }).success,
      ).toBe(false);
    });

    it("is visible to both sides (neither venue-internal nor sender-only)", () => {
      expect(
        VENUE_INTERNAL_SYSTEM_ENTRY_KINDS as readonly string[],
      ).not.toContain("booking_request.bill_changed");
      expect(isSenderOnlySystemEntry("booking_request.bill_changed")).toBe(false);
    });
  });

  describe("booking_request.act_joined_lineup (lineup v3 FR-010)", () => {
    const schema =
      BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.act_joined_lineup"];
    const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    it("carries the act, the event and the act's name snapshot, nothing else", () => {
      expect(
        schema.safeParse({ actId: ACT_ID, eventId: EVENT_ID, actName: "Della" }).success,
      ).toBe(true);
      // The name is required (the renderer must not need a join) and bounded.
      expect(schema.safeParse({ actId: ACT_ID, eventId: EVENT_ID }).success).toBe(false);
      expect(
        schema.safeParse({ actId: ACT_ID, eventId: EVENT_ID, actName: "" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ actId: ACT_ID, eventId: EVENT_ID, actName: "x".repeat(121) }).success,
      ).toBe(false);
      expect(schema.safeParse({ actId: ACT_ID, actName: "Della" }).success).toBe(false);
      expect(
        schema.safeParse({ actId: ACT_ID, eventId: EVENT_ID, actName: "Della", role: "DJ" }).success,
      ).toBe(false);
    });

    it("is visible to both sides", () => {
      expect(
        VENUE_INTERNAL_SYSTEM_ENTRY_KINDS as readonly string[],
      ).not.toContain("booking_request.act_joined_lineup");
      expect(isSenderOnlySystemEntry("booking_request.act_joined_lineup")).toBe(false);
    });
  });

  it("validates the act confirm / decline payload shape", () => {
    const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    for (const kind of [
      "booking_request.act_confirmed",
      "booking_request.act_declined",
    ] as const) {
      const schema = BOOKING_SYSTEM_ENTRY_SCHEMAS[kind];
      expect(schema.safeParse({ actId: ACT_ID, actName: "The Weeds" }).success).toBe(true);
      // Bounded like BookingRequestAct.externalName.
      expect(schema.safeParse({ actId: ACT_ID, actName: "x".repeat(120) }).success).toBe(true);
      expect(schema.safeParse({ actId: ACT_ID, actName: "x".repeat(121) }).success).toBe(false);
      // An empty snapshot would render "confirmed their spot" with no subject.
      expect(schema.safeParse({ actId: ACT_ID, actName: "" }).success).toBe(false);
      expect(schema.safeParse({ actId: "not-a-uuid", actName: "The Weeds" }).success).toBe(false);
      expect(schema.safeParse({ actId: ACT_ID }).success).toBe(false);
      // .strict(): nothing else rides either entry.
      expect(
        schema.safeParse({ actId: ACT_ID, actName: "The Weeds", note: "busy" }).success,
      ).toBe(false);
    }
  });

  it("a join carries no reason; a pass carries its reason and whether it was a LEAVE (v3 L19, sender-only)", () => {
    const ACT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const confirmed = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.act_confirmed"];
    const declined = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.act_declined"];
    // A join has nothing to explain.
    expect(
      confirmed.safeParse({ actId: ACT_ID, actName: "The Weeds", reason: "busy" }).success,
    ).toBe(false);
    // A pass: the reason (bounded like BookingRequestAct.declineReason) and
    // the leave marker, both optional.
    expect(
      declined.safeParse({ actId: ACT_ID, actName: "The Weeds", reason: "busy" }).success,
    ).toBe(true);
    expect(
      declined.safeParse({ actId: ACT_ID, actName: "The Weeds", reason: "x".repeat(240), left: true })
        .success,
    ).toBe(true);
    expect(
      declined.safeParse({ actId: ACT_ID, actName: "The Weeds", reason: "x".repeat(241) }).success,
    ).toBe(false);
    // An empty reason is "none" — the emitter omits it rather than writing "".
    expect(
      declined.safeParse({ actId: ACT_ID, actName: "The Weeds", reason: "" }).success,
    ).toBe(false);
    expect(
      declined.safeParse({ actId: ACT_ID, actName: "The Weeds", left: false }).success,
    ).toBe(false);
    // The entry stays SENDER-ONLY: the venue never reads a pass or its reason.
    expect(isSenderOnlySystemEntry("booking_request.act_declined")).toBe(true);
  });

  it("landed the hold family as the pure data addition the seam promised", () => {
    // No migration, no column: `systemKind` is TEXT, so the hold kinds are
    // tuple entries + zod schemas and nothing else.
    expect(isBookingSystemEntryKind("booking_hold.placed")).toBe(true);
    expect(isBookingSystemEntryKind("booking_hold.converted")).toBe(false);
  });

  it("validates every hold / assignment payload shape", () => {
    const HOLD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const CAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const ok = (kind: keyof typeof BOOKING_SYSTEM_ENTRY_SCHEMAS, data: unknown) =>
      BOOKING_SYSTEM_ENTRY_SCHEMAS[kind].safeParse(data).success;

    expect(ok("booking_hold.placed", { holdId: HOLD_ID, date: "2026-10-13", position: 2 })).toBe(true);
    // A Date (or a datetime) is not a calendar day.
    expect(ok("booking_hold.placed", { holdId: HOLD_ID, date: "2026-10-13T00:00:00.000Z", position: 1 })).toBe(false);
    expect(ok("booking_hold.placed", { holdId: HOLD_ID, date: "2026-10-13", position: 0 })).toBe(false);
    expect(ok("booking_hold.reordered", { holdId: HOLD_ID, from: 3, to: 1 })).toBe(true);
    // ISO STRING, never a Date — Json column rule.
    expect(ok("booking_hold.challenged", { holdId: HOLD_ID, respondBy: "2026-10-12T19:00:00.000Z" })).toBe(true);
    expect(ok("booking_hold.challenged", { holdId: HOLD_ID, respondBy: new Date() })).toBe(false);
    expect(ok("booking_hold.extended", { holdId: HOLD_ID, respondBy: "2026-10-12T19:00:00.000Z" })).toBe(true);
    expect(ok("booking_hold.kept", { holdId: HOLD_ID })).toBe(true);
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "CONFIRMED_OTHER" })).toBe(true);
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "because" })).toBe(false);
    // `by` is optional (pre-field rows stay valid) and closed to act | staff.
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL", by: "act" })).toBe(true);
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL", by: "staff" })).toBe(true);
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL", by: "place" })).toBe(false);
    expect(ok("booking_hold.released", { holdId: HOLD_ID, reason: "MANUAL", by: null })).toBe(false);
    expect(ok("booking_hold.confirmed", { holdId: HOLD_ID, eventId: null })).toBe(true);
    // ── booking-the-night P2d-2 ── a keep with no terms sent records its
    // deadline and the challenge it answers; the old shape stays valid.
    expect(ok("booking_hold.kept", { holdId: HOLD_ID })).toBe(true);
    expect(ok("booking_hold.kept", { holdId: HOLD_ID, respondBy: "2026-06-12T12:00:00.000Z", challengedAt: "2026-06-10T11:00:00.000Z" })).toBe(true);
    expect(ok("booking_hold.kept", { holdId: HOLD_ID, respondBy: "soon" })).toBe(false);
    expect(ok("booking_hold.first_ready", { holdId: HOLD_ID, date: "2026-06-20", agreementId: HOLD_ID })).toBe(true);
    expect(ok("booking_hold.first_ready", { holdId: HOLD_ID, date: "2026-06-20" })).toBe(false);
    expect(ok("booking_hold.confirmed", { holdId: HOLD_ID })).toBe(false);
    expect(ok("booking_request.assigned", { assigneeHumanId: ACTOR_ID, previousAssigneeHumanId: null })).toBe(true);
    expect(ok("booking_request.assigned", { assigneeHumanId: null, previousAssigneeHumanId: ACTOR_ID })).toBe(true);
    // .strict(): an unread field never lands on the ledger.
    expect(ok("booking_request.assigned", { assigneeHumanId: null, previousAssigneeHumanId: null, name: "Dana" })).toBe(false);
  });
});

describe("appendBookingSystemEntry", () => {
  it("writes a SYSTEM entry with an empty body and the validated params", async () => {
    const { tx, messages } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_agreement.countered",
      data: { agreementId: AGREEMENT_ID, actorSide: "PLACE" },
      actorHumanId: ACTOR_ID,
    });

    expect(entry.authorSide).toBe("SYSTEM");
    expect(entry.systemKind).toBe("booking_agreement.countered");
    expect(entry.systemData).toEqual({
      agreementId: AGREEMENT_ID,
      actorSide: "PLACE",
    });
    // The sentence is rendered from kind + params through the i18n catalogs —
    // storing English here would be unlocalizable.
    expect(entry.body).toBe("");
    expect(messages.rows.size).toBe(1);
  });

  it("records the human who caused the transition, while staying SYSTEM-sided", async () => {
    const { tx } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_agreement.pulled_back",
      data: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" },
      actorHumanId: ACTOR_ID,
    });

    // "Pulled back by Dana" needs the id; the name is resolved at render time.
    expect(entry.authorHumanId).toBe(ACTOR_ID);
    // …but the row is still a platform notice, which is what keeps it out of
    // unread counts and out of mine/theirs bubble alignment.
    expect(entry.authorSide).toBe("SYSTEM");
  });

  it("leaves authorHumanId null for machine-caused entries", async () => {
    const { tx } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.expired",
      data: { expiresAt: "2026-06-24T12:00:00.000Z" },
    });

    expect(entry.authorHumanId).toBeNull();
  });

  it("bumps lastMessageAt in the SAME transaction, with the entry's own stamp", async () => {
    const { tx, bookingRequests, touched } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.viewed",
      data: {},
    });

    // An entry IS activity: a thread whose only recent event was "the
    // agreement was accepted" must not look stale in the inbox. Port mandate —
    // the bump is a separate call on the booking-requests repo, in this tx.
    expect(bookingRequests.touchLastMessageAt).toHaveBeenCalledTimes(1);
    expect(touched).toEqual([{ id: REQUEST_ID, at: entry.createdAt }]);
  });

  it("does NOT bump lastMessageAt for a sender-only kind (act_declined)", async () => {
    // The stamp is visible to the venue side; a recency move with no visible
    // entry behind it would leak that a declined act happened (FR-004).
    const { tx, messages, bookingRequests } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.act_declined",
      data: { actId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", actName: "Nope Band" },
    });

    expect(entry.systemKind).toBe("booking_request.act_declined");
    expect(messages.rows.size).toBe(1);
    expect(bookingRequests.touchLastMessageAt).not.toHaveBeenCalled();
  });

  it("still bumps lastMessageAt for act_confirmed (visible to both sides)", async () => {
    const { tx, bookingRequests } = buildTx();

    await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.act_confirmed",
      data: { actId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", actName: "The Weeds" },
    });

    expect(bookingRequests.touchLastMessageAt).toHaveBeenCalledTimes(1);
  });

  it("sender-only and venue-internal kinds are disjoint, and act_declined is sender-only", () => {
    expect(SENDER_ONLY_SYSTEM_ENTRY_KINDS).toEqual(["booking_request.act_declined"]);
    expect(isSenderOnlySystemEntry("booking_request.act_declined")).toBe(true);
    expect(isSenderOnlySystemEntry("booking_request.act_confirmed")).toBe(false);
    expect(isSenderOnlySystemEntry(null)).toBe(false);
    for (const kind of SENDER_ONLY_SYSTEM_ENTRY_KINDS) {
      expect(VENUE_INTERNAL_SYSTEM_ENTRY_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it("never opens a transaction of its own (it joins the caller's)", async () => {
    // The emitters in step 2 call this from INSIDE their transition tx so the
    // ledger and the state it records commit together. Proven structurally:
    // the helper is handed a TxRepos with NO `tx` at all and still succeeds —
    // if it ever reached for `repos.tx()` this would throw.
    const { tx } = buildTx();
    expect((tx as unknown as Record<string, unknown>).tx).toBeUndefined();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.withdrawn",
        data: {},
      }),
    ).resolves.toMatchObject({ systemKind: "booking_request.withdrawn" });
  });

  it("rejects a payload that does not match the kind's schema", async () => {
    const { tx, messages, bookingRequests } = buildTx();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_agreement.countered",
        // `agreementId` is not a uuid, and `actorSide` is missing.
        data: { agreementId: "nope", actorSide: "PLACE" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    // Nothing was written and nothing was bumped — the ledger is untouched.
    expect(messages.rows.size).toBe(0);
    expect(bookingRequests.touchLastMessageAt).not.toHaveBeenCalled();
  });

  it("rejects params belonging to a DIFFERENT kind", async () => {
    const { tx, messages } = buildTx();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        // A request-opened payload sent under an event-created kind: the whole
        // point of validating PER KIND rather than "is it an object".
        kind: "booking_event.created",
        data: { direction: "TO_PLACE", source: "PLATFORM" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(messages.rows.size).toBe(0);
  });

  it("rejects extra params (.strict) so no unread field lands on the ledger", async () => {
    const { tx } = buildTx();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.viewed",
        data: { viewedBy: "someone" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("requires ISO-8601 STRINGS for timestamps, never Date objects", async () => {
    const { tx } = buildTx();

    // Json has no date type: a Date written in comes back OUT as a string, so
    // accepting one here would validate on write and break on read.
    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.expired",
        data: { expiresAt: new Date("2026-06-24T12:00:00.000Z") } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.expired",
        data: { expiresAt: "2026-06-24T12:00:00.000Z" },
      }),
    ).resolves.toMatchObject({ systemKind: "booking_request.expired" });
  });

  it("accepts the event-created and event-modified shapes the timeline renders", async () => {
    const { tx } = buildTx();

    const created = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_event.created",
      data: {
        eventId: EVENT_ID,
        agreementId: AGREEMENT_ID,
        startsAt: "2026-07-10T02:00:00.000Z",
      },
      actorHumanId: ACTOR_ID,
    });
    expect(created.systemData).toMatchObject({ eventId: EVENT_ID });

    const modified = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_event.modified",
      data: {
        eventId: EVENT_ID,
        changedFields: ["startsAt"],
        previousStartsAt: "2026-07-10T02:00:00.000Z",
        nextStartsAt: "2026-07-11T02:00:00.000Z",
      },
      actorHumanId: ACTOR_ID,
    });
    expect(modified.systemData).toMatchObject({
      changedFields: ["startsAt"],
      nextStartsAt: "2026-07-11T02:00:00.000Z",
    });
  });

  it("accepts the lifecycle shapes (published / cancelled / completed / fulfilled)", async () => {
    const { tx } = buildTx();

    const published = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_event.published",
      data: { eventId: EVENT_ID, startsAt: "2026-07-10T02:00:00.000Z" },
      actorHumanId: ACTOR_ID,
    });
    expect(published.systemData).toEqual({
      eventId: EVENT_ID,
      startsAt: "2026-07-10T02:00:00.000Z",
    });
    // A start-less row is still writable — the copy has a date-free line.
    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_event.published",
        data: { eventId: EVENT_ID, startsAt: null },
      }),
    ).resolves.toMatchObject({ systemKind: "booking_event.published" });

    for (const kind of ["booking_event.cancelled", "booking_event.completed"] as const) {
      const entry = await appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind,
        data: { eventId: EVENT_ID },
        actorHumanId: ACTOR_ID,
      });
      expect(entry.systemData).toEqual({ eventId: EVENT_ID });
    }

    const fulfilled = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_agreement.fulfilled",
      data: { agreementId: AGREEMENT_ID },
      actorHumanId: ACTOR_ID,
    });
    expect(fulfilled.systemData).toEqual({ agreementId: AGREEMENT_ID });

    // `.strict()` everywhere: a cancel reason the use case does not have
    // cannot be smuggled onto the ledger.
    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_event.cancelled",
        data: { eventId: EVENT_ID, reason: "rain" } as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an empty or unbounded changedFields list", async () => {
    const { tx } = buildTx();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_event.modified",
        data: {
          eventId: EVENT_ID,
          changedFields: [],
          previousStartsAt: null,
          nextStartsAt: null,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_event.modified",
        data: {
          eventId: EVENT_ID,
          changedFields: Array.from({ length: 21 }, (_, i) => `f${i}`),
          previousStartsAt: null,
          nextStartsAt: null,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("caps free text copied onto the ledger", async () => {
    const { tx } = buildTx();

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.declined",
        data: { reason: "x".repeat(1001) },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.declined",
        data: { reason: null },
      }),
    ).resolves.toMatchObject({ systemKind: "booking_request.declined" });
  });

  it("does NOT make the request look unread on either side", async () => {
    const { tx, messages } = buildTx();

    await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_agreement.accepted",
      data: { agreementId: AGREEMENT_ID, actorSide: "PLACE" },
      actorHumanId: ACTOR_ID,
    });

    // The owner decision: unread means "a human is waiting on you". Accepting
    // your own agreement must not light up anybody's inbox badge.
    for (const side of ["VENUE", "PERFORMER"] as const) {
      const counts = await messages.countUnreadByRequest({
        bookingRequestIds: [REQUEST_ID],
        side,
      });
      expect(counts.has(REQUEST_ID)).toBe(false);
    }
  });

  it("still lets a HUMAN message count as unread alongside entries", async () => {
    const { tx, messages } = buildTx();

    await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_agreement.sent_for_review",
      data: { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" },
      actorHumanId: ACTOR_ID,
    });
    await messages.create({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      authorHumanId: ACTOR_ID,
      body: "Sent it over — have a look?",
    });

    const forVenue = await messages.countUnreadByRequest({
      bookingRequestIds: [REQUEST_ID],
      side: "VENUE",
    });
    // ONE — the human message, not the entry that preceded it.
    expect(forVenue.get(REQUEST_ID)).toBe(1);
  });

  it("is never stamped read, even when the counterparty opens the thread", async () => {
    const { tx, messages } = buildTx();

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.viewed",
      data: {},
      actorHumanId: ACTOR_ID,
    });
    await messages.create({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      authorHumanId: ACTOR_ID,
      body: "Any word?",
    });

    const stamped = await messages.markRead({
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
      upToCreatedAt: new Date("2999-01-01T00:00:00.000Z"),
    });

    // Only the human message. A row that can never be unread must never wear a
    // read receipt — that is what keeps markRead the exact complement of the
    // unread count.
    expect(stamped).toBe(1);
    expect(messages.rows.get(entry.id)?.readAt).toBeNull();
  });

  it("interleaves with human messages in one chronological thread", async () => {
    const { tx, messages } = buildTx();

    await messages.create({
      bookingRequestId: REQUEST_ID,
      authorSide: "PERFORMER",
      authorHumanId: ACTOR_ID,
      body: "Can we do the 10th?",
    });
    await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.accepted",
      data: { agreementId: AGREEMENT_ID },
      actorHumanId: ACTOR_ID,
    });
    await messages.create({
      bookingRequestId: REQUEST_ID,
      authorSide: "VENUE",
      authorHumanId: ACTOR_ID,
      body: "Draft's attached.",
    });

    const page = await messages.listForRequest({
      bookingRequestId: REQUEST_ID,
    });

    // The whole point: the agreement being hammered out reads as one column.
    expect(page.items.map((m) => m.systemKind)).toEqual([
      null,
      "booking_request.accepted",
      null,
    ]);
    expect(page.items[1]?.systemData).toEqual({ agreementId: AGREEMENT_ID });
  });
});

// ── P3a (unclaimed venues) ──
describe("retired kinds (amendment 2026-09-25: no parking)", () => {
  it("parked_unclaimed / unparked stay READABLE: kinds and schemas are still there", () => {
    expect(RETIRED_BOOKING_SYSTEM_ENTRY_KINDS).toEqual([
      "booking_request.parked_unclaimed",
      "booking_request.unparked",
    ]);
    for (const kind of RETIRED_BOOKING_SYSTEM_ENTRY_KINDS) {
      expect(isBookingSystemEntryKind(kind)).toBe(true);
      expect(BOOKING_SYSTEM_ENTRY_SCHEMAS[kind].safeParse({}).success).toBe(true);
      expect(isRetiredSystemEntry(kind)).toBe(true);
    }
    expect(isRetiredSystemEntry("booking_request.expired")).toBe(false);
    expect(isRetiredSystemEntry(null)).toBe(false);
  });

  it("they are never WRITTEN: the append refuses them before any write", async () => {
    const { tx, messages, bookingRequests } = buildTx();
    for (const kind of RETIRED_BOOKING_SYSTEM_ENTRY_KINDS) {
      await expect(
        appendBookingSystemEntry(tx, {
          bookingRequestId: REQUEST_ID,
          // The type already refuses it; widened here to prove the run-time half.
          kind: kind as never,
          data: {} as never,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "retired_system_entry_kind",
        meta: { kind },
      });
    }
    const page = await messages.listForRequest({ bookingRequestId: REQUEST_ID });
    expect(page.items).toEqual([]);
    expect(bookingRequests.touchLastMessageAt).not.toHaveBeenCalled();
  });

  it("expired_unclaimed carries a place-name snapshot (nullable), nothing else", async () => {
    const schema = BOOKING_SYSTEM_ENTRY_SCHEMAS["booking_request.expired_unclaimed"];
    expect(schema.safeParse({ placeName: "The Unclaimed Stage" }).success).toBe(true);
    expect(schema.safeParse({ placeName: null }).success).toBe(true);
    expect(schema.safeParse({ placeName: "" }).success).toBe(false);
    expect(schema.safeParse({ placeName: "x".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ placeName: "A", placeId: EVENT_ID }).success).toBe(false);

    const { tx, touched } = buildTx();
    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.expired_unclaimed",
      data: { placeName: "The Unclaimed Stage" },
      actorHumanId: null,
    });
    expect(entry).toMatchObject({
      authorSide: "SYSTEM",
      authorHumanId: null,
      systemKind: "booking_request.expired_unclaimed",
      systemData: { placeName: "The Unclaimed Stage" },
    });
    // Visible to the sender: it is not sender-only-hidden, and it bumps.
    expect(touched).toHaveLength(1);
  });
});
