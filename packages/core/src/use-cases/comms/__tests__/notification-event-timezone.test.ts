import { describe, expect, it } from "vitest";

import { renderNotification } from "../renderers";

// `event.changed` (rescheduled) and `volunteer.occurrence-cancelled` read the
// start in the zone the payload carries (added 2026-10-05). Rows stored before
// that have no `timezone`; they used to render in UTC, the server's zone,
// which put an evening start on the next day ("you're no longer expected that
// day" named the wrong day). Since 2026-10-16 they read in the platform
// default zone (America/Chicago), like every other zone-less date. The
// printed zone name keeps the instant right whichever zone it reads in.

const NOW = new Date("2026-11-01T12:00:00Z");
const E = "3f1c8d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const ASK = "11111111-0000-4000-8000-000000000001";
const OCC = "66666666-0000-4000-8000-000000000006";
const EVENT_URL = "https://ithas.fire/e/night-market";
// Fri Nov 13 2026, 7:30 PM in Chicago (CST, UTC-6); 01:30 UTC on the 14th.
const START = "2026-11-14T01:30:00.000Z";
const TZ = "America/Chicago";

const render = (variant: string, payload: unknown, locale: "en" | "es") =>
  renderNotification(variant, payload, { now: NOW, locale });

// ICU may put a narrow no-break space before AM/PM; compare on plain spaces.
const plain = (s: string | null | undefined) =>
  (s ?? "").replace(/[  ]/gu, " ");

describe("event.changed (rescheduled) time zone", () => {
  const oldShape = {
    eventId: E,
    eventTitle: "Night Market",
    changeType: "RESCHEDULED",
    newStartsAt: START,
    newEndsAt: null,
    eventUrl: EVENT_URL,
  } as const;
  const withTz = { ...oldShape, timezone: TZ };

  it("en: with a timezone, the new start reads in the event's zone", () => {
    const out = render("event.changed", withTz, "en");
    expect(plain(out.inApp?.body)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    // Email (and push, which has none here) say the same English as in-app.
    expect(plain(out.email?.text)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
  });

  it("es: with a timezone, the new start reads in the event's zone", () => {
    const out = render("event.changed", withTz, "es");
    expect(out.inApp?.title).toBe("Evento reprogramado");
    expect(plain(out.inApp?.body)).toBe(
      "Night Market tiene una nueva fecha. Ahora empieza el viernes 13 de noviembre de 2026 a las 19:30 (GMT-6).",
    );
    // Email stays English in every locale.
    expect(out.email).toEqual(render("event.changed", withTz, "en").email);
  });

  it("en: a Los Angeles event's 10:30 PM start stays on Friday", () => {
    // 22:30 PST Fri Nov 13 = 06:30Z Sat Nov 14 (00:30 CST, also Saturday).
    const out = render(
      "event.changed",
      { ...oldShape, newStartsAt: "2026-11-14T06:30:00.000Z", timezone: "America/Los_Angeles" },
      "en",
    );
    expect(plain(out.email?.text)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 10:30 PM PST.",
    );
  });

  it("old rows (no timezone) read in the platform default, not UTC, en and es", () => {
    expect(plain(render("event.changed", oldShape, "en").inApp?.body)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    expect(plain(render("event.changed", oldShape, "en").email?.text)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
    expect(plain(render("event.changed", oldShape, "es").inApp?.body)).toBe(
      "Night Market tiene una nueva fecha. Ahora empieza el viernes 13 de noviembre de 2026 a las 19:30 (GMT-6).",
    );
  });

  it("a null timezone renders exactly like a missing one", () => {
    for (const locale of ["en", "es"] as const) {
      expect(
        render("event.changed", { ...oldShape, timezone: null }, locale),
      ).toEqual(render("event.changed", oldShape, locale));
    }
  });

  it("an unknown zone falls back to the platform default instead of throwing", () => {
    const out = render(
      "event.changed",
      { ...oldShape, timezone: "Not/AZone" },
      "en",
    );
    expect(plain(out.inApp?.body)).toBe(
      "Night Market has a new date. It now starts Fri, Nov 13, 2026, 7:30 PM CST.",
    );
  });
});

describe("volunteer.occurrence-cancelled time zone", () => {
  const oldShape = {
    askId: ASK,
    askTitle: "Festival Crew",
    occurrenceId: OCC,
    roleName: "Security",
    startsAtIso: START,
    endsAtIso: "2026-11-14T05:30:00.000Z",
    askUrl: "https://ithas.fire/v/x",
  };
  const withTz = { ...oldShape, timezone: TZ };

  it("en: with a timezone, the start reads in that zone, in-app and email", () => {
    const out = render("volunteer.occurrence-cancelled", withTz, "en");
    const body =
      "The Security shift you claimed for Festival Crew (Fri, Nov 13, 2026, 7:30 PM CST) has been cancelled. No action needed — you're no longer expected that day.";
    expect(plain(out.inApp?.body)).toBe(body);
    expect(plain(out.email?.text)).toBe(
      `${body}\n\nView the schedule: https://ithas.fire/v/x`,
    );
  });

  it("es: with a timezone, the start reads in that zone", () => {
    const out = render("volunteer.occurrence-cancelled", withTz, "es");
    expect(plain(out.inApp?.body)).toBe(
      "Se canceló tu turno de Security en Festival Crew del viernes 13 de noviembre de 2026 a las 19:30 (GMT-6). No tienes que hacer nada: ya no te esperan ese día.",
    );
    expect(out.email).toEqual(
      render("volunteer.occurrence-cancelled", withTz, "en").email,
    );
  });

  it("en: a Los Angeles shift at 10:30 PM stays on Friday", () => {
    // 22:30 PST Fri Nov 13 = 06:30Z Sat Nov 14 (00:30 CST, also Saturday).
    const out = render(
      "volunteer.occurrence-cancelled",
      {
        ...oldShape,
        startsAtIso: "2026-11-14T06:30:00.000Z",
        endsAtIso: "2026-11-14T08:30:00.000Z",
        timezone: "America/Los_Angeles",
      },
      "en",
    );
    expect(plain(out.inApp?.body)).toBe(
      "The Security shift you claimed for Festival Crew (Fri, Nov 13, 2026, 10:30 PM PST) has been cancelled. No action needed — you're no longer expected that day.",
    );
  });

  it("old rows (no timezone) read in the platform default, not UTC, en and es", () => {
    const body =
      "The Security shift you claimed for Festival Crew (Fri, Nov 13, 2026, 7:30 PM CST) has been cancelled. No action needed — you're no longer expected that day.";
    const en = render("volunteer.occurrence-cancelled", oldShape, "en");
    expect(plain(en.inApp?.body)).toBe(body);
    expect(plain(en.email?.text)).toBe(
      `${body}\n\nView the schedule: https://ithas.fire/v/x`,
    );
    expect(
      plain(render("volunteer.occurrence-cancelled", oldShape, "es").inApp?.body),
    ).toBe(
      "Se canceló tu turno de Security en Festival Crew del viernes 13 de noviembre de 2026 a las 19:30 (GMT-6). No tienes que hacer nada: ya no te esperan ese día.",
    );
  });

  it("a null timezone renders exactly like a missing one", () => {
    for (const locale of ["en", "es"] as const) {
      expect(
        render(
          "volunteer.occurrence-cancelled",
          { ...oldShape, timezone: null },
          locale,
        ),
      ).toEqual(render("volunteer.occurrence-cancelled", oldShape, locale));
    }
  });
});
