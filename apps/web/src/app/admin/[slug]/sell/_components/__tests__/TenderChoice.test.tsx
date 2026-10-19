import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { pickDomProps } from "@/test-support/pick-dom-props";

/**
 * The tender screen while a sale attempt is unresolved. The key is kept, so
 * anything that changes the sale (the email, the cart, the tender) would be a
 * second sale under it, and the notice has to say the right thing: "press it
 * again" for a lost answer or a sale still processing, "go and check" for a
 * key that may already hold a sale.
 */

vi.mock("tamagui", async () => {
  const { pickDomProps } = await import("@/test-support/pick-dom-props");
  // A `tag="button"` stack is a real <button> (the tender tiles): render one,
  // so `disabled` and the press are what the test sees.
  const stack = ({
    children,
    tag,
    onPress,
    ...rest
  }: { children?: ReactNode; tag?: string; onPress?: () => void } & Record<
    string,
    unknown
  >) =>
    tag === "button" ? (
      <button onClick={onPress} {...pickDomProps(rest)}>
        {children}
      </button>
    ) : (
      <div {...pickDomProps(rest)}>{children}</div>
    );
  return { XStack: stack, YStack: stack };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    ...rest
  }: { children?: ReactNode; onPress?: () => void } & Record<string, unknown>) => (
    <button onClick={onPress} {...pickDomProps(rest)}>
      {children}
    </button>
  ),
  StyledSelect: () => null,
  Text: ({ children, id }: { children?: ReactNode; id?: string }) => (
    <span id={id}>{children}</span>
  ),
  TextInput: ({
    testId,
    disabled,
  }: {
    testId?: string;
    disabled?: boolean;
  }) => <input data-testid={testId} disabled={disabled} />,
}));

import { TenderChoice } from "../TenderChoice";

const tender = (
  over: Partial<{
    lockedTender: "card" | "cash" | "comp" | null;
    lockReason: "no-answer" | "processing" | null;
    mayAlreadyBeRecorded: boolean;
    onCheckTill: () => void;
    onBack: () => void;
  }> = {},
) =>
  render(
    <TenderChoice
      cardTotalCents={10_917}
      cashTotalCents={9_833}
      currency="usd"
      ticketCount={2}
      eventTitle="Door Night"
      readers={[{ id: "r1", label: "Front door", status: "online", busy: false }]}
      selectedReaderId="r1"
      onSelectReader={() => {}}
      buyerEmail=""
      onBuyerEmailChange={() => {}}
      cashTotalChanged={false}
      lockedTender={over.lockedTender ?? null}
      lockReason={over.lockReason ?? null}
      mayAlreadyBeRecorded={over.mayAlreadyBeRecorded ?? false}
      onCheckTill={over.onCheckTill ?? (() => {})}
      onCard={() => {}}
      onCash={() => {}}
      onComp={() => {}}
      onBack={over.onBack ?? (() => {})}
      busy={false}
    />,
  );

const disabled = (testId: string) =>
  (screen.getByTestId(testId) as HTMLButtonElement | HTMLInputElement).disabled;

describe("TenderChoice — an unresolved attempt", () => {
  it("leaves everything open when nothing is pending", () => {
    tender();
    expect(disabled("sell-back-to-cart")).toBe(false);
    expect(disabled("sell-buyer-email")).toBe(false);
    expect(disabled("tender-cash")).toBe(false);
  });

  it("locks Back to cart, the email and the other tenders after a lost answer", () => {
    // Back to cart would let the cart change under a key that may hold a sale.
    tender({ lockedTender: "cash", lockReason: "no-answer" });
    expect(disabled("sell-back-to-cart")).toBe(true);
    expect(disabled("sell-buyer-email")).toBe(true);
    expect(disabled("tender-cash")).toBe(false);
    expect(disabled("tender-card")).toBe(true);
    expect(disabled("tender-comp")).toBe(true);
    expect(screen.getByTestId("sell-no-answer").textContent).toContain(
      "Press Cash again",
    );
  });

  it("says 'still being processed' for a lock in progress, and keeps the same tender pressable", () => {
    tender({ lockedTender: "cash", lockReason: "processing" });
    expect(screen.queryByTestId("sell-may-be-recorded")).toBeNull();
    expect(screen.queryByTestId("sell-no-answer")).toBeNull();
    expect(screen.getByTestId("sell-still-processing").textContent).toBe(
      "Still being processed. Wait a moment, then press Cash again.",
    );
    expect(disabled("tender-cash")).toBe(false);
    expect(disabled("sell-back-to-cart")).toBe(true);
  });

  it("names where the check button goes", () => {
    const onCheckTill = vi.fn();
    tender({ lockedTender: "cash", lockReason: "no-answer", mayAlreadyBeRecorded: true, onCheckTill });
    const check = screen.getByTestId("sell-check-till");
    expect(check.textContent).toBe("See Cash taken tonight");
    fireEvent.click(check);
    expect(onCheckTill).toHaveBeenCalledTimes(1);
    // Every tender is shut: the next press must not be a guess.
    expect(disabled("tender-cash")).toBe(true);
  });
});
