import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted Stripe mocks ──────────────────────────────────────────────
const stripeMocks = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  elementsSubmit: vi.fn(),
  elementsUpdate: vi.fn(),
  /** The wallet confirm event's "close the sheet as failed". */
  paymentFailed: vi.fn(),
  /** The Payment Element's latest `onChange`, to pick a method. */
  paymentElementOnChange: null as null | ((event: unknown) => void),
}));

vi.mock("@stripe/react-stripe-js", async () => {
  const ReactModule = await import("react");
  return {
    Elements: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(React.Fragment, null, children),
    PaymentElement: ({
      onReady,
      onChange,
    }: {
      onReady?: () => void;
      onChange?: (event: unknown) => void;
    }) => {
      stripeMocks.paymentElementOnChange = onChange ?? null;
      ReactModule.useEffect(() => {
        onReady?.();
      }, [onReady]);
      return ReactModule.createElement("div", {
        "data-testid": "payment-element",
      });
    },
    ExpressCheckoutElement: ({
      onConfirm,
    }: {
      onConfirm?: (event: unknown) => void;
    }) =>
      ReactModule.createElement("button", {
        type: "button",
        "data-testid": "express-confirm",
        onClick: () =>
          onConfirm?.({ paymentFailed: stripeMocks.paymentFailed }),
      }),
    useStripe: () => ({ confirmPayment: stripeMocks.confirmPayment }),
    useElements: () => ({
      submit: stripeMocks.elementsSubmit,
      update: stripeMocks.elementsUpdate,
    }),
  };
});

vi.mock("@/config/stripe", () => ({
  getStripe: () => null,
}));

// The Sentry path for errors the card catches (they used to be unhandled
// rejections Sentry captured on its own).
const trace = vi.hoisted(() => ({ report: vi.fn(), labels: [] as string[] }));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => {
    trace.labels.push(label);
    return trace.report;
  },
}));

vi.mock("@th/ui", () => ({
  useTranslations: () => (key: string) => key,
  Button: ({
    children,
    disabled,
    type,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "submit" | "button";
  }) => (
    <button type={type ?? "button"} disabled={disabled}>
      {children}
    </button>
  ),
  FormErrorBanner: ({ message }: { message: string | null }) =>
    message ? <div role="alert">{message}</div> : null,
  Spinner: () => null,
}));

import { StripePaymentCard } from "./StripePaymentCard";

const submitPaymentForm = (container: HTMLElement) => {
  const form = container.querySelector("form");
  if (!form) throw new Error("payment form not rendered");
  fireEvent.submit(form);
};

