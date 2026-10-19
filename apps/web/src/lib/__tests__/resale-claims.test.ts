import { describe, expect, it } from "vitest";

import {
  claimResolutionKey,
  claimShortId,
  claimWindowState,
  isClaimableResaleTicket,
  isRefundPending,
  isResaleOrder,
  type ClaimableTicketCandidate,
} from "../resale-claims";

// Pure helpers only: no React, no DOM (web component tests are broken on
// main; this file must not depend on jest-dom).

const START = "2026-10-10T19:00:00.000Z";
const CLOSE = "2026-10-13T23:00:00.000Z";
const startMs = Date.parse(START);
const closeMs = Date.parse(CLOSE);

describe("claimWindowState (half-open, like the server)", () => {
  const at = (now: number) =>
    claimWindowState({
      eventStartsAt: START,
      resaleClaimWindowClosesAt: CLOSE,
      now,
    });

  it("is not_open one millisecond before the start", () => {
    expect(at(startMs - 1)).toBe("not_open");
  });

  it("is open AT the start instant (start is inclusive)", () => {
    expect(at(startMs)).toBe("open");
  });

  it("is open one millisecond before the close", () => {
    expect(at(closeMs - 1)).toBe("open");
  });

  it("is closed AT the close instant (close is exclusive)", () => {
    expect(at(closeMs)).toBe("closed");
  });

  it("is closed after the close", () => {
    expect(at(closeMs + 60_000)).toBe("closed");
  });

  it("accepts a Date for the start", () => {
    expect(
      claimWindowState({
        eventStartsAt: new Date(START),
        resaleClaimWindowClosesAt: CLOSE,
        now: startMs,
      }),
    ).toBe("open");
  });

  it("returns null without a start", () => {
    expect(
      claimWindowState({
        eventStartsAt: null,
        resaleClaimWindowClosesAt: CLOSE,
        now: startMs,
      }),
    ).toBeNull();
  });

  it("returns null without a close", () => {
    expect(
      claimWindowState({
        eventStartsAt: START,
        resaleClaimWindowClosesAt: null,
        now: startMs,
      }),
    ).toBeNull();
  });

  it("returns null for an unreadable start or close", () => {
    expect(
      claimWindowState({
        eventStartsAt: "not a date",
        resaleClaimWindowClosesAt: CLOSE,
        now: startMs,
      }),
    ).toBeNull();
    expect(
      claimWindowState({
        eventStartsAt: START,
        resaleClaimWindowClosesAt: "not a date",
        now: startMs,
      }),
    ).toBeNull();
  });
});

describe("isClaimableResaleTicket", () => {
  const held = (
    overrides: Partial<ClaimableTicketCandidate> = {},
    item: Partial<NonNullable<ClaimableTicketCandidate["item"]>> = {},
  ): ClaimableTicketCandidate => ({
    id: "t1",
    status: "VALID",
    orderItemId: "i1",
    ...overrides,
    item: {
      id: "i1",
      kind: "ticket",
      status: "active",
      resaleListingId: "l1",
      transferredAt: null,
      refundedAt: null,
      ...item,
    },
  });

  it.each(["VALID", "SCANNED", "INVALID"])("accepts a held %s ticket", (s) => {
    expect(isClaimableResaleTicket(held({ status: s }))).toBe(true);
  });

  it.each(["LISTED", "REFUNDED"])("refuses a %s ticket", (s) => {
    expect(isClaimableResaleTicket(held({ status: s }))).toBe(false);
  });

  it("refuses without an order item link", () => {
    expect(isClaimableResaleTicket(held({ orderItemId: null }))).toBe(false);
    expect(isClaimableResaleTicket({ ...held(), item: null })).toBe(false);
  });

  it("refuses an item without a listing (the seller can't be found)", () => {
    expect(isClaimableResaleTicket(held({}, { resaleListingId: null }))).toBe(
      false,
    );
  });

  it("refuses a transferred, refunded or inactive item", () => {
    expect(
      isClaimableResaleTicket(held({}, { transferredAt: "2026-10-11" })),
    ).toBe(false);
    expect(isClaimableResaleTicket(held({}, { refundedAt: new Date() }))).toBe(
      false,
    );
    expect(isClaimableResaleTicket(held({}, { status: "transferred" }))).toBe(
      false,
    );
  });

  it("refuses a non-ticket item", () => {
    expect(isClaimableResaleTicket(held({}, { kind: "surcharge" }))).toBe(
      false,
    );
  });
});

describe("isResaleOrder", () => {
  it("is true only for RESALE", () => {
    expect(isResaleOrder({ source: "RESALE" })).toBe(true);
    expect(isResaleOrder({ source: "PRIMARY" })).toBe(false);
    expect(isResaleOrder({ source: "resale" })).toBe(false);
  });
});

describe("refund confirmation", () => {
  it("an approved claim is pending until the refund is confirmed", () => {
    expect(
      isRefundPending({ status: "approved", refundConfirmed: false }),
    ).toBe(true);
    expect(isRefundPending({ status: "approved", refundConfirmed: true })).toBe(
      false,
    );
    expect(isRefundPending({ status: "denied", refundConfirmed: false })).toBe(
      false,
    );
  });

  it("the Resolution column never says refunded before confirmation", () => {
    expect(
      claimResolutionKey({ status: "approved", refundConfirmed: false }),
    ).toBe("resaleClaim.resolutionRefundPending");
    expect(
      claimResolutionKey({ status: "approved", refundConfirmed: true }),
    ).toBe("resaleClaim.resolutionFullRefund");
    expect(
      claimResolutionKey({ status: "denied", refundConfirmed: false }),
    ).toBe("resaleClaim.resolutionNoRefund");
    expect(
      claimResolutionKey({ status: "open", refundConfirmed: false }),
    ).toBeNull();
    expect(
      claimResolutionKey({ status: "under_review", refundConfirmed: false }),
    ).toBeNull();
  });
});

describe("claimShortId", () => {
  it("keeps the first 8 characters, no ellipsis", () => {
    expect(claimShortId("3f2a9c1d-1111-4000-8000-000000000000")).toBe(
      "3f2a9c1d",
    );
  });
});
