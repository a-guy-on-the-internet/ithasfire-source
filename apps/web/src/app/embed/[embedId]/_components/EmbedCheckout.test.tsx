import { useEffect, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/messages/en";

/**
 * EmbedCheckout, rendered, with tRPC and Stripe mocked: what it does with an
 * order. EmbedCheckout.wiring.test.ts reads the same file as text and can
 * only say a prop is passed; these drive the component.
 *
 *  - The order is stamped with the cart, the key and the event that were
 *    SENT, whatever the props are when the answer lands.
 *  - Back is locked while the order is being created, and is let go when the
 *    request ends or goes unanswered for too long.
 *  - A request that goes unanswered keeps the checkout key.
 *  - Each order gets its own Elements and payment form.
 */

type Created = {
  orderId: string;
  clientSecret: string | null;
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  processorFeeCents: number;
  feeMode: "ABSORB" | "PASS_THROUGH";
  taxAmountCents: number;
  holdExpiresAt: string | null;
  lineItems: [];
};

const api = vi.hoisted(() => ({
  /** Every createGuestCheckout input, in order. */
  sent: [] as Array<Record<string, unknown>>,
  /** The createGuestCheckout the server has not answered yet. */
  pending: null as null | {
    resolve: (result: unknown) => void;
    reject: (err: unknown) => void;
  },
  traced: [] as string[],
}));
/** The bot check: off (no site key) unless a test turns it on. */
const botCheck = vi.hoisted(() => ({
  siteKey: "",
  issued: 0,
  /** The bot check's "passed" callback, as the form last handed it over. */
  pass: null as null | ((token: string) => void),
}));
/**
 * The details form: a stand-in that shows what it was handed, or the REAL
 * one (its email and promo inputs are what a kept press has to lock).
 * `submitting` is the `isCreating` of every stand-in render, in order.
 */
const detailsForm = vi.hoisted(() => ({
  real: false,
  submitting: [] as boolean[],
}));
const stripeUi = vi.hoisted(() => ({
  /** The client secret of every Elements / payment form MOUNT, in order. */
  elementsMounts: [] as string[],
  formMounts: [] as string[],
}));

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      createGuestCheckout: {
        useMutation: () => ({
          mutateAsync: (input: Record<string, unknown>) => {
            api.sent.push(input);
            return new Promise((resolve, reject) => {
              api.pending = { resolve, reject };
            });
          },
        }),
      },
      getEventDetail: {
        useQuery: () => ({
          data: {
            event: { currency: "usd" },
            ticketTypes: [
              {
                id: "tt-ga",
                name: "General",
                priceCents: 2000,
                pricingMode: "FIXED",
                minimumCents: null,
                suggestedCents: null,
              },
              {
                id: "tt-seat",
                name: "Reserved",
                priceCents: 4500,
                pricingMode: "FIXED",
                minimumCents: null,
                suggestedCents: null,
              },
            ],
          },
        }),
      },
    },
    waivers: {
      getEventWaiver: { useQuery: () => ({ data: { waiver: null } }) },
    },
    events: {
      getCheckoutFeeRates: {
        useQuery: () => ({ data: undefined, refetch: () => undefined }),
      },
    },
    useUtils: () => ({
      embeds: {
        listAvailableSeats: {
          invalidate: () => Promise.resolve(),
          fetch: () => Promise.resolve({ seats: [] }),
        },
      },
    }),
  },
}));

// The translator reads the REAL app catalog for the embed's own keys.
vi.mock("@th/ui", () => ({
  // For the real details form.
  FormErrorBanner: ({ message }: { message: string | null }) =>
    message ? <div role="alert">{message}</div> : null,
  Spinner: () => <span data-testid="spinner" />,
  useTranslations:
    () => (key: string, vars?: Record<string, string | number>) => {
      const [block, name] = key.split(".");
      const value = (en as unknown as Record<string, Record<string, unknown>>)[
        block ?? ""
      ]?.[name ?? ""];
      return (typeof value === "string" ? value : key).replace(
        /\{(\w+)\}/g,
        (_match, arg: string) =>
          vars?.[arg] === undefined ? `{${arg}}` : String(vars[arg]),
      );
    },
  // Clock times pinned to en-US and UTC, whatever machine runs the test.
  useFormatters: () => ({
    dateTime: (value: string, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(
        new Date(value),
      ),
  }),
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => () => {
    api.traced.push(label);
  },
}));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: Error) => `formatted: ${err.message}`,
}));
vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => "https://host.example",
  EMBED_ORIGIN_BLOCKED_MESSAGE: "blocked",
}));
vi.mock("@/config/stripe", () => ({ getStripe: () => null }));
vi.mock("./embed-helpers", async (original) => {
  const real = await original<typeof import("./embed-helpers")>();
  return {
    ...real,
    // No bot check unless a test turns it on: the form is valid without a
    // token.
    get TURNSTILE_SITE_KEY() {
      return botCheck.siteKey;
    },
  };
});
vi.mock("./useIsFramed", () => ({ useIsFramed: () => true }));
vi.mock(
  "@/app/events/checkout/[...slug]/_components/CheckoutStepper",
  () => ({ CheckoutStepper: () => null }),
);
// The summary and the phone bar show what they were handed for the "time
// left to pay" row (they print it only when `countdown` is set).
vi.mock("./EmbedOrderSummarySidebar", () => ({
  EmbedOrderSummarySidebar: ({ countdown }: { countdown: string | null }) => (
    <output data-testid="summary-countdown">{countdown ?? "no row"}</output>
  ),
}));
vi.mock("./EmbedMobileCTABar", () => ({
  EmbedMobileCTABar: ({
    countdown,
    isPending,
  }: {
    countdown: string | null;
    isPending?: boolean;
  }) => (
    <>
      <output data-testid="bar-countdown">{countdown ?? "no row"}</output>
      <output data-testid="bar-pending">{String(Boolean(isPending))}</output>
    </>
  ),
}));

