import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";
import { RefundDisclosure } from "./RefundDisclosure";

let messages: Record<string, string> = {};

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => messages[key] ?? key,
  useFormatters: () => ({
    getRawMessage: (key: string) => messages[key],
  }),
  Checkbox: ({ label }: { label: React.ReactNode }) => <div>{label}</div>,
}));

const cart = [{ id: "a", quantity: 1, pricingMode: "FIXED" as const, priceCents: 2500 }];
const base = {
  cart,
  checked: false,
  onCheckedChange: () => {},
  refundPolicyHref: "/help/refunds",
};

const flat = (m: unknown): Record<string, string> =>
  (m as { checkout: Record<string, string> }).checkout;

describe("RefundDisclosure sale variant", () => {
  for (const [name, source] of [
    ["en", enMessages],
    ["es", esMessages],
  ] as const) {
    it(`resale copy never mentions the platform fee (${name})`, () => {
      messages = Object.fromEntries(
        Object.entries(flat(source)).map(([k, v]) => [`checkout.${k}`, v]),
      );
      for (const refundPolicyHref of ["/help/refunds", undefined]) {
        const { container, unmount } = render(
          <RefundDisclosure {...base} refundPolicyHref={refundPolicyHref} sale="RESALE" />,
        );
        const text = container.textContent ?? "";
        expect(text).toMatch(/[Rr]eembolsable|[Rr]efundable/);
        expect(text).not.toMatch(/platform fee|tarifa de plataforma/i);
        unmount();
      }
    });
  }

  it("primary copy still mentions the platform fee", () => {
    messages = Object.fromEntries(
      Object.entries(flat(enMessages)).map(([k, v]) => [`checkout.${k}`, v]),
    );
    render(<RefundDisclosure {...base} />);
    expect(screen.getByText(/platform fee/)).toBeTruthy();
  });

  it("resale falls back to the inline English sentence without the platform fee", () => {
    messages = {};
    const { container } = render(<RefundDisclosure {...base} sale="RESALE" />);
    expect(container.textContent).toMatch(/Refundable per the organizer/);
    expect(container.textContent).not.toMatch(/platform fee/i);
  });
});
