import { describe, expect, it } from "vitest";

import {
  bookingInboxTabOf,
  countBookingInboxTabs,
  defaultBookingInboxTab,
  rowsForBookingInboxTab,
} from "../booking-inbox-tabs";

function row(
  status: string,
  agreementStatus: string | null = null,
  eventId: string | null = null,
  holds: { status: string; lapsed: boolean }[] = [],
) {
  return {
    status: status as "PENDING",
    agreementStatus,
    eventId,
    holds,
  };
}

const live = (status: "ACTIVE" | "CHALLENGED" = "ACTIVE") => ({
  status,
  lapsed: false,
});

describe("bookingInboxTabOf — where the booking IS", () => {
  it("open: PENDING and VIEWED, whatever the projection says", () => {
    expect(bookingInboxTabOf(row("PENDING"))).toBe("open");
    expect(bookingInboxTabOf(row("VIEWED"))).toBe("open");
    // A stale projection cannot promote an unanswered request.
    expect(bookingInboxTabOf(row("VIEWED", "ACCEPTED", "ev-1"))).toBe("open");
  });

  it("closed: DECLINED / WITHDRAWN / EXPIRED requests", () => {
    expect(bookingInboxTabOf(row("DECLINED"))).toBe("closed");
    expect(bookingInboxTabOf(row("WITHDRAWN"))).toBe("closed");
    expect(bookingInboxTabOf(row("EXPIRED"))).toBe("closed");
  });

  it("agreement: accepted with no event, across every live agreement status", () => {
    for (const agreementStatus of [
      "DRAFT",
      "PROPOSED",
      "COUNTERED",
      "ACCEPTED",
      "FULFILLED",
      "DISPUTED",
    ]) {
      expect(bookingInboxTabOf(row("ACCEPTED", agreementStatus))).toBe(
        "agreement",
      );
    }
  });

  it("agreement, not closed, when the projection DEGRADED to null", () => {
    // `resolveBookingStages` nulls every row's stage fields on a failed batch
    // lookup. Null must read as "accepted, nothing more known" — never as a
    // definite negative that files the booking under Closed.
    expect(bookingInboxTabOf(row("ACCEPTED", null, null))).toBe("agreement");
  });

  it("event: any accepted row with an event, whatever the event's status", () => {
    expect(bookingInboxTabOf(row("ACCEPTED", "ACCEPTED", "ev-1"))).toBe(
      "event",
    );
    // The stage rail distinguishes draft / published / cancelled / completed;
    // the tab only says an event exists.
    expect(bookingInboxTabOf(row("ACCEPTED", "FULFILLED", "ev-1"))).toBe(
      "event",
    );
  });

  it("closed: the agreement ended before an event came of it", () => {
    for (const agreementStatus of ["DECLINED", "CANCELLED", "EXPIRED"]) {
      expect(bookingInboxTabOf(row("ACCEPTED", agreementStatus))).toBe(
        "closed",
      );
    }
  });

  it("event outranks a terminal agreement status — the event is the fact", () => {
    // An event that exists is what the venue has to deal with; a CANCELLED
    // agreement beside it is history the rail shows, not a reason to hide it.
    expect(bookingInboxTabOf(row("ACCEPTED", "CANCELLED", "ev-1"))).toBe(
      "event",
    );
  });

  it("files a request status this build has never seen under Agreement, not Closed", () => {
    // Hidden is worse than slightly misfiled.
    expect(bookingInboxTabOf(row("SOMETHING_NEW"))).toBe("agreement");
  });

  // ── booking-holds FR-011 ─────────────────────────────────────────────────
  it("holds: any live hold on an answered request, ACTIVE or CHALLENGED", () => {
    expect(bookingInboxTabOf(row("ACCEPTED", "DRAFT", null, [live()]))).toBe(
      "holds",
    );
    expect(
      bookingInboxTabOf(row("ACCEPTED", "ACCEPTED", null, [live("CHALLENGED")])),
    ).toBe("holds");
    // One live hold among released ones is enough.
    expect(
      bookingInboxTabOf(
        row("ACCEPTED", "DRAFT", null, [
          { status: "RELEASED", lapsed: false },
          live(),
        ]),
      ),
    ).toBe("holds");
  });

  it("holds never steals from Open — the Open count must keep meaning Open", () => {
    expect(bookingInboxTabOf(row("PENDING", null, null, [live()]))).toBe("open");
    expect(bookingInboxTabOf(row("VIEWED", null, null, [live("CHALLENGED")]))).toBe(
      "open",
    );
  });

  it("a lapsed, released or confirmed hold is not live", () => {
    expect(
      bookingInboxTabOf(
        row("ACCEPTED", "DRAFT", null, [{ status: "CHALLENGED", lapsed: true }]),
      ),
    ).toBe("agreement");
    expect(
      bookingInboxTabOf(
        row("ACCEPTED", "DRAFT", null, [{ status: "RELEASED", lapsed: false }]),
      ),
    ).toBe("agreement");
    // Confirm mints the event; the row lands on Event, not Holds.
    expect(
      bookingInboxTabOf(
        row("ACCEPTED", "ACCEPTED", "ev-1", [
          { status: "CONFIRMED", lapsed: false },
        ]),
      ),
    ).toBe("event");
  });

  it("holds outranks the event and terminal-agreement rules", () => {
    // A request with an event AND a live hold on another date is still being
    // held — the booker's live work wins over the history.
    expect(
      bookingInboxTabOf(row("ACCEPTED", "CANCELLED", "ev-1", [live()])),
    ).toBe("holds");
  });

  it("rows without a `holds` field classify as before", () => {
    expect(
      bookingInboxTabOf({ status: "ACCEPTED", agreementStatus: "DRAFT", eventId: null }),
    ).toBe("agreement");
  });
});

