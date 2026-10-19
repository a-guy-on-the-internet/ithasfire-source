import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The third place switch. It has no verification gate — an owner may publish or
 * hide the attendee aggregate at any time — so the ONLY reason it is ever
 * disabled is the write bar it shares with the two booking switches: a direct
 * human owner, or OWNER/ADMIN in an owning org.
 *
 * The page around this control loads for ANY org member by design, which is why
 * a VIEWER used to meet a live-looking switch and discover the boundary by
 * flipping it.
 *
 * WHAT THIS CANNOT SEE. The design system is mocked away, so it says nothing
 * about the real Switch's dimmed treatment, the helper line's wrap at 320px, or
 * how a screen reader actually voices the name it asserts.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  toastDanger: vi.fn(),
}));

let mutationOptions: {
  onSuccess?: (r: { attendeeReviewsPublic: boolean }) => unknown;
  onError?: (e: unknown, v: { isPublic: boolean }) => unknown;
};

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: { getPlaceForEdit: { invalidate: mocks.invalidate } },
    }),
    places: {
      setAttendeeReviewsPublic: {
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
  // line, so a mock that drops ids would turn that assertion into a check of
  // nothing.
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
      // All three are forwarded exactly as the real Switch forwards them, so
      // the "the name was not rewritten" assertion still means something.
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      id={testId}
      data-testid={testId}
      disabled={disabled || saving}
      onClick={() => onCheckedChange(!checked)}
    >
      switch
    </button>
  ),
  useNotify: () => ({ toast: { danger: mocks.toastDanger } }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "boom",
}));

import { AttendeeReviewsPublicToggle } from "../AttendeeReviewsPublicToggle";

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";

const switchEl = () => screen.getByTestId("attendee-reviews-public-switch");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendeeReviewsPublicToggle", () => {
  it("flips for a viewer who holds the write bar", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage
      />,
    );

    expect(switchEl()).toBeEnabled();
    fireEvent.click(switchEl());
    expect(mocks.mutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      isPublic: true,
    });
  });

  it("keeps its own accessible name and help copy when the viewer may flip it", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage
      />,
    );

    expect(switchEl()).not.toHaveAttribute("aria-labelledby");
    expect(switchEl()).not.toHaveAttribute("aria-describedby");
    expect(switchEl()).toHaveAttribute(
      "aria-label",
      "admin.peAttendeeReviewsPublicTitle",
    );
    expect(
      screen.getByText("admin.peAttendeeReviewsPublicHelp"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("admin.placeSwitchNoPermission"),
    ).not.toBeInTheDocument();
  });

  it("disables the switch for a viewer below the write bar and names who can", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage={false}
      />,
    );

    expect(switchEl()).toBeDisabled();
    expect(
      screen.getByText("admin.placeSwitchNoPermission"),
    ).toBeInTheDocument();
    // One explanation on screen: the refusal REPLACES the description.
    expect(
      screen.queryByText("admin.peAttendeeReviewsPublicHelp"),
    ).not.toBeInTheDocument();
  });

  it("reaches a screen reader with the reason instead of a silently dimmed switch", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage={false}
      />,
    );

    // The reason DESCRIBES the switch; it is not folded into the name, which
    // stays the title alone.
    const describedBy = switchEl().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(switchEl()).not.toHaveAttribute("aria-labelledby");
    expect(switchEl()).toHaveAttribute(
      "aria-label",
      "admin.peAttendeeReviewsPublicTitle",
    );
    // A dangling reference announces nothing at all — resolve every id.
    const described = describedBy!
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.every(Boolean)).toBe(true);
    expect(described.map((el) => el!.textContent)).toEqual([
      "admin.placeSwitchNoPermission",
    ]);
  });

  it("does not fire the mutation if a click reaches the locked switch anyway", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage={false}
      />,
    );

    fireEvent.click(switchEl());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("keeps the error toast as the backstop for a refusal reached another way", () => {
    render(
      <AttendeeReviewsPublicToggle
        placeId={PLACE_ID}
        initialIsPublic={false}
        canManage
      />,
    );

    mutationOptions.onError?.(new Error("nope"), { isPublic: true });
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "admin.peAttendeeReviewsPublicUpdateFailed",
        message: "boom",
      }),
    );
  });
});
