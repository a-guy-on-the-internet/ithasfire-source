import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack, Stack, styled: () => Stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children, tone }: { children?: ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({
    dateTime: (d: Date) => d.toISOString().slice(0, 10),
  }),
  useTranslations: () => (key: string) => {
    const dictionary: Record<string, string> = {
      "admin.cpActive": "Active",
      "admin.cpArchived": "Archived",
      "admin.cpExpired": "Expired",
      "admin.cpNoExpiry": "No expiry",
      "admin.cpRedemptionsColumn": "Redemptions",
    };
    return dictionary[key] ?? key;
  },
}));

vi.mock("@/lib/format", () => ({
  formatCurrency: (cents: number, currency: string) => `${currency}:${cents}`,
}));

import {
  PromoMobileCard,
  getPromoStatus,
  formatPromoValue,
  type PromoMobileCardRow,
} from "../PromoMobileCard";

const baseRow: PromoMobileCardRow = {
  code: "SUMMER25",
  kind: "PERCENT",
  value: 25,
  currency: "usd",
  scope: "GLOBAL",
  status: "ACTIVE",
  endsAt: null,
  maxRedemptions: 100,
  totalRedemptions: 3,
};

describe("getPromoStatus", () => {
  const now = new Date("2026-06-12T00:00:00Z");

  it("ARCHIVED wins over expiry, then end-date expiry, then active", () => {
    expect(
      getPromoStatus("ARCHIVED", new Date("2026-01-01T00:00:00Z"), now),
    ).toEqual({ labelKey: "admin.cpArchived", tone: "neutral" });
    expect(
      getPromoStatus("ACTIVE", new Date("2026-01-01T00:00:00Z"), now),
    ).toEqual({ labelKey: "admin.cpExpired", tone: "warning" });
    expect(getPromoStatus("ACTIVE", null, now)).toEqual({
      labelKey: "admin.cpActive",
      tone: "success",
    });
  });
});

describe("formatPromoValue", () => {
  it("formats percent and fixed-amount promos", () => {
    expect(formatPromoValue("PERCENT", 25)).toBe("25%");
    expect(formatPromoValue("AMOUNT", 500, "usd")).toBe("usd:500");
  });
});

describe("PromoMobileCard", () => {
  it("renders code, status badge, value, scope, redemptions, and expiry", () => {
    render(<PromoMobileCard row={baseRow} />);

    expect(screen.getByText("SUMMER25")).toBeInTheDocument();
    expect(screen.getByText("Active")).toHaveAttribute("data-tone", "success");
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("GLOBAL")).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText(/Redemptions/)).toHaveTextContent(
      "Redemptions: 3 / 100",
    );
    expect(screen.getByText("No expiry")).toBeInTheDocument();
  });

  it("marks past end dates as expired with the table's warning tone", () => {
    render(
      <PromoMobileCard
        row={{
          ...baseRow,
          endsAt: new Date("2020-01-01T00:00:00Z"),
          maxRedemptions: null,
        }}
      />,
    );

    // Badge + expiry caption both say "Expired"; the badge carries the tone.
    const expired = screen.getAllByText("Expired");
    expect(expired.length).toBeGreaterThanOrEqual(1);
    expect(
      expired.some((el) => el.getAttribute("data-tone") === "warning"),
    ).toBe(true);
    expect(screen.getByText(/Redemptions/)).toHaveTextContent(
      "Redemptions: 3",
    );
  });
});
