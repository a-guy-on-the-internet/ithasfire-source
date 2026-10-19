import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * The done screen's change notice. The till collects the quote's cash total;
 * when the server charged less (a hand-entered tax rate gave way to a lower
 * looked-up one) the buyer is owed the difference, and this screen is the
 * only place that knows it.
 */

vi.mock("tamagui", () => ({
  XStack: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  ),
  YStack: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...pickDomProps(rest)}>{children}</div>
  ),
}));

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => (
    <button onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </button>
  ),
  Spinner: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { SaleDoneView } from "../SaleStates";

const done = (changeCents: number) =>
  render(
    <SaleDoneView
      amountCents={9_000}
      currency="usd"
      ticketCount={2}
      tender="cash"
      discountCents={0}
      buyerEmail={null}
      changeCents={changeCents}
      autoAdmitted
      seatLabels={[]}
      onNextSale={() => {}}
    />,
  );

describe("SaleDoneView — change due", () => {
  it("tells the operator to give back the difference", () => {
    done(833);
    const notice = screen.getByTestId("sell-done-change");
    expect(notice.textContent).toBe(
      "Give back $8.33: the total came out lower than quoted.",
    );
  });

  it("says nothing when the sale charged exactly what was taken", () => {
    done(0);
    expect(screen.queryByTestId("sell-done-change")).toBeNull();
  });
});

describe("SaleDoneView — free with a code", () => {
  const free = (promoCodes?: string[]) =>
    render(
      <SaleDoneView
        amountCents={0}
        currency="usd"
        ticketCount={2}
        tender="cash"
        discountCents={9_000}
        promoCodes={promoCodes}
        buyerEmail={null}
        changeCents={0}
        autoAdmitted
        seatLabels={[]}
        onNextSale={() => {}}
      />,
    );

  it("names the code that made the sale free (a sale, never a comp)", () => {
    free(["FRIENDS100"]);
    expect(screen.getByText("Free with FRIENDS100 — 2 tickets")).toBeTruthy();
    expect(screen.getByText("Counted as a sale, not a comp")).toBeTruthy();
    expect(screen.queryByText("Comped")).toBeNull();
  });

  it("falls back to 'a code' for a result that carries no codes", () => {
    free(undefined);
    expect(screen.getByText("Free with a code — 2 tickets")).toBeTruthy();
  });

  it("a comp stays a comp, whatever codes say", () => {
    render(
      <SaleDoneView
        amountCents={0}
        currency="usd"
        ticketCount={1}
        tender="comp"
        discountCents={0}
        promoCodes={[]}
        buyerEmail={null}
        changeCents={0}
        autoAdmitted
        seatLabels={[]}
        onNextSale={() => {}}
      />,
    );
    expect(screen.getByText("Comped")).toBeTruthy();
    expect(screen.getByText("Guest list — 1 ticket")).toBeTruthy();
  });
});
