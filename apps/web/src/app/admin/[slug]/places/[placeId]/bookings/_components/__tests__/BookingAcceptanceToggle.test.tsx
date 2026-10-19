import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue's booking on/off switch, in its new home at the top of the bookings
 * page.
 *
 * The behaviours worth pinning are the two the move was made for: the flip
 * reaches `places.setBookingAcceptance`, and a successful flip goes on to purge
 * the ISR snapshot of the public page (`/api/places/[placeId]/revalidate`) —
 * without which the owner reloads their venue page, still sees the old button,
 * and reports the switch as broken. That was the original complaint.
 *
 * WHAT THIS CANNOT SEE. The design system is mocked away here, so it says
 * nothing about layout, the 320px row, or the switch's real focus ring; and the
 * purge only proves the request is SENT, not that Next actually dropped the
 * cache entry. Both were checked in a browser against a production build.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  cancel: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  invalidateSetup: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastDanger: vi.fn(),
  fetch: vi.fn(),
}));

/** Mutable per-test `places.getPlaceForEdit` payload. */
let placeData: { place: Record<string, unknown> } | undefined;
let placeLoading = false;
let placeError: unknown = null;
/** Mutable `places.getAvailabilitySetupState` payload (FR-001 detector). */
let setupData:
  | {
      configured: boolean;
      calendarCount: number;
      defaultCalendarId: string | null;
    }
  | undefined;
let setupError: unknown = null;
/** The options object the component handed to `useMutation`, so cases can drive its callbacks. */
let mutationOptions: {
  onMutate?: (v: { placeId: string; accepts: boolean }) => unknown;
  onSuccess?: (
    r: { placeId: string; acceptsBookingRequests: boolean },
    v: unknown,
    c: unknown,
  ) => unknown;
  onError?: (e: unknown, v: unknown, c: unknown) => unknown;
  onSettled?: () => unknown;
};

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: {
        getPlaceForEdit: {
          cancel: mocks.cancel,
          getData: () => placeData,
          setData: mocks.setData,
          invalidate: mocks.invalidate,
        },
        getAvailabilitySetupState: {
          invalidate: mocks.invalidateSetup,
        },
      },
    }),
    places: {
      getPlaceForEdit: {
        useQuery: () => ({
          data: placeData,
          isLoading: placeLoading,
          error: placeError,
        }),
      },
      getAvailabilitySetupState: {
        useQuery: () => ({
          data: setupError ? undefined : setupData,
          isLoading: setupData === undefined && !setupError,
          error: setupError,
        }),
      },
      setBookingAcceptance: {
        useMutation: (options: typeof mutationOptions) => {
          mutationOptions = options;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
    },
  },
}));

