import { describe, expect, it, vi } from "vitest";

import { BOOKING_SYSTEM_ENTRY_KINDS } from "@th/ports/repos/booking-request-messages";
import type { TxRepos } from "@th/ports/repos";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import {
  BOOKING_REASON_MAX,
  BOOKING_SYSTEM_ENTRY_SCHEMAS,
  appendBookingSystemEntry,
  isSenderOnlySystemEntry,
  isVenueInternalSystemEntry,
} from "../messages/_shared/system-entries";
import { LEGACY_OWNER_SIDE } from "../../../lib/legacy-place-values";
import { AGREEMENT_ID, ACTOR_ID, REQUEST_ID } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Ledger contract for booking-the-night (docs/specs/2026-09-25, P2a): the
// kinds and params the agree-to-book, cancel-booking and close-request paths
// will write. Nothing emits them yet; what is pinned here is that each new
// payload is STRICT and BOUNDED, that every payload written before this
// change still validates, and who may see each new kind.
// ─────────────────────────────────────────────────────────────────────────────

const HOLD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EVENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ok = (kind: keyof typeof BOOKING_SYSTEM_ENTRY_SCHEMAS, data: unknown) =>
  BOOKING_SYSTEM_ENTRY_SCHEMAS[kind].safeParse(data).success;

