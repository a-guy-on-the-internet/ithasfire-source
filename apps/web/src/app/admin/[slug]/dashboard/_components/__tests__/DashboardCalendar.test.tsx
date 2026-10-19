import { fireEvent, render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard mount of the calendar engine (event-calendar-redesign,
 * phase 2b). The ENGINE is real; tRPC, the owner hook and the create hook
 * are stubbed. Pins: one `listMine` per selected owner with the bounded
 * expanding window, owner chips on a personal dashboard only, hold items
 * from the requester-side read, view persistence (with the retired "day"
 * falling back), the FR-019 create-owner rule, and the series select built
 * from the DISTINCT series among the fetched rows (phase 2).
 */

const TZ = "America/Chicago";

type Owner =
  | { kind: "human"; humanId: string; humanName: string; humanUsername: string | null; avatarUrl: null; adminSlug: string }
  | { kind: "org"; orgId: string; orgName: string; orgSlug: string; role: "OWNER"; avatarUrl: null; adminSlug: string };

const HUMAN: Owner = {
  kind: "human",
  humanId: "h1",
  humanName: "Willa",
  humanUsername: "willa",
  avatarUrl: null,
  adminSlug: "@willa",
};
const ORG: Owner = {
  kind: "org",
  orgId: "o1",
  orgName: "Blue Room Collective",
  orgSlug: "blue-room",
  role: "OWNER",
  avatarUrl: null,
  adminSlug: "blue-room",
};

const state = vi.hoisted(() => ({
  currentOwner: null as unknown,
  owners: [] as unknown[],
  listMineCalls: [] as Array<Record<string, unknown>>,
  holdCalls: [] as Array<Record<string, unknown>>,
  events: new Map<string, unknown[]>(),
  holds: new Map<string, unknown[]>(),
  push: vi.fn(),
  createDraftAt: vi.fn(),
  prefetch: vi.fn(),
}));

vi.mock("@th/ui", async () => {
  const { uiStub } = await import("@/app/admin/[slug]/_components/calendar/__tests__/ui.stub");
  return {
    ...uiStub,
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
      key === "admin.ecSubscribe" ? `Copy subscribe link (${values?.language})` : key,
  };
});
const copyTextMock = vi.hoisted(() => vi.fn((_text: string) => Promise.resolve(true)));
vi.mock("@/lib/calendar/calendar-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/calendar/calendar-actions")>()),
  copyText: copyTextMock,
}));
vi.mock("lucide-react", async () => {
  const { lucideStub } = await import("@/app/admin/[slug]/_components/calendar/__tests__/ui.stub");
  const Icon = () => <span data-icon="true" />;
  return { ...lucideStub, Download: Icon, Rss: Icon };
});
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useViewerTimezone", () => ({ useViewerTimezone: () => TZ }));
vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@tanstack/react-query", () => ({ keepPreviousData: (x: unknown) => x }));
vi.mock("@/config/trpc", () => ({ getTrpcHttpUrl: () => "http://localhost:3001/trpc" }));
vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: state.currentOwner,
    ownerEntities: { ownersWithSlugs: state.owners },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useCreateDraftEvent", () => ({
  useCreateDraftEvent: () => ({
    createDraft: vi.fn(),
    createDraftAt: state.createDraftAt,
    modeChoiceDialog: null,
  }),
}));

vi.mock("@/trpc", () => {
  const result = (data: unknown) => ({
    data,
    isPending: false,
    isPlaceholderData: false,
    isError: false,
    refetch: vi.fn(),
  });
  const q = {
    events: {
      listMine: (input: Record<string, unknown>) => {
        state.listMineCalls.push(input);
        return result({ items: state.events.get(String(input.ownerId)) ?? [] });
      },
    },
    bookingHolds: {
      listForRequester: (input: Record<string, unknown>) => {
        state.holdCalls.push(input);
        return result({ holds: state.holds.get(String(input.ownerId)) ?? [] });
      },
    },
    // No `series` router on purpose: the mount must build its series select
    // from the fetched rows, never a second read.
  };
  return {
    trpc: {
      useUtils: () => ({ events: { listMine: { prefetch: state.prefetch } } }),
      useQueries: (build: (proxy: typeof q) => unknown[]) => build(q),
    },
  };
});

import { zonedInstant } from "@/app/admin/[slug]/_components/calendar/helpers";
import {
  DashboardCalendar,
  VIEW_STORAGE_KEY,
  filtersStorageKey,
  parseStoredFilters,
  toEventItems,
  toHoldItems,
} from "../DashboardCalendar";

const at = (m: number, d: number, h: number) => zonedInstant(2026, m, d, h, 0, TZ);

