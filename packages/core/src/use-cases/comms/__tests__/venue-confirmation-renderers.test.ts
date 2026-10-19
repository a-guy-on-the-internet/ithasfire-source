import { describe, expect, it } from "vitest";

import { BOOKING_REASON_MAX } from "../../booking-requests/messages/_shared/system-entries";
import { renderNotification } from "../renderers";

// Venue-confirmation renderer pair (docs/specs/2026-08-27). The dispatcher's
// tests cover routing; these pin the per-variant contract: strict schemas,
// stable per-event fingerprints, email + in-app + push, no sms, and that the
// withdrawal's reason reaches the copy.

const NOW = new Date("2026-09-02T12:00:00.000Z");
const base = {
  eventId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  eventTitle: "Loud Band Night",
  placeId: "33333333-3333-4333-8333-333333333333",
  placeName: "The Corner Stage",
  bookingRequestId: "44444444-4444-4444-8444-444444444444",
  targetUrl: "https://ithasfire.test/admin/%40sam/events/e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
};

const render = (variant: string, payload: unknown) => renderNotification(variant, payload, { now: NOW });

describe("event.venue-confirmed", () => {
  it("renders in-app + push + text email, fingerprinted per event", () => {
    const r = render("event.venue-confirmed", base);
    expect(r.category).toBe("transactional");
    expect(r.fingerprint).toEqual({ variant: "event.venue-confirmed", eventId: base.eventId });
    expect(r.inApp?.title).toBe("The Corner Stage confirmed Loud Band Night");
    expect(r.inApp?.kind).toBe("INFO");
    expect(r.inApp?.action).toEqual({ label: "View your event", href: base.targetUrl });
    expect(r.inApp?.metadata).toEqual({
      eventId: base.eventId,
      placeId: base.placeId,
      bookingRequestId: base.bookingRequestId,
    });
    expect(r.push?.collapseKey).toBe(`venue-confirmation-${base.eventId}`);
    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.text).toContain(base.targetUrl);
    // Text-only for now — no ui-email template exists for this pair yet.
    expect(r.email?.template).toBeUndefined();
    expect(r.sms).toBeUndefined();
  });

  it("omits bookingRequestId from metadata when null, and rejects unknown/short fields", () => {
    const r = render("event.venue-confirmed", { ...base, bookingRequestId: null });
    expect(r.inApp?.metadata).toEqual({ eventId: base.eventId, placeId: base.placeId });
    expect(() => render("event.venue-confirmed", { ...base, extra: 1 })).toThrow();
    expect(() => render("event.venue-confirmed", { ...base, placeName: "" })).toThrow();
    expect(() => render("event.venue-confirmed", { ...base, targetUrl: "not a url" })).toThrow();
  });
});

describe("event.venue-confirmation-withdrawn", () => {
  it("renders a WARNING with the venue's reason in the body, and an edit CTA", () => {
    const r = render("event.venue-confirmation-withdrawn", { ...base, reason: "We double-booked the room." });
    expect(r.fingerprint).toEqual({ variant: "event.venue-confirmation-withdrawn", eventId: base.eventId });
    expect(r.inApp?.title).toBe("The Corner Stage withdrew its confirmation of Loud Band Night");
    expect(r.inApp?.kind).toBe("WARNING");
    expect(r.inApp?.body).toContain("Reason: We double-booked the room.");
    expect(r.inApp?.body).toContain("keeps its address");
    expect(r.inApp?.action).toEqual({ label: "Edit your event", href: base.targetUrl });
    expect(r.inApp?.metadata).toMatchObject({ reason: "We double-booked the room." });
    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.text).toContain("We double-booked the room.");
    expect(r.push?.collapseKey).toBe(`venue-confirmation-${base.eventId}`);
    expect(r.sms).toBeUndefined();
  });

  it("requires a non-empty reason ≤ 1000 (BOOKING_REASON_MAX, one cap for every booking reason)", () => {
    expect(() => render("event.venue-confirmation-withdrawn", base)).toThrow();
    expect(() => render("event.venue-confirmation-withdrawn", { ...base, reason: "" })).toThrow();
    expect(() =>
      render("event.venue-confirmation-withdrawn", { ...base, reason: "x".repeat(BOOKING_REASON_MAX + 1) }),
    ).toThrow();
  });

  it("renders a reason at the full 1000 cap into the body, the email and the metadata", () => {
    const long = "r".repeat(BOOKING_REASON_MAX);
    expect(long).toHaveLength(1000);
    const r = render("event.venue-confirmation-withdrawn", { ...base, reason: long });
    expect(r.inApp?.body).toContain(`Reason: ${long}`);
    expect(r.email?.text).toContain(long);
    expect(r.push?.body).toContain(long);
    expect(r.inApp?.metadata).toMatchObject({ reason: long });
  });
});
