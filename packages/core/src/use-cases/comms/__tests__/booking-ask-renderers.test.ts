import { describe, expect, it } from "vitest";

import { listNotificationRendererVariants, renderNotification } from "../renderers";

// ── P3b (asks) ── venue-booking-standards v1.1 FR-009b: the venue's ask
// reaches the sender (in-app + email, transactional); the sender's answer
// reaches the venue (in-app only). Strict payloads; the email names its
// template and keeps the subject equal to the in-app title.

const NOW = new Date("2026-10-02T12:00:00.000Z");
const REQUEST = "44444444-4444-4444-8444-444444444444";
const ASK = "a5a5a5a5-0000-4000-8000-000000000001";
const URL = "https://ithasfire.test/account/settings/booking-requests";
const render = (variant: string, payload: unknown) =>
  renderNotification(variant, payload, { now: NOW });

describe("booking ask renderers", () => {
  it("are registered", () => {
    expect(listNotificationRendererVariants()).toEqual(
      expect.arrayContaining(["booking.ask-received", "booking.ask-answered"]),
    );
  });

  describe("booking.ask-received", () => {
    const base = {
      bookingRequestId: REQUEST,
      askId: ASK,
      venueName: "The Corner Stage",
      kind: "IMAGE",
      label: "Poster",
      targetUrl: URL,
    };

    it("is transactional, in-app AND email, never push", () => {
      const out = render("booking.ask-received", { ...base, note: "Portrait, please." });
      expect(out.category).toBe("transactional");
      expect(out.inApp?.title).toBe("The Corner Stage asked you for: Poster");
      expect(out.inApp?.body).toContain("Portrait, please.");
      expect(out.inApp?.body).toContain("Answer with an image on the request.");
      expect(out.email?.subject).toBe(out.inApp?.title);
      expect(out.email?.template).toEqual({
        key: "booking.ask_received",
        variables: {
          venueName: "The Corner Stage",
          label: "Poster",
          note: "Portrait, please.",
          answerPhrase: "an image",
          targetUrl: URL,
        },
      });
      expect(out.push).toBeUndefined();
    });

    it("names the input for each kind", () => {
      const phrases = {
        FILE: "a file",
        LINK: "a link",
        TEXT: "a few words",
        SET_LENGTH: "a set length",
      } as const;
      for (const [kind, phrase] of Object.entries(phrases)) {
        expect(render("booking.ask-received", { ...base, kind }).inApp?.body).toBe(
          `Answer with ${phrase} on the request.`,
        );
      }
    });

    it("is strict: unknown keys, a bad kind and an over-long label are refused", () => {
      expect(() => render("booking.ask-received", { ...base, extra: 1 })).toThrow();
      expect(() => render("booking.ask-received", { ...base, kind: "POSTER" })).toThrow();
      expect(() => render("booking.ask-received", { ...base, label: "x".repeat(81) })).toThrow();
    });
  });

  describe("booking.ask-answered", () => {
    const base = {
      bookingRequestId: REQUEST,
      askId: ASK,
      answeredByName: "The Midnight Ramblers",
      kind: "SET_LENGTH",
      label: "Set length",
      targetUrl: URL,
    };

    it("is transactional and IN-APP ONLY", () => {
      const out = render("booking.ask-answered", base);
      expect(out.category).toBe("transactional");
      expect(out.inApp?.title).toBe("The Midnight Ramblers answered: Set length");
      expect(out.inApp?.action).toEqual({ label: "View the request", href: URL });
      expect(out.email).toBeUndefined();
      expect(out.push).toBeUndefined();
    });
  });
});
