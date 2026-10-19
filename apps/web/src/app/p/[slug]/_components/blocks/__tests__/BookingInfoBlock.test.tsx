import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BookingInfoBlock CTA gating (venue-confirmation-and-booking-intents spec,
 * UI/Flow › Place page): "Play here" and "Rent or use a space", each visible
 * only if some calendar on the place accepts it; both hidden when a claimed
 * venue opted out; both open the one dialog with their intent preselected.
 */

const testMocks = vi.hoisted(() => ({
  optionsUseQuery: vi.fn(),
  showSignInOverlay: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    places: { getBookingOptions: { useQuery: testMocks.optionsUseQuery } },
  },
}));
vi.mock("@th/ui", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/navigation", () => ({ usePathname: () => "/p/velvet-room" }));
vi.mock("@/hooks/useSessionGate", () => ({
  useSessionGate: () => ({ isSignedIn: true, isPending: false }),
}));
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: testMocks.showSignInOverlay }),
}));
vi.mock("../block-page-owner-context", () => ({
  useBlockPageOwner: () => ({
    place: { id: "place-1", name: "Velvet Room", acceptsRequests: true },
  }),
}));
vi.mock("../../BookingRequestDialog", () => ({
  BookingRequestDialog: ({
    open,
    intent,
  }: {
    open: boolean;
    intent: string | null;
  }) => (
    <div data-testid="dialog" data-open={String(open)} data-intent={intent ?? ""} />
  ),
}));

import { BookingInfoBlock } from "../BookingInfoBlock";

const calendar = (over: Record<string, unknown> = {}) => ({
  id: "cal-1",
  name: "Main",
  isDefault: true,
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
  spaces: [{ id: "space-1", name: "Room" }],
  ...over,
});

function mockOptions(
  calendars: unknown[],
  extra: { acceptsBookingRequests?: boolean } = {},
) {
  testMocks.optionsUseQuery.mockReturnValue({
    data: {
      placeId: "place-1",
      isClaimed: true,
      acceptsBookingRequests: extra.acceptsBookingRequests ?? true,
      calendars,
    },
    isPending: false,
    isSuccess: true,
    isError: false,
  });
}

const block = {
  id: "block-1",
  kind: "booking_info",
  data: { contactEmail: "book@velvet.example" },
} as never;

const play = () => screen.queryByRole("button", { name: "places.heroPlayHereCta" });
const space = () =>
  screen.queryByRole("button", { name: "places.heroRentOrUseCta" });

describe("BookingInfoBlock — CTA gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows both CTAs when calendars accept a pitch and a rental", () => {
    mockOptions([calendar(), calendar({ id: "cal-2", acceptsRent: true })]);
    render(<BookingInfoBlock block={block} />);
    expect(play()).toBeInTheDocument();
    expect(space()).toBeInTheDocument();
    // The direct-contact fallback keeps its "or reach us" label.
    expect(screen.getByText("places.contact")).toBeInTheDocument();
  });

  it("shows only Play here when no calendar rents or lends a room", () => {
    mockOptions([calendar()]);
    render(<BookingInfoBlock block={block} />);
    expect(play()).toBeInTheDocument();
    expect(space()).not.toBeInTheDocument();
  });

  it("shows only Rent or use a space when no calendar takes pitches", () => {
    mockOptions([calendar({ acceptsPerform: false, acceptsUse: true })]);
    render(<BookingInfoBlock block={block} />);
    expect(play()).not.toBeInTheDocument();
    expect(space()).toBeInTheDocument();
    // USE-only opens the dialog on USE.
    fireEvent.click(space()!);
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-intent", "USE");
  });

  it("hides both when the claimed venue opted out of requests", () => {
    mockOptions([calendar({ acceptsRent: true })], {
      acceptsBookingRequests: false,
    });
    render(<BookingInfoBlock block={block} />);
    expect(play()).not.toBeInTheDocument();
    expect(space()).not.toBeInTheDocument();
    // Contact details still render.
    expect(screen.getByText("book@velvet.example")).toBeInTheDocument();
  });

  it("keeps today's single Play here while the options read is pending", () => {
    testMocks.optionsUseQuery.mockReturnValue({
      data: undefined,
      isPending: true,
      isSuccess: false,
      isError: false,
    });
    render(<BookingInfoBlock block={block} />);
    expect(play()).toBeInTheDocument();
    expect(space()).not.toBeInTheDocument();
  });

  it("opens the one dialog with the pressed CTA's intent", () => {
    mockOptions([calendar({ acceptsRent: true })]);
    render(<BookingInfoBlock block={block} />);

    expect(screen.getByTestId("dialog")).toHaveAttribute("data-open", "false");
    fireEvent.click(space()!);
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-open", "true");
    expect(screen.getByTestId("dialog")).toHaveAttribute("data-intent", "RENT");
  });
});