const row = (over: Record<string, unknown>) => ({
  id: "evt",
  title: "Event",
  status: "PUBLISHED",
  startsAt: at(9, 5, 20),
  endsAt: at(9, 5, 23),
  slug: null,
  placeName: "The Blue Room",
  ticketsSold: 12,
  totalCapacity: 100,
  timezone: TZ,
  occurrence: null,
  seriesId: null,
  seriesName: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ now: at(9, 2, 12), toFake: ["Date"] });
  window.localStorage.clear();
  state.currentOwner = HUMAN;
  state.owners = [HUMAN, ORG];
  state.listMineCalls = [];
  state.holdCalls = [];
  state.events = new Map([
    ["h1", [row({ id: "e-h", title: "Willa solo set" })]],
    ["o1", [row({ id: "e-o", title: "Collective night", startsAt: at(9, 6, 20), endsAt: at(9, 6, 22) })]],
  ]);
  state.holds = new Map([
    [
      "o1",
      [
        {
          id: "hold-1",
          bookingRequestId: "req-1",
          calendarId: "c1",
          spaceId: null,
          placeId: "p1",
          placeName: "Drkmttr",
          date: "2026-09-08",
          position: 2,
          status: "ACTIVE",
          respondBy: null,
          requestTitle: "Willa & the Wolves",
        },
      ],
    ],
  ]);
  state.push.mockReset();
  state.createDraftAt.mockReset();
  state.prefetch.mockReset();
});

describe("DashboardCalendar", () => {
  it("personal dashboard: one bounded expanding listMine per owner, owner chips, both owners' items, and the hold", () => {
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);

    const owners = state.listMineCalls.map((c) => c.ownerId).sort();
    expect(owners).toEqual(["h1", "o1"]);
    for (const call of state.listMineCalls) {
      expect(call.expandDates).toBe(true);
      expect(call.limit).toBe(100);
      const range = call.dateRange as { from: Date; to: Date };
      expect(range.from).toBeInstanceOf(Date);
      expect(range.to.getTime()).toBeGreaterThan(range.from.getTime());
    }
    expect(state.holdCalls.map((c) => c.ownerType).sort()).toEqual(["HUMAN", "ORGANIZATION"]);

    // Agenda is the dashboard default (FR-008).
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("agenda");
    expect(screen.getByTestId("calendar-filter-owner-human:h1")).toBeTruthy();
    expect(screen.getByTestId("calendar-filter-owner-org:o1")).toBeTruthy();
    expect(screen.getByTestId("calendar-agenda-row-e-h:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-agenda-row-e-o:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-agenda-row-hold-1").textContent).toContain("Hold at Drkmttr");
  });

  it("offers one subscribe item per feed language; English copies the plain URL, Español adds ?lang=es", () => {
    copyTextMock.mockClear();
    state.currentOwner = ORG;
    render(<DashboardCalendar slug="blue-room" displayName="Blue Room" />);
    const en = screen.getByRole("menuitem", { name: "Copy subscribe link (English)" });
    const es = screen.getByRole("menuitem", { name: "Copy subscribe link (Español)" });
    act(() => { fireEvent.click(en); });
    act(() => { fireEvent.click(es); });
    expect(copyTextMock.mock.calls.map((c) => c[0])).toEqual([
      "webcal://localhost:3001/api/orgs/o1/calendar.ics",
      "webcal://localhost:3001/api/orgs/o1/calendar.ics?lang=es",
    ]);
  });

  it("org dashboard: a single owner, no owner chips", () => {
    state.currentOwner = ORG;
    render(<DashboardCalendar slug="blue-room" displayName="Blue Room Collective" />);
    expect(state.listMineCalls.map((c) => c.ownerId)).toEqual(["o1"]);
    expect(screen.queryByTestId("calendar-filter-owner-org:o1")).toBeNull();
    expect(screen.queryByTestId("calendar-agenda-row-e-h:0")).toBeNull();
  });

  it("restores the stored view; the retired 'day' value falls back to agenda", async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "day");
    const { unmount } = render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    await act(async () => {});
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("agenda");
    unmount();

    window.localStorage.setItem(VIEW_STORAGE_KEY, "month");
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    await act(async () => {});
    expect(screen.getByTestId("event-calendar").getAttribute("data-view")).toBe("month");
    expect(state.prefetch).toHaveBeenCalled();
  });

  it("persists view and filters under the documented keys", async () => {
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    await act(async () => {});
    fireEvent.click(screen.getByTestId("calendar-view-month"));
    expect(window.localStorage.getItem(VIEW_STORAGE_KEY)).toBe("month");

    fireEvent.click(screen.getByTestId("calendar-filter-status-draft"));
    const stored = parseStoredFilters(window.localStorage.getItem(filtersStorageKey("@willa")));
    expect(stored?.statuses.has("DRAFT")).toBe(false);
    expect(stored?.statuses.has("PUBLISHED")).toBe(true);
  });

  it("series select lists the DISTINCT series among the fetched rows; picking one hides non-series and other-series items", async () => {
    const jam = { seriesId: "s-jam", seriesName: "Tuesday Jam" };
    state.events = new Map([
      [
        "h1",
        [
          row({ id: "solo", title: "Willa solo set" }),
          row({ id: "jam-1", title: "Jam #1", ...jam, startsAt: at(9, 8, 20), endsAt: at(9, 8, 22) }),
        ],
      ],
      [
        "o1",
        [
          row({ id: "jam-2", title: "Jam #2", ...jam, startsAt: at(9, 15, 20), endsAt: at(9, 15, 22) }),
          row({ id: "res-1", title: "Residency night", seriesId: "s-res", seriesName: "Residency", startsAt: at(9, 9, 20), endsAt: at(9, 9, 22) }),
        ],
      ],
    ]);
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    await act(async () => {});

    const select = screen.getByTestId("calendar-filter-series") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["All series", "Residency", "Tuesday Jam"]);
    expect([...select.options].map((o) => o.value)).toEqual(["all", "s-res", "s-jam"]);
    for (const id of ["solo", "jam-1", "jam-2", "res-1"]) {
      expect(screen.getByTestId(`calendar-agenda-row-${id}:0`)).toBeTruthy();
    }

    fireEvent.change(select, { target: { value: "s-jam" } });
    expect(screen.getByTestId("calendar-agenda-row-jam-1:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-agenda-row-jam-2:0")).toBeTruthy();
    expect(screen.queryByTestId("calendar-agenda-row-solo:0")).toBeNull();
    expect(screen.queryByTestId("calendar-agenda-row-res-1:0")).toBeNull();
    expect(
      parseStoredFilters(window.localStorage.getItem(filtersStorageKey("@willa")))?.seriesId,
    ).toBe("s-jam");

    fireEvent.change(screen.getByTestId("calendar-filter-series"), { target: { value: "all" } });
    expect(screen.getByTestId("calendar-agenda-row-solo:0")).toBeTruthy();
    expect(screen.getByTestId("calendar-agenda-row-res-1:0")).toBeTruthy();
  });

  it("no series among the fetched rows ⇒ no series select", () => {
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    expect(screen.queryByTestId("calendar-filter-series")).toBeNull();
  });

  it("FR-019: exactly one org selected ⇒ the draft opens under that org; otherwise the current slug", async () => {
    window.localStorage.setItem(VIEW_STORAGE_KEY, "month");
    render(<DashboardCalendar slug="@willa" displayName="Willa" />);
    await act(async () => {});

    // All owners selected → current slug's quick create.
    fireEvent.click(screen.getByTestId("calendar-day-create-2026-09-10"));
    expect(state.createDraftAt).toHaveBeenCalledWith(
      { startsAt: "2026-09-10T19:00" },
      undefined,
    );
    expect(state.push).not.toHaveBeenCalled();

    // Deselect the human → only the org remains → org context. BOTH paths go
    // through `createDraftAt`, never a raw router.push: the one-org path used
    // to skip the moderator Ticketed-vs-Community chooser entirely.
    fireEvent.click(screen.getByTestId("calendar-filter-owner-human:h1"));
    fireEvent.click(screen.getByTestId("calendar-day-create-2026-09-10"));
    expect(state.createDraftAt).toHaveBeenLastCalledWith(
      { startsAt: "2026-09-10T19:00" },
      { slug: "blue-room" },
    );
    expect(state.push).not.toHaveBeenCalled();
  });
});

