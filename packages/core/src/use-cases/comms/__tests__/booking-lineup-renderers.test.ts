import { describe, expect, it } from "vitest";

import { listNotificationRendererVariants, renderNotification } from "../renderers";

// booking.lineup-invited (lineup-booking-requests v2, FR-003 / NFR-002): the
// invite a tagged artist gets. Pins the strict schema, the per-(request,
// human) fingerprint + push collapse, the templated email contract the
// ui-email registry mirrors, and the calm copy.

const NOW = new Date("2026-09-25T12:00:00.000Z");
const base = {
  bookingRequestId: "44444444-4444-4444-8444-444444444444",
  humanId: "12121212-1212-4121-8121-121212121212",
  senderName: "Corner Booking Collective",
  venueName: "The Corner Stage",
  targetUrl: "https://ithasfire.test/bookings/acts/44444444-4444-4444-8444-444444444444",
};

const render = (payload: unknown) =>
  renderNotification("booking.lineup-invited", payload, { now: NOW });

describe("booking.lineup-invited", () => {
  it("is registered", () => {
    expect(listNotificationRendererVariants()).toContain("booking.lineup-invited");
  });

  it("renders transactional in-app + push + templated email, no SMS", () => {
    const r = render({ ...base, preferredDates: ["2026-08-14T20:00", "2026-08-21"] });

    expect(r.category).toBe("transactional");
    expect(r.fingerprint).toEqual({
      variant: "booking.lineup-invited",
      bookingRequestId: base.bookingRequestId,
      humanId: base.humanId,
    });
    expect(r.inApp?.title).toBe("Corner Booking Collective added you to a bill at The Corner Stage");
    expect(r.inApp?.body).toBe(
      "They pitched The Corner Stage with you on the bill. Join if you're in, or pass — either way takes one tap.",
    );
    expect(r.inApp?.action).toEqual({ label: "Review", href: base.targetUrl });
    expect(r.inApp?.kind).toBe("INFO");

    expect(r.push?.collapseKey).toBe(`booking-lineup-${base.bookingRequestId}-${base.humanId}`);
    expect(r.push?.data).toEqual({ bookingRequestId: base.bookingRequestId, url: base.targetUrl });

    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.template).toEqual({
      key: "booking.lineup_invited",
      variables: {
        senderName: base.senderName,
        venueName: base.venueName,
        // Wall-clock time printed as written — never shifted through a zone.
        dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM", "Fri, Aug 21, 2026"],
        targetUrl: base.targetUrl,
      },
    });
    expect(r.email?.text).toContain(base.targetUrl);
    expect(r.email?.text).toContain("Fri, Aug 14, 2026 at 8:00 PM");
    expect(r.sms).toBeUndefined();
  });

  it("renders without dates (empty labels) and shows an unparseable stored date verbatim rather than failing", () => {
    expect(render(base).email?.template?.variables).toMatchObject({ dateLabels: [] });
    expect(
      render({ ...base, preferredDates: ["someday"] }).email?.template?.variables,
    ).toMatchObject({ dateLabels: ["someday"] });
  });

  it("formats midnight and noon wall clocks", () => {
    const labels = render({ ...base, preferredDates: ["2026-08-14T00:05", "2026-08-14T12:30"] }).email
      ?.template?.variables as { dateLabels: string[] };
    expect(labels.dateLabels).toEqual(["Fri, Aug 14, 2026 at 12:05 AM", "Fri, Aug 14, 2026 at 12:30 PM"]);
  });

  it("names the group for a group editor's invite (v3 L17 / FR-012)", () => {
    const r = render({ ...base, asGroupName: "Paper Moth" });
    expect(r.inApp?.title).toBe("Corner Booking Collective added Paper Moth to a bill at The Corner Stage");
    expect(r.inApp?.body).toContain("with Paper Moth on the bill");
    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.template?.variables).toMatchObject({ asGroupName: "Paper Moth" });
    // Absent for a tagged person — the template keys off its presence.
    expect(render(base).email?.template?.variables).not.toHaveProperty("asGroupName");
    expect(() => render({ ...base, asGroupName: "" })).toThrow();
  });

  it("speaks join / pass, never confirm (CONTEXT.md)", () => {
    for (const payload of [base, { ...base, asGroupName: "Paper Moth" }]) {
      const r = render(payload);
      const copy = [r.inApp?.title, r.inApp?.body, r.push?.body, r.email?.text].join(" ");
      expect(copy).not.toMatch(/confirm|decline/i);
    }
  });

  it("carries no urgency language anywhere (NFR-002)", () => {
    const r = render(base);
    const copy = [r.inApp?.title, r.inApp?.body, r.push?.body, r.email?.text].join(" ");
    expect(copy).not.toMatch(/urgent|expires|deadline|act now|hurry|asap/i);
  });

  it("rejects unknown fields, empty names and a non-URL target (strict)", () => {
    expect(() => render({ ...base, extra: "x" })).toThrow();
    expect(() => render({ ...base, senderName: "" })).toThrow();
    expect(() => render({ ...base, venueName: "" })).toThrow();
    expect(() => render({ ...base, targetUrl: "/bookings/acts/x" })).toThrow();
    expect(() => render({ ...base, humanId: "not-a-uuid" })).toThrow();
  });
});
