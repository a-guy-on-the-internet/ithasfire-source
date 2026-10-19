import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * Till T1 (owner pick): sales made free by a code are counted on their own
 * row, separate from comps — a 100%-off code makes a $0 SALE, never a comp.
 * And the event's cash-sales list sits inside the panel, read for the org.
 */

const testState = vi.hoisted(() => ({
  listProps: null as null | Record<string, unknown>,
  report: {} as Record<string, unknown>,
}));

vi.mock("tamagui", () => ({
  XStack: ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) =>
    onPress ? (
      <button onClick={onPress} {...pickDomProps(rest)}>
        {children}
      </button>
    ) : (
      <div {...pickDomProps(rest)}>{children}</div>
    ),
  YStack: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  Separator: () => <hr />,
  Spinner: () => null,
  Text: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <span {...pickDomProps(rest)}>{children}</span>
  ),
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  ChevronDown: () => null,
  ChevronUp: () => null,
}));

vi.mock("@/lib/format", () => ({
  formatCents: (cents: number) => `$${(cents / 100).toFixed(2)}`,
}));

vi.mock("../CashSalesList", () => ({
  CashSalesList: (props: Record<string, unknown>) => {
    testState.listProps = props;
    return <div data-testid="cash-sales-list" />;
  },
}));

vi.mock("@/trpc", () => ({
  trpc: {
    pos: {
      cashTillReport: {
        useQuery: () => ({
          isLoading: false,
          error: null,
          refetch: vi.fn(),
          data: {
            eventId: "22222222-2222-4222-8222-222222222222",
            currency: "usd",
            truncated: false,
            paidSaleCount: 9,
            cashCollectedCents: 41_200,
            taxCents: 3_488,
            platformFeeOwedCents: 0,
            organiserKeepsCents: 37_712,
            compSaleCount: 2,
            compTicketCount: 3,
            freeWithCodeSaleCount: 1,
            freeWithCodeTicketCount: 2,
            paidTicketCount: 18,
            refundedSaleCount: 1,
            refundedCents: 4_370,
            recentSales: [],
            ...testState.report,
          },
        }),
      },
    },
  },
}));

import { CashTillPanel } from "../CashTillPanel";

const EVENT = "22222222-2222-4222-8222-222222222222";
const ORG = "77777777-7777-4777-8777-777777777777";

function openPanel() {
  render(<CashTillPanel eventId={EVENT} orgId={ORG} />);
  fireEvent.click(screen.getByRole("button", { name: "Cash taken tonight" }));
}

describe("CashTillPanel — T1 rows", () => {
  beforeEach(() => {
    testState.report = {};
  });

  it("counts free-with-code sales on their own row, apart from comps", () => {
    render(
      <CashTillPanel
        eventId="22222222-2222-4222-8222-222222222222"
        orgId="77777777-7777-4777-8777-777777777777"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cash taken tonight" }));

    const free = screen.getByTestId("cash-till-free-with-code");
    expect(free.textContent).toBe("Free with a code1 sale · 2 tickets");
    expect(screen.getByText("Comped").parentElement!.textContent).toBe(
      "Comped2 sales · 3 tickets",
    );
  });

  it("puts the event's cash-sales list in the panel, read for the org", () => {
    render(
      <CashTillPanel
        eventId="22222222-2222-4222-8222-222222222222"
        orgId="77777777-7777-4777-8777-777777777777"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cash taken tonight" }));
    expect(screen.getByTestId("cash-sales-list")).toBeInTheDocument();
    expect(testState.listProps).toMatchObject({
      orgId: "77777777-7777-4777-8777-777777777777",
      eventId: "22222222-2222-4222-8222-222222222222",
      currency: "usd",
    });
  });

  describe("the note under Yours to keep", () => {
    it("says cash carries no platform fee when none is owed", () => {
      testState.report = { platformFeeOwedCents: 0 };
      openPanel();
      expect(screen.getByTestId("cash-till-keep-note").textContent).toBe(
        "No platform fee on cash. The tax comes out of your next payout.",
      );
    });

    it("explains the fee row when older cash sales still owe one", () => {
      testState.report = { platformFeeOwedCents: 150 };
      openPanel();
      expect(screen.getByText("Platform fee")).toBeInTheDocument();
      const note = screen.getByTestId("cash-till-keep-note").textContent;
      expect(note).toBe(
        "Cash sales before Oct 8, 2026 carried a platform fee. That fee and the tax come out of your next payout.",
      );
      expect(note).not.toMatch(/No platform fee/);
    });
  });
});