describe("DashboardCalendar mappers", () => {
  it("toEventItems: occurrence-qualified ids, owner hrefs, skips unscheduled and archived rows", () => {
    const items = toEventItems(
      [
        row({ id: "a", occurrence: { index: 2, total: 5 }, slug: "a-slug" }),
        row({ id: "b", startsAt: null }),
        row({ id: "c", status: "ARCHIVED" }),
      ],
      ORG,
    );
    expect(items.map((i) => i.id)).toEqual(["a:2"]);
    expect(items[0]).toMatchObject({
      eventId: "a",
      ownerKey: "org:o1",
      ownerName: "Blue Room Collective",
      venueName: "The Blue Room",
      occurrence: { index: 2, total: 5 },
      ticketsSold: 12,
      totalCapacity: 100,
      href: { edit: "/admin/blue-room/events/a/edit", public: "/events/a-slug" },
    });
  });

  it("toHoldItems: midnight of the held day in the paint zone, booking link in the owner's admin", () => {
    const [item] = toHoldItems(
      [
        {
          id: "hold-1",
          bookingRequestId: "req-1",
          placeName: "Drkmttr",
          date: "2026-09-08",
          position: 2,
          status: "CHALLENGED",
          respondBy: at(9, 4, 17),
          requestTitle: null,
        },
        {
          id: "hold-2",
          bookingRequestId: "req-2",
          placeName: "Drkmttr",
          date: "2026-09-09",
          position: 1,
          status: "RELEASED",
          respondBy: null,
          requestTitle: null,
        },
      ],
      ORG,
      TZ,
    );
    expect(item).toMatchObject({
      kind: "hold",
      title: "Hold at Drkmttr",
      position: 2,
      status: "CHALLENGED",
      venueName: "Drkmttr",
      bookingHref: "/admin/blue-room/bookings?request=req-1",
    });
    expect(item!.startsAt).toEqual(at(9, 8, 0));
  });
});
