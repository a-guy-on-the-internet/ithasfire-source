import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { CALENDAR_FEED_COPY } from "../use-cases/comms/copy/calendar-feeds";
import {
  DEFAULT_ICAL_LABELS,
  escapeText,
  foldLine,
  generateSingleEventIcs,
  generateVenueCalendarFeed,
  googleCalendarUrl,
  outlookCalendarUrl,
  type ICalEvent,
} from "./ical";

const SAMPLE_EVENT: ICalEvent = {
  uid: "evt-123@ithasfire.com",
  title: "Summer Concert",
  startsAt: new Date("2026-07-15T19:00:00Z"),
  endsAt: new Date("2026-07-15T22:00:00Z"),
  location: "Skyline Rooftop, 123 Harbor Blvd, San Francisco, CA",
  description: "An evening of live music under the stars.",
  url: "https://ithasfire.com/events/summer-concert",
  geo: { lat: 37.7749, lng: -122.4194 },
};

describe("generateSingleEventIcs", () => {
  it("produces valid iCal output with required fields", () => {
    const ics = generateSingleEventIcs(SAMPLE_EVENT);

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("PRODID:-//Ithas Fire//Event//EN");
    expect(ics).toContain("CALSCALE:GREGORIAN");
    expect(ics).toContain("METHOD:PUBLISH");
  });

  it("includes event details", () => {
    const ics = generateSingleEventIcs(SAMPLE_EVENT);

    expect(ics).toContain("UID:evt-123@ithasfire.com");
    expect(ics).toContain("SUMMARY:Summer Concert");
    expect(ics).toContain("DTSTART:20260715T190000Z");
    expect(ics).toContain("DTEND:20260715T220000Z");
    expect(ics).toContain("LOCATION:Skyline Rooftop");
    expect(ics).toContain("DESCRIPTION:An evening of live music");
    expect(ics).toContain(
      "URL:https://ithasfire.com/events/summer-concert",
    );
    expect(ics).toContain("GEO:37.7749;-122.4194");
    expect(ics).toContain("STATUS:CONFIRMED");
  });

  it("defaults to 2h duration when endsAt is null", () => {
    const event: ICalEvent = {
      ...SAMPLE_EVENT,
      endsAt: null,
    };
    const ics = generateSingleEventIcs(event);

    expect(ics).toContain("DTSTART:20260715T190000Z");
    expect(ics).toContain("DTEND:20260715T210000Z");
  });

  it("escapes special characters in text fields", () => {
    const event: ICalEvent = {
      ...SAMPLE_EVENT,
      title: "Rock & Roll; Live, Tonight",
      description: "Line 1\nLine 2",
    };
    const ics = generateSingleEventIcs(event);

    expect(ics).toContain("SUMMARY:Rock & Roll\\; Live\\, Tonight");
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2");
  });

  it("uses CRLF line endings", () => {
    const ics = generateSingleEventIcs(SAMPLE_EVENT);
    expect(ics).toContain("\r\n");
    // Should not have bare LF (outside escaped text)
    const lines = ics.split("\r\n");
    for (const line of lines) {
      // Unfolded lines should not contain raw newlines
      if (line.length > 0 && !line.startsWith(" ")) {
        expect(line).not.toContain("\n");
      }
    }
  });
});

describe("generateVenueCalendarFeed", () => {
  it("produces a multi-event feed", () => {
    const events: ICalEvent[] = [
      SAMPLE_EVENT,
      {
        uid: "evt-456@ithasfire.com",
        title: "Jazz Night",
        startsAt: new Date("2026-07-20T20:00:00Z"),
        endsAt: new Date("2026-07-20T23:00:00Z"),
      },
    ];

    const ics = generateVenueCalendarFeed(events, {
      calendarName: "Skyline Rooftop — Ithas Fire",
    });

    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Skyline Rooftop");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    // Two VEVENTs
    const veventCount = (ics.match(/BEGIN:VEVENT/g) || []).length;
    expect(veventCount).toBe(2);
    expect(ics).toContain("SUMMARY:Summer Concert");
    expect(ics).toContain("SUMMARY:Jazz Night");
  });

  it("respects custom refresh interval", () => {
    const ics = generateVenueCalendarFeed([SAMPLE_EVENT], {
      calendarName: "Test Venue",
      refreshInterval: "PT30M",
    });

    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT30M");
    expect(ics).toContain("X-PUBLISHED-TTL:PT30M");
  });
});

describe("googleCalendarUrl", () => {
  it("generates a valid Google Calendar deep link", () => {
    const url = googleCalendarUrl(SAMPLE_EVENT);

    expect(url).toContain("https://calendar.google.com/calendar/render");
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("text=Summer+Concert");
    expect(url).toContain("dates=20260715T190000Z");
    expect(url).toContain("location=Skyline+Rooftop");
  });
});

