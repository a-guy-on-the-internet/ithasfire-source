/**
 * SpotlightSearch — admin-context behaviour (admin-search-parity Phase A + B).
 *
 * These are LOGIC pins. The design system is mocked away and the overlay
 * renders in isolation, so nothing here says anything about how it LOOKS —
 * accessible-name collisions, overflow and hydration are invisible to this
 * harness by construction. Drive the real app for those.
 *
 * Covered:
 *   FR-001  admin queries `search.adminOrgSearch` (never `autocompleteAdmin`)
 *   FR-004  facet → tRPC input mapping (and never an empty array)
 *   FR-005  facet-only intent enables the query with `types: ["event"]`
 *   FR-006  no Groups pill; attendee row → /admin/{slug}/orders?q=<email>
 *   FR-007  geo pill + Surprise me are consumer-only
 *   FR-012  the order row renders on THIS surface too, and renders nothing
 *           (with no explanation) when `order` is null
 *   NFR-003 every pill exposes aria-pressed; the order row joins the listbox
 *   NFR-005 the consumer `search.autocomplete` args are unchanged
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SpotlightSearch } from "../SpotlightSearch";
import {
  closeSpotlight,
  getContextQuery,
  openSpotlight,
  setContextQuery,
} from "../spotlight-store";

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

type GroupCount = { shown: number; total: number };

type AdminSearchData = {
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
    /** FR-013 — ALL of this buyer's orders under the owner, not a page count. */
    orderCount: number;
    lastOrderAt: Date | null;
  }[];
  venues: { id: string; name: string; address: string | null }[];
  /** FR-012 — always present, null when there is nothing to show. */
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
    events: GroupCount;
    attendees: GroupCount;
    venues: GroupCount;
  };
};

const testState = vi.hoisted(() => ({
  pathname: "/",
  push: (_url: string) => {},
  autocomplete: [] as QueryCall[],
  autocompleteAdmin: [] as QueryCall[],
  adminOrgSearch: [] as QueryCall[],
  adminData: undefined as unknown,
  isMobile: false,
  geoCoords: null as { lat: number; lng: number } | null,
}));

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  usePathname: () => testState.pathname,
  useRouter: () => ({
    push: (url: string) => testState.push(url),
    replace: vi.fn(),
  }),
}));

vi.mock("@th/ui", () => ({
  useNotify: () => ({
    toast: { info: vi.fn(), danger: vi.fn(), success: vi.fn() },
  }),
  // Category names are picked by locale (category-display-name).
  useLocale: () => "en",
  useTranslations:
    () => (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
  // The real one formats through the APP locale, not the browser's.
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
      autocomplete: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          testState.autocomplete.push({ input, options });
          return { data: undefined, isFetching: false };
        },
      },
      autocompleteAdmin: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          testState.autocompleteAdmin.push({ input, options });
          return { data: undefined, isFetching: false };
        },
      },
      adminOrgSearch: {
        useQuery: (input: unknown, options: Record<string, unknown>) => {
          testState.adminOrgSearch.push({ input, options });
          return { data: testState.adminData, isFetching: false };
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

vi.mock("@/hooks/useSurpriseMe", () => ({
  useSurpriseMe: () => ({
    roll: vi.fn().mockResolvedValue({ status: "ok" }),
    isRolling: false,
  }),
}));

vi.mock("@/hooks/useCyclingPlaceholder", () => ({
  useCyclingPlaceholder: () => "",
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => testState.isMobile,
}));

vi.mock("@/hooks/useDebouncedValue", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

vi.mock("@/hooks/user-location/useUserLocation", () => ({
  useUserLocation: () => ({
    coords: testState.geoCoords,
    loading: false,
    error: null,
    request: vi.fn(),
  }),
}));

vi.mock("@/hooks/useImperial", () => ({
  useImperial: () => [false, vi.fn()] as const,
}));

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: testState.pathname.startsWith("/admin")
      ? { kind: "org", orgId: ORG_ID, orgName: "Org", adminSlug: "org-admin" }
      : null,
  }),
}));

