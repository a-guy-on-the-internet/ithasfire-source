import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * "Net Charged" is what the buyer's card was charged. It used to be
 * gross + feesPlatformCents + tax: under ABSORB that added a fee the
 * organiser paid, and under PASS_THROUGH it left out the processing fee the
 * buyer did pay. It now reads `charges.totalCents` from the server.
 */

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  return {
    Button: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    Badge: Passthrough,
    Text: Passthrough,
    useFormatters: () => ({}),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("lucide-react", () => ({
  X: () => null,
  ExternalLink: () => null,
  Copy: () => null,
}));

vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
  fmtDate: () => "date",
  truncateId: (id: string) => id.slice(0, 8),
}));

vi.mock(
  "../../../../admin/[slug]/orders/_components/OrderStatusBadge",
  () => ({ OrderStatusBadge: () => null }),
);
vi.mock("../detail-parts", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    MonoText: Passthrough,
    SectionDivider: () => null,
    SectionHeader: Passthrough,
  };
});
vi.mock("../OrderSplitsSection", () => ({ OrderSplitsSection: () => null }));

import { PlatformOrderDetail, type PlatformOrderRow } from "../OrderDetailPanel";

const baseRow = (overrides: Partial<PlatformOrderRow>): PlatformOrderRow => ({
  id: "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3",
  eventId: null,
  eventTitle: "Show",
  orgId: null,
  orgName: null,
  buyerHumanId: "00000000-0000-4000-8000-000000000001",
  buyerName: "Buyer",
  buyerEmail: null,
  amountGrossCents: 1000,
  feesPlatformCents: 33,
  taxAmountCents: 89,
  currency: "usd",
  status: "SUCCEEDED",
  source: "PRIMARY",
  stripePaymentIntentId: null,
  paymentMethodType: null,
  occurredAt: new Date("2026-09-01T00:00:00Z"),
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  itemCount: 1,
  feePolicySnapshot: {},
  billingCountry: null,
  billingAddress: null,
  stripeTaxCalculationId: null,
  parentOrderId: null,
  promo: null,
  items: [],
  charges: {
    buyerFeeMode: "PASS_THROUGH",
    subtotalCents: 1000,
    platformFeeCents: 33,
    processingFeeCents: 64,
    taxCents: 89,
    creditCents: 0,
    totalCents: 1186,
  },
  ...overrides,
});

const netCharged = () =>
  screen.getByText("admin.plNetCharged").parentElement!.textContent;

describe("PlatformOrderDetail — Net Charged", () => {
  it("PASS_THROUGH: includes the processing fee the buyer paid", () => {
    render(<PlatformOrderDetail row={baseRow({})} onClose={() => {}} />);

    expect(netCharged()).toContain("usd:1186");
    expect(screen.getByText("orderDetail.processingFee")).toBeInTheDocument();
    expect(screen.getByText("usd:64")).toBeInTheDocument();
    expect(screen.queryByText("admin.ttFeeModeAbsorb")).toBeNull();
  });

  it("ABSORB: the recorded fee is labelled absorbed and not added to Net", () => {
    render(
      <PlatformOrderDetail
        row={baseRow({
          feePolicySnapshot: { feeMode: "ABSORB" },
          charges: {
            buyerFeeMode: "ABSORB",
            subtotalCents: 1000,
            platformFeeCents: 0,
            processingFeeCents: 0,
            taxCents: 89,
            creditCents: 0,
            totalCents: 1089,
          },
        })}
        onClose={() => {}}
      />,
    );

    expect(netCharged()).toContain("usd:1089");
    // The recorded fee is still visible to staff, marked as absorbed.
    expect(screen.getByText("usd:33")).toBeInTheDocument();
    expect(screen.getByText("admin.ttFeeModeAbsorb")).toBeInTheDocument();
    expect(screen.queryByText("orderDetail.processingFee")).toBeNull();
  });

  it("a platform credit shows as its own line and Net reflects it", () => {
    render(
      <PlatformOrderDetail
        row={baseRow({
          charges: {
            buyerFeeMode: "PASS_THROUGH",
            subtotalCents: 1000,
            platformFeeCents: 33,
            processingFeeCents: 64,
            taxCents: 89,
            creditCents: -500,
            totalCents: 686,
          },
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("orderDetail.creditApplied")).toBeInTheDocument();
    expect(netCharged()).toContain("usd:686");
  });
});
