import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BookingsWorkspace: pins the org Bookings page's composition contract —
 *
 *   • up to THREE tabs, one per relationship — "To your places" (acts asking to
 *     play at a place the org owns), "To you as an act" (organizers asking the
 *     group to perform), "Sent to acts". They must never collapse into one
 *     list: the first two are different directions with different
 *     counterparties;
 *   • the ARIA tabs wiring (roving tabindex, arrow keys, tabpanel labelling);
 *   • the venue tab is the DEFAULT when venue requests are waiting, and the
 *     whole tab disappears for a pure-act org that owns no venues — with the
 *     selection clamped so nothing can be left on a panel with no tab;
 *   • the ACT tab is gated on performer mode, and hides ONLY on positive
 *     knowledge that the group is not an act AND nothing is open in it. Every
 *     uncertain read — org absent from the administered-org list, status in
 *     flight, status failed — shows it, because hiding a real inbound request
 *     is worse than an extra empty tab;
 *   • badges/venue set come ENTIRELY from `bookingRequests.countOpen` — the old
 *     capped fan-out of per-venue list queries is gone, and so is the companion
 *     `places.listHumanPlaces` call (the two are different SETS);
 *   • a human admin context gets the SAME venues inbox for venues the person
 *     owns directly (human selector, `human-venues` scope), never the act or
 *     sent tabs — and still gets the account-settings pointer when they own
 *     no venues.
 *
 * All three panels are stubbed — they have their own tests. This file pins
 * composition, not row rendering.
 */

const testMocks = vi.hoisted(() => ({
  countOpenUseQuery: vi.fn(),
  getMyStatusUseQuery: vi.fn(),
  /** Any list-shaped query the page must NOT issue for badge purposes. */
  forbiddenListQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isError: false,
  })),
  currentOwner: null as unknown,
  ownerLoading: false,
}));

/** The `?request=<id>` deep link; null = no query string. */
let requestParam: string | null = null;
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "dev-qa" }),
  usePathname: () => "/admin/dev-qa/bookings",
  useSearchParams: () => ({
    get: (key: string) => (key === "request" ? requestParam : null),
  }),
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testMocks.currentOwner,
    isLoading: testMocks.ownerLoading,
  }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      bookingRequests: { list: { invalidate: vi.fn() } },
    }),
    useQueries: testMocks.forbiddenListQuery,
    bookingRequests: {
      countOpen: { useQuery: testMocks.countOpenUseQuery },
      list: { useQuery: testMocks.forbiddenListQuery },
    },
    places: {
      listHumanPlaces: { useQuery: testMocks.forbiddenListQuery },
    },
    performers: {
      getMyStatus: { useQuery: testMocks.getMyStatusUseQuery },
    },
  },
}));

// Panels are covered by their own suites; stub them so this file pins
// composition, not row rendering.
vi.mock("../_components/OrgReceivedRequestsTable", () => ({
  OrgReceivedRequestsTable: ({ orgId }: { orgId: string }) => (
    <div data-testid="received-panel">received:{orgId}</div>
  ),
}));

vi.mock("../_components/SentToActsList", () => ({
  SentToActsList: ({ orgId }: { orgId: string }) => (
    <div data-testid="sent-panel">sent:{orgId}</div>
  ),
}));

// The unconfigured-venue banner has its own suite (probes, trigger, session
// dismissal). Here only its PLACEMENT contract is pinned: it receives the
// count's venue set and the admin slug, and is absent when no venue exists —
// its per-venue probes must never run for a pure-act org.
vi.mock("../_components/AvailabilitySetupBanner", () => ({
  AvailabilitySetupBanner: ({
    slug,
    venues,
  }: {
    slug: string;
    venues: { placeId: string }[];
  }) => (
    <div
      data-testid="hours-banner"
      data-slug={slug}
      data-venues={venues.map((v) => v.placeId).join(",")}
    />
  ),
}));