vi.mock("@/components/maps/LocationAutocomplete", () => ({
  default: ({ placeholder }: { placeholder?: string }) => (
    <input aria-label={placeholder ?? "location"} />
  ),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Every distinct `spotlight.*` key rendered. Walks TEXT NODES, not
 * `textContent`: the latter concatenates siblings with no separator and glues
 * two adjacent labels into one bogus key.
 */
function spotlightKeysInBody(): string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
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

function rowTestIdsInBody(): string[] {
  return [...document.querySelectorAll("[data-spotlight-item]")]
    .map((node) => node.getAttribute("data-testid") ?? "")
    .sort();
}

function lastCall(calls: QueryCall[]): QueryCall {
  const call = calls.at(-1);
  if (!call) throw new Error("expected at least one query call");
  return call;
}

function openWith(pathname: string, context: "admin" | "consumer", query: string) {
  testState.pathname = pathname;
  act(() => {
    if (query) setContextQuery(context, query);
    openSpotlight();
  });
  return render(<SpotlightSearch />);
}

function adminData(overrides: Partial<AdminSearchData> = {}): AdminSearchData {
  const merged = {
    events: [],
    attendees: [],
    venues: [],
    order: null,
    ...overrides,
  } as Omit<AdminSearchData, "counts">;
  return {
    ...merged,
    // The overlay reads rows, not counts — these exist so the fixture matches
    // the Phase B output schema instead of the old bare-number `counts`.
    counts: {
      events: { shown: merged.events.length, total: merged.events.length },
      attendees: {
        shown: merged.attendees.length,
        total: merged.attendees.length,
      },
      venues: { shown: merged.venues.length, total: merged.venues.length },
      ...(overrides.counts ?? {}),
    },
  };
}

const anAttendee = (
  over: Partial<AdminSearchData["attendees"][number]> = {},
): AdminSearchData["attendees"][number] => ({
  buyerHumanId: null,
  name: null,
  email: null,
  eventTitles: [],
  moreCount: 0,
  orderCount: 1,
  lastOrderAt: null,
  ...over,
});

const anOrder = (
  over: Partial<NonNullable<AdminSearchData["order"]>> = {},
): NonNullable<AdminSearchData["order"]> => ({
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

/** Open the Status expander (if closed) and pick an option. */
function pickStatus(option: string) {
  if (!screen.queryByTestId(`spotlight-status-${option}`)) {
    fireEvent.click(screen.getByTestId("spotlight-facet-status"));
  }
  fireEvent.click(screen.getByTestId(`spotlight-status-${option}`));
}

/** jsdom has no layout, so it doesn't implement scrollIntoView. */
function stubScrollIntoView() {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = vi.fn();
  }
}

beforeEach(() => {
  stubScrollIntoView();
  testState.autocomplete = [];
  testState.autocompleteAdmin = [];
  testState.adminOrgSearch = [];
  testState.adminData = undefined;
  testState.isMobile = false;
  testState.geoCoords = null;
  testState.push = () => {};
  act(() => {
    closeSpotlight();
    setContextQuery("admin", "");
    setContextQuery("consumer", "");
    setContextQuery("platform", "");
  });
});

// ── FR-001: backend switch ───────────────────────────────────────────────────

describe("FR-001 — admin queries the org-truthful backend", () => {
  it("calls search.adminOrgSearch with the owner scope, never autocompleteAdmin", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");

    expect(testState.autocompleteAdmin).toHaveLength(0);
    const { input, options } = lastCall(testState.adminOrgSearch);
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 10,
    });
    expect(options.enabled).toBe(true);
    expect(options.staleTime).toBe(30_000);
    expect(options.placeholderData).toBeTypeOf("function");
  });

  it("sends no `types` key when no entity pill is active", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    expect(lastCall(testState.adminOrgSearch).input).not.toHaveProperty("types");
  });

  it("sends exactly one type when a group pill is selected", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));
    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      types: ["attendee"],
    });
  });

  it("keeps the admin query disabled below the minimum length with no facets", () => {
    openWith("/admin/org-admin/dashboard", "admin", "");
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(false);
  });
});

// ── NFR-005: consumer regression pin ─────────────────────────────────────────

