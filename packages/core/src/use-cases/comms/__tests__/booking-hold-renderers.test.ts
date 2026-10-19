import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// Booking-hold renderer family (booking-holds spec FR-016). The dispatcher's
// tests cover routing; these pin the per-variant contract: strict schemas,
// stable fingerprints, the email-or-not matrix, and the "acts hear only
// their own position" rule (no foreign act data can even be supplied).

const NOW = new Date("2026-08-05T12:00:00.000Z");
const base = {
  bookingRequestId: "44444444-4444-4444-8444-444444444444",
  holdId: "d0000000-0000-4000-8000-000000000001",
  placeName: "The Corner Stage",
  date: "2026-08-14",
  timezone: "America/Chicago",
  targetUrl: "https://ithasfire.test/account/settings/booking-requests",
};
const RESPOND_BY = "2026-08-06T23:00:00.000Z";

const render = (variant: string, payload: unknown) => renderNotification(variant, payload, { now: NOW });

describe("booking.hold-placed", () => {
  it("renders in-app + push + templated email with ordinal position", () => {
    const r = render("booking.hold-placed", { ...base, position: 2 });
    expect(r.category).toBe("transactional");
    expect(r.fingerprint).toEqual({ variant: "booking.hold-placed", holdId: base.holdId });
    expect(r.inApp?.title).toBe("The Corner Stage is holding Fri, Aug 14, 2026 for you");
    expect(r.inApp?.body).toBe("You're 2nd in line for Fri, Aug 14, 2026.");
    expect(r.inApp?.action).toEqual({ label: "View your request", href: base.targetUrl });
    expect(r.push?.collapseKey).toBe(`booking-hold-${base.holdId}`);
    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.template).toEqual({
      key: "booking.hold_placed",
      variables: { kind: "placed", placeName: base.placeName, dateLabel: "Fri, Aug 14, 2026", position: 2, targetUrl: base.targetUrl },
    });
    expect(r.sms).toBeUndefined();
  });

  it("says first in line for position 1", () => {
    expect(render("booking.hold-placed", { ...base, position: 1 }).inApp?.body).toBe("You're first in line for Fri, Aug 14, 2026.");
  });

  it("rejects unknown fields, bad dates and position 0 (strict)", () => {
    expect(() => render("booking.hold-placed", { ...base, position: 1, actName: "x" })).toThrow();
    expect(() => render("booking.hold-placed", { ...base, position: 0 })).toThrow();
    expect(() => render("booking.hold-placed", { ...base, position: 1, date: "Aug 14" })).toThrow();
  });
});

describe("booking.hold-placed-batch", () => {
  const dates = [
    { date: "2026-08-14", position: 1 },
    { date: "2026-08-15", position: 2 },
    { date: "2026-08-21", position: 3 },
  ];

  it("renders ONE in-app row, ONE push and ONE templated email naming every date and position", () => {
    const r = render("booking.hold-placed-batch", { ...base, dates });
    expect(r.category).toBe("transactional");
    expect(r.inApp?.title).toBe("The Corner Stage is holding 3 dates for you");
    expect(r.inApp?.body).toBe(
      "Fri, Aug 14, 2026 — first in line; Sat, Aug 15, 2026 — 2nd in line; Fri, Aug 21, 2026 — 3rd in line",
    );
    expect(r.inApp?.action).toEqual({ label: "View your request", href: base.targetUrl });
    // Push bodies get truncated: name the count and the first date, not a list.
    expect(r.push?.body).toBe("You're in line for 3 dates, starting Fri, Aug 14, 2026.");
    expect(r.push?.collapseKey).toBe(`booking-hold-batch-${base.holdId}`);
    expect(r.email?.subject).toBe(r.inApp?.title);
    expect(r.email?.template).toEqual({
      key: "booking.hold_placed",
      variables: {
        kind: "placed_batch",
        placeName: base.placeName,
        dates: [
          { dateLabel: "Fri, Aug 14, 2026", position: 1 },
          { dateLabel: "Sat, Aug 15, 2026", position: 2 },
          { dateLabel: "Fri, Aug 21, 2026", position: 3 },
        ],
        targetUrl: base.targetUrl,
      },
    });
    expect(r.sms).toBeUndefined();
  });

  it("fingerprints on the SET, so two batches anchored on one hold stay distinct rows", () => {
    const three = render("booking.hold-placed-batch", { ...base, dates });
    const two = render("booking.hold-placed-batch", { ...base, dates: dates.slice(0, 2) });
    expect(three.fingerprint).toEqual({
      variant: "booking.hold-placed-batch",
      holdId: base.holdId,
      dates: "2026-08-14,2026-08-15,2026-08-21",
    });
    expect(two.fingerprint).not.toEqual(three.fingerprint);
  });

  it("refuses a one-date 'batch' and unknown fields (strict) — a digest of one is the plain variant", () => {
    expect(() => render("booking.hold-placed-batch", { ...base, dates: dates.slice(0, 1) })).toThrow();
    expect(() => render("booking.hold-placed-batch", { ...base, dates, position: 1 })).toThrow();
    expect(() =>
      render("booking.hold-placed-batch", { ...base, dates: [...dates, { date: "Aug 22", position: 4 }] }),
    ).toThrow();
  });
});