// What the REAL details form needs around it: the bot check answering as
// Turnstile's callbacks do, and nothing from the network.
vi.mock("@marsidev/react-turnstile", () => ({
  Turnstile: ({
    onSuccess,
    onError,
  }: {
    onSuccess: (token: string) => void;
    onError: () => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => {
          botCheck.issued += 1;
          onSuccess(`token-${botCheck.issued}`);
        }}
      >
        bot check passes
      </button>
      <button type="button" onClick={onError}>
        bot check fails
      </button>
    </>
  ),
}));
vi.mock(
  "@/app/events/checkout/[...slug]/_components/RefundDisclosure",
  () => ({ RefundDisclosure: () => null }),
);
vi.mock("@/lib/maps/geocoding", () => ({
  forwardGeocode: () => Promise.resolve([]),
}));

// The details form: its Continue button, and what the checkout hands it to
// print (the error, and the note that goes under it). `detailsForm.real`
// swaps in the real one.
type StandInFormProps = {
  handleCreateCheckout: () => void;
  checkoutError: string | null;
  checkoutErrorNote?: ReactNode;
  isCreating: boolean;
  submitAttempted: boolean;
  turnstileToken: string | null;
  onTurnstileSuccess: (token: string) => void;
  onTurnstileError: () => void;
};
vi.mock("./EmbedCheckoutFormSection", async (original) => {
  const { EmbedCheckoutFormSection: RealForm } =
    await original<typeof import("./EmbedCheckoutFormSection")>();
  const StandIn = ({
    handleCreateCheckout,
    checkoutError,
    checkoutErrorNote,
    isCreating,
    submitAttempted,
    turnstileToken,
    onTurnstileSuccess,
    onTurnstileError,
  }: StandInFormProps) => {
    detailsForm.submitting.push(isCreating);
    botCheck.pass = onTurnstileSuccess;
    return (
    <div data-testid="details-step">
      <button type="button" onClick={handleCreateCheckout}>
        continue to payment
      </button>
      {/* The bot check answering, as Turnstile's callbacks do. */}
      <button
        type="button"
        onClick={() => {
          botCheck.issued += 1;
          onTurnstileSuccess(`token-${botCheck.issued}`);
        }}
      >
        verification passes
      </button>
      <button type="button" onClick={onTurnstileError}>
        verification fails
      </button>
      <output data-testid="submit-attempted">{String(submitAttempted)}</output>
      <output data-testid="token">{turnstileToken ?? "none"}</output>
      <output data-testid="is-creating">{String(isCreating)}</output>
      <output data-testid="checkout-error">{checkoutError ?? ""}</output>
      <div data-testid="error-note">{checkoutErrorNote}</div>
    </div>
    );
  };
  return {
    EmbedCheckoutFormSection: (
      props: Parameters<typeof RealForm>[0],
    ) => (detailsForm.real ? <RealForm {...props} /> : <StandIn {...props} />),
  };
});

