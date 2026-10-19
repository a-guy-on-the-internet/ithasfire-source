/**
 * /admin/[slug]/search — Phase B behaviour (admin-search-parity FR-011..013).
 *
 * These are LOGIC pins. The design system is mocked away and the page renders
 * in isolation, so nothing here says anything about how it LOOKS — overflow,
 * accessible-name collisions and hydration are invisible to this harness by
 * construction. Drive the real app for those.
 *
 * Covered:
 *   FR-011  URL → facet state (the overlay's exact param names), facet state →
 *           URL, back/forward restore, no replace/parse loop, facet-only
 *           browse, never an empty array on the wire, counts show TOTAL
 *   FR-012  the order row renders when `order` is non-null and renders NOTHING
 *           when null — with no permission / not-found messaging either way
 *   FR-013  attendee order count + last order date
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AdminSearchPage from "../page";

const ORG_ID = "77777777-7777-4777-8777-777777777777";
const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
/**
 * The order fixture's id needs a head and a tail that DIFFER.
 *
 * It used to be `44444444-4444-4444-8444-444444444444`, whose first and last
 * 8 characters are both `44444444` — so every assertion below passed
 * identically whether `formatOrderCode` took the tail (correct) or the head
 * (the exact bug this suite claims to pin: the head is also 8 hex chars, so it
 * parses as an order code and then resolves to nothing).
 */
const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
/** `formatOrderCode(ORDER_ID)` — the 8-hex TAIL, uppercased. */
const ORDER_CODE = "DB21B2C3";

type QueryCall = { input: unknown; options: Record<string, unknown> };

const testState = vi.hoisted(() => ({
  search: "",
  pushed: [] as string[],
  replaced: [] as string[],
  adminOrgSearch: [] as QueryCall[],
  data: undefined as unknown,
  isMobile: false,
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(testState.search),
  useParams: () => ({ slug: "org-admin" }),
  usePathname: () => "/admin/org-admin/search",
  useRouter: () => ({
    push: (url: string) => testState.pushed.push(url),
    replace: (url: string) => testState.replaced.push(url),
  }),
}));

vi.mock("@th/ui", () => ({
  // Category names are picked by locale (category-display-name).
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
  useFormatters: () => ({
    dateTime: (value: Date | number | string) =>
      `date(${new Date(value).toISOString().slice(0, 10)})`,
    currency: (amount: number, currency: string) =>
      `${currency}(${amount.toFixed(2)})`,
  }),
}));

vi.mock("@/lib/design-tokens", () => ({
  ACCENT: "var(--accent, #E2481D)",
  ACCENT_FILL: "var(--brandSecondaryHover, #B93312)",
  ACCENT_TEXT: "var(--accentText, #A8300F)",
  ON_ACCENT_FILL: "var(--onBrandSecondary, #FFFFFF)",
  ON_STRUCTURE: "var(--onStructure, #FDFAF3)",
  STRUCTURAL: "var(--structure, #211C16)",
}));