describe("StripePaymentCard deferred-mode confirm flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  it("syncs the Elements amount to the server-stamped total before confirming", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    // Client-side estimate ($90.86) differs from the server-stamped
    // PaymentIntent amount ($87.90) — the exact live-repro mismatch.
    const onBeforePayment = vi
      .fn()
      .mockResolvedValue({ clientSecret: "cs_test_123", amountCents: 8790 });
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_1", status: "succeeded" },
    });

    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_1", "succeeded"));
    expect(stripeMocks.elementsUpdate).toHaveBeenCalledWith({ amount: 8790 });
    expect(stripeMocks.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "cs_test_123" }),
    );
    // The amount must be synced BEFORE confirmPayment runs
    const updateOrder = stripeMocks.elementsUpdate.mock.invocationCallOrder[0];
    const confirmOrder =
      stripeMocks.confirmPayment.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(confirmOrder);
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a REJECTED confirmPayment (IntegrationError) instead of failing silently", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onBeforePayment = vi
      .fn()
      .mockResolvedValue({ clientSecret: "cs_test_123", amountCents: 8790 });
    stripeMocks.confirmPayment.mockRejectedValue(
      new Error(
        "IntegrationError: elements should have a mounted Payment Element",
      ),
    );

    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "IntegrationError: elements should have a mounted Payment Element",
      ),
    );
    // Inline error banner is visible to the buyer
    expect(screen.getByRole("alert")).toHaveTextContent("IntegrationError");
    expect(onSuccess).not.toHaveBeenCalled();
    // The form recovers — pay button is re-enabled for a retry
    await waitFor(() => {
      const button = screen.getByRole("button");
      expect(button).not.toBeDisabled();
    });
  });

  it("supports legacy string results from onBeforePayment without an amount sync", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onBeforePayment = vi.fn().mockResolvedValue("cs_legacy_456");
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_2", status: "succeeded" },
    });

    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={5000}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_2", "succeeded"));
    expect(stripeMocks.elementsUpdate).not.toHaveBeenCalled();
    expect(stripeMocks.confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecret: "cs_legacy_456" }),
    );
  });

  it("wallet path: validates via elements.submit() before confirming", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onBeforePayment = vi
      .fn()
      .mockResolvedValue({ clientSecret: "cs_test_789", amountCents: 8790 });
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_3", status: "succeeded" },
    });

    render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    fireEvent.click(screen.getByTestId("express-confirm"));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_3", "succeeded"));
    // Deferred-intent mode requires submit() BEFORE confirmPayment
    expect(stripeMocks.elementsSubmit).toHaveBeenCalled();
    const submitOrder = stripeMocks.elementsSubmit.mock.invocationCallOrder[0];
    const confirmOrder =
      stripeMocks.confirmPayment.mock.invocationCallOrder[0];
    expect(submitOrder).toBeLessThan(confirmOrder);
    // submit() must also precede order creation (onBeforePayment)
    const beforePaymentOrder = onBeforePayment.mock.invocationCallOrder[0];
    expect(submitOrder).toBeLessThan(beforePaymentOrder);
    expect(onError).not.toHaveBeenCalled();
  });

  it("wallet path: bails via onError when elements.submit() fails", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onBeforePayment = vi.fn();
    stripeMocks.elementsSubmit.mockResolvedValue({
      error: { message: "Incomplete wallet details." },
    });

    render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    fireEvent.click(screen.getByTestId("express-confirm"));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Incomplete wallet details."),
    );
    expect(onBeforePayment).not.toHaveBeenCalled();
    expect(stripeMocks.confirmPayment).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("stops cleanly when onBeforePayment resolves null (free order)", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const onBeforePayment = vi.fn().mockResolvedValue(null);

    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={0}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() => expect(onBeforePayment).toHaveBeenCalled());
    expect(stripeMocks.confirmPayment).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("StripePaymentCard — a bank debit still processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  // A US bank debit confirms as `processing`: accepted, not paid, and it can
  // still fail. The caller is told which, so it never reads as confirmed.
  it("card form: passes 'processing' to onSuccess", async () => {
    const onSuccess = vi.fn();
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_ach", status: "processing" },
    });

    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_ach", amountCents: 9086 })}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("pi_ach", "processing"),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("wallet path: passes 'processing' to onSuccess", async () => {
    const onSuccess = vi.fn();
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_ach_w", status: "processing" },
    });

    render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_ach_w", amountCents: 9086 })}
      />,
    );

    fireEvent.click(screen.getByTestId("express-confirm"));

    await waitFor(() =>
      expect(onSuccess).toHaveBeenCalledWith("pi_ach_w", "processing"),
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("StripePaymentCard — reports a Stripe confirm in flight (onSubmittingChange)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  /** A confirmPayment that waits for `settle(result)`. */
  const deferConfirm = () => {
    let settle!: (result: unknown) => void;
    stripeMocks.confirmPayment.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    return (result: unknown) => settle(result);
  };
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];

  it("card form: true while the confirm is in flight, false once it fails", async () => {
    const onSubmittingChange = vi.fn();
    const settle = deferConfirm();
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 9086 })}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    expect(last(onSubmittingChange)).toBe(false);

    submitPaymentForm(container);
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    expect(last(onSubmittingChange)).toBe(true);

    settle({ error: { message: "Your card was declined." } });
    await waitFor(() => expect(last(onSubmittingChange)).toBe(false));
  });

  it("card form: stays true after a success (the parent moves on), false on unmount", async () => {
    const onSubmittingChange = vi.fn();
    const settle = deferConfirm();
    const onSuccess = vi.fn();
    const { container, unmount } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 9086 })}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    submitPaymentForm(container);
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    settle({ paymentIntent: { id: "pi_ok", status: "succeeded" } });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_ok", "succeeded"));
    expect(last(onSubmittingChange)).toBe(true);

    unmount();
    expect(last(onSubmittingChange)).toBe(false);
  });

  it("wallet: true while its confirm is in flight, false once it fails", async () => {
    const onSubmittingChange = vi.fn();
    const settle = deferConfirm();
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_2", amountCents: 9086 })}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    fireEvent.click(screen.getByTestId("express-confirm"));
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    expect(last(onSubmittingChange)).toBe(true);

    settle({ error: { message: "Wallet declined." } });
    await waitFor(() => expect(last(onSubmittingChange)).toBe(false));
  });
});

