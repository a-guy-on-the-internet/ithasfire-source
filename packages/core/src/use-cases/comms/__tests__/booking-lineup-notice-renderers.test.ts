import { describe, expect, it } from "vitest";

import { formatBookingNight } from "../booking-lineup-notice-renderers";
import { listNotificationRendererVariants, renderNotification } from "../renderers";

// The bill's notices after the invite (lineup-booking-requests v3, FR-012):
// strict schemas, the category each one routes through (transactional vs
// "Bills you're on"), the channels each renders, the join / pass vocabulary,
// and that no notice can carry a reason.

const NOW = new Date("2026-09-25T12:00:00.000Z");
const REQUEST = "44444444-4444-4444-8444-444444444444";
const ACT = "55555555-5555-4555-8555-555555555555";
const HUMAN = "12121212-1212-4121-8121-121212121212";
const render = (variant: string, payload: unknown) =>
  renderNotification(variant, payload, { now: NOW });

describe("bill notice renderers", () => {
  it("are registered", () => {
    expect(listNotificationRendererVariants()).toEqual(
      expect.arrayContaining([
        "booking.lineup-answered",
        "booking.lineup-request-closed",
        "booking.lineup-removed",
      ]),
    );
  });

  describe("booking.lineup-answered", () => {
    const base = {
      bookingRequestId: REQUEST,
      actId: ACT,
      humanId: HUMAN,
      actName: "Della",
      venueName: "The Corner Stage",
      answer: "joined",
      targetUrl: "https://ithasfire.test/admin/@sam/bookings",
    };

    it("is transactional and IN-APP ONLY", () => {
      const r = render("booking.lineup-answered", base);
      expect(r.category).toBe("transactional");
      expect(r.inApp).toMatchObject({
        title: "Della joined your bill at The Corner Stage",
        action: { label: "Open your bookings", href: base.targetUrl },
      });
      expect(r.email).toBeUndefined();
      expect(r.push).toBeUndefined();
      expect(r.sms).toBeUndefined();
      expect(r.fingerprint).toEqual({
        variant: "booking.lineup-answered",
        bookingRequestId: REQUEST,
        actId: ACT,
        humanId: HUMAN,
        answer: "joined",
      });
    });

    it("passed and left read as such — and never 'confirm' / 'decline'", () => {
      expect(render("booking.lineup-answered", { ...base, answer: "passed" }).inApp?.title).toBe(
        "Della passed on your bill at The Corner Stage",
      );
      expect(render("booking.lineup-answered", { ...base, answer: "left" }).inApp?.title).toBe(
        "Della left your bill at The Corner Stage",
      );
      for (const answer of ["joined", "passed", "left"]) {
        const r = render("booking.lineup-answered", { ...base, answer });
        expect([r.inApp?.title, r.inApp?.body].join(" ")).not.toMatch(/confirm|decline/i);
      }
    });

    it("is strict: no reason field, no unknown answer", () => {
      expect(() => render("booking.lineup-answered", { ...base, reason: "x" })).toThrow();
      expect(() => render("booking.lineup-answered", { ...base, answer: "confirmed" })).toThrow();
      expect(() => render("booking.lineup-answered", { ...base, actName: "" })).toThrow();
    });
  });

  describe("booking.lineup-request-closed", () => {
    const base = {
      bookingRequestId: REQUEST,
      actId: ACT,
      humanId: HUMAN,
      senderName: "Corner Booking Collective",
      venueName: "The Corner Stage",
      preferredDates: ["2026-08-14T20:00"],
      targetUrl: `https://ithasfire.test/bookings/acts/${REQUEST}`,
    };

    it("routes through 'Bills you're on', in-app + templated email, no push", () => {
      const r = render("booking.lineup-request-closed", base);
      expect(r.category).toBe("billsYoureOn");
      expect(r.inApp?.title).toBe("The request to The Corner Stage isn't going ahead");
      expect(r.inApp?.body).toBe(
        "Corner Booking Collective's request to The Corner Stage for Fri, Aug 14, 2026 at 8:00 PM, with you on the bill, isn't going ahead. There's nothing you need to do.",
      );
      expect(r.push).toBeUndefined();
      expect(r.email?.subject).toBe(r.inApp?.title);
      expect(r.email?.template).toEqual({
        key: "booking.lineup_request_closed",
        variables: {
          senderName: base.senderName,
          venueName: base.venueName,
          dateLabels: ["Fri, Aug 14, 2026 at 8:00 PM"],
          targetUrl: base.targetUrl,
        },
      });
    });

    it("names the group for a group editor", () => {
      const r = render("booking.lineup-request-closed", { ...base, asGroupName: "Paper Moth" });
      expect(r.inApp?.body).toContain("with Paper Moth on the bill");
      expect(r.email?.template?.variables).toMatchObject({ asGroupName: "Paper Moth" });
    });

    it("cannot carry the venue's reason (strict schema)", () => {
      expect(() => render("booking.lineup-request-closed", { ...base, reason: "fully booked" })).toThrow();
      expect(() => render("booking.lineup-request-closed", { ...base, declineReason: "x" })).toThrow();
    });
  });

  describe("booking.lineup-removed", () => {
    const base = {
      bookingRequestId: REQUEST,
      actId: ACT,
      humanId: HUMAN,
      senderName: "Corner Booking Collective",
      venueName: "The Corner Stage",
    };

    it("routes through 'Bills you're on', in-app (no action) + templated email", () => {
      const r = render("booking.lineup-removed", base);
      expect(r.category).toBe("billsYoureOn");
      expect(r.inApp).toMatchObject({
        title: "Corner Booking Collective took you off the bill at The Corner Stage",
        action: null,
      });
      expect(r.push).toBeUndefined();
      expect(r.email?.template).toEqual({
        key: "booking.lineup_removed",
        variables: {
          senderName: base.senderName,
          venueName: base.venueName,
          dateLabels: [],
        },
      });
    });

    it("a group reads in the third person", () => {
      const r = render("booking.lineup-removed", { ...base, asGroupName: "Paper Moth" });
      expect(r.inApp?.title).toBe("Corner Booking Collective took Paper Moth off the bill at The Corner Stage");
      expect(r.inApp?.body).toContain("Paper Moth is no longer on it");
    });
  });

  it("formatBookingNight prints the wall clock as written and passes the unparseable through", () => {
    expect(formatBookingNight("2026-08-14")).toBe("Fri, Aug 14, 2026");
    expect(formatBookingNight("2026-08-14T00:05")).toBe("Fri, Aug 14, 2026 at 12:05 AM");
    expect(formatBookingNight("someday")).toBe("someday");
  });
});