describe("NFR-005 — consumer autocomplete args are unchanged", () => {
  it("sends { query, limit } with no filter", () => {
    openWith("/", "consumer", "jazz");

    // Both hooks always RUN (rules of hooks); only the admin one is disabled.
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(false);
    const { input, options } = lastCall(testState.autocomplete);
    expect(input).toEqual({ query: "jazz", limit: 8 });
    expect(options.enabled).toBe(true);
    expect(options.staleTime).toBe(30_000);
  });

  it("adds only `types` when a consumer pill is active", () => {
    openWith("/", "consumer", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-filter-event"));
    expect(lastCall(testState.autocomplete).input).toEqual({
      query: "jazz",
      limit: 8,
      types: ["event"],
    });
  });

  it("falls through to the consumer query in platform context", () => {
    act(() => setContextQuery("platform", "jazz"));
    openWith("/platform/orgs", "consumer", "");

    // FR-010: /platform/* keeps querying the public projection.
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(false);
    const { input, options } = lastCall(testState.autocomplete);
    expect(options.enabled).toBe(true);
    expect(input).toEqual({ query: "jazz", limit: 8 });
  });
});

// ── FR-004 / FR-005: facets ──────────────────────────────────────────────────

describe("FR-004 — facet → input mapping", () => {
  it("maps the Drafts pill to statuses: ['DRAFT']", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      statuses: ["DRAFT"],
    });
  });

  it("sends no `statuses` key for the All option", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    pickStatus("ALL");
    const { input } = lastCall(testState.adminOrgSearch);
    expect(input).not.toHaveProperty("statuses");
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 10,
    });
  });

  it("clears the status facet from the row's clear button", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    fireEvent.click(screen.getByTestId("spotlight-facet-status-clear"));
    expect(lastCall(testState.adminOrgSearch).input).not.toHaveProperty(
      "statuses",
    );
  });

  it("maps a category selection to categoryIds: [id]", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-category"));
    fireEvent.click(screen.getByTestId("spotlight-category-music"));
    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      categoryIds: [CATEGORY_ID],
    });
  });

  /**
   * "Uncategorised" is a PEER option in the same panel, but a toggle rather
   * than a selection: `Event.categoryId` is nullable and SQL `IN` never matches
   * NULL, so it cannot be a `categoryIds` entry, and it has to compose with one
   * ("Music OR uncategorised").
   */
  it("maps the Uncategorised option to includeUncategorised: true, with no categoryIds", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-category"));
    fireEvent.click(screen.getByTestId("spotlight-category-uncategorised"));

    const { input } = lastCall(testState.adminOrgSearch);
    expect(input).toMatchObject({ includeUncategorised: true });
    expect(input).not.toHaveProperty("categoryIds");
  });

  it("composes Uncategorised WITH a selected category", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-category"));
    fireEvent.click(screen.getByTestId("spotlight-category-music"));
    // Picking an option collapses the panel, so reopen to reach the toggle.
    fireEvent.click(screen.getByTestId("spotlight-facet-category"));
    fireEvent.click(screen.getByTestId("spotlight-category-uncategorised"));

    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      categoryIds: [CATEGORY_ID],
      includeUncategorised: true,
    });
  });

  it("clears BOTH category arms from the row's clear button", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-category"));
    fireEvent.click(screen.getByTestId("spotlight-category-uncategorised"));
    fireEvent.click(screen.getByTestId("spotlight-facet-category-clear"));

    const { input } = lastCall(testState.adminOrgSearch);
    expect(input).not.toHaveProperty("includeUncategorised");
    expect(input).not.toHaveProperty("categoryIds");
  });

  it("maps Upcoming to a dateRange with a frozen `from` bound", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-date"));
    fireEvent.click(screen.getByTestId("spotlight-date-UPCOMING"));

    const input = lastCall(testState.adminOrgSearch).input as {
      dateRange?: { from?: Date; to?: Date };
    };
    expect(input.dateRange?.from).toBeInstanceOf(Date);
    expect(input.dateRange).not.toHaveProperty("to");

    // The anchor is frozen at pick time — a later render must not move it.
    const first = input.dateRange?.from?.getTime();
    fireEvent.click(screen.getByTestId("spotlight-facet-date"));
    const after = (
      lastCall(testState.adminOrgSearch).input as {
        dateRange?: { from?: Date };
      }
    ).dateRange?.from?.getTime();
    expect(after).toBe(first);
  });

  it("treats a Custom range with empty inputs as no filter", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-date"));
    fireEvent.click(screen.getByTestId("spotlight-date-CUSTOM"));
    expect(lastCall(testState.adminOrgSearch).input).not.toHaveProperty(
      "dateRange",
    );
  });

  it("bounds a Custom range inclusively across the whole end day", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-date"));
    fireEvent.click(screen.getByTestId("spotlight-date-CUSTOM"));
    fireEvent.change(screen.getByTestId("spotlight-date-from"), {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByTestId("spotlight-date-to"), {
      target: { value: "2026-08-10" },
    });

    const { dateRange } = lastCall(testState.adminOrgSearch).input as {
      dateRange: { from: Date; to: Date };
    };
    expect(dateRange.from.getHours()).toBe(0);
    expect(dateRange.to.getDate()).toBe(10);
    expect(dateRange.to.getHours()).toBe(23);
  });
});

