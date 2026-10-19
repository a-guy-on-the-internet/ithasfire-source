/**
 * The editor moves focus to the save result only for a SAVE. After a partial
 * failure, picking a seat trims the result (the "still selected" lines go)
 * and must leave focus where the organizer is.
 *
 * Children are stubs: this tests the editor's own wiring (save, selection,
 * focus), not the views or the panel, which have their own tests.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  seatPriceRead,
  seatRead,
  sectionRead,
} from "../__fixtures__/seat-price-read";
import type { SeatPriceViewProps } from "../seat-price-views";

const SEAT_COUNT = 501; // two write chunks: 500, then 1

const state = vi.hoisted(() => ({
  read: null as unknown,
  write: vi.fn(),
  hasSidebar: true,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-")) {
        safe[key] = value;
      }
    }
    return React.createElement("div", safe, children as ReactNode);
  };
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Banner = React.forwardRef<
    HTMLDivElement,
    { title?: string; children?: ReactNode; tabIndex?: number; "data-testid"?: string }
  >(function Banner({ title, children, tabIndex, ...rest }, ref) {
    return React.createElement(
      "div",
      { ref, tabIndex, "data-testid": rest["data-testid"] },
      title,
      children,
    );
  });
  const Button = React.forwardRef<
    HTMLButtonElement,
    { children?: ReactNode; onPress?: () => void; disabled?: boolean; "data-testid"?: string }
  >(function Button({ children, onPress, disabled, ...rest }, ref) {
    return React.createElement(
      "button",
      { ref, type: "button", onClick: onPress, disabled, "data-testid": rest["data-testid"] },
      children,
    );
  });
  const Plain = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const BottomSheet = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", null, children) : null,
    { Panel: Plain, Header: () => null, Body: Plain },
  );
  const t = (key: string) => key;
  return {
    ADMIN_BOTTOM_NAV_HEIGHT_VAR: "--admin-bottom-nav-height",
    Banner,
    BottomSheet,
    Button,
    Link: Plain,
    SegmentedControl: () => null,
    Spinner: () => null,
    Text: Plain,
    useFormatters: () => ({ dateTime: {} }),
    useTranslations: () => t,
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: {
        listEventSeatPriceOverridesForEdit: { invalidate: () => Promise.resolve() },
      },
      placeLayouts: {
        getPublicPlaceLayout: { invalidate: () => Promise.resolve() },
      },
    }),
    events: {
      listEventSeatPriceOverridesForEdit: {
        useQuery: () => ({
          data: state.read,
          isPending: false,
          isError: false,
          isFetching: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      getEventForEdit: {
        useQuery: () => ({ data: { currency: "usd", timezone: "America/Chicago" } }),
      },
      getEventTitle: { useQuery: () => ({ data: { title: "Show" } }) },
      setSeatPriceOverrides: {
        useMutation: () => ({ mutateAsync: state.write }),
      },
    },
  },
}));

vi.mock("@/hooks/useMinViewportWidth", () => ({
  useMinViewportWidth: () => state.hasSidebar,
}));
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number) => `$${(cents / 100).toFixed(2)}`,
}));
vi.mock("@/components/data-table/ConfirmDialog", () => ({ ConfirmDialog: () => null }));
vi.mock("../../../../new/_components/ticket-type-schedule", () => ({
  formatZonedInstant: () => null,
}));

// One stub for both views: "pick all" selects every seat, "pick one" toggles
// the first.
vi.mock("../SeatPriceList", () => ({ SeatPriceList: ViewStub }));
vi.mock("../SeatPriceMap", () => ({ SeatPriceMap: ViewStub }));
vi.mock("../SeatPriceSectionNav", () => ({ SeatPriceSectionNav: () => null }));
vi.mock("../SeatPriceReadOnly", () => ({ SeatPriceReadOnly: () => null }));
vi.mock("../SeatPriceNotice", () => ({
  SeatPriceNotice: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../SeatPricePanel", () => ({
  PRISTINE_DRAFT: { price: null, note: null },
  SeatPricePanel: ({ onSetPrice }: { onSetPrice: (cents: number, note: string | null) => void }) => (
    <button type="button" onClick={() => onSetPrice(1000, null)}>
      save
    </button>
  ),
}));

function ViewStub({ model, dispatch }: SeatPriceViewProps) {
  const ids = [...model.selectableIds];
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          dispatch({ type: "replaceWithin", scopeIds: ids, next: new Set(ids) })
        }
      >
        pick all
      </button>
      <PickOne onPick={() => dispatch({ type: "toggleSeat", seatId: ids[0]! })} />
    </div>
  );
}

const PickOne = forwardRef<HTMLButtonElement, { onPick: () => void }>(
  function PickOne({ onPick }, ref) {
    return (
      <button ref={ref} type="button" onClick={onPick}>
        pick one
      </button>
    );
  },
);

// jsdom has no layout: scrolling is a no-op here.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function readWithSeats() {
  return seatPriceRead({
    sections: [
      sectionRead({
        seatSectionId: "balcony",
        name: "Balcony",
        seats: Array.from({ length: SEAT_COUNT }, (_, i) =>
          seatRead({ id: `seat-${i}`, label: `A${i + 1}`, row: "A", number: i + 1 }),
        ),
      }),
    ],
  });
}

/** The first chunk of 500 is saved, the second fails: a partial failure. */
function failSecondChunk() {
  state.write.mockReset();
  state.write
    .mockResolvedValueOnce({
      updated: 500,
      skipped: { sold: 0, held: 0, busy: 0, notFound: 0 },
    })
    .mockRejectedValueOnce(new Error("Network down"));
}

