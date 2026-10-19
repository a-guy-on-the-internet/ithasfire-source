import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatEventDate,
  formatEventStart,
  formatEventTime,
} from "../copy/common";

// ICU may put narrow no-break spaces in en output; compare on plain spaces.
const plain = (s: string | null) => (s ?? "").replace(/[  ]/gu, " ");
const CHI = "America/Chicago";

afterEach(() => vi.restoreAllMocks());

describe("formatEventStart / Date / Time", () => {
  it("es: pins the full phrase, and its date and time halves", () => {
    const iso = "2026-11-14T01:30:00.000Z";
    expect(plain(formatEventStart("es", iso, CHI))).toBe(
      "viernes 13 de noviembre de 2026 a las 19:30 (GMT-6)",
    );
    expect(plain(formatEventDate("es", iso, CHI))).toBe(
      "viernes 13 de noviembre de 2026",
    );
    expect(plain(formatEventTime("es", iso, CHI))).toBe("19:30 (GMT-6)");
  });

  it("es: midnight reads 0:05, not 24:05 or 00:05", () => {
    // 06:05Z = 00:05 CST
    expect(plain(formatEventStart("es", "2026-11-14T06:05:00.000Z", CHI))).toBe(
      "sábado 14 de noviembre de 2026 a las 0:05 (GMT-6)",
    );
  });

  it("es: a 1 o'clock hour says 'a la', not 'a las'", () => {
    // 07:30Z = 01:30 CST
    expect(plain(formatEventStart("es", "2026-11-14T07:30:00.000Z", CHI))).toBe(
      "sábado 14 de noviembre de 2026 a la 1:30 (GMT-6)",
    );
  });

  // UTC was the server's zone, not the event's: it put a 7:30 PM Chicago
  // show on Saturday. A missing or unknown zone now reads in the platform
  // default, like every other zone-less date.
  it.each([null, undefined, "", "Not/AZone"])(
    "es: a missing or invalid timezone (%s) falls back to the platform default",
    (zone) => {
      expect(
        plain(formatEventStart("es", "2026-11-14T01:30:00.000Z", zone)),
      ).toBe("viernes 13 de noviembre de 2026 a las 19:30 (GMT-6)");
    },
  );

  it.each([null, undefined, "Not/AZone"])(
    "en: a missing or invalid timezone (%s) falls back to the platform default",
    (zone) => {
      expect(plain(formatEventStart("en", "2026-11-14T01:30:00.000Z", zone))).toBe(
        "Fri, Nov 13, 2026, 7:30 PM CST",
      );
      expect(plain(formatEventDate("en", "2026-11-14T01:30:00.000Z", zone))).toBe(
        "Fri, Nov 13, 2026",
      );
    },
  );

  it("en: a Los Angeles 10:30 PM start stays on Friday", () => {
    // 22:30 PST Fri Nov 13 = 06:30Z Sat Nov 14 (00:30 CST, also Saturday).
    expect(
      plain(formatEventStart("en", "2026-11-14T06:30:00.000Z", "America/Los_Angeles")),
    ).toBe("Fri, Nov 13, 2026, 10:30 PM PST");
  });

  it("an explicit UTC zone stays UTC (stored calendar days)", () => {
    expect(plain(formatEventDate("en", "2026-11-14T01:30:00.000Z", "UTC"))).toBe(
      "Sat, Nov 14, 2026",
    );
  });

  it("es: a missing part falls back to the plain Intl format", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(
      [],
    );
    const out = formatEventStart("es", "2026-11-14T01:30:00.000Z", CHI);
    // The fallback still carries the date and the 24h time.
    expect(plain(out)).toMatch(/2026/);
    expect(plain(out)).toMatch(/19:30/);
    expect(out).not.toContain(" de  de ");
    expect(out).not.toContain("()");
  });

  it("returns null for an unparseable ISO", () => {
    expect(formatEventStart("es", "nope", CHI)).toBeNull();
    expect(formatEventStart("en", "nope", CHI)).toBeNull();
  });

  it("en: dateTime keeps the pre-locale output", () => {
    expect(
      plain(formatEventStart("en", "2026-11-14T01:30:00.000Z", CHI)),
    ).toBe("Fri, Nov 13, 2026, 7:30 PM CST");
  });

  it("en: the date and time halves match the dateTime phrasing", () => {
    const iso = "2026-11-14T01:30:00.000Z";
    expect(plain(formatEventDate("en", iso, CHI))).toBe("Fri, Nov 13, 2026");
    expect(plain(formatEventTime("en", iso, CHI))).toBe("7:30 PM CST");
  });
});
