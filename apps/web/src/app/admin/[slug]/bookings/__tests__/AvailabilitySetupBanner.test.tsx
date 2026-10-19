import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unconfigured-venue banner (availability-onboarding FR-004).
 *
 * The trigger is exactly "zero availability rows AND accepting booking
 * requests", per venue, and BOTH halves ride the one detector read —
 * `getAvailabilitySetupState` carries `acceptsBookingRequests` (the raw
 * toggle) precisely so this surface needs no companion place read. This
 * suite pins:
 *
 *   • ONE banner naming the matching venues — never a band per venue;
 *   • both halves of the trigger, and fail-quiet on an unanswered probe;
 *   • the probe CAP — one query per venue up to the cap, none above it: a
 *     large portfolio is not the onboarding case, and this workspace was
 *     rebuilt specifically to kill per-venue fan-outs;
 *   • session dismissal: client state keyed to the unconfigured SET, so a new
 *     venue entering the state re-surfaces the banner, and storage refusing
 *     (private mode) still hides it for the mount.
 */

/** Per-place detector answers, set by each test. */
let setupByPlace: Record<
  string,
  { data?: unknown; isLoading?: boolean; isError?: boolean }
> = {};

const probeMocks = vi.hoisted(() => ({
  setupProbe: vi.fn(),
}));

const UNANSWERED = { data: undefined, isLoading: false, isError: true };

vi.mock("@/trpc", () => {
  type Descriptor = { placeId: string };
  const q = {
    places: {
      getAvailabilitySetupState: (input: { placeId: string }): Descriptor => {
        probeMocks.setupProbe(input.placeId);
        return { placeId: input.placeId };
      },
    },
  };
  return {
    trpc: {
      useQueries: (build: (qq: typeof q) => Descriptor[]) =>
        build(q).map((d) => setupByPlace[d.placeId] ?? UNANSWERED),
    },
  };
});

vi.mock("tamagui", () => {
  const Stack = (props: Record<string, unknown>) => (
    <div
      data-testid={props.testID as string | undefined}
      role={props.role as string | undefined}
    >
      {props.children as ReactNode}
    </div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    testID,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    testID?: string;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      data-testid={testID}
      aria-label={rest["aria-label"]}
    >
      {children}
    </button>
  ),
  NextLinkAnchor: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: ReactNode;
    "aria-label"?: string;
  }) => (
    <a href={href} aria-label={rest["aria-label"]}>
      {children}
    </a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>) =>
      values
        ? `${key} ${Object.entries(values)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(" ")}`
        : key,
}));

vi.mock("lucide-react", () => ({ X: () => <span /> }));

vi.mock("@/components/bookings/booking-holds", () => ({
  HOLD_ACTION_TOUCH: {},
}));

import {
  AvailabilitySetupBanner,
  MAX_PROBED_VENUES,
} from "../_components/AvailabilitySetupBanner";

const venue = (n: number) => ({ placeId: `pl-${n}`, placeName: `Venue ${n}` });

function answer(
  placeId: string,
  over: { configured?: boolean; accepts?: boolean } = {},
) {
  const { configured = false, accepts = true } = over;
  setupByPlace[placeId] = {
    data: {
      configured,
      calendarCount: 1,
      defaultCalendarId: null,
      acceptsBookingRequests: accepts,
    },
    isLoading: false,
    isError: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setupByPlace = {};
  window.sessionStorage.clear();
});