describe("StripePaymentCard — a throw never leaves it 'submitting'; card and wallet never both", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trace.labels.length = 0;
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });
  const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
  const payButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  /** Let every pending promise callback run (the handlers are async). */
  const flush = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /** A confirmPayment that waits for `settle(result)`. */
  const deferConfirm = () => {
    let settle!: (result: unknown) => void;
    stripeMocks.confirmPayment.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    return (result: unknown) => settle(result);
  };

  it("regression: card — elements.submit() REJECTS → reported to Sentry, submitting false again, and the form submits again", async () => {
    const onSubmittingChange = vi.fn();
    const rejection = new Error("iframe gone");
    stripeMocks.elementsSubmit.mockRejectedValueOnce(rejection);
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi.fn().mockResolvedValue(null)}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    submitPaymentForm(container);
    await waitFor(() => expect(last(onSubmittingChange)).toBe(false));
    expect(trace.labels).toContain("checkout.cardSubmit");
    expect(trace.report).toHaveBeenCalledWith(rejection);
    expect(payButton(container).disabled).toBe(false);

    // Usable again: a second submit runs.
    submitPaymentForm(container);
    await waitFor(() => expect(stripeMocks.elementsSubmit).toHaveBeenCalledTimes(2));
  });

  it("regression: wallet — elements.submit() REJECTS → reported to Sentry, submitting false again, and the buyer is told", async () => {
    const onSubmittingChange = vi.fn();
    const onError = vi.fn();
    const rejection = new Error("wallet sheet closed");
    stripeMocks.elementsSubmit.mockRejectedValueOnce(rejection);
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi.fn()}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    fireEvent.click(screen.getByTestId("express-confirm"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("wallet sheet closed"));
    expect(last(onSubmittingChange)).toBe(false);
    expect(trace.labels).toContain("checkout.walletSubmit");
    expect(trace.report).toHaveBeenCalledWith(rejection);
  });

  it("regression: card — onSuccess THROWS after Stripe succeeded → reported, but no 'payment failed' banner (the charge went through)", async () => {
    const onSubmittingChange = vi.fn();
    const boom = new Error("parent blew up");
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_ok", status: "succeeded" },
    });
    const onSuccess = vi.fn(() => {
      throw boom;
    });
    const { container } = render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 9086 })}
        onSubmittingChange={onSubmittingChange}
      />,
    );
    submitPaymentForm(container);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_ok", "succeeded"));
    await flush();
    expect(trace.report).toHaveBeenCalledWith(boom);
    expect(screen.queryByRole("alert")).toBeNull();
    // Still "submitting": the parent is confirming the charge.
    expect(last(onSubmittingChange)).toBe(true);
  });

  it("regression: wallet — onSuccess THROWS after Stripe succeeded → reported, and NOT handed to onError (which dropped the buyer back to details)", async () => {
    const onError = vi.fn();
    const boom = new Error("parent blew up");
    stripeMocks.confirmPayment.mockResolvedValue({
      paymentIntent: { id: "pi_w", status: "succeeded" },
    });
    const onSuccess = vi.fn(() => {
      throw boom;
    });
    render(
      <StripePaymentCard
        onSuccess={onSuccess}
        onError={onError}
        totalCents={9086}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_2", amountCents: 9086 })}
      />,
    );
    fireEvent.click(screen.getByTestId("express-confirm"));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("pi_w", "succeeded"));
    await flush();
    expect(trace.report).toHaveBeenCalledWith(boom);
    expect(onError).not.toHaveBeenCalled();
  });

  it("regression: while the CARD confirm is in flight, the wallet stays MOUNTED (no layout jump) but hidden, inert, and refuses a second checkout", async () => {
    const settle = deferConfirm();
    const onBeforePayment = vi
      .fn()
      .mockResolvedValue({ clientSecret: "cs_1", amountCents: 9086 });
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );
    const element = screen.getByTestId("express-confirm");
    submitPaymentForm(container);
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());

    // The SAME element is still in the document — not unmounted, not remounted.
    expect(screen.getByTestId("express-confirm")).toBe(element);
    const wrapper = screen.getByTestId("express-pay");
    expect(wrapper.style.visibility).toBe("hidden");
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(wrapper).toHaveAttribute("aria-hidden", "true");

    // A click that gets through anyway starts nothing.
    fireEvent.click(element);
    await flush();
    expect(stripeMocks.elementsSubmit).toHaveBeenCalledTimes(1);
    expect(onBeforePayment).toHaveBeenCalledTimes(1);

    settle({ error: { message: "declined" } });
    await waitFor(() => expect(wrapper.style.visibility).toBe(""));
    expect(screen.getByTestId("express-confirm")).toBe(element);
  });

  it("regression: while the WALLET confirm is in flight, the card form cannot start a second checkout", async () => {
    const settle = deferConfirm();
    const onBeforePayment = vi
      .fn()
      .mockResolvedValue({ clientSecret: "cs_2", amountCents: 9086 });
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment}
      />,
    );
    fireEvent.click(screen.getByTestId("express-confirm"));
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    await waitFor(() => expect(payButton(container).disabled).toBe(true));
    submitPaymentForm(container);
    // Counted AFTER every pending callback has run: a form that did not
    // refuse would have called elements.submit() (synchronously) and then
    // onBeforePayment a second time by now.
    await flush();
    expect(stripeMocks.elementsSubmit).toHaveBeenCalledTimes(1);
    expect(onBeforePayment).toHaveBeenCalledTimes(1);
    settle({ error: { message: "declined" } });
    await waitFor(() => expect(payButton(container).disabled).toBe(false));
  });
});

