import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * ActsRoster (`/p/[slug]/acts`, venue-track-record-and-review-switch FR-016,
 * ruling R9 "Roster"). Pins:
 *  - the REGULARS / RECENTLY split at three shows, and the order inside each;
 *  - a repeat act's "×N · last <date>" line versus a one-off's bare date, and
 *    the year suffix once a show is in another year;
 *  - the header line's three figures;
 *  - the empty state;
 *  - gate-aware links: names are text while `humanProfilesPublic` is off,
 *    links only when it is on AND the act has a profile URL.
 */

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as VenueStatsBlock.test.tsx).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
  // Pinned to en-US so the assertions do not depend on the machine's ICU.
  useFormatters: () => ({
    locale: "en-US",
    number: (v: number, o?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", o).format(v),
    currency: (v: number, c: string, o?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: c,
        ...o,
      }).format(v),
    dateTime: (v: Date | number | string, o?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", o).format(
        v instanceof Date ? v : new Date(v),
      ),
    getRawMessage: () => undefined,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ActsRoster } from "../_components/ActsRoster";
import {
  formatRelativePast,
  groupRoster,
  readTrackRecordSummary,
  type RosterAct,
} from "../_components/roster-helpers";

const TZ = "America/Chicago";
/** Thursday 2026-09-24, noon Central. */
const NOW = "2026-09-24T17:00:00.000Z";

/** 8pm Central on the given local date. */
const show = (local: string) => new Date(`${local}T20:00:00-05:00`).toISOString();

const act = (
  name: string,
  timesPlayed: number,
  lastLocal: string,
  profileUrl: string | null = `/humans/${name.toLowerCase().replace(/\s+/g, "-")}`,
): RosterAct => ({
  key: `n:${name.toLowerCase()}`,
  name,
  profileUrl,
  timesPlayed,
  lastPlayedAt: show(lastLocal),
});

const ACTS: RosterAct[] = [
  act("Cold Stomach", 3, "2026-09-08"),
  act("Tulip Sleep", 1, "2026-09-15"),
  act("Rat Cathedral", 5, "2026-09-15"),
  act("Grave Neighbors", 2, "2026-09-01"),
  act("Sister Furnace", 4, "2026-08-22"),
  act("The Long Hallway Orchestra", 3, "2025-06-02"),
  act("Damp Jacket", 1, "2026-08-22", null),
];

const SUMMARY = {
  showsHosted: 38,
  firstShowAt: show("2024-03-08"),
  lastShowAt: show("2026-09-15"),
  timeZone: TZ,
};
const EMPTY_SUMMARY = {
  showsHosted: 0,
  firstShowAt: null,
  lastShowAt: null,
  timeZone: null,
};

function renderRoster(overrides: Partial<Parameters<typeof ActsRoster>[0]> = {}) {
  return render(
    <ActsRoster
      venueName="Fishbowl House"
      venueHref="/p/fishbowl-house-00000000"
      acts={ACTS}
      summary={SUMMARY}
      linkProfiles={false}
      timeZone={TZ}
      nowIso={NOW}
      {...overrides}
    />,
  );
}

const namesIn = (region: HTMLElement): string[] =>
  within(region)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[title]")?.getAttribute("title") ?? "");

describe("ActsRoster — grouping and order", () => {
  it("puts an act with three shows in REGULARS and one with two in RECENTLY", () => {
    renderRoster();
    const regulars = screen.getByRole("region", { name: "actsRoster.regulars" });
    const recently = screen.getByRole("region", { name: "actsRoster.recently" });

    expect(namesIn(regulars)).toContain("Cold Stomach");
    expect(namesIn(recently)).toContain("Grave Neighbors");
    expect(namesIn(regulars)).not.toContain("Grave Neighbors");
  });

  it("orders REGULARS by times played, then most recent", () => {
    renderRoster();
    const regulars = screen.getByRole("region", { name: "actsRoster.regulars" });
    expect(namesIn(regulars)).toEqual([
      "Rat Cathedral", // ×5
      "Sister Furnace", // ×4
      "Cold Stomach", // ×3, Sep 8 2026
      "The Long Hallway Orchestra", // ×3, Jun 2 2025
    ]);
  });

  it("orders RECENTLY by most recent show", () => {
    renderRoster();
    const recently = screen.getByRole("region", { name: "actsRoster.recently" });
    expect(namesIn(recently)).toEqual([
      "Tulip Sleep", // Sep 15
      "Grave Neighbors", // Sep 1
      "Damp Jacket", // Aug 22
    ]);
  });

  it("omits a group that has nobody in it", () => {
    renderRoster({ acts: [act("Tulip Sleep", 1, "2026-09-15")] });
    expect(
      screen.queryByRole("region", { name: "actsRoster.regulars" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "actsRoster.recently" }),
    ).toBeInTheDocument();
  });
});

describe("ActsRoster — tiles", () => {
  it("prints ×N · last <date> for a repeat act and just the date for a one-off", () => {
    renderRoster();
    expect(
      screen.getByText("actsRoster.tileMeta times=5 date=Sep 15"),
    ).toBeInTheDocument();
    const tulip = screen.getByTitle("Tulip Sleep").parentElement!;
    expect(within(tulip).getByText("Sep 15")).toBeInTheDocument();
  });

  it("adds the year once the last show is in another year", () => {
    renderRoster();
    expect(
      screen.getByText("actsRoster.tileMeta times=3 date=Jun 2, 2025"),
    ).toBeInTheDocument();
  });

  it("carries the last show as a <time datetime> on every tile", () => {
    renderRoster();
    const times = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("time")?.getAttribute("datetime"));
    expect(times).toHaveLength(ACTS.length);
    expect(times).toContain(show("2026-09-15"));
    expect(times.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });
});

describe("ActsRoster — header line", () => {
  it("prints shows hosted, since <month year>, last <day> and a standalone relative phrase", () => {
    renderRoster();
    expect(screen.getByText("38")).toBeInTheDocument();
    expect(
      screen.getByText("actsRoster.headShows count=38"),
    ).toBeInTheDocument();
    expect(screen.getByText("Mar 2024")).toBeInTheDocument();
    // The figure after "last" is the absolute day (as on the venue block);
    // the relative phrase follows in parentheses and never wears the prefix.
    // Scoped to the header: a tile below also says "Sep 15".
    const header = within(screen.getByRole("heading", { level: 1 }).parentElement!);
    expect(header.getByText("Sep 15")).toBeInTheDocument();
    expect(header.getByText("(9 days ago)")).toBeInTheDocument();
  });

  it("carries first and last show as <time datetime>", () => {
    renderRoster();
    const times = Array.from(
      screen.getByRole("heading", { level: 1 }).parentElement!.querySelectorAll("time"),
    ).map((el) => el.getAttribute("datetime"));
    expect(times).toEqual([SUMMARY.firstShowAt, SUMMARY.lastShowAt]);
  });

  it("prints nothing when the venue has hosted nothing", () => {
    renderRoster({
      acts: [],
      summary: EMPTY_SUMMARY,
    });
    expect(screen.queryByText("actsRoster.headShows count=0")).toBeNull();
  });
});

describe("ActsRoster — empty state and chrome", () => {
  it("renders the empty line when nobody has played", () => {
    renderRoster({
      acts: [],
      summary: EMPTY_SUMMARY,
    });
    expect(screen.getByText("actsRoster.empty")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("says lineups are missing, not people, when shows were hosted but none has a lineup", () => {
    renderRoster({ acts: [], summary: SUMMARY });
    expect(screen.getByText("actsRoster.emptyNoLineups")).toBeInTheDocument();
    expect(screen.queryByText("actsRoster.empty")).toBeNull();
    // The header still prints the count the empty line must not contradict.
    expect(screen.getByText("38")).toBeInTheDocument();
  });

  it("leads with THE DOOR stamp, the heading and a way back to the venue", () => {
    renderRoster();
    expect(screen.getByText("actsRoster.tier")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "actsRoster.heading" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Fishbowl House" }),
    ).toHaveAttribute("href", "/p/fishbowl-house-00000000");
  });
});

describe("ActsRoster — gate-aware links", () => {
  it("renders every name as text while humanProfilesPublic is off", () => {
    renderRoster({ linkProfiles: false });
    // The only link on the page is the way back to the venue.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByTitle("Rat Cathedral").closest("a")).toBeNull();
  });

  it("links an act to its profile when the gate is on and it has one", () => {
    renderRoster({ linkProfiles: true });
    expect(
      screen.getByRole("link", { name: /Rat Cathedral/ }),
    ).toHaveAttribute("href", "/humans/rat-cathedral");
  });

  it("keeps an unlinked act as text even when the gate is on", () => {
    renderRoster({ linkProfiles: true });
    expect(screen.getByTitle("Damp Jacket").closest("a")).toBeNull();
  });
});

describe("ActsRoster — act identity", () => {
  // Linked human without a public page + an unlinked act of the same name:
  // name + profileUrl are identical, so only core's opaque key tells them
  // apart.
  const SAMS: RosterAct[] = [
    { ...act("Sam", 1, "2026-09-15", null), key: "h:0123456789ab" },
    { ...act("Sam", 1, "2026-09-01", null), key: "n:sam" },
  ];

  it("control: this environment's console.error spy DOES catch a duplicate React key", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ul>
          {["Sam", "Sam"].map((name, i) => (
            <li key={`name:${name}`}>{`${name} ${i}`}</li>
          ))}
        </ul>,
      );
      expect(consoleError).toHaveBeenCalled();
      expect(String(consoleError.mock.calls[0]?.[0])).toMatch(/same key/i);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("two same-name acts render as two tiles with no React key warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderRoster({ acts: SAMS });
      const recently = screen.getByRole("region", { name: "actsRoster.recently" });
      expect(namesIn(recently)).toEqual(["Sam", "Sam"]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("roster helpers", () => {
  it("groupRoster splits at three shows", () => {
    const { regulars, recently } = groupRoster(ACTS);
    expect(regulars.map((a) => a.timesPlayed).every((n) => n >= 3)).toBe(true);
    expect(recently.map((a) => a.timesPlayed).every((n) => n < 3)).toBe(true);
    expect(regulars.length + recently.length).toBe(ACTS.length);
  });

  it("readTrackRecordSummary reads only a server-marked track_record block", () => {
    const base = { id: "b", pageId: "p", orderIndex: 0, visible: true };
    expect(
      readTrackRecordSummary([
        {
          ...base,
          kind: "track_record",
          data: {
            dataSource: "track_record",
            showsHosted: 38,
            firstShowAt: SUMMARY.firstShowAt,
            lastShowAt: SUMMARY.lastShowAt,
            timeZone: TZ,
          },
        },
      ]),
    ).toEqual(SUMMARY);
    // A block from before the zone field (spec FU-001) reads as null, so the
    // page falls back to the platform zone rather than crashing.
    expect(
      readTrackRecordSummary([
        {
          ...base,
          kind: "track_record",
          data: { dataSource: "track_record", showsHosted: 3 },
        },
      ]).timeZone,
    ).toBeNull();
    // Owner-stored data (no marker) is never read as a figure.
    expect(
      readTrackRecordSummary([
        { ...base, kind: "track_record", data: { showsHosted: 999 } },
      ]),
    ).toEqual(EMPTY_SUMMARY);
    expect(readTrackRecordSummary([])).toEqual(EMPTY_SUMMARY);
  });

  it("formatRelativePast counts calendar days in the venue's zone, then months, then years", () => {
    const now = new Date(NOW);
    const rel = (from: Date) => formatRelativePast("en-US", from, now, TZ);
    const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
    expect(rel(daysAgo(0))).toBe("today");
    expect(rel(daysAgo(1))).toBe("yesterday");
    expect(rel(daysAgo(9))).toBe("9 days ago");
    // Months and years are always numeric: the phrase stands alone after an
    // absolute date, and "last month" / "last year" are not complete phrases.
    expect(rel(daysAgo(35))).toBe("1 month ago");
    expect(rel(daysAgo(61))).toBe("2 months ago");
    expect(rel(daysAgo(400))).toBe("1 year ago");
    expect(rel(daysAgo(800))).toBe("2 years ago");
    // An evening show on the 15th is 9 CALENDAR days before noon on the 24th,
    // though fewer than 9×24 hours have elapsed.
    expect(rel(new Date(show("2026-09-15")))).toBe("9 days ago");
    // A show that ended after `now` never reads as the future.
    expect(rel(daysAgo(-1))).toBe("today");
  });
});