vi.mock("tamagui", () => {
  const Stack = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", () => ({
  // Forwards `id` and `testId`: the locked switch is DESCRIBED by the helper
  // line via aria-describedby, so a mock that drops ids would silently turn
  // that assertion into a check of nothing.
  Text: ({
    children,
    id,
    testId,
  }: {
    children?: ReactNode;
    id?: string;
    testId?: string;
  }) => (
    <span id={id} data-testid={testId}>
      {children}
    </span>
  ),
  // FR-001's warning surface: the real Alert is a bordered YStack; what the
  // tests assert is presence, copy, and the CTA — all of which survive here.
  Alert: ({
    title,
    description,
    children,
    testID,
  }: {
    title?: string;
    description?: string;
    children?: ReactNode;
    testID?: string;
  }) => (
    // Mirrors the real AlertContent order: children render BENEATH the
    // description inside the body column (the CTA deliberately does not use
    // the `actions` slot — that slot shares the body's row and squeezed the
    // text to ~1ch at 320px).
    <div data-testid={testID} role="status">
      <span>{title}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) => (
    <button
      type="button"
      data-testid={testID}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
  Spinner: () => <span data-testid="place-loading">loading…</span>,
  // Renders a real <button> so `disabled` is honoured by fireEvent, exactly as
  // the real Switch's disabled state must be.
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    saving,
    testId,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
    saving?: boolean;
    testId?: string;
    "aria-label"?: string;
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      // Mirrors the real Switch: all three are forwarded. Forwarding
      // aria-labelledby even though the component no longer sets it is what
      // keeps "the reason did not rename the control" an honest assertion.
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      // Mirrors the real Switch: the focusable <button> gets id = testId
      // (its data-testid is suffixed "-track"); the focus reseat targets
      // the id, so the mock must carry it too.
      id={testId}
      data-testid={testId}
      data-saving={saving ? "true" : "false"}
      disabled={disabled || saving}
      onClick={() => onCheckedChange(!checked)}
    >
      switch
    </button>
  ),
  useNotify: () => ({
    toast: {
      success: mocks.toastSuccess,
      warning: mocks.toastWarning,
      danger: mocks.toastDanger,
    },
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

// The hours modal is its own surface with its own tests (set-hours-modal
// .test.tsx); here it only matters that the CTA opens it in place.
vi.mock("../../../calendars/_components/SetHoursModal", () => ({
  SetHoursModal: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div data-testid="set-hours-modal">
        <button
          type="button"
          data-testid="set-hours-modal-close"
          onClick={onClose}
        >
          close
        </button>
      </div>
    ) : null,
}));

import { BookingAcceptanceToggle } from "../BookingAcceptanceToggle";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";

function makePlace(overrides: Record<string, unknown> = {}) {
  return {
    place: {
      placeId: PLACE_ID,
      verificationStatus: "VERIFIED",
      acceptsBookingRequests: true,
      // The default fixture is the venue's owner. `viewerCanManageSwitches` is
      // REQUIRED on the payload, and the component fails closed without it, so
      // leaving it off here would disable the switch in every unrelated case.
      viewerCanManageSwitches: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  placeData = makePlace();
  placeLoading = false;
  placeError = null;
  // Configured by default so the pre-existing cases exercise the toggle
  // without the FR-001 warning in frame.
  setupData = { configured: true, calendarCount: 0, defaultCalendarId: null };
  setupError = null;
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true });
});

describe("BookingAcceptanceToggle", () => {
  it("reflects the place's current acceptance and flips it", () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const toggle = screen.getByTestId("booking-acceptance-switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(mocks.mutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      accepts: false,
    });
  });

  it("says which state the PUBLIC page is in, not a state-neutral blurb", () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(screen.getByText("admin.bkAcceptanceHelpOn")).toBeInTheDocument();

    placeData = makePlace({ acceptsBookingRequests: false });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(screen.getByText("admin.bkAcceptanceHelpOff")).toBeInTheDocument();
  });

  it("disables the switch on an unverified place and says why", () => {
    placeData = makePlace({
      verificationStatus: "UNVERIFIED",
      acceptsBookingRequests: false,
    });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    expect(screen.getByTestId("booking-acceptance-switch")).toBeDisabled();
    expect(
      screen.getByText("admin.bkAcceptanceUnverified"),
    ).toBeInTheDocument();
  });

  // ── The write bar (place-switch authority) ───────────────────────────────
  //
  // The read that renders this page admits ANY org membership on purpose, so a
  // VIEWER/SCANNER/FINANCE/EDITOR gets here. Before this, they got a live
  // switch and learned the boundary by flipping it.

  it("disables the switch for a viewer who may read the place but not flip it, and names who can", () => {
    placeData = makePlace({ viewerCanManageSwitches: false });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    expect(screen.getByTestId("booking-acceptance-switch")).toBeDisabled();
    expect(
      screen.getByText("admin.placeSwitchNoPermission"),
    ).toBeInTheDocument();
    // The state blurb is REPLACED, not joined — one explanation on screen.
    expect(
      screen.queryByText("admin.bkAcceptanceHelpOn"),
    ).not.toBeInTheDocument();
  });

  it("reaches a screen reader with the reason instead of a silently dimmed switch", () => {
    placeData = makePlace({ viewerCanManageSwitches: false });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const toggle = screen.getByTestId("booking-acceptance-switch");
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The reason is a DESCRIPTION, not the name: the control is still called
    // "Accept booking requests".
    expect(toggle).not.toHaveAttribute("aria-labelledby");
    expect(toggle).toHaveAttribute("aria-label", "admin.bkAcceptanceTitle");
    // Every referenced id must RESOLVE. A dangling aria-describedby announces
    // nothing at all, which is the failure this test exists to catch.
    const described = describedBy!
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.every(Boolean)).toBe(true);
    expect(described.map((el) => el!.textContent)).toEqual([
      "admin.placeSwitchNoPermission",
    ]);
  });

  // The OTHER lock reason rides the same path — an owner of an unverified
  // venue is refused for a different reason and must hear that one.
  it("describes the switch with the verification reason when that is the lock", () => {
    placeData = makePlace({ verificationStatus: "UNVERIFIED" });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const toggle = screen.getByTestId("booking-acceptance-switch");
    const describedBy = toggle.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const described = describedBy!
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.every(Boolean)).toBe(true);
    expect(described.map((el) => el!.textContent)).toEqual([
      "admin.bkAcceptanceUnverified",
    ]);
  });

  it("leaves the accessible name alone when the viewer may flip it", () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const toggle = screen.getByTestId("booking-acceptance-switch");
    expect(toggle).toBeEnabled();
    expect(toggle).not.toHaveAttribute("aria-labelledby");
    expect(toggle).not.toHaveAttribute("aria-describedby");
    expect(toggle).toHaveAttribute("aria-label", "admin.bkAcceptanceTitle");
    expect(
      screen.queryByText("admin.placeSwitchNoPermission"),
    ).not.toBeInTheDocument();
  });

  it("names the authority, not the verification, when BOTH would refuse", () => {
    placeData = makePlace({
      verificationStatus: "UNVERIFIED",
      viewerCanManageSwitches: false,
    });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    // Telling a VIEWER to go get the venue verified points them at a door they
    // also cannot open, and verifying would not unlock the switch for them.
    expect(
      screen.getByText("admin.placeSwitchNoPermission"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.bkAcceptanceUnverified"),
    ).not.toBeInTheDocument();
  });

  it("does not fire the mutation if a click reaches the locked switch anyway", () => {
    placeData = makePlace({ viewerCanManageSwitches: false });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("booking-acceptance-switch"));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("shows a spinner rather than a guessed OFF position while loading", () => {
    placeData = undefined;
    placeLoading = true;
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    expect(screen.getByTestId("place-loading")).toBeInTheDocument();
    expect(
      screen.queryByTestId("booking-acceptance-switch"),
    ).not.toBeInTheDocument();
  });

  it("purges the public page's route cache after a successful flip", async () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsBookingRequests: false },
        { placeId: PLACE_ID, accepts: false },
        undefined,
      );
    });

    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/places/${PLACE_ID}/revalidate`,
      { method: "POST" },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkAcceptanceSavedOff" }),
    );
  });

  it("names the new state in the toast and warns about the propagation window", async () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsBookingRequests: true },
        { placeId: PLACE_ID, accepts: true },
        undefined,
      );
    });

    // The message is deliberately NOT "go look, it's live": the venue page is
    // edge-cached for a couple of minutes, and promising an instant flip is
    // what produced the original "the switch doesn't work" report.
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "admin.bkAcceptanceSavedOn",
        message: "admin.bkAcceptanceSavedNote",
      }),
    );
  });

  it("warns about staleness instead of claiming success when the purge fails", async () => {
    mocks.fetch.mockResolvedValue({ ok: false });
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsBookingRequests: false },
        { placeId: PLACE_ID, accepts: false },
        undefined,
      );
    });

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkAcceptanceSavedStale" }),
    );
  });

  it("rolls the optimistic flip back to the snapshot when the mutation fails", async () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const previous = placeData;
    await act(async () => {
      await mutationOptions.onError?.(new Error("nope"), null, { previous });
    });

    expect(mocks.setData).toHaveBeenCalledWith({ placeId: PLACE_ID }, previous);
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({ title: "admin.bkAcceptanceUpdateFailed" }),
    );
  });

  it("renders nothing when the place lookup fails", () => {
    placeData = undefined;
    placeError = new Error("denied");
    const { container } = render(
      <BookingAcceptanceToggle placeId={PLACE_ID} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  // ── FR-001 · the hours warning (availability-onboarding spec) ─────────────

  it("warns under the slider when accepting requests with no hours set", () => {
    setupData = { configured: false, calendarCount: 0, defaultCalendarId: null };
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    const warning = screen.getByTestId("booking-hours-warning");
    expect(warning).toHaveTextContent("admin.bkHoursWarnTitle");
    expect(warning).toHaveTextContent("admin.bkHoursWarnBody");
    expect(
      screen.getByTestId("booking-hours-warning-cta"),
    ).toHaveTextContent("admin.bkHoursWarnCta");
  });

  it("the CTA opens the hours modal in place — not a navigation", () => {
    setupData = { configured: false, calendarCount: 0, defaultCalendarId: null };
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    expect(screen.queryByTestId("set-hours-modal")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("booking-hours-warning-cta"));
    expect(screen.getByTestId("set-hours-modal")).toBeInTheDocument();
  });

  it("renders no warning once the venue is configured", () => {
    setupData = { configured: true, calendarCount: 1, defaultCalendarId: null };
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.queryByTestId("booking-hours-warning"),
    ).not.toBeInTheDocument();
  });

  it("renders no warning while the toggle is off, even unconfigured", () => {
    placeData = makePlace({ acceptsBookingRequests: false });
    setupData = { configured: false, calendarCount: 0, defaultCalendarId: null };
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.queryByTestId("booking-hours-warning"),
    ).not.toBeInTheDocument();
  });

  it("renders no warning before the detector answers — no flash-and-retract", () => {
    setupData = undefined;
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.queryByTestId("booking-hours-warning"),
    ).not.toBeInTheDocument();
  });

  it("a settled flip invalidates the detector too, not just the place", async () => {
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    await act(async () => {
      await mutationOptions.onSettled?.();
    });

    // Both caches move together: the bookings-workspace banner reads the
    // detector this component populates; a flip that only refreshed
    // getPlaceForEdit served that banner a ~30s-stale acceptance state.
    expect(mocks.invalidate).toHaveBeenCalledWith({ placeId: PLACE_ID });
    expect(mocks.invalidateSetup).toHaveBeenCalledWith({ placeId: PLACE_ID });
  });

  it("closing the modal after hours were set seats focus on the switch, not <body>", async () => {
    setupData = { configured: false, calendarCount: 0, defaultCalendarId: null };
    const { rerender } = render(<BookingAcceptanceToggle placeId={PLACE_ID} />);

    fireEvent.click(screen.getByTestId("booking-hours-warning-cta"));
    expect(screen.getByTestId("set-hours-modal")).toBeInTheDocument();

    // Hours land while the modal is open: the detector flips to configured
    // and the warning — including the CTA the Modal would restore focus
    // to — unmounts.
    setupData = { configured: true, calendarCount: 0, defaultCalendarId: null };
    rerender(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.queryByTestId("booking-hours-warning"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("set-hours-modal-close"));
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBe(document.body);
    expect(active?.id).toBe("booking-acceptance-switch");
  });

  it("renders no warning over a failed detector read — the toggle is unaffected", () => {
    setupData = undefined;
    setupError = new Error("denied");
    render(<BookingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.queryByTestId("booking-hours-warning"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("booking-acceptance-switch"),
    ).toBeInTheDocument();
  });
});
