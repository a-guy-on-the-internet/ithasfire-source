import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MembershipPaymentStep — the Elements confirmation for a
 * `default_incomplete` membership subscription. What matters here:
 *
 *  - confirm success (succeeded/processing) → onSuccess, so the panel can
 *    show the honest "webhooks are finishing this" state;
 *  - a decline resolves `{ error }` and an IntegrationError REJECTS — both
 *    must land in the inline alert with the form still standing for a retry
 *    (an uncaught rejection here would wipe the form silently);
 *  - backing out calls onCancel (the membership stays resumable).
 */

const confirmPayment = vi.fn();

vi.mock("@stripe/react-stripe-js", async () => {
  const { useEffect } = await import("react");
  return {
    Elements: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="elements">{children}</div>
    ),
    PaymentElement: ({ onReady }: { onReady?: () => void }) => {
      useEffect(() => {
        onReady?.();
      }, [onReady]);
      return <div data-testid="payment-element" />;
    },
    useStripe: () => ({ confirmPayment }),
    useElements: () => ({}),
  };
});

vi.mock("@/config/stripe", () => ({
  getStripe: () => Promise.resolve(null),
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
}));

import { MembershipPaymentStep } from "../MembershipPaymentStep";

const onSuccess = vi.fn();
const onCancel = vi.fn();

function renderStep() {
  return render(
    <MembershipPaymentStep
      clientSecret="pi_1_secret_abc"
      tierName="Sustaining Member"
      onSuccess={onSuccess}
      onCancel={onCancel}
    />,
  );
}

async function submitPayment() {
  const pay = await screen.findByRole("button", {
    name: "entityMemberships.payNow",
  });
  await waitFor(() => expect(pay).toBeEnabled());
  fireEvent.click(pay);
}

beforeEach(() => {
  confirmPayment.mockReset();
  onSuccess.mockClear();
  onCancel.mockClear();
});

describe("MembershipPaymentStep", () => {
  it("confirm success → onSuccess (webhooks own activation)", async () => {
    confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_1", status: "succeeded" },
    });
    renderStep();

    await submitPayment();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ redirect: "if_required" }),
    );
  });

  it("`processing` also counts as success — delayed-notification methods settle via webhook", async () => {
    confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_1", status: "processing" },
    });
    renderStep();

    await submitPayment();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  it("a decline shows the inline alert and leaves the form up for retry", async () => {
    confirmPayment.mockResolvedValue({
      error: { message: "Your card was declined." },
    });
    renderStep();

    await submitPayment();

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Your card was declined.");
    expect(onSuccess).not.toHaveBeenCalled();
    // Retry path: the form is still standing and the button re-enabled.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "entityMemberships.payNow" }),
      ).toBeEnabled(),
    );
  });

  it("a REJECTED confirmPayment (IntegrationError) lands in the alert, not a silent wipe", async () => {
    confirmPayment.mockRejectedValue(new Error("Integration error"));
    renderStep();

    await submitPayment();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Integration error",
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("Finish later → onCancel", async () => {
    confirmPayment.mockResolvedValue({});
    renderStep();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "entityMemberships.paymentFinishLater",
      }),
    );

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(confirmPayment).not.toHaveBeenCalled();
  });
});
