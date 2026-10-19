import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// The bill's emails (lineup-booking-requests v3, FR-012): the invite's group
// line (L17), the "isn't going ahead" notice (L7) and the "off the bill"
// notice (L5). Subjects mirror the core renderer titles
// (comms/booking-lineup-notice-renderers.ts, comms/renderers.ts).

const TARGET = "https://ithasfire.com/bookings/acts/44444444-4444-4444-8444-444444444444";
const CONFIRM_WORDS = /\bconfirm|\bdecline/i;

describe("booking.lineup_invited — a group editor's invite (v3 L17)", () => {
  it("names the group in the subject, heading and footer; join / pass copy", async () => {
    const out = await render({
      templateId: "booking.lineup_invited",
      props: {
        senderName: "Corner Booking Collective",
        venueName: "The Corner Stage",
        asGroupName: "Paper Moth",
        dateLabels: [],
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("Corner Booking Collective added Paper Moth to a bill at The Corner Stage");
    expect(out.text).toContain("Paper Moth");
    expect(out.text).toContain("a group you edit");
    expect(out.text).not.toMatch(CONFIRM_WORDS);
  });

  it("a person's invite says join / pass, never confirm / decline", async () => {
    const out = await render({
      templateId: "booking.lineup_invited",
      props: sampleInputFor("booking.lineup_invited"),
    });
    expect(out.text).not.toMatch(CONFIRM_WORDS);
    expect(out.text).toMatch(/Join if you.re in, or pass/);
  });
});

describe("booking.lineup_request_closed (v3 L7)", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "booking.lineup_request_closed",
      props: sampleInputFor("booking.lineup_request_closed"),
    });
    expect(out.subject).toBe("The request to The Corner Stage isn't going ahead");
    expect(out.html).toContain(`href="${TARGET}"`);
    expect(out.text).toContain("Fri, Aug 14, 2026 at 8:00 PM");
    expect(out.text).toContain("Bills you're on");
  });

  it("has no slot for a reason and never speaks of one", async () => {
    const out = await render({
      templateId: "booking.lineup_request_closed",
      props: {
        senderName: "Sam",
        venueName: "The Corner Stage",
        asGroupName: "Paper Moth",
        dateLabels: [],
        targetUrl: TARGET,
      },
    });
    expect(out.text).toContain("with Paper Moth on the bill");
    expect(out.text).not.toMatch(/reason|because the venue/i);
    expect(out.html).not.toContain("DATES");
  });

  it("escapes a hostile sender name", async () => {
    const out = await render({
      templateId: "booking.lineup_request_closed",
      props: {
        senderName: "<script>alert(1)</script>",
        venueName: "The Corner Stage",
        dateLabels: [],
        targetUrl: TARGET,
      },
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("booking.lineup_removed (v3 L5)", () => {
  it("renders the registry sample (a group) with no link", async () => {
    const out = await render({
      templateId: "booking.lineup_removed",
      props: sampleInputFor("booking.lineup_removed"),
    });
    expect(out.subject).toBe("Corner Booking Collective took Paper Moth off the bill at The Corner Stage");
    expect(out.text).toContain("Paper Moth is no longer on it");
    expect(out.html).not.toContain("/bookings/acts/");
  });

  it("a person reads in the second person", async () => {
    const out = await render({
      templateId: "booking.lineup_removed",
      props: { senderName: "Sam", venueName: "The Corner Stage", dateLabels: [] },
    });
    expect(out.subject).toBe("Sam took you off the bill at The Corner Stage");
    expect(out.text).toContain("you are no longer on it");
  });
});