// Elements and the payment form record each MOUNT with its client secret:
// the real Elements reads its secret once, at mount.
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({
    options,
    children,
  }: {
    options: { clientSecret: string };
    children?: ReactNode;
  }) => {
    useEffect(() => {
      stripeUi.elementsMounts.push(options.clientSecret);
      // Mount only: that is the point.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div data-testid="elements">{children}</div>;
  },
}));
vi.mock("./EmbedPaymentForm", () => ({
  EmbedPaymentForm: ({
    clientSecret,
    payDisabled,
    onOrderExpired,
    onSuccess,
    onOutcomeUnknown,
  }: {
    clientSecret: string;
    payDisabled: boolean;
    onOrderExpired: () => void;
    onSuccess: () => void;
    onOutcomeUnknown?: (report: "settled" | "still-out" | "late-settled") => void;
  }) => {
    useEffect(() => {
      stripeUi.formMounts.push(clientSecret);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <div data-testid="payment-form">
        <output data-testid="form-secret">{clientSecret}</output>
        <output data-testid="pay-disabled">{String(payDisabled)}</output>
        <button type="button" onClick={onOrderExpired}>
          stripe says canceled
        </button>
        <button type="button" onClick={onSuccess}>
          paid
        </button>
        <button type="button" onClick={() => onOutcomeUnknown?.("still-out")}>
          confirm is still out
        </button>
      </div>
    );
  },
}));

import { EmbedCheckout } from "./EmbedCheckout";
import {
  embedReceiptSecretKey,
  forgetEmbedReceiptSecretsInMemory,
  heldEmbedReceiptSecret,
} from "./embed-receipt-secret";
import type {
  EmbedCheckoutProps,
  EmbedPaymentOrder,
} from "./embed-checkout-types";
import {
  CREATE_CHECKOUT_TIMEOUT_MS,
  VERIFICATION_WAIT_MS,
} from "./embed-request-timeouts";
import type { CartItem } from "./embed-types";

const TIMED_OUT = "This is taking longer than expected. Try again.";
const clock = (at: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(at));
const EARLIER_UNTIL = "2026-10-10T19:20:00.000Z";
const EARLIER = `Tickets from your earlier order usually go back on sale by ${clock("2026-10-10T18:50:00.000Z")} and can stay reserved until ${clock(EARLIER_UNTIL)}, so they may show as unavailable until then.`;

const CART_AB: CartItem[] = [
  { ticketTypeId: "tt-seat", qty: 2, seatIds: ["seat-a", "seat-b"] },
  { ticketTypeId: "tt-ga", qty: 1 },
];
const CART_CD: CartItem[] = [
  { ticketTypeId: "tt-seat", qty: 2, seatIds: ["seat-c", "seat-d"] },
];

/** What the checkout reported, in the order it reported it. */
let calls: Array<[string, ...unknown[]]>;
const called = (name: string) => calls.filter(([n]) => n === name);

const baseProps = (over: Partial<EmbedCheckoutProps> = {}): EmbedCheckoutProps => ({
  embedId: "embed-1",
  eventId: "event-1",
  cart: CART_AB,
  guestName: "Ada Buyer",
  guestEmail: " buyer@example.com ",
  onGuestNameChange: () => undefined,
  onGuestEmailChange: () => undefined,
  initialDraft: {
    billingLine1: "1 Main St",
    billingLine2: "",
    billingCity: "Minneapolis",
    billingState: "MN",
    billingPostalCode: "55401",
    billingCountry: "US",
    promoCodes: [],
    waiverAccepted: false,
    termsAccepted: true,
    refundPolicyAccepted: true,
  },
  clientKey: "key-1",
  paymentOrder: null,
  checkoutError: null,
  checkoutStep: "details",
  // Answers "this is now the page's order", as the widget does for an
  // order that lands while the buyer is still on the purchase it was for.
  onCheckoutCreated: (payload, paymentOrder, sentClientKey) => {
    calls.push(["created", payload, paymentOrder, sentClientKey]);
    return true;
  },
  onCheckoutError: (msg) => calls.push(["error", msg]),
  onCheckoutFailed: (error) => calls.push(["failed", error]),
  onCartUpdate: () => calls.push(["cartUpdate"]),
  onPaymentSuccess: (email) => calls.push(["success", email]),
  isPaying: false,
  onPayingChange: () => undefined,
  onPaymentOutcomeUnknown: (clientSecret, report) =>
    calls.push(["outcomeUnknown", clientSecret, report]),
  earlierReservedUntil: null,
  onPaymentOrderExpired: () => calls.push(["orderExpired"]),
  onBack: () => calls.push(["back"]),
  stepperStepId: "details",
  completedStepIds: ["tickets"],
  ...over,
});

const created = (over: Partial<Created> = {}): Created => ({
  orderId: "order-1",
  clientSecret: "pi_1_secret_x",
  amountGrossCents: 11000,
  feesPlatformCents: 100,
  buyerFeesCents: 100,
  processorFeeCents: 0,
  feeMode: "ABSORB",
  taxAmountCents: 0,
  holdExpiresAt: "2026-10-10T18:15:00.000Z",
  lineItems: [],
  ...over,
});

const orderOnScreen = (
  clientSecret: string,
  holdExpiresAt: string | null = null,
): EmbedPaymentOrder => ({
  clientSecret,
  clientKey: "key-1",
  eventId: "event-1",
  cart: CART_AB,
  orderFees: {
    amountGrossCents: 11000,
    feesPlatformCents: 100,
    buyerFeesCents: 100,
    processorFeeCents: 0,
    feeMode: "ABSORB",
    taxAmountCents: 0,
    holdExpiresAt,
  },
  lineItems: [],
});

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
const wait = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const press = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await vi.advanceTimersByTimeAsync(0);
  });
const serverAnswers = (result: Created) =>
  act(async () => {
    api.pending?.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
  });
const serverRefuses = (err: unknown) =>
  act(async () => {
    api.pending?.reject(err);
    await vi.advanceTimersByTimeAsync(0);
  });
