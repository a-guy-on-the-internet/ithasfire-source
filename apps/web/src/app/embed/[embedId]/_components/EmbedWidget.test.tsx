import React, { useEffect, useReducer, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/i18n/messages/en";

/** A `checkout.*` string as the catalog has it; throws on a key it lacks. */
const checkoutCopy = (key: string): string => {
  const value = (en as unknown as Record<string, Record<string, unknown>>)
    .checkout?.[key];
  if (typeof value !== "string") throw new Error(`no checkout.${key} in en.ts`);
  return value;
};

/**
 * EmbedWidget — view resolution, the lazy second query, and the browse-state
 * machine around them (FR-003 / FR-004 / NFR-002).
 *
 * This is the diff's riskiest logic and it has already shipped one bug (a
 * one-frame error-screen flash when the second query's observer mounts), so
 * the query layer is faked rather than mocked flat: `useFakeQuery` models the
 * two behaviours that matter and NOTHING else.
 *
 *  1. A fetch is counted on every disabled→enabled TRANSITION. That is the
 *     pessimistic model (it is what react-query does whenever the cached data
 *     is stale, and always if the observer unmounts), so a component that
 *     lets `enabled` flap back and forth fails these tests even though the
 *     real client's 60s staleTime would have hidden it in a short test run.
 *     Counting transitions is the whole point: it pins the one-way latch.
 *  2. A query stays PENDING (no data, no error) until the test settles it, so
 *     the frame where the second observer mounts is directly observable
 *     instead of being flushed away by act().
 *
 * The fake deliberately exposes no `isLoading`. The component derives loading
 * from "no data and no error" precisely because react-query reports a
 * freshly-enabled observer as pending-but-idle; if anyone reintroduces an
 * `isLoading` gate, it reads `undefined` here and these tests fail loudly.
 */

type QueryKey = "list" | "calendar";

type FakeQueryState = {
  fetchCount: number;
  data: unknown;
  error: unknown;
};

const queryState: Record<QueryKey, FakeQueryState> = {
  list: { fetchCount: 0, data: undefined, error: undefined },
  calendar: { fetchCount: 0, data: undefined, error: undefined },
};

const listeners = new Set<() => void>();

/** Resolve a pending query and re-render every subscriber. */
const settle = (key: QueryKey, payload: { data?: unknown; error?: unknown }) =>
  act(() => {
    queryState[key].data = payload.data;
    queryState[key].error = payload.error;
    listeners.forEach((notify) => notify());
  });

const useFakeQuery = (key: QueryKey, opts?: { enabled?: boolean }) => {
  const enabled = opts?.enabled !== false;
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const prevEnabled = React.useRef(false);

  useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    if (enabled && !prevEnabled.current) queryState[key].fetchCount += 1;
    prevEnabled.current = enabled;
  }, [enabled, key]);

  return {
    data: queryState[key].data,
    error: queryState[key].error,
    refetch: vi.fn(),
  };
};

vi.mock("@/trpc", () => ({
  trpc: {
    embeds: {
      getForWidget: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) =>
          useFakeQuery("list", opts),
      },
      getCalendarEvents: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) =>
          useFakeQuery("calendar", opts),
      },
      getPlatformPublicSettings: {
        useQuery: () => ({ data: undefined }),
      },
      // The server's word on a paid order. Each test says what it answers;
      // by default it confirms, at once.
      confirmGuestPayment: {
        useMutation: (options?: unknown) => {
          server.mutationOptions = options;
          return {
          mutateAsync: (input: {
            embedId: string;
            hostOrigin: string | null;
            clientSecret: string;
          }) => server.confirm(input),
          };
        },
      },
      // Giving back an order the buyer left. Each test says what the server
      // answers; by default the call fails in transit, so the order is not
      // released and the widget says what it said before it could ask.
      releaseGuestOrder: {
        useMutation: (options?: unknown) => {
          server.releaseOptions = options;
          return {
            mutateAsync: (input: {
              embedId: string;
              hostOrigin: string | null;
              clientSecret: string;
            }) => server.release(input),
          };
        },
      },
    },
  },
}));

/** One ticket as the server's "confirmed" answer carries it. */
type ServerTicket = {
  code: string;
  ticketTypeName: string | null;
  seatLabel: string | null;
};
type ServerAnswer =
  | { outcome: "confirmed"; orderId: string; tickets?: ServerTicket[] }
  | { outcome: "processing"; orderId: string }
  | { outcome: "not_paid"; orderId: string; paymentIntentStatus: string };
const server = vi.hoisted(() => ({
  confirm: vi.fn(),
  /** What the widget passed to `confirmGuestPayment.useMutation`. */
  mutationOptions: undefined as unknown,
  release: vi.fn(),
  /** What the widget passed to `releaseGuestOrder.useMutation`. */
  releaseOptions: undefined as unknown,
}));
type ReleaseAnswer = { outcome: "released" | "gone" | "kept"; orderId: string };
/** The release never reaches the server (the default). */
const releaseFailsInTransit = () =>
  server.release.mockImplementation(async (): Promise<ReleaseAnswer> => {
    throw new TypeError("Failed to fetch");
  });
const serverReleases = (outcome: ReleaseAnswer["outcome"] = "released") =>
  server.release.mockImplementation(
    async (): Promise<ReleaseAnswer> => ({ outcome, orderId: "order-left" }),
  );
/** The client secret of every release sent, in order. */
const releasedSecrets = () =>
  server.release.mock.calls.map(
    ([input]) => (input as { clientSecret: string }).clientSecret,
  );
/** What the widget computes as the host page's origin, per test. */
const hostOrigin = vi.hoisted(() => ({
  value: "https://host.example" as string | null,
}));
const serverConfirms = () =>
  server.confirm.mockImplementation(
    async (): Promise<ServerAnswer> => ({
      outcome: "confirmed",
      orderId: "order-on-the-server",
    }),
  );

const searchMock = vi.hoisted(() => ({ value: "" }));

type MockCartItem = {
  ticketTypeId: string;
  qty: number;
  seatIds?: string[];
  seatQuotes?: Array<{ seatId: string; unitPriceCents: number }>;
};
/** Controls for the EmbedCheckout mock's createGuestCheckout. */
const checkoutMock = vi.hoisted(() => ({
  /** How long a created order's tickets stay reserved; null = no expiry. */
  reservedForMs: null as number | null,
  /** Lands the answer of a create that was left in flight (the latest). */
  landPendingCreate: null as null | (() => void),
  /** Every create left in flight, in the order they were sent. */
  pendingCreates: [] as Array<() => void>,
  /** The server answers with a free order: no PaymentIntent. */
  free: false,
  /** The tickets a free order's create answer carries; null = no field. */
  freeTickets: null as null | Array<{
    code: string;
    ticketTypeName: string | null;
    seatLabel: string | null;
  }>,
  /**
   * Tells two orders apart that the server made for one and the same
   * request (it should replay the first; this is the case where it did not).
   */
  serial: null as string | null,
  /** The order the payment form last reported an unknown outcome for. */
  unknownSecret: null as string | null,
  /** How many waits for releases the checkout started, and how many ended. */
  releaseWaits: { started: 0, ended: 0 },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ embedId: "embed-1" }),
  useSearchParams: () => new URLSearchParams(searchMock.value),
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
}));

// The translator reads the REAL app catalog, so a key the widget asks for
// that the catalog lacks shows up as the raw key.
vi.mock("@th/ui", () => ({
  Spinner: () => <div data-testid="spinner" />,
  useTranslations:
    () => (key: string, values?: Record<string, string | number>) => {
      const [block, name] = key.split(".");
      const value = (en as unknown as Record<string, Record<string, unknown>>)[
        block ?? ""
      ]?.[name ?? ""];
      if (typeof value !== "string") return key;
      // A placeholder with no value given stays as written.
      return value.replace(/\{(\w+)\}/g, (match, param: string) =>
        values && param in values ? String(values[param]) : match,
      );
    },
}));

// The redirect return verifies its PaymentIntent with Stripe.js.
const stripeJs = vi.hoisted(() => ({
  retrievePaymentIntent: (async () => ({})) as (secret: string) => Promise<unknown>,
  /** Stripe.js failed to load (blocked, offline): getStripe() → null. */
  unavailable: true,
  /** Stripe.js still loading: getStripe() answers with this instead. */
  loading: null as null | Promise<unknown>,
}));
vi.mock("@/config/stripe", () => ({
  getStripe: () =>
    stripeJs.loading ??
    Promise.resolve(
      stripeJs.unavailable
        ? null
        : {
            retrievePaymentIntent: (secret: string) =>
              stripeJs.retrievePaymentIntent(secret),
          },
    ),
}));
const trace = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: (label: string) => () => {
    trace.labels.push(label);
  },
}));
vi.mock("@/config/site", () => ({ getSiteUrl: () => "https://ithasfire.com" }));
vi.mock("@/lib/embed-host-origin", () => ({
  getEmbedHostOrigin: () => hostOrigin.value,
  DEFAULT_SUPPORT_EMAIL: "support@ithasfire.com",
  EMBED_ORIGIN_BLOCKED_MESSAGE: "blocked",
}));

// One spy across renders, so a test can count what the host page was told.
const bridge = vi.hoisted(() => ({ emitOrderComplete: vi.fn() }));
vi.mock("./useEmbedBridge", () => ({
  useEmbedBridge: () => ({
    emitOrderComplete: bridge.emitOrderComplete,
    emitCartUpdate: vi.fn(),
  }),
}));
vi.mock("./useEmbedThemeOverrides", () => ({
  useEmbedThemeOverrides: () => ({}),
}));

vi.mock("./EmbedEventGrid", () => ({
  // Exposes the select affordance so a test can leave the browse screen —
  // that is the only way to check the switcher does NOT follow it there.
  EmbedEventGrid: ({
    onSelectEvent,
  }: {
    onSelectEvent: (event: { id: string }) => void;
  }) => (
    <div data-testid="grid">
      <button type="button" onClick={() => onSelectEvent({ id: "event-1" })}>
        open event
      </button>
      <button type="button" onClick={() => onSelectEvent({ id: "event-2" })}>
        open another event
      </button>
    </div>
  ),
}));
vi.mock("./EmbedCalendarBrowse", () => ({
  EmbedCalendarBrowse: () => <div data-testid="calendar" />,
}));
vi.mock("./EmbedEventDetail", () => ({
  // Exposes "continue" so a test can walk grid → detail → checkout, and the
  // ticket stepper's two cart edits.
  EmbedEventDetail: ({
    cart,
    onCartChange,
    onContinueToCheckout,
    onBack,
    onSelectDate,
  }: {
    cart: MockCartItem[];
    onCartChange: (cart: MockCartItem[]) => void;
    onContinueToCheckout: () => void;
    onBack: () => void;
    onSelectDate: (eventId: string) => void;
  }) => {
    const addTicket = (delta: number) => {
      const qty = (cart.find((c) => c.ticketTypeId === "tt-ga")?.qty ?? 0) + delta;
      onCartChange(qty > 0 ? [{ ticketTypeId: "tt-ga", qty }] : []);
    };
    // The seat picker's confirm: two seats of one reserved-seating type.
    const pickSeats = (seatIds: string[]) =>
      onCartChange([{ ticketTypeId: "tt-seat", qty: seatIds.length, seatIds }]);
    return (
      <div data-testid="event-detail">
        <button type="button" onClick={() => pickSeats(["seat-a", "seat-b"])}>
          pick seats A and B
        </button>
        <button type="button" onClick={() => pickSeats(["seat-c", "seat-d"])}>
          pick seats C and D
        </button>
        <button type="button" onClick={() => addTicket(1)}>
          add a ticket
        </button>
        <button type="button" onClick={() => addTicket(-1)}>
          remove a ticket
        </button>
        <button type="button" onClick={onContinueToCheckout}>
          continue to checkout
        </button>
        <button type="button" onClick={onBack}>
          back to the events
        </button>
        <button type="button" onClick={() => onSelectDate("event-1-next-week")}>
          another date
        </button>
        <button type="button" onClick={() => onSelectDate("event-1")}>
          the first date
        </button>
      </div>
    );
  },
}));
// The two notices render their inputs: which one shows is the widget's call,
// their copy is EmbedOrderNotice's (tested there).
vi.mock("./EmbedOrderNotice", () => ({
  // The control is the real one's contract: there only with `onLetGo`,
  // `aria-disabled` and deaf to a press while the release is out, and its
  // button handed to `letGoRef`. The widget moves focus on from that button
  // by comparing the ref with the focused element, so this mock is honest
  // only while the REAL notice attaches the ref to its button, and the real
  // order notice takes `noticeRef`: EmbedOrderNotice.test.tsx asserts both
  // ("hands the widget the button itself", "takes focus from a script").
  // Nothing here is read by the widget that the real components lack.
  EmbedReservedNotice: ({
    reservedUntil,
    onLetGo,
    lettingGo,
    letGoFailed,
    letGoRef,
  }: {
    reservedUntil: string | null;
    onLetGo?: () => void;
    lettingGo?: boolean;
    letGoFailed?: boolean;
    letGoRef?: React.Ref<HTMLButtonElement>;
  }) => (
    <>
      <output data-testid="reserved-notice">{reservedUntil ?? "no time"}</output>
      {onLetGo && (
        <>
          <button
            ref={letGoRef}
            type="button"
            aria-disabled={lettingGo || undefined}
            onClick={lettingGo ? undefined : onLetGo}
          >
            let these tickets go
          </button>
          {/* What the real control cannot do: press while it is busy. */}
          <button type="button" onClick={onLetGo}>
            let go, pressed again at once
          </button>
          <output data-testid="let-go-state">
            {lettingGo ? "letting go" : letGoFailed ? "not let go" : "idle"}
          </output>
        </>
      )}
    </>
  ),
  // Like the real one, renders nothing when there is nothing to say.
  EmbedOrderNotice: ({
    kind,
    mayHaveBeenCharged,
    earlierReservedUntil,
    earlierReleased,
    noticeRef,
  }: {
    kind: string | null;
    mayHaveBeenCharged: boolean;
    earlierReservedUntil: string | null;
    earlierReleased?: boolean;
    noticeRef?: React.Ref<HTMLOutputElement>;
  }) =>
    kind === null && earlierReservedUntil === null && !earlierReleased ? null : (
      <output data-testid="order-notice" ref={noticeRef} tabIndex={-1}>
        {[
          kind,
          mayHaveBeenCharged ? "(may have been charged)" : null,
          earlierReservedUntil !== null ? "(earlier order reserved)" : null,
          earlierReleased ? "(earlier order released)" : null,
        ]
          .filter(Boolean)
          .join(" ")}
      </output>
    ),
}));
vi.mock("./EmbedCheckout", () => ({
  // Exposes the in-page success callback (what a confirmed card payment or a
  // free order fires), so a test can complete a purchase without Stripe.
  // Also shows the clientKey it was handed and plays the two kinds of failed
  // createGuestCheckout, the way EmbedCheckout's catch reports them.
  //
  // "create the order" plays a successful createGuestCheckout the way
  // EmbedCheckout's success branch reports it: an order priced from the cart
  // it was handed, at $20 a ticket. The outputs show what the REAL checkout
  // would put on screen: the PaymentIntent its payment form confirms, and the
  // order figure its summary prints.
  EmbedCheckout: ({
    onPaymentSuccess,
    clientKey,
    onCheckoutFailed,
    onCheckoutError,
    cart,
    paymentOrder,
    onCheckoutCreated,
    onBack,
    stepperStepId,
    onCartUpdate,
    checkoutError,
    isPaying,
    onPayingChange,
    isConfirming,
    onPaymentOutcomeUnknown,
    eventId,
    earlierReservedUntil,
    onPaymentOrderExpired,
    waitForReleases,
    guestEmail,
    onGuestEmailChange,
    initialDraft,
    onDraftChange,
    loadedAsRedirectReturn,
  }: {
    loadedAsRedirectReturn?: boolean;
    eventId: string;
    earlierReservedUntil: string | null;
    onPaymentOrderExpired: () => void;
    waitForReleases?: () => Promise<void>;
    guestEmail: string;
    onGuestEmailChange: (email: string) => void;
    initialDraft?: { promoCodes: string[] };
    onDraftChange?: (draft: { promoCodes: string[] }) => void;
    onPaymentSuccess: (
      email: string,
      paid?: { clientSecret: string; status: "succeeded" | "processing" },
    ) => void;
    isConfirming?: boolean;
    clientKey: string;
    onCheckoutFailed: (error: unknown) => void;
    onCheckoutError: (msg: string) => void;
    cart: MockCartItem[];
    paymentOrder: {
      clientSecret: string;
      orderFees: { amountGrossCents: number };
    } | null;
    onCheckoutCreated: (
      payload: unknown,
      paymentOrder: unknown,
      sentClientKey: string,
    ) => boolean;
    onBack: () => void;
    stepperStepId: string;
    onCartUpdate?: (update: (cart: MockCartItem[]) => MockCartItem[]) => void;
    checkoutError: string | null;
    isPaying: boolean;
    onPayingChange: (paying: boolean) => void;
    onPaymentOutcomeUnknown: (
      clientSecret: string,
      report: "settled" | "still-out" | "late-settled",
    ) => void;
  }) => {
    const fail = (error: unknown, msg: string) => {
      onCheckoutFailed(error);
      onCheckoutError(msg);
    };
    // What the real checkout reports when its payment form hears "paid"
    // from Stripe: the order's client secret and the status Stripe gave.
    const stripeSaysPaid = (status: "succeeded" | "processing" = "succeeded") =>
      onPaymentSuccess(
        "buyer@example.com",
        paymentOrder
          ? { clientSecret: paymentOrder.clientSecret, status }
          : undefined,
      );
    // Like the real checkout: the promo codes live here, seeded from the
    // draft the page kept, and every change is reported up as the draft.
    const [promoCodes, setPromoCodes] = useState<string[]>(
      () => initialDraft?.promoCodes ?? [],
    );
    useEffect(() => {
      onDraftChange?.({ promoCodes });
    }, [promoCodes, onDraftChange]);
    // The order createGuestCheckout would answer with for the cart and key
    // THIS render was handed: what the real checkout pins before its await.
    const orderForThisRender = (): [unknown, unknown] => {
      const qty = cart.reduce((sum, item) => sum + item.qty, 0);
      const seats = cart.flatMap((item) => item.seatIds ?? []).join("+");
      const orderFees = {
        amountGrossCents: qty * 2000,
        feesPlatformCents: 0,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        feeMode: "ABSORB" as const,
        taxAmountCents: 0,
      };
      // The email and promo codes the request went out with show in the
      // PaymentIntent, so a test can tell whose order is on screen.
      const sentAs = [
        guestEmail ? `for_${guestEmail}` : null,
        promoCodes.length > 0 ? `with_${promoCodes.join("+")}` : null,
        checkoutMock.serial,
      ]
        .filter(Boolean)
        .map((part) => `_${String(part)}`)
        .join("");
      const paidSecret = `pi_for_${qty}${seats ? `_${seats}` : ""}${sentAs}_secret_${clientKey}`;
      if (checkoutMock.free) {
        return [
          {
            orderId: `free-order-for-${qty}`,
            clientSecret: null,
            currency: "usd",
            orderFees: { ...orderFees, amountGrossCents: 0 },
            lineItems: [],
            billingAddress: null,
            waiverAccepted: false,
            ...(checkoutMock.freeTickets
              ? { tickets: checkoutMock.freeTickets }
              : {}),
          },
          null,
        ];
      }
      const clientSecret = paidSecret;
      return [
        {
          orderId: `order-for-${qty}`,
          clientSecret,
          currency: "usd",
          orderFees,
          lineItems: [],
          billingAddress: null,
          waiverAccepted: false,
        },
        {
          clientSecret,
          clientKey,
          eventId,
          cart,
          orderFees: {
            ...orderFees,
            holdExpiresAt:
              checkoutMock.reservedForMs === null
                ? null
                : new Date(
                    Date.now() + checkoutMock.reservedForMs,
                  ).toISOString(),
          },
          lineItems: [],
        },
      ];
    };
    // What the real checkout does with an answer (`land`): hands the order
    // over under the key it was SENT with and, for a free order the widget
    // took as the page's, completes it on the spot. All from the closure of
    // the render that sent the request, however long ago that was.
    const land = ([payload, order]: [unknown, unknown]) => {
      const isThePagesOrder = onCheckoutCreated(payload, order, clientKey);
      if (order === null && isThePagesOrder) {
        onPaymentSuccess(guestEmail || "buyer@example.com");
      }
    };
    const createOrder = () => land(orderForThisRender());
    // A createGuestCheckout still in flight: its answer lands when the test
    // says so, from this render's closure, like the real async continuation.
    const startCreating = () => {
      const answer = orderForThisRender();
      const landIt = () => land(answer);
      checkoutMock.landPendingCreate = landIt;
      checkoutMock.pendingCreates.push(landIt);
    };
    return (
      <>
        <button type="button" onClick={createOrder}>
          create the order
        </button>
        <button type="button" onClick={startCreating}>
          start creating the order
        </button>
        {/* What the real checkout does first on Continue: wait for any
            release still out, then ask for the order (EmbedCheckout.test). */}
        <button
          type="button"
          onClick={() => {
            checkoutMock.releaseWaits.started += 1;
            void waitForReleases?.().then(() => {
              checkoutMock.releaseWaits.ended += 1;
            });
          }}
        >
          continue waits for releases
        </button>
        <button
          type="button"
          onClick={() => onGuestEmailChange("typo@example.com")}
        >
          email typed wrong
        </button>
        <button
          type="button"
          onClick={() => onGuestEmailChange("right@example.com")}
        >
          email put right
        </button>
        <button
          type="button"
          onClick={() => onGuestEmailChange(" right@example.com ")}
        >
          email retyped with spaces
        </button>
        <button type="button" onClick={() => setPromoCodes(["SAVE10"])}>
          apply a promo code
        </button>
        <button
          type="button"
          onClick={() => onCheckoutError("Your card was declined.")}
        >
          card declined
        </button>
        <button type="button" onClick={() => onPayingChange(true)}>
          confirm starts
        </button>
        <button type="button" onClick={() => onPayingChange(false)}>
          confirm ends unpaid
        </button>
        {/* A wallet confirm: the form reports it and, in the SAME tick,
            before any render, something else discards the order (here a
            cart update; in the product a timer for the reservation's end). */}
        <button
          type="button"
          onClick={() => {
            onPayingChange(true);
            onCartUpdate?.((current) =>
              current.map((item) => ({ ...item, qty: item.qty + 1 })),
            );
          }}
        >
          confirm starts and the order is left in the same tick
        </button>
        {/* What the real checkout reports from its payment form, for the
            order on screen. "late confirm ends unpaid" is the one report
            that can come for an order that has gone: the confirm it is about
            was sent before, and answers when it answers. */}
        <button
          type="button"
          onClick={() => {
            const secret = paymentOrder?.clientSecret ?? "none";
            checkoutMock.unknownSecret = secret;
            onPaymentOutcomeUnknown(secret, "settled");
          }}
        >
          outcome unknown
        </button>
        <button
          type="button"
          onClick={() => {
            const secret = paymentOrder?.clientSecret ?? "none";
            checkoutMock.unknownSecret = secret;
            onPaymentOutcomeUnknown(secret, "still-out");
          }}
        >
          confirm is still out
        </button>
        <button
          type="button"
          onClick={() =>
            onPaymentOutcomeUnknown(
              checkoutMock.unknownSecret ?? "none",
              "late-settled",
            )
          }
        >
          late confirm ends unpaid
        </button>
        <output data-testid="checkout-error">{checkoutError ?? ""}</output>
        <output data-testid="is-paying">{String(isPaying)}</output>
        <button type="button" onClick={onBack}>
          checkout back
        </button>
        {/* What the real checkout does after `seat_price_changed`: the same
            purchase at new prices. */}
        <button
          type="button"
          onClick={() =>
            onCartUpdate?.((current) =>
              current.map((item) => ({
                ...item,
                seatQuotes: (item.seatIds ?? []).map((seatId) => ({
                  seatId,
                  unitPriceCents: 7000,
                })),
              })),
            )
          }
        >
          re-quote the cart
        </button>
        {/* A cart update that changes WHAT is bought (the real re-quote
            never does; this is what the widget's rule is there for). */}
        <button
          type="button"
          onClick={() =>
            onCartUpdate?.((current) =>
              current.map((item) => ({
                ...item,
                qty: item.qty - 1,
                ...(item.seatIds ? { seatIds: item.seatIds.slice(1) } : {}),
              })),
            )
          }
        >
          the update drops a ticket
        </button>
        <button type="button" onClick={onPaymentOrderExpired}>
          stripe says canceled
        </button>
        <button
          type="button"
          onClick={() => {
            stripeSaysPaid();
            stripeSaysPaid();
          }}
        >
          paid is reported twice
        </button>
        <output data-testid="earlier-note">
          {String(earlierReservedUntil !== null)}
        </output>
        <output data-testid="payment-intent">
          {paymentOrder?.clientSecret ?? "none"}
        </output>
        <output data-testid="order-gross">
          {paymentOrder ? String(paymentOrder.orderFees.amountGrossCents) : "none"}
        </output>
        <output data-testid="checkout-step">{stepperStepId}</output>
        <output data-testid="cart-qty">
          {String(cart.reduce((sum, item) => sum + item.qty, 0))}
        </output>
        <button type="button" onClick={() => stripeSaysPaid()}>
          pay in page
        </button>
        <button type="button" onClick={() => stripeSaysPaid("processing")}>
          pay in page by bank
        </button>
        <output data-testid="is-confirming">{String(isConfirming ?? false)}</output>
        <output data-testid="client-key">{clientKey}</output>
        <output data-testid="loaded-as-redirect-return">
          {String(loadedAsRedirectReturn ?? false)}
        </output>
        <button
          type="button"
          onClick={() =>
            fail(
              Object.assign(new Error("INSUFFICIENT_CAPACITY"), {
                data: { appCode: "INSUFFICIENT_CAPACITY" },
              }),
              `failed ${Math.random()}`,
            )
          }
        >
          checkout fails
        </button>
        <button
          type="button"
          onClick={() =>
            fail(new TypeError("Failed to fetch"), `lost ${Math.random()}`)
          }
        >
          response lost
        </button>
        <button
          type="button"
          onClick={() =>
            fail(
              Object.assign(new Error("IDEMPOTENCY_LOCK_IN_PROGRESS"), {
                data: { appCode: "IDEMPOTENCY_LOCK_IN_PROGRESS" },
              }),
              `locked ${Math.random()}`,
            )
          }
        >
          checkout still running
        </button>
      </>
    );
  },
}));
vi.mock("./EmbedConfirmation", () => ({
  // Shows which order it was handed: the confirmation prints that order.
  EmbedConfirmation: ({
    checkout,
    onDone,
  }: {
    checkout: { orderId: string; tickets?: Array<{ code: string }> } | null;
    onDone: () => void;
  }) => (
    <>
      <div data-testid="confirmation">{checkout?.orderId ?? "no order"}</div>
      {/* The ticket codes it was handed: the real one draws these. */}
      <div data-testid="confirmation-tickets">
        {checkout?.tickets?.map((ticket) => ticket.code).join(",") || "none"}
      </div>
      <button type="button" onClick={onDone}>
        Done
      </button>
    </>
  ),
}));