describe("StripePaymentCard — the wallet sheet is never left hanging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const renderWallet = (onBeforePayment: () => Promise<unknown>) =>
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
        onBeforePayment={onBeforePayment as never}
      />,
    );

  it("regression: wallet details invalid (submit error) → the sheet is failed", async () => {
    stripeMocks.elementsSubmit.mockResolvedValue({ error: { message: "bad" } });
    renderWallet(vi.fn());
    fireEvent.click(screen.getByTestId("express-confirm"));
    await flush();
    expect(stripeMocks.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
  });

  it("regression: onBeforePayment refuses (it throws) → the sheet is failed", async () => {
    renderWallet(vi.fn().mockRejectedValue(new Error("hold expired")));
    fireEvent.click(screen.getByTestId("express-confirm"));
    await flush();
    expect(stripeMocks.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
  });

  it("a FREE order (onBeforePayment → null) closes the sheet with a neutral 'no charge needed' message — not as failed", async () => {
    renderWallet(vi.fn().mockResolvedValue(null));
    fireEvent.click(screen.getByTestId("express-confirm"));
    await flush();
    expect(stripeMocks.paymentFailed).toHaveBeenCalledTimes(1);
    expect(stripeMocks.paymentFailed).toHaveBeenCalledWith({
      message: "checkout.walletNoChargeNeeded",
    });
    expect(stripeMocks.paymentFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "fail" }),
    );
  });

  it("regression: no client secret came back → the sheet is failed", async () => {
    renderWallet(vi.fn().mockResolvedValue({ clientSecret: "", amountCents: 0 }));
    fireEvent.click(screen.getByTestId("express-confirm"));
    await flush();
    expect(stripeMocks.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
  });

  it("regression: paused (the card is confirming) → a wallet confirm is refused AND its sheet failed", async () => {
    let settle!: (result: unknown) => void;
    stripeMocks.confirmPayment.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const { container } = renderWallet(
      vi.fn().mockResolvedValue({ clientSecret: "cs_1", amountCents: 9086 }),
    );
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("express-confirm"));
    await flush();
    expect(stripeMocks.paymentFailed).toHaveBeenCalledWith({ reason: "fail" });
    // Paused means inert as well as hidden.
    expect(screen.getByTestId("express-pay")).toHaveAttribute("inert");
    settle({ error: { message: "declined" } });
    await waitFor(() =>
      expect(screen.getByTestId("express-pay")).not.toHaveAttribute("inert"),
    );
  });

  it("once confirmPayment runs, Stripe owns the sheet — no paymentFailed from us on a decline", async () => {
    stripeMocks.confirmPayment.mockResolvedValue({ error: { message: "declined" } });
    renderWallet(vi.fn().mockResolvedValue({ clientSecret: "cs_2", amountCents: 9086 }));
    fireEvent.click(screen.getByTestId("express-confirm"));
    await waitFor(() => expect(stripeMocks.confirmPayment).toHaveBeenCalled());
    await flush();
    expect(stripeMocks.paymentFailed).not.toHaveBeenCalled();
  });
});

