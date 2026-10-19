import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { makeFeatureGates } from "@/lib/feature-gates/test-helpers";

/**
 * TrackRecordBlock (venue-track-record-and-review-switch R8/R9, FR-011,
 * FR-015, NFR-006): the "Ledger" render of the server-injected
 * `track_record` payload. Pins:
 *  - the trusted-marker discipline (no `dataSource: "track_record"` → null),
 *  - the THE DOOR stamp + heading, the three `<dl>` cells with real
 *    `<time datetime>` values, the derived second lines ("14 this year",
 *    "2½ years running", the relative last-show line),
 *  - the cadence line (present iff `cadence` is set),
 *  - the acts list as a real `<ul>` with ×N for regulars and the
 *    "All N acts →" link to `/p/{slug}/acts`,
 *  - gate-aware act links: `/humans/*` 404s while `humanProfilesPublic` is
 *    off, so names are plain text unless the gate is on AND a profile exists,
 *  - the EMPTY state renders (the block is pinned — it never vanishes), and
 *  - the editor placeholder.
 *
 * WHAT THIS CANNOT SEE: the 320px fit of three tracked uppercase labels, and
 * whether the SSR'd dates hydrate clean against a browser in another zone.
 * Both are checked in the real page.
 */

const gateMocks = vi.hoisted(() => ({
  humanProfilesPublic: false,
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({
    gates: makeFeatureGates({
      humanProfilesPublic: gateMocks.humanProfilesPublic,
    }),
    isLoading: false,
  }),
}));

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
  // PINNED to en-US, as the sibling block tests are: the component formats
  // off the APP locale, so these assertions are not at the mercy of the
  // machine's ICU default.
  useFormatters: () => ({
    locale: "en-US",
    number: (v: number, o?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", o).format(v),
    currency: (v: number, c: string, o?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat("en-US", { style: "currency", currency: c, ...o }).format(v),
    dateTime: (v: Date | number | string, o?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", o).format(
        v instanceof Date ? v : new Date(v),
      ),
    getRawMessage: () => undefined,
  }),
}));

import {
  TrackRecordBlock,
  formatHalfYears,
  formatRelativeDays,
  yearOf,
} from "../TrackRecordBlock";
import { BlockPageOwnerProvider } from "../block-page-owner-context";
import { BlockRenderModeProvider } from "../block-render-context";

const DAY_MS = 86_400_000;

function makeBlock(data: unknown): PageBlockRecord {
  return {
    id: "block-1",
    pageId: "page-1",
    kind: "track_record",
    orderIndex: 0,
    data,
    visible: true,
  };
}

function renderBlock(data: unknown) {
  return render(
    <BlockPageOwnerProvider
      owner={{
        place: {
          id: "place-1",
          name: "Fishbowl House",
          acceptsRequests: true,
          pageSlug: "fishbowl-house",
        },
      }}
    >
      <TrackRecordBlock block={makeBlock(data)} />
    </BlockPageOwnerProvider>,
  );
}

const NINE_DAYS_AGO = new Date(Date.now() - 9 * DAY_MS).toISOString();

/** The artifact's populated frame: 38 shows, weekly since April, 61 acts.
 *  Dated in the VENUE's zone (spec FU-001): every instant below is a Central
 *  evening that is already the next day in UTC. */
const FULL_DATA = {
  dataSource: "track_record",
  timeZone: "America/Chicago",
  showsHosted: 38,
  showsThisYear: 14,
  // 2024-03-08 21:00 CST — "Mar 2024" either way; the day matters below.
  firstShowAt: "2024-03-09T03:00:00.000Z",
  yearsRunning: 2.5,
  lastShowAt: NINE_DAYS_AGO,
  cadence: "weekly",
  cadenceSince: "2026-04-03T00:00:00.000Z",
  recentActs: [
    { key: "h:aaaaaaaaaaaa", name: "Rat Cathedral", profileUrl: "/humans/rat-cathedral", timesPlayed: 5 },
    { key: "h:bbbbbbbbbbbb", name: "Cold Stomach", profileUrl: "/humans/cold-stomach", timesPlayed: 3 },
    { key: "n:tulip sleep", name: "Tulip Sleep", profileUrl: null, timesPlayed: 1 },
    { key: "h:cccccccccccc", name: "Grave Neighbors", profileUrl: "/humans/grave-neighbors", timesPlayed: 2 },
  ],
  allActsCount: 61,
};