describe("booking.hold-position-changed", () => {
  it("emails ONLY when the act became first", () => {
    const first = render("booking.hold-position-changed", { ...base, position: 1 });
    expect(first.email?.subject).toBe("You're now first in line for Fri, Aug 14, 2026");
    expect(first.email?.template).toMatchObject({ key: "booking.hold_placed", variables: { kind: "moved", position: 1 } });

    const third = render("booking.hold-position-changed", { ...base, position: 3 });
    expect(third.email).toBeUndefined();
    expect(third.inApp?.body).toBe("You're now 3rd in line at The Corner Stage.");
  });

  it("fingerprints on the new position", () => {
    expect(render("booking.hold-position-changed", { ...base, position: 2 }).fingerprint).toEqual({
      variant: "booking.hold-position-changed",
      holdId: base.holdId,
      position: 2,
    });
  });
});

describe("booking.hold-challenged / booking.hold-challenge-extended", () => {
  // An unknown zone used to read the English deadline in UTC (a day late for
  // 03:30Z) while Spanish used the platform default; both now use the default.
  it("an unknown place zone reads the deadline in the platform default, en and es", () => {
    const payload = { ...base, timezone: "Not/AZone", position: 1, respondByISO: "2026-08-07T03:30:00.000Z" };
    const en = renderNotification("booking.hold-challenged", payload, { now: NOW, locale: "en" });
    expect(en.inApp?.body).toContain("by Thu, Aug 6 at 10:30 PM CDT");
    const es = renderNotification("booking.hold-challenged", payload, { now: NOW, locale: "es" });
    expect(es.inApp?.body?.replace(/[\u202f\u00a0]/gu, " ")).toContain("jueves 6 de agosto de 2026 a las 22:30");
  });

  it("position 1 (act): keep-or-release copy, WARNING kind, deadline in the place zone", () => {
    const r = render("booking.hold-challenged", { ...base, position: 1, respondByISO: RESPOND_BY });
    expect(r.inApp?.kind).toBe("WARNING");
    expect(r.inApp?.title).toBe("The Corner Stage needs an answer on Fri, Aug 14, 2026");
    // booking-the-night N20 owner copy: "another act is ready", never who.
    expect(r.inApp?.body).toBe("Another act is ready to book Fri, Aug 14, 2026. Keep or release your hold by Thu, Aug 6 at 6:00 PM CDT, or it lapses.");
    expect(r.inApp?.action?.label).toBe("Keep or release");
    expect(r.email?.template).toEqual({
      key: "booking.hold_challenged",
      variables: {
        placeName: base.placeName,
        dateLabel: "Fri, Aug 14, 2026",
        respondByLabel: "Thu, Aug 6 at 6:00 PM CDT",
        position: 1,
        extended: false,
        targetUrl: base.targetUrl,
      },
    });
    expect(r.fingerprint).toEqual({ variant: "booking.hold-challenged", holdId: base.holdId, position: 1, respondBy: RESPOND_BY });
  });

  // ── booking-the-night P2d-2 ── N19 / FR-014: the notice says what Keep will do.
  it("position 1 (act) with keepWill: book_now → 'Agree your terms by … to keep it'; ask_for_terms → the venue sends terms", () => {
    const now = render("booking.hold-challenged", { ...base, position: 1, respondByISO: RESPOND_BY, keepWill: "book_now" });
    expect(now.inApp?.body).toBe(
      "Another act is ready to book Fri, Aug 14, 2026. Agree your terms by Thu, Aug 6 at 6:00 PM CDT to keep it. Keep agrees them and books the night.",
    );
    expect(now.email?.template).toMatchObject({ variables: { keepWill: "book_now" } });
    const ask = render("booking.hold-challenged", { ...base, position: 1, respondByISO: RESPOND_BY, keepWill: "ask_for_terms" });
    // Review W2: before the tap the deadline is not set yet — "within 48 hours of keeping", no date.
    expect(ask.inApp?.body).toBe(
      "Another act is ready to book Fri, Aug 14, 2026. Keep it by Thu, Aug 6 at 6:00 PM CDT and the place sends you terms. Agree them within 48 hours of keeping, or the hold lapses.",
    );
    // keepWill is the challenged act's own: refused on the position-2 and staff copies.
    expect(() => render("booking.hold-challenged", { ...base, position: 2, respondByISO: RESPOND_BY, keepWill: "book_now" })).toThrow();
    expect(() =>
      render("booking.hold-challenged", { ...base, audience: "staff", actName: "The Fake Band", position: 1, respondByISO: RESPOND_BY, keepWill: "book_now" }),
    ).toThrow();
  });

  it("position 2 (act): informational, never names the challenged act", () => {
    const r = render("booking.hold-challenged", { ...base, position: 2, respondByISO: RESPOND_BY });
    expect(r.inApp?.kind).toBe("INFO");
    expect(r.inApp?.title).toBe("The first hold on Fri, Aug 14, 2026 was challenged");
    expect(r.inApp?.body).toContain("You'll hear by");
    expect(r.email?.template).toMatchObject({ variables: { position: 2 } });
  });

  it("extended: same template with extended=true and the moved-deadline subject", () => {
    const r = render("booking.hold-challenge-extended", { ...base, position: 1, respondByISO: RESPOND_BY });
    expect(r.email?.subject).toBe("More time to answer The Corner Stage about Fri, Aug 14, 2026");
    expect(r.email?.template).toMatchObject({ key: "booking.hold_challenged", variables: { extended: true } });
    expect(r.fingerprint).toMatchObject({ variant: "booking.hold-challenge-extended" });
  });

  it("staff audience: in-app only, names the act, requires actName", () => {
    const r = render("booking.hold-challenged", { ...base, audience: "staff", position: 1, respondByISO: RESPOND_BY, actName: "The Fake Band" });
    expect(r.email).toBeUndefined();
    expect(r.inApp?.title).toBe("Challenge open: The Fake Band on Fri, Aug 14, 2026");
    expect(r.inApp?.action?.label).toBe("Open booking inbox");
    expect(() => render("booking.hold-challenged", { ...base, audience: "staff", position: 1, respondByISO: RESPOND_BY })).toThrow();
  });

  it("act audience forbids actName; position must be 1 or 2; respondBy must be an instant", () => {
    expect(() => render("booking.hold-challenged", { ...base, position: 1, respondByISO: RESPOND_BY, actName: "x" })).toThrow();
    expect(() => render("booking.hold-challenged", { ...base, position: 3, respondByISO: RESPOND_BY })).toThrow();
    expect(() => render("booking.hold-challenged", { ...base, position: 1, respondByISO: "tomorrow" })).toThrow();
  });

  it("falls back to the platform default on an unknown zone instead of throwing", () => {
    const r = render("booking.hold-challenged", { ...base, timezone: "Mars/Olympus", position: 1, respondByISO: RESPOND_BY });
    expect(r.inApp?.body).toContain("6:00 PM CDT");
  });
});

