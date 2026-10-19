import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The venue's standing consent to ownerless COMMUNITY listings
 * (community-listings-at-claimed-venues FR-001/FR-005/FR-007).
 *
 * Deliberately mirrors BookingAcceptanceToggle.test.tsx, because the component
 * deliberately mirrors that component. What is pinned here is what the spec
 * turns on: the flip reaches `places.setCommunityListingAcceptance`; a
 * successful flip purges the public page; the consequence sentence ("this also
 * occupies that time for booking availability") is on screen BEFORE the
 * decision, not in a toast after it; and the FR-007 count reaches the copy.
 *
 * WHAT THIS CANNOT SEE, stated because this repo has shipped defects straight
 * through a green suite of exactly this shape: the design system is mocked away,
 * so this says nothing about layout, the 320px row, accessible-name collisions
 * with the booking switch sitting directly above it, or hydration. The purge
 * assertion proves only that the request is SENT. Those need the real app.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  cancel: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastDanger: vi.fn(),
  fetch: vi.fn(),
}));

let placeData: { place: Record<string, unknown> } | undefined;
let placeLoading = false;
let placeError: unknown = null;
let mutationOptions: {
  onMutate?: (v: { placeId: string; accepts: boolean }) => unknown;
  onSuccess?: (
    r: { placeId: string; acceptsCommunityListings: boolean },
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
      setCommunityListingAcceptance: {
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
    <div data-testid={testID} role="status">
      <span>{title}</span>
      <span>{description}</span>
      {children}
    </div>
  ),
  Spinner: () => <span data-testid="place-loading">loading…</span>,
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
  // Echoes the key, and the ARGS when there are any, so a test can prove the
  // FR-007 count actually reaches the string rather than being dropped.
  useTranslations:
    () =>
    (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

import { CommunityListingAcceptanceToggle } from "../CommunityListingAcceptanceToggle";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";

function makePlace(overrides: Record<string, unknown> = {}) {
  return {
    place: {
      placeId: PLACE_ID,
      verificationStatus: "VERIFIED",
      acceptsCommunityListings: false,
      communityListingCount: 0,
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
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockResolvedValue({ ok: true });
});

const switchEl = () =>
  screen.getByTestId("community-listing-acceptance-switch");

describe("CommunityListingAcceptanceToggle", () => {
  it("flipping ON calls setCommunityListingAcceptance with the place and the new value", () => {
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    fireEvent.click(switchEl());
    expect(mocks.mutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      accepts: true,
    });
  });

  it("flipping OFF sends accepts: false — retracting consent is a first-class action", () => {
    placeData = makePlace({ acceptsCommunityListings: true });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    fireEvent.click(switchEl());
    expect(mocks.mutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      accepts: false,
    });
  });

  it("reads its position from the SHARED getPlaceForEdit entry, not local state", () => {
    placeData = makePlace({ acceptsCommunityListings: true });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(switchEl()).toHaveAttribute("aria-checked", "true");
  });

  // ── The consequence, stated before the decision (FR-005) ─────────────────

  it("names the booking-availability consequence BEFORE the switch is touched", () => {
    // The whole point of the inline Alert: a venue must not discover that
    // accepting community listings also blocks those nights by finding its
    // calendar full later. A toast after the fact would not do this.
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(screen.getByTestId("community-listing-consequence")).toBeTruthy();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("FR-007: the attached-listing count reaches the copy when there is something to count", () => {
    placeData = makePlace({ communityListingCount: 3 });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(
      screen.getByTestId("community-listing-consequence").textContent,
    ).toContain('{"count":3}');
  });

  it("at zero it falls back to the countless sentence rather than saying '0 listings'", () => {
    placeData = makePlace({ communityListingCount: 0 });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    const text = screen.getByTestId("community-listing-consequence").textContent;
    expect(text).toContain("admin.clAcceptanceConsequenceBody");
    expect(text).not.toContain('{"count":0}');
  });

  // ── Verification gate ────────────────────────────────────────────────────

  it("an unverified place gets a disabled switch and no mutation", () => {
    placeData = makePlace({ verificationStatus: "PENDING" });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(switchEl()).toBeDisabled();
    fireEvent.click(switchEl());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("an unverified place is not told about a consequence it cannot opt into yet", () => {
    placeData = makePlace({ verificationStatus: "PENDING" });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(screen.queryByTestId("community-listing-consequence")).toBeNull();
  });

  // ── The write bar (place-switch authority) ───────────────────────────────
  //
  // Unlike the verification gate, this one binds in BOTH directions: the
  // backend refuses a non-admin retracting consent too.

  it("disables the switch for a viewer who may read the place but not flip it, and names who can", () => {
    placeData = makePlace({ viewerCanManageSwitches: false });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    expect(switchEl()).toBeDisabled();
    expect(
      screen.getByText("admin.placeSwitchNoPermission"),
    ).toBeInTheDocument();
    // One explanation: the state blurb is replaced, not joined.
    expect(
      screen.queryByText("admin.clAcceptanceHelpOff"),
    ).not.toBeInTheDocument();

    fireEvent.click(switchEl());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("locks retraction too, not just enabling", () => {
    placeData = makePlace({
      acceptsCommunityListings: true,
      viewerCanManageSwitches: false,
    });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    expect(switchEl()).toBeDisabled();
    fireEvent.click(switchEl());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("reaches a screen reader with the reason instead of a silently dimmed switch", () => {
    placeData = makePlace({ viewerCanManageSwitches: false });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    const describedBy = switchEl().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    // The reason DESCRIBES the switch and does not rename it.
    expect(switchEl()).not.toHaveAttribute("aria-labelledby");
    expect(switchEl()).toHaveAttribute("aria-label", "admin.clAcceptanceTitle");
    // Dangling ids announce nothing — every reference must resolve.
    const described = describedBy!
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.every(Boolean)).toBe(true);
    expect(described.map((el) => el!.textContent)).toEqual([
      "admin.placeSwitchNoPermission",
    ]);
  });

  // The OTHER lock reason rides the same path.
  it("describes the switch with the verification reason when that is the lock", () => {
    placeData = makePlace({ verificationStatus: "PENDING" });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    const describedBy = switchEl().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const described = describedBy!
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.every(Boolean)).toBe(true);
    expect(described.map((el) => el!.textContent)).toEqual([
      "admin.clAcceptanceUnverified",
    ]);
  });

  it("leaves the accessible name alone when the viewer may flip it", () => {
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    expect(switchEl()).toBeEnabled();
    expect(switchEl()).not.toHaveAttribute("aria-labelledby");
    expect(switchEl()).not.toHaveAttribute("aria-describedby");
    expect(switchEl()).toHaveAttribute("aria-label", "admin.clAcceptanceTitle");
    expect(
      screen.queryByText("admin.placeSwitchNoPermission"),
    ).not.toBeInTheDocument();
  });

  it("names the authority, not the verification, when BOTH would refuse", () => {
    placeData = makePlace({
      verificationStatus: "PENDING",
      viewerCanManageSwitches: false,
    });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);

    expect(
      screen.getByText("admin.placeSwitchNoPermission"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.clAcceptanceUnverified"),
    ).not.toBeInTheDocument();
  });

  // ── Save → purge → toast ─────────────────────────────────────────────────

  it("a successful flip purges the public page and confirms", async () => {
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsCommunityListings: true },
        undefined,
        undefined,
      );
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `/api/places/${PLACE_ID}/revalidate`,
      { method: "POST" },
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("a FAILED purge still counts as saved — it warns about staleness, it does not claim failure", async () => {
    mocks.fetch.mockResolvedValue({ ok: false });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsCommunityListings: true },
        undefined,
        undefined,
      );
    });
    expect(mocks.toastWarning).toHaveBeenCalled();
    expect(mocks.toastDanger).not.toHaveBeenCalled();
  });

  it("a thrown purge is swallowed — the flag is already written", async () => {
    mocks.fetch.mockRejectedValue(new Error("offline"));
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    await act(async () => {
      await mutationOptions.onSuccess?.(
        { placeId: PLACE_ID, acceptsCommunityListings: true },
        undefined,
        undefined,
      );
    });
    expect(mocks.toastWarning).toHaveBeenCalled();
  });

  // ── Optimism and its rollback ────────────────────────────────────────────

  it("writes optimistically into the shared cache entry", async () => {
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    await act(async () => {
      await mutationOptions.onMutate?.({ placeId: PLACE_ID, accepts: true });
    });
    expect(mocks.cancel).toHaveBeenCalledWith({ placeId: PLACE_ID });
    expect(mocks.setData).toHaveBeenCalled();
    const updater = mocks.setData.mock.calls[0]![1] as (
      p: typeof placeData,
    ) => typeof placeData;
    expect(updater(makePlace())!.place.acceptsCommunityListings).toBe(true);
  });

  it("rolls the optimistic flip back on error and says why", async () => {
    const previous = makePlace({ acceptsCommunityListings: false });
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    await act(async () => {
      await mutationOptions.onError?.(new Error("nope"), undefined, {
        previous,
      });
    });
    expect(mocks.setData).toHaveBeenCalledWith({ placeId: PLACE_ID }, previous);
    expect(mocks.toastDanger).toHaveBeenCalled();
  });

  it("renders NOTHING when the place read failed — no switch we cannot vouch for", () => {
    placeError = new Error("down");
    const { container } = render(
      <CommunityListingAcceptanceToggle placeId={PLACE_ID} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows a spinner rather than a default-OFF switch while loading", () => {
    placeData = undefined;
    placeLoading = true;
    render(<CommunityListingAcceptanceToggle placeId={PLACE_ID} />);
    expect(screen.getByTestId("place-loading")).toBeTruthy();
    expect(
      screen.queryByTestId("community-listing-acceptance-switch"),
    ).toBeNull();
  });
});
