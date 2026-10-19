import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// booking-the-night N9 / FR-008: the sender hears the answer to its booking
// request, in either direction, with the responder's reason on a decline or
// a close. The subject mirrors the core renderer's title.

const TARGET = "https://ithasfire.com/account/settings/booking-requests";

describe("booking.request_responded", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: sampleInputFor("booking.request_responded"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("a venue's decline: subject, the reason, the request link", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: {
        responderName: "The Corner Stage",
        action: "declined",
        reason: "We're booked through the fall.",
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("The Corner Stage declined your booking request");
    expect(out.text).toContain("We're booked through the fall.");
    expect(out.text).toContain("View the request");
    expect(out.html).toContain(TARGET);
  });

  it("a venue's accept says terms follow, and has no reason block", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: {
        responderName: "The Corner Stage",
        action: "accepted",
        acceptedNext: "terms_coming",
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("The Corner Stage accepted your booking request");
    expect(out.text).toContain("They'll send terms for a night");
    expect(out.text).not.toContain("THEIR REASON");
    // Booking-arc vocabulary (CONTEXT.md): "Confirm" is not a booking word.
    expect(out.text).not.toMatch(/\bconfirm/i);
  });

  it("an act's accept of an organiser's request opens the agreement", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: {
        responderName: "The Midnight Ramblers",
        action: "accepted",
        acceptedNext: "agreement_ready",
        targetUrl: "https://ithasfire.com/agreements/agr_123",
      },
    });
    expect(out.text).toContain("Open the agreement");
  });

  it("a close after accept says so, with the reason", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: {
        responderName: "The Corner Stage",
        action: "closed",
        reason: "The room is closing for repairs.",
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("The Corner Stage closed your booking request");
    expect(out.text).toContain("The room is closing for repairs.");
  });

  it("escapes markup in the reason (escape at the sink)", async () => {
    const out = await render({
      templateId: "booking.request_responded",
      props: {
        responderName: "The Corner Stage",
        action: "declined",
        reason: "<b>no</b> <script>alert(1)</script>",
        targetUrl: TARGET,
      },
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});