describe("booking.hold-challenge-answered", () => {
  it("staff kept: templated email + in-app", () => {
    const r = render("booking.hold-challenge-answered", { ...base, audience: "staff", answer: "kept", actName: "The Fake Band" });
    expect(r.inApp?.title).toBe("The Fake Band kept their hold on Fri, Aug 14, 2026");
    expect(r.email?.template).toEqual({
      key: "booking.hold_staff_attention",
      variables: { kind: "answered_kept", actName: "The Fake Band", placeName: base.placeName, dateLabel: "Fri, Aug 14, 2026", targetUrl: base.targetUrl },
    });
    expect(r.fingerprint).toEqual({ variant: "booking.hold-challenge-answered", holdId: base.holdId, audience: "staff", answer: "kept" });
  });

  // ── booking-the-night P2d-2 ── FR-014: kept with no terms sent.
  it("staff kept, awaiting terms: 'send terms to keep this night' with the act's deadline", () => {
    const r = render("booking.hold-challenge-answered", {
      ...base,
      audience: "staff",
      answer: "kept",
      actName: "The Fake Band",
      awaitingTerms: true,
      respondByISO: RESPOND_BY,
    });
    expect(r.inApp?.body).toBe("Send them terms to keep this night. They have until Thu, Aug 6 at 6:00 PM CDT to agree, or the hold lapses.");
    expect(r.email?.template).toMatchObject({ variables: { kind: "answered_kept", respondByLabel: "Thu, Aug 6 at 6:00 PM CDT" } });
    // Kept only, and never without its deadline.
    expect(() => render("booking.hold-challenge-answered", { ...base, audience: "staff", answer: "released", actName: "X", awaitingTerms: true, respondByISO: RESPOND_BY })).toThrow();
    expect(() => render("booking.hold-challenge-answered", { ...base, audience: "staff", answer: "kept", actName: "X", awaitingTerms: true })).toThrow();
  });

  // ── booking-the-night P2d-2 review W2 ── the keeper's own notice.
  it("act (the keeper), awaiting terms: the ABSOLUTE deadline the keep set — no '48 hours', no email, no names", () => {
    const r = render("booking.hold-challenge-answered", {
      ...base,
      audience: "act",
      answer: "kept",
      awaitingTerms: true,
      respondByISO: RESPOND_BY,
    });
    expect(r.inApp?.title).toBe("You kept your hold on Fri, Aug 14, 2026");
    expect(r.inApp?.body).toBe(
      "The Corner Stage will send you terms. Agree them by Thu, Aug 6 at 6:00 PM CDT, or the hold lapses.",
    );
    expect(r.inApp?.body).not.toMatch(/48 hours/);
    expect(r.email).toBeUndefined();
    expect(r.fingerprint).toMatchObject({ audience: "act", answer: "kept", respondBy: RESPOND_BY });
    // The position-2 act's "first hold stands" is unchanged.
    expect(render("booking.hold-challenge-answered", { ...base, audience: "act", answer: "kept" }).inApp?.title).toBe(
      "The first hold on Fri, Aug 14, 2026 stands",
    );
  });

  it("staff released: answered_released template", () => {
    const r = render("booking.hold-challenge-answered", { ...base, audience: "staff", answer: "released", actName: "The Fake Band" });
    expect(r.email?.subject).toBe("The Fake Band released their hold on Fri, Aug 14, 2026");
    expect(r.email?.template).toMatchObject({ variables: { kind: "answered_released" } });
  });

  it("act audience: in-app only, no email, actName forbidden", () => {
    const r = render("booking.hold-challenge-answered", { ...base, audience: "act", answer: "kept" });
    expect(r.email).toBeUndefined();
    expect(r.inApp?.title).toBe("The first hold on Fri, Aug 14, 2026 stands");
    expect(() => render("booking.hold-challenge-answered", { ...base, audience: "act", answer: "kept", actName: "Leak" })).toThrow();
    expect(() => render("booking.hold-challenge-answered", { ...base, audience: "staff", answer: "kept" })).toThrow();
  });
});