vi.mock("@/components/bookings/BookingInbox", () => ({
  BookingInbox: ({
    scope,
    venues,
    venuesTruncated,
  }: {
    scope: { kind: string; orgId?: string };
    venues: { placeId: string }[];
    venuesTruncated: boolean;
  }) => (
    <div
      data-testid="venues-panel"
      data-scope={scope.kind}
      data-venues={venues.map((v) => v.placeId).join(",")}
      data-truncated={String(venuesTruncated)}
    >
      venues:{scope.orgId}
    </div>
  ),
}));

/**
 * Tamagui stub that forwards the web-only a11y props the real components set
 * (role, aria-*, id, tabIndex, onKeyDown) so the ARIA wiring is actually
 * assertable, while dropping the style props that would become invalid DOM
 * attributes.
 */
const PASSTHROUGH_PROPS = [
  "role",
  "id",
  "tabIndex",
  "onKeyDown",
  "aria-label",
  "aria-selected",
  "aria-controls",
  "aria-labelledby",
  "aria-pressed",
  "aria-hidden",
] as const;

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => {
    const passed: Record<string, unknown> = {};
    for (const key of PASSTHROUGH_PROPS) {
      if (key in props) passed[key] = props[key];
    }
    return (
      <div
        data-testid={props.testID as string | undefined}
        onClick={props.onPress as (() => void) | undefined}
        {...passed}
      >
        {props.children as ReactNode}
      </div>
    );
  };
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testID}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
  }: {
    href: string;
    children?: ReactNode;
  }) => <a href={href}>{children}</a>,
  Spinner: () => <span>Loading</span>,
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <span data-testid={testID}>{children}</span>
  ),
  // Key-echo translator (same convention as the other booking suites).
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

import { BookingsWorkspace } from "../_components/BookingsWorkspace";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_OWNER = { kind: "org", orgId: "org-1", orgName: "Dev QA Collective" };

/**
 * `performers.getMyStatus`. `orgs` carries ONLY the orgs the actor
 * ADMINISTERS, so `present: false` is what a FINANCE/VIEWER member of org-1
 * actually sees — indistinguishable on the wire from "performer mode off".
 */
function statusResult(
  overrides: Partial<{
    enabled: boolean;
    present: boolean;
    isLoading: boolean;
    isError: boolean;
  }> = {},
) {
  const {
    enabled = true,
    present = true,
    isLoading = false,
    isError = false,
  } = overrides;
  if (isLoading || isError) {
    return { data: undefined, isLoading, isError };
  }
  return {
    data: {
      human: {
        ownerId: "h-1",
        enabled: false,
        enabledAt: null,
        acceptsBookingRequests: false,
        statsEligible: false,
      },
      orgs: present
        ? [
            {
              ownerId: "org-1",
              enabled,
              enabledAt: enabled ? new Date("2026-01-01T00:00:00Z") : null,
              acceptsBookingRequests: false,
            },
          ]
        : [],
    },
    isLoading: false,
    isError: false,
  };
}