describe("outlookCalendarUrl", () => {
  it("generates a valid Outlook deep link", () => {
    const url = outlookCalendarUrl(SAMPLE_EVENT);

    expect(url).toContain("https://outlook.live.com/calendar");
    expect(url).toContain("subject=Summer+Concert");
    expect(url).toContain("startdt=2026-07-15T19");
    expect(url).toContain("location=Skyline+Rooftop");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RFC 5545 hygiene (V4) and revision fields
// ─────────────────────────────────────────────────────────────────────────────

const utf8 = (text: string) => Buffer.byteLength(text, "utf8");
/** Undo RFC 5545 folding: CRLF followed by one space is removed. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

describe("foldLine — 75 octets of UTF-8, never inside a character", () => {
  it("leaves a line of exactly 75 octets alone", () => {
    const line = "X".repeat(75);
    expect(foldLine(line)).toBe(line);
  });

  it("folds ASCII at 75 octets; continuation lines are space + 74", () => {
    const line = "A".repeat(200);
    const parts = foldLine(line).split("\r\n");
    expect(parts.map(utf8)).toEqual([75, 75, 52]);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(unfold(foldLine(line))).toBe(line);
  });

  it("counts accented characters as two octets and never splits one", () => {
    const line = `SUMMARY:${"é".repeat(80)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) {
      expect(utf8(part)).toBeLessThanOrEqual(75);
      // A split two-byte sequence would decode to U+FFFD.
      expect(Buffer.from(part, "utf8").toString("utf8")).not.toContain("\uFFFD");
    }
    expect(unfold(folded)).toBe(line);
  });

  it("keeps an emoji surrogate pair (4 octets) whole across the fold boundary", () => {
    // 73 ASCII octets + a 4-octet emoji would be 77: the emoji must move
    // wholly onto the continuation line.
    const line = `${"B".repeat(73)}🎸🎸tail`;
    const parts = foldLine(line).split("\r\n");
    expect(parts[0]).toBe("B".repeat(73));
    expect(parts[1]!.startsWith(" 🎸")).toBe(true);
    for (const part of parts) {
      expect(utf8(part)).toBeLessThanOrEqual(75);
      expect(part).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
      expect(part).not.toMatch(/^ ?[\uDC00-\uDFFF]/); // no orphan low surrogate
    }
    expect(unfold(parts.join("\r\n"))).toBe(line);
  });

  it("every line of a generated event with long multi-byte text is ≤ 75 octets", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      title: "Noche de café con música en vivo 🎶 ".repeat(6),
      description: "Señoras y señores, ¡bienvenidos! 🎉 ".repeat(10),
    });
    for (const line of ics.split("\r\n")) {
      expect(utf8(line)).toBeLessThanOrEqual(75);
    }
  });
});

describe("escapeText — CR handling", () => {
  it("turns CRLF and a lone CR into one escaped newline each", () => {
    expect(escapeText("a\r\nb\rc\nd")).toBe("a\\nb\\nc\\nd");
  });

  it("never leaves a raw CR or LF in a generated line", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      title: "Line one\r\nLine two\rLine three",
      description: "x\r\ny",
    });
    expect(ics).toContain("SUMMARY:Line one\\nLine two\\nLine three");
    for (const line of ics.split("\r\n")) {
      expect(line).not.toMatch(/[\r\n]/);
    }
  });
});

describe("STATUS / SEQUENCE / LAST-MODIFIED", () => {
  it("defaults to CONFIRMED, SEQUENCE:0, no LAST-MODIFIED", () => {
    const ics = generateSingleEventIcs(SAMPLE_EVENT);
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("SEQUENCE:0");
    expect(ics).toContain("TRANSP:OPAQUE");
    expect(ics).not.toContain("LAST-MODIFIED");
  });

  it("emits a cancelled entry with its real title, SEQUENCE:1 and LAST-MODIFIED", () => {
    const ics = generateVenueCalendarFeed(
      [
        {
          ...SAMPLE_EVENT,
          status: "CANCELLED",
          sequence: 1,
          lastModified: new Date("2026-07-01T08:30:15.123Z"),
        },
      ],
      { calendarName: "Test" },
    );
    expect(ics).toContain("SUMMARY:Summer Concert");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SEQUENCE:1");
    expect(ics).toContain("LAST-MODIFIED:20260701T083015Z");
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).not.toContain("STATUS:CONFIRMED");
  });
});

describe("host name and URL", () => {
  it("never emits ORGANIZER; the host leads DESCRIPTION instead", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      organizerName: "Cobra; Nashville",
    });
    expect(ics).not.toContain("ORGANIZER");
    expect(ics).not.toContain("MAILTO");
    expect(unfold(ics)).toContain(
      "DESCRIPTION:Hosted by Cobra\\; Nashville\\nAn evening of live music under the stars.",
    );
  });

  it("emits DESCRIPTION for a host alone", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      description: null,
      organizerName: "The Club",
    });
    expect(ics).toContain("DESCRIPTION:Hosted by The Club");
  });

  it("does not text-escape a URL (commas, semicolons stay as-is)", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      url: "https://ithasfire.com/events/a,b;c?x=1&y=2",
    });
    expect(unfold(ics)).toContain("URL:https://ithasfire.com/events/a,b;c?x=1&y=2");
  });

  it("drops a URL that is not absolute http(s)", () => {
    for (const url of ["javascript:alert(1)", "/events/relative", "not a url"]) {
      const ics = generateSingleEventIcs({ ...SAMPLE_EVENT, url });
      expect(ics).not.toContain("URL:");
    }
  });

  it("a URL cannot smuggle a line break into the output", () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      url: "https://ithasfire.com/events/x\r\nATTACH:evil",
    });
    expect(ics).not.toMatch(/\r\nATTACH/);
  });
});

describe("cancelled DESCRIPTION order", () => {
  it('"Cancelled." leads, then the host, then the description', () => {
    const ics = generateSingleEventIcs({
      ...SAMPLE_EVENT,
      status: "CANCELLED",
      organizerName: "The Club",
      description: "https://ithasfire.com/events/x",
    });
    expect(unfold(ics)).toContain(
      "DESCRIPTION:Cancelled.\\nHosted by The Club\\nhttps://ithasfire.com/events/x",
    );
  });
});

describe("translated DESCRIPTION labels", () => {
  it("a feed with labels writes them; without labels it stays English", () => {
    const event = {
      ...SAMPLE_EVENT,
      status: "CANCELLED" as const,
      organizerName: "The Club",
      description: "https://ithasfire.com/events/x",
    };
    const labels = { cancelled: "Cancelado.", hostedBy: (h: string) => `Organiza: ${h}` };
    expect(unfold(generateVenueCalendarFeed([event], { calendarName: "x", labels }))).toContain(
      "DESCRIPTION:Cancelado.\\nOrganiza: The Club\\nhttps://ithasfire.com/events/x",
    );
    expect(unfold(generateVenueCalendarFeed([event], { calendarName: "x" }))).toContain(
      "DESCRIPTION:Cancelled.\\nHosted by The Club",
    );
  });
});

describe("end time rule (matches the web app: missing or not after start = +2h)", () => {
  const start = SAMPLE_EVENT.startsAt;
  const cases: Array<[string, Date | null, string, string]> = [
    ["null end", null, "20260715T210000Z", "2026-07-15T21:00:00.000Z"],
    ["end equal to start", start, "20260715T210000Z", "2026-07-15T21:00:00.000Z"],
    [
      "end before start",
      new Date("2026-07-15T18:00:00Z"),
      "20260715T210000Z",
      "2026-07-15T21:00:00.000Z",
    ],
    [
      "invalid date end",
      new Date("nope"),
      "20260715T210000Z",
      "2026-07-15T21:00:00.000Z",
    ],
    [
      "valid end unchanged",
      new Date("2026-07-15T22:00:00Z"),
      "20260715T220000Z",
      "2026-07-15T22:00:00.000Z",
    ],
  ];
  for (const [name, endsAt, compact, iso] of cases) {
    it(`${name}`, () => {
      const event: ICalEvent = { ...SAMPLE_EVENT, endsAt };
      expect(generateSingleEventIcs(event)).toContain(`DTEND:${compact}`);
      expect(googleCalendarUrl(event)).toContain(`%2F${compact}`);
      expect(outlookCalendarUrl(event)).toContain(
        `enddt=${encodeURIComponent(iso)}`,
      );
    });
  }
});

// The lib's English defaults duplicate the feeds' English copy module
// (`CALENDAR_FEED_COPY.en`): the lib stays locale-agnostic and must not import
// a use-case module, so the duplicate stays and this pins the two together.
describe("DEFAULT_ICAL_LABELS parity with CALENDAR_FEED_COPY.en", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("every default label has the same words as the English copy", () => {
    const en = CALENDAR_FEED_COPY.en as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(DEFAULT_ICAL_LABELS)) {
      expect(en, `CALENDAR_FEED_COPY.en lacks "${key}"`).toHaveProperty(key);
      if (typeof value === "function") {
        expect(value("X")).toBe((en[key] as (h: string) => string)("X"));
      } else {
        expect(value).toBe(en[key]);
      }
    }
    expect(DEFAULT_ICAL_LABELS.cancelled).toBe(CALENDAR_FEED_COPY.en.cancelled);
    expect(DEFAULT_ICAL_LABELS.hostedBy("X")).toBe(
      CALENDAR_FEED_COPY.en.hostedBy("X"),
    );
  });

  it("a cancelled, hosted show renders byte-identically with the defaults and with the English copy", () => {
    const en = CALENDAR_FEED_COPY.en;
    const show: ICalEvent = {
      ...SAMPLE_EVENT,
      status: "CANCELLED",
      organizerName: "X",
    };
    const calendarName = `${en.hostCalendar} — Ithas Fire`;
    const withDefaults = generateVenueCalendarFeed([show], { calendarName });
    const withEnglishCopy = generateVenueCalendarFeed([show], {
      calendarName,
      labels: { cancelled: en.cancelled, hostedBy: en.hostedBy },
    });

    expect(withDefaults).toBe(withEnglishCopy);
    const unfolded = withDefaults.replace(/\r\n /g, "");
    expect(unfolded).toContain("DESCRIPTION:Cancelled.\\nHosted by X\\n");
    expect(unfolded).toContain("X-WR-CALNAME:Host calendar — Ithas Fire");
  });
});
