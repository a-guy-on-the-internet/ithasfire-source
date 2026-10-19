import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DealChanges, type DealChangesPage } from "../DealChanges";

/**
 * "Show older changes" after an older page failed: pressing it again asks
 * that page again (review round 2, NIT 7). Before, the cursor was already
 * listed, so the press did nothing.
 *
 * Mocks are enumerated, not a catch-all Proxy.
 */

const EVENT_ID = "44444444-4444-4444-8444-444444444444";

const refetch = vi.fn(() => Promise.resolve(undefined));

vi.mock("@/trpc", () => ({
  trpc: {
    deals: {
      listDealChanges: {
        // Every older page fails.
        useQuery: () => ({
          data: undefined,
          isLoading: false,
          error: new Error("boom"),
          refetch,
        }),
      },
    },
  },
}));

vi.mock("@th/ui", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
  Money: { format: (cents: number) => `$${cents / 100}` },
  DateTime: { format: () => "Oct 14, 6:30 PM" },
  Spinner: () => <span />,
  Button: ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      {children}
    </button>
  ),
}));

const first = {
  eventId: EVENT_ID,
  event: {
    title: "Lowlight at Marrow Hall",
    startsAt: new Date("2026-10-25T01:00:00.000Z"),
    timezone: "America/Chicago",
    dealFrozenAt: new Date("2026-10-14T23:30:00.000Z"),
    frozenBy: null,
  },
  items: [],
  nextCursor: "cursor-2",
} as unknown as DealChangesPage;

describe("DealChanges: older pages", () => {
  afterEach(() => {
    cleanup();
    refetch.mockClear();
  });

  it("a failed older page is asked again when Show older changes is pressed again", () => {
    render(<DealChanges first={first} testIdBase="deal" />);
    const older = () => screen.getByTestId("deal-changes-older");

    fireEvent.click(older());
    expect(screen.getByText("deals.history.failed")).toBeTruthy();
    expect(refetch).not.toHaveBeenCalled();

    fireEvent.click(older());
    expect(refetch).toHaveBeenCalledTimes(1);
    fireEvent.click(older());
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});