vi.mock("@/trpc", () => ({
  trpc: {
    search: {
      adminOrgSearch: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          testState.adminOrgSearch.push({ input, options });
          return { data: testState.data, isFetching: false };
        },
      },
    },
    categories: {
      list: {
        useQuery: () => ({
          data: {
            categories: [
              {
                id: CATEGORY_ID,
                slug: "music",
                name: "Music",
                active: true,
                sortOrder: 1,
                seoType: "MusicEvent",
              },
            ],
          },
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: { kind: "org", orgId: ORG_ID, adminSlug: "org-admin" },
  }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => testState.isMobile,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Every distinct `spotlight.*` key rendered — the mock echoes keys as copy.
 *
 * Walks TEXT NODES, not `container.textContent`: the latter concatenates
 * sibling elements with no separator, so two adjacent labels glue into
 * `spotlight.adminTypeAttendeesspotlight` and the key set silently goes wrong.
 */
function spotlightKeysIn(container: HTMLElement): string[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const keys = new Set<string>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const match of (node.nodeValue ?? "").matchAll(
      /spotlight\.[A-Za-z]+/g,
    )) {
      keys.add(match[0]);
    }
  }
  return [...keys].sort();
}

function testIdsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-testid]")]
    .map((node) => node.getAttribute("data-testid") ?? "")
    .sort();
}

/**
 * Apply the most recent navigation to the mocked URL, the way a real router
 * would. Without this the querystring never moves, so the URL → state effect
 * has nothing to react to and a "Back" cannot be simulated at all.
 */
function applyLastNavigation() {
  const url = testState.replaced.at(-1) ?? testState.pushed.at(-1);
  if (!url) throw new Error("expected a navigation");
  testState.search = new URL(url, "https://x").searchParams.toString();
}

function lastCall(): QueryCall {
  const call = testState.adminOrgSearch.at(-1);
  if (!call) throw new Error("expected at least one adminOrgSearch call");
  return call;
}

type AdminData = {
  events: {
    id: string;
    title: string | null;
    status: string;
    startsAt: Date | null;
    slug: string | null;
  }[];
  attendees: {
    buyerHumanId: string | null;
    name: string | null;
    email: string | null;
    eventTitles: string[];
    moreCount: number;
    orderCount: number;
    lastOrderAt: Date | null;
  }[];
  venues: { id: string; name: string; address: string | null }[];
  order: {
    id: string;
    status: string;
    buyerName: string | null;
    buyerEmail: string | null;
    eventTitle: string;
    amountGrossCents: number;
    currency: string;
    occurredAt: Date;
  } | null;
  counts: {
    events: { shown: number; total: number };
    attendees: { shown: number; total: number };
    venues: { shown: number; total: number };
  };
};

function adminData(overrides: Partial<AdminData> = {}): AdminData {
  const merged = {
    events: [],
    attendees: [],
    venues: [],
    order: null,
    ...overrides,
  } as Omit<AdminData, "counts">;
  return {
    ...merged,
    counts: {
      events: {
        shown: merged.events.length,
        total: merged.events.length,
      },
      attendees: {
        shown: merged.attendees.length,
        total: merged.attendees.length,
      },
      venues: { shown: merged.venues.length, total: merged.venues.length },
      ...(overrides.counts ?? {}),
    },
  };
}

const anEvent = (over: Partial<AdminData["events"][number]> = {}) => ({
  id: EVENT_ID,
  title: "Draft Night",
  status: "DRAFT",
  startsAt: null,
  slug: null,
  ...over,
});

const anOrder = (over: Partial<NonNullable<AdminData["order"]>> = {}) => ({
  id: ORDER_ID,
  status: "SUCCEEDED",
  buyerName: "Ada Lovelace",
  buyerEmail: "ada@example.com",
  eventTitle: "Night One",
  amountGrossCents: 4250,
  currency: "USD",
  occurredAt: new Date("2026-08-02T18:00:00.000Z"),
  ...over,
});

function renderPage(search = "") {
  testState.search = search;
  return render(<AdminSearchPage />);
}

beforeEach(() => {
  testState.search = "";
  testState.pushed = [];
  testState.replaced = [];
  testState.adminOrgSearch = [];
  testState.data = undefined;
  testState.isMobile = false;
});

// ── FR-011: URL → state ──────────────────────────────────────────────────────

describe("FR-011 — the spotlight hand-off lands pre-filtered", () => {
  it("applies search + status + category + type from the URL", () => {
    renderPage(
      `search=jazz&status=DRAFT&category=${CATEGORY_ID}&type=event`,
    );

    expect(lastCall().input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 50,
      types: ["event"],
      statuses: ["DRAFT"],
      categoryIds: [CATEGORY_ID],
    });
    expect(lastCall().options.enabled).toBe(true);
  });

  it("lights the pills that the URL set", () => {
    renderPage("search=jazz&status=DRAFT&type=event");

    expect(screen.getByTestId("admin-facet-status-DRAFT")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("admin-facet-status-ALL")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("admin-facet-type-event")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("admin-facet-type-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("restores a relative date facet from the hand-off's instant", () => {
    const anchor = new Date("2026-08-04T14:32:11.123Z");
    renderPage(`search=jazz&from=${encodeURIComponent(anchor.toISOString())}`);

    expect(screen.getByTestId("admin-facet-date-UPCOMING")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const { dateRange } = lastCall().input as { dateRange: { from: Date } };
    expect(dateRange.from.toISOString()).toBe(anchor.toISOString());
  });

  /**
   * The two-click collapse. Picking "Custom range" writes nothing to the URL
   * (a blank range is a mode, not a filter), so the NEXT commit re-parses the
   * date facet as ANY and the URL → state effect yanks the mode — and the
   * From/To inputs — out from under the user mid-task.
   */
  it("keeps a blank Custom range selected across an unrelated facet commit", () => {
    renderPage("search=jazz");

    fireEvent.click(screen.getByTestId("admin-facet-date-CUSTOM"));
    expect(screen.getByTestId("admin-facet-date-from")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("admin-facet-status-DRAFT"));
    applyLastNavigation();
    act(() => {
      render(<AdminSearchPage />);
    });

    expect(screen.getAllByTestId("admin-facet-date-CUSTOM").at(-1)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getAllByTestId("admin-facet-date-from").length).toBeGreaterThan(0);
  });

  it("hides the events-only facet rows when the pill is a non-event group", () => {
    renderPage("search=jazz&type=attendee");

    expect(
      screen.queryByTestId("admin-facet-status-DRAFT"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-facet-type-attendee")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("strips the facet keys off the wire for a non-event group", () => {
    renderPage("search=jazz&type=attendee&status=DRAFT");

    expect(lastCall().input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 50,
      types: ["attendee"],
    });
  });
});

// ── FR-011: state → URL ──────────────────────────────────────────────────────

describe("FR-011 — facet changes are written to the URL", () => {
  it("pushes the status facet with the spotlight's param name", () => {
    renderPage("search=jazz");
    fireEvent.click(screen.getByTestId("admin-facet-status-DRAFT"));

    // PUSH, not replace. Every control on this bar is discrete, and the repo
    // convention (search-url.ts's `diffIsContinuousOnly`) reserves `replace`
    // for continuous controls — of which this page has none. FR-011 also
    // requires back/forward to work, and `replace` leaves nothing to go back
    // to: Back would exit the page instead of undoing the filter.
    expect(testState.pushed).toEqual([
      "/admin/org-admin/search?search=jazz&status=DRAFT",
    ]);
    expect(testState.replaced).toEqual([]);
  });

  it("restores the prior facet state on Back", () => {
    const view = renderPage("search=jazz");
    fireEvent.click(screen.getByTestId("admin-facet-status-DRAFT"));
    expect(testState.pushed).toEqual([
      "/admin/org-admin/search?search=jazz&status=DRAFT",
    ]);

    // The pushed entry lands…
    applyLastNavigation();
    act(() => {
      view.rerender(<AdminSearchPage />);
    });
    expect(screen.getByTestId("admin-facet-status-DRAFT")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // …and Back returns to the entry it pushed ON TOP OF, which only exists
    // because this was a push. With `replace` there is nothing here.
    testState.search = "search=jazz";
    act(() => {
      view.rerender(<AdminSearchPage />);
    });

    expect(screen.getByTestId("admin-facet-status-ALL")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("admin-facet-status-DRAFT")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(lastCall().input).not.toHaveProperty("statuses");
    // …and the page does not shove the filter back over the navigation.
    expect(testState.pushed).toHaveLength(1);
    expect(testState.replaced).toEqual([]);
  });

  it("pushes a query submit too — nothing on this page replaces", () => {
    renderPage("search=jazz");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "blues" },
    });
    fireEvent.submit(screen.getByTestId("admin-search-form"));

    expect(testState.pushed).toEqual(["/admin/org-admin/search?search=blues"]);
    expect(testState.replaced).toEqual([]);
  });

  it("pushes the type facet as ?type=", () => {
    renderPage("search=jazz");
    fireEvent.click(screen.getByTestId("admin-facet-type-venue"));

    expect(testState.pushed).toEqual([
      "/admin/org-admin/search?search=jazz&type=venue",
    ]);
  });

  it("pushes a category selection as ?category=", () => {
    renderPage("search=jazz");
    fireEvent.change(screen.getByTestId("admin-facet-category"), {
      target: { value: CATEGORY_ID },
    });

    expect(testState.pushed).toEqual([
      `/admin/org-admin/search?search=jazz&category=${CATEGORY_ID}`,
    ]);
  });

  /**
   * "Uncategorised" is a peer of the categories, but it cannot live inside the
   * single-select: `Event.categoryId` is nullable, SQL `IN` never matches NULL,
   * and it composes with whatever the select holds rather than replacing it.
   */
  it("pushes the Uncategorised toggle as ?uncat=1, composing with ?category=", () => {
    renderPage("search=jazz");
    fireEvent.click(screen.getByTestId("admin-facet-uncategorised"));
    expect(testState.pushed).toEqual([
      "/admin/org-admin/search?search=jazz&uncat=1",
    ]);

    fireEvent.change(screen.getByTestId("admin-facet-category"), {
      target: { value: CATEGORY_ID },
    });
    expect(testState.pushed.at(-1)).toBe(
      `/admin/org-admin/search?search=jazz&category=${CATEGORY_ID}&uncat=1`,
    );
  });

  it("sends includeUncategorised on the wire, and nothing when it is off", () => {
    renderPage("search=jazz&uncat=1");
    expect(lastCall().input).toMatchObject({ includeUncategorised: true });

    renderPage("search=jazz");
    expect(lastCall().input).not.toHaveProperty("includeUncategorised");
  });

  it("drops the params when the facets are cleared", () => {
    renderPage(
      `search=jazz&status=DRAFT&category=${CATEGORY_ID}&uncat=1`,
    );
    fireEvent.click(screen.getByTestId("admin-facet-clear-all"));

    expect(testState.pushed).toEqual([
      "/admin/org-admin/search?search=jazz",
    ]);
  });

  /**
   * The classic failure this page is built to avoid: parse → state → build →
   * write → parse, forever. A URL the page itself produced must settle with
   * ZERO further navigations.
   */
  it("writes nothing when the URL already describes the state", () => {
    renderPage(`search=jazz&status=DRAFT&category=${CATEGORY_ID}&type=event`);

    expect(testState.pushed).toEqual([]);
    expect(testState.replaced).toEqual([]);
  });

  it("still writes nothing after a re-render", () => {
    const view = renderPage("search=jazz&status=DRAFT");
    act(() => {
      view.rerender(<AdminSearchPage />);
    });

    expect(testState.pushed).toEqual([]);
    expect(testState.replaced).toEqual([]);
  });

  /** Back/forward: the URL changes underneath, and the facets follow it. */
  it("adopts an externally-changed URL and does not push it back", () => {
    const view = renderPage("search=jazz&status=DRAFT");
    expect(screen.getByTestId("admin-facet-status-DRAFT")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    testState.search = "search=jazz";
    act(() => {
      view.rerender(<AdminSearchPage />);
    });

    expect(screen.getByTestId("admin-facet-status-DRAFT")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("admin-facet-status-ALL")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(lastCall().input).not.toHaveProperty("statuses");
    // Crucially: the page must NOT shove the pre-navigation state back.
    expect(testState.pushed).toEqual([]);
    expect(testState.replaced).toEqual([]);
  });
});

// ── FR-011: the wire ─────────────────────────────────────────────────────────

describe("FR-011 — facet → tRPC input", () => {
  it("never sends an empty array for types / statuses / categoryIds", () => {
    renderPage("search=jazz");
    const { input } = lastCall();

    expect(input).not.toHaveProperty("types");
    expect(input).not.toHaveProperty("statuses");
    expect(input).not.toHaveProperty("categoryIds");
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 50,
    });
  });

  it("keeps the query disabled below the minimum length with no facets", () => {
    renderPage("search=j");
    expect(lastCall().options.enabled).toBe(false);
  });

  /** FR-005 applies here too — an active facet IS a search intent. */
  it("enables a facet-only browse with types:['event'] on an empty query", () => {
    renderPage("status=DRAFT");

    const { input, options } = lastCall();
    expect(options.enabled).toBe(true);
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "",
      limit: 50,
      types: ["event"],
      statuses: ["DRAFT"],
    });
  });

  /**
   * The negative half: without the events-only gate, "Attendees + Drafts +
   * empty box" becomes an unfiltered dump of every recent buyer.
   */
  it("never browses attendees on facet-only intent", () => {
    renderPage("status=DRAFT&type=attendee");
    expect(lastCall().options.enabled).toBe(false);
  });

  it("keeps results from blanking on a facet flip", () => {
    renderPage("search=jazz");
    expect(lastCall().options.placeholderData).toBeTypeOf("function");
    expect(lastCall().options.staleTime).toBe(30_000);
  });
});

// ── FR-011: counts ───────────────────────────────────────────────────────────

describe("FR-011 — section counts report the scope total", () => {
  it("prints the total, not the page length", () => {
    testState.data = adminData({
      events: [anEvent()],
      counts: {
        events: { shown: 1, total: 200 },
        attendees: { shown: 0, total: 0 },
        venues: { shown: 0, total: 0 },
      },
    });
    renderPage("search=draft");

    // Capped page → "1 of 200", never a bare 200 over one row.
    expect(screen.getByText("spotlight.shownOfTotal:1,200")).toBeInTheDocument();
  });

  it("prints a bare total when the page is not capped", () => {
    testState.data = adminData({ events: [anEvent()] });
    renderPage("search=draft");

    expect(screen.queryByText(/shownOfTotal/)).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  /**
   * A total BELOW the rows on screen is impossible, but the UI must not repeat
   * the claim when the backend makes it. Live example at the time of writing:
   * `listForOrg` matches order identifiers while `countDistinctBuyersForOwner`
   * does not, so an id-shaped query returns `attendees {shown: 1, total: 0}` —
   * and "0 attendees" printed over a visible attendee row is the search
   * visibly lying about something the user can count.
   *
   * Clamping to `shown` invents no number: those rows are on screen, so "at
   * least this many" is provably true.
   */
  it("never claims a total lower than the rows on screen", () => {
    testState.data = adminData({
      events: [anEvent()],
      attendees: [
        {
          buyerHumanId: null,
          name: "Ada Lovelace",
          email: "ada@example.com",
          eventTitles: [],
          moreCount: 0,
          orderCount: 2,
          lastOrderAt: null,
        },
      ],
      counts: {
        // The impossible pair the backend can currently produce.
        events: { shown: 1, total: 0 },
        attendees: { shown: 1, total: 0 },
        venues: { shown: 0, total: 0 },
      },
    });
    renderPage(`search=${ORDER_ID}`);

    const headerCounts = screen
      .getAllByTestId("admin-search-section-count")
      .map((node) => node.textContent);
    expect(headerCounts).toEqual(["1", "spotlight.countTotal:1"]);

    // …and the live region agrees with what is on screen. The announcement
    // keeps `countAttendees` — the header drops the noun because its label
    // already supplies it, but a spoken list needs it.
    expect(screen.getByTestId("admin-search-announcement")).toHaveTextContent(
      "spotlight.countEvents:1, spotlight.countAttendees:1",
    );
  });

  /**
   * The units differ: `shown` is buyers deduped from a page of ORDERS, `total`
   * is distinct buyers in the whole scope. 137 matching buyers whose 20 most
   * recent orders all belong to one repeat customer would render "1 of 137" —
   * not a truncation, a division of two different things, and it reads as a
   * bug in the search. Events and venues keep the fraction; attendees must not.
   */
  it("never divides the attendee counts into a fraction", () => {
    testState.data = adminData({
      events: [anEvent()],
      attendees: [
        {
          buyerHumanId: null,
          name: "Repeat Customer",
          email: "repeat@example.com",
          eventTitles: [],
          moreCount: 0,
          orderCount: 20,
          lastOrderAt: null,
        },
      ],
      counts: {
        events: { shown: 1, total: 200 },
        attendees: { shown: 1, total: 137 },
        venues: { shown: 0, total: 0 },
      },
    });
    renderPage("search=draft");

    const headerCounts = screen
      .getAllByTestId("admin-search-section-count")
      .map((node) => node.textContent);

    // Events keep the fraction (same unit); attendees get the total alone.
    //
    // `countTotal` ("137 total"), not `countAttendees` ("137 attendees"): the
    // section header already reads ATTENDEES, so the noun was pure repetition.
    // The announcement below still uses `countAttendees`, where the groups are
    // read as a sentence and the noun is what makes it parse.
    expect(headerCounts).toEqual([
      "spotlight.shownOfTotal:1,200",
      "spotlight.countTotal:137",
    ]);
    expect(screen.queryByText("spotlight.shownOfTotal:1,137")).toBeNull();
  });

  it("announces the scope totals politely", () => {
    testState.data = adminData({
      events: [anEvent()],
      counts: {
        events: { shown: 1, total: 200 },
        attendees: { shown: 0, total: 3 },
        venues: { shown: 0, total: 0 },
      },
    });
    renderPage("search=draft");

    expect(screen.getByTestId("admin-search-announcement")).toHaveTextContent(
      "spotlight.countEvents:200, spotlight.countAttendees:3, spotlight.countVenues:0",
    );
  });

  /**
   * Without the order segment a finance admin who pastes an order UUID — where
   * the order row is the ONLY result — is told "0 events, 0 attendees,
   * 0 venues" over a visible row. The overlay already announces its order
   * group; the two surfaces must not disagree about what settled.
   */
  it("announces the order group when there is one", () => {
    testState.data = adminData({ order: anOrder() });
    renderPage(`search=${ORDER_ID}`);

    expect(screen.getByTestId("admin-search-announcement")).toHaveTextContent(
      "spotlight.countOrders:1, spotlight.countEvents:0",
    );
  });

  /** NFR-002: a null order must contribute nothing distinguishable. */
  it("says nothing about orders when there is none", () => {
    testState.data = adminData({ events: [anEvent()] });
    renderPage(`search=${ORDER_ID}`);

    expect(
      screen.getByTestId("admin-search-announcement").textContent ?? "",
    ).not.toMatch(/countOrders/);
  });

  /**
   * A group excluded via `types` reports `{shown:0,total:0}` because its query
   * never ran — announcing "0 venues" describes a search nobody asked for.
   */
  it("skips groups the user filtered out rather than announcing them as zero", () => {
    testState.data = adminData({ events: [anEvent()] });
    renderPage("search=draft&type=event");

    const announced =
      screen.getByTestId("admin-search-announcement").textContent ?? "";
    expect(announced).toBe("spotlight.countEvents:1");
    expect(announced).not.toMatch(/countAttendees|countVenues/);
  });
});

// ── NFR-003: the facet bar on a phone ────────────────────────────────────────

/**
 * Measured at 320x640, the inline bar wraps to NINE rows and its last control
 * sits at y=754 — the filter bar alone is taller than the viewport, so no
 * result is reachable without scrolling past a full screen of chrome.
 *
 * These are STRUCTURAL pins (jsdom has no layout, so `getBoundingClientRect`
 * is all zeros here and the real 320px measurement has to be re-run in a
 * browser). What they can prove is that the collapsed bar renders ONE control
 * instead of fifteen, which is the thing the height depended on.
 */
describe("NFR-003 — the facet bar collapses on mobile", () => {
  const facetBar = () => screen.getByTestId("admin-search-facets");

  it("renders a single control when collapsed", () => {
    testState.isMobile = true;
    renderPage("search=jazz");

    const controls = within(facetBar()).getAllByRole("button");
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAttribute("data-testid", "admin-facet-toggle");
    expect(
      screen.queryByTestId("admin-facet-panel"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("admin-facet-status-DRAFT"),
    ).not.toBeInTheDocument();
  });

  it("expands the existing bar on demand", () => {
    testState.isMobile = true;
    renderPage("search=jazz");

    const toggle = screen.getByTestId("admin-facet-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByTestId("admin-facet-panel").id,
    );
    expect(screen.getByTestId("admin-facet-status-DRAFT")).toBeInTheDocument();
    expect(screen.getByTestId("admin-facet-date-CUSTOM")).toBeInTheDocument();
    expect(screen.getByTestId("admin-facet-category")).toBeInTheDocument();
  });

  it("leaves the desktop bar inline with no disclosure", () => {
    renderPage("search=jazz");

    expect(screen.queryByTestId("admin-facet-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-facet-status-DRAFT")).toBeInTheDocument();
  });

  /**
   * The hand-off case: filters the user did NOT set arriving from "View all"
   * or a shared link. A collapsed bar reading only "Filters" would hide
   * exactly the state they most need to see.
   */
  it("shows the active count while collapsed", () => {
    testState.isMobile = true;
    renderPage(`search=jazz&status=DRAFT&category=${CATEGORY_ID}&type=event`);

    // group + status + category = 3.
    expect(screen.getByTestId("admin-facet-toggle")).toHaveTextContent(
      "spotlight.facetsToggle:3",
    );
  });

  /**
   * The uncategorised arm is a real filter, so it must reach the badge — a
   * collapsed bar reading "Filters" over a list narrowed to `categoryId IS
   * NULL` is exactly the hidden state this label exists to prevent.
   */
  it("counts the uncategorised arm on its own", () => {
    testState.isMobile = true;
    renderPage("search=jazz&uncat=1");
    expect(screen.getByTestId("admin-facet-toggle")).toHaveTextContent(
      "spotlight.facetsToggle:1",
    );
  });

  /**
   * Category is ONE facet however many of its arms are lit — this badge counts
   * facets, not selections.
   */
  it("counts the category facet once when both of its arms are on", () => {
    testState.isMobile = true;
    renderPage(`search=jazz&category=${CATEGORY_ID}&uncat=1`);
    expect(screen.getByTestId("admin-facet-toggle")).toHaveTextContent(
      "spotlight.facetsToggle:1",
    );
  });

  it("reads as unfiltered when nothing is applied", () => {
    testState.isMobile = true;
    renderPage("search=jazz");
    expect(screen.getByTestId("admin-facet-toggle")).toHaveTextContent(
      "spotlight.facetsToggle:0",
    );
  });

  /** A mode with no bound filters nothing, so badging it would overstate. */
  it("does not count a blank Custom range as an active filter", () => {
    testState.isMobile = true;
    renderPage("search=jazz&date=CUSTOM");

    expect(screen.getByTestId("admin-facet-toggle")).toHaveTextContent(
      "spotlight.facetsToggle:0",
    );
    fireEvent.click(screen.getByTestId("admin-facet-toggle"));
    expect(screen.getByTestId("admin-facet-date-CUSTOM")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

// ── FR-012: the order row ────────────────────────────────────────────────────

describe("FR-012 — the order row", () => {
  it("renders the order first, above events", () => {
    testState.data = adminData({ order: anOrder(), events: [anEvent()] });
    renderPage(`search=${ORDER_ID}`);

    const row = screen.getByTestId("admin-search-order-row");
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent(`#${ORDER_CODE}`);
    // The TAIL, never the head — the head is id-shaped and matches nothing.
    expect(row).not.toHaveTextContent(`#${ORDER_ID.slice(0, 8).toUpperCase()}`);
    // Buyer · event · amount · date — status omitted on the happy path.
    expect(row).toHaveTextContent("Ada Lovelace");
    expect(row).toHaveTextContent("Night One");
    expect(row).toHaveTextContent("USD(42.50)");
    expect(row).toHaveTextContent("date(2026-08-02)");
    expect(row).not.toHaveTextContent("spotlight.orderStatusSucceeded");

    // Order leads: it precedes the event row in document order.
    const eventRow = screen.getByText("Draft Night");
    expect(row.compareDocumentPosition(eventRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("annotates a status that is not the happy path", () => {
    testState.data = adminData({ order: anOrder({ status: "REFUNDED" }) });
    renderPage(`search=${ORDER_ID}`);

    const row = screen.getByTestId("admin-search-order-row");
    expect(row).toHaveTextContent("spotlight.orderStatusRefunded");

    // It must sit in the RIGHT column (like the event rows), not inside the
    // nowrap+ellipsis detail line where a 320px clip eats it — for a DISPUTED
    // order that is the one annotation the row exists to surface.
    const detail = row.querySelector('[style*="text-overflow: ellipsis"]');
    expect(detail?.textContent ?? "").not.toMatch(/orderStatus/);
  });

  /**
   * NFR-002, asserted STRUCTURALLY.
   *
   * The previous version regex'd the DOM for /permission|not found|no order/ —
   * but `useTranslations` is mocked to echo keys, so all copy is `spotlight.*`
   * and a newly-added `spotlight.orderNotFound` would have sailed straight
   * past it. Instead: an id-shaped query that finds no order must render the
   * EXACT same structure — same testids, same translation keys — as an
   * ordinary query that has no order to find. Any new key or node in that
   * branch fails here.
   */
  it("renders an unmatched id-shaped query identically to a plain query", () => {
    const data = adminData({ order: null, events: [anEvent()] });

    testState.data = data;
    const idShaped = renderPage(`search=${ORDER_ID}`);
    const idKeys = spotlightKeysIn(idShaped.container);
    const idIds = testIdsIn(idShaped.container);
    cleanup();

    testState.data = data;
    const plain = renderPage("search=draft");

    expect(spotlightKeysIn(plain.container)).toEqual(idKeys);
    expect(testIdsIn(plain.container)).toEqual(idIds);
    expect(idIds).not.toContain("admin-search-order-row");
  });

  /** And the same when there is nothing at all to show. */
  it("renders an unmatched id-shaped query with no results like any empty search", () => {
    const data = adminData({ order: null });

    testState.data = data;
    const idShaped = renderPage(`search=${ORDER_ID}`);
    const idKeys = spotlightKeysIn(idShaped.container);
    const idIds = testIdsIn(idShaped.container);
    cleanup();

    testState.data = data;
    const plain = renderPage("search=draft");

    expect(spotlightKeysIn(plain.container)).toEqual(idKeys);
    expect(testIdsIn(plain.container)).toEqual(idIds);
    expect(idIds).toContain("admin-search-empty");
  });

  /** The delta a REAL order introduces is confined to the order row itself. */
  it("adds only the order section when an order is present", () => {
    const base = { order: null, events: [anEvent()] };

    testState.data = adminData(base);
    const without = renderPage(`search=${ORDER_ID}`);
    const withoutKeys = spotlightKeysIn(without.container);
    const withoutIds = testIdsIn(without.container);
    cleanup();

    testState.data = adminData({ ...base, order: anOrder() });
    const withOrder = renderPage(`search=${ORDER_ID}`);

    expect(
      testIdsIn(withOrder.container).filter((id) => !withoutIds.includes(id)),
    ).toEqual(["admin-search-order-row"]);
    expect(
      spotlightKeysIn(withOrder.container).filter(
        (key) => !withoutKeys.includes(key),
      ),
    ).toEqual(["spotlight.adminTypeOrder", "spotlight.countOrders"]);
  });

  /**
   * FR-012's hand-off. The ONE order code (`formatOrderCode` — the 8-hex tail
   * of the order id, uppercased) is what the admin sees everywhere, so it is
   * what the pre-filled orders search box gets. This relies on `listForOrg` /
   * `listForHumanOwnedEvents` matching order identifiers, not just buyer
   * name/email.
   *
   * Replaces the old shortId-based hand-off: `Order.shortId` was a random
   * 10-char code the dashboard never displayed, so the two surfaces showed two
   * different codes for one order.
   */
  it("hands off to the orders list filtered by the order code", () => {
    testState.data = adminData({ order: anOrder() });
    renderPage(`search=${ORDER_ID}`);

    const row = screen.getByTestId("admin-search-order-row");
    expect(row).toHaveAttribute(
      "href",
      `/admin/org-admin/orders?q=${ORDER_CODE}`,
    );
    // The href carries exactly the code the row LABELS itself with, so the
    // hand-off cannot silently disagree with what the admin just read.
    expect(row).toHaveTextContent(`#${ORDER_CODE}`);
    // And it is the TAIL: an `?q=<head>` link is id-shaped, so the orders list
    // accepts it and returns nothing — a dead end that looks like "no order".
    expect(row).not.toHaveAttribute(
      "href",
      `/admin/org-admin/orders?q=${ORDER_ID.slice(0, 8).toUpperCase()}`,
    );
  });
});

// ── FR-013: attendee enrichment ──────────────────────────────────────────────

describe("FR-013 — attendee rows carry the order aggregates", () => {
  it("renders the owner-scoped order count and last order date", () => {
    testState.data = adminData({
      attendees: [
        {
          buyerHumanId: null,
          name: "Ada Lovelace",
          email: "ada@example.com",
          eventTitles: ["Night One"],
          moreCount: 2,
          orderCount: 3,
          lastOrderAt: new Date("2026-08-02T18:00:00.000Z"),
        },
      ],
    });
    renderPage("search=ada");

    expect(
      screen.getByText(
        "spotlight.attendeePurchases:3 · spotlight.attendeeLastPurchase:date(2026-08-02)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Night One, spotlight.moreEvents:2"),
    ).toBeInTheDocument();
  });

  /**
   * The attendee LIST comes from every order; the aggregate counts only
   * COMPLETED ones. A buyer sitting in the list on 20 held/cancelled orders
   * therefore has `orderCount: 0` — and calling that "0 orders" next to a row
   * that is in the list *because of orders* reads as a broken feature.
   * "0 purchases" is instead the actual signal: in your attendee list, never
   * completed a checkout.
   */
  it("does not contradict itself for a buyer with no completed purchases", () => {
    testState.data = adminData({
      attendees: [
        {
          buyerHumanId: null,
          name: "Cart Abandoner",
          email: "abandon@example.com",
          eventTitles: ["Night One"],
          moreCount: 0,
          orderCount: 0,
          lastOrderAt: null,
        },
      ],
    });
    renderPage("search=abandon");

    // The zero is SHOWN (hiding it would make a cart-abandoner look identical
    // to a buyer whose count merely hadn't loaded)…
    expect(
      screen.getByText("spotlight.attendeePurchases:0"),
    ).toBeInTheDocument();
    // …and no "0 orders" claim is made about a row derived from orders.
    expect(spotlightKeysIn(document.body).join(" ")).not.toMatch(
      /countOrders|attendeeOrders/,
    );
    // No date segment — the backend returns null there and it must not render.
    expect(
      screen.queryByText(/attendeeLastPurchase/),
    ).not.toBeInTheDocument();
  });

  it("omits the date when the buyer has none", () => {
    testState.data = adminData({
      attendees: [
        {
          buyerHumanId: null,
          name: null,
          email: null,
          eventTitles: [],
          moreCount: 0,
          orderCount: 1,
          lastOrderAt: null,
        },
      ],
    });
    renderPage("search=ada");

    expect(
      screen.getByText("spotlight.attendeePurchases:1"),
    ).toBeInTheDocument();
    expect(screen.getByText("spotlight.guestBuyer")).toBeInTheDocument();
  });
});