const EMPTY_DATA = {
  dataSource: "track_record",
  timeZone: "America/Chicago",
  showsHosted: 0,
  showsThisYear: 0,
  firstShowAt: null,
  yearsRunning: null,
  lastShowAt: null,
  cadence: null,
  cadenceSince: null,
  recentActs: [],
  allActsCount: 0,
};

beforeEach(() => {
  gateMocks.humanProfilesPublic = false;
});

describe("TrackRecordBlock", () => {
  it("renders the stamp, heading, three ledger cells with <time datetime>, cadence, acts and footer", () => {
    const { container } = renderBlock(FULL_DATA);

    // R8: the stamp is the bare noun, first; the heading carries the sentence.
    expect(screen.getByText("trackRecord.tier")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "trackRecord.heading" }),
    ).toBeInTheDocument();

    // FR-015: the section is a NAMED landmark carrying the provenance.
    expect(
      screen.getByRole("region", {
        name: "trackRecord.blockLabel heading=trackRecord.heading",
      }),
    ).toBeInTheDocument();

    // NFR-006: a real definition list, three term/value pairs.
    const dl = container.querySelector("dl");
    expect(dl).not.toBeNull();
    const terms = within(dl as HTMLElement).getAllByRole("term");
    expect(terms).toHaveLength(3);
    expect(within(dl as HTMLElement).getAllByRole("definition")).toHaveLength(3);
    expect(terms[0]).toHaveTextContent("trackRecord.showsHosted");
    expect(terms[1]).toHaveTextContent("trackRecord.firstShow");
    expect(terms[2]).toHaveTextContent("trackRecord.lastShow");

    // Shows hosted + "14 this year".
    expect(screen.getByText("38")).toBeInTheDocument();
    expect(screen.getByText("trackRecord.thisYear count=14")).toBeInTheDocument();

    // First show: month + year in UTC, the instant on the attribute,
    // and 2.5 → "2½ years running".
    const first = screen.getByText("Mar 2024");
    expect(first.tagName).toBe("TIME");
    expect(first).toHaveAttribute("datetime", "2024-03-09T03:00:00.000Z");
    expect(
      screen.getByText("trackRecord.yearsRunning years=2½"),
    ).toBeInTheDocument();

    // Last show: day + month (no year — there were shows this year) in the
    // VENUE's zone, the instant on the attribute, and the relative line.
    const expectedLast = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "America/Chicago",
    }).format(new Date(NINE_DAYS_AGO));
    const last = screen.getByText(expectedLast);
    expect(last.tagName).toBe("TIME");
    expect(last).toHaveAttribute("datetime", NINE_DAYS_AGO);
    expect(screen.getByText("9 days ago")).toBeInTheDocument();

    // R9: one derived cadence sentence — "Weekly since Apr".
    expect(
      screen.getByText("trackRecord.cadenceWeekly since=Apr"),
    ).toBeInTheDocument();

    // The acts: a real <ul> (explicit role, since list-style:none strips it
    // in WebKit), regulars marked, the Roster link on the label row.
    expect(screen.getByText("trackRecord.playedRecently")).toBeInTheDocument();
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("role", "list");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Rat Cathedral×5trackRecord.timesPlayed count=5",
      "Cold Stomach×3trackRecord.timesPlayed count=3",
      "Tulip Sleep",
      "Grave Neighbors×2trackRecord.timesPlayed count=2",
    ]);
    expect(
      screen.getByRole("link", { name: "trackRecord.allActs count=61" }),
    ).toHaveAttribute("href", "/p/fishbowl-house/acts");

    expect(screen.getByText("trackRecord.foot")).toBeInTheDocument();
    expect(screen.queryByText("trackRecord.footEmpty")).not.toBeInTheDocument();
  });

  it("two acts with the SAME name and no profile (linked-no-page + unlinked) render as two rows with no React key warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderBlock({
        ...FULL_DATA,
        recentActs: [
          // Linked human without a public page → profileUrl null …
          { key: "h:0123456789ab", name: "Sam", profileUrl: null, timesPlayed: 2 },
          // … and a free-text "Sam": name + profileUrl are identical.
          { key: "n:sam", name: "Sam", profileUrl: null, timesPlayed: 1 },
        ],
      });

      expect(screen.getAllByText("Sam")).toHaveLength(2);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders act names as plain text while the human-profiles gate is off", () => {
    gateMocks.humanProfilesPublic = false;
    renderBlock(FULL_DATA);

    // The only link in the block is the Roster link.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/p/fishbowl-house/acts");
    expect(screen.getByText("Rat Cathedral").tagName).toBe("SPAN");
  });

  it("links acts with a profile when the gate is on, and keeps unlinked acts as text", () => {
    gateMocks.humanProfilesPublic = true;
    renderBlock(FULL_DATA);

    expect(screen.getByRole("link", { name: "Rat Cathedral" })).toHaveAttribute(
      "href",
      "/humans/rat-cathedral",
    );
    // `profileUrl: null` → no anchor, gate or no gate.
    expect(screen.getByText("Tulip Sleep").tagName).toBe("SPAN");
    expect(
      screen.queryByRole("link", { name: "Tulip Sleep" }),
    ).not.toBeInTheDocument();
  });

  it("omits the cadence line when cadence is null", () => {
    renderBlock({ ...FULL_DATA, cadence: null, cadenceSince: null });
    expect(screen.queryByText(/trackRecord\.cadence/)).not.toBeInTheDocument();
  });

  it("SAYS 'none this year' when there were none, and spells the last show's year out", () => {
    renderBlock({
      ...FULL_DATA,
      showsThisYear: 0,
      // 2025-11-20 23:00 CST — Nov 21 in UTC, Nov 20 in the venue's zone.
      lastShowAt: "2025-11-21T05:00:00.000Z",
    });
    expect(screen.getByText("trackRecord.thisYearNone")).toBeInTheDocument();
    expect(screen.queryByText(/thisYear count=/)).not.toBeInTheDocument();
    // No shows this year ⇒ the last show cannot be this year ⇒ its year shows.
    expect(screen.getByText("Nov 20, 2025")).toBeInTheDocument();
  });

  it("dates every figure in the VENUE's zone, never UTC (FU-001)", () => {
    // Fishbowl's real row: a Thursday show ending 23:00 CDT on Sep 17 is
    // 04:00Z on Sep 18. The Roster page says Sep 17; so must this block.
    renderBlock({
      ...FULL_DATA,
      lastShowAt: "2026-09-18T04:00:00.000Z",
      // Dec 31 23:30 CST 2025 = Jan 1 05:30Z 2026 — the first show is 2025.
      firstShowAt: "2026-01-01T05:30:00.000Z",
      // Run started Jan 1 04:00Z = Dec 31 22:00 CST → a different year from
      // the last show, so the month carries its year.
      cadenceSince: "2026-01-01T04:00:00.000Z",
    });
    const last = screen.getByText("Sep 17");
    expect(last.tagName).toBe("TIME");
    expect(last).toHaveAttribute("datetime", "2026-09-18T04:00:00.000Z");
    expect(screen.getByText("Dec 2025")).toBeInTheDocument();
    expect(
      screen.getByText("trackRecord.cadenceWeekly since=Dec 2025"),
    ).toBeInTheDocument();
  });

  it("falls back to the platform default zone when the payload carries none", () => {
    // A stale ISR entry or a pre-column cache can still hand the block a
    // payload without the key; the fallback is Central, so the same instant
    // still prints a venue-local day rather than a UTC one.
    const { timeZone: _omit, ...withoutZone } = FULL_DATA;
    void _omit;
    renderBlock({ ...withoutZone, lastShowAt: "2026-09-18T04:00:00.000Z" });
    expect(screen.getByText("Sep 17")).toBeInTheDocument();
  });

  it("uses the singular for exactly one year running, and the half for under one", () => {
    renderBlock({ ...FULL_DATA, yearsRunning: 1 });
    expect(screen.getByText("trackRecord.yearsRunningOne")).toBeInTheDocument();
  });

  it("says '½ year running' under one year", () => {
    renderBlock({ ...FULL_DATA, yearsRunning: 0.5 });
    expect(screen.getByText("trackRecord.yearsRunningHalf")).toBeInTheDocument();
  });

  it("renders the EMPTY state rather than nothing — the block is pinned", () => {
    renderBlock(EMPTY_DATA);

    expect(screen.getByText("trackRecord.tier")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "trackRecord.heading" }),
    ).toBeInTheDocument();
    expect(screen.getByText("trackRecord.empty")).toBeInTheDocument();
    expect(screen.getByText("trackRecord.footEmpty")).toBeInTheDocument();
    expect(screen.queryByRole("term")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("prefers the owner's heading when set", () => {
    renderBlock({ ...FULL_DATA, heading: "The room so far" });
    expect(
      screen.getByRole("heading", { name: "The room so far" }),
    ).toBeInTheDocument();
  });

  it("renders NOTHING without the server marker (owner-stored data can never carry it)", () => {
    const { container } = renderBlock({ ...FULL_DATA, dataSource: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the labelled, not-editable placeholder in the editor", () => {
    render(
      <BlockRenderModeProvider mode="editor">
        <TrackRecordBlock block={makeBlock({ heading: "x" })} />
      </BlockRenderModeProvider>,
    );
    expect(screen.getByText("admin.peBlockKindTrackRecord")).toBeInTheDocument();
    expect(
      screen.getByText("admin.peBlockFieldTrackRecordHelp"),
    ).toBeInTheDocument();
  });
});

describe("formatHalfYears", () => {
  it("prints halves as the fraction glyph", () => {
    expect(formatHalfYears(2.5)).toBe("2½");
    expect(formatHalfYears(3)).toBe("3");
    expect(formatHalfYears(0.5)).toBe("½");
  });
});

describe("yearOf", () => {
  it("reads the year in the venue's zone, not UTC", () => {
    expect(yearOf("2026-01-01T05:30:00.000Z", "America/Chicago")).toBe(2025);
    expect(yearOf("2026-01-01T05:30:00.000Z", "UTC")).toBe(2026);
    expect(Number.isNaN(yearOf("nope", "America/Chicago"))).toBe(true);
  });
});

describe("formatRelativeDays", () => {
  const now = Date.UTC(2026, 8, 24, 12);

  it("buckets days, months and years", () => {
    expect(formatRelativeDays("en-US", new Date(now - 9 * DAY_MS).toISOString(), now)).toBe(
      "9 days ago",
    );
    expect(formatRelativeDays("en-US", new Date(now - 1 * DAY_MS).toISOString(), now)).toBe(
      "yesterday",
    );
    expect(formatRelativeDays("en-US", new Date(now - 95 * DAY_MS).toISOString(), now)).toBe(
      "3 months ago",
    );
    expect(formatRelativeDays("en-US", new Date(now - 800 * DAY_MS).toISOString(), now)).toBe(
      "2 years ago",
    );
  });

  it("returns null on a malformed instant", () => {
    expect(formatRelativeDays("en-US", "not-a-date", now)).toBeNull();
  });
});
