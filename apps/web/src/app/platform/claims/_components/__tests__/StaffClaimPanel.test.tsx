import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The claim desk words every `claims.review` failure inline, so its mutation
 * opts out of the global toast. Without that, a failed refund showed
 * "Something went wrong" over the panel's own explanation and logged a
 * missing-copy warning for REFUND_FAILED, an INTERNAL code the catalog must
 * not carry. In exchange, every failed approval is announced on the page:
 * approval commits the claim before the refund runs, so the refetch can
 * unmount the panel (and its inline error) under the operator.
 */

type MutationOptions = {
  meta?: { silent?: boolean };
  onError?: (err: unknown, variables?: { status?: string }) => void;
};

const testState = vi.hoisted(() => ({
  reviewOptions: null as MutationOptions | null,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, Spinner: () => null };
});

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@th/ui", () => ({
  Text: ({
    children,
    role,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    role?: string;
    "data-testid"?: string;
  }) => (
    <span role={role} data-testid={testId}>
      {children}
    </span>
  ),
  Button: ({
    children,
    onPress,
  }: {
    children?: ReactNode;
    onPress?: () => void;
  }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  CharCountTextarea: () => <textarea />,
  useTranslations: () => (key: string) => key,
  useFormatters: () => ({ getRawMessage: () => undefined }),
}));

vi.mock("@/lib/format", () => ({
  fmtDate: () => "date",
  truncateId: (id: string) => id.slice(0, 8),
}));

vi.mock("../ClaimMobileCard", () => ({
  ClaimStatusBadge: () => <span />,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({ claims: { list: { invalidate: vi.fn() } } }),
    claims: {
      review: {
        useMutation: (options: MutationOptions) => {
          testState.reviewOptions = options;
          return { mutate: vi.fn(), isPending: false };
        },
      },
    },
  },
}));

import { StaffClaimPanel } from "../StaffClaimPanel";
import type { StaffClaimRow } from "../StaffClaimPanel";

const CLAIM_ID = "e82ede83-8fb2-4064-9c16-edd9f4da24fc";

const claim = {
  id: CLAIM_ID,
  kind: "ticket_invalid",
  status: "open",
  view: "full",
  orderId: "11111111-1111-4111-8111-111111111111",
  claimantId: "22222222-2222-4222-8222-222222222222",
  respondentId: "33333333-3333-4333-8333-333333333333",
  evidenceText: "The ticket was refused at the door.",
  sellerReplyText: null,
  sellerRespondedAt: null,
  resolutionNote: null,
  resolvedAt: null,
  refundConfirmed: false,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  deadline: new Date("2026-10-08T00:00:00Z"),
} as unknown as StaffClaimRow;

describe("StaffClaimPanel review mutation", () => {
  beforeEach(() => {
    testState.reviewOptions = null;
  });

  it("opts out of the global error toast", () => {
    render(<StaffClaimPanel claim={claim} onAnnounce={vi.fn()} />);
    expect(testState.reviewOptions?.meta).toEqual({ silent: true });
  });

  it("words REFUND_FAILED inline with the claim desk's own copy", () => {
    const onAnnounce = vi.fn();
    render(<StaffClaimPanel claim={claim} onAnnounce={onAnnounce} />);

    act(() =>
      testState.reviewOptions!.onError!(
        { message: "REFUND_FAILED", data: { appCode: "REFUND_FAILED" } },
        { status: "approved" },
      ),
    );

    expect(
      screen.getByTestId(`staff-claim-error-${CLAIM_ID}`).textContent,
    ).toBe("resaleClaim.staffErrorRefundFailed");
    expect(onAnnounce).toHaveBeenCalledWith(
      "resaleClaim.staffAnnounceRefundFailed",
      { urgent: true },
    );
  });

  it("announces any other failed approval, naming the claim", () => {
    const onAnnounce = vi.fn();
    render(<StaffClaimPanel claim={claim} onAnnounce={onAnnounce} />);

    act(() =>
      testState.reviewOptions!.onError!(
        {
          message: "IDEMPOTENCY_LOCK_IN_PROGRESS",
          data: { appCode: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
        },
        { status: "approved" },
      ),
    );

    const inline = screen.getByTestId(
      `staff-claim-error-${CLAIM_ID}`,
    ).textContent;
    expect(inline).toBeTruthy();
    expect(onAnnounce).toHaveBeenCalledTimes(1);
    const [message, options] = onAnnounce.mock.calls[0]!;
    expect(options).toEqual({ urgent: true });
    expect(message).toContain(CLAIM_ID.slice(0, 8));
    expect((message as string).endsWith(`: ${inline}`)).toBe(true);
  });

  it("leaves a failed non-approval decision to the inline error", () => {
    const onAnnounce = vi.fn();
    render(<StaffClaimPanel claim={claim} onAnnounce={onAnnounce} />);

    act(() =>
      testState.reviewOptions!.onError!(
        {
          message: "IDEMPOTENCY_LOCK_IN_PROGRESS",
          data: { appCode: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
        },
        { status: "denied" },
      ),
    );

    expect(screen.getByTestId(`staff-claim-error-${CLAIM_ID}`)).toBeTruthy();
    expect(onAnnounce).not.toHaveBeenCalled();
  });
});
