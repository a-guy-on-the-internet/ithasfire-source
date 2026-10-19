import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

/**
 * AudienceStatsBlock (attendee-reviews FR-005/FR-007): renders the
 * anonymization-policy snapshot injected server-side into an `audience_stats`
 * block — the AUDIENCE-perspective sibling of `venue_stats`. These tests pin:
 *  - the trusted-marker discipline (no `dataSource: "audience_stats"` → null),
 *  - present-keys-only rendering (absent facets never render as zeroes),
 *  - the distinct "Rated by N verified attendees" provenance framing, and
 *  - the editor placeholder (owner-stored data carries no marker).
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
}));

import { AudienceStatsBlock } from "../AudienceStatsBlock";
import { BlockRenderModeProvider } from "../block-render-context";

function makeBlock(data: unknown): PageBlockRecord {
  return {
    id: "block-1",
    pageId: "page-1",
    kind: "audience_stats",
    orderIndex: 0,
    data,
    visible: true,
  };
}

/** Full server-built payload: every optional facet present. */
const FULL_DATA = {
  dataSource: "audience_stats",
  heading: "Custom heading",
  snapshot: {
    version: 1,
    summary: {
      reviewCountBand: "20+",
      overallScore: 4.5,
      recommendPct: 90,
      soundQualityScore: 4,
      venueComfortScore: 3.5,
      organizationScore: 5,
      valueForMoneyScore: 2.5,
    },
  },
  snapshotAt: "2026-07-06T00:00:00.000Z",
};

describe("AudienceStatsBlock", () => {
  it("renders audience provenance framing, overall, recommend and facets", () => {
    render(<AudienceStatsBlock block={makeBlock(FULL_DATA)} />);

    // Distinct provenance: verified attendees, NOT performers.
    expect(
      screen.getByText("audienceStats.ratedBy count=20+"),
    ).toBeInTheDocument();
    // Owner-editable heading wins over the default.
    expect(screen.getByText("Custom heading")).toBeInTheDocument();

    // Overall score is prominent (text, never color-only) and recommend %.
    expect(
      screen.getByText("audienceStats.scoreOutOf score=4.5"),
    ).toBeInTheDocument();
    expect(screen.getByText("audienceStats.overall")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(
      screen.getByText("audienceStats.wouldRecommend"),
    ).toBeInTheDocument();

    // All four facet scores render as text.
    expect(screen.getByText("audienceStats.scoreSound")).toBeInTheDocument();
    expect(
      screen.getByText("audienceStats.scoreVenueComfort"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("audienceStats.scoreOrganization"),
    ).toBeInTheDocument();
    expect(screen.getByText("audienceStats.scoreValue")).toBeInTheDocument();
    expect(
      screen.getByText("audienceStats.scoreOutOf score=4"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("audienceStats.scoreOutOf score=3.5"),
    ).toBeInTheDocument();

    // Deliberately-periodic caption with the snapshot date.
    expect(
      screen.getByText(/audienceStats\.updatedPeriodically/),
    ).toBeInTheDocument();
    expect(screen.getByText(/audienceStats\.asOf date=/)).toBeInTheDocument();
  });

  it("renders only present facets (absent slices never appear as zeroes)", () => {
    const minimal = {
      dataSource: "audience_stats",
      snapshot: {
        version: 1,
        summary: { reviewCountBand: "5", overallScore: 3 },
      },
      snapshotAt: null,
    };
    render(<AudienceStatsBlock block={makeBlock(minimal)} />);

    expect(
      screen.getByText("audienceStats.ratedBy count=5"),
    ).toBeInTheDocument();
    // Default heading when the owner set none.
    expect(screen.getByText("audienceStats.heading")).toBeInTheDocument();
    // Overall still renders…
    expect(
      screen.getByText("audienceStats.scoreOutOf score=3"),
    ).toBeInTheDocument();
    expect(screen.getByText("audienceStats.overall")).toBeInTheDocument();
    // …absent slices do not.
    expect(
      screen.queryByText("audienceStats.wouldRecommend"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("audienceStats.scoreSound"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("audienceStats.scoreValue"),
    ).not.toBeInTheDocument();
    // "Updated periodically" still shows, without an as-of date.
    expect(
      screen.getByText("audienceStats.updatedPeriodically"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/audienceStats\.asOf/)).not.toBeInTheDocument();
  });

  it("renders nothing without the server trust marker", () => {
    const forged = {
      heading: "Fake ratings",
      snapshot: FULL_DATA.snapshot,
      snapshotAt: FULL_DATA.snapshotAt,
    };
    const { container } = render(
      <AudienceStatsBlock block={makeBlock(forged)} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a mismatched marker or missing data", () => {
    const mismatched = { ...FULL_DATA, dataSource: "venue_stats" };
    const { container } = render(
      <AudienceStatsBlock block={makeBlock(mismatched)} />,
    );
    expect(container).toBeEmptyDOMElement();

    const { container: empty } = render(
      <AudienceStatsBlock block={makeBlock(undefined)} />,
    );
    expect(empty).toBeEmptyDOMElement();
  });

  it("shows an owner-facing placeholder in the editor (data has no marker there)", () => {
    render(
      <BlockRenderModeProvider mode="editor">
        <AudienceStatsBlock block={makeBlock({ heading: "Custom heading" })} />
      </BlockRenderModeProvider>,
    );

    expect(
      screen.getByText("admin.peBlockKindAudienceStats"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("admin.peBlockAudienceStatsEditorHint"),
    ).toBeInTheDocument();
  });
});