const back = () => screen.getByRole("button", { name: "Back" });
const out = (testId: string) => screen.getByTestId(testId).textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T18:00:00.000Z"));
  calls = [];
  api.sent.length = 0;
  api.pending = null;
  api.traced.length = 0;
  stripeUi.elementsMounts.length = 0;
  stripeUi.formMounts.length = 0;
  botCheck.siteKey = "";
  botCheck.issued = 0;
  botCheck.pass = null;
  detailsForm.real = false;
  detailsForm.submitting.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("EmbedCheckout — the order is stamped with what was sent", () => {
  it("the cart, key and event the request went out with, even when the page has others by the time it is answered", async () => {
    const { rerender } = render(<EmbedCheckout {...baseProps()} />);
    await flush();

    await press("continue to payment");
    // The widget moved on while the request was out.
    rerender(
      <EmbedCheckout
        {...baseProps({
          cart: CART_CD,
          clientKey: "key-2",
          eventId: "event-2",
        })}
      />,
    );
    await serverAnswers(created());

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({
      embedId: "embed-1",
      eventId: "event-1",
      clientKey: "key-1",
      guestEmail: "buyer@example.com",
      // In the fixed order `embedCheckoutItems` sends (by ticket type), not
      // the cart's.
      items: [
        { ticketTypeId: "tt-ga", qty: 1 },
        { ticketTypeId: "tt-seat", qty: 2, seatIds: ["seat-a", "seat-b"] },
      ],
    });
    const [[, payload, paymentOrder]] = called("created") as [
      [string, { orderId: string }, EmbedPaymentOrder],
    ];
    expect(payload.orderId).toBe("order-1");
    expect(paymentOrder.clientKey).toBe("key-1");
    expect(paymentOrder.eventId).toBe("event-1");
    expect(paymentOrder.cart).toBe(CART_AB);
    expect(paymentOrder.clientSecret).toBe("pi_1_secret_x");
    expect(paymentOrder.orderFees.holdExpiresAt).toBe(
      "2026-10-10T18:15:00.000Z",
    );
    // A paid order waits for its payment: nothing is "successful" yet.
    expect(called("success")).toEqual([]);
  });

  it("a free order (no PaymentIntent) is handed over with no payment order, then completes on the spot", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();

    await press("continue to payment");
    await serverAnswers(created({ clientSecret: null, amountGrossCents: 0 }));

    expect(calls.map(([name]) => name)).toEqual([
      "error", // the start clears the last error
      "created",
      "success",
    ]);
    const [[, , paymentOrder, sentClientKey]] = called("created");
    expect(paymentOrder).toBeNull();
    // A free order carries no payment order to read its key from: the key
    // it was sent under is handed over beside it.
    expect(sentClientKey).toBe("key-1");
    expect(called("success")).toEqual([["success", "buyer@example.com"]]);
  });

  it("a free order's tickets ride its create answer to the widget; a paid order's never do (they come with the server's 'confirmed')", async () => {
    const tickets = [
      { code: "TCK-FREE-1", ticketTypeName: "General Admission", seatLabel: null },
    ];
    const view = render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers({
      ...created({ clientSecret: null, amountGrossCents: 0 }),
      tickets,
    } as Created);
    const [[, freePayload]] = called("created");
    expect((freePayload as { tickets?: unknown }).tickets).toEqual(tickets);
    view.unmount();
    calls.length = 0;

    // An API that sends no such field (older than this web build): none.
    const older = render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers(created({ clientSecret: null, amountGrossCents: 0 }));
    const [[, olderPayload]] = called("created");
    expect((olderPayload as { tickets?: unknown }).tickets).toEqual([]);
    older.unmount();
    calls.length = 0;

    // A paid order is not confirmed at create: whatever the answer carries.
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers({ ...created(), tickets } as Created);
    const [[, paidPayload]] = called("created");
    expect(paidPayload as object).not.toHaveProperty("tickets");
  });

  it("a free order the widget leaves behind (the buyer has moved on) is not completed on the page", async () => {
    render(
      <EmbedCheckout
        {...baseProps({
          onCheckoutCreated: (payload, paymentOrder, sentClientKey) => {
            calls.push(["created", payload, paymentOrder, sentClientKey]);
            return false;
          },
        })}
      />,
    );
    await flush();

    await press("continue to payment");
    await serverAnswers(created({ clientSecret: null, amountGrossCents: 0 }));

    expect(called("created")).toHaveLength(1);
    expect(called("success")).toEqual([]);
  });
});

