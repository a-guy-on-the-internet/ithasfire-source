import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/**
 * VenueStatsBlock (booking-review-data-weave FR-005/FR-007): renders the
 * anonymization-policy snapshot injected server-side into a `venue_stats`
 * block. These tests pin:
 *  - the trusted-marker discipline (no `dataSource: "venue_stats"` → null),
 *  - present-keys-only rendering (absent slices never render as zeroes),
 *  - the "Reported by N performers" provenance framing,
 *  - the PAIRING with `audience_stats`: a PERFORMERS tier stamp leads, and the
 *    would-play-again percentage renders through the shared review-tier
 *    headline so a reader can compare it with the attendee one, and
 *  - the editor placeholder (owner-stored data carries no marker).
 */

vi.mock("@th/ui", () => ({
  // Key-echo translator (same convention as BookingDefaultsEditor.test.tsx).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
  // The app-locale formatters. PINNED to en-US on purpose: the component no
  // longer calls `toLocaleString(undefined, …)`, so these assertions are no
  // longer at the mercy of whatever ICU default the machine running the suite
  // happens to have — which is the same class of bug the component had.
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

import { VenueStatsBlock } from "../VenueStatsBlock";
import { BlockRenderModeProvider } from "../block-render-context";

function makeBlock(data: unknown): PageBlockRecord {
  return {
    id: "block-1",
    pageId: "page-1",
    kind: "venue_stats",
    orderIndex: 0,
    data,
    visible: true,
  };
}

/** Full server-built payload: every optional slice present. */
const FULL_DATA = {
  dataSource: "venue_stats",
  heading: "Custom heading",
  snapshot: {
    version: 1,
    headline: {
      reviewCountBand: "7",
      wouldPlayAgainPct: 85,
      soundScore: 4.5,
      stageEquipmentScore: 3,
      parkingScore: 2.5,
      bookerScore: 5,
      staffSupportScore: 4,
      promotionScore: 1.5,
    },
    payout: {
      sampleSizeBand: "5",
      medianCents: 15000,
      minCents: 10000,
      maxCents: 30000,
      methodPcts: { guarantee: 60, doorSplit: 25 },
    },
    dayOfWeek: [
      { day: 4, pct: 10 },
      { day: 5, pct: 40 },
      { day: 6, pct: 35 },
    ],
    genres: ["indie rock", "metal", "other"],
  },
  snapshotAt: "2026-07-06T00:00:00.000Z",
};

describe("VenueStatsBlock", () => {
  it("renders provenance framing, payout, and scores from a full snapshot", () => {
    render(<VenueStatsBlock block={makeBlock(FULL_DATA)} />);

    // FR-007: performer-testimony framing leads — the tier stamp first, then
    // the count band it is reporting over.
    expect(screen.getByText("venueStats.tier")).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.reportedBy count=7"),
    ).toBeInTheDocument();
    // Owner-editable heading wins over the default.
    expect(screen.getByText("Custom heading")).toBeInTheDocument();

    // Headline aggregates.
    expect(screen.getByText("85%")).toBeInTheDocument();
    expect(screen.getByText("venueStats.wouldPlayAgain")).toBeInTheDocument();
    // $25-bucket cents → whole dollars, never invented precision.
    expect(screen.getByText("$150")).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.payoutRange min=$100 max=$300"),
    ).toBeInTheDocument();

    // All six 0–5 scores render as text (never color-only).
    expect(screen.getByText("venueStats.scoreSound")).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.scoreOutOf score=4.5"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.scoreStageEquipment"),
    ).toBeInTheDocument();
    expect(screen.getByText("venueStats.scoreParking")).toBeInTheDocument();
    expect(screen.getByText("venueStats.scoreBooker")).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.scoreStaffSupport"),
    ).toBeInTheDocument();
    expect(screen.getByText("venueStats.scorePromotion")).toBeInTheDocument();

    // Subordinate slices: method mix sorted by share, nights by pct desc.
    expect(
      screen.getByText(
        "venueStats.methodMix list=venueStats.methodGuarantee 60% · venueStats.methodDoorSplit 25%",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.genres list=indie rock, metal, other"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.nights list=Fri 40% · Sat 35% · Thu 10%"),
    ).toBeInTheDocument();

    // Deliberately-periodic caption with the snapshot date.
    expect(
      screen.getByText(/venueStats\.updatedPeriodically/),
    ).toBeInTheDocument();
    expect(screen.getByText(/venueStats\.asOf date=/)).toBeInTheDocument();
  });

  it("renders only present keys (absent slices never appear as zeroes)", () => {
    const minimal = {
      dataSource: "venue_stats",
      snapshot: {
        version: 1,
        headline: { reviewCountBand: "20+", soundScore: 3 },
      },
      snapshotAt: null,
    };
    render(<VenueStatsBlock block={makeBlock(minimal)} />);

    expect(
      screen.getByText("venueStats.reportedBy count=20+"),
    ).toBeInTheDocument();
    // Default heading when the owner set none.
    expect(screen.getByText("venueStats.heading")).toBeInTheDocument();
    // Present score renders…
    expect(screen.getByText("venueStats.scoreSound")).toBeInTheDocument();
    expect(
      screen.getByText("venueStats.scoreOutOf score=3"),
    ).toBeInTheDocument();
    // …absent slices do not.
    expect(
      screen.queryByText("venueStats.wouldPlayAgain"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("venueStats.medianPayout"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("venueStats.scoreBooker"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/venueStats\.methodMix/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/venueStats\.genres/)).not.toBeInTheDocument();
    expect(screen.queryByText(/venueStats\.nights/)).not.toBeInTheDocument();
    // "Updated periodically" still shows, without an as-of date.
    expect(
      screen.getByText("venueStats.updatedPeriodically"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/venueStats\.asOf/)).not.toBeInTheDocument();
  });

  it("keeps the tier stamp and a standalone count when nobody answered would-play-again", () => {
    const noHeadlinePct = {
      dataSource: "venue_stats",
      snapshot: {
        version: 1,
        headline: { reviewCountBand: "20+", soundScore: 3 },
      },
      snapshotAt: null,
    };
    render(<VenueStatsBlock block={makeBlock(noHeadlinePct)} />);

    // The stamp is the pair's signature and never depends on a figure.
    expect(screen.getByText("venueStats.tier")).toBeInTheDocument();
    // The count still shows — on its own line, with no 0% invented above it.
    expect(
      screen.getByText("venueStats.reportedBy count=20+"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("venueStats.wouldPlayAgain"),
    ).not.toBeInTheDocument();
  });

  it("collapses a flat payout range to the median only", () => {
    const flatRange = {
      dataSource: "venue_stats",
      snapshot: {
        version: 1,
        headline: { reviewCountBand: "5" },
        payout: {
          sampleSizeBand: "5",
          medianCents: 10000,
          minCents: 10000,
          maxCents: 10000,
        },
      },
      snapshotAt: null,
    };
    render(<VenueStatsBlock block={makeBlock(flatRange)} />);

    expect(screen.getByText("$100")).toBeInTheDocument();
    expect(
      screen.queryByText(/venueStats\.payoutRange/),
    ).not.toBeInTheDocument();
  });

  it("renders nothing without the server trust marker", () => {
    const forged = {
      // A page owner storing this via managePageBlocks gets stripped to
      // `heading` server-side; even if the raw shape leaked, no marker = null.
      heading: "Fake stats",
      snapshot: FULL_DATA.snapshot,
      snapshotAt: FULL_DATA.snapshotAt,
    };
    const { container } = render(<VenueStatsBlock block={makeBlock(forged)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a mismatched marker or missing data", () => {
    const mismatched = { ...FULL_DATA, dataSource: "stats" };
    const { container } = render(
      <VenueStatsBlock block={makeBlock(mismatched)} />,
    );
    expect(container).toBeEmptyDOMElement();

    const { container: empty } = render(
      <VenueStatsBlock block={makeBlock(undefined)} />,
    );
    expect(empty).toBeEmptyDOMElement();
  });

  it("shows an owner-facing placeholder in the editor (data has no marker there)", () => {
    render(
      <BlockRenderModeProvider mode="editor">
        <VenueStatsBlock block={makeBlock({ heading: "Custom heading" })} />
      </BlockRenderModeProvider>,
    );

    expect(
      screen.getByText("admin.peBlockKindVenueStats"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin.peBlockVenueStatsEditorHint"),
    ).toBeInTheDocument();
  });
});