describe("FR-004 — facets are events-only, and the UI says so", () => {
  it("hides the facet row when the pill is pinned to a non-event group", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    expect(screen.getByTestId("spotlight-facet-row")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));
    expect(screen.queryByTestId("spotlight-facet-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spotlight-filter-venue"));
    expect(screen.queryByTestId("spotlight-facet-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spotlight-filter-event"));
    expect(screen.getByTestId("spotlight-facet-row")).toBeInTheDocument();
  });

  it("strips facet keys off the wire for a non-event group", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      statuses: ["DRAFT"],
    });

    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));
    expect(lastCall(testState.adminOrgSearch).input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "jazz",
      limit: 10,
      types: ["attendee"],
    });
  });

  it("gives the facets back when the pill returns to an event-inclusive group", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));
    fireEvent.click(screen.getByTestId("spotlight-filter-attendee")); // back to All

    expect(lastCall(testState.adminOrgSearch).input).toMatchObject({
      statuses: ["DRAFT"],
    });
    // ...and the row is lit again, not silently reset.
    expect(screen.getByTestId("spotlight-facet-status")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("drops the facet params from the View all hand-off too", () => {
    const pushed: string[] = [];
    testState.push = (url) => pushed.push(url);

    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    pickStatus("DRAFT");
    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));
    fireEvent.click(screen.getByTestId("spotlight-full-search"));

    expect(pushed).toEqual([
      "/admin/org-admin/search?search=jazz&type=attendee",
    ]);
  });

  it("collapses the expander once an option is picked", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-status"));
    expect(screen.getByTestId("spotlight-facet-panel")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("spotlight-status-DRAFT"));
    expect(
      screen.queryByTestId("spotlight-facet-panel"),
    ).not.toBeInTheDocument();
  });

  it("keeps the expander open on Custom so the date inputs stay reachable", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    fireEvent.click(screen.getByTestId("spotlight-facet-date"));
    fireEvent.click(screen.getByTestId("spotlight-date-CUSTOM"));

    expect(screen.getByTestId("spotlight-facet-panel")).toBeInTheDocument();
    expect(screen.getByTestId("spotlight-date-from")).toBeInTheDocument();
  });
});