// The receipt secret (owner ruling 2026-10-12): the paid order's ticket
// codes go only to the tab that started the payment. That tab keeps the
// secret from the create answer, before the payment step can send the buyer
// away to a redirect payment method.
describe("EmbedCheckout — the receipt secret is kept as the order lands", () => {
  // Fake fixture, not a real secret.
  const RECEIPT = "FakeReceiptSecretFixture_NotReal-0123456789A";

  beforeEach(() => {
    window.sessionStorage.clear();
    forgetEmbedReceiptSecretsInMemory();
  });

  it("a paid order: kept in this tab (sessionStorage, keyed by embed and PaymentIntent) BEFORE the order is handed to the payment step", async () => {
    let heldWhenHandedOver: string | null | undefined;
    render(
      <EmbedCheckout
        {...baseProps({
          onCheckoutCreated: (payload, paymentOrder, sentClientKey) => {
            heldWhenHandedOver = heldEmbedReceiptSecret(
              "embed-1",
              "pi_1_secret_x",
            );
            calls.push(["created", payload, paymentOrder, sentClientKey]);
            return true;
          },
        })}
      />,
    );
    await flush();
    await press("continue to payment");
    await serverAnswers({ ...created(), receiptSecret: RECEIPT } as Created);

    expect(heldWhenHandedOver).toBe(RECEIPT);
    expect(
      window.sessionStorage.getItem(embedReceiptSecretKey("embed-1", "pi_1")),
    ).toContain(RECEIPT);
    // Never beside the client secret in storage, never in localStorage.
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(
      "pi_1_secret_x",
    );
    expect(window.localStorage.length).toBe(0);
    // Not handed to the widget either: the widget reads it from the store.
    expect(JSON.stringify(called("created"))).not.toContain(RECEIPT);
  });

  it("a free order, and an API that sends none, keep nothing", async () => {
    const free = render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers({
      ...created({ clientSecret: null, amountGrossCents: 0 }),
      receiptSecret: null,
    } as Created);
    free.unmount();

    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers(created());

    expect(heldEmbedReceiptSecret("embed-1", "pi_1_secret_x")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("storage that throws does not break the create: the order is handed over and the secret is held in memory", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    try {
      render(<EmbedCheckout {...baseProps()} />);
      await flush();
      await press("continue to payment");
      await serverAnswers({ ...created(), receiptSecret: RECEIPT } as Created);

      expect(called("created")).toHaveLength(1);
      expect(heldEmbedReceiptSecret("embed-1", "pi_1_secret_x")).toBe(RECEIPT);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("EmbedCheckout — Back while the order is being created", () => {
  it("is locked from Continue until the server answers, then goes back", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    fireEvent.click(back());
    expect(called("back")).toHaveLength(1);

    await press("continue to payment");
    expect(out("is-creating")).toBe("true");
    fireEvent.click(back());
    expect(called("back")).toHaveLength(1);
    expect(back().getAttribute("aria-disabled")).toBe("true");
    // A second Continue while the first is out sends nothing.
    await press("continue to payment");
    expect(api.sent).toHaveLength(1);

    await serverAnswers(created());

    expect(out("is-creating")).toBe("false");
    fireEvent.click(back());
    expect(called("back")).toHaveLength(2);
  });

  it("a refusal: the raw error goes to the widget (its key rotation) BEFORE the message, and Back is freed", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    const refusal = Object.assign(new Error("seat_unavailable"), {
      data: { appCode: "CONFLICT" },
    });

    await press("continue to payment");
    await serverRefuses(refusal);

    expect(calls).toEqual([
      ["error", ""],
      ["failed", refusal],
      ["error", "formatted: seat_unavailable"],
    ]);
    expect(out("is-creating")).toBe("false");
    fireEvent.click(back());
    expect(called("back")).toHaveLength(1);
  });
});

describe("EmbedCheckout — a create that goes unanswered", () => {
  it("after the timeout: the button and Back are freed, the buyer is told, and the key is KEPT (the widget is not told the attempt failed)", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();

    await press("continue to payment");
    await wait(CREATE_CHECKOUT_TIMEOUT_MS - 1);
    expect(out("is-creating")).toBe("true");
    expect(called("error")).toEqual([["error", ""]]);

    await wait(1);

    expect(out("is-creating")).toBe("false");
    expect(called("error")).toEqual([
      ["error", ""],
      ["error", TIMED_OUT],
    ]);
    // `onCheckoutFailed` is what rotates the widget's key.
    expect(called("failed")).toEqual([]);
    fireEvent.click(back());
    expect(called("back")).toHaveLength(1);
    // Reported: a buyer left waiting is otherwise invisible.
    expect(api.traced).toEqual(["embed.checkoutCreateTimedOut"]);
  });

  it("the retry goes out under the same key", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();

    await press("continue to payment");
    await wait(CREATE_CHECKOUT_TIMEOUT_MS);
    await press("continue to payment");

    expect(api.sent.map((input) => input.clientKey)).toEqual([
      "key-1",
      "key-1",
    ]);
  });

  it("an order that lands after the timeout is still handed over, stamped with what was sent", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await wait(CREATE_CHECKOUT_TIMEOUT_MS);
    expect(called("created")).toEqual([]);

    await serverAnswers(created());

    const [[, , paymentOrder]] = called("created") as [
      [string, unknown, EmbedPaymentOrder],
    ];
    expect(paymentOrder.clientKey).toBe("key-1");
    expect(paymentOrder.cart).toBe(CART_AB);
  });

  it("a refusal that lands after the timeout changes nothing: no second message, and the key is not rotated under a retry", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await wait(CREATE_CHECKOUT_TIMEOUT_MS);
    const before = calls.length;

    await serverRefuses(new Error("seat_unavailable"));

    expect(calls).toHaveLength(before);
    expect(api.traced).toEqual([
      "embed.checkoutCreateTimedOut",
      "embed.lateCheckoutRefused",
    ]);
  });

  it("an answer inside the time is not followed by a timeout", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    await serverAnswers(created());

    await wait(CREATE_CHECKOUT_TIMEOUT_MS * 2);

    expect(called("error")).toEqual([["error", ""]]);
    expect(api.traced).toEqual([]);
  });
});

