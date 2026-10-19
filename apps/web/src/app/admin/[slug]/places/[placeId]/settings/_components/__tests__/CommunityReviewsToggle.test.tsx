import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The PERFORMER-review switch (venue-track-record-and-review-switch FR-007).
 * Mirrors the attendee toggle's tests: the write bar locks it, the helper line
 * describes it, the mutation carries `{ placeId, enabled }`, the optimistic
 * flip reverts on error, and — the one that matters — the error toast carries
 * the TRANSLATED message, because `formatErrorMessage(err)` without `t`
 * renders "Something went wrong" for this control's own refusal.
 *
 * WHAT THIS CANNOT SEE. The design system is mocked away, so it says nothing
 * about the real Switch's dimmed treatment or how the two help lines wrap.
 */

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  toastDanger: vi.fn(),
  formatErrorMessage: vi.fn(),
}));

let mutationOptions: {
  onSuccess?: (r: { communityReviewsEnabled: boolean }) => unknown;
  onError?: (e: unknown, v: { enabled: boolean }) => unknown;
};

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: { getPlaceForEdit: { invalidate: mocks.invalidate } },
    }),
    places: {
      setCommunityReviewsEnabled: {
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
    "aria-describedby": ariaDescribedBy,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    disabled?: boolean;
    saving?: boolean;
    testId?: string;
    "aria-label"?: string;
    "aria-describedby"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
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
  formatErrorMessage: mocks.formatErrorMessage,
}));

import { CommunityReviewsToggle } from "../CommunityReviewsToggle";

const PLACE_ID = "00000000-0000-4000-8000-00000000e100";

const switchEl = () => screen.getByTestId("community-reviews-switch");
const helpEl = () => screen.getByTestId("community-reviews-help");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.formatErrorMessage.mockReturnValue("errors.notResourceOwner");
});

describe("CommunityReviewsToggle", () => {
  it("flips for a viewer who holds the write bar, sending { placeId, enabled }", () => {
    render(
      <CommunityReviewsToggle placeId={PLACE_ID} initialEnabled canManage />,
    );

    expect(switchEl()).toBeEnabled();
    expect(switchEl()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(switchEl());
    expect(mocks.mutate).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      enabled: false,
    });
    // Optimistic: the switch reads OFF before the server answers, and the
    // helper line already says what OFF means — what stays.
    expect(switchEl()).toHaveAttribute("aria-checked", "false");
    expect(helpEl()).toHaveTextContent("admin.peCommunityReviewsHelpOff");
  });

  it("describes the ON state while on, and keeps its own accessible name", () => {
    render(
      <CommunityReviewsToggle placeId={PLACE_ID} initialEnabled canManage />,
    );
    expect(
      screen.getByRole("switch", { name: "admin.peCommunityReviewsTitle" }),
    ).toBeInTheDocument();
    expect(helpEl()).toHaveTextContent("admin.peCommunityReviewsHelpOn");
    expect(switchEl()).toHaveAttribute("aria-describedby", helpEl().id);
  });

  it("locks for a viewer below the bar and says why", () => {
    render(
      <CommunityReviewsToggle
        placeId={PLACE_ID}
        initialEnabled
        canManage={false}
      />,
    );
    expect(switchEl()).toBeDisabled();
    expect(helpEl()).toHaveTextContent("admin.placeSwitchNoPermission");
    fireEvent.click(switchEl());
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("settles on the server's answer and invalidates the edit read", () => {
    render(
      <CommunityReviewsToggle
        placeId={PLACE_ID}
        initialEnabled={false}
        canManage
      />,
    );
    fireEvent.click(switchEl());
    act(() => {
      mutationOptions.onSuccess?.({ communityReviewsEnabled: true });
    });
    expect(switchEl()).toHaveAttribute("aria-checked", "true");
    expect(mocks.invalidate).toHaveBeenCalledWith({ placeId: PLACE_ID });
  });

  it("reverts the optimistic flip on error and toasts the TRANSLATED message", () => {
    render(
      <CommunityReviewsToggle placeId={PLACE_ID} initialEnabled canManage />,
    );
    fireEvent.click(switchEl());
    expect(switchEl()).toHaveAttribute("aria-checked", "false");

    const err = new Error("NOT_RESOURCE_OWNER");
    act(() => {
      mutationOptions.onError?.(err, { enabled: false });
    });

    expect(switchEl()).toHaveAttribute("aria-checked", "true");
    // The translator is passed — without it the dictionary has no
    // NOT_RESOURCE_OWNER entry and the toast reads "Something went wrong."
    expect(mocks.formatErrorMessage).toHaveBeenCalledWith(
      err,
      expect.any(Function),
    );
    expect(mocks.toastDanger).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "admin.peCommunityReviewsUpdateFailed",
        message: "errors.notResourceOwner",
      }),
    );
  });
});