// Records every render, so a screen that appears for a single frame and is
// gone by the time we assert still leaves evidence behind.
const errorRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./EmbedErrorScreen", () => ({
  EmbedErrorScreen: () => {
    errorRenders.count += 1;
    return <div data-testid="error-screen" />;
  },
}));

import { STRIPE_VERIFY_TIMEOUT_MS } from "@/lib/stripe-redirect-return";
import {
  PENDING_REDIRECT_NOTICE_MS,
  heldRedirectReturnKey,
  pendingRedirectKey,
} from "./useEmbedRedirectReturn";
import {
  EMBED_RECEIPT_SECRET_MS,
  embedReceiptSecretKey,
  forgetEmbedReceiptSecretsInMemory,
  rememberEmbedReceiptSecret,
} from "./embed-receipt-secret";
import { EmbedWidget } from "./EmbedWidget";

const ORG_EMBED = {
  id: "embed-1",
  subjectType: "organization",
  subjectId: "org-1",
  domain: "host.example",
  linkOut: false,
  defaultView: "list",
  viewToggle: true,
};

const listPayload = (embed: Partial<typeof ORG_EMBED> = {}) => ({
  embed: { ...ORG_EMBED, requireAuth: false, ...embed },
  owner: {
    kind: "organization",
    id: "org-1",
    name: "Dev QA Collective",
    slug: "dev-qa",
  },
  events: [],
});

const calendarPayload = (embed: Partial<typeof ORG_EMBED> = {}) => ({
  embed: { ...ORG_EMBED, ...embed },
  ownerName: "Dev QA Collective",
  events: [],
});

const toggle = (name: "List" | "Calendar") =>
  screen.getByRole("button", { name });

/**
 * Flipping the switcher sets state that a passive effect then reads (the
 * query latch), so the click needs its own act scope — without it the
 * effect's `setCalendarActivated` lands after userEvent's scope has closed.
 */
const flipTo = async (name: "List" | "Calendar") => {
  await act(async () => {
    await userEvent.click(toggle(name));
  });
};

beforeEach(() => {
  queryState.list = { fetchCount: 0, data: undefined, error: undefined };
  queryState.calendar = { fetchCount: 0, data: undefined, error: undefined };
  errorRenders.count = 0;
  searchMock.value = "";
  listeners.clear();
  stripeJs.unavailable = true;
  stripeJs.loading = null;
  stripeJs.retrievePaymentIntent = async () => ({});
  checkoutMock.reservedForMs = null;
  checkoutMock.landPendingCreate = null;
  checkoutMock.pendingCreates.length = 0;
  checkoutMock.free = false;
  checkoutMock.freeTickets = null;
  checkoutMock.serial = null;
  checkoutMock.unknownSecret = null;
  checkoutMock.releaseWaits = { started: 0, ended: 0 };
  bridge.emitOrderComplete.mockClear();
  server.confirm.mockReset();
  serverConfirms();
  server.release.mockReset();
  releaseFailsInTransit();
  hostOrigin.value = "https://host.example";
  trace.labels.length = 0;
  window.sessionStorage.clear();
  forgetEmbedReceiptSecretsInMemory();
  window.history.replaceState(null, "", "/embed/embed-1");
});

describe("EmbedWidget — initial load fires exactly one browse query", () => {
  it("bare URL with a list default: grid only, calendar never asked", () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });

    expect(screen.getByTestId("grid")).toBeInTheDocument();
    expect(queryState.list.fetchCount).toBe(1);
    expect(queryState.calendar.fetchCount).toBe(0);
  });

  it("bare URL with a SERVER-RESOLVED calendar default: calendar only", () => {
    // The point of resolving `defaultView` server-side (server/embeds.ts): the
    // bare URL shape already pasted across the internet must not fetch the
    // grid just to discover the row wants a calendar.
    render(<EmbedWidget initialDefaultView="calendar" />);
    settle("calendar", { data: calendarPayload({ defaultView: "calendar" }) });

    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(queryState.calendar.fetchCount).toBe(1);
    expect(queryState.list.fetchCount).toBe(0);
  });

  it("?view= outranks the stored default without a second query", () => {
    searchMock.value = "?view=calendar";
    render(<EmbedWidget initialDefaultView="list" />);
    settle("calendar", { data: calendarPayload() });

    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(queryState.list.fetchCount).toBe(0);
  });

  it("an unknown ?view= falls through to the stored default", () => {
    searchMock.value = "?view=map";
    render(<EmbedWidget initialDefaultView="calendar" />);
    settle("calendar", { data: calendarPayload({ defaultView: "calendar" }) });

    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(queryState.list.fetchCount).toBe(0);
  });

  it("degrades to the payload probe when the server lookup failed", () => {
    // initialDefaultView=null (SSR unavailable) → the grid query doubles as
    // the config probe, and a calendar row still lands on the calendar.
    render(<EmbedWidget />);
    expect(queryState.list.fetchCount).toBe(1);
    settle("list", { data: listPayload({ defaultView: "calendar" }) });

    expect(queryState.calendar.fetchCount).toBe(1);
    settle("calendar", { data: calendarPayload({ defaultView: "calendar" }) });
    expect(screen.getByTestId("calendar")).toBeInTheDocument();
  });
});

describe("EmbedWidget — viewer toggle (FR-004)", () => {
  it("fetches the second view once across repeated flips", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });

    await flipTo("Calendar");
    settle("calendar", { data: calendarPayload() });
    expect(screen.getByTestId("calendar")).toBeInTheDocument();

    await flipTo("List");
    expect(screen.getByTestId("grid")).toBeInTheDocument();

    await flipTo("Calendar");
    expect(screen.getByTestId("calendar")).toBeInTheDocument();

    // The one-way latch: neither observer is ever disabled again, so no flip
    // can re-issue either request.
    expect(queryState.calendar.fetchCount).toBe(1);
    expect(queryState.list.fetchCount).toBe(1);
  });

  it("shows the loading state — never the error screen — while the second view is in flight", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    expect(errorRenders.count).toBe(0);

    await flipTo("Calendar");

    // The calendar query is enabled but has neither data nor error. This is
    // the exact frame that used to render the error screen.
    expect(screen.getByTestId("spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("error-screen")).not.toBeInTheDocument();
    expect(errorRenders.count).toBe(0);

    settle("calendar", { data: calendarPayload() });
    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(errorRenders.count).toBe(0);
  });

  it("keeps the switcher mounted when the toggled-to view is rejected", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });

    await flipTo("Calendar");
    settle("calendar", { error: { data: { code: "FORBIDDEN" } } });

    // Fail closed on the DATA, but never trap the viewer: the switcher is
    // still there to go back with.
    expect(screen.getByTestId("error-screen")).toBeInTheDocument();
    expect(toggle("List")).toBeInTheDocument();

    await flipTo("List");
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("does not follow the viewer off the browse screen", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    expect(toggle("Calendar")).toBeInTheDocument();

    // Into the event detail screen — a browse-view switcher has no meaning
    // over a detail / checkout / confirmation screen.
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });

    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
  });

  it("renders no switcher when viewToggle is off", () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload({ viewToggle: false }) });

    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("renders no switcher for an event subject even when viewToggle is on", () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", {
      data: {
        ...listPayload({ subjectType: "event", viewToggle: true }),
        owner: undefined,
        events: undefined,
      },
    });

    expect(screen.queryByRole("button", { name: "Calendar" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The Stripe REDIRECT RETURN inside the embed. Embed buyers are guests, and
// the embed has no server confirm (the webhook finalizes), so Stripe.js is
// the only check: buying reopens ONLY on a PaymentIntent it verifies dead
// (`requires_payment_method` / `canceled`); anything else is a terminal
// screen with buying closed. Stripe's params leave the URL as soon as they
// are read, whatever the outcome (the client secret is the guest's proof of
// payment); the return is held in sessionStorage until it settles.
// `redirect_status` is a hint for the copy, never the verdict.
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_RETURN = (status: string, params = "payment_intent=pi_r&payment_intent_client_secret=pi_r_secret_x") =>
  `?${params}&redirect_status=${status}`;
/** The embed lands on a redirect return: the URL the hook reads AND the one useSearchParams serves. */
const landOn = (query: string) => {
  window.history.replaceState(null, "", `/embed/embed-1${query}`);
  searchMock.value = query;
};
const embedUrlHasRedirectParams = () =>
  /payment_intent|redirect_status/.test(window.location.search);
const UNVERIFIED = /We couldn.t confirm your payment\. Check your email for a confirmation before trying again\./;
const DECLINED = "Payment was declined. Please try a different payment method.";
/** Let the verification's promises run. */
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("EmbedWidget — a redirect return reopens buying only on a VERIFIED failure", () => {
  it("the FIRST render is already 'Confirming your payment…' (seeded from useSearchParams, as the server render sees it)", () => {
    stripeJs.loading = new Promise(() => {});
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    expect(screen.getByRole("status")).toHaveTextContent("Confirming your payment…");
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
  });

  it("BLOCKER regression: failed, but Stripe.js says requires_action (still live) → terminal, buying closed, no secret left on the URL", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_action" },
    });
    landOn(EMBED_RETURN("failed"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    expect(screen.queryByText(DECLINED)).not.toBeInTheDocument();
    // Buying closed: no browse grid, nothing to select.
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "open event" })).not.toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
  });

  it("requires_action with no failed hint → terminal too (never 'try again')", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_action" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    expect(screen.queryByText(/Additional verification is required/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
  });

  it("failed, and Stripe.js VERIFIES requires_payment_method → the declined copy, buying reopens, params stripped", async () => {
    stripeJs.unavailable = false;
    const retrieve = vi.fn(async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    }));
    stripeJs.retrievePaymentIntent = retrieve;
    landOn(EMBED_RETURN("failed"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(retrieve).toHaveBeenCalledWith("pi_r_secret_x");
    expect(screen.getByRole("alert")).toHaveTextContent(DECLINED);
    expect(screen.getByTestId("grid")).toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
    // The notice goes once the buyer moves on.
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });
    expect(screen.queryByText(DECLINED)).not.toBeInTheDocument();
  });

  it("canceled → the canceled copy, buying reopens", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "canceled" },
    });
    landOn(EMBED_RETURN("failed"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent("Payment was canceled. Please try again.");
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("succeeded → the REDIRECT confirmation (what Stripe said: received + the amount), never 'Tickets sent to' a blank; params stripped", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(
      screen.getByText("Your tickets are on their way to the email you used at checkout."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("embed-redirect-amount")).toHaveTextContent("$42.50");
    expect(screen.queryByText(/Tickets sent to/)).not.toBeInTheDocument();
    // The in-page confirmation (which needs the cart, email and order) is not used.
    expect(screen.queryByTestId("confirmation")).not.toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
    // Done goes back to browsing.
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("regression: a single-event embed whose data lands AFTER the verified payment keeps 'Payment received' (never the ticket picker); Done opens the event", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    // Stripe.js answers first; the embed's own data is still in flight.
    await flush();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    settle("list", {
      data: {
        ...listPayload({ subjectType: "event" }),
        owner: undefined,
        events: undefined,
        event: { id: "evt-single" },
      },
    });
    await flush();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(screen.queryByTestId("event-detail")).not.toBeInTheDocument();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
    });
    expect(screen.getByTestId("event-detail")).toBeInTheDocument();
  });

  it("processing → 'Payment submitted', we'll email once it clears; params stripped", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "processing", amount: 1000, currency: "usd" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    // Stripe.js said "processing", but the status shown is the SERVER's: it
    // finalized the order, so the payment is received.
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(screen.queryByText(/Tickets sent to/)).not.toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
  });

  it("the server says the payment is still clearing → 'Your bank is clearing this payment', tickets emailed when it clears; never 'Order confirmed' or 'Tickets sent'", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "processing", amount: 1000, currency: "usd" },
    });
    server.confirm.mockResolvedValue({ outcome: "processing", orderId: "order-r" });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(
      screen.getByRole("heading", { name: checkoutCopy("embedPaymentClearingTitle") }),
    ).toBeInTheDocument();
    expect(screen.getByText(checkoutCopy("embedPaymentClearingBody"))).toBeInTheDocument();
    expect(screen.queryByText(/Order confirmed|Tickets sent|Payment received/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("embed-redirect-amount")).toHaveTextContent("$10.00");
    expect(embedUrlHasRedirectParams()).toBe(false);
  });

  it("Stripe.js says paid → the server is asked with the return URL's client secret, and nothing is confirmed until it answers", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    let answer: (value: ServerAnswer) => void = () => undefined;
    server.confirm.mockImplementation(
      () =>
        new Promise<ServerAnswer>((resolve) => {
          answer = resolve;
        }),
    );
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(server.confirm).toHaveBeenCalledWith({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: "pi_r_secret_x",
    });
    expect(screen.getByRole("status")).toHaveTextContent("Confirming your payment…");
    expect(screen.queryByRole("heading", { name: "Payment received" })).not.toBeInTheDocument();
    // Off the URL before the server was asked; held for a reload meanwhile.
    expect(embedUrlHasRedirectParams()).toBe(false);
    expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toContain("pi_r_secret_x");

    await act(async () => {
      answer({ outcome: "confirmed", orderId: "order-r" });
    });
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
    expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toBeNull();
    // The redirect return tells the host page nothing: it has no ticket
    // subtotal to put in the event's `totalCents`.
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
  });

  describe("Stripe.js says paid and the server does not confirm", () => {
    // Fake timers: "Check again" rests for 5 s after every unconfirmed answer.
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const press = (name: string) =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
      });
    const REST = 5_000;
    const landPaid = async () => {
      stripeJs.unavailable = false;
      stripeJs.retrievePaymentIntent = async () => ({
        paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
      });
      landOn(EMBED_RETURN("succeeded"));
      const view = render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await tick(0);
      return view;
    };
    const notPaid: ServerAnswer = {
      outcome: "not_paid",
      orderId: "order-r",
      paymentIntentStatus: "requires_payment_method",
    };
    const checkAgain = () =>
      screen.getByRole("button", { name: checkoutCopy("embedCheckAgain") });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("the server says 'not paid' against Stripe.js → 'your payment went through, order not confirmed yet', buying closed, no secret on the URL; Check again asks once more", async () => {
      server.confirm.mockResolvedValue(notPaid);
      await landPaid();

      const title = screen.getByRole("heading", {
        name: checkoutCopy("embedPaidUnconfirmedTitle"),
      });
      // Focus is on the title, not lost to the page body.
      expect(document.activeElement).toBe(title);
      expect(screen.getByRole("alert")).toHaveTextContent(checkoutCopy("embedUnconfirmedBody"));
      expect(screen.getByRole("link", { name: "support@ithasfire.com" })).toHaveAttribute(
        "href",
        "mailto:support@ithasfire.com",
      );
      expect(screen.queryByText(/Payment received|Order confirmed|not been charged/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
      // The secret is gone from the URL. The held return stays in
      // sessionStorage, so an iframe reload asks the server again; the
      // marker reminds a load that has no held return left.
      expect(embedUrlHasRedirectParams()).toBe(false);
      expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toContain("pi_r_secret_x");
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).not.toBeNull();
      expect(server.confirm).toHaveBeenCalledTimes(1);

      // The button rests first: a press sends nothing.
      expect(checkAgain().getAttribute("aria-disabled")).toBe("true");
      await press(checkoutCopy("embedCheckAgain"));
      expect(server.confirm).toHaveBeenCalledTimes(1);
      await tick(REST);
      expect(checkAgain().getAttribute("aria-disabled")).toBeNull();

      // Still nothing: said, and the screen stays.
      await press(checkoutCopy("embedCheckAgain"));
      expect(server.confirm).toHaveBeenCalledTimes(2);
      expect(screen.getByText(checkoutCopy("embedStillUnconfirmed"))).toBeInTheDocument();
      expect(checkAgain().getAttribute("aria-disabled")).toBe("true");

      // The webhook finished the order meanwhile: the next check confirms.
      serverConfirms();
      await tick(REST);
      await press(checkoutCopy("embedCheckAgain"));
      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(embedUrlHasRedirectParams()).toBe(false);
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toBeNull();
      expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toBeNull();
    });

    it("an iframe reload on that screen asks the server again (never the notice beside an open widget), and reaches the order", async () => {
      server.confirm.mockResolvedValue(notPaid);
      const first = await landPaid();
      expect(server.confirm).toHaveBeenCalledTimes(1);
      first.unmount();

      // The reload: the iframe's URL is already clean, so nothing is seeded.
      landOn("");
      serverConfirms();
      render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await tick(0);

      expect(server.confirm).toHaveBeenCalledTimes(2);
      expect(server.confirm).toHaveBeenLastCalledWith(
        expect.objectContaining({ clientSecret: "pi_r_secret_x" }),
      );
      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toBeNull();
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toBeNull();
    });

    it("an iframe reload past the held return's 30 minutes asks nothing and shows the reminder", async () => {
      server.confirm.mockResolvedValue(notPaid);
      const first = await landPaid();
      first.unmount();
      // The held return was read before the marker was written; age it
      // past its window while the marker is still inside the notice's.
      const key = heldRedirectReturnKey("embed-1");
      const held = JSON.parse(window.sessionStorage.getItem(key)!) as { at: number };
      window.sessionStorage.setItem(key, JSON.stringify({ ...held, at: Date.now() - 31 * 60 * 1000 }));

      landOn("");
      render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await tick(0);

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(window.sessionStorage.getItem(key)).toBeNull();
      expect(screen.getByTestId("grid")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/Check your email/i);
    });

    it.each([
      ["the order can no longer be finalized", "CONFLICT", "ORDER_NOT_PROCESSABLE"],
      ["the secret is not this order's", "CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH"],
      ["the page may not host this embed", "FORBIDDEN", undefined],
      ["the embed is gone", "NOT_FOUND", "EMBED_NOT_FOUND"],
    ])(
      "a refusal asking again cannot change (%s) → no Check again; who to write to comes first; never 'your tickets will not come'",
      async (_what, code, appCode) => {
        server.confirm.mockRejectedValue(
          Object.assign(new Error(appCode ?? code), {
            data: { code, ...(appCode ? { appCode } : {}) },
          }),
        );
        await landPaid();
        await tick(REST);

        const said = screen.getByRole("alert").textContent ?? "";
        expect(said).toContain(checkoutCopy("embedPaidUnconfirmedTitle"));
        expect(said.indexOf(checkoutCopy("embedUnconfirmedContact"))).toBeGreaterThan(-1);
        expect(said.indexOf(checkoutCopy("embedUnconfirmedContact"))).toBeLessThan(
          said.indexOf(checkoutCopy("embedUnconfirmedBody")),
        );
        expect(screen.queryByRole("button", { name: checkoutCopy("embedCheckAgain") })).toBeNull();
        expect(screen.queryByText(/will not|won.t/i)).toBeNull();
        expect(server.confirm).toHaveBeenCalledTimes(1);
        expect(embedUrlHasRedirectParams()).toBe(false);
      },
    );

    it("Check again pressed twice sends one call; 'Checking…' is said in the status region while it is out", async () => {
      server.confirm.mockResolvedValue(notPaid);
      await landPaid();
      await tick(REST);
      server.confirm.mockImplementation(() => new Promise(() => undefined));

      await press(checkoutCopy("embedCheckAgain"));
      await press(checkoutCopy("embedCheckAgain"));

      expect(server.confirm).toHaveBeenCalledTimes(2);
      expect(checkAgain().getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("status").textContent).toBe(checkoutCopy("embedCheckingAgain"));
    });

    it("the widget is unmounted while a check is out → its answer sets nothing and confirms nothing", async () => {
      server.confirm.mockResolvedValue(notPaid);
      const view = await landPaid();
      await tick(REST);
      let answer: (value: ServerAnswer) => void = () => undefined;
      server.confirm.mockImplementation(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            answer = resolve;
          }),
      );
      await press(checkoutCopy("embedCheckAgain"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

      view.unmount();
      await act(async () => {
        answer({ outcome: "confirmed", orderId: "order-r" });
      });

      expect(errors).not.toHaveBeenCalled();
      errors.mockRestore();
      // Nothing was settled for a page that is gone: a reload is reminded.
      expect(embedUrlHasRedirectParams()).toBe(false);
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).not.toBeNull();
    });

    it("an answer that lands after the widget stopped waiting still confirms: the buyer moves on without pressing anything", async () => {
      const answers: Array<(value: ServerAnswer) => void> = [];
      server.confirm.mockImplementation(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            answers.push(resolve);
          }),
      );
      await landPaid();
      await tick(2 * 20_000);
      expect(screen.getByRole("heading", { name: checkoutCopy("embedPaidUnconfirmedTitle") })).toBeInTheDocument();

      await act(async () => {
        answers[1]?.({ outcome: "confirmed", orderId: "order-r" });
      });

      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(embedUrlHasRedirectParams()).toBe(false);
    });

    it.each([
      ["no origin at all", null],
      ["the payment page's origin (Firefox reads it from the referrer)", "https://pay.example"],
    ])(
      "R7: on the return the widget computes %s → the server is asked with the host origin saved before the payment",
      async (_what, computed) => {
        window.sessionStorage.setItem("hf:embed:host-origin:embed-1", "https://host.example");
        hostOrigin.value = computed;
        await landPaid();

        expect(server.confirm).toHaveBeenCalledWith({
          embedId: "embed-1",
          hostOrigin: "https://host.example",
          clientSecret: "pi_r_secret_x",
        });
      },
    );

    it("D4: the return confirmed → its marker goes, no 'still being confirmed' reminder is left, and the saved host origin is removed", async () => {
      window.sessionStorage.setItem(
        pendingRedirectKey("embed-1"),
        JSON.stringify({ paymentIntentId: "pi_r", at: Date.now() }),
      );
      window.sessionStorage.setItem("hf:embed:host-origin:embed-1", "https://host.example");
      await landPaid();

      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(
        screen.queryByText(
          "You may have a payment still being confirmed. Check your email before buying again.",
        ),
      ).toBeNull();
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toBeNull();
      expect(window.sessionStorage.getItem("hf:embed:host-origin:embed-1")).toBeNull();
    });

    it("D4: Check again on the return confirms → its marker goes with the screen", async () => {
      server.confirm.mockResolvedValueOnce(notPaid);
      await landPaid();
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toContain("pi_r");
      await tick(REST);

      await act(async () => {
        fireEvent.click(checkAgain());
      });

      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(window.sessionStorage.getItem(pendingRedirectKey("embed-1"))).toBeNull();
    });

    it("R7: nothing saved (storage was blocked) → the computed origin, as before", async () => {
      hostOrigin.value = null;
      await landPaid();
      expect(server.confirm.mock.calls[0]?.[0]).toMatchObject({ hostOrigin: null });
    });
  });

  it("succeeded with no amount from Stripe → no amount row (never a blank figure)", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    await flush();
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(screen.queryByTestId("embed-redirect-amount")).not.toBeInTheDocument();
  });

  it("StrictMode's dev double-mount retrieves once and confirms once", async () => {
    stripeJs.unavailable = false;
    const retrieve = vi.fn(async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 500, currency: "usd" },
    }));
    stripeJs.retrievePaymentIntent = retrieve;
    landOn(EMBED_RETURN("succeeded"));
    render(
      <React.StrictMode>
        <EmbedWidget initialDefaultView="list" />
      </React.StrictMode>,
    );
    await flush();
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("heading", { name: "Payment received" })).toHaveLength(1);
  });

  it.each(["failed", "succeeded"])("Stripe.js unavailable (hint %s) → terminal, buying closed, reported as embed.redirectVerifyStripeUnavailable (not the real-error key)", async (hint) => {
    stripeJs.unavailable = true;
    landOn(EMBED_RETURN(hint));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    expect(embedUrlHasRedirectParams()).toBe(false);
    expect(trace.labels).toContain("embed.redirectVerifyStripeUnavailable");
    expect(trace.labels).not.toContain("embed.redirectVerifyError");
  });

  it("Stripe.js never answers → terminal after the timeout, reported as embed.redirectVerifyTimeout", async () => {
    vi.useFakeTimers();
    try {
      stripeJs.loading = new Promise(() => {});
      landOn(EMBED_RETURN("failed"));
      render(<EmbedWidget initialDefaultView="list" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STRIPE_VERIFY_TIMEOUT_MS - 1);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Confirming your payment…");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
      expect(trace.labels).toContain("embed.redirectVerifyTimeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a reload from the terminal screen: the URL is clean, so it gets the reminder over an OPEN widget and is not re-verified", async () => {
    stripeJs.unavailable = false;
    const retrieve = vi.fn(async () => ({
      paymentIntent: { id: "pi_r", status: "requires_action" },
    }));
    stripeJs.retrievePaymentIntent = retrieve;
    landOn(EMBED_RETURN("failed"));
    const first = render(<EmbedWidget initialDefaultView="list" />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    first.unmount();

    // The reload: the URL the widget left, without Stripe's params. The
    // terminal screen let the held return go and left the pending marker.
    expect(embedUrlHasRedirectParams()).toBe(false);
    searchMock.value = window.location.search;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("You may have a payment still being confirmed. Check your email before buying again."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("a payment_intent with no client secret (nothing Stripe.js can retrieve) → terminal, not the steps", async () => {
    stripeJs.unavailable = false;
    landOn(EMBED_RETURN("failed", "payment_intent=pi_r"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
  });

  it("a load that resumes a held return (iframe-only reload mid-verify, URL already clean) counts as a redirect return for the checkout", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_payment_method" },
    });
    window.sessionStorage.setItem(
      heldRedirectReturnKey("embed-1"),
      JSON.stringify({
        clientSecret: "pi_r_secret_x",
        paymentIntentId: "pi_r",
        failedHint: true,
        at: Date.now(),
      }),
    );
    landOn("");
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    // The resumed return verified dead: buying reopens.
    expect(screen.getByRole("alert")).toHaveTextContent(DECLINED);
    expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toBeNull();
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "continue to checkout" }));
    });
    expect(screen.getByTestId("loaded-as-redirect-return")).toHaveTextContent("true");
  });

  it("a plain load (no params, nothing held) is not a redirect return for the checkout", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "continue to checkout" }));
    });
    expect(screen.getByTestId("loaded-as-redirect-return")).toHaveTextContent("false");
  });

  it("unmounted mid-verification → nothing reported; the URL is clean and the return is held for the next load", async () => {
    let resolveStripe!: (value: unknown) => void;
    stripeJs.loading = new Promise((resolve) => {
      resolveStripe = resolve;
    });
    landOn(EMBED_RETURN("failed"));
    const { unmount } = render(<EmbedWidget initialDefaultView="list" />);
    unmount();
    await act(async () => {
      resolveStripe({
        retrievePaymentIntent: async () => ({
          paymentIntent: { id: "pi_r", status: "requires_payment_method" },
        }),
      });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(embedUrlHasRedirectParams()).toBe(false);
    expect(window.sessionStorage.getItem(heldRedirectReturnKey("embed-1"))).toContain("pi_r_secret_x");
    expect(trace.labels).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A HOST-PAGE reload loads the iframe from its `src`, without Stripe's
// params, so the terminal screen cannot come back. A per-embed sessionStorage
// marker (the PaymentIntent id and a time, never the secret) remembers it,
// and a fresh load within 30 minutes shows a dismissible reminder that does
// NOT block buying.
// ─────────────────────────────────────────────────────────────────────────────

describe("EmbedWidget — a pending redirect payment survives a host-page reload as a reminder", () => {
  const KEY = pendingRedirectKey("embed-1");
  const REMINDER = "You may have a payment still being confirmed. Check your email before buying again.";
  /** The host page reloads: the iframe comes back from its src, no Stripe params. */
  const hostReload = () => {
    window.history.replaceState(null, "", "/embed/embed-1");
    searchMock.value = "";
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
  };
  const landOnTerminal = async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "requires_action" },
    });
    landOn(EMBED_RETURN("failed"));
    const view = render(<EmbedWidget initialDefaultView="list" />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    return view;
  };

  it("the terminal screen stores the PaymentIntent id and a time, NEVER the client secret", async () => {
    await landOnTerminal();
    const raw = window.sessionStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const marker = JSON.parse(raw!) as { paymentIntentId: unknown; at: unknown };
    expect(marker.paymentIntentId).toBe("pi_r");
    expect(typeof marker.at).toBe("number");
    expect(raw).not.toContain("secret");
  });

  it("a host reload within 30 minutes → the reminder above an OPEN widget; dismissing it clears the marker", async () => {
    const first = await landOnTerminal();
    first.unmount();
    hostReload();
    await flush();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();
    // Buying is not blocked.
    expect(screen.getByTestId("grid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "open event" })).toBeInTheDocument();

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "Dismiss payment notice" }));
    });
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("a marker older than 30 minutes → no reminder, and it is dropped", async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({ paymentIntentId: "pi_r", at: Date.now() - PENDING_REDIRECT_NOTICE_MS - 1 }),
    );
    hostReload();
    await flush();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("another embed's marker → no reminder here", async () => {
    window.sessionStorage.setItem(
      pendingRedirectKey("some-other-embed"),
      JSON.stringify({ paymentIntentId: "pi_r", at: Date.now() }),
    );
    hostReload();
    await flush();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it.each([
    ["succeeded", { id: "pi_r", status: "succeeded", amount: 100, currency: "usd" }],
    ["requires_payment_method", { id: "pi_r", status: "requires_payment_method" }],
  ])("a later VERIFIED outcome (%s) clears the marker", async (_label, paymentIntent) => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ paymentIntentId: "pi_r", at: Date.now() }));
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({ paymentIntent });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("an in-page purchase settles the reminder: the marker is cleared, and the next host reload shows none", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify({ paymentIntentId: "pi_r", at: Date.now() }));
    const view = render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();

    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "continue to checkout" }));
    });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "pay in page" }));
    });
    expect(screen.getByTestId("confirmation")).toBeInTheDocument();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();

    view.unmount();
    hostReload();
    await flush();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it("storage that throws never breaks the terminal screen", async () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    try {
      await landOnTerminal();
      expect(screen.queryByTestId("grid")).not.toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it("no client secret to verify → traced as embed.redirectUnverifiable", async () => {
    landOn(EMBED_RETURN("failed", "payment_intent=pi_r"));
    render(<EmbedWidget initialDefaultView="list" />);
    await flush();
    expect(screen.getByRole("alert")).toHaveTextContent(UNVERIFIED);
    expect(trace.labels).toContain("embed.redirectUnverifiable");
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!).paymentIntentId).toBe("pi_r");
  });
});