describe("StripePaymentCard — the Stripe appearance follows the theme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });
  afterEach(() => {
    // Unmount first: resetting the vars would otherwise fire the theme
    // observer into an unmounted-test update.
    cleanup();
    document.body.style.removeProperty("--color");
    document.body.style.removeProperty("--surface");
  });

  it("regression: a light → dark switch after mount restyles the mounted Elements in place (elements.update), with the night theme", async () => {
    document.body.style.setProperty("--color", "#211C16");
    document.body.style.setProperty("--surface", "#FDFAF3");
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={9086}
        currency="usd"
      />,
    );
    // Nothing pushed on mount: the first appearance is in the options.
    expect(stripeMocks.elementsUpdate).not.toHaveBeenCalled();

    // Async act: the theme is picked up by a MutationObserver (a microtask).
    await act(async () => {
      document.body.style.setProperty("--color", "#F3EDE2");
      document.body.style.setProperty("--surface", "#16120E");
    });
    await waitFor(() =>
      expect(stripeMocks.elementsUpdate).toHaveBeenCalledWith({
        appearance: expect.objectContaining({
          theme: "night",
          variables: expect.objectContaining({
            colorText: "#F3EDE2",
            colorBackground: "#16120E",
          }),
        }),
      }),
    );
  });
});

describe("StripePaymentCard expressPay opt-out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the wallet buttons by default (the ticket checkout is unchanged)", () => {
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={5175}
        currency="usd"
        onBeforePayment={vi.fn()}
      />,
    );
    expect(screen.getByTestId("express-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("payment-element")).toBeInTheDocument();
  });

  it("expressPay={false} hides the wallet buttons and keeps the card", () => {
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={5175}
        currency="usd"
        onBeforePayment={vi.fn()}
        expressPay={false}
      />,
    );
    expect(screen.queryByTestId("express-confirm")).not.toBeInTheDocument();
    expect(screen.getByTestId("payment-element")).toBeInTheDocument();
  });
});

describe("StripePaymentCard amount sync (the wallet sheet's amount follows the total)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // No opt-in prop: every caller (ticket checkout and resale) gets the sync.
  // A wallet sheet showing a stale figure has the buyer authorise an amount
  // that is not the one on the page (owner, 2026-10-14).
  const card = (totalCents: number) => (
    <StripePaymentCard
      onSuccess={vi.fn()}
      onError={vi.fn()}
      totalCents={totalCents}
      currency="usd"
      onBeforePayment={vi.fn()}
    />
  );

  it("pushes a changed total into Elements, in place", () => {
    const { rerender } = render(card(5619));
    // The first amount is already in the frozen options: nothing pushed.
    expect(stripeMocks.elementsUpdate).not.toHaveBeenCalled();

    rerender(card(5662));
    expect(stripeMocks.elementsUpdate).toHaveBeenCalledWith({ amount: 5662 });
    expect(screen.getByTestId("payment-element")).toBeInTheDocument();

    rerender(card(5662));
    expect(stripeMocks.elementsUpdate).toHaveBeenCalledTimes(1);
  });

  it("follows a total that drops (a promo applied on the payment step) and back", () => {
    const { rerender } = render(card(4542));
    rerender(card(4088));
    rerender(card(4542));
    expect(stripeMocks.elementsUpdate.mock.calls).toEqual([
      [{ amount: 4088 }],
      [{ amount: 4542 }],
    ]);
  });

  it("never pushes a zero or missing total (a credit-covered order has no wallet charge)", () => {
    const { rerender } = render(card(4542));
    rerender(card(0));
    rerender(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={undefined}
        currency="usd"
        onBeforePayment={vi.fn()}
      />,
    );
    expect(stripeMocks.elementsUpdate).not.toHaveBeenCalled();
  });

  it("starts syncing once the first total is known (Elements mounted before the total)", () => {
    const { rerender } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={vi.fn()}
        totalCents={undefined}
        currency="usd"
        onBeforePayment={vi.fn()}
      />,
    );
    // The first known total becomes the frozen starting amount: nothing pushed.
    rerender(card(4542));
    expect(stripeMocks.elementsUpdate).not.toHaveBeenCalled();
    rerender(card(4601));
    expect(stripeMocks.elementsUpdate).toHaveBeenCalledWith({ amount: 4601 });
  });
});