describe("booking.hold-released / -lost-date / -expired / -confirmed", () => {
  it("released: reason picks the sentence and the template reason", () => {
    const manual = render("booking.hold-released", { ...base, reason: "MANUAL" });
    expect(manual.inApp?.body).toBe("The Corner Stage released the hold. Your request is still open.");
    expect(manual.email?.template).toMatchObject({ key: "booking.hold_released", variables: { reason: "released" } });

    expect(render("booking.hold-released", { ...base, reason: "SIBLING_CONFIRMED" }).email?.template).toMatchObject({ variables: { reason: "sibling_confirmed" } });
    expect(render("booking.hold-released", { ...base, reason: "REQUEST_CLOSED" }).email?.template).toMatchObject({ variables: { reason: "request_closed" } });
    // The loser reasons have their own variants — not accepted here.
    expect(() => render("booking.hold-released", { ...base, reason: "CONFIRMED_OTHER" })).toThrow();
    expect(() => render("booking.hold-released", { ...base, reason: "EXPIRED" })).toThrow();
  });

  it("released (EVENT_SCHEDULED, FR-018): the venue scheduled an event on the date — never 'another act'", () => {
    const act = render("booking.hold-released", { ...base, reason: "EVENT_SCHEDULED" });
    expect(act.inApp?.title).toBe("Your hold on Fri, Aug 14, 2026 at The Corner Stage was released");
    expect(act.inApp?.body).toBe("The Corner Stage scheduled an event on that date, so the hold was released. Your request is still open.");
    expect(act.inApp?.body).not.toContain("another act");
    expect(act.email?.template).toMatchObject({ key: "booking.hold_released", variables: { reason: "event_scheduled" } });
    expect(act.fingerprint).toEqual({ variant: "booking.hold-released", holdId: base.holdId });

    // Staff (assignee) shape: in-app only, names the act, its own fingerprint.
    const staff = render("booking.hold-released", { ...base, reason: "EVENT_SCHEDULED", audience: "staff", actName: "The Fake Band" });
    expect(staff.email).toBeUndefined();
    expect(staff.inApp?.title).toBe("Hold for The Fake Band on Fri, Aug 14, 2026 was released");
    expect(staff.inApp?.body).toBe("An event was scheduled on that date, so the hold left the line.");
    expect(staff.fingerprint).toEqual({ variant: "booking.hold-released", holdId: base.holdId, audience: "staff" });

    // Staff is EVENT_SCHEDULED-only and needs the name; acts never carry one.
    expect(() => render("booking.hold-released", { ...base, reason: "EVENT_SCHEDULED", audience: "staff" })).toThrow();
    expect(() => render("booking.hold-released", { ...base, reason: "MANUAL", audience: "staff", actName: "Leak" })).toThrow();
    expect(() => render("booking.hold-released", { ...base, reason: "EVENT_SCHEDULED", actName: "Leak" })).toThrow();
  });

  it("lost-date: the date went to another (unnamed) act", () => {
    const r = render("booking.hold-lost-date", base);
    expect(r.inApp?.title).toBe("Fri, Aug 14, 2026 at The Corner Stage went to another act");
    expect(r.email?.template).toMatchObject({ key: "booking.hold_released", variables: { reason: "lost_date" } });
    expect(() => render("booking.hold-lost-date", { ...base, actName: "Leak" })).toThrow();
  });

  it("expired: act gets the lapsed email; staff gets the staff-attention email with the act named", () => {
    const act = render("booking.hold-expired", { ...base, audience: "act" });
    expect(act.inApp?.title).toBe("Your hold on Fri, Aug 14, 2026 at The Corner Stage lapsed");
    expect(act.email?.template).toMatchObject({ key: "booking.hold_released", variables: { reason: "expired" } });

    const staff = render("booking.hold-expired", { ...base, audience: "staff", actName: "The Fake Band" });
    expect(staff.inApp?.title).toBe("Hold for The Fake Band on Fri, Aug 14, 2026 lapsed");
    expect(staff.email?.template).toMatchObject({ key: "booking.hold_staff_attention", variables: { kind: "expired", actName: "The Fake Band" } });
    expect(staff.fingerprint).toEqual({ variant: "booking.hold-expired", holdId: base.holdId, audience: "staff" });

    expect(() => render("booking.hold-expired", { ...base, audience: "act", actName: "Leak" })).toThrow();
    expect(() => render("booking.hold-expired", { ...base, audience: "staff" })).toThrow();
  });

  it("confirmed: templated email, booking link", () => {
    const r = render("booking.hold-confirmed", base);
    expect(r.email?.subject).toBe("The Corner Stage confirmed Fri, Aug 14, 2026");
    expect(r.inApp?.action).toEqual({ label: "View your booking", href: base.targetUrl });
    expect(r.email?.template).toEqual({
      key: "booking.hold_confirmed",
      variables: { placeName: base.placeName, dateLabel: "Fri, Aug 14, 2026", targetUrl: base.targetUrl },
    });
    expect(r.fingerprint).toEqual({ variant: "booking.hold-confirmed", holdId: base.holdId });
  });
});
