import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RequestToPlayStatsLine (booking-review-data-weave FR-008): the compact
 * crowd-sourced context line inside the booking-request form. Pins the three
 * snapshot shapes (full / headline-only / nothing) and — via the full
 * RequestToPlayPanel — that the form never waits on the stats query.
 */

const testMocks = vi.hoisted(() => ({
  statsUseQuery: vi.fn(),
  statusUseQuery: vi.fn(),
  defaultsUseQuery: vi.fn(),
  trackRecordUseQuery: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      performers: {
        getMyStatus: {
          getData: vi.fn(),
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
    }),
    performers: {
      getMyStatus: { useQuery: testMocks.statusUseQuery },
      setMode: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      getBookingDefaults: { useQuery: testMocks.defaultsUseQuery },
    },
    bookingRequests: {
      create: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
    placeReviews: {
      getPublicStats: { useQuery: testMocks.statsUseQuery },
    },
    // P5-F1 (bill): the bill's Name combobox searches on demand only.
    search: {
      autocompleteAdmin: {
        useQuery: () => ({ data: undefined, isFetching: false, isPending: true, isError: false }),
      },
    },
    // BookingDatePicker (rendered inside the panel's form) reads
    // `trpc.places.getBookingAvailability` for its 62-day horizon. Without an
    // entry here the whole panel throws on `undefined.getBookingAvailability`
    // before any assertion runs — which is what made this suite red.
    //
    // Left PENDING (`data: undefined`) on purpose: the component narrows with
    // `query.data?.days ?? []`, and the one test that reaches this path is
    // precisely the one asserting the interactive form renders immediately
    // rather than waiting on a query. Resolving it would test the opposite.
    places: {
      // The DOOR read (venue-track-record-and-review-switch FR-014): the
      // attendance band. Pending by default — see `mockBand`.
      getTrackRecord: { useQuery: testMocks.trackRecordUseQuery },
      getBookingAvailability: {
        useQuery: () => ({ data: undefined, isLoading: true }),
      },
      // The panel's intent switch reads `places.getBookingOptions` first and
      // shows a loading line until it settles. Resolved here — with no
      // calendars, so the pitch form mounts unrouted exactly as before — so
      // the assertion below still measures the STATS query, not this one.
      getBookingOptions: {
        useQuery: () => ({
          data: {
            placeId: "place-1",
            isClaimed: true,
            acceptsBookingRequests: true,
            calendars: [],
          },
          isPending: false,
          isSuccess: true,
          isError: false,
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: [] }),
}));

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
  // BookingSubmitButton mounts a Spinner while the create mutation is
  // pending; the mock above pins isPending:false, but a missing export would
  // still throw at module load.
  Spinner: () => <span data-testid="spinner" />,
}));

import { RequestToPlayStatsLine } from "../RequestToPlayStatsLine";
import { RequestToPlayPanel } from "../RequestToPlayForm";

function mockStats(result: {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
}) {
  const pending = result.isLoading ?? false;
  testMocks.statsUseQuery.mockReturnValue({
    data: result.data,
    isLoading: pending,
    isPending: pending,
    isError: result.isError ?? false,
  });
}

/** `places.getTrackRecord`, SETTLED with the given band. */
function mockBand(
  attendanceBand: "under_25" | "25_to_100" | "100_to_300" | "over_300" | null,
) {
  testMocks.trackRecordUseQuery.mockReturnValue({
    data: { placeId: "place-1", attendanceBand },
    isLoading: false,
    isPending: false,
    isError: false,
  });
}

/** `places.getTrackRecord` still in flight. */
function mockBandPending() {
  testMocks.trackRecordUseQuery.mockReturnValue({
    data: undefined,
    isLoading: true,
    isPending: true,
    isError: false,
  });
}

const FULL_SNAPSHOT = {
  placeId: "place-1",
  snapshot: {
    version: 1,
    headline: { reviewCountBand: "7", wouldPlayAgainPct: 85 },
    payout: {
      sampleSizeBand: "5",
      medianCents: 15000,
      minCents: 10000,
      maxCents: 30000,
    },
  },
  snapshotAt: new Date("2026-07-06T00:00:00.000Z"),
};

