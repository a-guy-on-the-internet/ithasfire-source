import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A buyer whose charge is under dispute cannot self-serve a refund — Stripe
 * refuses it and so does the server. The page must say so INSTEAD of showing
 * the refund form (a confirm button that can only fail).
 */

const testState = vi.hoisted(() => ({
  eligibilityQuery: {} as Record<string, unknown>,
  refundMutation: { mutate: vi.fn(), error: null } as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children, ...props }: { children?: ReactNode }) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (key === "role" || key === "data-testid" || key.startsWith("aria-"))
        safe[key] = value;
    }
    return React.createElement("div", safe, children);
  };
  return {
    XStack: Stack,
    YStack: Stack,
    Card: Stack,
    Spinner: () => <span>Loading</span>,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onPress} disabled={disabled}>
      {children}
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({
    getRawMessage: () => undefined,
    dateTime: () => "date",
  }),
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
}));

vi.mock("@/trpc", () => ({
  trpc: {
    orders: {
      getRefundEligibility: { useQuery: () => testState.eligibilityQuery },
      refundFullOrder: { useMutation: () => testState.refundMutation },
    },
  },
}));

import { RefundRequest } from "../RefundRequest";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

function eligibility(overrides: Record<string, unknown> = {}) {
  return {
    orderId: ORDER_ID,
    isEligible: true,
    reason: "eligible",
    eventStartsAt: "2026-12-01T19:00:00.000Z",
    refundDeadline: "2026-12-01T19:00:00.000Z",
    feeBreakdown: {
      amountPaidCents: 5500,
      ticketPriceCents: 5000,
      platformFeeCents: 500,
      taxCents: 0,
      stripeFeeCents: 200,
      refundableCents: 5300,
      currency: "usd",
    },
    isResale: false,
    hasTransferredItems: false,
    refundableItemCount: 1,
    totalItemCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  testState.refundMutation = { mutate: vi.fn(), error: null };
});

describe("RefundRequest — dispute block", () => {
  it("shows the dispute explanation INSTEAD of the refund form", () => {
    testState.eligibilityQuery = {
      data: eligibility({
        isEligible: false,
        reason: "disputed",
        feeBreakdown: null,
        eventStartsAt: null,
        refundDeadline: null,
      }),
      isLoading: false,
      error: null,
    };

    render(<RefundRequest orderId={ORDER_ID} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "This order is under dispute with your card issuer, so it can't be refunded right now. Once the dispute closes, you can request a refund if anything is still owed.",
    );
    // No form: neither the confirm button nor the disabled "not available"
    // placeholder, and no fee breakdown to read.
    expect(
      screen.queryByRole("button", { name: "refund.confirmRefund" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "refund.refundNotAvailable" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("refund.refundBreakdown")).not.toBeInTheDocument();
    // The way back is still offered.
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      `/my-tickets/${ORDER_ID}`,
    );
  });

  it("renders the refund form for an eligible order (regression)", () => {
    testState.eligibilityQuery = {
      data: eligibility(),
      isLoading: false,
      error: null,
    };

    render(<RefundRequest orderId={ORDER_ID} />);

    expect(
      screen.getByRole("button", { name: "refund.confirmRefund" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains a dispute that opened between the eligibility check and the refund", () => {
    testState.eligibilityQuery = {
      data: eligibility(),
      isLoading: false,
      error: null,
    };
    testState.refundMutation = {
      mutate: vi.fn(),
      error: new Error("ORDER_DISPUTED_REFUND_BLOCKED"),
    };

    render(<RefundRequest orderId={ORDER_ID} />);

    // Buyer wording — not the staff dictionary sentence ("the buyer's card
    // issuer"), and never the raw code.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This order is under dispute with your card issuer",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "the buyer's card issuer",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "ORDER_DISPUTED_REFUND_BLOCKED",
    );
  });

  it("recognises the refusal from the structured data.appCode too", () => {
    testState.eligibilityQuery = {
      data: eligibility(),
      isLoading: false,
      error: null,
    };
    testState.refundMutation = {
      mutate: vi.fn(),
      error: Object.assign(new Error("Refund refused"), {
        data: { appCode: "ORDER_DISPUTED_REFUND_BLOCKED" },
      }),
    };

    render(<RefundRequest orderId={ORDER_ID} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This order is under dispute with your card issuer",
    );
  });

  it("shows the permanent 'already returned' wording for disputed_lost", () => {
    testState.eligibilityQuery = {
      data: eligibility({
        isEligible: false,
        reason: "disputed_lost",
        feeBreakdown: null,
        eventStartsAt: null,
        refundDeadline: null,
      }),
      isLoading: false,
      error: null,
    };

    render(<RefundRequest orderId={ORDER_ID} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Your card issuer resolved the dispute in your favour, so the money has already been returned to your card. There is nothing left to refund.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(
      "Once the dispute closes",
    );
    expect(
      screen.queryByRole("button", { name: "refund.confirmRefund" }),
    ).not.toBeInTheDocument();
  });
});

describe("RefundRequest — refund policy sentence", () => {
  it("names the platform fee on a primary order", () => {
    testState.eligibilityQuery = { data: eligibility(), isLoading: false, error: null };
    render(<RefundRequest orderId={ORDER_ID} />);
    expect(screen.getByText(/the platform fee are all refunded/)).toBeInTheDocument();
  });

  it("leaves the platform fee out on a resale order", () => {
    testState.eligibilityQuery = {
      data: eligibility({
        isResale: true,
        feeBreakdown: {
          amountPaidCents: 5200,
          ticketPriceCents: 5000,
          platformFeeCents: 0,
          taxCents: 0,
          stripeFeeCents: 200,
          refundableCents: 5000,
          currency: "usd",
        },
      }),
      isLoading: false,
      error: null,
    };
    render(<RefundRequest orderId={ORDER_ID} />);
    expect(screen.getByText(/Your ticket price and tax are refunded/)).toBeInTheDocument();
    expect(screen.queryByText(/platform fee/i)).not.toBeInTheDocument();
  });

  it("leaves the platform fee out on an ineligible resale order too", () => {
    // The policy card renders for ineligible results, which carry no fee
    // breakdown; the server sets `isResale` on them as well.
    testState.eligibilityQuery = {
      data: eligibility({
        isEligible: false,
        reason: "event_started",
        feeBreakdown: null,
        isResale: true,
      }),
      isLoading: false,
      error: null,
    };
    render(<RefundRequest orderId={ORDER_ID} />);
    expect(screen.getByText(/Your ticket price and tax are refunded/)).toBeInTheDocument();
    expect(screen.queryByText(/platform fee/i)).not.toBeInTheDocument();
  });
});
