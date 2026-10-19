import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A held cart persists no tax and no processing fee (checkout solves both),
 * so the banner shows the ticket subtotal and says what checkout adds. It
 * used to add `feesPlatformCents`, which under ABSORB is the organiser's
 * cost, and even under PASS_THROUGH left out processing and tax.
 */

const state = vi.hoisted(() => ({ carts: [] as unknown[] }));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    "data-testid"?: string;
  }) => React.createElement("div", { "data-testid": testId }, children);
  return { XStack: Stack, YStack: Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <span>{children}</span>
  );
  return {
    Link: ({ children, href }: { children?: ReactNode; href?: string }) => (
      <a href={href}>{children}</a>
    ),
    Button: ({ children }: { children?: ReactNode }) => (
      <button type="button">{children}</button>
    ),
    Text: Passthrough,
    useFormatters: () => ({}),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("lucide-react", () => ({ Clock: () => null, ShoppingCart: () => null }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/lib/format", () => ({
  fmtCurrency: (_fmt: unknown, cents: number, currency: string) =>
    `${currency}:${cents}`,
}));
vi.mock("@/hooks/useCartRecovery", () => ({
  useCartRecovery: () => ({
    activeCarts: state.carts,
    isLoading: false,
    dismissCart: vi.fn(),
  }),
}));

import { CartRecoveryBanner } from "../CartRecoveryBanner";

const cart = (overrides: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  eventName: "Warehouse Showcase",
  eventSlug: "warehouse-showcase",
  eventStartsAt: null,
  amountGrossCents: 1000,
  feesPlatformCents: 33,
  feeMode: "PASS_THROUGH",
  currency: "usd",
  holdExpiresAt: new Date(Date.now() + 10 * 60_000),
  createdAt: new Date(),
  ticketSummary: [
    {
      ticketTypeId: "33333333-3333-4333-8333-333333333333",
      ticketTypeName: "GA",
      qty: 1,
      unitPriceCents: 1000,
      seatIds: [],
    },
  ],
  ...overrides,
});

describe("CartRecoveryBanner amount", () => {
  beforeEach(() => {
    state.carts = [];
  });

  it("PASS_THROUGH: the subtotal plus '+ fees & tax', never a partial total", () => {
    state.carts = [cart({})];
    render(<CartRecoveryBanner />);
    const text = screen.getByText(/usd:1000/).textContent ?? "";
    expect(text).toContain("eventDetail.plusFeesAndTax");
    expect(screen.queryByText(/usd:1033/)).toBeNull();
  });

  it("ABSORB: the subtotal plus '+ tax'; the organiser's recorded fee is not added", () => {
    state.carts = [cart({ feeMode: "ABSORB" })];
    render(<CartRecoveryBanner />);
    const text = screen.getByText(/usd:1000/).textContent ?? "";
    expect(text).toContain("eventDetail.plusTax");
    expect(text).not.toContain("plusFeesAndTax");
    expect(screen.queryByText(/usd:1033/)).toBeNull();
  });

  it("a $0 held cart: just $0.00, no '+ fees & tax'", () => {
    state.carts = [cart({ amountGrossCents: 0, feesPlatformCents: 0 })];
    render(<CartRecoveryBanner />);
    const text = screen.getByText(/usd:0/).textContent ?? "";
    expect(text).not.toContain("eventDetail.plus");
  });

  it("unrecorded mode: says fees & tax are added (the safe reading)", () => {
    state.carts = [cart({ feeMode: null })];
    render(<CartRecoveryBanner />);
    expect(screen.getByText(/usd:1000/).textContent).toContain(
      "eventDetail.plusFeesAndTax",
    );
  });
});

describe("CartRecoveryBanner resume link", () => {
  beforeEach(() => {
    state.carts = [];
  });

  it("with a slug: Resume links to the slug-addressed checkout", () => {
    const c = cart({});
    state.carts = [c];
    render(<CartRecoveryBanner />);
    const link = screen.getByText("cart.resume").closest("a");
    expect(link?.getAttribute("href")).toBe(
      `/events/checkout/warehouse-showcase?resumeOrderId=${c.id}`,
    );
  });

  it("without a slug: no Resume link, Dismiss stays", () => {
    state.carts = [cart({ eventSlug: null })];
    render(<CartRecoveryBanner />);
    expect(screen.queryByText("cart.resume")).toBeNull();
    expect(screen.getByText("cart.dismiss")).toBeTruthy();
  });
});