describe("EmbedCheckout — the payment step", () => {
  it("each order mounts its own Elements and payment form (Elements reads its client secret once)", async () => {
    const { rerender } = render(
      <EmbedCheckout
        {...baseProps({ paymentOrder: orderOnScreen("pi_1_secret_x") })}
      />,
    );
    await flush();
    expect(out("form-secret")).toBe("pi_1_secret_x");

    // The same order again (a re-render): nothing remounts.
    rerender(
      <EmbedCheckout
        {...baseProps({ paymentOrder: orderOnScreen("pi_1_secret_x") })}
      />,
    );
    await flush();
    expect(stripeUi.elementsMounts).toEqual(["pi_1_secret_x"]);

    rerender(
      <EmbedCheckout
        {...baseProps({ paymentOrder: orderOnScreen("pi_2_secret_y") })}
      />,
    );
    await flush();

    expect(stripeUi.elementsMounts).toEqual(["pi_1_secret_x", "pi_2_secret_y"]);
    expect(stripeUi.formMounts).toEqual(["pi_1_secret_x", "pi_2_secret_y"]);
    expect(out("form-secret")).toBe("pi_2_secret_y");
  });

  it("Pay is disabled by the order's own countdown, from the real clock", async () => {
    render(
      <EmbedCheckout
        {...baseProps({
          paymentOrder: orderOnScreen(
            "pi_1_secret_x",
            "2026-10-10T18:00:02.000Z",
          ),
        })}
      />,
    );
    await flush();
    expect(out("pay-disabled")).toBe("false");

    await wait(1000);
    expect(out("pay-disabled")).toBe("false");

    await wait(1500);
    expect(out("pay-disabled")).toBe("true");
  });

  it("the 'time left to pay' row counts down, and is not printed once the time has run out (the widget says what happened to the order)", async () => {
    render(
      <EmbedCheckout
        {...baseProps({
          paymentOrder: orderOnScreen(
            "pi_1_secret_x",
            "2026-10-10T18:00:02.000Z",
          ),
        })}
      />,
    );
    await flush();
    expect(out("summary-countdown")).not.toBe("no row");

    await wait(2500);

    expect(out("pay-disabled")).toBe("true");
    expect(out("summary-countdown")).toBe("no row");
  });

  it("an unknown payment outcome reaches the widget with the order it is about", async () => {
    render(
      <EmbedCheckout
        {...baseProps({ paymentOrder: orderOnScreen("pi_1_secret_x") })}
      />,
    );
    await flush();

    await press("confirm is still out");

    expect(called("outcomeUnknown")).toEqual([
      ["outcomeUnknown", "pi_1_secret_x", "still-out"],
    ]);
  });

  it("the details form is gone, the header holds room for its 'payment is processing' line, and Stripe's 'canceled' reaches the widget", async () => {
    render(
      <EmbedCheckout
        {...baseProps({ paymentOrder: orderOnScreen("pi_1_secret_x") })}
      />,
    );
    await flush();

    expect(screen.queryByTestId("details-step")).toBeNull();
    expect(
      document.getElementById("embed-checkout-back-locked")?.style.minHeight,
    ).toBe("34px");

    await press("stripe says canceled");
    expect(called("orderExpired")).toHaveLength(1);

    await press("paid");
    expect(called("success")).toEqual([["success", "buyer@example.com"]]);
  });
});

describe("EmbedCheckout — Continue pressed before the bot check has its token", () => {
  // The check starts over each time the details form comes up (first visit,
  // back from the tickets, an order that ran out of time), and takes a
  // moment. A Continue pressed in that moment used to do nothing at all.
  beforeEach(() => {
    botCheck.siteKey = "site-key";
  });

  it("F2 regression: the press is kept: the button shows as working, nothing is sent, and the order is asked for when the token arrives", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();

    await press("continue to payment");

    expect(api.sent).toHaveLength(0);
    // Submitting, from the press: what locks the email and the promo input.
    expect(out("is-creating")).toBe("true");
    // Nothing is wrong with the form, so nothing is marked as wrong.
    expect(out("submit-attempted")).toBe("false");
    // No request is out: Back is not locked.
    expect(back().getAttribute("aria-disabled")).not.toBe("true");

    await press("verification passes");

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.turnstileToken).toBe("token-1");
    expect(out("is-creating")).toBe("true");
  });

  it("no token in time → the button is given back and the verification is pointed at; a token after that sends nothing by itself", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");

    await wait(VERIFICATION_WAIT_MS - 1);
    expect(out("is-creating")).toBe("true");
    await wait(1);

    expect(out("is-creating")).toBe("false");
    expect(out("submit-attempted")).toBe("true");

    await press("verification passes");
    expect(api.sent).toHaveLength(0);
    // The buyer's own press does.
    await press("continue to payment");
    expect(api.sent).toHaveLength(1);
  });

  it("the check fails while waiting → the wait ends there", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");

    await press("verification fails");

    expect(out("is-creating")).toBe("false");
    expect(out("submit-attempted")).toBe("true");
    expect(api.sent).toHaveLength(0);
  });

  it("a form with something missing is not waited on: its errors show, as before", async () => {
    render(<EmbedCheckout {...baseProps({ guestName: "" })} />);
    await flush();

    await press("continue to payment");

    expect(out("is-creating")).toBe("false");
    expect(out("submit-attempted")).toBe("true");
    expect(api.sent).toHaveLength(0);
  });

  it("with the token already there, Continue goes straight out", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("verification passes");

    await press("continue to payment");

    expect(api.sent).toHaveLength(1);
  });

  it("a token is spent by the order it made: the next Continue waits for its own instead of sending the old one", async () => {
    // The widget leaves this order behind (the buyer had moved on), so the
    // details form stays up.
    render(
      <EmbedCheckout
        {...baseProps({
          onCheckoutCreated: () => false,
        })}
      />,
    );
    await flush();
    await press("verification passes");
    await press("continue to payment");
    await serverAnswers(created());
    expect(out("token")).toBe("none");

    await press("continue to payment");

    expect(api.sent).toHaveLength(1);
    expect(out("is-creating")).toBe("true");
    await press("verification passes");
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]?.turnstileToken).toBe("token-2");
  });
});

