import { describe, expect, it } from "vitest";

import {
  createEventExplainerCopy,
  createEventFromBookingErrorMessage,
  createEventOutcomeCopy,
  explainerShowDate,
  mayCreateEventFromBooking,
  venueEventEditorUrl,
  type OwnerEntityForBooking,
} from "../create-event-from-booking";

const owners: OwnerEntityForBooking[] = [
  { kind: "human", humanId: "human-1", adminSlug: "@stagename" },
  { kind: "org", orgId: "org-1", role: "EDITOR", adminSlug: "venue-co" },
  { kind: "org", orgId: "org-2", role: "FINANCE", adminSlug: "books-org" },
];

describe("mayCreateEventFromBooking", () => {
  it("never offers on agreements without a booking request", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: false,
        counterpartyType: "organization",
        counterpartyId: "org-1",
        owners,
      }),
    ).toBe(false);
  });

  it("defaults open while owners have not resolved (server enforces)", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "organization",
        counterpartyId: "org-1",
        owners: undefined,
      }),
    ).toBe(true);
  });

  it("offers to edit-role members of the venue counterparty org", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "organization",
        counterpartyId: "org-1",
        owners,
      }),
    ).toBe(true);
  });

  it("hides from FINANCE members (saveEventForOrg would 403)", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "organization",
        counterpartyId: "org-2",
        owners,
      }),
    ).toBe(false);
  });

  it("hides from non-members of the counterparty org", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "organization",
        counterpartyId: "org-elsewhere",
        owners,
      }),
    ).toBe(false);
  });

  it("offers to the counterparty human themselves, and only them", () => {
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "human",
        counterpartyId: "human-1",
        owners,
      }),
    ).toBe(true);
    expect(
      mayCreateEventFromBooking({
        bookingMinted: true,
        counterpartyType: "human",
        counterpartyId: "human-other",
        owners,
      }),
    ).toBe(false);
  });
});

describe("venueEventEditorUrl", () => {
  it("routes org-owned drafts under the org admin slug", () => {
    expect(
      venueEventEditorUrl({
        eventId: "evt-1",
        counterpartyType: "organization",
        counterpartyId: "org-1",
        owners,
      }),
    ).toBe("/admin/venue-co/events/evt-1");
  });

  it("falls back to the org id when the owner entry is missing", () => {
    expect(
      venueEventEditorUrl({
        eventId: "evt-1",
        counterpartyType: "organization",
        counterpartyId: "org-unknown",
        owners,
      }),
    ).toBe("/admin/org-unknown/events/evt-1");
  });

  it("routes human-owned drafts under the human's @slug", () => {
    expect(
      venueEventEditorUrl({
        eventId: "evt-2",
        counterpartyType: "human",
        counterpartyId: "human-1",
        owners,
      }),
    ).toBe("/admin/@stagename/events/evt-2");
  });

  it("falls back to @{id} when owners are unavailable", () => {
    expect(
      venueEventEditorUrl({
        eventId: "evt-2",
        counterpartyType: "human",
        counterpartyId: "human-1",
        owners: undefined,
      }),
    ).toBe("/admin/@human-1/events/evt-2");
  });
});

describe("explainerShowDate", () => {
  it("prefers the negotiated proposedDate (matches the server's startsAt preference)", () => {
    const proposed = new Date("2026-08-15T19:00:00.000Z");
    expect(
      explainerShowDate({
        proposedDate: proposed,
        preferredDates: ["2026-08-02"],
      }),
    ).toBe(proposed);
  });

  it("falls back to the first preferred date at local midnight", () => {
    expect(
      explainerShowDate({
        proposedDate: null,
        preferredDates: ["2026-08-02", "2026-08-09"],
      }),
    ).toEqual(new Date("2026-08-02T00:00:00"));
  });

  it("returns null when neither is available", () => {
    expect(
      explainerShowDate({ proposedDate: null, preferredDates: [] }),
    ).toBeNull();
    expect(
      explainerShowDate({ proposedDate: null, preferredDates: undefined }),
    ).toBeNull();
  });
});