describe("rowsForBookingInboxTab / countBookingInboxTabs — one rule for both", () => {
  const rows = [
    { id: "a", ...row("PENDING") },
    { id: "b", ...row("VIEWED") },
    { id: "c", ...row("ACCEPTED", "DRAFT") },
    { id: "d", ...row("ACCEPTED", "ACCEPTED", "ev-1") },
    { id: "e", ...row("DECLINED") },
    { id: "f", ...row("ACCEPTED", "CANCELLED") },
    { id: "g", ...row("ACCEPTED", "DRAFT", null, [live()]) },
  ];

  it("counts exactly what each tab filters", () => {
    const counts = countBookingInboxTabs(rows);
    expect(counts).toEqual({ open: 2, holds: 1, agreement: 1, event: 1, closed: 2 });
    for (const tab of ["open", "holds", "agreement", "event", "closed"] as const) {
      expect(rowsForBookingInboxTab(rows, tab)).toHaveLength(counts[tab]);
    }
  });

  it("partitions: every row lands on exactly one tab", () => {
    const seen = new Set<string>();
    for (const tab of ["open", "holds", "agreement", "event", "closed"] as const) {
      for (const r of rowsForBookingInboxTab(rows, tab)) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
    }
    expect(seen.size).toBe(rows.length);
  });
});

describe("defaultBookingInboxTab — first non-empty in slot order", () => {
  it("lands on Open when anything is waiting", () => {
    expect(
      defaultBookingInboxTab({ open: 1, holds: 5, agreement: 5, event: 5, closed: 5 }),
    ).toBe("open");
  });

  it("falls through open → holds → agreement → event → closed", () => {
    expect(
      defaultBookingInboxTab({ open: 0, holds: 1, agreement: 2, event: 1, closed: 1 }),
    ).toBe("holds");
    expect(
      defaultBookingInboxTab({ open: 0, holds: 0, agreement: 2, event: 1, closed: 1 }),
    ).toBe("agreement");
    expect(
      defaultBookingInboxTab({ open: 0, holds: 0, agreement: 0, event: 1, closed: 1 }),
    ).toBe("event");
    expect(
      defaultBookingInboxTab({ open: 0, holds: 0, agreement: 0, event: 0, closed: 3 }),
    ).toBe("closed");
  });

  it("lands on Open for an empty inbox — the onboarding state lives there", () => {
    expect(
      defaultBookingInboxTab({ open: 0, holds: 0, agreement: 0, event: 0, closed: 0 }),
    ).toBe("open");
  });
});