describe("AvailabilitySetupBanner — the trigger", () => {
  it("renders ONE banner and links exactly the venues matching unconfigured + accepting", () => {
    answer("pl-1"); // unconfigured, accepting → in
    answer("pl-2", { configured: true }); // has hours → out
    answer("pl-3", { accepts: false }); // not taking requests → out
    render(
      <AvailabilitySetupBanner
        slug="dev-qa"
        venues={[venue(1), venue(2), venue(3)]}
      />,
    );

    const banner = screen.getByTestId("bookings-hours-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(screen.getByTestId("bookings-hours-banner-link-pl-1")).toBeTruthy();
    expect(screen.queryByTestId("bookings-hours-banner-link-pl-2")).toBeNull();
    expect(screen.queryByTestId("bookings-hours-banner-link-pl-3")).toBeNull();

    // Single venue: the copy names it and the one link says the action.
    expect(banner.textContent).toContain("bkWsHoursBannerOne venue=Venue 1");
    expect(banner.textContent).toContain("bkWsHoursBannerCta");

    const anchor = screen
      .getByTestId("bookings-hours-banner-link-pl-1")
      .closest("a");
    expect(anchor?.getAttribute("href")).toBe(
      "/admin/dev-qa/places/pl-1/calendars",
    );

    // ONE read per venue — the detector carries both halves of the trigger,
    // so no companion place query ever fires.
    expect(
      new Set(probeMocks.setupProbe.mock.calls.map((call) => call[0])),
    ).toEqual(new Set(["pl-1", "pl-2", "pl-3"]));
  });

  it("names each venue on its link when several are unconfigured", () => {
    answer("pl-1");
    answer("pl-2");
    render(
      <AvailabilitySetupBanner slug="dev-qa" venues={[venue(1), venue(2)]} />,
    );
    const banner = screen.getByTestId("bookings-hours-banner");
    expect(banner.textContent).toContain("bkWsHoursBannerMany");
    expect(
      screen.getByTestId("bookings-hours-banner-link-pl-1").textContent,
    ).toContain("venue=Venue 1");
    expect(
      screen.getByTestId("bookings-hours-banner-link-pl-2").textContent,
    ).toContain("venue=Venue 2");
  });

  it("renders nothing when every venue is configured, and nothing off an unanswered probe", () => {
    answer("pl-1", { configured: true });
    // pl-2's probes never answer (refused / not deployed): fail QUIET —
    // a missing nudge is recoverable, a guessed one is not.
    render(
      <AvailabilitySetupBanner slug="dev-qa" venues={[venue(1), venue(2)]} />,
    );
    expect(screen.queryByTestId("bookings-hours-banner")).toBeNull();
  });

  it("stands down entirely above the probe cap — no banner AND no fan-out", () => {
    const many = Array.from({ length: MAX_PROBED_VENUES + 1 }, (_, i) =>
      venue(i + 1),
    );
    for (const v of many) answer(v.placeId);
    render(<AvailabilitySetupBanner slug="dev-qa" venues={many} />);
    expect(screen.queryByTestId("bookings-hours-banner")).toBeNull();
    expect(probeMocks.setupProbe).not.toHaveBeenCalled();
  });
});

describe("AvailabilitySetupBanner — session dismissal", () => {
  it("dismisses for the SESSION: hidden now, hidden on remount, never the database", () => {
    answer("pl-1");
    const { unmount } = render(
      <AvailabilitySetupBanner slug="dev-qa" venues={[venue(1)]} />,
    );
    const dismiss = screen.getByTestId("bookings-hours-banner-dismiss");
    expect(dismiss.getAttribute("aria-label")).toContain(
      "bkWsHoursBannerDismiss",
    );
    fireEvent.click(dismiss);
    expect(screen.queryByTestId("bookings-hours-banner")).toBeNull();

    unmount();
    render(<AvailabilitySetupBanner slug="dev-qa" venues={[venue(1)]} />);
    expect(screen.queryByTestId("bookings-hours-banner")).toBeNull();
  });

  it("re-surfaces when a NEW venue enters the unconfigured set", () => {
    answer("pl-1");
    const { unmount } = render(
      <AvailabilitySetupBanner slug="dev-qa" venues={[venue(1)]} />,
    );
    fireEvent.click(screen.getByTestId("bookings-hours-banner-dismiss"));
    unmount();

    // A second venue flips booking requests on while still unconfigured:
    // dismissing "Venue 1 needs hours" must not silence "Venue 2 needs hours".
    answer("pl-2");
    render(
      <AvailabilitySetupBanner slug="dev-qa" venues={[venue(1), venue(2)]} />,
    );
    expect(screen.getByTestId("bookings-hours-banner")).toBeTruthy();
  });

  it("still hides for the mount when storage refuses", () => {
    answer("pl-1");
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("private mode");
      });
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("private mode");
      });
    try {
      render(<AvailabilitySetupBanner slug="dev-qa" venues={[venue(1)]} />);
      fireEvent.click(screen.getByTestId("bookings-hours-banner-dismiss"));
      expect(screen.queryByTestId("bookings-hours-banner")).toBeNull();
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });
});