describe("EmbedWidget — the guest checkout key after a failed attempt", () => {
  // The server locks a key for up to 900 s; a request that died holding it
  // would refuse every retry under the same key until it lapsed.
  const openCheckout = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await act(async () => {
      await userEvent.click(screen.getByRole("button", { name: "open event" }));
    });
    await act(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "continue to checkout" }),
      );
    });
  };
  const key = () => screen.getByTestId("client-key").textContent;
  const click = (name: string) =>
    act(async () => {
      await userEvent.click(screen.getByRole("button", { name }));
    });

  it("a lost response keeps the key, so the retry replays what the server committed", async () => {
    await openCheckout();
    const first = key();

    await click("response lost");

    expect(key()).toBe(first);
  });

  it("a server refusal hands the next attempt a fresh key", async () => {
    await openCheckout();
    const first = key();
    expect(first).toBeTruthy();

    await click("checkout fails");

    expect(key()).not.toBe(first);
  });

  it("IDEMPOTENCY_LOCK_IN_PROGRESS keeps the key (the first attempt is still running)", async () => {
    await openCheckout();
    const first = key();

    await click("checkout still running");

    expect(key()).toBe(first);
  });
});

describe("EmbedWidget — the payment step charges the order the buyer is shown", () => {
  // The payment form confirms the order's PaymentIntent, while the summary
  // and the pay button print figures. Back to the tickets and forward again
  // must never pair one order's PaymentIntent with another cart's figures.
  const click = (name: string) =>
    act(async () => {
      await userEvent.click(screen.getByRole("button", { name }));
    });
  const out = (testId: string) => screen.getByTestId(testId).textContent;

  /** Grid → detail with one ticket → checkout → an order for that ticket. */
  const payForOneTicket = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("add a ticket");
    await click("continue to checkout");
    await click("create the order");
  };

  it("regression: Back from payment, two more tickets, Continue → no payment form for the one-ticket order; the next order is priced from three", async () => {
    await payForOneTicket();
    const firstKey = out("client-key");
    expect(out("payment-intent")).toBe(`pi_for_1_secret_${firstKey}`);
    expect(out("order-gross")).toBe("2000");
    await click("card declined");
    expect(out("checkout-error")).toBe("Your card was declined.");

    await click("checkout back");
    await click("add a ticket");
    await click("add a ticket");
    // Said at once, on the event detail, and again on the details step.
    expect(out("order-notice")).toBe("changed");
    await click("continue to checkout");

    // Before the fix the form came back for the one-ticket PaymentIntent
    // while the summary estimated three tickets.
    expect(out("cart-qty")).toBe("3");
    expect(out("payment-intent")).toBe("none");
    expect(out("order-gross")).toBe("none");
    expect(out("checkout-step")).toBe("details");
    expect(out("order-notice")).toBe("changed");
    // The old order's decline says nothing about this cart.
    expect(out("checkout-error")).toBe("");
    // A fresh key, so Continue creates an order for THIS cart instead of the
    // server replaying the old order (or refusing) under the old key.
    const secondKey = out("client-key");
    expect(secondKey).not.toBe(firstKey);

    await click("create the order");

    expect(out("payment-intent")).toBe(`pi_for_3_secret_${secondKey}`);
    expect(out("order-gross")).toBe("6000");
    // The new order is on screen: nothing left to explain.
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("Back and Continue with the SAME cart returns to the same order, its figures and its payment step", async () => {
    await payForOneTicket();
    const firstKey = out("client-key");
    const firstIntent = out("payment-intent");

    await click("checkout back");
    expect(screen.getByTestId("event-detail")).toBeTruthy();
    await click("continue to checkout");

    expect(out("payment-intent")).toBe(firstIntent);
    // The order's own figures, not the cart's estimate: EmbedCheckout
    // remounted, so they come from the widget.
    expect(out("order-gross")).toBe("2000");
    expect(out("checkout-step")).toBe("payment");
    expect(out("client-key")).toBe(firstKey);
  });

  it("the checkout's re-quote (new prices, the same purchase) keeps the order and the key", async () => {
    await payForOneTicket();
    const firstKey = out("client-key");
    const firstIntent = out("payment-intent");

    await click("re-quote the cart");

    expect(out("payment-intent")).toBe(firstIntent);
    expect(out("client-key")).toBe(firstKey);
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("a re-quote before any order exists keeps the key too: the retry it is for must replay, not start over", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("pick seats A and B");
    await click("continue to checkout");
    const firstKey = out("client-key");

    await click("re-quote the cart");

    expect(out("client-key")).toBe(firstKey);
  });

  it("a cart update from the checkout that changes the purchase follows the same rule as any cart change: order gone, new key, and the buyer is told", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("pick seats A and B");
    await click("continue to checkout");
    await click("create the order");
    const firstKey = out("client-key");
    expect(out("payment-intent")).not.toBe("none");

    await click("the update drops a ticket");

    expect(out("cart-qty")).toBe("1");
    expect(out("payment-intent")).toBe("none");
    expect(out("order-gross")).toBe("none");
    expect(out("client-key")).not.toBe(firstKey);
    expect(out("order-notice")).toBe("changed");
  });

  it("with no order yet, a cart update that changes the purchase still rotates the key (a kept key would replay the old seats)", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("pick seats A and B");
    await click("continue to checkout");
    await click("response lost");
    const firstKey = out("client-key");

    await click("the update drops a ticket");

    expect(out("client-key")).not.toBe(firstKey);
  });

  it("an order reported paid twice completes once: the host page hears of one sale", async () => {
    await payForOneTicket();

    await click("paid is reported twice");

    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("a cart changed and changed back still gets a fresh order: the first one went with the change", async () => {
    await payForOneTicket();
    const firstKey = out("client-key");

    await click("checkout back");
    await click("add a ticket");
    await click("remove a ticket");
    await click("continue to checkout");

    expect(out("cart-qty")).toBe("1");
    expect(out("payment-intent")).toBe("none");
    expect(out("client-key")).not.toBe(firstKey);
  });
});

describe("EmbedWidget — a different purchase never rides the old checkout key", () => {
  // The server's idempotency hash covers ticket types, quantities, PWYW
  // amounts and promo codes, NOT seat ids. Under a kept key a same-quantity
  // seat swap is answered with the OLD order (the old seats), which the
  // checkout would then show as this cart's. So the key follows the purchase.
  const click = (name: string) =>
    act(async () => {
      await userEvent.click(screen.getByRole("button", { name }));
    });
  const out = (testId: string) => screen.getByTestId(testId).textContent;

  /** Grid → detail with seats A and B → the checkout's details step. */
  const checkoutWithSeatsAB = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("pick seats A and B");
    await click("continue to checkout");
  };

  it("BLOCKER regression (lost response): the order's answer is lost, Back, two OTHER seats, Continue → a NEW key", async () => {
    await checkoutWithSeatsAB();
    const firstKey = out("client-key");

    // The server committed an order for A and B; the response never arrived.
    await click("response lost");
    expect(out("client-key")).toBe(firstKey);
    expect(out("payment-intent")).toBe("none");

    await click("checkout back");
    await click("pick seats C and D");
    await click("continue to checkout");

    const secondKey = out("client-key");
    expect(secondKey).not.toBe(firstKey);

    await click("create the order");
    expect(out("payment-intent")).toBe(
      `pi_for_2_seat-c+seat-d_secret_${secondKey}`,
    );
  });

  it("the SAME cart keeps its key after a lost response, so the retry replays the order the server committed", async () => {
    await checkoutWithSeatsAB();
    const firstKey = out("client-key");

    await click("response lost");
    await click("checkout back");
    // The picker confirmed again with the same two seats: not a change.
    await click("pick seats A and B");
    await click("continue to checkout");

    expect(out("client-key")).toBe(firstKey);
  });

  it("BLOCKER regression (late answer): an order that lands after the cart changed NEVER becomes live, even for its own seats again", async () => {
    await checkoutWithSeatsAB();
    const firstKey = out("client-key");

    // Continue is in flight; the buyer steps back and swaps seats before the
    // answer lands. (The real checkout also locks Back while creating.)
    await click("start creating the order");
    await click("checkout back");
    await click("pick seats C and D");
    await act(async () => {
      checkoutMock.landPendingCreate?.();
    });

    // Told why, on the event detail.
    expect(out("order-notice")).toBe("changed");
    await click("continue to checkout");
    expect(out("payment-intent")).toBe("none");
    expect(out("checkout-step")).toBe("details");
    expect(out("client-key")).not.toBe(firstKey);

    // Back to the very seats the late order was for: still no order. It was
    // dropped, not parked.
    await click("checkout back");
    await click("pick seats A and B");
    await click("continue to checkout");
    expect(out("payment-intent")).toBe("none");
    expect(out("client-key")).not.toBe(firstKey);
  });

  it("an order that lands after Back with the cart UNCHANGED is this cart's order", async () => {
    await checkoutWithSeatsAB();
    const firstKey = out("client-key");

    await click("start creating the order");
    await click("checkout back");
    await act(async () => {
      checkoutMock.landPendingCreate?.();
    });
    await click("continue to checkout");

    expect(out("payment-intent")).toBe(
      `pi_for_2_seat-a+seat-b_secret_${firstKey}`,
    );
    expect(out("checkout-step")).toBe("payment");
  });
});

describe("EmbedWidget — the order's reservation and what the buyer is told", () => {
  const click = (name: string) =>
    act(async () => {
      await userEvent.click(screen.getByRole("button", { name }));
    });
  const out = (testId: string) => screen.getByTestId(testId).textContent;

  // Fake timers for the reservation clock, so `fireEvent` (no timers of its
  // own) drives the clicks.
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const TEN_MINUTES = 10 * 60_000;
  const orderReservedForTenMinutes = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
  };

  it("back on the event detail with an order waiting: the tickets are shown as reserved, with the order's time", async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("add a ticket");
    await click("continue to checkout");
    await click("create the order");
    // The payment step has its own countdown.
    expect(screen.queryByTestId("reserved-notice")).toBeNull();

    await click("checkout back");

    expect(out("reserved-notice")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("the reservation runs out on the payment step → the order is discarded like a changed cart: details step, new key, and the buyer is told", async () => {
    vi.useFakeTimers();
    try {
      await orderReservedForTenMinutes();
      const firstKey = out("client-key");
      expect(out("payment-intent")).not.toBe("none");
      await press("card declined");

      await tick(TEN_MINUTES - 1000);
      expect(out("payment-intent")).not.toBe("none");

      await tick(1000);

      expect(out("payment-intent")).toBe("none");
      expect(out("checkout-step")).toBe("details");
      // The order is past its time to pay, and still holds its tickets.
      expect(out("order-notice")).toBe("expired (earlier order reserved)");
      expect(out("checkout-error")).toBe("");
      expect(out("client-key")).not.toBe(firstKey);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reservation runs out while the buyer is back on the event detail (the checkout and its countdown are unmounted) → discarded and said there", async () => {
    vi.useFakeTimers();
    try {
      await orderReservedForTenMinutes();
      await press("checkout back");
      expect(screen.getByTestId("reserved-notice")).toBeTruthy();

      await tick(TEN_MINUTES);

      expect(screen.queryByTestId("reserved-notice")).toBeNull();
      // The order is past its time to pay, and still holds its tickets.
      expect(out("order-notice")).toBe("expired (earlier order reserved)");
      await press("continue to checkout");
      expect(out("payment-intent")).toBe("none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a confirm in flight when the reservation runs out is waited out: the order stays until Stripe answers", async () => {
    vi.useFakeTimers();
    try {
      await orderReservedForTenMinutes();
      const intent = out("payment-intent");
      await press("confirm starts");

      await tick(TEN_MINUTES + 5000);
      // Still the order the confirm belongs to.
      expect(out("payment-intent")).toBe(intent);

      await press("confirm ends unpaid");

      expect(out("payment-intent")).toBe("none");
      // The order is past its time to pay, and still holds its tickets.
      expect(out("order-notice")).toBe("expired (earlier order reserved)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a payment that went through leaves no order for a lapsing reservation to discard under the confirmation", async () => {
    vi.useFakeTimers();
    try {
      await orderReservedForTenMinutes();
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-1");

      await tick(TEN_MINUTES + 5000);

      // Still the order that was paid for.
      expect(out("confirmation")).toBe("order-for-1");
      expect(screen.queryByTestId("order-notice")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a payment nobody could confirm: the reminder to check email shows, and a later discard never claims 'not charged'", async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await click("open event");
    await click("add a ticket");
    await click("continue to checkout");
    await click("create the order");

    await click("outcome unknown");
    // In the buyer's language: the catalog's sentence, not the redirect
    // reminder's English.
    const REMINDER =
      "We could not confirm whether your payment went through. Check your email before trying again.";
    expect(screen.getByText(REMINDER)).toBeTruthy();

    // Dismissing the reminder hides it; the outcome is still unknown.
    await click("Dismiss payment notice");
    expect(screen.queryByText(REMINDER)).toBeNull();
    await click("checkout back");
    await click("add a ticket");

    expect(out("order-notice")).toBe("changed (may have been charged)");
  });
});

describe("EmbedWidget — tickets an earlier order still has reserved", () => {
  // An order the widget leaves behind and could NOT release (here the
  // release fails in transit, the default of these tests) keeps its tickets
  // reserved until the SERVER cleans it up, which is well after its own
  // countdown, and they can show as unavailable to the buyer who reserved
  // them. The widget says so, as a fact about their own order, while it can
  // be true. What it says when the release does happen is further down.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const TEN_MINUTES = 10 * 60_000;
  const EARLIER = "(earlier order reserved)";
  // From the order's creation: its ten minutes to pay (the mock's), then the
  // 65 the server can go on holding its tickets (`leftOrderReservedUntil`).
  const RELEASED_AFTER = TEN_MINUTES + 65 * 60_000;

  /** An order for seats A and B, reserved for ten minutes, on the payment step. */
  const orderForSeatsAB = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("pick seats A and B");
    await press("continue to checkout");
    await press("create the order");
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("BLOCKER regression: a changed cart is told the earlier order's tickets stay reserved, while they can be, and no longer", async () => {
    await orderForSeatsAB();
    await press("checkout back");
    await tick(60_000);

    await press("pick seats C and D");

    expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    // It stays across further cart changes while that reservation lasts.
    await press("pick seats A and B");
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);

    // The earlier order's own countdown ending frees nothing: the server
    // holds its seats until the cart reaper gets to it.
    await tick(TEN_MINUTES);
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);

    // One second before the server's window for it is up.
    await tick(RELEASED_AFTER - TEN_MINUTES - 60_000 - 1000);
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);

    await tick(1000);

    // Nothing is reserved any more, and the notice has nothing left to say.
    expect(screen.queryByTestId("order-notice")).toBeNull();
    await press("continue to checkout");
    expect(out("earlier-note")).toBe("false");
  });

  it("an order with no reservation time is not said to have tickets reserved", async () => {
    checkoutMock.reservedForMs = null;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("pick seats A and B");
    await press("continue to checkout");
    await press("create the order");
    await press("checkout back");

    await press("pick seats C and D");

    expect(out("order-notice")).toBe("changed");
  });

  it("a refused checkout while the earlier order's tickets are reserved: said beside the error, once", async () => {
    await orderForSeatsAB();
    await press("checkout back");
    await press("pick seats C and D");
    await press("continue to checkout");
    // On the details step, before any attempt: in the notice above.
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    expect(out("earlier-note")).toBe("true");

    await press("checkout fails");

    // The checkout prints it under its error (EmbedCheckout); the notice
    // above keeps the rest and does not repeat it.
    expect(out("checkout-error")).not.toBe("");
    expect(out("earlier-note")).toBe("true");
    expect(out("order-notice")).toBe("changed");

    // Once that reservation is over, a refusal is no longer explained by it.
    await tick(RELEASED_AFTER);
    expect(out("earlier-note")).toBe("false");
  });

  it("a new order clears the notice, and the earlier one's tickets are still remembered", async () => {
    await orderForSeatsAB();
    await press("checkout back");
    await press("pick seats C and D");
    await press("continue to checkout");

    await tick(60_000);
    await press("create the order");

    expect(screen.queryByTestId("order-notice")).toBeNull();
    // Left behind in turn: the notice is about the later of the two.
    await press("checkout back");
    await press("pick seats A and B");
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    // Past the first order's end, inside the second's.
    await tick(RELEASED_AFTER - 30_000);
    expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    await tick(60_000);
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("an order that lands after the cart changed is dropped, and its tickets are reserved all the same", async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("pick seats A and B");
    await press("continue to checkout");
    await press("start creating the order");
    await press("checkout back");
    await press("pick seats C and D");
    expect(screen.queryByTestId("order-notice")).toBeNull();

    await act(async () => {
      checkoutMock.landPendingCreate?.();
    });

    expect(out("order-notice")).toBe(`changed ${EARLIER}`);
  });

  it("leaving the event for another and coming back: the order is gone without a word, its tickets are still reserved, and that is said", async () => {
    await orderForSeatsAB();
    await press("checkout back");
    await press("back to the events");

    await press("open another event");
    // Nothing about the first event's order on another event.
    expect(screen.queryByTestId("order-notice")).toBeNull();
    expect(screen.queryByTestId("reserved-notice")).toBeNull();

    await press("back to the events");
    await press("open event");

    expect(out("order-notice")).toBe(EARLIER);
    await press("pick seats A and B");
    await press("continue to checkout");
    // No order to return to: it was left.
    expect(out("payment-intent")).toBe("none");
    expect(out("earlier-note")).toBe("true");

    await tick(RELEASED_AFTER);
    expect(out("earlier-note")).toBe("false");
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("another date of the series is another event: nothing said there, said again back on the first", async () => {
    await orderForSeatsAB();
    await press("checkout back");

    await press("another date");
    expect(screen.queryByTestId("order-notice")).toBeNull();
    expect(screen.queryByTestId("reserved-notice")).toBeNull();

    await press("the first date");
    expect(out("order-notice")).toBe(EARLIER);
  });

  it("a reservation that ran out: the order still holds its tickets until the server cleans it up, so the buyer's own order may refuse their next try, and that is said", async () => {
    await orderForSeatsAB();

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe(`expired ${EARLIER}`);
    expect(out("earlier-note")).toBe("true");

    await tick(RELEASED_AFTER - TEN_MINUTES);

    expect(out("order-notice")).toBe("expired");
    expect(out("earlier-note")).toBe("false");
  });
});

describe("EmbedWidget — a reservation that ran out while the device slept", () => {
  // A timer set for the reservation's end does not fire on time on a device
  // that slept through it. The clock moves here without any timer running,
  // which is what waking up looks like to the page.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const TEN_MINUTES = 10 * 60_000;
  const sleepPast = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const wake = (how: "visibilitychange" | "focus") =>
    act(async () => {
      (how === "focus" ? window : document).dispatchEvent(new Event(how));
    });
  const orderOnThePaymentStep = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["visibilitychange", "focus"] as const)(
    "the page comes back (%s) after the reservation's end → the order is gone at once, not when a stale timer gets round to it",
    async (how) => {
      await orderOnThePaymentStep();
      const firstKey = out("client-key");

      sleepPast(TEN_MINUTES + 60_000);
      // No timer has run: the payment form is still there.
      expect(out("payment-intent")).not.toBe("none");

      await wake(how);

      expect(out("payment-intent")).toBe("none");
      expect(out("order-notice")).toBe("expired (earlier order reserved)");
      expect(out("client-key")).not.toBe(firstKey);
    },
  );

  it("coming back with time left changes nothing", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent");

    sleepPast(TEN_MINUTES - 60_000);
    await wake("visibilitychange");
    await wake("focus");

    expect(out("payment-intent")).toBe(intent);
    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("the earlier order's tickets stop being mentioned on waking past their time, too", async () => {
    await orderOnThePaymentStep();
    await press("checkout back");
    await press("add a ticket");
    expect(out("order-notice")).toBe("changed (earlier order reserved)");

    // Past the order's own countdown: still held by the server.
    sleepPast(TEN_MINUTES + 60_000);
    await wake("visibilitychange");
    expect(out("order-notice")).toBe("changed (earlier order reserved)");

    // Past the time the server keeps it.
    sleepPast(65 * 60_000);
    await wake("visibilitychange");

    expect(screen.queryByTestId("order-notice")).toBeNull();
  });

  it("Stripe says the order's PaymentIntent is canceled → discarded as expired, whatever this device's clock says; the server has let its tickets go, so none are said to be reserved", async () => {
    await orderOnThePaymentStep();
    const firstKey = out("client-key");

    await press("stripe says canceled");

    expect(out("payment-intent")).toBe("none");
    expect(out("checkout-step")).toBe("details");
    expect(out("order-notice")).toBe("expired");
    expect(out("earlier-note")).toBe("false");
    expect(out("client-key")).not.toBe(firstKey);
  });
});

describe("EmbedWidget — an order that answers late", () => {
  // The checkout stops waiting for createGuestCheckout after a while; the
  // request does not. Its answer arrives from the render that sent it, with
  // that render's idea of the page, and must never take the place of what
  // the buyer has moved on to since.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  /** Lands the nth create that was left in flight (0 = the first sent). */
  const lands = (nth: number) =>
    act(async () => {
      checkoutMock.pendingCreates[nth]?.();
    });
  const TEN_MINUTES = 10 * 60_000;

  /** Grid → detail with one ticket → the checkout's details step. */
  const onTheDetailsStep = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
  };

  it("Back from the details step takes the checkout off the page: whatever it was waiting on (a Continue kept for the bot check) goes with it", async () => {
    await onTheDetailsStep();
    expect(screen.queryByTestId("client-key")).not.toBeNull();

    await press("checkout back");

    // Unmounted, not hidden: its effects and timers are gone with it.
    expect(screen.queryByTestId("client-key")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "create the order" }),
    ).toBeNull();
  });

  it("W1 regression (wrong email): the order asked for under a mistyped email lands after the corrected one and never replaces it", async () => {
    await onTheDetailsStep();
    await press("email typed wrong");
    const typoKey = out("client-key");
    // Continue; no answer for 45 seconds, and the checkout stops waiting.
    await press("start creating the order");

    await press("email put right");
    // Another email is another buyer: the retry cannot ride the old key.
    const rightKey = out("client-key");
    expect(rightKey).not.toBe(typoKey);
    await press("create the order");
    const rightOrder = `pi_for_1_for_right@example.com_secret_${rightKey}`;
    expect(out("payment-intent")).toBe(rightOrder);

    await lands(0);

    // Still the order for the address the buyer meant.
    expect(out("payment-intent")).toBe(rightOrder);
    expect(out("checkout-step")).toBe("payment");
    // The mistyped one exists on the server all the same, with its ticket.
    expect(out("earlier-note")).toBe("true");
  });

  it("W1 regression (wrong email): with the corrected order's payment in flight, the late one does not unmount its form", async () => {
    await onTheDetailsStep();
    await press("email typed wrong");
    await press("start creating the order");
    await press("email put right");
    await press("create the order");
    const rightOrder = out("payment-intent");
    await press("confirm starts");

    await lands(0);

    expect(out("payment-intent")).toBe(rightOrder);
    expect(out("is-paying")).toBe("true");
  });

  it("W1 regression (wrong email): before any retry, the late order for the old email is left behind, said as an earlier order and not as changed tickets", async () => {
    await onTheDetailsStep();
    await press("email typed wrong");
    await press("start creating the order");
    await press("email put right");

    await lands(0);

    expect(out("payment-intent")).toBe("none");
    expect(out("checkout-step")).toBe("details");
    // The buyer changed no tickets. What is true: an earlier order of
    // theirs has its ticket reserved.
    expect(out("order-notice")).toBe("(earlier order reserved)");
  });

  it("an email retyped to the same address (spaces aside) is the same buyer: the key is kept, so the retry replays", async () => {
    await onTheDetailsStep();
    await press("email put right");
    const key = out("client-key");

    await press("email retyped with spaces");

    expect(out("client-key")).toBe(key);
  });

  it("W1 regression (promo codes): an order asked for before a promo code was applied lands late and does not take the place of the one with the code", async () => {
    await onTheDetailsStep();
    const firstKey = out("client-key");
    await press("start creating the order");

    await press("apply a promo code");
    // Other codes are another purchase: a fresh key, handed to the checkout.
    const promoKey = out("client-key");
    expect(promoKey).not.toBe(firstKey);
    await press("create the order");
    const promoOrder = `pi_for_1_with_SAVE10_secret_${promoKey}`;
    expect(out("payment-intent")).toBe(promoOrder);

    await lands(0);

    expect(out("payment-intent")).toBe(promoOrder);
    expect(out("earlier-note")).toBe("true");
  });

  it("W1 regression (promo codes): before any retry, the late order without the code is left behind and remembered", async () => {
    await onTheDetailsStep();
    await press("start creating the order");
    await press("apply a promo code");

    await lands(0);

    expect(out("payment-intent")).toBe("none");
    expect(out("order-notice")).toBe("(earlier order reserved)");
  });

  it("the promo codes the page already had are no change: coming back to the checkout keeps the key", async () => {
    await onTheDetailsStep();
    await press("apply a promo code");
    const key = out("client-key");

    await press("checkout back");
    await press("continue to checkout");

    expect(out("client-key")).toBe(key);
  });

  it("W1 regression (late free order): it does not pull the buyer off a paid order they are on, and the host page is not told of a sale", async () => {
    await onTheDetailsStep();
    checkoutMock.free = true;
    await press("start creating the order");
    // The buyer goes back for a second, paid, ticket.
    checkoutMock.free = false;
    await press("checkout back");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const paidOrder = out("payment-intent");
    expect(paidOrder).not.toBe("none");

    await lands(0);

    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(out("payment-intent")).toBe(paidOrder);
    expect(out("checkout-step")).toBe("payment");
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
  });

  it("W1 regression (late free order): the same key is not enough while another order is on screen", async () => {
    await onTheDetailsStep();
    checkoutMock.free = true;
    await press("start creating the order");
    // The retry of the same purchase came back as a paid order.
    checkoutMock.free = false;
    await press("create the order");
    const paidOrder = out("payment-intent");

    await lands(0);

    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(out("payment-intent")).toBe(paidOrder);
  });

  it("a late free order for the purchase the buyer is still on completes it, once", async () => {
    await onTheDetailsStep();
    checkoutMock.free = true;
    await press("start creating the order");
    await press("start creating the order");

    await lands(0);
    await lands(1);

    expect(out("confirmation")).toBe("free-order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("W1 regression (same key, two orders): an order already on screen is never replaced by an answer that comes in behind it, paying or not", async () => {
    await onTheDetailsStep();
    checkoutMock.serial = "first";
    await press("start creating the order");
    // The retry under the same key was answered with ANOTHER order (the
    // server should have replayed the first; this is the day it did not).
    checkoutMock.serial = "second";
    await press("create the order");
    const onScreen = out("payment-intent");
    expect(onScreen).toContain("_second_");

    await lands(0);
    expect(out("payment-intent")).toBe(onScreen);

    await press("confirm starts");
    await lands(0);
    expect(out("payment-intent")).toBe(onScreen);
    expect(out("is-paying")).toBe("true");
    // The first one is on the server with its ticket.
    expect(out("earlier-note")).toBe("true");
  });

  it("the order already paid for answers again behind its own confirmation → it is not taken back as an order to pay, and the confirmation keeps it", async () => {
    vi.useFakeTimers();
    try {
      await onTheDetailsStep();
      // The first request is left in flight; the retry under the same key
      // gets the order, and the buyer pays for it.
      await press("start creating the order");
      await press("create the order");
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-1");

      // The first request's answer: the very order on the confirmation.
      await lands(0);
      // Taken back as the page's order to pay, it would run out of time and
      // be discarded, and the confirmation would lose the order it shows.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(TEN_MINUTES + 5000);
      });

      expect(out("confirmation")).toBe("order-for-1");
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a payment in flight is never interrupted by an answer landing on it, whatever order is or is not on screen", async () => {
    await onTheDetailsStep();
    await press("start creating the order");
    await press("confirm starts");

    await lands(0);

    expect(out("payment-intent")).toBe("none");
    expect(out("is-paying")).toBe("true");
    // Left behind, and on the server with its ticket.
    expect(out("earlier-note")).toBe("true");
  });

  it("the order on screen answered a second time changes nothing", async () => {
    await onTheDetailsStep();
    await press("start creating the order");
    await press("create the order");
    const onScreen = out("payment-intent");

    await lands(0);

    expect(out("payment-intent")).toBe(onScreen);
    expect(out("checkout-step")).toBe("payment");
    // The same order, not one left behind.
    expect(out("earlier-note")).toBe("false");
  });
});

describe("EmbedWidget — a reservation that runs out on a payment nobody could confirm", () => {
  // While the order was live, a second attempt reused its PaymentIntent, so
  // the buyer could not pay twice. Discarding it ends that: the key rotates
  // and the notice invites them to reserve again. So Stripe is asked once
  // more before the order goes.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const TEN_MINUTES = 10 * 60_000;
  const CHECK_EMAIL =
    "We could not confirm whether your payment went through. Check your email before trying again.";
  let asked: string[];
  const stripeSays = (status: string | null) => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async (secret) => {
      asked.push(secret);
      return status === null ? {} : { paymentIntent: { status } };
    };
  };
  /** An order on the payment step whose confirm ended with no known outcome. */
  const unknownOutcome = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("outcome unknown");
  };

  beforeEach(() => {
    vi.useFakeTimers();
    asked = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["succeeded", "processing"] as const)(
    "W3 regression: Stripe says the PaymentIntent %s → the buyer gets their confirmation, not an invitation to buy the same tickets again",
    async (status) => {
      stripeSays(status);
      await unknownOutcome();
      const intent = out("payment-intent");

      await tick(TEN_MINUTES);

      expect(asked).toEqual([intent]);
      expect(out("confirmation")).toBe("order-for-1");
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("order-notice")).toBeNull();
      expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
    },
  );

  it("W3 regression: Stripe cannot be asked → the order goes, and the invitation to reserve again carries 'check your email' where it cannot be dismissed", async () => {
    await unknownOutcome();
    // Until then the reminder is the banner, which the buyer can dismiss.
    expect(screen.getByText(CHECK_EMAIL)).toBeTruthy();
    await press("Dismiss payment notice");

    await tick(TEN_MINUTES);

    expect(out("payment-intent")).toBe("none");
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
    // Stripe.js not loading is a fallback like any other: reported.
    expect(trace.labels).toContain("embed.paymentStatusUnreadable");
  });

  it("the reminder is said once: the banner steps aside while the notice carries it", async () => {
    await unknownOutcome();
    expect(screen.getAllByText(CHECK_EMAIL)).toHaveLength(1);

    await tick(TEN_MINUTES);

    // The (mocked) notice shows that it was told; the banner is gone.
    expect(out("order-notice")).toContain("(may have been charged)");
    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
  });

  it("Stripe answers with no PaymentIntent → as unknown as no answer, and reported", async () => {
    stripeSays(null);
    await unknownOutcome();

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
    expect(trace.labels).toContain("embed.paymentStatusUnreadable");
  });

  it("Stripe says the last attempt failed outright → the order goes as expired, and nothing says the buyer may have been charged", async () => {
    stripeSays("requires_payment_method");
    await unknownOutcome();

    await tick(TEN_MINUTES);

    expect(out("payment-intent")).toBe("none");
    expect(out("order-notice")).toBe("expired (earlier order reserved)");
    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
  });

  it("Stripe says canceled → the server cleaned the order up: expired, nothing reserved, nothing charged", async () => {
    stripeSays("canceled");
    await unknownOutcome();

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe("expired");
    expect(out("earlier-note")).toBe("false");
  });

  it("Stripe is asked once per order, however long the answer takes and whatever re-renders meanwhile", async () => {
    stripeJs.unavailable = false;
    let answer: (value: unknown) => void = () => undefined;
    stripeJs.retrievePaymentIntent = (secret) => {
      asked.push(secret);
      return new Promise((resolve) => {
        answer = resolve;
      });
    };
    await unknownOutcome();

    await tick(TEN_MINUTES);
    // Everything the discard waits on changes and changes back.
    await press("confirm starts");
    await press("confirm ends unpaid");
    await tick(1000);
    // Still there while Stripe is being asked.
    expect(out("payment-intent")).not.toBe("none");
    expect(asked).toHaveLength(1);

    await act(async () => {
      answer({ paymentIntent: { status: "succeeded" } });
    });

    expect(out("confirmation")).toBe("order-for-1");
    expect(asked).toHaveLength(1);
  });

  it("the buyer changes the cart while Stripe is being asked → the answer is about an order that is gone, and settles nothing on the page", async () => {
    stripeJs.unavailable = false;
    let answer: (value: unknown) => void = () => undefined;
    stripeJs.retrievePaymentIntent = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await unknownOutcome();
    await tick(TEN_MINUTES);

    await press("checkout back");
    await press("add a ticket");
    await act(async () => {
      answer({ paymentIntent: { status: "succeeded" } });
    });

    // No confirmation for a cart that was never paid for. The buyer is on
    // the event with two tickets, told the order changed and, since nobody
    // settled it, not told they were not charged.
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(out("order-notice")).toBe(
      "changed (may have been charged) (earlier order reserved)",
    );
    expect(screen.getByText(CHECK_EMAIL)).toBeTruthy();
  });

  it("no answer from Stripe in time → the order goes, still unknown", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = (secret) => {
      asked.push(secret);
      return new Promise(() => undefined);
    };
    await unknownOutcome();

    await tick(TEN_MINUTES);
    expect(out("payment-intent")).not.toBe("none");
    expect(trace.labels).not.toContain("embed.paymentStatusUnreadable");
    await tick(STRIPE_VERIFY_TIMEOUT_MS);

    expect(out("payment-intent")).toBe("none");
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
    // Giving up on the answer is reported too.
    expect(trace.labels).toContain("embed.paymentStatusUnreadable");
  });

  // D1: the unknown outcome belongs to ONE order. What Stripe says about
  // another order settles nothing about it.
  it("D1 regression: order A's payment is unknown, the buyer changes the cart and order B's time runs out → Stripe is not asked about B, and nothing says the buyer was not charged", async () => {
    stripeSays("requires_payment_method");
    await unknownOutcome();
    const orderA = out("payment-intent");

    // A different purchase: order A is left behind, order B takes its place.
    await press("checkout back");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const orderB = out("payment-intent");
    expect(orderB).not.toBe(orderA);
    expect(screen.getByText(CHECK_EMAIL)).toBeTruthy();

    await tick(TEN_MINUTES);

    // B went when its time was up, with nothing unknown about it to ask.
    expect(out("payment-intent")).toBe("none");
    expect(asked).toEqual([]);
    // A is still unsettled, so the buyer is still told to check their email.
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );

    // And a change of tickets after that never says "not charged" either.
    await press("checkout back");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("checkout back");
    await press("remove a ticket");
    expect(out("order-notice")).toContain("changed (may have been charged)");
  });

  it("D1 regression: order B's own payment is unknown too → Stripe's answer about B clears B only, and A's reminder stays", async () => {
    stripeSays("requires_payment_method");
    await unknownOutcome();
    await press("checkout back");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const orderB = out("payment-intent");
    await press("outcome unknown");

    await tick(TEN_MINUTES);

    expect(asked).toEqual([orderB]);
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
  });

  // D1: Stripe reads "requires_payment_method" right up to the moment a
  // confirm lands. While the form's confirm is still out, that answer is not
  // "nothing was charged".
  it("D1 regression: the confirm is still out when the time runs out and Stripe says nothing was charged yet → the order goes, and the buyer is still told to check their email", async () => {
    stripeSays("requires_payment_method");
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const intent = out("payment-intent");
    await press("confirm is still out");

    await tick(TEN_MINUTES);

    expect(asked).toEqual([intent]);
    expect(out("payment-intent")).toBe("none");
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );

    // The confirm ending unpaid after the order has gone changes nothing on
    // the page: nobody asks Stripe again, so nothing has settled it.
    await press("late confirm ends unpaid");
    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
  });

  it("the confirm that was still out ends unpaid BEFORE the time runs out → Stripe's 'nothing was charged' is believed", async () => {
    stripeSays("requires_payment_method");
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("confirm is still out");
    // Still unknown: the confirm ended, but Stripe has not been asked.
    await press("late confirm ends unpaid");
    expect(screen.getByText(CHECK_EMAIL)).toBeTruthy();

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe("expired (earlier order reserved)");
    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
  });

  it("two confirms still out and one ends unpaid → the other can still land, so Stripe's answer is not believed", async () => {
    stripeSays("requires_payment_method");
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("confirm is still out");
    await press("confirm is still out");
    await press("late confirm ends unpaid");

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe(
      "expired (may have been charged) (earlier order reserved)",
    );
  });

  it("Stripe says canceled while a confirm is still out → canceled settles it: nothing can land on a canceled PaymentIntent", async () => {
    stripeSays("canceled");
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("confirm is still out");

    await tick(TEN_MINUTES);

    expect(out("order-notice")).toBe("expired");
    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
  });

  it("the payment form learns the order was canceled → that order's unknown outcome is settled, another order's is not", async () => {
    await unknownOutcome();
    await press("stripe says canceled");
    // The only unknown outcome was this order's.
    expect(out("order-notice")).toBe("expired");
    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();

    // A second order with an unknown outcome, left behind for a third...
    await press("create the order");
    await press("outcome unknown");
    await press("checkout back");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    // ...whose cancellation says nothing about the second.
    await press("stripe says canceled");
    expect(out("order-notice")).toContain("expired (may have been charged)");
  });

  it("a late 'ended unpaid' for an order the widget has no record of is ignored", async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");

    await press("late confirm ends unpaid");

    expect(screen.queryByText(CHECK_EMAIL)).toBeNull();
    await press("checkout back");
    await press("add a ticket");
    expect(out("order-notice")).toContain("changed");
    expect(out("order-notice")).not.toContain("(may have been charged)");
  });

  it("a payment that was simply declined is not asked about: the order goes when its time is up", async () => {
    stripeSays("succeeded");
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("card declined");

    await tick(TEN_MINUTES);

    expect(asked).toEqual([]);
    expect(out("order-notice")).toBe("expired (earlier order reserved)");
  });
});

describe("EmbedWidget — 'Order confirmed' waits for the server's answer", () => {
  // Stripe's browser side saying "paid" is not a confirmed order: the server
  // finalizes it. The widget asks `embeds.confirmGuestPayment` and shows a
  // confirmation only on its answer (owner ruling 2026-10-11).
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const copy = new Proxy({} as Record<string, string>, {
    get: (_target, key) => checkoutCopy(String(key)),
  });
  const TEN_MINUTES = 10 * 60_000;
  const ASK_TIMEOUT = 20_000;
  const RETRY_DELAY = 2_000;

  /** A server that answers when the test says so, one resolver per call. */
  const serverAnswersLater = () => {
    const answers: Array<(value: ServerAnswer) => void> = [];
    server.confirm.mockImplementation(
      () =>
        new Promise<ServerAnswer>((resolve) => {
          answers.push(resolve);
        }),
    );
    return answers;
  };
  const refusal = (code: string, appCode?: string) =>
    Object.assign(new Error(appCode ?? code), {
      data: { code, ...(appCode ? { appCode } : {}) },
    });
  const orderOnThePaymentStep = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
  };
  const onTheUnconfirmedScreen = () =>
    screen.queryByText(copy.embedPaidUnconfirmedTitle) !== null;
  /** How long "Check again" rests after an unconfirmed answer. */
  const REST = 5_000;
  /** Not now, and not final: the endpoint's budget is spent. */
  const notNow = () => refusal("TOO_MANY_REQUESTS");
  const checkAgainButton = () =>
    screen.queryByRole("button", { name: copy.embedCheckAgain });
  const pendingMarker = () =>
    window.sessionStorage.getItem(pendingRedirectKey("embed-1"));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Stripe says paid → the server is asked for THIS order, and until it answers there is no confirmation, no sale told to the host, and Back is locked", async () => {
    const answers = serverAnswersLater();
    await orderOnThePaymentStep();
    const intent = out("payment-intent");

    await press("pay in page");

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(server.confirm).toHaveBeenCalledWith({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: intent,
    });
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
    // The checkout stays, told to lock Back and say why.
    expect(out("is-confirming")).toBe("true");
    // Not "we could not confirm": nothing has failed.
    expect(screen.queryByText(copy.embedPaymentOutcomeUnknown)).toBeNull();

    await act(async () => {
      answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
    });

    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    expect(bridge.emitOrderComplete).toHaveBeenCalledWith("order-for-1", 2000, "usd");
  });

  it("paid reported twice for one order → the server is asked once", async () => {
    await orderOnThePaymentStep();
    await press("paid is reported twice");
    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("a free order has no payment to confirm: complete as created, the server is not asked", async () => {
    checkoutMock.free = true;
    await orderOnThePaymentStep();
    expect(out("confirmation")).toBe("free-order-for-1");
    expect(server.confirm).not.toHaveBeenCalled();
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("the server says the payment is still clearing → the truth: with the bank, tickets emailed when it clears; never 'Order confirmed'. The host is told once", async () => {
    server.confirm.mockResolvedValue({ outcome: "processing", orderId: "order-for-1" });
    await orderOnThePaymentStep();

    await press("pay in page by bank");

    expect(screen.getByRole("heading", { name: copy.embedPaymentClearingTitle })).toBeTruthy();
    expect(screen.getByText(copy.embedPaymentClearingBody)).toBeTruthy();
    // Not the screen that says "Order confirmed" and "Tickets sent to".
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(screen.getByTestId("embed-redirect-amount").textContent).toBe("$20.00");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);

    await press("Done");
    expect(screen.getByTestId("grid")).toBeTruthy();
  });

  it("the server says 'not paid' after Stripe said paid → a contradiction, not 'you were not charged': payment went through, order not confirmed yet", async () => {
    server.confirm.mockResolvedValue({
      outcome: "not_paid",
      orderId: "order-for-1",
      paymentIntentStatus: "requires_payment_method",
    });
    await orderOnThePaymentStep();

    await press("pay in page");

    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain(copy.embedUnconfirmedBody);
    expect(screen.getByRole("alert").textContent).toContain(copy.embedUnconfirmedContact);
    expect(screen.getByRole("alert").textContent).not.toContain(copy.embedClearingUnconfirmedBody);
    expect(screen.getByRole("link", { name: "support@ithasfire.com" })).toBeTruthy();
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(screen.queryByText(copy.embedNotCharged)).toBeNull();
    // Buying is closed: no checkout, no event, no grid.
    expect(screen.queryByTestId("payment-intent")).toBeNull();
    expect(screen.queryByTestId("event-detail")).toBeNull();
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
    // An answer is an answer: not asked a second time by itself.
    expect(server.confirm).toHaveBeenCalledTimes(1);
  });

  it("Stripe said the payment is clearing and the server does not confirm → 'with your bank', not 'went through'", async () => {
    server.confirm.mockRejectedValue(refusal("FORBIDDEN"));
    await orderOnThePaymentStep();
    await press("pay in page by bank");
    const said = screen.getByRole("alert").textContent ?? "";
    expect(said).toContain(copy.embedClearingUnconfirmedTitle);
    expect(screen.queryByText(copy.embedPaidUnconfirmedTitle)).toBeNull();
    // No ticket is sent until the bank clears: never "check your email for
    // your tickets", and the contact line does not call them late.
    expect(said).toContain(copy.embedClearingUnconfirmedBody);
    expect(said).not.toContain(copy.embedUnconfirmedBody);
    expect(said).toContain(copy.embedClearingUnconfirmedContact);
    expect(said).not.toContain(copy.embedUnconfirmedContact);
    expect(screen.getByRole("link", { name: "support@ithasfire.com" })).toBeTruthy();
  });

  it.each([
    ["the origin is refused", "FORBIDDEN", undefined, true],
    ["the embed is gone", "NOT_FOUND", "EMBED_NOT_FOUND", true],
    ["the order can no longer be finalized", "CONFLICT", "ORDER_NOT_PROCESSABLE", true],
    ["the secret is not this order's", "CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH", true],
    ["the rate limit is hit", "TOO_MANY_REQUESTS", undefined, false],
  ])(
    "the call throws (%s) → never 'not paid' and never 'Order confirmed'; not asked again by itself; Check again only where asking again can help",
    async (_what, code, appCode, final) => {
      server.confirm.mockRejectedValue(refusal(code, appCode));
      await orderOnThePaymentStep();

      await press("pay in page");
      await tick(RETRY_DELAY + ASK_TIMEOUT);

      expect(onTheUnconfirmedScreen()).toBe(true);
      expect(screen.queryByTestId("confirmation")).toBeNull();
      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
      expect(trace.labels).toContain("embed.confirmOrderFailed");
      expect(checkAgainButton() === null).toBe(final);
      const said = screen.getByRole("alert").textContent ?? "";
      // The body and the support line stay either way; with nothing to
      // press, the support line leads.
      const contactAt = said.indexOf(copy.embedUnconfirmedContact);
      const bodyAt = said.indexOf(copy.embedUnconfirmedBody);
      expect(contactAt).toBeGreaterThan(-1);
      expect(bodyAt).toBeGreaterThan(-1);
      expect(contactAt < bodyAt).toBe(final);
      // Never a claim that the tickets will not come: the webhook can still
      // finalize the order.
      expect(said).not.toMatch(/will not|won.t|cannot be/i);
    },
  );

  it("a 500 that carries an app code is asked once more, like any 5xx", async () => {
    server.confirm.mockRejectedValueOnce(
      refusal("INTERNAL_SERVER_ERROR", "INTERNAL"),
    );
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(RETRY_DELAY);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(out("confirmation")).toBe("order-for-1");
  });

  it("D1: the confirm call opts out of the app's global 'Action failed… try again' toast, and of react-query's retry", async () => {
    await orderOnThePaymentStep();
    // `meta.silent` is what GlobalMutationErrorNotifier reads to stay quiet.
    expect(server.mutationOptions).toMatchObject({
      meta: { silent: true },
      retry: false,
    });
  });

  it("entering the unconfirmed screen: the title is a heading and takes focus; a host-page reload is covered by the pending marker, which holds the PaymentIntent id and never the secret", async () => {
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    const intent = out("payment-intent") ?? "";
    expect(pendingMarker()).toBeNull();

    await press("pay in page");

    const title = screen.getByRole("heading", { name: copy.embedPaidUnconfirmedTitle });
    expect(document.activeElement).toBe(title);
    const marker = pendingMarker() ?? "";
    expect(JSON.parse(marker)).toMatchObject({
      paymentIntentId: intent.slice(0, intent.indexOf("_secret_")),
    });
    expect(marker).not.toContain("_secret_");

    // Confirmed after all: the reminder is moot.
    serverConfirms();
    await tick(REST);
    await press(copy.embedCheckAgain);
    expect(out("confirmation")).toBe("order-for-1");
    expect(pendingMarker()).toBeNull();
  });

  it("the call fails with no server code (a lost connection) → asked once more after a pause; the second answer confirms", async () => {
    server.confirm.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await orderOnThePaymentStep();

    await press("pay in page");
    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(onTheUnconfirmedScreen()).toBe(false);

    await tick(RETRY_DELAY);

    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(out("confirmation")).toBe("order-for-1");
  });

  it("a finalize is already running for the order (the webhook's) → asked once more, which confirms", async () => {
    server.confirm.mockRejectedValueOnce(
      refusal("TOO_MANY_REQUESTS", "IDEMPOTENCY_LOCK_IN_PROGRESS"),
    );
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(RETRY_DELAY);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(out("confirmation")).toBe("order-for-1");
  });

  it("the call fails twice → 'payment went through, order not confirmed yet'; two calls, no more", async () => {
    server.confirm.mockRejectedValue(new TypeError("Failed to fetch"));
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(RETRY_DELAY);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    await tick(10 * ASK_TIMEOUT);
    expect(server.confirm).toHaveBeenCalledTimes(2);
  });

  it("no answer in time → asked once more; no answer again → the widget stops waiting and says the payment went through, the order is not confirmed yet", async () => {
    serverAnswersLater();
    await orderOnThePaymentStep();

    await press("pay in page");
    await tick(ASK_TIMEOUT - 1);
    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(out("is-confirming")).toBe("true");

    await tick(1);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(onTheUnconfirmedScreen()).toBe(false);

    await tick(ASK_TIMEOUT);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
    expect(trace.labels).toContain("embed.confirmOrderTimedOut");
  });

  it("the first ask answers while the second is waited on → its answer is taken", async () => {
    const answers = serverAnswersLater();
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(ASK_TIMEOUT);
    expect(server.confirm).toHaveBeenCalledTimes(2);

    await act(async () => {
      answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
    });

    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("an answer that lands after the widget stopped waiting still confirms the order: the buyer moves to the confirmation without pressing anything, and the host is told once", async () => {
    const answers = serverAnswersLater();
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(2 * ASK_TIMEOUT);
    expect(onTheUnconfirmedScreen()).toBe(true);

    await act(async () => {
      answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
    });
    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    expect(pendingMarker()).toBeNull();

    // The other ask answering too changes nothing more.
    await act(async () => {
      answers[1]?.({ outcome: "confirmed", orderId: "order-for-1" });
    });
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("a late 'not paid' is not news: the unconfirmed screen stays as it is", async () => {
    const answers = serverAnswersLater();
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(2 * ASK_TIMEOUT);

    await act(async () => {
      answers[0]?.({
        outcome: "not_paid",
        orderId: "order-for-1",
        paymentIntentStatus: "requires_payment_method",
      });
    });
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(screen.queryByText(copy.embedNotCharged)).toBeNull();
  });

  it("Check again: one call a press, 'Checking…' while it is out, 'still could not confirm' when it changes nothing, and the confirmation when the server confirms", async () => {
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    await press("pay in page");
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(screen.queryByText(copy.embedStillUnconfirmed)).toBeNull();

    // It rests for 5 s after the answer that opened the screen: said the
    // way "checking" is (aria-disabled), and a press sends nothing.
    const answers = serverAnswersLater();
    expect(checkAgainButton()?.getAttribute("aria-disabled")).toBe("true");
    await press(copy.embedCheckAgain);
    expect(server.confirm).toHaveBeenCalledTimes(1);
    await tick(REST - 1);
    expect(checkAgainButton()?.getAttribute("aria-disabled")).toBe("true");
    await tick(1);
    expect(checkAgainButton()?.getAttribute("aria-disabled")).toBeNull();

    // A check that is still out.
    await press(copy.embedCheckAgain);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(checkAgainButton()?.getAttribute("aria-disabled")).toBe("true");
    expect((checkAgainButton() as HTMLButtonElement).disabled).toBe(false);
    // "Checking…" is in the live region, where it is announced.
    expect(screen.getByRole("status").textContent).toBe(copy.embedCheckingAgain);
    // A press while it is out sends nothing.
    await press(copy.embedCheckAgain);
    expect(server.confirm).toHaveBeenCalledTimes(2);

    // It comes back without a confirmation, and is not asked again by itself.
    await act(async () => {
      answers[0]?.({
        outcome: "not_paid",
        orderId: "order-for-1",
        paymentIntentStatus: "requires_action",
      });
    });
    expect(screen.getByRole("status").textContent).toBe(copy.embedStillUnconfirmed);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(server.confirm).toHaveBeenCalledTimes(2);
    // And rests again.
    expect(checkAgainButton()?.getAttribute("aria-disabled")).toBe("true");

    serverConfirms();
    await tick(REST);
    await press(copy.embedCheckAgain);
    expect(server.confirm).toHaveBeenCalledTimes(3);
    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  it("Check again while a finalize is running for the order (the webhook's) → asked once more after the pause, which confirms", async () => {
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(REST);
    server.confirm.mockReset();
    server.confirm.mockRejectedValueOnce(
      refusal("TOO_MANY_REQUESTS", "IDEMPOTENCY_LOCK_IN_PROGRESS"),
    );
    serverConfirms();

    await press(copy.embedCheckAgain);
    expect(server.confirm).toHaveBeenCalledTimes(1);
    await tick(RETRY_DELAY);

    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(out("confirmation")).toBe("order-for-1");
  });

  it("a bare 429 with no app code is the rate limit, not the finalize lock: not asked again by itself, and Check again stays", async () => {
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(RETRY_DELAY + ASK_TIMEOUT);

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).not.toBeNull();
  });

  it("W2: an in-page order is asked about with the origin the widget computes, never the one saved for a redirect return", async () => {
    window.sessionStorage.setItem("hf:embed:host-origin:embed-1", "https://saved.example");
    hostOrigin.value = "https://pay.example";
    await orderOnThePaymentStep();
    await press("pay in page");
    expect(server.confirm.mock.calls[0]?.[0]).toMatchObject({
      hostOrigin: "https://pay.example",
    });
  });

  it.each([
    ["a gateway that timed out", "GATEWAY_TIMEOUT"],
    ["a code this widget does not know", "SOMETHING_NEW"],
  ])(
    "W1: %s is not final: asked once more, and the screen keeps Check again",
    async (_what, code) => {
      server.confirm.mockRejectedValue(refusal(code));
      await orderOnThePaymentStep();
      await press("pay in page");
      await tick(RETRY_DELAY);

      expect(server.confirm).toHaveBeenCalledTimes(2);
      expect(onTheUnconfirmedScreen()).toBe(true);
      expect(checkAgainButton()).not.toBeNull();
    },
  );

  it("a bare NOT_FOUND with no app code is not final (a web build ahead of the API answers that for a procedure it lacks): asked once more, and Check again stays", async () => {
    server.confirm.mockRejectedValue(refusal("NOT_FOUND"));
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(RETRY_DELAY);

    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).not.toBeNull();
  });

  it.each([
    ["FORBIDDEN", undefined],
    ["NOT_FOUND", "EMBED_NOT_FOUND"],
    ["NOT_FOUND", "EVENT_NOT_FOUND"],
    ["NOT_FOUND", "ORDER_NOT_FOUND"],
    ["CONFLICT", undefined],
    ["BAD_REQUEST", undefined],
  ])(
    "W1: %s (app code %s) is final: asked once, and no Check again",
    async (code, appCode) => {
      server.confirm.mockRejectedValue(refusal(code, appCode));
      await orderOnThePaymentStep();
      await press("pay in page");
      await tick(RETRY_DELAY);

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(onTheUnconfirmedScreen()).toBe(true);
      expect(checkAgainButton()).toBeNull();
    },
  );

  describe("D4: a 'still being confirmed' reminder already on screen", () => {
    const REMINDER =
      "You may have a payment still being confirmed. Check your email before buying again.";
    /** A load within 30 minutes of a payment that ended unconfirmed. */
    const loadedAfterUnconfirmed = (paymentIntentId: string) =>
      window.sessionStorage.setItem(
        pendingRedirectKey("embed-1"),
        JSON.stringify({ paymentIntentId, at: Date.now() }),
      );
    const reminderOnScreen = () => screen.queryByText(REMINDER) !== null;

    it("the same payment confirmed by a late answer: the reminder and its marker both go", async () => {
      loadedAfterUnconfirmed("pi_for_1");
      const answers = serverAnswersLater();
      await orderOnThePaymentStep();
      expect(reminderOnScreen()).toBe(true);
      await press("pay in page");
      await tick(2 * ASK_TIMEOUT);
      expect(onTheUnconfirmedScreen()).toBe(true);

      await act(async () => {
        answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });

      expect(out("confirmation")).toBe("order-for-1");
      expect(reminderOnScreen()).toBe(false);
      expect(pendingMarker()).toBeNull();
    });

    it("the same payment confirmed by Check again: the reminder and its marker both go", async () => {
      loadedAfterUnconfirmed("pi_for_1");
      server.confirm.mockRejectedValue(notNow());
      await orderOnThePaymentStep();
      await press("pay in page");
      expect(onTheUnconfirmedScreen()).toBe(true);
      serverConfirms();
      await tick(REST);

      await press(copy.embedCheckAgain);

      expect(out("confirmation")).toBe("order-for-1");
      expect(reminderOnScreen()).toBe(false);
      expect(pendingMarker()).toBeNull();
    });

    it("a DIFFERENT payment's reminder stays over the confirmation: nothing was learned about it", async () => {
      loadedAfterUnconfirmed("pi_other");
      serverConfirms();
      await orderOnThePaymentStep();
      await press("pay in page");

      expect(out("confirmation")).toBe("order-for-1");
      expect(reminderOnScreen()).toBe(true);
    });
  });

  it("Check again on a lost connection is one call: it is the buyer's to press again", async () => {
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    await press("pay in page");
    await tick(REST);
    server.confirm.mockReset();
    server.confirm.mockRejectedValue(new TypeError("Failed to fetch"));

    await press(copy.embedCheckAgain);
    await tick(RETRY_DELAY + ASK_TIMEOUT);

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(copy.embedStillUnconfirmed);
  });

  it("a paid, unconfirmed order is never discarded when its reservation runs out: no invitation to buy the same tickets again", async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    server.confirm.mockRejectedValue(notNow());
    await orderOnThePaymentStep();
    await press("pay in page");
    expect(onTheUnconfirmedScreen()).toBe(true);

    await tick(TEN_MINUTES + 5000);

    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(screen.queryByTestId("order-notice")).toBeNull();
    expect(screen.queryByTestId("event-detail")).toBeNull();
    // And it can still be confirmed.
    serverConfirms();
    await press(copy.embedCheckAgain);
    expect(out("confirmation")).toBe("order-for-1");
  });

  it("the page cannot leave an order while the server is asked about it: off the checkout, the confirming screen is all there is, and the answer still confirms that order", async () => {
    const answers = serverAnswersLater();
    await orderOnThePaymentStep();
    await press("pay in page");
    // The mock's Back is not locked, unlike the real one.
    await press("checkout back");

    expect(screen.queryByTestId("event-detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "add a ticket" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Confirming your payment…");
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();

    await act(async () => {
      answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
    });
    expect(out("confirmation")).toBe("order-for-1");
    expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
  });

  describe("the expiry path", () => {
    const stripeSays = (status: string) => {
      stripeJs.unavailable = false;
      stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { status } });
    };
    const unknownOutcomeAtExpiry = async () => {
      checkoutMock.reservedForMs = TEN_MINUTES;
      await orderOnThePaymentStep();
      await press("outcome unknown");
      await tick(TEN_MINUTES);
    };

    it("Stripe says paid at expiry → the server is asked before any confirmation", async () => {
      stripeSays("succeeded");
      const answers = serverAnswersLater();
      await unknownOutcomeAtExpiry();

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(server.confirm.mock.calls[0]?.[0]).toMatchObject({
        clientSecret: out("payment-intent"),
      });
      expect(screen.queryByTestId("confirmation")).toBeNull();
      expect(out("is-confirming")).toBe("true");
      expect(screen.queryByTestId("order-notice")).toBeNull();

      await act(async () => {
        answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });
      expect(out("confirmation")).toBe("order-for-1");
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    });

    it("R4: the ask starts while the buyer is back on the event → 'Confirming your payment…' takes the screen, so the cart cannot be changed under a paid order", async () => {
      stripeSays("succeeded");
      const answers = serverAnswersLater();
      checkoutMock.reservedForMs = TEN_MINUTES;
      await orderOnThePaymentStep();
      await press("outcome unknown");
      await press("checkout back");
      expect(screen.getByTestId("event-detail")).toBeTruthy();

      await tick(TEN_MINUTES);

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("event-detail")).toBeNull();
      expect(screen.queryByRole("button", { name: "add a ticket" })).toBeNull();
      expect(screen.getByRole("status").textContent).toBe("Confirming your payment…");

      await act(async () => {
        answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });
      expect(out("confirmation")).toBe("order-for-1");
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    });

    it("the payment form's own late 'paid' arrives while the expiry ask is already out → one server call, one sale told to the host", async () => {
      stripeSays("succeeded");
      const answers = serverAnswersLater();
      await unknownOutcomeAtExpiry();
      expect(server.confirm).toHaveBeenCalledTimes(1);

      await press("pay in page");
      expect(server.confirm).toHaveBeenCalledTimes(1);

      await act(async () => {
        answers[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });
      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
      expect(out("confirmation")).toBe("order-for-1");
    });

    it("Stripe says paid at expiry and the server does not confirm → the paid-unconfirmed screen, never the 'reservation ran out, reserve again' notice", async () => {
      stripeSays("succeeded");
      server.confirm.mockRejectedValue(notNow());
      await unknownOutcomeAtExpiry();

      expect(onTheUnconfirmedScreen()).toBe(true);
      expect(screen.queryByTestId("order-notice")).toBeNull();
      expect(screen.queryByTestId("confirmation")).toBeNull();
    });
  });

  describe("the earlier order's reminder when a later order completes", () => {
    // Order 1's payment ended with nobody able to say what became of it;
    // the buyer changed the cart and paid order 2.
    let firstIntent = "";
    const payALaterOrder = async (
      earlier: (clientSecret: string) => Promise<ServerAnswer>,
      leaveFirstOrder: () => Promise<void> = async () => {
        await press("outcome unknown");
      },
    ) => {
      await orderOnThePaymentStep();
      firstIntent = out("payment-intent") ?? "";
      await leaveFirstOrder();
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      const secondIntent = out("payment-intent");
      expect(secondIntent).not.toBe(firstIntent);
      server.confirm.mockImplementation(
        async ({ clientSecret }: { clientSecret: string }) =>
          clientSecret === firstIntent
            ? earlier(clientSecret)
            : { outcome: "confirmed", orderId: "order-for-2" },
      );
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-2");
    };
    const askedAbout = () =>
      server.confirm.mock.calls.map(
        ([input]: [{ clientSecret: string }]) => input.clientSecret,
      );

    it("the server says the earlier payment went through → said plainly over the confirmation, as a payment, not as a confirmed order", async () => {
      await payALaterOrder(async () => ({ outcome: "confirmed", orderId: "order-for-1" }));

      expect(askedAbout()).toContain(firstIntent);
      expect(screen.getByText(copy.embedEarlierOrderPaid)).toBeTruthy();
      expect(copy.embedEarlierOrderPaid).not.toMatch(/confirmed/i);
      // The host page hears of the order that was completed, and only it.
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
      expect(bridge.emitOrderComplete).toHaveBeenCalledWith("order-for-2", 4000, "usd");
      // Still said after Done: it is a fact about another order.
      await press("Done");
      expect(screen.getByText(copy.embedEarlierOrderPaid)).toBeTruthy();
    });

    it("N1: the same 'paid' answer a second time does not bring back the reminder the buyer dismissed", async () => {
      // Two asks about order 1 are out at once: one from order 2's
      // confirmation, one from order 3's.
      const waiting: Array<(answer: ServerAnswer) => void> = [];
      await payALaterOrder(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            waiting.push(resolve);
          }),
      );
      await press("Done");
      await press("open event");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      await press("pay in page");
      expect(waiting).toHaveLength(2);

      await act(async () => {
        waiting[0]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });
      expect(screen.getByText(copy.embedEarlierOrderPaid)).toBeTruthy();
      await press("Dismiss payment notice");
      expect(screen.queryByText(copy.embedEarlierOrderPaid)).toBeNull();

      await act(async () => {
        waiting[1]?.({ outcome: "confirmed", orderId: "order-for-1" });
      });
      expect(screen.queryByText(copy.embedEarlierOrderPaid)).toBeNull();
    });

    it("the server says the earlier payment is clearing → said as that", async () => {
      await payALaterOrder(async () => ({ outcome: "processing", orderId: "order-for-1" }));
      expect(screen.getByText(copy.embedEarlierOrderClearing)).toBeTruthy();
      expect(screen.queryByText(copy.embedEarlierOrderPaid)).toBeNull();
    });

    it("the server settles the earlier order as not charged → the record is forgotten, and the widget may say 'not charged' again", async () => {
      await payALaterOrder(async () => ({
        outcome: "not_paid",
        orderId: "order-for-1",
        paymentIntentStatus: "requires_payment_method",
      }));

      expect(screen.queryByText(copy.embedEarlierOrderUnknown)).toBeNull();
      expect(screen.queryByText(copy.embedEarlierOrderPaid)).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss payment notice" })).toBeNull();
      // Forgotten for good: the next order the buyer changes is "not charged".
      await press("Done");
      await press("open event");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toContain("changed");
      expect(out("order-notice")).not.toContain("(may have been charged)");
    });

    it("the server says 'requires_payment_method' while a confirm of ours is still out on the earlier order → not settled: the reminder stays", async () => {
      await payALaterOrder(
        async () => ({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_payment_method",
        }),
        async () => {
          await press("confirm is still out");
        },
      );
      expect(screen.getByText(copy.embedEarlierOrderUnknown)).toBeTruthy();
    });

    it.each([
      [
        "throws",
        async (): Promise<ServerAnswer> => {
          throw new TypeError("Failed to fetch");
        },
      ],
      [
        "says the earlier payment still needs the buyer",
        async (): Promise<ServerAnswer> => ({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_action",
        }),
      ],
    ])(
      "the server %s → the reminder is kept over the confirmation, saying it is about an earlier order; asked once",
      async (_what, earlier) => {
        await payALaterOrder(earlier);

        expect(screen.getByText(copy.embedEarlierOrderUnknown)).toBeTruthy();
        expect(askedAbout().filter((secret) => secret === firstIntent)).toHaveLength(1);
        // And after Done, where it reads as before.
        await press("Done");
        expect(screen.getByText(copy.embedPaymentOutcomeUnknown)).toBeTruthy();
      },
    );

    it("'requires_payment_method' after the confirm that was still out has ended unpaid → settled: the record is forgotten", async () => {
      await payALaterOrder(
        async () => ({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_payment_method",
        }),
        async () => {
          await press("confirm is still out");
          await press("late confirm ends unpaid");
        },
      );
      await tick(0);
      expect(screen.queryByText(copy.embedEarlierOrderUnknown)).toBeNull();
      expect(screen.queryByRole("button", { name: "Dismiss payment notice" })).toBeNull();
    });

    describe("several earlier orders", () => {
      /** Four orders left with an unknown outcome, and a fifth on the payment step. */
      const fourEarlierOrders = async () => {
        await orderOnThePaymentStep();
        const earlier: string[] = [];
        for (let left = 0; left < 4; left += 1) {
          earlier.push(out("payment-intent") ?? "");
          await press("outcome unknown");
          await press("checkout back");
          await press("add a ticket");
          await press("continue to checkout");
          await press("create the order");
        }
        return { earlier, page: out("payment-intent") ?? "" };
      };

      it("are asked about one at a time, three at most: the page's own order keeps its share of the budget", async () => {
        const { earlier, page } = await fourEarlierOrders();
        const answers: Array<(value: ServerAnswer) => void> = [];
        server.confirm.mockImplementation(
          ({ clientSecret }: { clientSecret: string }) =>
            clientSecret === page
              ? Promise.resolve({ outcome: "confirmed", orderId: "order-for-5" })
              : new Promise<ServerAnswer>((resolve) => {
                  answers.push(resolve);
                }),
        );

        await press("pay in page");
        expect(out("confirmation")).toBe("order-for-5");
        // One earlier order is out; the next waits for its answer.
        expect(askedAbout().filter((secret) => earlier.includes(secret))).toHaveLength(1);

        for (let asked = 0; asked < 4; asked += 1) {
          await act(async () => {
            answers[asked]?.({
              outcome: "not_paid",
              orderId: "earlier",
              paymentIntentStatus: "requires_action",
            });
          });
        }
        expect(askedAbout().filter((secret) => earlier.includes(secret))).toHaveLength(3);
        expect(screen.getByText(copy.embedEarlierOrderUnknown)).toBeTruthy();
      });

      it("the first 429 stops the asking: no further calls, and every record stays as it was", async () => {
        const { earlier, page } = await fourEarlierOrders();
        server.confirm.mockImplementation(
          async ({ clientSecret }: { clientSecret: string }) => {
            if (clientSecret === page) {
              return { outcome: "confirmed", orderId: "order-for-5" };
            }
            throw refusal("TOO_MANY_REQUESTS");
          },
        );

        await press("pay in page");
        await tick(0);

        expect(out("confirmation")).toBe("order-for-5");
        expect(askedAbout().filter((secret) => earlier.includes(secret))).toHaveLength(1);
        // Still unknown, still said: never read as "not charged".
        expect(screen.getByText(copy.embedEarlierOrderUnknown)).toBeTruthy();
        await press("Done");
        await press("open event");
        await press("add a ticket");
        await press("continue to checkout");
        await press("create the order");
        await press("checkout back");
        await press("add a ticket");
        expect(out("order-notice")).toContain("(may have been charged)");
      });
    });

    it("an earlier order's answer that lands after Done does not move the page", async () => {
      let answerEarlier: (value: ServerAnswer) => void = () => undefined;
      await payALaterOrder(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            answerEarlier = resolve;
          }),
      );
      await press("Done");
      expect(screen.getByTestId("grid")).toBeTruthy();

      await act(async () => {
        answerEarlier({ outcome: "confirmed", orderId: "order-for-1" });
      });

      expect(screen.getByTestId("grid")).toBeTruthy();
      expect(screen.queryByTestId("confirmation")).toBeNull();
      expect(screen.getByText(copy.embedEarlierOrderPaid)).toBeTruthy();
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
    });
  });
});

