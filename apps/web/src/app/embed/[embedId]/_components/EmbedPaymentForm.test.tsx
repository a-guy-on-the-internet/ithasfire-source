import { useEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/messages/en";

/**
 * EmbedPaymentForm and the order it charges.
 *
 *  - It reports a confirm in flight (`onSubmittingChange`): the checkout locks
 *    Back on it, because stepping back and changing the cart discards the
 *    order, and a confirm landing after that would charge an order the buyer
 *    has left. So the report must also END, whatever Stripe.js does.
 *  - A confirm that errored or never answered is not proof nothing was
 *    charged. The form asks Stripe what became of the PaymentIntent before it
 *    says "failed" and frees the buyer to buy again.
 *  - One confirm per click and one completion per order, and a confirm that
 *    never answers does not hold the form (and Back) for good.
 */

type ConfirmResult = {
  error?: { message?: string; type?: string };
  paymentIntent?: { status: string };
};
type RetrieveResult = { paymentIntent?: { status: string }; error?: object };

const stripeJs = vi.hoisted(() => ({
  /** The confirm Stripe has not answered yet. */
  pending: null as null | {
    resolve: (result: unknown) => void;
    reject: (err: unknown) => void;
  },
  confirmCalls: 0,
  /** Runs inside `confirmPayment`, at the moment the confirm goes out. */
  onConfirmSent: null as null | (() => void),
  /** What `retrievePaymentIntent` answers. */
  retrieve: (() => Promise.resolve({})) as (secret: string) => Promise<unknown>,
  retrieveCalls: [] as string[],
  submit: (() => Promise.resolve({})) as () => Promise<unknown>,
  traced: [] as string[],
  /** What the form told each wallet click: open the sheet, or do not. */
  walletClicks: [] as Array<"resolved" | "rejected">,
  /** The wallet element's confirm, callable after the form is gone. */
  walletConfirm: null as null | ((e: unknown) => void),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  useStripe: () => ({
    confirmPayment: () => {
      stripeJs.confirmCalls += 1;
      stripeJs.onConfirmSent?.();
      return new Promise((resolve, reject) => {
        stripeJs.pending = { resolve, reject };
      });
    },
    retrievePaymentIntent: (secret: string) => {
      stripeJs.retrieveCalls.push(secret);
      return stripeJs.retrieve(secret);
    },
  }),
  useElements: () => ({ submit: () => stripeJs.submit() }),
  PaymentElement: ({ onReady }: { onReady: () => void }) => {
    useEffect(() => onReady(), [onReady]);
    return <div data-testid="payment-element" />;
  },
  // Reports a wallet, or the form keeps the express row hidden. Like the
  // real element, it asks the form before opening the sheet (`onClick`) and
  // confirms only when told to go ahead.
  ExpressCheckoutElement: ({
    onConfirm,
    onReady,
    onClick,
  }: {
    onConfirm: (e: unknown) => void;
    onReady: (e: { availablePaymentMethods: object }) => void;
    onClick: (e: { resolve: () => void; reject: () => void }) => void;
  }) => {
    useEffect(
      () => onReady({ availablePaymentMethods: { applePay: true } }),
      [onReady],
    );
    stripeJs.walletConfirm = onConfirm;
    return (
      <>
        <button
          type="button"
          onClick={() => {
            let goAhead = false;
            onClick({
              resolve: () => {
                goAhead = true;
                stripeJs.walletClicks.push("resolved");
              },
              reject: () => {
                stripeJs.walletClicks.push("rejected");
              },
            });
            if (goAhead) onConfirm({});
          }}
        >
          wallet pay
        </button>
        {/* A sheet that confirms without asking: what the form's own guard
            must stop. */}
        <button type="button" onClick={() => onConfirm({})}>
          wallet confirms unasked
        </button>
      </>
    );
  },
}));

// The translator reads the REAL app catalog: a key the form asks for that
// the catalog lacks shows up as the raw key and fails the copy assertions.
vi.mock("@th/ui", () => ({
  Spinner: () => <span data-testid="spinner" />,
  useTranslations: () => (key: string) => {
    const [block, name] = key.split(".");
    const value = (en as unknown as Record<string, Record<string, unknown>>)[
      block ?? ""
    ]?.[name ?? ""];
    return typeof value === "string" ? value : key;
  },
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => () => {
    stripeJs.traced.push(label);
  },
}));

import { EmbedPaymentForm } from "./EmbedPaymentForm";
import { CONFIRM_WATCHDOG_MS } from "./embed-request-timeouts";

const UNKNOWN_OUTCOME =
  "We could not confirm whether your payment went through. Check your email before trying again.";

const renderForm = (
  props: {
    payDisabled?: boolean;
    confirmingOrder?: boolean;
    onBeforeConfirm?: () => void;
  } = {},
) => {
  const onSubmittingChange = vi.fn();
  const onSuccess = vi.fn();
  const onError = vi.fn();
  const onOutcomeUnknown = vi.fn();
  const onOrderExpired = vi.fn();
  const view = render(
    <EmbedPaymentForm
      clientSecret="pi_1_secret_x"
      totalCents={2000}
      currency="usd"
      onSuccess={onSuccess}
      onError={onError}
      onSubmittingChange={onSubmittingChange}
      onOutcomeUnknown={onOutcomeUnknown}
      onOrderExpired={onOrderExpired}
      {...props}
    />,
  );
  return {
    onSubmittingChange,
    onSuccess,
    onError,
    onOutcomeUnknown,
    onOrderExpired,
    ...view,
  };
};

/** Let the form's async continuation (confirm → status read) run out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const click = (name: string | RegExp) =>
  act(async () => {
    await userEvent.click(screen.getByRole("button", { name }));
    await settle();
  });
const pay = () => click(/^Pay /);

/** Stripe answers the pending confirm (or the confirm rejects). */
const confirmAnswers = (result: ConfirmResult) =>
  act(async () => {
    stripeJs.pending?.resolve(result);
    await settle();
  });
const confirmRejects = (err: unknown) =>
  act(async () => {
    stripeJs.pending?.reject(err);
    await settle();
  });

const retrieveAnswers = (result: RetrieveResult) => {
  stripeJs.retrieve = () => Promise.resolve(result);
};

const lastReport = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls[fn.mock.calls.length - 1]?.[0];

beforeEach(() => {
  stripeJs.pending = null;
  stripeJs.confirmCalls = 0;
  stripeJs.onConfirmSent = null;
  stripeJs.retrieveCalls.length = 0;
  stripeJs.traced.length = 0;
  stripeJs.walletClicks.length = 0;
  stripeJs.walletConfirm = null;
  stripeJs.submit = () => Promise.resolve({});
  // By default Stripe says the PaymentIntent still wants a payment method.
  retrieveAnswers({ paymentIntent: { status: "requires_payment_method" } });
});

describe("EmbedPaymentForm — the caption names what this form offers", () => {
  it("card, the device's wallets and bank through Link, from the catalog; not the old redirect line", () => {
    renderForm();
    const caption = (en as unknown as Record<string, Record<string, string>>)
      .checkout?.embedPaymentMethodsCaption;
    expect(caption).toMatch(/card/);
    expect(caption).toMatch(/Link/);
    expect(screen.getByText(caption ?? "missing")).toBeTruthy();
    expect(screen.queryByText(/Redirect-based/)).toBeNull();
  });
});

describe("EmbedPaymentForm — a confirm in flight", () => {
  it("card: in flight from submit until Stripe answers; a decline frees it and shows as an alert", async () => {
    const { onSubmittingChange, onError } = renderForm();
    expect(lastReport(onSubmittingChange)).toBe(false);

    await pay();
    expect(lastReport(onSubmittingChange)).toBe(true);
    // The button says so. Nothing in the form announces it: a role on a
    // button's child is not exposed, and the checkout header's live region
    // carries the announcement (EmbedOrderNotice.test.tsx).
    expect(screen.getByRole("button", { name: /Processing/ })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();

    await confirmAnswers({ error: { message: "Your card was declined." } });

    expect(lastReport(onSubmittingChange)).toBe(false);
    expect(onError).toHaveBeenCalledWith("Your card was declined.");
    expect(screen.getByRole("alert").textContent).toBe(
      "Your card was declined.",
    );
  });

  it("card: a charge that went through stays in flight (the widget moves on to the confirmation)", async () => {
    const { onSubmittingChange, onSuccess } = renderForm();

    await pay();
    await confirmAnswers({ paymentIntent: { status: "succeeded" } });

    expect(onSuccess).toHaveBeenCalledTimes(1);
    // With the status Stripe gave: the widget's copy depends on it if the
    // server then does not confirm the order.
    expect(onSuccess).toHaveBeenCalledWith("succeeded");
    expect(lastReport(onSubmittingChange)).toBe(true);
    // A clean answer needs no second opinion.
    expect(stripeJs.retrieveCalls).toEqual([]);
  });

  it("wallet: Apple Pay / Google Pay counts as in flight too, and its error shows on the payment step", async () => {
    const { onSubmittingChange, onError } = renderForm();

    await click("wallet pay");
    expect(lastReport(onSubmittingChange)).toBe(true);

    await confirmAnswers({ error: { message: "Wallet closed." } });

    expect(lastReport(onSubmittingChange)).toBe(false);
    expect(onError).toHaveBeenCalledWith("Wallet closed.");
    // Not only handed to the checkout (which does not print it on this step).
    expect(screen.getByRole("alert").textContent).toBe("Wallet closed.");
  });

  it("wallet: 'in flight' is reported BEFORE the confirm goes out, in the same tick, not a render later", async () => {
    // The wallet's confirm comes from a Stripe callback: the form sets its
    // own state and sends the confirm with no render in between. The widget
    // never releases an order under a confirm, so it must have heard by the
    // time Stripe is called (a timer can land before the next render).
    const { onSubmittingChange } = renderForm();
    let reportedWhenSent: unknown = "not sent";
    stripeJs.onConfirmSent = () => {
      reportedWhenSent = lastReport(onSubmittingChange);
    };

    await click("wallet pay");

    expect(stripeJs.confirmCalls).toBe(1);
    expect(reportedWhenSent).toBe(true);
  });

  it("card: 'in flight' is reported before the confirm goes out, too", async () => {
    const { onSubmittingChange } = renderForm();
    let reportedWhenSent: unknown = "not sent";
    stripeJs.onConfirmSent = () => {
      reportedWhenSent = lastReport(onSubmittingChange);
    };

    await pay();

    expect(stripeJs.confirmCalls).toBe(1);
    expect(reportedWhenSent).toBe(true);
  });

  it("a confirm that ends unpaid reports 'not in flight' itself, not only through a render", async () => {
    // "In flight" is reported directly, ahead of any render. If the confirm
    // ended before `isSubmitting` rendered true, the effect would have
    // nothing to re-run on, and the widget would keep Back locked. So the
    // end is reported directly too: the first "not in flight" comes while
    // the button still reads "Processing", before the render that frees it.
    const { onSubmittingChange } = renderForm();
    await pay();
    const buttonSaidProcessing: boolean[] = [];
    onSubmittingChange.mockImplementation((inFlight: boolean) => {
      if (inFlight) return;
      buttonSaidProcessing.push(
        screen.queryByRole("button", { name: /Processing/ }) !== null,
      );
    });

    await confirmAnswers({ error: { message: "Your card was declined." } });

    expect(buttonSaidProcessing[0]).toBe(true);
    expect(screen.queryByRole("button", { name: /Processing/ })).toBeNull();
  });

  it("wallet: an answer that is neither paid nor an error frees it", async () => {
    const { onSubmittingChange, onSuccess } = renderForm();

    await click("wallet pay");
    await confirmAnswers({
      paymentIntent: { status: "requires_payment_method" },
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(lastReport(onSubmittingChange)).toBe(false);
  });

  it("unmounting mid-confirm reports 'not in flight', so Back cannot stay locked behind a form that is gone", async () => {
    const { onSubmittingChange, unmount } = renderForm();

    await pay();
    expect(lastReport(onSubmittingChange)).toBe(true);

    unmount();

    expect(lastReport(onSubmittingChange)).toBe(false);
  });
});

describe("EmbedPaymentForm — Stripe.js rejects instead of answering", () => {
  it.each(["card", "wallet"] as const)(
    "%s: a confirm that REJECTS still frees the form, with an error",
    async (method) => {
      const { onSubmittingChange, onSuccess } = renderForm();

      await (method === "card" ? pay() : click("wallet pay"));
      expect(lastReport(onSubmittingChange)).toBe(true);

      await confirmRejects(new TypeError("Failed to fetch"));

      expect(lastReport(onSubmittingChange)).toBe(false);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toBe(
        "Payment could not be completed. Please try again.",
      );
      expect(stripeJs.traced).toContain("embed.confirmPaymentThrew");
    },
  );

  it("card: the PaymentElement's own check rejecting frees the form before anything is confirmed", async () => {
    stripeJs.submit = () => Promise.reject(new Error("elements blew up"));
    const { onSubmittingChange } = renderForm();

    await pay();

    expect(lastReport(onSubmittingChange)).toBe(false);
    expect(stripeJs.confirmCalls).toBe(0);
    expect(screen.getByRole("alert").textContent).toBe(
      "Payment could not be completed. Please try again.",
    );
    expect(stripeJs.traced).toContain("embed.paymentElementSubmitThrew");
  });
});

describe("EmbedPaymentForm — a confirm that failed may still have charged", () => {
  // The response can be lost after Stripe took the payment. Telling the buyer
  // it failed frees them to change the cart and pay for a second order.
  it.each(["succeeded", "processing"] as const)(
    "an error from the confirm, but Stripe says the PaymentIntent %s → the purchase completes",
    async (status) => {
      retrieveAnswers({ paymentIntent: { status } });
      const { onSubmittingChange, onSuccess, onError } = renderForm();

      await pay();
      await confirmAnswers({ error: { message: "Network error." } });

      expect(stripeJs.retrieveCalls).toEqual(["pi_1_secret_x"]);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(lastReport(onSubmittingChange)).toBe(true);
    },
  );

  it("a confirm that REJECTS, but Stripe says succeeded → the purchase completes (wallet)", async () => {
    retrieveAnswers({ paymentIntent: { status: "succeeded" } });
    const { onSuccess } = renderForm();

    await click("wallet pay");
    await confirmRejects(new TypeError("Failed to fetch"));

    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an error that does not settle it, which Stripe confirms as unpaid, keeps Stripe's own message", async () => {
    const { onSuccess, onOutcomeUnknown, onError } = renderForm();

    await pay();
    await confirmAnswers({
      error: { type: "api_error", message: "Something went wrong." },
    });

    expect(stripeJs.retrieveCalls).toEqual(["pi_1_secret_x"]);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Something went wrong.");
  });

  // A refused card, or details that never left the page: nothing was
  // charged, so Stripe is not asked, and an unreachable Stripe cannot turn a
  // plain decline into "we could not confirm whether your payment went
  // through".
  it.each(["card_error", "validation_error"] as const)(
    "a %s settles it: the message shows without asking Stripe, reachable or not",
    async (type) => {
      stripeJs.retrieve = () => Promise.reject(new TypeError("offline"));
      const { onSuccess, onOutcomeUnknown, onError, onSubmittingChange } =
        renderForm();

      await pay();
      await confirmAnswers({
        error: { type, message: "Your card was declined." },
      });

      expect(stripeJs.retrieveCalls).toEqual([]);
      expect(onOutcomeUnknown).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith("Your card was declined.");
      expect(screen.getByRole("alert").textContent).toBe(
        "Your card was declined.",
      );
      expect(lastReport(onSubmittingChange)).toBe(false);
    },
  );

  it.each<[string, () => Promise<unknown>]>([
    ["cannot be reached", () => Promise.reject(new TypeError("offline"))],
    ["answers with no PaymentIntent", () => Promise.resolve({ error: {} })],
  ])(
    "Stripe %s → never 'payment failed': the outcome is reported unknown and the buyer is told to check their email",
    async (_label, retrieve) => {
      stripeJs.retrieve = retrieve;
      const { onSubmittingChange, onSuccess, onError, onOutcomeUnknown } =
        renderForm();

      await pay();
      await confirmAnswers({ error: { message: "Network error." } });

      // The confirm itself has ended: no charge of ours is still on its way.
      expect(onOutcomeUnknown.mock.calls).toEqual([["settled"]]);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(UNKNOWN_OUTCOME);
      expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_OUTCOME);
      // Freed all the same: a locked form helps nobody.
      expect(lastReport(onSubmittingChange)).toBe(false);
      // Reported: a buyer who may have paid and was not told so.
      expect(stripeJs.traced).toContain("embed.confirmOutcomeUnknown");
      // An answer with nothing in it is reported like no answer.
      expect(stripeJs.traced).toContain("embed.paymentStatusUnreadable");
    },
  );

  it("a decline Stripe settles is not reported as an unknown outcome", async () => {
    renderForm();

    await pay();
    await confirmAnswers({ error: { message: "Network error." } });

    expect(screen.getByRole("alert").textContent).toBe("Network error.");
    expect(stripeJs.traced).not.toContain("embed.confirmOutcomeUnknown");
  });
});

describe("EmbedPaymentForm — a reservation that ran out", () => {
  it("payDisabled: the Pay button is disabled and nothing is confirmed", async () => {
    renderForm({ payDisabled: true });

    const payButton = screen.getByRole("button", { name: /^Pay / });
    expect((payButton as HTMLButtonElement).disabled).toBe(true);

    await click("wallet pay");

    expect(stripeJs.confirmCalls).toBe(0);
    // The sheet is not opened at all.
    expect(stripeJs.walletClicks).toEqual(["rejected"]);

    await click("wallet confirms unasked");
    expect(stripeJs.confirmCalls).toBe(0);
  });

  it("Stripe says the PaymentIntent is canceled → the order is reported expired, and Stripe's message about it is not shown", async () => {
    retrieveAnswers({ paymentIntent: { status: "canceled" } });
    const { onOrderExpired, onError, onOutcomeUnknown, onSuccess } =
      renderForm();

    await pay();
    await confirmAnswers({
      error: {
        type: "invalid_request_error",
        message:
          "This PaymentIntent's status is canceled and cannot be confirmed.",
      },
    });

    expect(onOrderExpired).toHaveBeenCalledTimes(1);
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).not.toContain(
      "PaymentIntent",
    );
  });
});

describe("EmbedPaymentForm — one confirm per click, one completion per order", () => {
  const form = () => screen.getByTestId("payment-element").closest("form")!;

  it("two submits in one tick send one confirm (the button is not disabled until the next render)", async () => {
    renderForm();

    await act(async () => {
      fireEvent.submit(form());
      fireEvent.submit(form());
      await settle();
    });

    expect(stripeJs.confirmCalls).toBe(1);
  });

  it("no wallet sheet over a card confirm in flight, and a sheet that confirms unasked sends nothing", async () => {
    renderForm();

    await pay();
    expect(stripeJs.confirmCalls).toBe(1);

    await click("wallet pay");
    expect(stripeJs.walletClicks).toEqual(["rejected"]);

    await click("wallet confirms unasked");
    expect(stripeJs.confirmCalls).toBe(1);
  });

  it("a wallet sheet that confirms after the form is gone sends nothing", async () => {
    const { unmount } = renderForm();
    const lateConfirm = stripeJs.walletConfirm;
    unmount();

    await act(async () => {
      lateConfirm?.({});
      await settle();
    });

    expect(stripeJs.confirmCalls).toBe(0);
  });

  it("the guard lets go when the confirm ends: the next attempt goes through", async () => {
    renderForm();

    await pay();
    await confirmAnswers({
      error: { type: "card_error", message: "Your card was declined." },
    });
    await pay();

    expect(stripeJs.confirmCalls).toBe(2);
    await click("wallet pay");
    // In flight again.
    expect(stripeJs.walletClicks).toEqual(["rejected"]);
  });

  it("a paid order takes no further confirm", async () => {
    const { onSuccess } = renderForm();

    await pay();
    await confirmAnswers({ paymentIntent: { status: "succeeded" } });
    await act(async () => {
      fireEvent.submit(form());
      await settle();
    });
    await click("wallet pay");
    await click("wallet confirms unasked");

    expect(stripeJs.confirmCalls).toBe(1);
    expect(stripeJs.walletClicks).toEqual(["rejected"]);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("EmbedPaymentForm — a confirm that never answers", () => {
  const form = () => screen.getByTestId("payment-element").closest("form")!;
  const wait = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const submit = () =>
    act(async () => {
      fireEvent.submit(form());
      await vi.advanceTimersByTimeAsync(0);
    });
  const lateAnswer = (result: ConfirmResult) =>
    act(async () => {
      stripeJs.pending?.resolve(result);
      await vi.advanceTimersByTimeAsync(0);
    });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is left alone until the watchdog's time, then Stripe is asked; unpaid and still unanswered is 'unknown', never 'failed', and the form is freed", async () => {
    const { onSubmittingChange, onOutcomeUnknown, onError, onSuccess } =
      renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS - 1);
    expect(stripeJs.retrieveCalls).toEqual([]);
    expect(lastReport(onSubmittingChange)).toBe(true);

    await wait(1);

    expect(stripeJs.retrieveCalls).toEqual(["pi_1_secret_x"]);
    // "requires_payment_method" now does not mean the confirm will not land,
    // and the widget is told the confirm is still out.
    expect(onOutcomeUnknown.mock.calls).toEqual([["still-out"]]);
    expect(onError).toHaveBeenCalledWith(UNKNOWN_OUTCOME);
    expect(screen.getByRole("alert").textContent).toBe(UNKNOWN_OUTCOME);
    expect(onSuccess).not.toHaveBeenCalled();
    // Pay and the checkout's Back are no longer held.
    expect(lastReport(onSubmittingChange)).toBe(false);
    expect(stripeJs.traced).toContain("embed.confirmOutcomeUnknown");
  });

  it("a buyer with their bank (requires_action) is waited on, and checked again after the same time", async () => {
    retrieveAnswers({ paymentIntent: { status: "requires_action" } });
    const { onSubmittingChange, onOutcomeUnknown, onSuccess } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    expect(stripeJs.retrieveCalls).toHaveLength(1);
    expect(lastReport(onSubmittingChange)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();

    await wait(CONFIRM_WATCHDOG_MS);
    expect(stripeJs.retrieveCalls).toHaveLength(2);
    expect(lastReport(onSubmittingChange)).toBe(true);
    expect(onOutcomeUnknown).not.toHaveBeenCalled();

    await lateAnswer({ paymentIntent: { status: "succeeded" } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("Stripe says it was paid → the purchase completes, once, even when the confirm then answers 'paid' too", async () => {
    retrieveAnswers({ paymentIntent: { status: "succeeded" } });
    const { onSuccess, onOutcomeUnknown } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onOutcomeUnknown).not.toHaveBeenCalled();

    await lateAnswer({ paymentIntent: { status: "succeeded" } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("after 'unknown', a confirm that lands paid moves the buyer on", async () => {
    const { onSuccess, onOutcomeUnknown } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    expect(onOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();

    await lateAnswer({ paymentIntent: { status: "succeeded" } });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("D1: after 'still out', the confirm ending unpaid is reported, so Stripe's 'nothing was charged' can be believed from then on", async () => {
    const { onSuccess, onOutcomeUnknown } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    await lateAnswer({
      error: { type: "card_error", message: "Your card was declined." },
    });

    expect(onOutcomeUnknown.mock.calls).toEqual([
      ["still-out"],
      ["late-settled"],
    ]);
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("D1: the confirm ending unpaid is reported with the form gone too (the buyer went back and came again to the same order)", async () => {
    const { onOutcomeUnknown, unmount } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    unmount();
    await lateAnswer({
      error: { type: "card_error", message: "Your card was declined." },
    });

    expect(onOutcomeUnknown.mock.calls).toEqual([
      ["still-out"],
      ["late-settled"],
    ]);
  });

  it("D1: a confirm that lands paid is never reported as ended unpaid", async () => {
    const { onOutcomeUnknown } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    await lateAnswer({ paymentIntent: { status: "succeeded" } });

    expect(onOutcomeUnknown.mock.calls).toEqual([["still-out"]]);
  });

  it("D1: nothing was reported still out (Stripe said canceled) → nothing is reported settled later", async () => {
    retrieveAnswers({ paymentIntent: { status: "canceled" } });
    const { onOutcomeUnknown, onOrderExpired } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    await lateAnswer({
      error: { type: "invalid_request_error", message: "Canceled." },
    });

    expect(onOrderExpired).toHaveBeenCalledTimes(1);
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("a form that is gone reports nothing: 'paid' from its order must not complete the page's next one", async () => {
    const { onSuccess, unmount } = renderForm();

    await submit();
    await wait(CONFIRM_WATCHDOG_MS);
    unmount();
    await lateAnswer({ paymentIntent: { status: "succeeded" } });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("a confirm that answers in time is never second-guessed", async () => {
    const { onSubmittingChange } = renderForm();

    await submit();
    await lateAnswer({
      error: { type: "card_error", message: "Your card was declined." },
    });
    await wait(CONFIRM_WATCHDOG_MS * 2);

    expect(stripeJs.retrieveCalls).toEqual([]);
    expect(screen.getByRole("alert").textContent).toBe(
      "Your card was declined.",
    );
    expect(lastReport(onSubmittingChange)).toBe(false);
  });
});

describe("EmbedPaymentForm — paid per Stripe, the order not yet confirmed by the server", () => {
  it("a payment still clearing with the bank is reported as 'processing', not as 'succeeded'", async () => {
    const { onSuccess } = renderForm();
    await pay();
    await confirmAnswers({ paymentIntent: { status: "processing" } });
    expect(onSuccess).toHaveBeenCalledWith("processing");
  });

  it("a confirm that rejected but Stripe says succeeded reports the status Stripe was read with", async () => {
    retrieveAnswers({ paymentIntent: { status: "succeeded" } });
    const { onSuccess } = renderForm();
    await click("wallet pay");
    await confirmRejects(new TypeError("Failed to fetch"));
    expect(onSuccess).toHaveBeenCalledWith("succeeded");
  });

  it("while the server is asked: the button says the ORDER is being confirmed and takes no press", async () => {
    const { onSuccess } = renderForm({ confirmingOrder: true });

    const button = screen.getByRole("button", {
      name: /Confirming your order/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /^Pay / })).toBeNull();
    expect(screen.queryByRole("button", { name: /Processing/ })).toBeNull();

    // A wallet sheet does not open over it either.
    await click("wallet pay");
    expect(stripeJs.retrieveCalls).toEqual([]);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("EmbedPaymentForm — before a confirm that can send the buyer away and back", () => {
  it("onBeforeConfirm runs once per confirm, card or wallet, and not for a form the field check stopped", async () => {
    const onBeforeConfirm = vi.fn();
    renderForm({ onBeforeConfirm });
    expect(onBeforeConfirm).not.toHaveBeenCalled();

    await pay();
    expect(onBeforeConfirm).toHaveBeenCalledTimes(1);
    await confirmAnswers({ error: { type: "card_error", message: "Declined." } });

    await click("wallet pay");
    expect(onBeforeConfirm).toHaveBeenCalledTimes(2);
  });
});
