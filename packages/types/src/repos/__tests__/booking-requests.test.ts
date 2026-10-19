import { describe, expect, it } from "vitest";

import {
  getBookingRequestSender,
  isAnonymousBookingRequestCreateInput,
  isUnclaimedBookingInquiry,
  type CreateAnonymousBookingRequestRecordInput,
  type CreateBookingRequestRecordInput,
} from "../booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// getBookingRequestSender
// ─────────────────────────────────────────────────────────────────────────────

describe("getBookingRequestSender", () => {
  it("narrows a performer-owned row to the owned variant", () => {
    expect(
      getBookingRequestSender({
        performerOwnerType: "human",
        performerOwnerId: "human-1",
        contactName: null,
        contactEmail: null,
      }),
    ).toEqual({
      kind: "owned",
      performerOwnerType: "human",
      performerOwnerId: "human-1",
    });

    expect(
      getBookingRequestSender({
        performerOwnerType: "organization",
        performerOwnerId: "org-1",
        contactName: null,
        contactEmail: null,
      }),
    ).toEqual({
      kind: "owned",
      performerOwnerType: "organization",
      performerOwnerId: "org-1",
    });
  });

  it("narrows a null-owner row with contact fields to the anonymous variant", () => {
    expect(
      getBookingRequestSender({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: "Riot Grrrl Trio",
        contactEmail: "band@example.com",
      }),
    ).toEqual({
      kind: "anonymous",
      contactName: "Riot Grrrl Trio",
      contactEmail: "band@example.com",
    });
  });

  it("prefers the owner pair when both identities are present (claimed request)", () => {
    // FR-007: claiming backfills the owner pair; the row keeps its contact
    // fields but behaves as owned from then on.
    expect(
      getBookingRequestSender({
        performerOwnerType: "human",
        performerOwnerId: "human-1",
        contactName: "Riot Grrrl Trio",
        contactEmail: "band@example.com",
      }),
    ).toEqual({
      kind: "owned",
      performerOwnerType: "human",
      performerOwnerId: "human-1",
    });
  });

  it("throws on a half-populated owner pair or missing contact fields (invariant violation)", () => {
    // Neither identity at all.
    expect(() =>
      getBookingRequestSender({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: null,
        contactEmail: null,
      }),
    ).toThrow(/booking_request_sender_invariant/);

    // Owner pair half-set and no contact fields — corrupt, never valid.
    expect(() =>
      getBookingRequestSender({
        performerOwnerType: "human",
        performerOwnerId: null,
        contactName: null,
        contactEmail: null,
      }),
    ).toThrow(/booking_request_sender_invariant/);

    // Anonymous row missing one contact field — corrupt, never valid.
    expect(() =>
      getBookingRequestSender({
        performerOwnerType: null,
        performerOwnerId: null,
        contactName: null,
        contactEmail: "band@example.com",
      }),
    ).toThrow(/booking_request_sender_invariant/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isAnonymousBookingRequestCreateInput
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// isUnclaimedBookingInquiry
// ─────────────────────────────────────────────────────────────────────────────

describe("isUnclaimedBookingInquiry", () => {
  it("is true for a contact-bearing row nobody has claimed", () => {
    expect(
      isUnclaimedBookingInquiry({
        contactEmail: "jo@example.com",
        claimedAt: null,
      }),
    ).toBe(true);
  });

  it("is false once the row is claimed, and for a platform-owned row", () => {
    expect(
      isUnclaimedBookingInquiry({
        contactEmail: "jo@example.com",
        claimedAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toBe(false);
    expect(
      isUnclaimedBookingInquiry({ contactEmail: null, claimedAt: null }),
    ).toBe(false);
  });

  it("treats an ABSENT claimedAt as unclaimed (nullish, not strict, equality)", () => {
    // A projection or a test fixture that omits the field yields `undefined`.
    // With `=== null` this returned FALSE — "a real party is attached" — which
    // is the unsafe direction for a predicate whose whole job is a fail-closed
    // bias, and no tsconfig typechecks test files to catch such a fixture.
    expect(
      isUnclaimedBookingInquiry({
        contactEmail: "jo@example.com",
      } as unknown as { contactEmail: string | null; claimedAt: Date | null }),
    ).toBe(true);
  });

  it("treats an ABSENT contactEmail as not-an-inquiry", () => {
    expect(
      isUnclaimedBookingInquiry({ claimedAt: null } as unknown as {
        contactEmail: string | null;
        claimedAt: Date | null;
      }),
    ).toBe(false);
  });
});

describe("isAnonymousBookingRequestCreateInput", () => {
  const base = {
    placeId: "place-1",
    message: "We'd love to play your room.",
    preferredDates: ["2026-08-01"],
    expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("returns true for the anonymous variant and narrows it", () => {
    const input: CreateAnonymousBookingRequestRecordInput = {
      ...base,
      contactName: "Riot Grrrl Trio",
      contactEmail: "band@example.com",
      source: "EMBED",
      embedId: "embed-1",
    };
    expect(isAnonymousBookingRequestCreateInput(input)).toBe(true);
  });

  it("returns false for the owned variant", () => {
    const input: CreateBookingRequestRecordInput = {
      ...base,
      performerOwnerType: "human",
      performerOwnerId: "human-1",
    };
    expect(isAnonymousBookingRequestCreateInput(input)).toBe(false);
  });

  it("throws when an input carries BOTH identities (union excess-property leak)", () => {
    // TS excess-property rules let a non-literal owned value that also
    // carries contact fields flow into the union; property-presence sniffing
    // would mis-narrow it to anonymous and write a null-owner row with a
    // null contactName. The guard must reject instead of guessing.
    const leaky = {
      ...base,
      performerOwnerType: "human" as const,
      performerOwnerId: "human-1",
      contactName: "Riot Grrrl Trio",
      contactEmail: "band@example.com",
      source: "EMBED" as const,
    };
    expect(() => isAnonymousBookingRequestCreateInput(leaky)).toThrow(
      /booking_request_create_input_invariant/,
    );
  });

  it("throws when an input carries NEITHER identity", () => {
    const empty = { ...base } as CreateBookingRequestRecordInput;
    expect(() => isAnonymousBookingRequestCreateInput(empty)).toThrow(
      /booking_request_create_input_invariant/,
    );
  });
});