describe("FR-005 — facet-only intent", () => {
  it("enables the query with types:['event'] on an empty box", () => {
    openWith("/admin/org-admin/dashboard", "admin", "");
    pickStatus("DRAFT");

    const { input, options } = lastCall(testState.adminOrgSearch);
    expect(options.enabled).toBe(true);
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "",
      limit: 10,
      types: ["event"],
      statuses: ["DRAFT"],
    });
  });

  it("returns to the idle state when the last facet is cleared", () => {
    openWith("/admin/org-admin/dashboard", "admin", "");
    pickStatus("DRAFT");
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(true);
    pickStatus("ALL");
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(false);
  });

  /**
   * The NEGATIVE half — the clause that stops a facet from turning an empty
   * box into a bulk buyer dump. Without the events-only gate, "Attendees +
   * Drafts + empty query" becomes an unfiltered
   * `orders.listForOrg({ searchQuery: undefined })`: every recent buyer of the
   * org, name and email, for anyone who can open ⌘K. Delete the gate and BOTH
   * assertions below fail.
   */
  it("never browses attendees on facet-only intent", () => {
    openWith("/admin/org-admin/dashboard", "admin", "");
    pickStatus("DRAFT");
    fireEvent.click(screen.getByTestId("spotlight-filter-attendee"));

    const { input, options } = lastCall(testState.adminOrgSearch);
    expect(options.enabled).toBe(false);
    expect(input).toEqual({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      query: "",
      limit: 10,
      types: ["attendee"],
    });
  });

  it("resets facets when the overlay is reopened", () => {
    const view = openWith("/admin/org-admin/dashboard", "admin", "");
    pickStatus("DRAFT");
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(true);

    // A stale relative date anchor ("Upcoming" frozen days ago) would quietly
    // mean the wrong thing, and reopening straight into a filtered browse
    // hides the idle hint.
    act(() => closeSpotlight());
    act(() => openSpotlight());
    view.rerender(<SpotlightSearch />);

    const { input, options } = lastCall(testState.adminOrgSearch);
    expect(options.enabled).toBe(false);
    expect(input).not.toHaveProperty("statuses");
    expect(screen.getByTestId("spotlight-facet-status")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

// ── FR-006: pills + routing ──────────────────────────────────────────────────

describe("FR-006 — admin groups and routing", () => {
  it("renders Events / Attendees / Venues and no Groups pill", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");

    expect(screen.getByTestId("spotlight-filter-event")).toBeInTheDocument();
    expect(screen.getByTestId("spotlight-filter-attendee")).toBeInTheDocument();
    expect(screen.getByTestId("spotlight-filter-venue")).toBeInTheDocument();
    expect(
      screen.queryByTestId("spotlight-filter-organization"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("spotlight-filter-human"),
    ).not.toBeInTheDocument();
  });

  it("routes an attendee row to the orders list filtered by email", () => {
    const pushed: string[] = [];
    testState.push = (url) => pushed.push(url);
    testState.adminData = adminData({
      attendees: [
        anAttendee({
          name: "Ada Lovelace",
          email: "ada+buyer@example.com",
          eventTitles: ["Night One"],
          moreCount: 2,
        }),
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", "ada");
    fireEvent.click(screen.getByText("Ada Lovelace"));

    expect(pushed).toEqual([
      "/admin/org-admin/orders?q=ada%2Bbuyer%40example.com",
    ]);
  });

  it("routes an event row to the admin event page", () => {
    const pushed: string[] = [];
    testState.push = (url) => pushed.push(url);
    testState.adminData = adminData({
      events: [
        {
          id: EVENT_ID,
          title: "Draft Night",
          status: "DRAFT",
          startsAt: null,
          slug: null,
        },
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", "draft");
    fireEvent.click(screen.getByText("Draft Night"));

    expect(pushed).toEqual([`/admin/org-admin/events/${EVENT_ID}`]);
  });

  it("keeps guest buyers with no human id from colliding on one key", () => {
    testState.adminData = adminData({
      attendees: [
        anAttendee({ email: "one@example.com" }),
        anAttendee({ email: "two@example.com" }),
        // Neither a name nor an email — nothing to render or filter on.
        anAttendee(),
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", "example");

    expect(screen.getByText("one@example.com")).toBeInTheDocument();
    expect(screen.getByText("two@example.com")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("falls back to a translated title for an untitled event", () => {
    testState.adminData = adminData({
      events: [
        {
          id: EVENT_ID,
          title: null,
          status: "DRAFT",
          startsAt: null,
          slug: null,
        },
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", "x y");
    expect(screen.getByText("spotlight.untitledEvent")).toBeInTheDocument();
  });
});

// ── FR-012: the order row ────────────────────────────────────────────────────

/**
 * The overlay already FETCHED an order before Phase B — the backend's default
 * `types` includes `"order"` — and silently discarded it. These pin that it is
 * rendered, that it leads, and that a null order says nothing.
 */
describe("FR-012 — the order row renders here too", () => {
  it("puts the order above the events group", () => {
    testState.adminData = adminData({
      order: anOrder(),
      events: [
        {
          id: EVENT_ID,
          title: "Draft Night",
          status: "DRAFT",
          startsAt: null,
          slug: null,
        },
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);

    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(`#${ORDER_CODE}`);
    // The TAIL, never the head — the head is id-shaped and matches nothing.
    expect(rows[0]).not.toHaveTextContent(
      `#${ORDER_ID.slice(0, 8).toUpperCase()}`,
    );
    expect(rows[0]).toHaveTextContent("USD(42.50)");
    expect(rows[1]).toHaveTextContent("Draft Night");
  });

  it("routes to the orders list filtered by the order code", () => {
    // The ONE order code (`formatOrderCode`) — the same string the row shows,
    // so what the admin clicks and what the orders list is filtered by can
    // never be two different codes (they were, when this used Order.shortId).
    const pushed: string[] = [];
    testState.push = (url) => pushed.push(url);
    testState.adminData = adminData({ order: anOrder() });

    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);
    fireEvent.click(screen.getByText(`#${ORDER_CODE}`));

    expect(pushed).toEqual([`/admin/org-admin/orders?q=${ORDER_CODE}`]);
  });

  /**
   * NFR-002 — not id-shaped / no match / no finance access / group filtered
   * out are all the same `null`, and they must stay indistinguishable.
   *
   * Asserted STRUCTURALLY. A regex for /permission|not found|no order/ looks
   * strong but is not: `useTranslations` is mocked to echo keys, so all copy is
   * `spotlight.*` and a newly-added `spotlight.orderNotFound` would pass it.
   * Instead an unmatched id-shaped query must render the exact same rows and
   * the exact same key set as an ordinary query with no order.
   */
  it("renders an unmatched id-shaped query identically to a plain query", () => {
    const venues = [{ id: EVENT_ID, name: "The Basement", address: null }];

    testState.adminData = adminData({ order: null, venues });
    const idShaped = openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);
    const idKeys = spotlightKeysInBody();
    const idRows = rowTestIdsInBody();
    idShaped.unmount();
    act(() => closeSpotlight());

    testState.adminData = adminData({ order: null, venues });
    openWith("/admin/org-admin/dashboard", "admin", "basement");

    expect(spotlightKeysInBody()).toEqual(idKeys);
    expect(rowTestIdsInBody()).toEqual(idRows);
    expect(idRows).toHaveLength(1);
    expect(idKeys).not.toContain("spotlight.adminTypeOrder");
  });

  it("adds only the order row when an order is present", () => {
    const venues = [{ id: EVENT_ID, name: "The Basement", address: null }];

    testState.adminData = adminData({ order: null, venues });
    const without = openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);
    const withoutKeys = spotlightKeysInBody();
    const withoutRows = rowTestIdsInBody();
    without.unmount();
    act(() => closeSpotlight());

    testState.adminData = adminData({ order: anOrder(), venues });
    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);

    expect(
      rowTestIdsInBody().filter((id) => !withoutRows.includes(id)),
    ).toEqual([`spotlight-result-order:${ORDER_ID}`]);
    expect(
      spotlightKeysInBody().filter((key) => !withoutKeys.includes(key)),
    ).toEqual(["spotlight.adminTypeOrder", "spotlight.countOrders"]);
  });

  it("keeps the order row inside the listbox traversal", () => {
    testState.adminData = adminData({ order: anOrder() });

    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);

    const input = screen.getByTestId("spotlight-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    expect(screen.getByTestId("spotlight-announcement")).toHaveTextContent(
      "spotlight.countOrders:1",
    );
  });
});

describe("FR-012 — the order status survives the clamp", () => {
  it("leads the single-line subtitle with the status", () => {
    testState.adminData = adminData({
      order: anOrder({ status: "DISPUTED" }),
    });

    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);

    // The overlay has ONE clamped subtitle line, so the annotation the row
    // exists to surface has to come first — anything after it is what the
    // ellipsis eats at 320px.
    const subtitle = screen
      .getByTestId(`spotlight-result-order:${ORDER_ID}`)
      .textContent?.replace(`#${ORDER_CODE}`, "");
    expect(subtitle?.trimStart().startsWith("spotlight.orderStatusDisputed")).toBe(
      true,
    );
  });

  it("says nothing about status on the happy path", () => {
    testState.adminData = adminData({ order: anOrder() });
    openWith("/admin/org-admin/dashboard", "admin", ORDER_ID);
    expect(
      screen.getByTestId(`spotlight-result-order:${ORDER_ID}`),
    ).not.toHaveTextContent("spotlight.orderStatus");
  });
});

// ── FR-007: a stale consumer location must not leak into admin ───────────────

/**
 * Phase A bug, first exploitable now that Phase B consumes these URLs.
 * `geoLocation` lives on an overlay that never unmounts, so it survives a
 * client navigation into /admin/*. The geo pill is correctly hidden there —
 * which is exactly what made this invisible: `isSearching` went true on a
 * location the admin could not see, firing `adminOrgSearch` with an empty
 * query and no `types` and dumping the org's events, buyers and venues.
 */
describe("FR-007 — stale geo does not drive an admin search", () => {
  function pickLocationThenGoToAdmin() {
    testState.geoCoords = { lat: 36.16, lng: -86.78 };
    const view = openWith("/", "consumer", "");
    // Coords are already available, so opening the panel resolves the location
    // through the component's own effect.
    fireEvent.click(screen.getByTestId("spotlight-geo-toggle"));
    expect(screen.getByTestId("spotlight-clear-geo")).toBeInTheDocument();

    testState.pathname = "/admin/org-admin/dashboard";
    act(() => {
      view.rerender(<SpotlightSearch />);
    });
    return view;
  }

  it("keeps the empty-box admin query disabled", () => {
    pickLocationThenGoToAdmin();
    expect(lastCall(testState.adminOrgSearch).options.enabled).toBe(false);
  });

  it("still browses by distance in consumer context", () => {
    testState.geoCoords = { lat: 36.16, lng: -86.78 };
    openWith("/", "consumer", "");
    fireEvent.click(screen.getByTestId("spotlight-geo-toggle"));

    // NFR-005: consumer geo-as-intent is untouched.
    expect(lastCall(testState.autocomplete).options.enabled).toBe(true);
  });

  it("writes no geo params into the admin View all hand-off", () => {
    const pushed: string[] = [];
    const view = pickLocationThenGoToAdmin();
    testState.push = (url) => pushed.push(url);

    // "View all" only renders once there IS a search intent — and with the geo
    // term correctly gated out of admin, a typed query is the only way to get
    // one. Go through the store so the 700ms text debounce is already settled.
    act(() => setContextQuery("admin", "jazz"));
    view.rerender(<SpotlightSearch />);

    fireEvent.click(screen.getByTestId("spotlight-full-search"));

    expect(pushed).toEqual(["/admin/org-admin/search?search=jazz"]);
  });
});

// ── FR-007: consumer-only affordances ────────────────────────────────────────

describe("FR-007 — admin sheds consumer-only affordances", () => {
  it("hides the geo pill and Surprise me in admin", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");
    expect(screen.queryByTestId("spotlight-geo-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("spotlight-surprise")).not.toBeInTheDocument();
  });

  it("keeps both in consumer context", () => {
    openWith("/", "consumer", "jazz");
    expect(screen.getByTestId("spotlight-geo-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("spotlight-surprise")).toBeInTheDocument();
  });

  it("carries active facets onto the View all hand-off", () => {
    const pushed: string[] = [];
    testState.push = (url) => pushed.push(url);

    openWith("/admin/org-admin/dashboard", "admin", "");
    pickStatus("DRAFT");
    fireEvent.click(screen.getByTestId("spotlight-full-search"));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toBe("/admin/org-admin/search?status=DRAFT");
  });
});

// ── NFR-003: a11y ────────────────────────────────────────────────────────────

describe("NFR-003 — pill and listbox semantics", () => {
  it("exposes aria-pressed on every entity and facet pill", () => {
    openWith("/admin/org-admin/dashboard", "admin", "jazz");

    expect(screen.getByTestId("spotlight-filter-all")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("spotlight-filter-event")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    fireEvent.click(screen.getByTestId("spotlight-filter-event"));
    expect(screen.getByTestId("spotlight-filter-event")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(screen.getByTestId("spotlight-facet-status")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    pickStatus("DRAFT");
    expect(screen.getByTestId("spotlight-facet-status")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("wires the listbox / combobox pair and announces the counts", () => {
    testState.adminData = adminData({
      events: [
        {
          id: EVENT_ID,
          title: "Draft Night",
          status: "DRAFT",
          startsAt: null,
          slug: null,
        },
      ],
    });

    openWith("/admin/org-admin/dashboard", "admin", "draft");

    const listbox = screen.getByRole("listbox");
    const input = screen.getByTestId("spotlight-input");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(screen.getByTestId("spotlight-announcement")).toHaveTextContent(
      "spotlight.countEvents:1",
    );

    // Arrow-down points aria-activedescendant at the first row.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = screen.getByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
  });
});

// ── Per-context query isolation ──────────────────────────────────────────────

describe("per-context query isolation", () => {
  /**
   * The overlay's `query` is local state that only OPEN resets, so it outlives
   * a close. The persist effect used to list `context` in its deps, which meant
   * a mere context CHANGE re-ran it and re-attributed the stale query to the
   * new context. Verified in the browser before the fix: searching
   * "ORD-4F2A refund" in admin and taking the workspace switcher's
   * exit-to-attendee (a client-side `router.push("/")`) put that internal order
   * reference in the PUBLIC navbar trigger.
   */
  it("does not carry an admin query into the consumer slot on a client-side context switch", () => {
    const { rerender } = openWith("/admin/org-admin/dashboard", "admin", "");

    fireEvent.change(screen.getByTestId("spotlight-input"), {
      target: { value: "ORD-4F2A refund" },
    });
    act(() => {
      closeSpotlight();
    });
    expect(getContextQuery("admin")).toBe("ORD-4F2A refund");

    // Exit to the attendee view: the overlay never unmounts, only the path
    // changes, so `context` flips admin → consumer under a live `query`.
    testState.pathname = "/";
    act(() => {
      rerender(<SpotlightSearch />);
    });

    expect(getContextQuery("consumer")).toBe("");
    expect(getContextQuery("admin")).toBe("ORD-4F2A refund");
  });

  it("does not carry a consumer query into the admin slot on the way back", () => {
    const { rerender } = openWith("/", "consumer", "");

    fireEvent.change(screen.getByTestId("spotlight-input"), {
      target: { value: "punk show friday" },
    });
    act(() => {
      closeSpotlight();
    });
    expect(getContextQuery("consumer")).toBe("punk show friday");

    testState.pathname = "/admin/org-admin/dashboard";
    act(() => {
      rerender(<SpotlightSearch />);
    });

    expect(getContextQuery("admin")).toBe("");
    expect(getContextQuery("consumer")).toBe("punk show friday");
  });
});

describe("a close inside the enter transition", () => {
  /**
   * Opening schedules a double-rAF that flips the backdrop visible and
   * clickable. A ⌘K⌘K faster than two frames closed the store first, then the
   * stale frame landed `animIn = true` anyway: a CLOSED overlay sat on screen
   * taking clicks until the exit timer unmounted it. Frames are queued by hand
   * here so the close provably lands between them.
   */
  it("leaves the backdrop hidden and inert when closed before the frames run", () => {
    let nextId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      });
    const caf = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const flushFrames = () =>
      act(() => {
        for (let i = 0; i < 3; i++) {
          const pending = [...frames.entries()];
          frames.clear();
          for (const [, cb] of pending) cb(0);
        }
      });

    try {
      openWith("/", "consumer", "");
      act(() => {
        closeSpotlight();
      });
      flushFrames();

      const backdrop = screen.getByTestId("spotlight-backdrop");
      expect(backdrop.style.pointerEvents).toBe("none");
      expect(backdrop.style.opacity).toBe("0");
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });
});
