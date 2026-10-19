import { describe, expect, it } from "vitest";

import { render, sampleInputFor } from "..";

// ── P3b (asks) ── venue-booking-standards v1.1 FR-009b: the venue asked the
// sender for one thing the night needs. The subject mirrors the core
// renderer's title (comms/renderers.ts, booking.ask-received).

const TARGET = "https://ithasfire.com/account/settings/booking-requests";

describe("booking.ask_received", () => {
  it("renders the registry sample", async () => {
    const out = await render({
      templateId: "booking.ask_received",
      props: sampleInputFor("booking.ask_received"),
    });
    expect(out.html).toContain("<html");
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it("subject, what to answer with, the note, the request link", async () => {
    const out = await render({
      templateId: "booking.ask_received",
      props: {
        venueName: "The Corner Stage",
        label: "Tech rider",
        note: "Inputs and backline, please.",
        answerPhrase: "a file",
        targetUrl: TARGET,
      },
    });
    expect(out.subject).toBe("The Corner Stage asked you for: Tech rider");
    expect(out.text).toContain("Answer with a file on the request.");
    expect(out.text).toContain("Inputs and backline, please.");
    expect(out.html).toContain(TARGET);
  });

  it("no note: no note card", async () => {
    const out = await render({
      templateId: "booking.ask_received",
      props: {
        venueName: "The Corner Stage",
        label: "Set length",
        answerPhrase: "a set length",
        targetUrl: TARGET,
      },
    });
    expect(out.text).not.toContain("THEIR NOTE");
  });

  it("escapes the venue's label and note (user free text)", async () => {
    const out = await render({
      templateId: "booking.ask_received",
      props: {
        venueName: "The Corner Stage",
        label: "<b>Poster</b>",
        note: "<script>alert(1)</script>",
        answerPhrase: "an image",
        targetUrl: TARGET,
      },
    });
    expect(out.html).not.toContain("<script>alert(1)</script>");
    expect(out.html).not.toContain("<b>Poster</b>");
  });
});