describe("StripePaymentCard onError carries the code and the PaymentIntent's status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  it("card: payment_intent_unexpected_state on an already-succeeded PaymentIntent", async () => {
    const onError = vi.fn();
    stripeMocks.confirmPayment.mockResolvedValue({
      error: {
        message: "already succeeded",
        code: "payment_intent_unexpected_state",
        payment_intent: { id: "pi_1", status: "succeeded" },
      },
    });
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={onError}
        totalCents={5619}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 5619 })}
      />,
    );

    submitPaymentForm(container);

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "already succeeded",
        "payment_intent_unexpected_state",
        "succeeded",
        // The PaymentIntent's id rides along, so an accepted payment can be
        // confirmed with the server.
        "pi_1",
      ),
    );
  });

  it("wallet: the same four arguments", async () => {
    const onError = vi.fn();
    stripeMocks.confirmPayment.mockResolvedValue({
      error: {
        message: "canceled",
        code: "payment_intent_unexpected_state",
        payment_intent: { id: "pi_1", status: "canceled" },
      },
    });
    render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={onError}
        totalCents={5619}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 5619 })}
      />,
    );

    fireEvent.click(screen.getByTestId("express-confirm"));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        "canceled",
        "payment_intent_unexpected_state",
        "canceled",
        // The PaymentIntent's id rides along, so an accepted payment can be
        // confirmed with the server.
        "pi_1",
      ),
    );
  });
});

describe("StripePaymentCard — a bank debit is said before paying", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  const pick = (type: string) =>
    act(() => {
      stripeMocks.paymentElementOnChange?.({
        complete: false,
        empty: true,
        value: { type },
      });
    });

  it("shows the note under the Payment Element only while US bank account is selected", () => {
    render(
      <StripePaymentCard onSuccess={vi.fn()} onError={vi.fn()} currency="usd" />,
    );
    // Card is the default tab: no note, but the polite live region is
    // already mounted, so the note is announced when it appears.
    expect(screen.queryByTestId("bank-debit-notice")).toBeNull();
    const live = screen.getByTestId("bank-debit-live-region");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).not.toHaveAttribute("role", "alert");

    pick("us_bank_account");
    expect(screen.getByTestId("bank-debit-notice")).toHaveTextContent(
      "checkout.bankDebitNotice",
    );
    expect(live).toContainElement(screen.getByTestId("bank-debit-notice"));

    pick("card");
    expect(screen.queryByTestId("bank-debit-notice")).toBeNull();

    pick("google_pay");
    expect(screen.queryByTestId("bank-debit-notice")).toBeNull();
  });
});

describe("StripePaymentCard — an already-accepted PaymentIntent flashes no error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stripeMocks.elementsSubmit.mockResolvedValue({});
  });

  const pressPay = async (status: string) => {
    const onError = vi.fn();
    stripeMocks.confirmPayment.mockResolvedValue({
      error: {
        message: "already accepted",
        code: "payment_intent_unexpected_state",
        payment_intent: { id: "pi_1", status },
      },
    });
    const { container } = render(
      <StripePaymentCard
        onSuccess={vi.fn()}
        onError={onError}
        totalCents={5619}
        currency="usd"
        onBeforePayment={vi
          .fn()
          .mockResolvedValue({ clientSecret: "cs_1", amountCents: 5619 })}
      />,
    );
    submitPaymentForm(container);
    await waitFor(() => expect(onError).toHaveBeenCalled());
  };

  it.each(["succeeded", "processing"])(
    "%s: the parent confirms it, and no red banner shows",
    async (status) => {
      await pressPay(status);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("canceled: a real failure still shows the banner", async () => {
    await pressPay("canceled");
    expect(screen.getByRole("alert")).toHaveTextContent("already accepted");
  });
});