function countResult(
  overrides: Partial<{
    performerInbox: number;
    venues: { placeId: string; placeName: string; openCount: number }[];
    ownedPlacesTruncated: boolean;
  }> = {},
) {
  return {
    data: {
      performerInbox: 0,
      venues: [],
      ownedPlacesTruncated: false,
      ...overrides,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requestParam = null;
  testMocks.currentOwner = ORG_OWNER;
  testMocks.ownerLoading = false;
  testMocks.countOpenUseQuery.mockReturnValue(countResult());
  // Default: the org IS an act, so the act tab is present and the pre-existing
  // composition expectations below are unaffected by the performer gate.
  testMocks.getMyStatusUseQuery.mockReturnValue(statusResult());
  testMocks.forbiddenListQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

const VENUES = [
  { placeId: "pl-1", placeName: "The Basement", openCount: 3 },
  { placeId: "pl-2", placeName: "Exit/In", openCount: 0 },
];

describe("BookingsWorkspace — tabs", () => {
  it("mounts NO panel while the count is in flight", () => {
    // Guessing a tab before the count lands would mount that panel, fire its
    // own list query, then unmount it and move aria-selected with no user
    // action. The panel must mount exactly once.
    testMocks.countOpenUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BookingsWorkspace />);

    expect(
      screen.getByTestId("bookings-workspace-loading"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sent-panel")).not.toBeInTheDocument();
    // No half-built tablist either — a tablist with nothing selected is broken.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("falls back to the venue inbox when the count itself failed", () => {
    // The badge numbers are unknown, but the cross-venue list is a SEPARATE
    // query that may well succeed — hiding the page's primary surface on a
    // badge failure would hide requests, which is the exact failure this page
    // exists to prevent.
    testMocks.countOpenUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsTabVenues")).toBeInTheDocument();
  });

  it("renders three tabs with tablist/tab/tabpanel wiring", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    render(<BookingsWorkspace />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(screen.getByText("admin.bkWsTabVenues (3)")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsTabSent")).toBeInTheDocument();

    const panel = screen.getByRole("tabpanel");
    const selected = tabs.find(
      (el) => el.getAttribute("aria-selected") === "true",
    )!;
    expect(panel).toHaveAttribute("aria-labelledby", selected.id);
    // Roving tabindex: exactly one tab is in the tab order.
    expect(
      tabs.filter((el) => el.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });

  it("defaults to the venue inbox when venue requests are waiting", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES, performerInbox: 2 }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("venues-panel")).toHaveTextContent(
      "venues:org-1",
    );
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
    // Both open counts decorate their own tab; neither is folded into the other.
    expect(screen.getByText("admin.bkWsTabVenues (3)")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsTabReceived (2)")).toBeInTheDocument();
  });

  it("defaults to the act inbox when only the act has something waiting", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({
        venues: [{ placeId: "pl-2", placeName: "Exit/In", openCount: 0 }],
        performerInbox: 2,
      }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("received-panel")).toHaveTextContent(
      "received:org-1",
    );
  });

  it("a `?request=` deep link lands on the venue inbox even when the act inbox would win", () => {
    // Same counts as the case above — the default would be `received`.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({
        venues: [{ placeId: "pl-2", placeName: "Exit/In", openCount: 0 }],
        performerInbox: 2,
      }),
    );
    requestParam = "req-1";
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
  });

  it("lands a quiet venue org on its venue inbox, not the sent list", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({
        venues: [{ placeId: "pl-2", placeName: "Exit/In", openCount: 0 }],
      }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();
  });

  it("hides the venue tab entirely for a pure-act org, and falls back to Sent", () => {
    render(<BookingsWorkspace />);
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.queryByText("admin.bkWsTabVenues")).not.toBeInTheDocument();
    expect(screen.getByTestId("sent-panel")).toHaveTextContent("sent:org-1");
  });

  it("CLAMPS the selection when the venue tab disappears mid-session", () => {
    // A tabpanel whose aria-labelledby points at a tab that is no longer
    // rendered, and a tablist with nothing selected, are both broken states.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    const { rerender } = render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();

    testMocks.countOpenUseQuery.mockReturnValue(countResult({ venues: [] }));
    rerender(<BookingsWorkspace />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();
    const selected = tabs.filter(
      (el) => el.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      selected[0]!.id,
    );
  });

  it("STAYS put after the last open request is answered", () => {
    // Observed in the real app before this was latched: answering the final
    // open request dropped the count to 0, which re-derived the default and
    // threw the user onto another tab with no interaction. Responding to a
    // request must never navigate.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ performerInbox: 1 }),
    );
    const { rerender } = render(<BookingsWorkspace />);
    expect(screen.getByTestId("received-panel")).toBeInTheDocument();

    // The response lands; countOpen is invalidated and refetches as 0.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ performerInbox: 0 }),
    );
    rerender(<BookingsWorkspace />);

    expect(screen.getByTestId("received-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("sent-panel")).not.toBeInTheDocument();
    // The count decoration goes away, but the tab does not move.
    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
  });

  it("switches panels on click and on arrow keys, across all three tabs", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("bookings-workspace-tab-received"));
    expect(screen.getByTestId("received-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-received"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("sent-panel")).toBeInTheDocument();

    // Wraps: three tabs, so a plain toggle would strand the middle one.
    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-sent"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-venues"), {
      key: "ArrowLeft",
    });
    expect(screen.getByTestId("sent-panel")).toBeInTheDocument();
  });
});

