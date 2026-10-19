import { describe, expect, it } from "vitest";

import { NOTIFICATION_LOCALES } from "../locale";
import { renderNotification } from "../renderers";

const NOW = new Date("2026-11-01T12:00:00Z");

const PAYLOAD = {
  eventId: "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
  eventTitle: "Open Mic Night",
  startsAtIso: "2026-11-14T01:30:00.000Z",
  timezone: "America/Chicago",
  venueName: "The Hall",
  addressText: "123 Main St",
  eventUrl: "https://ithas.fire/e/open-mic-night",
  manageRsvpsUrl: "https://ithas.fire/my-rsvps",
};

// ICU puts a narrow no-break space before "PM"; compare on plain spaces.
const plain = (s: string | null | undefined) =>
  (s ?? "").replace(/ /gu, " ");

describe("rsvp.confirmed copy by locale", () => {
  it("renders English exactly as before the copy moved (no locale given)", () => {
    const out = renderNotification("rsvp.confirmed", PAYLOAD, { now: NOW });

    expect(out.inApp?.title).toBe("You're going to Open Mic Night");
    expect(plain(out.inApp?.body)).toBe(
      "Your RSVP for Open Mic Night is confirmed. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    expect(out.inApp?.action).toEqual({
      label: "View event",
      route: "/e/open-mic-night",
    });
    expect(out.email?.subject).toBe("You're going to Open Mic Night");
    expect(plain(out.email?.text)).toBe(
      [
        "Your RSVP for Open Mic Night is confirmed. It starts Fri, Nov 13, 2026, 7:30 PM CST.",
        "Where: The Hall",
        "Address: 123 Main St",
        "View the event: https://ithas.fire/e/open-mic-night",
        "Changed your plans? Manage your RSVPs: https://ithas.fire/my-rsvps",
      ].join("\n\n"),
    );
  });

  it("an explicit 'en' is identical to no locale", () => {
    expect(
      renderNotification("rsvp.confirmed", PAYLOAD, { now: NOW, locale: "en" }),
    ).toEqual(renderNotification("rsvp.confirmed", PAYLOAD, { now: NOW }));
  });

  it("renders the in-app copy in Spanish, with the date formatted in Spanish", () => {
    const out = renderNotification("rsvp.confirmed", PAYLOAD, {
      now: NOW,
      locale: "es",
    });

    expect(out.inApp?.title).toBe("Vas a ir a Open Mic Night");
    // Long weekday, "de" month "de" year, "a las" 24h time, zone in parens.
    // The zone name is whatever ICU gives for "es" (CST or GMT-6): pin the shape.
    const body = (out.inApp?.body ?? "").replace(/[\u202f\u00a0]/gu, " ");
    expect(body).toMatch(
      /^Tu asistencia a Open Mic Night está confirmada\. Empieza el viernes 13 de noviembre de 2026 a las 19:30 \([^)]+\)\.$/u,
    );
    expect(out.inApp?.action).toEqual({
      label: "Ver evento",
      route: "/e/open-mic-night",
    });
  });

  it("keeps email English whatever the locale (email locale is a later task)", () => {
    const en = renderNotification("rsvp.confirmed", PAYLOAD, { now: NOW });
    const es = renderNotification("rsvp.confirmed", PAYLOAD, {
      now: NOW,
      locale: "es",
    });
    expect(es.email).toEqual(en.email);
    expect(es.fingerprint).toEqual(en.fingerprint);
  });

  it("omits the date sentence in every locale when the start is unparseable", () => {
    for (const locale of NOTIFICATION_LOCALES) {
      const out = renderNotification(
        "rsvp.confirmed",
        { ...PAYLOAD, startsAtIso: "not-a-date" },
        { now: NOW, locale },
      );
      expect(out.inApp?.body).not.toMatch(/starts|Empieza/u);
      expect(out.inApp?.body.endsWith(".")).toBe(true);
    }
  });

  it("renders without throwing in every locale with a minimal payload (no URL → no action)", () => {
    for (const locale of NOTIFICATION_LOCALES) {
      const out = renderNotification(
        "rsvp.confirmed",
        {
          eventId: PAYLOAD.eventId,
          eventTitle: "X",
          startsAtIso: PAYLOAD.startsAtIso,
          timezone: "Not/AZone",
        },
        { now: NOW, locale },
      );
      expect(out.inApp?.title).toContain("X");
      expect(out.inApp?.action).toBeNull();
    }
  });
});