describe("EmbedCheckout — a kept press goes out with what the form held AT THE PRESS", () => {
  // The order is made from what the form holds when the token arrives. So
  // the email and the promo input lock at the press, as they do while the
  // order is being created: the buyer cannot be halfway through a change
  // when the request goes out. These drive the REAL details form.
  const email = () => screen.getByLabelText("Email address") as HTMLInputElement;
  const promo = () => screen.getByLabelText("Promo code") as HTMLInputElement;
  const applyPromo = () =>
    screen.getByRole("button", { name: /apply/i }) as HTMLButtonElement;
  const pressContinue = () =>
    act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Continue to payment/ }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      fireEvent.change(input, { target: { value } });
      await vi.advanceTimersByTimeAsync(0);
    });
  /** The checkout with the email held above it, as the widget holds it. */
  function CheckoutHoldingTheEmail({ initialEmail }: { initialEmail: string }) {
    const [guestEmail, setGuestEmail] = useState(initialEmail);
    return (
      <EmbedCheckout
        {...baseProps({ guestEmail, onGuestEmailChange: setGuestEmail })}
      />
    );
  }

  beforeEach(() => {
    botCheck.siteKey = "site-key";
    detailsForm.real = true;
  });

  it("BLOCKING regression (email): a retype during the wait does not get in: one create, with the email as it was at the press", async () => {
    render(<CheckoutHoldingTheEmail initialEmail="jane@gmial.com" />);
    await flush();
    await pressContinue();
    expect(screen.getByRole("button", { name: /Processing/ })).toBeTruthy();
    expect(api.sent).toHaveLength(0);

    // The buyer sees the typo and is halfway through putting it right.
    expect(email().readOnly).toBe(true);
    await type(email(), "jane@gmail.co");
    expect(email().value).toBe("jane@gmial.com");

    await press("bot check passes");
    await flush();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.guestEmail).toBe("jane@gmial.com");
    // Still locked: the order is being created.
    expect(email().readOnly).toBe(true);
  });

  it("BLOCKING regression (promo): the promo input is disabled during the wait, so nothing typed there is left half-applied when the order goes out", async () => {
    render(<CheckoutHoldingTheEmail initialEmail="jane@gmail.com" />);
    await flush();
    expect(promo().disabled).toBe(false);
    await pressContinue();

    expect(promo().disabled).toBe(true);
    expect(applyPromo().disabled).toBe(true);
    // Whatever reaches the field anyway cannot be applied.
    await type(promo(), "HALF10");
    fireEvent.click(applyPromo());

    await press("bot check passes");
    await flush();

    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).not.toHaveProperty("promoCodes");
    expect(promo().disabled).toBe(true);
  });

  it("a code applied BEFORE the press goes out with the order, and cannot be taken off during the wait", async () => {
    render(<CheckoutHoldingTheEmail initialEmail="jane@gmail.com" />);
    await flush();
    await type(promo(), "SPRING10");
    await act(async () => {
      fireEvent.click(applyPromo());
    });
    expect(screen.getByRole("button", { name: "Remove SPRING10" })).toBeTruthy();
    await pressContinue();

    expect(screen.queryByRole("button", { name: "Remove SPRING10" })).toBeNull();
    expect(screen.getByText("SPRING10")).toBeTruthy();
    await press("bot check passes");

    expect(api.sent[0]?.promoCodes).toEqual(["SPRING10"]);
  });

  it("the name is not locked during the wait (it is not in the checkout key)", async () => {
    const onGuestNameChange = vi.fn();
    render(<EmbedCheckout {...baseProps({ onGuestNameChange })} />);
    await flush();
    await pressContinue();

    await type(
      screen.getByLabelText("Full name") as HTMLInputElement,
      "Ada B",
    );

    expect(onGuestNameChange).toHaveBeenCalledWith("Ada B");
  });

  it("no token in time → the email and the promo input unlock, beside the alert, and an edit goes into the next press", async () => {
    render(<CheckoutHoldingTheEmail initialEmail="jane@gmial.com" />);
    await flush();
    await pressContinue();
    expect(email().readOnly).toBe(true);
    expect(promo().disabled).toBe(true);

    await wait(VERIFICATION_WAIT_MS);

    expect(email().readOnly).toBe(false);
    expect(promo().disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe(
      "Complete the verification to continue",
    );
    await type(email(), "jane@gmail.com");
    expect(email().value).toBe("jane@gmail.com");
    await press("bot check passes");
    expect(api.sent).toHaveLength(0);
    await pressContinue();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.guestEmail).toBe("jane@gmail.com");
  });

  it("the bot check fails during the wait → the email and the promo input unlock, beside the alert", async () => {
    render(<CheckoutHoldingTheEmail initialEmail="jane@gmial.com" />);
    await flush();
    await pressContinue();
    expect(email().readOnly).toBe(true);

    await press("bot check fails");

    expect(email().readOnly).toBe(false);
    expect(promo().disabled).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe(
      "Complete the verification to continue",
    );
    expect(api.sent).toHaveLength(0);
  });
});

