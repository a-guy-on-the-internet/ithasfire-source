/**
 * /platform/community-listings: rows, the status filter, which take-down
 * action each status offers, the confirm dialog, and the New listing link.
 *
 * The design system is mocked down to bare DOM, so this covers the view's own
 * logic; layout, hydration and 320px are checked in the running app.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Props = { children?: ReactNode; [key: string]: unknown };

const PASS_PROP = /^(data-|aria-)|^(id|role|tabIndex|htmlFor|href)$/;
const domProps = (rest: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(rest).filter(([k]) => PASS_PROP.test(k)));

const state = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  nextCursor: null as string | null,
  error: null as unknown,
  inputs: [] as Array<Record<string, unknown>>,
  owners: undefined as undefined | Array<Record<string, unknown>>,
  cancelMutate: vi.fn(),
  mutationOpts: null as null | { onError?: (e: unknown) => void },
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastDanger: vi.fn(),
  secondFactor: vi.fn(() => false),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/platform/community-listings" }));

vi.mock("nanoid", () => ({ nanoid: () => "key-123" }));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...rest }: Props) =>
    React.createElement("div", domProps(rest), children);
  return { XStack: Stack, YStack: Stack, Stack };
});

vi.mock("lucide-react", () => ({ CalendarRange: () => null }));

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({ children, tag, ...rest }: Props & { tag?: string }) =>
    React.createElement((tag as string) ?? "span", domProps(rest), children);
  const Modal = Object.assign(
    ({ open, children }: Props & { open?: boolean }) =>
      open ? React.createElement("div", { role: "dialog" }, children) : null,
    {
      Panel: ({ children }: Props) => React.createElement("div", null, children),
      Header: ({ title }: { title: string }) =>
        React.createElement("h2", null, title),
      Body: ({ children }: Props) => React.createElement("div", null, children),
      Footer: ({ children }: Props) =>
        React.createElement("div", null, children),
    },
  );
  return {
    Text,
    Modal,
    Button: ({ children, onPress, disabled, ...rest }: Props & {
      onPress?: () => void;
      disabled?: boolean;
    }) =>
      React.createElement(
        tagFor(rest),
        { ...(rest.tag ? {} : { type: "button", onClick: onPress, disabled }), ...domProps(rest) },
        children,
      ),
    NextLinkAnchor: ({ children, href, ...rest }: Props & { href: string }) =>
      React.createElement("a", { href, ...domProps(rest) }, children),
    StyledSelect: ({
      value,
      options,
      onChange,
      selectId,
    }: {
      value: string;
      options: Array<{ value: string; label: string }>;
      onChange: (v: string) => void;
      selectId: string;
    }) =>
      React.createElement(
        "select",
        { id: selectId, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
        options.map((o) =>
          React.createElement("option", { key: o.value, value: o.value }, o.label),
        ),
      ),
    TextInput: ({ value, onChangeText, id }: { value: string; onChangeText: (v: string) => void; id: string }) =>
      React.createElement("input", { id, value, onChange: (e: { target: { value: string } }) => onChangeText(e.target.value) }),
    DataTable: ({ rows, columns, emptyState, isLoading }: {
      rows: Array<Record<string, unknown>>;
      columns: Array<{ id: string; cell: (r: Record<string, unknown>) => ReactNode }>;
      emptyState: ReactNode;
      isLoading: boolean;
    }) =>
      isLoading
        ? React.createElement("div", { "data-testid": "loading" })
        : rows.length === 0
          ? React.createElement("div", null, emptyState)
          : React.createElement(
              "ul",
              null,
              rows.map((r) =>
                React.createElement(
                  "li",
                  { key: r.id as string, "data-testid": `row-${r.id as string}` },
                  columns.map((c) =>
                    React.createElement("div", { key: c.id }, c.cell(r)),
                  ),
                ),
              ),
            ),
    useFormatters: () => ({
      dateTime: (d: Date, o?: { timeZone?: string }) =>
        `${d.toISOString()}@${o?.timeZone ?? ""}`,
    }),
    useNotify: () => ({
      toast: { success: state.toastSuccess, danger: state.toastDanger },
    }),
    useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  };
});

function tagFor(rest: Record<string, unknown>): string {
  return rest.tag ? "span" : "button";
}

vi.mock("@/app/admin/[slug]/events/_components/EventStatusBadge", () => ({
  EventStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="badge">{status}</span>
  ),
}));

vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => state.secondFactor,
  buildEnrollTwoFactorUrl: (p: string) => `/enroll-2fa?redirect_url=${p}`,
}));

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({ ownersWithSlugs: state.owners }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      community: {
        listListingsForPlatform: {
          invalidate: state.invalidate,
          fetch: vi.fn(),
        },
      },
    }),
    community: {
      listListingsForPlatform: {
        useQuery: (input: Record<string, unknown>) => {
          state.inputs.push(input);
          return {
            data: state.error
              ? undefined
              : { items: state.items, nextCursor: state.nextCursor },
            error: state.error,
            isError: Boolean(state.error),
            isLoading: false,
            isFetching: false,
            dataUpdatedAt: 1,
            refetch: vi.fn(),
          };
        },
      },
    },
    events: {
      cancelEvent: {
        useMutation: (opts: { onSuccess?: () => void; onError?: (e: unknown) => void }) => {
          state.mutationOpts = opts;
          return {
          mutate: (...a: unknown[]) => {
            state.cancelMutate(...a);
            opts.onSuccess?.();
          },
          isPending: false,
          };
        },
      },
    },
  },
}));

import { CommunityListingsView } from "../CommunityListingsView";

const listing = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Listing ${id}`,
  status,
  slug: `slug-${id}`,
  timezone: "America/Chicago",
  startsAt: new Date("2026-10-20T00:00:00Z"),
  endsAt: new Date("2026-10-20T03:00:00Z"),
  recurring: false,
  placeId: "p1",
  placeName: "The Basement",
  city: "Nashville",
  nextNightStartsAt: new Date("2026-10-21T00:00:00Z"),
  upcomingNightCount: 0,
  publishedAt: new Date("2026-10-01T00:00:00Z"),
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  ...extra,
});

beforeEach(() => {
  state.items = [];
  state.nextCursor = null;
  state.error = null;
  state.inputs = [];
  state.owners = [
    { kind: "org", adminSlug: "some-org" },
    { kind: "human", adminSlug: "@micah" },
  ];
  for (const fn of [
    state.cancelMutate,
    state.invalidate,
    state.toastSuccess,
    state.toastDanger,
    state.secondFactor,
  ])
    fn.mockReset();
});

describe("CommunityListingsView", () => {
  it("renders a row with place, next night in the listing's timezone and upcoming nights", () => {
    state.items = [
      listing("a", "PUBLISHED", { recurring: true, upcomingNightCount: 6 }),
    ];
    render(<CommunityListingsView />);
    const row = screen.getByTestId("row-a");
    expect(within(row).getByText("Listing a")).toBeTruthy();
    expect(within(row).getByTestId("badge").textContent).toBe("PUBLISHED");
    expect(within(row).getByText("The Basement · Nashville")).toBeTruthy();
    expect(row.textContent).toContain("@America/Chicago");
    expect(row.textContent).toContain('"count":6');
  });

  it("prints the upcoming-nights line only when there is more than one", () => {
    state.items = [
      listing("z", "PUBLISHED", { recurring: true, upcomingNightCount: 0, nextNightStartsAt: null }),
      listing("o", "PUBLISHED", { recurring: true, upcomingNightCount: 1 }),
      listing("m", "PUBLISHED", { recurring: true, upcomingNightCount: 3 }),
    ];
    render(<CommunityListingsView />);
    const text = (id: string) => screen.getByTestId(`row-${id}`).textContent ?? "";
    expect(text("z")).toContain("admin.clNoNextNight");
    expect(text("z")).not.toContain("admin.clUpcomingNights");
    expect(text("o")).not.toContain("admin.clUpcomingNights");
    expect(text("m")).toContain("admin.clUpcomingNights");
  });

  it("sends no status for the default Live view, and the chosen status otherwise", () => {
    render(<CommunityListingsView />);
    expect(state.inputs.at(-1)).toEqual({ limit: 25 });
    fireEvent.change(document.getElementById("community-listings-status")!, {
      target: { value: "CANCELLED" },
    });
    expect(state.inputs.at(-1)).toEqual({ status: "CANCELLED", limit: 25 });
  });

  it("offers Take down on DRAFT and PUBLISHED only", () => {
    state.items = [
      listing("d", "DRAFT"),
      listing("p", "PUBLISHED"),
      listing("c", "CANCELLED"),
      listing("o", "COMPLETED"),
      listing("z", "ARCHIVED"),
    ];
    render(<CommunityListingsView />);
    const has = (id: string) =>
      within(screen.getByTestId(`row-${id}`)).queryByText(
        "admin.ebTakeDownListing",
      ) !== null;
    expect(["d", "p"].map(has)).toEqual([true, true]);
    expect(["c", "o", "z"].map(has)).toEqual([false, false, false]);
  });

  it("confirming Take down calls cancelEvent with a client key, then refreshes the list", () => {
    state.items = [listing("p", "PUBLISHED")];
    render(<CommunityListingsView />);
    fireEvent.click(
      within(screen.getByTestId("row-p")).getByText("admin.ebTakeDownListing"),
    );
    expect(state.cancelMutate).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByTestId("community-listing-takedown-confirm-btn"));
    });
    expect(state.cancelMutate).toHaveBeenCalledWith({
      eventId: "p",
      clientKey: "key-123",
    });
    expect(state.invalidate).toHaveBeenCalled();
    expect(state.toastSuccess).toHaveBeenCalled();
  });

  it("builds Edit and New listing links from the human admin slug, not the org's", () => {
    state.items = [listing("p", "PUBLISHED")];
    render(<CommunityListingsView />);
    const links = Array.from(document.querySelectorAll("a")).map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("/admin/@micah/events/p/edit");
    expect(links).toContain("/admin/@micah/events/new/community");
    expect(links.some((h) => h?.includes("some-org"))).toBe(false);
  });

  it("shows View only when the listing has a public page", () => {
    state.items = [listing("p", "PUBLISHED"), listing("d", "DRAFT")];
    render(<CommunityListingsView />);
    expect(within(screen.getByTestId("row-p")).queryByText("admin.clView")).not.toBeNull();
    expect(within(screen.getByTestId("row-d")).queryByText("admin.clView")).toBeNull();
  });

  it("shows the empty state, and a different one under a filter", () => {
    const { unmount } = render(<CommunityListingsView />);
    expect(screen.getByText("admin.clEmpty")).toBeTruthy();
    unmount();
    render(<CommunityListingsView />);
    fireEvent.change(document.getElementById("community-listings-status")!, {
      target: { value: "DRAFT" },
    });
    expect(screen.getByText("admin.clEmptyFiltered")).toBeTruthy();
  });

  it("shows the denied state, with no New listing, on FORBIDDEN", () => {
    state.error = { data: { code: "FORBIDDEN" } };
    render(<CommunityListingsView />);
    expect(screen.getByText("admin.clForbidden")).toBeTruthy();
    expect(screen.queryByText("admin.clNew")).toBeNull();
  });

  it("gives each row's Edit and View links a row-specific name", () => {
    state.items = [listing("a", "PUBLISHED"), listing("b", "PUBLISHED")];
    render(<CommunityListingsView />);
    const names = Array.from(document.querySelectorAll("a")).map((a) =>
      a.getAttribute("aria-label"),
    );
    expect(names).toContain("admin.clEdit: Listing a");
    expect(names).toContain("admin.clEdit: Listing b");
    expect(names).toContain("admin.clView: Listing a");
    expect(new Set(names.filter(Boolean)).size).toBe(
      names.filter(Boolean).length,
    );
  });

  it("gives each row's Take down button a row-specific name", () => {
    state.items = [listing("a", "PUBLISHED"), listing("b", "PUBLISHED")];
    render(<CommunityListingsView />);
    const names = Array.from(document.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toContain("admin.ebTakeDownListing: Listing a");
    expect(names).toContain("admin.ebTakeDownListing: Listing b");
  });

  describe("take-down errors", () => {
    const fail = (error: unknown) => {
      state.items = [listing("p", "PUBLISHED")];
      render(<CommunityListingsView />);
      state.invalidate.mockClear();
      act(() => {
        state.mutationOpts?.onError?.(error);
      });
    };

    it("routes SECOND_FACTOR_REQUIRED to the second-factor prompt, no toast", () => {
      state.secondFactor.mockReturnValue(true);
      fail({ data: { code: "FORBIDDEN", appCode: "SECOND_FACTOR_REQUIRED" } });
      expect(state.secondFactor).toHaveBeenCalled();
      expect(state.toastDanger).not.toHaveBeenCalled();
    });

    it("toasts a generic error and leaves the list alone", () => {
      fail(new Error("boom"));
      expect(state.toastDanger).toHaveBeenCalledTimes(1);
      expect(state.invalidate).not.toHaveBeenCalled();
    });

    it.each(["EVENT_ALREADY_CANCELLED", "EVENT_NOT_CANCELLABLE"])(
      "refetches the list on %s, besides the toast",
      (appCode) => {
        fail({ data: { appCode } });
        expect(state.invalidate).toHaveBeenCalled();
        expect(state.toastDanger).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("hides the count while more pages remain", () => {
    state.items = [listing("p", "PUBLISHED")];
    const { unmount } = render(<CommunityListingsView />);
    expect(screen.queryByText(/admin\.clCount/)).not.toBeNull();
    unmount();
    state.nextCursor = "cur";
    render(<CommunityListingsView />);
    expect(screen.queryByText(/admin\.clCount/)).toBeNull();
  });

  it("routes a missing second factor to the enrol prompt, not the denied text", () => {
    state.error = { data: { code: "FORBIDDEN", appCode: "SECOND_FACTOR_REQUIRED" } };
    render(<CommunityListingsView />);
    expect(state.secondFactor).toHaveBeenCalledWith(state.error);
    expect(screen.queryByText("admin.clForbidden")).toBeNull();
    expect(screen.getByText("moderation.secondFactorRequiredToastMessage")).toBeTruthy();
    const link = screen
      .getByText("moderation.secondFactorRequiredToastAction")
      .closest("a");
    expect(link?.getAttribute("href")).toBe(
      "/enroll-2fa?redirect_url=/platform/community-listings",
    );
    expect(screen.queryByText("admin.clRetry")).toBeNull();
  });

  it("shows Load more when a next cursor exists", () => {
    state.items = [listing("p", "PUBLISHED")];
    state.nextCursor = "cur";
    render(<CommunityListingsView />);
    expect(screen.getByText("admin.clLoadMore")).toBeTruthy();
  });
});