describe("createEventExplainerCopy", () => {
  it("uses the full sentence when venue, date, and act are on hand", () => {
    expect(
      createEventExplainerCopy({
        venueName: "The Basement",
        dateLabel: "Aug 2, 2026",
        actName: "Night Static",
      }),
    ).toBe(
      "Creates a draft show at The Basement on Aug 2, 2026 with Night Static on the bill. Fine-tune details in the event editor before publishing.",
    );
  });

  it("falls back to generic copy when any fact is missing", () => {
    const generic = createEventExplainerCopy({
      venueName: "The Basement",
      dateLabel: null,
      actName: "Night Static",
    });
    expect(generic).toContain("prefilled from this booking");
    expect(generic).not.toContain("The Basement");
  });
});

describe("createEventOutcomeCopy", () => {
  it("distinguishes fresh finalize from already-linked", () => {
    expect(
      createEventOutcomeCopy({
        eventId: "e",
        alreadyLinked: false,
        finalized: true,
      }).title,
    ).toBe("Event created and agreement finalized");
    expect(
      createEventOutcomeCopy({
        eventId: "e",
        alreadyLinked: true,
        finalized: true,
      }).title,
    ).toBe("This agreement is already linked to its event.");
  });

  it("maps both blocked gates to created-with-caveat copy", () => {
    const lines = createEventOutcomeCopy({
      eventId: "e",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "lines_unconfirmed",
    });
    expect(lines.title).toBe(
      "Event created — finalize when payouts are confirmed",
    );
    expect(lines.detail).toContain("payout line is confirmed");

    const payee = createEventOutcomeCopy({
      eventId: "e",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "payee_not_ready",
    });
    expect(payee.title).toBe("Event created — finalize when payees are ready");
    expect(payee.detail).toContain("payee can receive payouts");
  });

  it("says where a requester-owned draft went instead of promising a venue finalize", () => {
    const owned = createEventOutcomeCopy({
      eventId: "e",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "requester_owned",
    });
    expect(owned.title).toBe("Event created in the requester's admin");
    expect(owned.detail).toContain("nothing to finalize on your side");
    expect(owned.detail).not.toContain("finalize flow below");
  });

  it("says a frozen deal's finalize is made from the agreement page, and that everyone is told", () => {
    const frozen = createEventOutcomeCopy({
      eventId: "e",
      alreadyLinked: false,
      finalized: false,
      finalizeBlocked: "deal_frozen",
    });
    expect(frozen.title).toBe("Event created. Its deal is frozen");
    expect(frozen.detail).toContain("tells everyone on it");
    expect(frozen.detail).not.toContain("payout line is confirmed");
  });
});

describe("createEventFromBookingErrorMessage", () => {
  it("maps structured appCodes to calm copy", () => {
    expect(
      createEventFromBookingErrorMessage({
        message: "AGREEMENT_NOT_ACCEPTED",
        data: { appCode: "AGREEMENT_NOT_ACCEPTED" },
      }),
    ).toContain("isn't accepted anymore");
    expect(
      createEventFromBookingErrorMessage({
        message: "INVALID_STATUS",
        data: { appCode: "INVALID_STATUS" },
      }),
    ).toContain("missing the details");
  });

  it("maps legacy lowercase message codes too", () => {
    expect(
      createEventFromBookingErrorMessage({ message: "not_resource_owner" }),
    ).toContain("Only the place on this agreement");
  });

  it("maps PLACE_NOT_FOUND to the removed-place message", () => {
    expect(
      createEventFromBookingErrorMessage({
        message: "PLACE_NOT_FOUND",
        data: { appCode: "PLACE_NOT_FOUND" },
      }),
    ).toContain("place on this booking no longer exists");
  });

  it("treats tRPC CONFLICT as a retryable convergence", () => {
    expect(
      createEventFromBookingErrorMessage({
        message: "agreement_status_changed",
        data: { code: "CONFLICT" },
      }),
    ).toContain("Try again");
  });

  it("returns null for unmapped errors (caller falls back)", () => {
    expect(
      createEventFromBookingErrorMessage({ message: "quota_exceeded" }),
    ).toBeNull();
    expect(createEventFromBookingErrorMessage(new Error("boom"))).toBeNull();
    expect(createEventFromBookingErrorMessage(undefined)).toBeNull();
  });
});
