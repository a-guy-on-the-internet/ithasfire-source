import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// booking-the-night N13 / FR-009, review W4: both sides of a booking hear
// that its night was cancelled, with the canceller's reason. The subject
// mirrors the core renderer's title.

const TARGET = "https://ithasfire.com/account/settings/booking-requests";

describe("booking.booking_cancelled", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "booking.booking_cancelled",
      props: sampleInputFor("booking.booking_cancelled"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("subject, the reason, the event line, the request link", async () => {
    const out = await render({
      templateId: "booking.booking_cancelled",
      props: {
        cancelledByName: "The Corner Stage",
        dateLabel: "Sat, Oct 17, 2026",
        reason: "The roof is leaking; we're shut that week.",
        eventCancelled: true,
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("The Corner Stage cancelled the booking for Sat, Oct 17, 2026");
    expect(out.text).toContain("The roof is leaking; we're shut that week.");
    expect(out.text).toContain("the event is cancelled with it");
    expect(out.text).toContain("Anyone who bought a ticket");
    expect(out.html).toContain(TARGET);
  });

  it("no event: no ticket-buyer line", async () => {
    const out = await render({
      templateId: "booking.booking_cancelled",
      props: {
        cancelledByName: "The Midnight Ramblers",
        dateLabel: "Sat, Oct 17, 2026",
        reason: "Our drummer broke a wrist.",
        eventCancelled: false,
        targetUrl: TARGET,
      },
    });
    expect(out.text).not.toContain("Anyone who bought a ticket");
    expect(out.text).not.toContain("cancelled with it");
  });

  it("escapes the reason (user free text)", async () => {
    const out = await render({
      templateId: "booking.booking_cancelled",
      props: {
        cancelledByName: "The Corner Stage",
        dateLabel: "Sat, Oct 17, 2026",
        reason: "<script>alert(1)</script>",
        eventCancelled: false,
        targetUrl: TARGET,
      },
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
  });
});