describe("EmbedWidget — an order the buyer leaves is released on the server", () => {
  // Owner ruling 2026-10-11: "A guest can release it." The widget asks the
  // server to cancel an order it leaves behind, so its tickets go back on
  // sale at once instead of staying reserved until the server's clean-up.
  // It never asks for an order a payment may have gone through on, and what
  // it tells the buyer is true to what the server answered.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const TEN_MINUTES = 10 * 60_000;
  const RELEASE_WAIT = 10_000;
  const EARLIER = "(earlier order reserved)";
  const LET_GO = "(earlier order released)";

  /** Grid → detail with one ticket → the checkout's details step. */
  const onTheDetailsStep = async () => {
    checkoutMock.reservedForMs = TEN_MINUTES;
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
  };
  /** An order for one ticket on the payment step. Answers its client secret. */
  const orderOnThePaymentStep = async (): Promise<string> => {
    await onTheDetailsStep();
    await press("create the order");
    return out("payment-intent") ?? "";
  };
  /** Every release stays out until the test answers it (in the order sent). */
  const releasesStayOut = () => {
    const answer: Array<(result: ReleaseAnswer) => void> = [];
    const refuse: Array<(error: unknown) => void> = [];
    server.release.mockImplementation(
      () =>
        new Promise<ReleaseAnswer>((resolve, reject) => {
          answer.push(resolve);
          refuse.push(reject);
        }),
    );
    return { answer, refuse };
  };
  /** A refusal as the server sends it: `data.code` and `data.appCode`. */
  const refusal = (code: string, appCode?: string) =>
    Object.assign(new Error(appCode ?? code), {
      data: { code, ...(appCode ? { appCode } : {}) },
    });
  const stripeSays = (status: string) => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({ paymentIntent: { status } });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    serverReleases("released");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the release goes out like the confirm does: no retry, and no global 'Action failed' toast", async () => {
    await onTheDetailsStep();
    expect(server.releaseOptions).toEqual({
      retry: false,
      meta: { silent: true },
    });
  });

  describe("when it is sent: once, for the order that was left", () => {
    it("a changed cart", async () => {
      const secret = await orderOnThePaymentStep();
      await press("checkout back");
      expect(server.release).not.toHaveBeenCalled();

      await press("add a ticket");

      expect(server.release.mock.calls).toEqual([
        [
          {
            embedId: "embed-1",
            hostOrigin: "https://host.example",
            clientSecret: secret,
          },
        ],
      ]);
      // Further changes to the cart are not further orders to release.
      await press("add a ticket");
      await press("remove a ticket");
      expect(server.release).toHaveBeenCalledTimes(1);
    });

    it("a cart update from the checkout that changes what is bought", async () => {
      const secret = await orderOnThePaymentStep();

      await press("the update drops a ticket");

      expect(releasedSecrets()).toEqual([secret]);
    });

    it("the host origin is computed when the release is sent, as for the confirm", async () => {
      const secret = await orderOnThePaymentStep();
      hostOrigin.value = null;

      await press("the update drops a ticket");

      expect(server.release.mock.calls[0]?.[0]).toEqual({
        embedId: "embed-1",
        hostOrigin: null,
        clientSecret: secret,
      });
    });

    it("opening another event", async () => {
      const secret = await orderOnThePaymentStep();
      await press("checkout back");
      await press("back to the events");
      expect(server.release).not.toHaveBeenCalled();

      await press("open another event");

      expect(releasedSecrets()).toEqual([secret]);
    });

    it("opening another date of the series", async () => {
      const secret = await orderOnThePaymentStep();
      await press("checkout back");

      await press("another date");

      expect(releasedSecrets()).toEqual([secret]);
    });

    it("an order that lands after the cart changed: it was never the page's, and is released as it lands", async () => {
      await onTheDetailsStep();
      const key = out("client-key");
      await press("start creating the order");
      await press("checkout back");
      await press("add a ticket");
      expect(server.release).not.toHaveBeenCalled();

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(releasedSecrets()).toEqual([`pi_for_1_secret_${key}`]);
    });

    it("an order asked for under an email the buyer then corrected, landing late (an email change discards no order by itself)", async () => {
      await onTheDetailsStep();
      await press("email typed wrong");
      const typoKey = out("client-key");
      await press("start creating the order");
      await press("email put right");
      expect(server.release).not.toHaveBeenCalled();

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(releasedSecrets()).toEqual([
        `pi_for_1_for_typo@example.com_secret_${typoKey}`,
      ]);
    });

    it("an order asked for before a promo code was applied, landing late (a promo change discards no order by itself)", async () => {
      await onTheDetailsStep();
      const firstKey = out("client-key");
      await press("start creating the order");
      await press("apply a promo code");
      expect(server.release).not.toHaveBeenCalled();

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(releasedSecrets()).toEqual([`pi_for_1_secret_${firstKey}`]);
    });

    it("a late order that lands behind the one the buyer is paying: released, and the order on screen is not", async () => {
      await onTheDetailsStep();
      await press("email typed wrong");
      const typoKey = out("client-key");
      await press("start creating the order");
      await press("email put right");
      await press("create the order");
      const onScreen = out("payment-intent");
      // Its payment is in flight: that is about the order on screen only.
      await press("confirm starts");

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(releasedSecrets()).toEqual([
        `pi_for_1_for_typo@example.com_secret_${typoKey}`,
      ]);
      expect(out("payment-intent")).toBe(onScreen);
    });

    it("a reservation that ran out with no payment tried", async () => {
      const secret = await orderOnThePaymentStep();

      await tick(TEN_MINUTES);

      expect(out("payment-intent")).toBe("none");
      expect(releasedSecrets()).toEqual([secret]);
      expect(out("order-notice")).toBe(`expired ${LET_GO}`);
    });

    it("a reservation that ran out on a payment nobody could confirm, once Stripe says it was not paid", async () => {
      stripeSays("requires_payment_method");
      const secret = await orderOnThePaymentStep();
      await press("outcome unknown");
      expect(server.release).not.toHaveBeenCalled();

      await tick(TEN_MINUTES);

      // Settled as not charged in the same tick that discards the order.
      expect(releasedSecrets()).toEqual([secret]);
      expect(out("order-notice")).toBe(`expired ${LET_GO}`);
    });

    it("the same order answered a second time after it was released is not released, or remembered, again", async () => {
      await onTheDetailsStep();
      // Two requests for one order: the server replays the first.
      await press("start creating the order");
      await press("create the order");
      const secret = out("payment-intent");
      await press("the update drops a ticket");
      expect(releasedSecrets()).toEqual([secret]);

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(server.release).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(EARLIER)).toBeNull();
    });
  });

  describe("when it is NOT sent", () => {
    it("plain Back from payment keeps the order: its tickets stay the buyer's while they look again", async () => {
      const secret = await orderOnThePaymentStep();

      await press("checkout back");
      await press("continue to checkout");

      expect(server.release).not.toHaveBeenCalled();
      expect(out("payment-intent")).toBe(secret);
    });

    it("a re-quote (new prices, the same purchase) keeps the order", async () => {
      await orderOnThePaymentStep();

      await press("re-quote the cart");

      expect(server.release).not.toHaveBeenCalled();
    });

    it("Stripe says the order's PaymentIntent is canceled: the server let it go already", async () => {
      await orderOnThePaymentStep();

      await press("stripe says canceled");

      expect(out("order-notice")).toBe("expired");
      expect(server.release).not.toHaveBeenCalled();
    });

    it("a free order: no PaymentIntent, complete as created, nothing to release", async () => {
      await onTheDetailsStep();
      checkoutMock.free = true;
      await press("create the order");
      expect(out("confirmation")).toBe("free-order-for-1");

      await press("Done");

      expect(server.release).not.toHaveBeenCalled();
    });

    it("an order that was paid for: not when it completes, not on Done, not when its reservation time passes", async () => {
      await orderOnThePaymentStep();
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-1");

      await tick(TEN_MINUTES + 5000);
      await press("Done");

      expect(server.release).not.toHaveBeenCalled();
    });

    it.each(["visibilitychange", "pagehide", "beforeunload", "blur"] as const)(
      "the page is hidden or left (%s): a buyer away at their bank must not have their payment cancelled",
      async (event) => {
        const secret = await orderOnThePaymentStep();
        const hidden = vi
          .spyOn(document, "visibilityState", "get")
          .mockReturnValue("hidden");
        try {
          await act(async () => {
            document.dispatchEvent(new Event(event));
            window.dispatchEvent(new Event(event));
          });
          await tick(60_000);
        } finally {
          hidden.mockRestore();
        }

        expect(server.release).not.toHaveBeenCalled();
        expect(out("payment-intent")).toBe(secret);
      },
    );

    it("the widget is taken off the page with an order on it", async () => {
      checkoutMock.reservedForMs = TEN_MINUTES;
      const { unmount } = render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await press("open event");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");

      unmount();
      await tick(60_000);

      expect(server.release).not.toHaveBeenCalled();
    });
  });

  describe("the gate: an order a payment may have gone through on is never offered for release", () => {
    it("a confirm that ended with no known outcome → nothing sent; the buyer is told what they were told before", async () => {
      await orderOnThePaymentStep();
      await press("outcome unknown");

      await press("checkout back");
      await press("add a ticket");

      expect(server.release).not.toHaveBeenCalled();
      expect(out("order-notice")).toBe(
        `changed (may have been charged) ${EARLIER}`,
      );
    });

    it("a confirm that is still out (it may yet land a charge) → nothing sent", async () => {
      await orderOnThePaymentStep();
      await press("confirm is still out");

      await press("the update drops a ticket");

      expect(out("payment-intent")).toBe("none");
      expect(server.release).not.toHaveBeenCalled();
      expect(out("order-notice")).toContain(EARLIER);
    });

    it("a payment confirm in flight for the order → nothing sent", async () => {
      await orderOnThePaymentStep();
      await press("confirm starts");

      await press("the update drops a ticket");

      expect(out("payment-intent")).toBe("none");
      expect(server.release).not.toHaveBeenCalled();
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    });

    it("a confirm reported in the same tick the order is left, before any render → nothing sent", async () => {
      await orderOnThePaymentStep();

      // One handler, one tick: no render between the report and the discard.
      await press("confirm starts and the order is left in the same tick");

      expect(out("payment-intent")).toBe("none");
      expect(server.release).not.toHaveBeenCalled();
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    });

    it("Stripe said 'paid' and the server is being asked about the order → nothing sent", async () => {
      server.confirm.mockImplementation(() => new Promise(() => undefined));
      await orderOnThePaymentStep();
      await press("pay in page");
      expect(out("is-confirming")).toBe("true");

      await press("the update drops a ticket");

      expect(server.release).not.toHaveBeenCalled();
    });

    it("Stripe says 'paid' at the reservation's end → the server is asked to confirm the order, never to release it", async () => {
      stripeSays("succeeded");
      server.confirm.mockImplementation(() => new Promise(() => undefined));
      await orderOnThePaymentStep();
      await press("outcome unknown");

      await tick(TEN_MINUTES);

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(server.release).not.toHaveBeenCalled();
    });

    it("the reservation ran out and Stripe could not be asked → the order goes with its outcome unknown, and nothing is sent", async () => {
      await orderOnThePaymentStep();
      await press("outcome unknown");

      await tick(TEN_MINUTES);

      expect(out("payment-intent")).toBe("none");
      expect(server.release).not.toHaveBeenCalled();
      expect(out("order-notice")).toBe(
        `expired (may have been charged) ${EARLIER}`,
      );
    });

    it("an order the server has said was paid for → nothing sent when its own late answer lands", async () => {
      await onTheDetailsStep();
      // Two requests for one order; the second answer comes much later.
      await press("start creating the order");
      await press("create the order");
      const first = out("payment-intent");
      await press("outcome unknown");
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      // The second order completes, and the server says the first was paid.
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-2");
      expect(
        server.confirm.mock.calls.map(
          ([input]) => (input as { clientSecret: string }).clientSecret,
        ),
      ).toContain(first);
      expect(
        screen.getByText(checkoutCopy("embedEarlierOrderPaid")),
      ).toBeTruthy();

      await act(async () => {
        checkoutMock.pendingCreates[0]?.();
      });

      expect(server.release).not.toHaveBeenCalled();
    });

    it("the control is not offered for an order a payment may have gone through on", async () => {
      await orderOnThePaymentStep();
      await press("outcome unknown");

      await press("checkout back");

      expect(screen.getByTestId("reserved-notice")).toBeTruthy();
      expect(
        screen.queryByRole("button", { name: "let these tickets go" }),
      ).toBeNull();
    });
  });

  describe("what the buyer is told about the order they left", () => {
    it.each(["released", "gone"] as const)(
      "while the release is out nothing is said of its tickets; '%s' → they are back on sale, and nothing is remembered as reserved",
      async (outcome) => {
        const { answer } = releasesStayOut();
        await orderOnThePaymentStep();
        await press("checkout back");

        await press("add a ticket");

        // No sentence that would be gone a second later.
        expect(out("order-notice")).toBe("changed");
        await tick(RELEASE_WAIT - 1000);
        expect(out("order-notice")).toBe("changed");

        await act(async () => {
          answer[0]?.({ outcome, orderId: "order-for-1" });
        });

        expect(out("order-notice")).toBe(`changed ${LET_GO}`);
        await press("continue to checkout");
        expect(out("earlier-note")).toBe("false");
        // Not an hour later either: there is no reservation to run out.
        await tick(80 * 60_000);
        expect(out("order-notice")).toBe(`changed ${LET_GO}`);
        expect(out("earlier-note")).toBe("false");
      },
    );

    it("'kept' → today's wait copy, no error, and the server is asked once what became of the order", async () => {
      serverReleases("kept");
      server.confirm.mockImplementation(async () => ({
        outcome: "not_paid",
        orderId: "order-for-1",
        paymentIntentStatus: "requires_payment_method",
      }));
      const secret = await orderOnThePaymentStep();
      await press("checkout back");

      await press("add a ticket");

      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      expect(server.confirm.mock.calls).toEqual([
        [
          {
            embedId: "embed-1",
            hostOrigin: "https://host.example",
            clientSecret: secret,
          },
        ],
      ]);
      // "Not paid" leaves no record behind: no reminder that was not already
      // showing, and the widget may still say "not charged" (the notice was
      // not told "may have been charged").
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Dismiss payment notice" }),
      ).toBeNull();
      expect(
        screen.queryByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeNull();
      await press("continue to checkout");
      expect(out("checkout-error")).toBe("");
      expect(out("earlier-note")).toBe("true");
    });

    it("'kept' and the server cannot say what became of it → never 'not charged': the order's outcome is unknown, the buyer is reminded to check their email, and it is not offered for release again", async () => {
      // The server refused to cancel, and "it is paid" is one of its reasons.
      serverReleases("kept");
      server.confirm.mockImplementation(async () => {
        throw new TypeError("Failed to fetch");
      });
      const secret = await orderOnThePaymentStep();
      await press("checkout back");

      await press("add a ticket");
      await tick(30_000);

      expect(server.confirm).toHaveBeenCalledTimes(1);
      expect(out("order-notice")).toBe(
        `changed (may have been charged) ${EARLIER}`,
      );
      expect(
        screen.getByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();

      // One release was sent for it, and the record now keeps the gate shut
      // for another (the control's side of this is tested further down).
      expect(releasedSecrets()).toEqual([secret]);

      // And it is asked about again when a later order completes.
      server.confirm.mockImplementation(async (input: { clientSecret: string }) =>
        input.clientSecret === secret
          ? {
              outcome: "not_paid",
              orderId: "order-for-1",
              paymentIntentStatus: "canceled",
            }
          : { outcome: "confirmed", orderId: "order-for-2" },
      );
      serverReleases("released");
      await press("continue to checkout");
      await press("create the order");
      await press("pay in page");

      expect(out("confirmation")).toBe("order-for-2");
      expect(
        server.confirm.mock.calls.filter(
          ([input]) => (input as { clientSecret: string }).clientSecret === secret,
        ),
      ).toHaveLength(2);
      // Settled as not charged: the reminder goes.
      expect(
        screen.queryByText(checkoutCopy("embedEarlierOrderUnknown")),
      ).toBeNull();
    });

    it("'kept', no answer in time, then 'not paid' arrives late → the record it started is settled, and the reminder goes", async () => {
      serverReleases("kept");
      let answerLate: (answer: ServerAnswer) => void = () => undefined;
      server.confirm.mockImplementation(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            answerLate = resolve;
          }),
      );
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      // Not yet: the server is still being asked.
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);

      await tick(20_000);
      expect(out("order-notice")).toBe(
        `changed (may have been charged) ${EARLIER}`,
      );

      await act(async () => {
        answerLate({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_payment_method",
        });
      });

      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      expect(
        screen.queryByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeNull();
    });

    it("a release nobody answered, answered 'released' after all → the wait copy gives way to 'back on sale'", async () => {
      const { answer } = releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      await tick(RELEASE_WAIT);
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(out("order-notice")).toBe(`changed ${LET_GO}`);
      await press("continue to checkout");
      expect(out("earlier-note")).toBe("false");
      expect(server.release).toHaveBeenCalledTimes(1);
    });

    it("a release nobody answered, answered 'kept' after all → nothing changes, and the server is not asked", async () => {
      const { answer } = releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      await tick(RELEASE_WAIT);

      await act(async () => {
        answer[0]?.({ outcome: "kept", orderId: "order-for-1" });
      });

      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      expect(server.confirm).not.toHaveBeenCalled();
    });

    it("Done after a purchase keeps the memory of an order that is still reserved; only 'back on sale' is dropped", async () => {
      // Order A is not released (the call fails), order B is paid for.
      releaseFailsInTransit();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      await press("continue to checkout");
      await press("create the order");
      await press("pay in page");
      expect(out("confirmation")).toBe("order-for-2");

      await press("Done");
      await press("open event");

      // No "released" or "gone" answer ever came for A.
      expect(out("order-notice")).toBe(EARLIER);
    });

    it.each([
      ["confirmed", "embedEarlierOrderPaid"],
      ["processing", "embedEarlierOrderClearing"],
    ] as const)(
      "'kept' because it was paid for (the server says %s) → the buyer is told that payment went through, and never 'not charged'",
      async (serverSaid, copyKey) => {
        serverReleases("kept");
        server.confirm.mockImplementation(async () => ({
          outcome: serverSaid,
          orderId: "order-for-1",
        }));
        await orderOnThePaymentStep();
        await press("checkout back");

        await press("add a ticket");

        expect(screen.getByText(checkoutCopy(copyKey))).toBeTruthy();
        expect(out("order-notice")).toBe(
          `changed (may have been charged) ${EARLIER}`,
        );
        // The page did not move, and the host page was told of no sale.
        expect(screen.getByTestId("event-detail")).toBeTruthy();
        expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
      },
    );

    it("nobody answers → after the wait, today's wait copy; no error", async () => {
      releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toBe("changed");

      await tick(RELEASE_WAIT);

      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      expect(server.release).toHaveBeenCalledTimes(1);
      expect(server.confirm).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(trace.labels).toContain("embed.releaseOrderTimedOut");
    });

    it.each([
      ["not this embed's order", "CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH"],
      ["the page may not host this embed", "FORBIDDEN", "EMBED_ORIGIN_NOT_ALLOWED"],
      ["no such embed", "NOT_FOUND", "EMBED_NOT_FOUND"],
      ["the budget is spent", "TOO_MANY_REQUESTS", undefined],
      ["the order's own budget is spent", "TOO_MANY_REQUESTS", "RATE_LIMITED"],
      ["a malformed input", "BAD_REQUEST", undefined],
    ] as const)(
      "the server refuses (%s) → today's wait copy, no error, one call, and the server is not asked about the order",
      async (_what, code, appCode) => {
        server.release.mockImplementation(async () => {
          throw refusal(code, appCode);
        });
        await orderOnThePaymentStep();
        await press("checkout back");

        await press("add a ticket");

        expect(out("order-notice")).toBe(`changed ${EARLIER}`);
        expect(server.release).toHaveBeenCalledTimes(1);
        expect(server.confirm).not.toHaveBeenCalled();
        expect(screen.queryByRole("alert")).toBeNull();
        await press("continue to checkout");
        expect(out("checkout-error")).toBe("");
        expect(trace.labels).toContain("embed.releaseOrderFailed");
      },
    );

    it("releasing one order does not erase the memory of another still reserved for the same event", async () => {
      // Order A is not released (the call fails); order B is.
      releaseFailsInTransit();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      await press("continue to checkout");
      await press("create the order");
      serverReleases("released");

      await press("checkout back");
      await press("add a ticket");

      expect(server.release).toHaveBeenCalledTimes(2);
      // A's tickets are still reserved, and that is what is said: "back on
      // sale" beside it would read as a contradiction.
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      await press("continue to checkout");
      expect(out("earlier-note")).toBe("true");
    });

    it("the other way round: A released, B not → B's reservation is said, from B's own time", async () => {
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toBe(`changed ${LET_GO}`);
      await press("continue to checkout");
      await tick(60_000);
      await press("create the order");
      releaseFailsInTransit();

      await press("checkout back");
      await press("add a ticket");

      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
      // B was created a minute after A: 10 to pay, then 65 on the server.
      await tick(TEN_MINUTES + 65 * 60_000 - 1000);
      expect(out("order-notice")).toBe(`changed ${EARLIER}`);
    });

    it("a new order for the event: nothing left to say about the one that was released", async () => {
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      expect(out("order-notice")).toBe(`changed ${LET_GO}`);
      await press("continue to checkout");

      await press("create the order");
      await press("checkout back");

      expect(screen.queryByTestId("order-notice")).toBeNull();
    });

    it("leaving the event and coming back after its order was released: nothing is said of it", async () => {
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("back to the events");
      await press("open another event");
      expect(server.release).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("order-notice")).toBeNull();

      await press("back to the events");
      await press("open event");

      expect(screen.queryByTestId("order-notice")).toBeNull();
      await press("add a ticket");
      await press("continue to checkout");
      expect(out("earlier-note")).toBe("false");
    });

    it("an answer that lands after the widget is gone changes nothing", async () => {
      const { answer } = releasesStayOut();
      checkoutMock.reservedForMs = TEN_MINUTES;
      const { unmount } = render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await press("open event");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      await press("the update drops a ticket");
      unmount();

      await act(async () => {
        answer[0]?.({ outcome: "kept", orderId: "order-for-1" });
      });

      // Not even the ask that follows "kept".
      expect(server.confirm).not.toHaveBeenCalled();
    });
  });

  describe("the next order waits for a release that is still out", () => {
    it("Continue right after a changed cart: the checkout's wait ends when the release is answered", async () => {
      const { answer } = releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");

      await press("continue waits for releases");

      expect(checkoutMock.releaseWaits).toEqual({ started: 1, ended: 0 });
      await tick(RELEASE_WAIT - 1000);
      expect(checkoutMock.releaseWaits.ended).toBe(0);

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(checkoutMock.releaseWaits.ended).toBe(1);
    });

    it("a release nobody answers holds the next order for the release's own wait, and no longer", async () => {
      releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");
      await press("continue waits for releases");

      await tick(RELEASE_WAIT - 1);
      expect(checkoutMock.releaseWaits.ended).toBe(0);
      await tick(1);

      expect(checkoutMock.releaseWaits.ended).toBe(1);
    });

    it("a release that was refused does not stop the next order", async () => {
      server.release.mockImplementation(async () => {
        throw refusal("CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH");
      });
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");

      await press("continue waits for releases");

      expect(checkoutMock.releaseWaits).toEqual({ started: 1, ended: 1 });
    });

    it("with no release out, there is nothing to wait for", async () => {
      await onTheDetailsStep();

      await press("continue waits for releases");

      expect(checkoutMock.releaseWaits).toEqual({ started: 1, ended: 1 });
    });

    it("a release still out for ANOTHER event does not hold this one's order", async () => {
      releasesStayOut();
      await orderOnThePaymentStep();
      await press("checkout back");
      await press("back to the events");
      await press("open another event");
      expect(server.release).toHaveBeenCalledTimes(1);
      await press("add a ticket");
      await press("continue to checkout");

      await press("continue waits for releases");

      expect(checkoutMock.releaseWaits).toEqual({ started: 1, ended: 1 });
    });
  });

  describe("the control: 'Let these tickets go'", () => {
    const letGo = () =>
      screen.getByRole("button", { name: "let these tickets go" });
    /** Back on the event detail with the order waiting. Answers its secret. */
    const backOnTheEvent = async (): Promise<string> => {
      const secret = await orderOnThePaymentStep();
      await press("card declined");
      await press("checkout back");
      return secret;
    };

    it("is offered beside the reserved notice, and nothing is sent until it is pressed", async () => {
      await backOnTheEvent();

      expect(screen.getByTestId("reserved-notice")).toBeTruthy();
      expect(letGo().getAttribute("aria-disabled")).toBeNull();
      expect(out("let-go-state")).toBe("idle");
      expect(server.release).not.toHaveBeenCalled();
    });

    it("pressed: one call for the order on the page; busy and aria-disabled while it is out; a second press sends nothing", async () => {
      releasesStayOut();
      const secret = await backOnTheEvent();

      await press("let these tickets go");

      expect(releasedSecrets()).toEqual([secret]);
      expect(out("let-go-state")).toBe("letting go");
      expect(letGo().getAttribute("aria-disabled")).toBe("true");
      // The order is still the page's until the server answers.
      expect(screen.getByTestId("reserved-notice")).toBeTruthy();

      await press("let these tickets go");
      await press("let go, pressed again at once");

      expect(server.release).toHaveBeenCalledTimes(1);
    });

    it("two presses in one tick, before any render: one call", async () => {
      releasesStayOut();
      await backOnTheEvent();

      await act(async () => {
        const button = screen.getByRole("button", {
          name: "let go, pressed again at once",
        });
        fireEvent.click(button);
        fireEvent.click(button);
      });

      expect(server.release).toHaveBeenCalledTimes(1);
    });

    it.each(["released", "gone"] as const)(
      "'%s' → the order leaves the page as a discarded one does, nothing is remembered as reserved, and the buyer is told",
      async (outcome) => {
        serverReleases(outcome);
        const secret = await backOnTheEvent();
        letGo().focus();

        await press("let these tickets go");

        expect(screen.queryByTestId("reserved-notice")).toBeNull();
        expect(out("order-notice")).toBe("released");
        // The control is gone; focus went to the notice, not to <body>.
        expect(document.activeElement).toBe(screen.getByTestId("order-notice"));
        await press("continue to checkout");
        expect(out("payment-intent")).toBe("none");
        expect(out("checkout-step")).toBe("details");
        // A fresh key, and the old order's decline is not carried over.
        expect(secret.endsWith(`_secret_${out("client-key") ?? ""}`)).toBe(false);
        expect(out("checkout-error")).toBe("");
        expect(out("earlier-note")).toBe("false");
        expect(out("order-notice")).toBe("released");
        // The same tickets again: a new order, and nothing more to say.
        await press("create the order");
        expect(out("payment-intent")).not.toBe(secret);
        expect(out("payment-intent")).not.toBe("none");
        expect(screen.queryByTestId("order-notice")).toBeNull();
        expect(server.release).toHaveBeenCalledTimes(1);
      },
    );

    it("released while a payment on ANOTHER order is unsettled: still said, without 'not charged' (the notice is told)", async () => {
      // Order A: outcome unknown, left by a changed cart (not released).
      await orderOnThePaymentStep();
      await press("outcome unknown");
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      const second = out("payment-intent");
      await press("checkout back");

      await press("let these tickets go");

      expect(releasedSecrets()).toEqual([second]);
      expect(out("order-notice")).toBe(
        `released (may have been charged) ${EARLIER}`,
      );
    });

    it("focus the buyer has moved elsewhere during the wait is left where they put it", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");
      const elsewhere = screen.getByRole("button", { name: "add a ticket" });
      elsewhere.focus();

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(out("order-notice")).toBe("released");
      expect(document.activeElement).toBe(elsewhere);
    });

    it.each([
      ["the server kept the order", () => serverReleases("kept")],
      ["the call failed in transit", () => releaseFailsInTransit()],
      [
        "the server refused",
        () =>
          server.release.mockImplementation(async () => {
            throw refusal("CONFLICT", "PAYMENT_INTENT_ORDER_MISMATCH");
          }),
      ],
    ] as const)(
      "not released (%s) → the order STAYS the page's, still payable; the notice says so and the control is back",
      async (_what, arrange) => {
        arrange();
        server.confirm.mockImplementation(async () => ({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_payment_method",
        }));
        const secret = await backOnTheEvent();

        await press("let these tickets go");

        expect(out("let-go-state")).toBe("not let go");
        expect(letGo().getAttribute("aria-disabled")).toBeNull();
        expect(screen.getByTestId("reserved-notice")).toBeTruthy();
        expect(screen.queryByTestId("order-notice")).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
        await press("continue to checkout");
        expect(out("payment-intent")).toBe(secret);
        expect(out("checkout-step")).toBe("payment");
        expect(out("earlier-note")).toBe("false");
      },
    );

    it("nobody answers → after the wait the control is back, with the same line; pressing again sends a second call and clears it", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");

      await tick(RELEASE_WAIT);

      expect(out("let-go-state")).toBe("not let go");
      await press("let these tickets go");
      expect(server.release).toHaveBeenCalledTimes(2);
      expect(out("let-go-state")).toBe("letting go");

      await act(async () => {
        answer[1]?.({ outcome: "released", orderId: "order-for-1" });
      });
      expect(out("order-notice")).toBe("released");
    });

    it("a press nobody answered, answered 'released' after all → the order leaves the page then, and the buyer is told; never a payment form for a cancelled order", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      letGo().focus();
      await press("let these tickets go");
      await tick(RELEASE_WAIT);
      expect(out("let-go-state")).toBe("not let go");
      expect(screen.getByTestId("reserved-notice")).toBeTruthy();

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(screen.queryByTestId("reserved-notice")).toBeNull();
      expect(out("order-notice")).toBe("released");
      expect(document.activeElement).toBe(screen.getByTestId("order-notice"));
      await press("continue to checkout");
      expect(out("payment-intent")).toBe("none");
      expect(out("checkout-step")).toBe("details");
    });

    it("a late 'released' while the buyer is paying that order: the form is not pulled from under the confirm", async () => {
      const { answer } = releasesStayOut();
      const secret = await backOnTheEvent();
      await press("let these tickets go");
      await tick(RELEASE_WAIT);
      await press("continue to checkout");
      await press("confirm starts");

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(out("payment-intent")).toBe(secret);
      expect(out("is-paying")).toBe("true");
    });

    it("an answer that lands after the widget is gone, late or not, does nothing", async () => {
      const { answer } = releasesStayOut();
      checkoutMock.reservedForMs = TEN_MINUTES;
      const { unmount } = render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await press("open event");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      await press("checkout back");
      await press("let these tickets go");
      await tick(RELEASE_WAIT);
      unmount();

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(trace.labels).not.toContain("embed.settleReleaseThrew");
    });

    it("'kept' and the server cannot say what became of the order → the control is withdrawn and the buyer is reminded to check their email; the order stays payable", async () => {
      serverReleases("kept");
      server.confirm.mockImplementation(async () => {
        throw new TypeError("Failed to fetch");
      });
      const secret = await backOnTheEvent();

      await press("let these tickets go");
      await tick(30_000);

      expect(
        screen.queryByRole("button", { name: "let these tickets go" }),
      ).toBeNull();
      expect(
        screen.getByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeTruthy();
      await press("continue to checkout");
      expect(out("payment-intent")).toBe(secret);
      // A changed cart does not send a second release for it either.
      await press("the update drops a ticket");
      expect(server.release).toHaveBeenCalledTimes(1);
    });

    it("'kept', the ask unanswered, the buyer then pays and that outcome is unknown → the first ask's late 'not paid' does not erase the record the payment now stands on", async () => {
      serverReleases("kept");
      const answerLate: ((answer: ServerAnswer) => void)[] = [];
      server.confirm.mockImplementation(
        () =>
          new Promise<ServerAnswer>((resolve) => {
            answerLate.push(resolve);
          }),
      );
      const secret = await backOnTheEvent();
      await press("let these tickets go");
      // The ask goes unanswered: the record starts.
      await tick(30_000);
      expect(
        screen.getByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeTruthy();

      // The order is still payable. The buyer pays; nobody can say how it
      // ended. The record is the same record, now for a different reason.
      await press("continue to checkout");
      expect(out("payment-intent")).toBe(secret);
      await press("outcome unknown");

      // The first ask answers, from before the charge.
      await act(async () => {
        answerLate[0]?.({
          outcome: "not_paid",
          orderId: "order-for-1",
          paymentIntentStatus: "requires_payment_method",
        });
      });

      expect(
        screen.getByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeTruthy();
      // And the order is still not one to release, or to call uncharged.
      await press("checkout back");
      await press("add a ticket");
      expect(server.release).toHaveBeenCalledTimes(1);
      expect(out("order-notice")).toContain("(may have been charged)");
    });

    it("a release nobody answered, the buyer pays with an unknown outcome, then 'released' arrives late → the server has cancelled that payment: the reminder to check their email goes", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");
      await tick(RELEASE_WAIT);
      await press("continue to checkout");
      await press("outcome unknown");
      expect(
        screen.getByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeTruthy();

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(
        screen.queryByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeNull();
      expect(out("order-notice")).not.toContain("(may have been charged)");
    });

    it("Continue pressed while the release is out, then the tickets changed → the buyer is not carried to a checkout they did not ask for", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");
      await press("continue to checkout");
      await press("continue to checkout");

      await press("add a ticket");
      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(screen.getByTestId("event-detail")).toBeTruthy();
      expect(screen.queryByTestId("payment-intent")).toBeNull();
      // And a kept Continue is spent: the next press goes at once.
      await press("continue to checkout");
      expect(out("checkout-step")).toBe("details");
    });

    it("'kept' → the server is asked once about the order; 'not paid' changes nothing on the page", async () => {
      serverReleases("kept");
      server.confirm.mockImplementation(async () => ({
        outcome: "not_paid",
        orderId: "order-for-1",
        paymentIntentStatus: "requires_payment_method",
      }));
      const secret = await backOnTheEvent();

      await press("let these tickets go");

      expect(
        server.confirm.mock.calls.map(
          ([input]) => (input as { clientSecret: string }).clientSecret,
        ),
      ).toEqual([secret]);
      expect(screen.getByTestId("event-detail")).toBeTruthy();
      expect(letGo()).toBeTruthy();
      expect(
        screen.queryByText(checkoutCopy("embedPaymentOutcomeUnknown")),
      ).toBeNull();
    });

    it("'kept' because the page's own order was paid for → its confirmation, never a payable order left on the page", async () => {
      serverReleases("kept");
      const secret = await backOnTheEvent();

      // The default server answer: confirmed.
      await press("let these tickets go");

      expect(out("confirmation")).toBe("order-for-1");
      expect(bridge.emitOrderComplete).toHaveBeenCalledTimes(1);
      expect(
        server.confirm.mock.calls.map(
          ([input]) => (input as { clientSecret: string }).clientSecret,
        ),
      ).toEqual([secret]);
    });

    it("Continue pressed while the release is out waits for the answer: released → the details step, never a payment form for an order being cancelled", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");

      await press("continue to checkout");

      expect(screen.getByTestId("event-detail")).toBeTruthy();
      expect(screen.queryByTestId("payment-intent")).toBeNull();

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(out("payment-intent")).toBe("none");
      expect(out("checkout-step")).toBe("details");
      expect(out("order-notice")).toBe("released");
    });

    it("Continue pressed while the release is out, and the order is kept → on to paying it", async () => {
      const { answer } = releasesStayOut();
      server.confirm.mockImplementation(() => new Promise(() => undefined));
      const secret = await backOnTheEvent();
      await press("let these tickets go");
      await press("continue to checkout");

      await act(async () => {
        answer[0]?.({ outcome: "kept", orderId: "order-for-1" });
      });

      expect(out("payment-intent")).toBe(secret);
      expect(out("checkout-step")).toBe("payment");
    });

    it("the cart changed while the release is out: one call serves both, and the order is told as a left one", async () => {
      const { answer } = releasesStayOut();
      await backOnTheEvent();
      await press("let these tickets go");

      await press("add a ticket");

      expect(server.release).toHaveBeenCalledTimes(1);
      expect(out("order-notice")).toBe("changed");

      await act(async () => {
        answer[0]?.({ outcome: "released", orderId: "order-for-1" });
      });

      expect(out("order-notice")).toBe(`changed ${LET_GO}`);
    });

    it("after a press that did not release it, a changed cart tries once more", async () => {
      releaseFailsInTransit();
      const secret = await backOnTheEvent();
      await press("let these tickets go");
      expect(out("let-go-state")).toBe("not let go");
      serverReleases("released");

      await press("add a ticket");

      expect(releasedSecrets()).toEqual([secret, secret]);
      expect(out("order-notice")).toBe(`changed ${LET_GO}`);
    });

    it("the reservation running out takes the control away with the order", async () => {
      await backOnTheEvent();

      await tick(TEN_MINUTES);

      expect(
        screen.queryByRole("button", { name: "let these tickets go" }),
      ).toBeNull();
      expect(out("order-notice")).toBe(`expired ${LET_GO}`);
    });
  });
});