/**
 * The act inbox is a tab only for a group that IS an act. Hiding it is the
 * whole point of this block — but hiding real inbound requests would be
 * strictly worse than an extra empty tab, so the matrix below pins that the
 * hide fires on POSITIVE knowledge only.
 */
describe("BookingsWorkspace — the act tab is gated on performer mode", () => {
  const ONE_VENUE = [{ placeId: "pl-2", placeName: "Exit/In", openCount: 0 }];

  it("SHOWS the act tab when org performer mode is on", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: true }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByText("admin.bkWsSubtitle")).toBeInTheDocument();
  });

  it("HIDES it when performer mode is off and nothing is open in it", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE, performerInbox: 0 }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
    render(<BookingsWorkspace />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.queryByText("admin.bkWsTabReceived")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("bookings-workspace-tab-received"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
    // The default cannot land on a tab that is not there.
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();
    // …and the subtitle stops promising an inbox the page no longer has.
    expect(screen.getByText("admin.bkWsSubtitleNoAct")).toBeInTheDocument();
  });

  it("SHOWS it with performer mode off when something is OPEN in it", () => {
    // A request someone is waiting on an answer to outranks a tidy tab strip.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE, performerInbox: 3 }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByText("admin.bkWsTabReceived (3)")).toBeInTheDocument();
    expect(screen.getByTestId("received-panel")).toBeInTheDocument();
  });

  it("SHOWS it when the org is ABSENT from the administered-org list", () => {
    // `getMyStatus.orgs` lists only orgs the actor OWNS/ADMINS, so a FINANCE
    // or VIEWER member's own org is simply missing — which is NOT "off".
    // Hiding on absence would hide real requests from those members.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ present: false }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("SHOWS it when the status read FAILED", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ isError: true }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("renders NO tab strip while the status read is in flight", () => {
    // The tab SET must be final at first paint. Rendering the strip on the
    // count alone would draw the act tab and then yank it away a moment
    // later — the same "moved with no user action" defect the default latch
    // exists to prevent. Both reads are in the gate; they run in parallel.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ isLoading: true }),
    );
    render(<BookingsWorkspace />);

    expect(
      screen.getByTestId("bookings-workspace-loading"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();
  });

  it("does NOT hide it when the COUNT failed (an unknown count is not zero)", () => {
    // `performerInbox` reads as 0 through the `?? 0` on a failed count. Hiding
    // on that would drop the tab on a badge outage.
    testMocks.countOpenUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("keeps a SHOWN act tab when performer mode is switched off mid-session", () => {
    // The dangerous version of this: performer mode off, one open request, the
    // user opens the tab and declines it. The count drops to 0 and the tab the
    // user is standing on would evaporate. Responding must never navigate.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE, performerInbox: 1 }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
    const { rerender } = render(<BookingsWorkspace />);

    fireEvent.click(screen.getByTestId("bookings-workspace-tab-received"));
    expect(screen.getByTestId("received-panel")).toBeInTheDocument();

    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE, performerInbox: 0 }),
    );
    rerender(<BookingsWorkspace />);

    expect(screen.getByTestId("received-panel")).toBeInTheDocument();
    expect(screen.getByText("admin.bkWsTabReceived")).toBeInTheDocument();
  });

  it("arrow-keys correctly around the TWO tabs that survive the gate", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: ONE_VENUE }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-venues"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("sent-panel")).toBeInTheDocument();

    // Wraps back past the hole the act tab left, not into it.
    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-sent"), {
      key: "ArrowRight",
    });
    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByTestId("bookings-workspace-tab-venues"), {
      key: "ArrowLeft",
    });
    expect(screen.getByTestId("sent-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();

    // Roving tabindex still holds with two tabs.
    const tabs = screen.getAllByRole("tab");
    expect(
      tabs.filter((el) => el.getAttribute("tabindex") === "0"),
    ).toHaveLength(1);
  });
});