describe("RequestToPlayStatsLine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The door read defaults to SETTLED with no band, so the performer-
    // snapshot cases below render exactly what they did before the band
    // existed. (Pending would render nothing — see the one-paint test.)
    mockBand(null);
  });

  it("shows review count, would-play-again, and median payout for a full snapshot", () => {
    mockStats({ data: FULL_SNAPSHOT });

    render(<RequestToPlayStatsLine placeId="place-1" />);

    expect(testMocks.statsUseQuery).toHaveBeenCalledWith(
      { placeId: "place-1" },
      expect.anything(),
    );
    expect(
      screen.getByText(
        "admin.bkStatsLineReviewed count=7 · admin.bkStatsLinePlayAgain pct=85 · admin.bkStatsLineMedianPayout amount=$150",
      ),
    ).toBeInTheDocument();
  });

  it("degrades to the review-count sentence when payout is below its threshold", () => {
    mockStats({
      data: {
        placeId: "place-1",
        snapshot: {
          version: 1,
          headline: { reviewCountBand: "3" },
        },
        snapshotAt: null,
      },
    });

    render(<RequestToPlayStatsLine placeId="place-1" />);

    expect(
      screen.getByText("admin.bkStatsLineReviewed count=3"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/bkStatsLineMedianPayout/),
    ).not.toBeInTheDocument();
  });

  it("renders nothing when no snapshot or headline is published", () => {
    mockStats({
      data: { placeId: "place-1", snapshot: null, snapshotAt: null },
    });
    const { container } = render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(container).toBeEmptyDOMElement();

    // `{ version: 1 }` (below the headline k-threshold) also renders nothing.
    mockStats({
      data: {
        placeId: "place-1",
        snapshot: { version: 1 },
        snapshotAt: null,
      },
    });
    const { container: below } = render(
      <RequestToPlayStatsLine placeId="place-1" />,
    );
    expect(below).toBeEmptyDOMElement();
  });

  it("renders nothing while loading and on error (no spinner, no fallback)", () => {
    mockStats({ isLoading: true });
    const { container } = render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(container).toBeEmptyDOMElement();

    mockStats({ isError: true });
    const { container: errored } = render(
      <RequestToPlayStatsLine placeId="place-1" />,
    );
    expect(errored).toBeEmptyDOMElement();
  });

  it("paints ONCE — nothing until the door read has settled too", () => {
    // Performer snapshot is in; the band is still in flight. Painting now
    // would reflow the sentence (and move its capital) when the band lands.
    mockStats({ data: FULL_SNAPSHOT });
    mockBandPending();
    const { container } = render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(container).toBeEmptyDOMElement();

    // The band read failing is a settled state: the performer clauses show.
    testMocks.trackRecordUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: true,
    });
    render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(screen.getByText(/bkStatsLineReviewed count=7/)).toBeInTheDocument();
  });
});

describe("RequestToPlayStatsLine — the attendance band (FR-014)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders NOTHING when the switch is off and there is no band", () => {
    mockStats({
      data: { placeId: "place-1", snapshot: null, snapshotAt: null },
    });
    mockBand(null);
    const { container } = render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the band clause on its own when the performer snapshot is null (R4: door data, not testimony)", () => {
    mockStats({
      data: { placeId: "place-1", snapshot: null, snapshotAt: null },
    });
    mockBand("25_to_100");
    render(<RequestToPlayStatsLine placeId="place-1" />);
    // Lowercase in the DOM: the opening capital is `::first-letter`, so the
    // clause can also follow a "·" unchanged.
    expect(
      screen.getByText("admin.bkStatsLineAttendance25To100"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/bkStatsLineReviewed/)).not.toBeInTheDocument();
  });

  it("appends the band clause after the performer clauses when both exist", () => {
    mockStats({ data: FULL_SNAPSHOT });
    mockBand("over_300");
    render(<RequestToPlayStatsLine placeId="place-1" />);
    expect(
      screen.getByText(
        "admin.bkStatsLineReviewed count=7 · admin.bkStatsLinePlayAgain pct=85 · admin.bkStatsLineMedianPayout amount=$150 · admin.bkStatsLineAttendanceOver300",
      ),
    ).toBeInTheDocument();
  });

  it("maps every band to its own clause", () => {
    mockStats({
      data: { placeId: "place-1", snapshot: null, snapshotAt: null },
    });
    for (const [band, key] of [
      ["under_25", "admin.bkStatsLineAttendanceUnder25"],
      ["100_to_300", "admin.bkStatsLineAttendance100To300"],
    ] as const) {
      mockBand(band);
      const { unmount } = render(
        <RequestToPlayStatsLine placeId="place-1" />,
      );
      expect(screen.getByText(key)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("RequestToPlayPanel with a pending stats query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBandPending();
  });

  it("renders the interactive form immediately — the stats line never blocks it", () => {
    // Performer mode on → the real form mounts.
    testMocks.statusUseQuery.mockReturnValue({
      data: { human: { enabled: true, ownerId: "human-1" }, orgs: [] },
      isLoading: false,
      isError: false,
    });
    // Stats query still in flight.
    mockStats({ isLoading: true });
    testMocks.defaultsUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    render(<RequestToPlayPanel placeId="place-1" onSuccess={vi.fn()} />);

    // The pitch fields are live while the stats query is still pending.
    expect(
      screen.getByLabelText("admin.bkFormMessageLabel"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "admin.bkFormSubmit" }),
    ).toBeInTheDocument();
    // And no stats line rendered yet.
    expect(screen.queryByText(/bkStatsLineReviewed/)).not.toBeInTheDocument();
  });
});