describe("EmbedWidget — the confirmation shows the tickets of the page's order, and only those", () => {
  // The server's "confirmed" answer carries the order's tickets. A code
  // admits whoever shows it: it reaches the confirmation of the order it
  // belongs to and goes nowhere else.
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const ticket = (code: string, seatLabel: string | null = null): ServerTicket => ({
    code,
    ticketTypeName: "General Admission",
    seatLabel,
  });
  const orderOnThePaymentStep = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
  };
  /** Everything the page has stored, in both storages, as one string. */
  const everythingStored = () =>
    [window.sessionStorage, window.localStorage]
      .flatMap((storage) =>
        Array.from({ length: storage.length }, (_unused, index) => {
          const key = storage.key(index) ?? "";
          return `${key}=${storage.getItem(key) ?? ""}`;
        }),
      )
      .join("\n");

  it("the server confirms the page's order with its tickets → the confirmation is handed them", async () => {
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "order-for-1",
      tickets: [ticket("TCK-MINE-1"), ticket("TCK-MINE-2", "Balcony · Q5")],
    });
    await orderOnThePaymentStep();
    await press("pay in page");

    expect(out("confirmation")).toBe("order-for-1");
    expect(out("confirmation-tickets")).toBe("TCK-MINE-1,TCK-MINE-2");
  });

  it("a code is never stored, never put in the URL, never traced, and the host page is told what it was told before", async () => {
    const posted = vi.spyOn(window, "postMessage");
    const postedUp = vi.spyOn(window.parent, "postMessage");
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "order-for-1",
      tickets: [ticket("TCK-SECRET-1")],
    });
    await orderOnThePaymentStep();
    await press("pay in page");
    expect(out("confirmation-tickets")).toBe("TCK-SECRET-1");

    expect(everythingStored()).not.toContain("TCK-SECRET-1");
    expect(window.location.href).not.toContain("TCK-SECRET-1");
    expect(JSON.stringify(trace.labels)).not.toContain("TCK-SECRET-1");
    expect(
      JSON.stringify([...posted.mock.calls, ...postedUp.mock.calls]),
    ).not.toContain("TCK-SECRET-1");
    // `hf:orderComplete`: the order id, the subtotal, the currency. No more.
    expect(bridge.emitOrderComplete.mock.calls).toEqual([
      ["order-for-1", 2000, "usd"],
    ]);
    posted.mockRestore();
    postedUp.mockRestore();
  });

  it("an API that sends no tickets (older than this web build) → today's confirmation, no tickets", async () => {
    server.confirm.mockResolvedValue({ outcome: "confirmed", orderId: "order-for-1" });
    await orderOnThePaymentStep();
    await press("pay in page");

    expect(out("confirmation")).toBe("order-for-1");
    expect(out("confirmation-tickets")).toBe("none");
  });

  it("a payment still clearing shows no ticket, even if an answer carried some", async () => {
    server.confirm.mockResolvedValue({
      outcome: "processing",
      orderId: "order-for-1",
      tickets: [ticket("TCK-EARLY-1")],
    } as unknown as ServerAnswer);
    await orderOnThePaymentStep();
    await press("pay in page by bank");

    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(screen.queryByTestId("embed-tickets")).toBeNull();
    expect(document.body.textContent).not.toContain("TCK-EARLY-1");
  });

  it("an answer that names another order is not believed: its tickets are not shown as this purchase", async () => {
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "some-other-order",
      tickets: [ticket("TCK-OTHER-1")],
    });
    await orderOnThePaymentStep();
    await press("pay in page");

    expect(out("confirmation")).toBe("order-for-1");
    expect(out("confirmation-tickets")).toBe("none");
  });

  describe("with an earlier order the widget re-asks about", () => {
    /** Leaves order 1 with an unknown outcome and pays order 2. */
    const payALaterOrder = async (
      answers: (which: "earlier" | "page") => ServerAnswer,
    ) => {
      await orderOnThePaymentStep();
      const firstIntent = out("payment-intent");
      await press("outcome unknown");
      await press("checkout back");
      await press("add a ticket");
      await press("continue to checkout");
      await press("create the order");
      expect(out("payment-intent")).not.toBe(firstIntent);
      server.confirm.mockImplementation(
        async ({ clientSecret }: { clientSecret: string }) =>
          answers(clientSecret === firstIntent ? "earlier" : "page"),
      );
      await press("pay in page");
      // The earlier order's answer has landed too.
      await act(async () => {});
      expect(server.confirm).toHaveBeenCalledTimes(2);
      expect(out("confirmation")).toBe("order-for-2");
    };

    it("the earlier order's tickets never reach the screen; the page's own do", async () => {
      await payALaterOrder((which) =>
        which === "earlier"
          ? {
              outcome: "confirmed",
              orderId: "order-for-1",
              tickets: [ticket("TCK-EARLIER-1")],
            }
          : {
              outcome: "confirmed",
              orderId: "order-for-2",
              tickets: [ticket("TCK-PAGE-1"), ticket("TCK-PAGE-2")],
            },
      );

      expect(out("confirmation-tickets")).toBe("TCK-PAGE-1,TCK-PAGE-2");
      expect(document.body.textContent).not.toContain("TCK-EARLIER-1");
    });

    it("the page's order came back without tickets → none shown, not the earlier order's", async () => {
      await payALaterOrder((which) =>
        which === "earlier"
          ? {
              outcome: "confirmed",
              orderId: "order-for-1",
              tickets: [ticket("TCK-EARLIER-1")],
            }
          : { outcome: "confirmed", orderId: "order-for-2" },
      );

      expect(out("confirmation-tickets")).toBe("none");
      expect(document.body.textContent).not.toContain("TCK-EARLIER-1");
    });
  });

  it("Done drops the tickets: the next order's confirmation does not show the last one's", async () => {
    server.confirm.mockResolvedValueOnce({
      outcome: "confirmed",
      orderId: "order-for-1",
      tickets: [ticket("TCK-FIRST-1")],
    });
    await orderOnThePaymentStep();
    await press("pay in page");
    expect(out("confirmation-tickets")).toBe("TCK-FIRST-1");

    await press("Done");
    expect(document.body.textContent).not.toContain("TCK-FIRST-1");

    // Two tickets this time: another order (the mock names one by its size).
    server.confirm.mockResolvedValue({ outcome: "confirmed", orderId: "order-for-2" });
    await press("open event");
    await press("add a ticket");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    await press("pay in page");
    expect(out("confirmation")).toBe("order-for-2");
    expect(out("confirmation-tickets")).toBe("none");
  });

  it("a free order: its tickets come with the create answer, and the server is not asked", async () => {
    checkoutMock.free = true;
    checkoutMock.freeTickets = [ticket("TCK-FREE-1")];
    await orderOnThePaymentStep();

    expect(out("confirmation")).toBe("free-order-for-1");
    expect(out("confirmation-tickets")).toBe("TCK-FREE-1");
    expect(server.confirm).not.toHaveBeenCalled();
    expect(everythingStored()).not.toContain("TCK-FREE-1");
  });

  it("a free order whose create answer has no tickets field → no tickets", async () => {
    checkoutMock.free = true;
    await orderOnThePaymentStep();

    expect(out("confirmation")).toBe("free-order-for-1");
    expect(out("confirmation-tickets")).toBe("none");
  });

  describe("a redirect payment's return", () => {
    const landPaid = async (answer: ServerAnswer) => {
      stripeJs.unavailable = false;
      stripeJs.retrievePaymentIntent = async () => ({
        paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
      });
      server.confirm.mockResolvedValue(answer);
      landOn(EMBED_RETURN("succeeded"));
      render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await flush();
    };

    it("confirmed with tickets → the same tickets section, under 'Payment received', and nothing stored", async () => {
      await landPaid({
        outcome: "confirmed",
        orderId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        tickets: [ticket("TCK-REDIRECT-1"), ticket("TCK-REDIRECT-2", "Balcony · Q5")],
      });

      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(
        screen.getAllByTestId("embed-ticket-code").map((el) => el.textContent),
      ).toEqual(["TCK-REDIRECT-1", "TCK-REDIRECT-2"]);
      // The seat label as the server sends it, in text and in the QR's name.
      expect(screen.getByText("Balcony · Q5")).toBeInTheDocument();
      expect(
        screen.getByRole("img", {
          name: "Ticket code for General Admission, Balcony · Q5, ticket 2 of 2",
        }),
      ).toBeInTheDocument();
      expect(out("embed-order-code")).toBe("#7728950E");
      expect(everythingStored()).not.toContain("TCK-REDIRECT");
      expect(window.location.href).not.toContain("TCK-REDIRECT");
      expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
    });

    it("confirmed without tickets → 'Payment received' and the order code, no tickets section", async () => {
      await landPaid({ outcome: "confirmed", orderId: "0f8fad5b-d9cb-469f-a165-70867728950e" });

      expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
      expect(screen.queryByTestId("embed-tickets")).toBeNull();
      expect(out("embed-order-code")).toBe("#7728950E");
    });

    it("still clearing → no tickets and no order code", async () => {
      await landPaid({ outcome: "processing", orderId: "order-r" });

      expect(screen.queryByTestId("embed-tickets")).toBeNull();
      expect(screen.queryByTestId("embed-order-code")).toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The receipt secret (owner ruling 2026-10-12): ticket codes show only in the
// tab that started the payment. That tab holds the secret createGuestCheckout
// answered with (EmbedCheckout keeps it); every ask about the order carries
// it. A tab without it asks without it, and the server answers "confirmed"
// with no codes.
// ─────────────────────────────────────────────────────────────────────────────
describe("EmbedWidget — every ask carries the tab's receipt secret, and only when it holds one", () => {
  // Fake fixture, not a real secret.
  const RECEIPT = "FakeReceiptSecretFixture_NotReal-0123456789A";
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const orderOnThePaymentStep = async () => {
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
  };
  const sentReceiptSecrets = () =>
    server.confirm.mock.calls.map(
      ([input]) => (input as { receiptSecret?: string }).receiptSecret ?? null,
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("in-frame: the payment's confirm carries the secret kept for that order", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);

    await press("pay in page");

    expect(server.confirm).toHaveBeenCalledWith({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: intent,
      receiptSecret: RECEIPT,
    });
  });

  it("in-frame with no secret held (an older API): the ask has no receiptSecret key at all", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;

    await press("pay in page");

    expect(server.confirm.mock.calls[0]?.[0]).toEqual({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: intent,
    });
    expect(server.confirm.mock.calls[0]?.[0]).not.toHaveProperty("receiptSecret");
  });

  it("a secret held for ANOTHER order is not sent with this one", async () => {
    await orderOnThePaymentStep();
    rememberEmbedReceiptSecret("embed-1", "pi_someOtherOrder_secret_y", RECEIPT);

    await press("pay in page");

    expect(sentReceiptSecrets()).toEqual([null]);
  });

  it("storage that throws: the in-frame confirm still carries the secret, from memory", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;
    for (const method of ["setItem", "getItem", "removeItem", "key"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    }
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);

    await press("pay in page");

    expect(sentReceiptSecrets()).toEqual([RECEIPT]);
    // The confirm went through as ever.
    expect(screen.getByTestId("confirmation")).toBeInTheDocument();
  });

  it("a same-tab redirect return (the page reloaded, memory gone) reads it back by the PaymentIntent id on the return URL", async () => {
    rememberEmbedReceiptSecret("embed-1", "pi_r_secret_x", RECEIPT);
    forgetEmbedReceiptSecretsInMemory();
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();

    expect(server.confirm).toHaveBeenCalledWith({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: "pi_r_secret_x",
      receiptSecret: RECEIPT,
    });
  });

  it("a redirect return in a NEW tab (nothing held) asks without it; the server's code-less 'confirmed' shows 'Payment received' and the order code, no tickets", async () => {
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "00000000-0000-4000-8000-0000000000ab",
      tickets: [],
    });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();

    expect(sentReceiptSecrets()).toEqual([null]);
    expect(server.confirm.mock.calls[0]?.[0]).not.toHaveProperty("receiptSecret");
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(
      screen.getByText("Your tickets are on their way to the email you used at checkout."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("embed-order-code")).toBeInTheDocument();
    expect(screen.queryByTestId("embed-tickets")).toBeNull();
  });

  // An API rolled back past receipt secrets refuses the field: its input is
  // `.strict()`, and the refusal is a bare BAD_REQUEST (no app code).
  const schemaRefusal = () =>
    Object.assign(new Error('[{"code":"unrecognized_keys","keys":["receiptSecret"]}]'), {
      data: { code: "BAD_REQUEST" },
    });
  const appRefusal = () =>
    Object.assign(new Error("PAYMENT_INTENT_ORDER_MISMATCH"), {
      data: { code: "BAD_REQUEST", appCode: "PAYMENT_INTENT_ORDER_MISMATCH" },
    });

  it("an API that refuses the field (rolled back): asked ONCE more without it, and that answer confirms the order", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);
    server.confirm
      .mockRejectedValueOnce(schemaRefusal())
      .mockResolvedValueOnce({ outcome: "confirmed", orderId: "order-for-1" });

    await press("pay in page");

    expect(sentReceiptSecrets()).toEqual([RECEIPT, null]);
    expect(server.confirm.mock.calls[1]?.[0]).toEqual({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: intent,
    });
    expect(screen.getByTestId("confirmation")).toBeInTheDocument();
    expect(trace.labels).toContain("embed.receiptSecretRefused");
  });

  it("the call without the field is refused too: no third call, and the refusal stands", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);
    server.confirm.mockRejectedValue(schemaRefusal());

    await press("pay in page");
    await flush();

    expect(sentReceiptSecrets()).toEqual([RECEIPT, null]);
    expect(screen.queryByTestId("confirmation")).toBeNull();
  });

  it("a BAD_REQUEST that carries an app code (the use case's own refusal) is NOT retried without the field", async () => {
    await orderOnThePaymentStep();
    const intent = out("payment-intent")!;
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);
    server.confirm.mockRejectedValue(appRefusal());

    await press("pay in page");
    await flush();

    expect(sentReceiptSecrets()).toEqual([RECEIPT]);
    expect(trace.labels).not.toContain("embed.receiptSecretRefused");
  });

  it("a bare BAD_REQUEST on a call WITHOUT the field is unchanged: one call, no retry", async () => {
    await orderOnThePaymentStep();
    server.confirm.mockRejectedValue(schemaRefusal());

    await press("pay in page");
    await flush();

    expect(sentReceiptSecrets()).toEqual([null]);
    expect(screen.queryByTestId("confirmation")).toBeNull();
    expect(trace.labels).not.toContain("embed.receiptSecretRefused");
  });

  it("a redirect return whose API refuses the field: asked once more without it, and 'Payment received' shows", async () => {
    rememberEmbedReceiptSecret("embed-1", "pi_r_secret_x", RECEIPT);
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
    });
    server.confirm
      .mockRejectedValueOnce(schemaRefusal())
      .mockResolvedValueOnce({ outcome: "confirmed", orderId: "order-r" });
    landOn(EMBED_RETURN("succeeded"));
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await flush();
    await flush();

    expect(sentReceiptSecrets()).toEqual([RECEIPT, null]);
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
  });

  describe("on the 'paid, not confirmed' screen", () => {
    const tick = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("Check again carries it too", async () => {
      rememberEmbedReceiptSecret("embed-1", "pi_r_secret_x", RECEIPT);
      server.confirm.mockResolvedValue({
        outcome: "not_paid",
        orderId: "order-r",
        paymentIntentStatus: "requires_payment_method",
      });
      stripeJs.unavailable = false;
      stripeJs.retrievePaymentIntent = async () => ({
        paymentIntent: { id: "pi_r", status: "succeeded", amount: 4250, currency: "usd" },
      });
      landOn(EMBED_RETURN("succeeded"));
      render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await tick(0);
      expect(sentReceiptSecrets()).toEqual([RECEIPT]);

      await tick(5_000);
      serverConfirms();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: checkoutCopy("embedCheckAgain") }),
        );
      });
      await tick(0);

      expect(sentReceiptSecrets()).toEqual([RECEIPT, RECEIPT]);
    });
  });

  it("every mount sweeps expired receipt secrets, of any embed, and keeps fresh ones", async () => {
    vi.useFakeTimers();
    try {
      rememberEmbedReceiptSecret("embed-other", "pi_old_secret_x", RECEIPT);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMBED_RECEIPT_SECRET_MS);
      });
      rememberEmbedReceiptSecret("embed-1", "pi_new_secret_x", RECEIPT);
      forgetEmbedReceiptSecretsInMemory();

      render(<EmbedWidget initialDefaultView="list" />);
      settle("list", { data: listPayload() });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(
        window.sessionStorage.getItem(embedReceiptSecretKey("embed-other", "pi_old")),
      ).toBeNull();
      expect(
        window.sessionStorage.getItem(embedReceiptSecretKey("embed-1", "pi_new")),
      ).toContain(RECEIPT);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// An in-frame payment Stripe said went through, whose order the server has not