describe("BookingsWorkspace — one panel left", () => {
  beforeEach(() => {
    // No venues, not an act, nothing open: only the outbound list survives.
    testMocks.countOpenUseQuery.mockReturnValue(countResult());
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ enabled: false }),
    );
  });

  it("drops the tablist entirely and labels the section instead", () => {
    render(<BookingsWorkspace />);

    // A one-tab tablist announces a switcher with nothing to switch to.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();

    expect(
      screen.getByTestId("bookings-workspace-solo-header"),
    ).toHaveTextContent("admin.bkWsTabSent");
    // The panel is still a labelled landmark, just not a tabpanel.
    const region = screen.getByRole("region");
    expect(region).toHaveAttribute("aria-label", "admin.bkWsTabSent");
    expect(screen.getByTestId("sent-panel")).toHaveTextContent("sent:org-1");
  });

  it("tells the truth in the subtitle", () => {
    render(<BookingsWorkspace />);
    expect(screen.getByText("admin.bkWsSubtitleSentOnly")).toBeInTheDocument();
    expect(screen.queryByText("admin.bkWsSubtitle")).not.toBeInTheDocument();
  });
});

describe("BookingsWorkspace — venue data handed to the cross-venue inbox", () => {
  it("passes countOpen's venue SET down and issues NO list query for badges", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("venues-panel")).toHaveAttribute(
      "data-venues",
      "pl-1,pl-2",
    );

    // One countOpen call, no list fan-out and no companion places query — the
    // old hub issued up to 12 full list queries just to draw badges.
    expect(testMocks.countOpenUseQuery).toHaveBeenCalledTimes(1);
    expect(testMocks.countOpenUseQuery.mock.calls[0]![0]).toEqual({
      orgId: "org-1",
    });
    expect(testMocks.forbiddenListQuery).not.toHaveBeenCalled();
  });

  it("hands the SAME venue set to the availability banner, and none to a venueless org", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    const { unmount } = render(<BookingsWorkspace />);
    const banner = screen.getByTestId("hours-banner");
    expect(banner).toHaveAttribute("data-venues", "pl-1,pl-2");
    expect(banner).toHaveAttribute("data-slug", "dev-qa");
    unmount();

    // A pure-act org owns nothing to probe — the banner must not mount at all.
    testMocks.countOpenUseQuery.mockReturnValue(countResult({ venues: [] }));
    render(<BookingsWorkspace />);
    expect(screen.queryByTestId("hours-banner")).toBeNull();
  });

  it("passes the truncation flag through instead of swallowing it", () => {
    // A capped owned-place read reads as "you have no more requests" unless it
    // is surfaced — the exact failure this page exists to prevent.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES, ownedPlacesTruncated: true }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toHaveAttribute(
      "data-truncated",
      "true",
    );
  });

  it("does not claim truncation when the flag is false", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    render(<BookingsWorkspace />);
    expect(screen.getByTestId("venues-panel")).toHaveAttribute(
      "data-truncated",
      "false",
    );
  });
});

/**
 * A person can own venues DIRECTLY. Their requests render on the personal
 * Bookings page through the same venues panel, with the human selector and
 * the `human-venues` list scope. Only the venue relationship applies here —
 * the person's act-side inbox and sent list live in account settings.
 */