describe("EmbedCheckout — one 'submitting' from the press to the answer, and Back during the wait", () => {
  beforeEach(() => {
    botCheck.siteKey = "site-key";
  });

  it("the form is never handed 'not submitting' between the press and the server's answer: no open moment as the token arrives", async () => {
    render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    const fromThePress = detailsForm.submitting.length - 1;
    expect(detailsForm.submitting[fromThePress]).toBe(true);

    // The token arrives, and everything that follows from it is committed
    // before any timer runs: a create put off to a later tick would show as
    // a render with the form open.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "verification passes" }),
      );
    });
    expect(api.sent).toHaveLength(1);
    await flush();

    // Every render of the form since the press, the token's included.
    expect(detailsForm.submitting.slice(fromThePress)).not.toContain(false);
    expect(detailsForm.submitting.length).toBeGreaterThan(fromThePress + 1);
  });

  it("Back is usable during the wait, and going back drops the kept press: a token that arrives afterwards sends nothing", async () => {
    const { unmount } = render(<EmbedCheckout {...baseProps()} />);
    await flush();
    await press("continue to payment");
    expect(out("is-creating")).toBe("true");

    expect(back().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(back());
    expect(called("back")).toHaveLength(1);
    // What the widget does with that Back: the checkout leaves the page
    // (EmbedWidget.test.tsx pins it).
    const pass = botCheck.pass;
    unmount();
    await act(async () => {
      pass?.("token-late");
      await vi.advanceTimersByTimeAsync(VERIFICATION_WAIT_MS * 2);
    });

    expect(api.sent).toHaveLength(0);
  });
});

describe("EmbedCheckout — an earlier order's tickets, beside a refused checkout", () => {
  it("hands the details form the sentence to print under its error while that reservation lasts, and nothing otherwise", async () => {
    const { rerender } = render(
      <EmbedCheckout {...baseProps({ earlierReservedUntil: EARLIER_UNTIL })} />,
    );
    await flush();
    expect(out("error-note")).toBe(EARLIER);

    rerender(<EmbedCheckout {...baseProps({ earlierReservedUntil: null })} />);
    await flush();
    expect(out("error-note")).toBe("");
  });
});

describe("EmbedCheckout — Continue while an order the buyer left is still being released", () => {
  // The old order's tickets are the ones the new checkout wants: asked for
  // before the release has landed, it can be refused by them.
  it("the order is not asked for until the release has settled; the button shows as working and Back is locked meanwhile", async () => {
    let released: () => void = () => undefined;
    const waitForReleases = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    );
    render(<EmbedCheckout {...baseProps({ waitForReleases })} />);
    await flush();

    await press("continue to payment");

    expect(waitForReleases).toHaveBeenCalledTimes(1);
    expect(api.sent).toHaveLength(0);
    expect(out("is-creating")).toBe("true");
    expect(back().getAttribute("aria-disabled")).toBe("true");
    // A second Continue during the wait neither waits again nor sends.
    await press("continue to payment");
    expect(waitForReleases).toHaveBeenCalledTimes(1);

    await act(async () => {
      released();
      await vi.advanceTimersByTimeAsync(0);
    });

    // One order, under the key and cart of the press.
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]).toMatchObject({ clientKey: "key-1" });
    await serverAnswers(created());
    expect(called("created")).toHaveLength(1);
    expect(out("is-creating")).toBe("false");
  });

  it("with no release out, the order is asked for at once", async () => {
    const waitForReleases = vi.fn(() => Promise.resolve());
    render(<EmbedCheckout {...baseProps({ waitForReleases })} />);
    await flush();

    await press("continue to payment");

    expect(api.sent).toHaveLength(1);
  });

  it("a wait that fails is no reason not to ask for the order", async () => {
    const waitForReleases = vi.fn(() => Promise.reject(new Error("no")));
    render(<EmbedCheckout {...baseProps({ waitForReleases })} />);
    await flush();

    await press("continue to payment");

    expect(api.sent).toHaveLength(1);
  });
});
