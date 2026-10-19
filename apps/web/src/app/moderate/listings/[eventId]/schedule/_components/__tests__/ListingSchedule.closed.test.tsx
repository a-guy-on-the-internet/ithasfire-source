/**
 * ListingSchedule on a closed listing: CANCELLED / ARCHIVED read "taken down",
 * COMPLETED reads "ended". Real design system and EN catalogue; only the data
 * layer is stubbed.
 */
import type { ReactElement } from "react";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

const { toastMock, refreshMock, restoreMutate, dates } = vi.hoisted(() => ({
  toastMock: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), danger: vi.fn() },
  refreshMock: vi.fn(),
  restoreMutate: vi.fn(),
  dates: [] as Array<Record<string, unknown>>,
}));

const DEFAULT_DATES = [
  {
    eventDateId: "d1",
    startsAt: new Date("2030-09-24T01:00:00.000Z"),
    status: "SCHEDULED",
    viewerRsvped: false,
  },
  {
    eventDateId: "d2",
    startsAt: new Date("2030-10-01T01:00:00.000Z"),
    status: "CANCELLED",
    viewerRsvped: false,
  },
];

vi.mock("@th/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/ui")>()),
  useNotify: () => ({ toast: toastMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
  usePathname: () => "/moderate/listings/e1/schedule",
}));

vi.mock("@/trpc", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        community: { listEventDates: { invalidate: vi.fn() } },
      }),
      community: {
        listEventDates: {
          useQuery: () => ({
            isLoading: false,
            isError: false,
            refetch: vi.fn(),
            data: {
              dates,
              recurrence: null,
              storedRule: null,
              truncated: false,
              hasRecurrenceRule: dates.length > 0,
            },
          }),
        },
        updateRecurrence: { useMutation: mutation },
        cancelEventDate: { useMutation: mutation },
        restoreEventDate: {
          useMutation: () => ({ mutate: restoreMutate, isPending: false }),
        },
      },
    },
  };
});

import { ListingSchedule } from "../ListingSchedule";

const render = (ui: ReactElement) =>
  rtlRender(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

const page = (listingStatus: string) => (
  <ListingSchedule
    eventId="e1"
    title="Open Mic"
    timezone="America/Chicago"
    startsAtIso="2030-09-24T01:00:00.000Z"
    listingHref="/events/open-mic"
    listingStatus={listingStatus}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  dates.length = 0;
  dates.push(...DEFAULT_DATES);
});

describe("ListingSchedule on a closed listing", () => {
  it.each(["CANCELLED", "ARCHIVED"])(
    "%s: says it was taken down, hides Put back and Change rule",
    (status) => {
      render(page(status));
      expect(screen.getByTestId("schedule-closed-notice").textContent).toMatch(
        /taken down/,
      );
      expect(screen.queryByTestId("schedule-date-put-back")).toBeNull();
      expect(screen.queryByTestId("schedule-change-rule")).toBeNull();
      expect(screen.queryByTestId("schedule-consequence")).toBeNull();
      expect(screen.getByTestId("schedule-view-listing")).toBeTruthy();
    },
  );

  it("COMPLETED: says it has ended", () => {
    render(page("COMPLETED"));
    expect(screen.getByTestId("schedule-closed-notice").textContent).toMatch(
      /has ended.*rule can't change/,
    );
    expect(screen.queryByTestId("schedule-date-put-back")).toBeNull();
    expect(screen.queryByTestId("schedule-consequence")).toBeNull();
  });

  it("no dates: no hint to set a rule", () => {
    dates.length = 0;
    render(page("CANCELLED"));
    expect(screen.getByText("No upcoming dates")).toBeTruthy();
    expect(screen.queryByTestId("schedule-no-dates-hint")).toBeNull();
  });

  it.each(["PUBLISHED", "DRAFT"])("%s: unchanged", (status) => {
    render(page(status));
    expect(screen.queryByTestId("schedule-closed-notice")).toBeNull();
    expect(screen.getByTestId("schedule-date-put-back")).toBeTruthy();
    expect(screen.getByTestId("schedule-change-rule")).toBeTruthy();
    expect(screen.getByTestId("schedule-consequence")).toBeTruthy();
  });

  it("PUBLISHED with no dates: the hint to set a rule stays", () => {
    dates.length = 0;
    render(page("PUBLISHED"));
    expect(screen.getByTestId("schedule-no-dates-hint")).toBeTruthy();
  });
});

describe("ListingSchedule when the listing closes while the page is open", () => {
  it.each([
    ["EVENT_ALREADY_CANCELLED"],
    ["EVENT_ARCHIVED"],
    ["EVENT_ALREADY_COMPLETED"],
  ])("Put back refused with %s: warns and refreshes", (appCode) => {
    render(page("PUBLISHED"));
    fireEvent.click(screen.getByTestId("schedule-date-put-back"));
    const opts = restoreMutate.mock.calls[0]![1] as {
      onError: (err: unknown) => void;
    };
    opts.onError({ message: appCode, data: { code: "CONFLICT", appCode } });
    // Title only: the closed notice (focused after the refresh) carries the why.
    expect(toastMock.warning).toHaveBeenCalledWith({
      title: expect.any(String),
    });
    expect(toastMock.danger).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("any other failure keeps the generic toast and does not refresh", () => {
    render(page("PUBLISHED"));
    fireEvent.click(screen.getByTestId("schedule-date-put-back"));
    const opts = restoreMutate.mock.calls[0]![1] as {
      onError: (err: unknown) => void;
    };
    opts.onError(new Error("boom"));
    expect(toastMock.danger).toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refusal: focus moves to the closed notice once it renders", () => {
    const { rerender } = render(page("PUBLISHED"));
    const putBack = screen.getByTestId("schedule-date-put-back");
    putBack.focus();
    fireEvent.click(putBack);
    const opts = restoreMutate.mock.calls[0]![1] as {
      onError: (err: unknown) => void;
    };
    act(() => {
      opts.onError({
        message: "EVENT_ARCHIVED",
        data: { code: "CONFLICT", appCode: "EVENT_ARCHIVED" },
      });
    });
    // router.refresh() re-renders the server half with the new status.
    rerender(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          {page("ARCHIVED")}
        </TranslationProvider>
      </IthasFireProvider>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("schedule-closed-notice"));
  });
});