describe("BookingsWorkspace — human admin context", () => {
  const HUMAN_OWNER = { kind: "human", humanId: "h-1" };

  beforeEach(() => {
    testMocks.currentOwner = HUMAN_OWNER;
  });

  it("asks countOpen with the HUMAN selector (no id — the owner is the actor)", () => {
    render(<BookingsWorkspace />);

    expect(testMocks.countOpenUseQuery).toHaveBeenCalled();
    const [input, options] = testMocks.countOpenUseQuery.mock.calls[0]!;
    expect(input).toEqual({ owner: { kind: "human" } });
    expect((options as { enabled: boolean }).enabled).toBe(true);
  });

  it("asks countOpen with the org id shorthand for an org", () => {
    testMocks.currentOwner = ORG_OWNER;
    render(<BookingsWorkspace />);

    const [input, options] = testMocks.countOpenUseQuery.mock.calls[0]!;
    expect(input).toEqual({ orgId: "org-1" });
    expect((options as { enabled: boolean }).enabled).toBe(true);
  });

  it("renders the venues inbox in the human scope, with NO act or sent tabs", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES, ownedPlacesTruncated: true }),
    );
    render(<BookingsWorkspace />);

    const panel = screen.getByTestId("venues-panel");
    expect(panel).toHaveAttribute("data-scope", "human-venues");
    expect(panel).toHaveAttribute("data-venues", "pl-1,pl-2");
    expect(panel).toHaveAttribute("data-truncated", "true");

    // One relationship, so a section label rather than a one-tab tablist.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("bookings-workspace-solo-header"),
    ).toHaveTextContent("admin.bkWsTabVenues (3)");
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sent-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.bkWsTabReceived")).not.toBeInTheDocument();
    expect(screen.queryByText("admin.bkWsTabSent")).not.toBeInTheDocument();

    // The subtitle says what the page holds for a person: venues they own.
    expect(
      screen.getByText("admin.bkWsSubtitleHumanVenues"),
    ).toBeInTheDocument();
    // …and the dead-end pointer is gone.
    expect(screen.queryByTestId("bookings-workspace-human-empty")).not.toBeInTheDocument();
  });

  it("keeps a compact link to the personal inbox in account settings", () => {
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    render(<BookingsWorkspace />);

    const pointer = screen.getByTestId("bookings-workspace-human-inbox-pointer");
    expect(pointer).toHaveTextContent("admin.bkHubHumanInboxHint");
    const link = screen.getByText("admin.bkHubHumanInboxLink").closest("a");
    expect(link).toHaveAttribute("href", "/account/settings/booking-requests");
    // The org's performer-settings pointer is not for a person.
    expect(
      screen.queryByText("admin.bkHubSettingsLink"),
    ).not.toBeInTheDocument();
  });

  it("shows the account-settings pointer for a person who owns NO venues", () => {
    testMocks.countOpenUseQuery.mockReturnValue(countResult({ venues: [] }));
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("bookings-workspace-human-empty")).toBeInTheDocument();
    // Same vocabulary and the same deep link as the under-inbox pointer —
    // the settings INDEX renders General, not Booking requests.
    expect(screen.getByText("admin.bkHubHumanInboxHint")).toBeInTheDocument();
    expect(
      screen.getByText("admin.bkHubHumanInboxLink").closest("a"),
    ).toHaveAttribute("href", "/account/settings/booking-requests");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("received-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sent-panel")).not.toBeInTheDocument();
  });

  it("waits for the count before choosing between the inbox and the pointer", () => {
    // Flashing the "lives in account settings" pointer and then replacing it
    // with the inbox is the same "moved with no user action" defect the org
    // default latch exists to prevent.
    testMocks.countOpenUseQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: vi.fn(),
    });
    render(<BookingsWorkspace />);

    // Bare spinner: no heading, no subtitle, no footer pointer either — the
    // count decides the page's SHAPE, so nothing page-shaped draws first.
    expect(
      screen.queryByTestId("bookings-workspace-loading"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("admin.navBookings")).not.toBeInTheDocument();
    expect(
      screen.queryByText("admin.bkWsSubtitleHumanVenues"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("bookings-workspace-human-inbox-pointer"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("bookings-workspace-human-empty")).not.toBeInTheDocument();
    expect(screen.queryByTestId("venues-panel")).not.toBeInTheDocument();
  });

  it("keeps the inbox when the count FAILED (the venue set is unknown, not empty)", () => {
    testMocks.countOpenUseQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("venues-panel")).toHaveAttribute(
      "data-scope",
      "human-venues",
    );
    expect(screen.queryByTestId("bookings-workspace-human-empty")).not.toBeInTheDocument();
  });

  it("does not wait on the performer read, which never fires for a person", () => {
    // `useOrgPerformerEnabled(null, …)` is a disabled query that never
    // settles. Gating the human page on it would spin forever.
    testMocks.countOpenUseQuery.mockReturnValue(
      countResult({ venues: VENUES }),
    );
    testMocks.getMyStatusUseQuery.mockReturnValue(
      statusResult({ isLoading: true }),
    );
    render(<BookingsWorkspace />);

    expect(screen.getByTestId("venues-panel")).toBeInTheDocument();
    expect(
      screen.queryByTestId("bookings-workspace-loading"),
    ).not.toBeInTheDocument();
  });
});