describe("booking-the-night ledger kinds", () => {
  it("are part of the kind vocabulary, each with a schema", () => {
    for (const kind of [
      "booking_request.closed_by_place",
      "booking_request.booking_cancelled",
      "booking_agreement.returned_to_draft",
    ] as const) {
      expect(BOOKING_SYSTEM_ENTRY_KINDS).toContain(kind);
      expect(BOOKING_SYSTEM_ENTRY_SCHEMAS[kind]).toBeDefined();
    }
  });

  it("are visible to BOTH sides (neither venue-internal nor sender-only)", () => {
    for (const kind of [
      "booking_request.closed_by_place",
      "booking_request.booking_cancelled",
      "booking_agreement.returned_to_draft",
    ]) {
      expect(isVenueInternalSystemEntry(kind), kind).toBe(false);
      expect(isSenderOnlySystemEntry(kind), kind).toBe(false);
    }
  });

  describe("booking_request.booking_cancelled (FR-009, N13)", () => {
    const kind = "booking_request.booking_cancelled" as const;

    it("carries which side cancelled and the reason", () => {
      expect(ok(kind, { by: "place", reason: "Our sound desk died." })).toBe(true);
      expect(ok(kind, { by: "sender", reason: "x".repeat(1000) })).toBe(true);
    });

    it("requires a non-empty reason of at most 1000 characters (N18)", () => {
      expect(ok(kind, { by: "place" })).toBe(false);
      expect(ok(kind, { by: "place", reason: null })).toBe(false);
      expect(ok(kind, { by: "place", reason: "" })).toBe(false);
      expect(ok(kind, { by: "place", reason: "x".repeat(1001) })).toBe(false);
    });

    it("writes the place side as place, whichever spelling the writer holds", () => {
      // `cancelBooking`'s canceller side still spells it the old way until
      // the codemod; the stored param is the new spelling.
      const parsed = BOOKING_SYSTEM_ENTRY_SCHEMAS[kind].parse({
        by: LEGACY_OWNER_SIDE,
        reason: "r",
      });
      expect(parsed).toEqual({ by: "place", reason: "r" });
    });

    it("names a side, never a person or a made-up party", () => {
      expect(ok(kind, { by: "act", reason: "r" })).toBe(false);
      expect(ok(kind, { by: "VENUE", reason: "r" })).toBe(false);
      expect(ok(kind, { reason: "r" })).toBe(false);
    });

    it("is strict", () => {
      expect(ok(kind, { by: "place", reason: "r", eventId: EVENT_ID })).toBe(false);
    });
  });

  describe("booking_request.closed_by_place (FR-010, N14)", () => {
    const kind = "booking_request.closed_by_place" as const;

    it("requires a bounded, non-empty reason and nothing else", () => {
      expect(ok(kind, { reason: "We went another way." })).toBe(true);
      expect(ok(kind, { reason: "x".repeat(1000) })).toBe(true);
      expect(ok(kind, {})).toBe(false);
      expect(ok(kind, { reason: "" })).toBe(false);
      expect(ok(kind, { reason: "x".repeat(1001) })).toBe(false);
      expect(ok(kind, { reason: "r", by: "place" })).toBe(false);
    });
  });

  describe("booking_agreement.returned_to_draft (N16, FR-012)", () => {
    const kind = "booking_agreement.returned_to_draft" as const;

    it("links the agreement; the reason is optional but bounded", () => {
      expect(ok(kind, { agreementId: AGREEMENT_ID })).toBe(true);
      expect(ok(kind, { agreementId: AGREEMENT_ID, reason: "Fee too low." })).toBe(
        true,
      );
      expect(ok(kind, { agreementId: AGREEMENT_ID, reason: "" })).toBe(false);
      expect(
        ok(kind, { agreementId: AGREEMENT_ID, reason: "x".repeat(1000) }),
      ).toBe(true);
      expect(
        ok(kind, { agreementId: AGREEMENT_ID, reason: "x".repeat(1001) }),
      ).toBe(false);
      expect(ok(kind, { reason: "r" })).toBe(false);
      expect(ok(kind, { agreementId: "not-a-uuid" })).toBe(false);
      expect(
        ok(kind, { agreementId: AGREEMENT_ID, actorSide: "PERFORMER" }),
      ).toBe(false);
    });
  });

  describe("one reason bound (N18 / FR-013)", () => {
    it("is 1000, the same bound as every other reason on the ledger", () => {
      expect(BOOKING_REASON_MAX).toBe(1000);
      const atMax = "x".repeat(BOOKING_REASON_MAX);
      const over = "x".repeat(BOOKING_REASON_MAX + 1);
      // The existing nullable reasons and the new required ones agree.
      expect(
        ok("booking_agreement.declined", {
          agreementId: AGREEMENT_ID,
          actorSide: "PERFORMER",
          reason: atMax,
        }),
      ).toBe(true);
      expect(
        ok("booking_agreement.declined", {
          agreementId: AGREEMENT_ID,
          actorSide: "PERFORMER",
          reason: over,
        }),
      ).toBe(false);
      expect(ok("booking_request.closed_by_place", { reason: atMax })).toBe(true);
      expect(ok("booking_request.closed_by_place", { reason: over })).toBe(false);
    });

    it("leaves an act's pass at 240", () => {
      const kind = "booking_request.act_declined" as const;
      const base = { actId: HOLD_ID, actName: "The Band" };
      expect(ok(kind, { ...base, reason: "x".repeat(240) })).toBe(true);
      expect(ok(kind, { ...base, reason: "x".repeat(241) })).toBe(false);
    });
  });

  describe("booking_agreement.agree_refused (FR-001, N6)", () => {
    const kind = "booking_agreement.agree_refused" as const;
    const AGREEMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    it("carries the terms and the place-local night, nothing else", () => {
      expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17" })).toBe(true);
      expect(ok(kind, { agreementId: AGREEMENT })).toBe(false);
      expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17T20:00" })).toBe(false);
      // Never another party's hold: the payload has no room for one.
      expect(
        ok(kind, { agreementId: AGREEMENT, date: "2026-10-17", aheadHoldId: HOLD_ID }),
      ).toBe(false);
    });

    it("names why: every reason the agree is refused for, and nothing else", () => {
      for (const reason of [
        "night_taken",
        "event_on_another_night",
        "event_origin_gone",
        "linked_event_gone",
        "place_not_taking_bookings",
      ]) {
        expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17", reason }), reason).toBe(true);
      }
      expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17", reason: "quota" })).toBe(false);
    });

    it("is VENUE-INTERNAL: the sender's list never carries it", () => {
      expect(isVenueInternalSystemEntry(kind)).toBe(true);
      expect(isSenderOnlySystemEntry(kind)).toBe(false);
    });
  });

  describe("booking_agreement.event_not_created (P2c, review carry e)", () => {
    const kind = "booking_agreement.event_not_created" as const;
    const AGREEMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    it("carries the terms and the booked place-local night, nothing else", () => {
      expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17" })).toBe(true);
      expect(ok(kind, { agreementId: AGREEMENT })).toBe(false);
      expect(ok(kind, { agreementId: AGREEMENT, date: "2026-10-17", reason: "quota" })).toBe(
        false,
      );
    });

    it("is VENUE-INTERNAL: the sender's list never carries it", () => {
      expect(isVenueInternalSystemEntry(kind)).toBe(true);
      expect(isSenderOnlySystemEntry(kind)).toBe(false);
    });
  });

  describe("booking_hold.confirmed gains withoutTerms (FR-004)", () => {
    const kind = "booking_hold.confirmed" as const;

    it("keeps every payload written before the field valid", () => {
      expect(ok(kind, { holdId: HOLD_ID, eventId: null })).toBe(true);
      expect(ok(kind, { holdId: HOLD_ID, eventId: EVENT_ID })).toBe(true);
    });

    it("accepts a boolean withoutTerms and nothing else under that name", () => {
      expect(ok(kind, { holdId: HOLD_ID, eventId: null, withoutTerms: true })).toBe(
        true,
      );
      expect(
        ok(kind, { holdId: HOLD_ID, eventId: null, withoutTerms: false }),
      ).toBe(true);
      expect(
        ok(kind, { holdId: HOLD_ID, eventId: null, withoutTerms: "yes" }),
      ).toBe(false);
      expect(
        ok(kind, { holdId: HOLD_ID, eventId: null, withoutTerms: true, by: "place" }),
      ).toBe(false);
    });
  });

  describe("booking_hold.released takes BOOKING_CANCELLED (FR-009)", () => {
    it("accepts the new reason beside the old ones", () => {
      for (const reason of [
        "MANUAL",
        "EXPIRED",
        "CONFIRMED_OTHER",
        "REQUEST_CLOSED",
        "SIBLING_CONFIRMED",
        "PAST_DATE",
        "EVENT_SCHEDULED",
        "BOOKING_CANCELLED",
      ]) {
        expect(ok("booking_hold.released", { holdId: HOLD_ID, reason }), reason).toBe(
          true,
        );
      }
      expect(
        ok("booking_hold.released", { holdId: HOLD_ID, reason: "CANCELLED" }),
      ).toBe(false);
    });
  });

  describe("booking_agreement.declined (unchanged, already carries a reason)", () => {
    it("keeps its existing shape: actorSide and a nullable reason", () => {
      const kind = "booking_agreement.declined" as const;
      expect(
        ok(kind, { agreementId: AGREEMENT_ID, actorSide: "PERFORMER", reason: null }),
      ).toBe(true);
      expect(
        ok(kind, {
          agreementId: AGREEMENT_ID,
          actorSide: "PERFORMER",
          reason: "The fee doesn't work.",
        }),
      ).toBe(true);
    });
  });

  it("appendBookingSystemEntry writes a cancel entry and bumps recency (visible kind)", async () => {
    const messages = createFakeBookingRequestMessagesRepo();
    const touchLastMessageAt = vi.fn(async () => {});
    const tx = {
      bookingRequestMessages: messages,
      bookingRequests: { touchLastMessageAt },
    } as unknown as TxRepos;

    const entry = await appendBookingSystemEntry(tx, {
      bookingRequestId: REQUEST_ID,
      kind: "booking_request.booking_cancelled",
      data: { by: "sender", reason: "The drummer broke a wrist." },
      actorHumanId: ACTOR_ID,
    });
    expect(entry).toMatchObject({
      authorSide: "SYSTEM",
      authorHumanId: ACTOR_ID,
      body: "",
      systemKind: "booking_request.booking_cancelled",
      systemData: { by: "sender", reason: "The drummer broke a wrist." },
    });
    expect(touchLastMessageAt).toHaveBeenCalledTimes(1);

    await expect(
      appendBookingSystemEntry(tx, {
        bookingRequestId: REQUEST_ID,
        kind: "booking_request.booking_cancelled",
        // @ts-expect-error — the reason is required (N18)
        data: { by: "place" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