describe("SeatPriceEditor result focus", () => {
  it("focuses the result after a save, and not after a seat is picked", async () => {
    state.hasSidebar = true;
    state.read = readWithSeats();
    failSecondChunk();

    const { SeatPriceEditor } = await import("../SeatPriceEditor");
    render(<SeatPriceEditor slug="demo" eventId="event-1" />);

    fireEvent.click(screen.getByText("pick all"));
    // The save awaits two writes: let them settle.
    await act(() => {
      fireEvent.click(screen.getByText("save"));
      return Promise.resolve();
    });

    const banner = screen.getByTestId("seat-price-result");
    expect(document.activeElement).toBe(banner);
    expect(state.write).toHaveBeenCalledTimes(2);

    // The organizer goes back to picking seats.
    const pickOne = screen.getByText("pick one");
    pickOne.focus();
    act(() => {
      fireEvent.click(pickOne);
    });

    // The counts stay; the result does not take focus again.
    expect(screen.getByTestId("seat-price-result")).toBeTruthy();
    expect(document.activeElement).toBe(pickOne);
    expect(document.activeElement).not.toBe(screen.getByTestId("seat-price-result"));
  });

  it("on a phone, the result takes focus from the sheet, not the button that opened it", async () => {
    state.hasSidebar = false;
    state.read = readWithSeats();
    failSecondChunk();

    const { SeatPriceEditor } = await import("../SeatPriceEditor");
    render(<SeatPriceEditor slug="demo" eventId="event-1" />);

    fireEvent.click(screen.getByText("pick all"));
    const opener = screen.getByTestId("seat-price-open-panel");
    opener.focus();
    act(() => {
      fireEvent.click(opener);
    });
    // The panel is in the sheet; the save resolves while the sheet is open.
    await act(() => {
      fireEvent.click(screen.getByText("save"));
      return Promise.resolve();
    });

    expect(screen.queryByText("save")).toBeNull(); // the sheet closed
    expect(opener.isConnected).toBe(true); // the unsent seats are still selected
    expect(document.activeElement).toBe(screen.getByTestId("seat-price-result"));
    expect(document.activeElement).not.toBe(opener);
  });
});
