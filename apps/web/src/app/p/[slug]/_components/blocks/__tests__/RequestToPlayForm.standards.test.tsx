import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The standards gate on the pitch form (venue-booking-standards FR-005, V1):
 * a REQUIRED item the place lists blocks Send and focuses its control, and a
 * server STANDARDS_UNMET refetches the place's booking options so the rail
 * shows its current list.
 */

const testMocks = vi.hoisted(() => ({
  optionsUseQuery: vi.fn(),
  createMutate: vi.fn(),
  invalidateOptions: vi.fn(),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      performers: {
        getMyStatus: { getData: vi.fn(), setData: vi.fn(), invalidate: vi.fn() },
      },
      places: {
        getBookingOptions: { invalidate: testMocks.invalidateOptions },
      },
    }),
    performers: {
      getMyStatus: {
        useQuery: () => ({
          data: {
            human: { ownerId: "human-1", enabled: true, statsEligible: false },
            orgs: [],
          },
          isLoading: false,
          isError: false,
        }),
      },
      setMode: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      getBookingDefaults: { useQuery: () => ({ data: undefined }) },
    },
    bookingRequests: {
      create: {
        useMutation: () => ({ mutate: testMocks.createMutate, isPending: false }),
      },
    },
    places: {
      getBookingOptions: { useQuery: testMocks.optionsUseQuery },
      getBookingAvailability: {
        useQuery: () => ({
          data: { timezone: "America/Chicago", days: [] },
          isError: false,
        }),
      },
    },
    search: {
      autocompleteAdmin: {
        useQuery: () => ({
          data: undefined,
          isFetching: false,
          isPending: true,
          isError: false,
        }),
      },
    },
  },
}));

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs: [
      {
        kind: "human",
        humanId: "human-1",
        humanName: "Jo Requester",
        humanUsername: "jo",
        avatarUrl: null,
        adminSlug: "@jo",
      },
    ],
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@th/ui", () => ({
  Spinner: () => null,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Money: { format: (cents: number) => `$${(cents / 100).toFixed(2)}` },
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("../RequestToPlayStatsLine", () => ({
  RequestToPlayStatsLine: () => null,
}));
vi.mock("../BookingDatePicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../BookingDatePicker")>()),
  BookingDatePicker: ({
    value,
    onChange,
  }: {
    value: string[];
    onChange: (next: string[]) => void;
  }) => (
    <input
      aria-label="dates"
      value={value[0] ?? ""}
      onChange={(e) => onChange([e.target.value])}
    />
  ),
}));

import { RequestToPlayPanel } from "../RequestToPlayForm";

const PLACE_ID = "place-1";

const MAIN = {
  id: "cal-main",
  name: "Main",
  isDefault: true,
  acceptsPerform: true,
  acceptsRent: false,
  acceptsUse: false,
  rentalRateCents: null,
  rentalRateCurrency: null,
  rentalRateVisible: false,
  spaces: [{ id: "space-a", name: "Room A" }],
  standards: {
    PERFORM: {
      standards: [
        {
          source: "place",
          field: "LINK_MUSIC",
          requirement: "REQUIRED",
          label: "A link to your music",
          hint: null,
        },
      ],
      examples: [],
    },
  },
};

const submit = () =>
  fireEvent.submit(
    screen.getByRole("form", { name: "admin.peBlockKindRequestToPlay" }),
  );

describe("RequestToPlayPanel — the standards gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testMocks.optionsUseQuery.mockReturnValue({
      data: {
        placeId: PLACE_ID,
        isClaimed: true,
        acceptsBookingRequests: true,
        calendars: [MAIN],
      },
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    render(<RequestToPlayPanel placeId={PLACE_ID} onSuccess={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("admin.bkFormMessageLabel"), {
      target: { value: "We are a four-piece surf-rock band from town." },
    });
    fireEvent.change(screen.getByLabelText("dates"), {
      target: { value: "2027-08-01" },
    });
  });

  it("a required music link blocks Send and takes focus; filled, Send goes", () => {
    const music = screen.getByLabelText("admin.bkFormLinkMusicLabel");

    submit();
    expect(testMocks.createMutate).not.toHaveBeenCalled();
    expect(music).toHaveFocus();
    expect(music).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(music, { target: { value: "https://example.com/band" } });
    submit();
    expect(testMocks.createMutate).toHaveBeenCalledTimes(1);
    expect(testMocks.createMutate.mock.calls[0]![0]).toMatchObject({
      placeId: PLACE_ID,
      calendarId: "cal-main",
      linkMusic: "https://example.com/band",
    });
  });

  it("a server STANDARDS_UNMET refetches the place's booking options", () => {
    fireEvent.change(screen.getByLabelText("admin.bkFormLinkMusicLabel"), {
      target: { value: "https://example.com/band" },
    });
    submit();
    const [, handlers] = testMocks.createMutate.mock.calls[0]!;

    act(() => {
      handlers.onError({
        message: "STANDARDS_UNMET",
        data: {
          appCode: "STANDARDS_UNMET",
          meta: { items: [{ field: "EXPECTED_DRAW", label: "Your draw" }] },
        },
      });
    });

    expect(testMocks.invalidateOptions).toHaveBeenCalledWith({
      placeId: PLACE_ID,
    });
  });
});