// confirmed, survives a remount (the host page reloads, or the iframe does).
// The order is held as a redirect return (`holdUnconfirmedOrder`): its client
// secret in sessionStorage only, for 30 minutes from the first hold. The next
// mount resumes it as a return: Stripe.js reads the PaymentIntent, the server
// is asked with the tab's receipt secret, and the buyer gets the confirmation
// on the server's word, or the "not confirmed yet" screen with Check again.
// ─────────────────────────────────────────────────────────────────────────────
describe("EmbedWidget — a paid order the server has not confirmed survives a remount", () => {
  // Fake fixture, not a real secret.
  const RECEIPT = "FakeReceiptSecretFixture_NotReal-0123456789A";
  const REMINDER =
    "You may have a payment still being confirmed. Check your email before buying again.";
  const HELD = heldRedirectReturnKey("embed-1");
  const out = (testId: string) => screen.getByTestId(testId).textContent;
  const press = (name: string) =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
  const tick = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const refusal = (code: string, appCode?: string) =>
    Object.assign(new Error(appCode ?? code), {
      data: { code, ...(appCode ? { appCode } : {}) },
    });
  /** Not now, and not final: the endpoint's budget is spent. One call. */
  const notNow = () => refusal("TOO_MANY_REQUESTS");
  /** How long "Check again" rests after an unconfirmed answer. */
  const REST = 5_000;
  const ticket = (code: string): ServerTicket => ({
    code,
    ticketTypeName: "General Admission",
    seatLabel: null,
  });
  const onTheUnconfirmedScreen = () =>
    screen.queryByText(checkoutCopy("embedPaidUnconfirmedTitle")) !== null;
  const checkAgainButton = () =>
    screen.queryByRole("button", { name: checkoutCopy("embedCheckAgain") });
  const sentReceiptSecrets = () =>
    server.confirm.mock.calls.map(
      ([input]) => (input as { receiptSecret?: string }).receiptSecret ?? null,
    );
  const held = () => window.sessionStorage.getItem(HELD);
  const pendingMarker = () =>
    window.sessionStorage.getItem(pendingRedirectKey("embed-1"));

  /**
   * The buyer pays in the frame (its receipt secret kept, as EmbedCheckout
   * keeps it), and the server cannot be asked: the unconfirmed screen.
   */
  const paidAndUnconfirmed = async () => {
    server.confirm.mockRejectedValue(notNow());
    const view = render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const intent = out("payment-intent") ?? "";
    rememberEmbedReceiptSecret("embed-1", intent, RECEIPT);
    await press("pay in page");
    expect(onTheUnconfirmedScreen()).toBe(true);
    return { view, intent, paymentIntentId: intent.slice(0, intent.indexOf("_secret_")) };
  };
  /** The page reloads: a fresh document (module memory gone), same tab. */
  const remount = async (
    view: { unmount: () => void },
    paymentIntentId: string,
    stripeStatus = "succeeded",
  ) => {
    view.unmount();
    forgetEmbedReceiptSecretsInMemory();
    server.confirm.mockClear();
    stripeJs.unavailable = false;
    stripeJs.retrievePaymentIntent = async () => ({
      paymentIntent: { id: paymentIntentId, status: stripeStatus, amount: 2000, currency: "usd" },
    });
    window.history.replaceState(null, "", "/embed/embed-1");
    searchMock.value = "";
    render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await tick(0);
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("the unconfirmed screen holds the order's client secret in sessionStorage only; the pending marker never holds it, and nothing goes to localStorage", async () => {
    const { intent, paymentIntentId } = await paidAndUnconfirmed();

    expect(JSON.parse(held() ?? "null")).toMatchObject({
      clientSecret: intent,
      paymentIntentId,
      failedHint: false,
    });
    const marker = pendingMarker() ?? "";
    expect(JSON.parse(marker)).toMatchObject({ paymentIntentId });
    expect(marker).not.toContain("_secret_");
    expect(window.localStorage.length).toBe(0);
    expect(window.location.href).not.toContain("_secret_");
  });

  it("asking again and staying unconfirmed does not restart the 30-minute window", async () => {
    await paidAndUnconfirmed();
    const firstAt = (JSON.parse(held() ?? "null") as { at: number }).at;
    await tick(REST);
    await press(checkoutCopy("embedCheckAgain"));
    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect((JSON.parse(held() ?? "null") as { at: number }).at).toBe(firstAt);
  });

  it("a remount asks the server again with the tab's receipt secret, and the confirmation shows the ticket codes; the hold and the marker go, and the host is not told of a sale", async () => {
    const { view, intent, paymentIntentId } = await paidAndUnconfirmed();
    server.confirm.mockReset();
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      tickets: [ticket("TCK-REMOUNT-1"), ticket("TCK-REMOUNT-2")],
    });

    await remount(view, paymentIntentId);

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(server.confirm).toHaveBeenCalledWith({
      embedId: "embed-1",
      hostOrigin: "https://host.example",
      clientSecret: intent,
      receiptSecret: RECEIPT,
    });
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();
    expect(
      screen.getAllByTestId("embed-ticket-code").map((el) => el.textContent),
    ).toEqual(["TCK-REMOUNT-1", "TCK-REMOUNT-2"]);
    expect(out("embed-order-code")).toBe("#7728950E");
    expect(held()).toBeNull();
    expect(pendingMarker()).toBeNull();
    expect(screen.queryByText(REMINDER)).toBeNull();
    // A separate owner ruling, not built: this path never tells the host.
    expect(bridge.emitOrderComplete).not.toHaveBeenCalled();
  });

  it("a remount whose ask goes unanswered → the 'not confirmed yet' screen with Check again, never the reminder beside an open widget; Check again confirms, still with the codes", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();

    await remount(view, paymentIntentId);

    expect(server.confirm).toHaveBeenCalledTimes(1);
    expect(sentReceiptSecrets()).toEqual([RECEIPT]);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).not.toBeNull();
    expect(screen.queryByTestId("grid")).toBeNull();
    expect(screen.queryByText(REMINDER)).toBeNull();
    expect(screen.queryByText(checkoutCopy("embedNotCharged"))).toBeNull();
    // Still held: another reload asks again.
    expect(held()).not.toBeNull();

    server.confirm.mockReset();
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      tickets: [ticket("TCK-REMOUNT-1")],
    });
    await tick(REST);
    await press(checkoutCopy("embedCheckAgain"));

    expect(sentReceiptSecrets()).toEqual([RECEIPT]);
    expect(
      screen.getAllByTestId("embed-ticket-code").map((el) => el.textContent),
    ).toEqual(["TCK-REMOUNT-1"]);
    expect(held()).toBeNull();
  });

  it("a remount whose server says 'not paid' against Stripe's 'paid' is a disagreement, not 'you were not charged': the unconfirmed screen", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    server.confirm.mockReset();
    server.confirm.mockResolvedValue({
      outcome: "not_paid",
      orderId: "order-for-1",
      paymentIntentStatus: "requires_payment_method",
    });

    await remount(view, paymentIntentId);

    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).not.toBeNull();
    expect(screen.queryByText(checkoutCopy("embedNotCharged"))).toBeNull();
    expect(held()).not.toBeNull();
  });

  it("the server confirms in the same mount (Check again) → the hold goes; a later remount asks nothing", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    expect(held()).not.toBeNull();
    serverConfirms();
    await tick(REST);
    await press(checkoutCopy("embedCheckAgain"));
    expect(screen.getByTestId("confirmation")).toBeInTheDocument();
    expect(held()).toBeNull();

    await remount(view, paymentIntentId);
    expect(server.confirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("a final refusal holds nothing (asking again cannot change it): a remount gets the reminder, not another ask", async () => {
    server.confirm.mockRejectedValue(refusal("FORBIDDEN"));
    const view = render(<EmbedWidget initialDefaultView="list" />);
    settle("list", { data: listPayload() });
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");
    await press("create the order");
    const intent = out("payment-intent") ?? "";
    await press("pay in page");
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).toBeNull();
    expect(held()).toBeNull();

    await remount(view, intent.slice(0, intent.indexOf("_secret_")));
    expect(server.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();
  });

  it("a hold older than 30 minutes is not resumed, and the mount sweeps it", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    expect(held()).not.toBeNull();
    await tick(PENDING_REDIRECT_NOTICE_MS);

    await remount(view, paymentIntentId);

    expect(server.confirm).not.toHaveBeenCalled();
    expect(held()).toBeNull();
    expect(onTheUnconfirmedScreen()).toBe(false);
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("storage that will not take the hold → today's behaviour: the unconfirmed screen in the frame, and a remount gets the reminder, not an ask", async () => {
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === HELD) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    expect(held()).toBeNull();
    expect(checkAgainButton()).not.toBeNull();

    await remount(view, paymentIntentId);

    expect(server.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();
    expect(screen.getByTestId("grid")).toBeInTheDocument();
  });

  it("Check again after the 30 minutes have run out does not store the order again: the window is not restarted, and the screen keeps working from memory", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    const firstAt = (JSON.parse(held() ?? "null") as { at: number }).at;
    await tick(PENDING_REDIRECT_NOTICE_MS);

    await press(checkoutCopy("embedCheckAgain"));

    expect(server.confirm).toHaveBeenCalledTimes(2);
    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).not.toBeNull();
    // Not written afresh: what is left is the first hold, past its window.
    const after = held();
    if (after !== null) expect((JSON.parse(after) as { at: number }).at).toBe(firstAt);

    await remount(view, paymentIntentId);
    expect(server.confirm).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it("held on an unanswered first ask, then Check again gets a final refusal → the hold goes and Check again with it", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    expect(held()).not.toBeNull();
    server.confirm.mockReset();
    server.confirm.mockRejectedValue(refusal("FORBIDDEN"));
    await tick(REST);

    await press(checkoutCopy("embedCheckAgain"));

    expect(onTheUnconfirmedScreen()).toBe(true);
    expect(checkAgainButton()).toBeNull();
    expect(held()).toBeNull();
    await remount(view, paymentIntentId);
    expect(server.confirm).not.toHaveBeenCalled();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();
  });

  it("a resumed in-frame order is not a redirect return for the next checkout: its referrer names the host page, so a later payment saves that origin", async () => {
    const { view, paymentIntentId } = await paidAndUnconfirmed();
    server.confirm.mockReset();
    server.confirm.mockResolvedValue({
      outcome: "confirmed",
      orderId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    });
    await remount(view, paymentIntentId);
    expect(screen.getByRole("heading", { name: "Payment received" })).toBeInTheDocument();

    await press("Done");
    await press("open event");
    await press("add a ticket");
    await press("continue to checkout");

    expect(out("loaded-as-redirect-return")).toBe("false");
  });

  it("storage that throws on every call never breaks the unconfirmed screen", async () => {
    for (const method of ["setItem", "getItem", "removeItem", "key"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    }
    await paidAndUnconfirmed();
    expect(checkAgainButton()).not.toBeNull();
  });
});
