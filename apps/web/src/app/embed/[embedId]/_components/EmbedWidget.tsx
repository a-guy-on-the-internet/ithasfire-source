"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useParams, useSearchParams } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { parseEmbedScope } from "@/lib/embed-scope";
import { keepsCheckoutClientKey } from "@/lib/checkout-client-key";
import { hasStripeRedirectParams } from "@/lib/stripe-redirect-return";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import {
  parseEmbedView,
  resolveEmbedBrowseView,
  type EmbedView,
} from "@/lib/embed-view";
import type { CheckoutStepId } from "@/app/events/checkout/[...slug]/_components/CheckoutStepper";

import type {
  CartItem,
  CheckoutStep,
  EmbedCheckoutConfirmation,
  EventItem,
  Screen,
  SlideDirection,
} from "./embed-types";
import type {
  EmbedCheckoutDraft,
  EmbedPaymentOrder,
} from "./embed-checkout-types";
import {
  DEFAULT_SUPPORT_EMAIL,
  embedEventUrl,
  generateClientKey,
} from "./embed-helpers";
import {
  hasReleasedLeftOrder,
  isSameEmbedCart,
  leftOrderReservedUntil,
  leftOrdersReservedUntil,
  withoutLapsedLeftOrders,
  withoutReleasedLeftOrders,
  type LeftEmbedOrders,
} from "./embed-payment-order";
import {
  NOTHING_KNOWN,
  asPaidStatus,
  earlierOrderAfterServerAnswer,
  settlesAsUnpaid,
  type EmbedServerAnswer,
  type PaidStatus,
  type UnknownOutcome,
  type UnknownOutcomeReport,
} from "./embed-payment-status";
import {
  askEmbedServer,
  sendConfirmWithReceiptSecret,
} from "./ask-embed-server";
import {
  heldEmbedReceiptSecret,
  sweepExpiredEmbedReceiptSecrets,
} from "./embed-receipt-secret";
import { ticketsForOrder } from "./embed-tickets";
import {
  releaseEmbedOrder,
  type EmbedReleaseOutcome,
} from "./release-embed-order";
import {
  embedHostOriginOnRedirectReturn,
  forgetEmbedHostOrigin,
} from "./embed-saved-host-origin";
import {
  DANGER,
  DANGER_BG,
  SURFACE,
  TEXT,
  WARNING_BG,
  embedThemeBridgeStyle,
} from "./embed-theme";
import { EmbedCalendarBrowse } from "./EmbedCalendarBrowse";
import { EmbedEventGrid } from "./EmbedEventGrid";
import { EmbedViewToggle } from "./EmbedViewToggle";
import { EmbedWidgetFallback } from "./EmbedWidgetFallback";
import { EmbedErrorScreen } from "./EmbedErrorScreen";
import { EmbedEventDetail } from "./EmbedEventDetail";
import { EmbedCheckout } from "./EmbedCheckout";
import { EmbedConfirmation } from "./EmbedConfirmation";
import {
  EmbedOrderNotice,
  EmbedReservedNotice,
  type EmbedOrderNoticeKind,
} from "./EmbedOrderNotice";
import { EmbedRedirectConfirmation } from "./EmbedRedirectConfirmation";
import { EmbedRedirectReturnScreen } from "./EmbedRedirectReturnScreen";
import { useEmbedBridge } from "./useEmbedBridge";
import { useHasPassed } from "./useHasPassed";
import { readEmbedPaymentStatus } from "./read-embed-payment-status";
import { useEmbedThemeOverrides } from "./useEmbedThemeOverrides";
import {
  useEmbedRedirectReturn,
  clearPendingMarker,
  hasHeldRedirectReturn,
  holdUnconfirmedOrder,
  releaseHeldOrder,
  writePendingMarker,
  type AskEmbedServer,
  type EmbedRedirectPayment,
} from "./useEmbedRedirectReturn";

/**
 * How many earlier orders the widget asks the server about when an order
 * completes, one after the other. Each is a call against
 * `embeds.confirmGuestPayment`'s budget of 20 a minute per IP, which the
 * page's own order needs too. The ones not asked about keep their record.
 */
const EARLIER_ORDER_ASKS = 3;

/** The PaymentIntent's ID: the part of its client secret that is no secret. */
const paymentIntentIdOf = (clientSecret: string): string | null =>
  clientSecret.split("_secret_")[0] || null;

// ─────────────────────────────────────────────────────────────────────────────
// Embed ticket widget
//
// The whole in-iframe purchase flow (browse → eventDetail → checkout →
// confirmation). The BROWSE screen renders one of two views of the same embed:
// - "list"     → EmbedEventGrid
// - "calendar" → EmbedCalendarBrowse
//
// Which one is resolved by `resolveEmbedBrowseView` (FR-003 / D-002):
//   route pin > ?view= > embed.defaultView > "list"
// The two routes are NOT two products: /embed/[embedId] resolves, and
// /embed/calendar/[embedId] passes `routeView="calendar"` as a permanent
// alias. When `embed.viewToggle` is on (org/human subjects only) the viewer
// can also flip views in-place — no navigation, no iframe reload.
// ─────────────────────────────────────────────────────────────────────────────

export function EmbedWidget({
  routeView,
  initialDefaultView = null,
}: {
  routeView?: EmbedView;
  /**
   * The embed's stored `defaultView`, resolved SERVER-SIDE by the canonical
   * route (see `server/embeds.ts`). Present ⇒ the view is fully resolved on
   * render 0 and exactly one browse query fires. `null` (the calendar alias
   * route, or an SSR lookup that failed) ⇒ the widget falls back to reading
   * the flag off whichever payload lands first, which costs one extra request
   * on a bare URL whose row wants the calendar.
   */
  initialDefaultView?: EmbedView | null;
} = {}) {
  const { embedId } = useParams<{ embedId: string }>();
  const searchParams = useSearchParams();
  const t = useTranslations();

  // Which events an organization/human widget renders. Junk falls back to
  // "own" — a live snippet must never white-screen on a hand-edited param
  // (`useSearchParams` is already on this page via useEmbedThemeOverrides,
  // so this adds no new Suspense requirement).
  const scope = parseEmbedScope(searchParams.get("scope"));

  // ── View resolution (FR-003) ───────────────────────────────────────
  const viewParam = searchParams.get("view");
  // Everything known BEFORE any payload lands: the route alias, a recognised
  // ?view=, and the server-resolved stored default — in precedence order.
  // This is what gates the queries, so a non-null value here means exactly one
  // browse query fires on load. Unknown ?view= values are ignored, falling
  // through to the stored default rather than pinning junk.
  const preResolvedView =
    routeView ?? parseEmbedView(viewParam) ?? initialDefaultView;
  // The viewer's own choice via the FR-004 toggle. Outranks everything once
  // set — it is a direct, in-session interaction.
  const [viewerView, setViewerView] = useState<EmbedView | null>(null);
  // Height floor held across a toggle flip so the framed embed doesn't
  // collapse while the incoming view fetches (see `browseToggle` below).
  const [transitionMinHeight, setTransitionMinHeight] = useState<number | null>(
    null,
  );
  const browseRootRef = useRef<HTMLDivElement>(null);

  // NOTE: "grid" is the BROWSE screen for both browse views — the value is
  // part of the public bridge contract (`hf:navigate` in useEmbedBridge /
  // public/embed/hf-embed.js), so the calendar browse reuses it rather than
  // introducing a new wire value.
  const [screen, setScreen] = useState<Screen>("grid");
  const [slideDir, setSlideDir] = useState<SlideDirection>("forward");
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  // The order the payment step charges (its PaymentIntent, figures and the
  // cart it was priced from). Held here, not in EmbedCheckout, so stepping
  // back to the event detail and forward again returns to the SAME order
  // with its figures, instead of its payment form under the cart's estimate.
  const [paymentOrder, setPaymentOrder] = useState<EmbedPaymentOrder | null>(
    null,
  );
  // The order counts only for the cart it was priced from: the payment form
  // charges its PaymentIntent, so under any other cart it would charge a
  // total the buyer is not shown. `handleCartChange` discards it on the
  // change; this is the backstop for any other path that sets the cart.
  const livePaymentOrder =
    paymentOrder && isSameEmbedCart(paymentOrder.cart, cart)
      ? paymentOrder
      : null;
  // The checkout's step follows the order: the payment form shows exactly
  // while there is an order for this cart.
  const checkoutStep: CheckoutStep = livePaymentOrder ? "payment" : "details";
  // A payment confirm is in flight with Stripe (reported by the payment form).
  const [isPaying, setIsPaying] = useState(false);
  // The same two facts, readable from a handler that runs between renders
  // (the gate on releasing an order, further down).
  const pageOrderRef = useRef({ clientSecret: null as string | null, isPaying });
  useLayoutEffect(() => {
    pageOrderRef.current = {
      clientSecret: paymentOrder?.clientSecret ?? null,
      isPaying,
    };
  });
  // Orders the server kept and then could not be asked about: their
  // unknown-outcome record was started for that reason (`settleKeptOrder`),
  // and a late "not paid" from that ask may take it away again. Only until a
  // payment starts or reports on the order: from then on the record stands
  // for that payment, and an answer computed before the charge says nothing
  // about it.
  const keptUnansweredRef = useRef(new Set<string>());
  // The payment form's report, written to the ref in the same tick: a
  // confirm can go out before any render (a wallet), and a timer landing in
  // between must already find it there.
  const handlePayingChange = useCallback((paying: boolean) => {
    const paidFor = pageOrderRef.current.clientSecret;
    if (paying && paidFor !== null) keptUnansweredRef.current.delete(paidFor);
    pageOrderRef.current = { ...pageOrderRef.current, isPaying: paying };
    setIsPaying(paying);
  }, []);
  // Why the order the buyer had is gone, said on the next screen they see,
  // for the event it was an order for (an order that lands late can belong
  // to an event the buyer has since left).
  const [orderNotice, setOrderNotice] = useState<{
    kind: EmbedOrderNoticeKind;
    eventId: string;
  } | null>(null);
  // Orders the buyer left behind, each under its client secret (see
  // `LeftEmbedOrder`). The widget asks the server to release such an order
  // (`leaveOrderOnServer`). One it could not release keeps its tickets until
  // the server's own clean-up (`leftOrderReservedUntil`, well after the
  // order's countdown), and until then they can show as unavailable to the
  // very buyer who reserved them: the widget says so while it can be true
  // (EmbedOrderNotice, and beside a refused checkout).
  const [leftOrders, setLeftOrders] = useState<LeftEmbedOrders>({});
  // A confirm failed or never answered and Stripe could not say what became
  // of it: the buyer may have been charged, so the widget stops saying they
  // were not and reminds them to check their email.
  //
  // Kept per ORDER (by its PaymentIntent's client secret), never as one flag
  // for the page: what Stripe later says about one order settles nothing
  // about another, and the buyer can be on their second or third by then.
  // `confirmsStillOut` counts confirms the payment form stopped waiting for
  // and that may yet land a charge (see `UnknownOutcomeReport`).
  //
  // The same record holds what is known once somebody has answered (see
  // `UnknownOutcome`): that Stripe's browser side said the order was paid
  // while the server has not confirmed it, and what the server said when it
  // was asked about an order the page had left. A record goes only when its
  // order is on the confirmation, or is settled as not charged.
  const [unknownOutcomes, setUnknownOutcomes] = useState<
    Record<string, UnknownOutcome>
  >({});
  // Any order at all: while one is unsettled, or was paid for, the widget
  // never says "you have not been charged".
  const paymentOutcomeUnknown = Object.keys(unknownOutcomes).length > 0;
  const unknownOutcomesRef = useRef(unknownOutcomes);
  useLayoutEffect(() => {
    unknownOutcomesRef.current = unknownOutcomes;
  });
  // Every change to the records goes through here, so the ref holds it in
  // the same tick: whether an order may be released is decided from the ref,
  // often in the very handler that changed a record. `change` must be pure
  // (it runs here and again in React's own update).
  const changeUnknownOutcomes = useCallback(
    (
      change: (
        prev: Record<string, UnknownOutcome>,
      ) => Record<string, UnknownOutcome>,
    ) => {
      unknownOutcomesRef.current = change(unknownOutcomesRef.current);
      setUnknownOutcomes(change);
    },
    [],
  );
  // Stripe settled that this order was not charged and will not be, or it
  // is on its confirmation, or a release cancelled it. Settled either way:
  // a hold for a remount (`holdUnconfirmedOrder`) has nothing left to ask.
  const forgetUnknownOutcome = useCallback(
    (clientSecret: string) => {
      releaseHeldOrder(embedId, clientSecret);
      changeUnknownOutcomes((prev) =>
        clientSecret in prev
          ? Object.fromEntries(
              Object.entries(prev).filter(
                ([secret]) => secret !== clientSecret,
              ),
            )
          : prev,
      );
    },
    [changeUnknownOutcomes, embedId],
  );
  // Dismissing the reminder hides it; it does not make the outcome known.
  const [outcomeReminderDismissed, setOutcomeReminderDismissed] =
    useState(false);
  const handlePaymentOutcomeUnknown = useCallback(
    (clientSecret: string, report: UnknownOutcomeReport) => {
      keptUnansweredRef.current.delete(clientSecret);
      changeUnknownOutcomes((prev) => {
        const known = prev[clientSecret];
        if (report === "late-settled") {
          // One confirm fewer is out. Still unknown: Stripe has yet to say.
          return known
            ? {
                ...prev,
                [clientSecret]: {
                  ...known,
                  confirmsStillOut: Math.max(0, known.confirmsStillOut - 1),
                },
              }
            : prev;
        }
        const record = known ?? NOTHING_KNOWN;
        return {
          ...prev,
          [clientSecret]: {
            ...record,
            confirmsStillOut:
              report === "still-out"
                ? record.confirmsStillOut + 1
                : record.confirmsStillOut,
          },
        };
      });
      if (report !== "late-settled") setOutcomeReminderDismissed(false);
    },
    [changeUnknownOutcomes],
  );
  // ── The server's word on a paid order ─────────────────────────────
  // Stripe's browser side saying "paid" is not a confirmed order: the server
  // finalizes it, and the widget shows "Order confirmed" only on the
  // server's answer (owner ruling 2026-10-11). `askServer` never rejects; a
  // failed or silent call is "unanswered", which is never "not paid".
  //
  // `meta.silent`: the app's global mutation-error toast ("Action failed…
  // Please try again") must not show for this call. A failed confirm has
  // its own screen, which tells the buyer NOT to pay again.
  const confirmGuestPayment = trpc.embeds.confirmGuestPayment.useMutation({
    retry: false,
    meta: { silent: true },
  });
  // Nothing is set, and the host page is told nothing, once the widget is
  // gone: an answer can land after the iframe's page has unmounted it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Every embed's expired receipt secrets go, on every mount.
  useEffect(() => {
    sweepExpiredEmbedReceiptSecrets();
  }, []);
  // This load is a redirect return: Stripe's params are on the URL, or a
  // return is held from an earlier load (an iframe-only reload mid-verify,
  // whose URL is already clean). Latched on the first render: the params
  // leave the URL at once and the held return goes when it settles. A
  // payment made on such a load must not save a host origin read from the
  // referrer, which names the payment page (embed-saved-host-origin.ts).
  // An in-frame payment held for a remount does not count: that load came
  // from the host page, and its referrer names it (`hasHeldRedirectReturn`).
  // Never rendered, only handed to the checkout's save, so the server
  // render (no storage: `false`) and the client's cannot disagree.
  const [loadedAsRedirectReturn] = useState(
    () =>
      hasStripeRedirectParams((key) => searchParams.has(key)) ||
      hasHeldRedirectReturn(embedId),
  );
  const sendConfirmRef = useRef(confirmGuestPayment.mutateAsync);
  useLayoutEffect(() => {
    sendConfirmRef.current = confirmGuestPayment.mutateAsync;
  });
  // Every ask carries the order's receipt secret when this tab holds one
  // (embed-receipt-secret.ts): it is what earns the ticket codes. Read at
  // each send, so "Check again" and a re-ask about an earlier order find it
  // as the first ask did. Sent only when held, and an API that refuses the
  // field (the input is `.strict()`, and the API may have been rolled back
  // since the create) is asked once more without it
  // (`sendConfirmWithReceiptSecret`). A tab without one (a buyer back in a
  // new tab, or blocked storage after a reload) asks without it and is told
  // "confirmed" with no codes.
  const askServer = useCallback<AskEmbedServer>(
    (clientSecret, options) =>
      askEmbedServer(
        () =>
          sendConfirmWithReceiptSecret(
            (input) => sendConfirmRef.current(input),
            { embedId, hostOrigin: getEmbedHostOrigin(), clientSecret },
            heldEmbedReceiptSecret(embedId, clientSecret),
          ),
        options,
      ),
    [embedId],
  );
  // The redirect return's own asks, and only those: Firefox computes the
  // host origin of that load from a referrer that names the payment page,
  // so the origin saved before the payment stands in where the browser has
  // nothing better. An order made in-page after the return is asked about
  // with the origin computed like any other (`askServer`).
  const askServerOnRedirectReturn = useCallback<AskEmbedServer>(
    (clientSecret, options) =>
      askEmbedServer(
        () =>
          // Same tab as the payment: read back by the PaymentIntent id in
          // the return URL's client secret (see `askServer`).
          sendConfirmWithReceiptSecret(
            (input) => sendConfirmRef.current(input),
            {
              embedId,
              hostOrigin: embedHostOriginOnRedirectReturn(embedId),
              clientSecret,
            },
            heldEmbedReceiptSecret(embedId, clientSecret),
          ),
        options,
      ),
    [embedId],
  );
  // Set once the redirect-return hook has run, further down.
  const settlePendingPaymentRef = useRef<
    (paymentIntentId: string | null) => void
  >(() => {});
  // The order (by client secret) the server is being asked about as the
  // PAGE's order. The ref is the same-tick guard: "paid" can be reported
  // twice before a render.
  const [askingServerFor, setAskingServerFor] = useState<string | null>(null);
  const askingServerForRef = useRef<string | null>(null);
  // The page's order is paid as far as Stripe's browser side knows and the
  // server did not confirm it: the terminal screen that says so is up, for
  // this order. `stillUnconfirmed` after a "Check again" that changed
  // nothing; `final` when the server's refusal is one asking again cannot
  // change, so the screen offers no "Check again".
  // Orders this mount has held for a remount (`holdUnconfirmedOrder`), by
  // client secret. Memory only: each is held once, so its 30 minutes count
  // from that first hold and are never started again.
  const heldOrdersRef = useRef(new Set<string>());
  const [unconfirmed, setUnconfirmed] = useState<{
    clientSecret: string;
    stillUnconfirmed: boolean;
    final: boolean;
  } | null>(null);
  // What the server said of the order on the confirmation: "processing" is
  // a payment still with the bank, which gets its own, smaller confirmation.
  const [completion, setCompletion] = useState<"confirmed" | "processing">(
    "confirmed",
  );
  /**
   * What the server said about an order the page is NOT confirming: one the
   * buyer left behind. It changes that order's record and nothing else, so
   * an answer that lands late never moves the page.
   *
   * `paidStartsRecord`: for an order with no record (one the server would
   * not release, asked about for that reason). A "paid" answer starts its
   * record, so the buyer is told; any other answer leaves it without one,
   * and with no reminder that was not already showing.
   */
  const takeEarlierOrderAnswer = useCallback(
    (
      clientSecret: string,
      answer: EmbedServerAnswer,
      paidStartsRecord = false,
    ) => {
      if (!mountedRef.current) return;
      const paidFor =
        answer.outcome === "confirmed" || answer.outcome === "processing";
      const blank = paidStartsRecord && paidFor ? NOTHING_KNOWN : undefined;
      // Read before the change, to know whether this answer is news. The
      // updater below decides again from the state it is handed.
      const known = unknownOutcomesRef.current[clientSecret] ?? blank;
      const isNews =
        known !== undefined &&
        earlierOrderAfterServerAnswer(known, answer) !== known;
      changeUnknownOutcomes((prev) => {
        const record = prev[clientSecret] ?? blank;
        if (!record) return prev;
        const next = earlierOrderAfterServerAnswer(record, answer);
        if (next === record) return prev;
        if (next === null) {
          return Object.fromEntries(
            Object.entries(prev).filter(([secret]) => secret !== clientSecret),
          );
        }
        return { ...prev, [clientSecret]: next };
      });
      // Settled either way: paid for on the server's word, or its record
      // gone as not charged. A hold for a remount goes with it.
      if (
        paidFor ||
        (known !== undefined &&
          earlierOrderAfterServerAnswer(known, answer) === null)
      ) {
        releaseHeldOrder(embedId, clientSecret);
      }
      if (!paidFor) return;
      // The server confirmed that payment: a "still being confirmed"
      // reminder about it is no longer true.
      settlePendingPaymentRef.current(paymentIntentIdOf(clientSecret));
      // The buyer paid for that order: said even if they had dismissed the
      // reminder that its outcome was unknown. Only when the record changed:
      // the same answer a second time does not bring a dismissed banner back.
      if (isNews) setOutcomeReminderDismissed(false);
    },
    [changeUnknownOutcomes, embedId],
  );
  // One at a time, and no further once the endpoint says its budget is
  // spent: the orders not asked about keep their record as it is.
  const askAboutEarlierOrders = useCallback(
    async (clientSecrets: string[]) => {
      for (const clientSecret of clientSecrets.slice(0, EARLIER_ORDER_ASKS)) {
        // The widget is gone: nobody is left to tell.
        if (!mountedRef.current) return;
        const answer = await askServer(clientSecret, {
          askTwice: false,
          onLateAnswer: (late) => takeEarlierOrderAnswer(clientSecret, late),
        });
        takeEarlierOrderAnswer(clientSecret, answer);
        if (answer.outcome === "unanswered" && answer.rateLimited) return;
      }
    },
    [askServer, takeEarlierOrderAnswer],
  );

  // ── Giving back an order the buyer left ───────────────────────────
  // Owner ruling 2026-10-11: "A guest can release it." An order the widget
  // leaves behind is released on the server at once (its tickets go back on
  // sale) instead of keeping them until the server's own clean-up. The
  // PaymentIntent's client secret is the proof that the order is this
  // buyer's. `meta.silent` as on the confirm: a release that fails is no
  // error to the buyer, who is told what they would have been told without
  // one.
  //
  // Never on page hide or unload: a buyer away at their bank would have
  // their payment cancelled under them.
  const releaseGuestOrder = trpc.embeds.releaseGuestOrder.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const sendReleaseRef = useRef(releaseGuestOrder.mutateAsync);
  useLayoutEffect(() => {
    sendReleaseRef.current = releaseGuestOrder.mutateAsync;
  });
  // Every release asked for, by client secret: the one that is out, or what
  // it came back with. `left`: the page has left the order (it may still
  // have been the page's when the buyer asked for the release themselves).
  // Kept here, not read from a render: the answer can come before the
  // render that takes the order off the page.
  const releasesRef = useRef(
    new Map<
      string,
      {
        eventId: string;
        out: Promise<EmbedReleaseOutcome> | null;
        answered: EmbedReleaseOutcome | null;
        left: boolean;
      }
    >(),
  );
  // Orders that reached their confirmation. Never released.
  const completedSecretsRef = useRef(new Set<string>());
  // The "Let these tickets go" button, and a Continue waiting on its answer.
  const letGoButtonRef = useRef<HTMLButtonElement>(null);
  const continueKeptRef = useRef(false);
  // The buyer pressed "Let these tickets go" for this order, and the answer
  // is not in yet; and the order a press did not release.
  const [lettingGo, setLettingGo] = useState<string | null>(null);
  const [letGoFailed, setLetGoFailed] = useState<string | null>(null);
  /**
   * Asks the server to release one order. The promise of the release that
   * is out for it (never a second call while one is), or null when the
   * order may not be released.
   *
   * THE GATE. An order is never offered for release while a payment on it
   * may have gone through or may yet: it has an unknown-outcome record (a
   * confirm that failed or is still out, Stripe saying "paid", the server
   * saying so), the server is being asked about it, a confirm is in flight
   * for it, or it reached its confirmation. The server refuses to cancel a
   * paid PaymentIntent, but that is the backstop, not the gate. All read
   * from refs: the handler deciding can be the one that just changed them.
   */
  const startRelease = useCallback(
    (
      clientSecret: string,
      eventId: string,
    ): Promise<EmbedReleaseOutcome> | null => {
      const known = releasesRef.current.get(clientSecret);
      if (known?.out) return known.out;
      const page = pageOrderRef.current;
      if (
        unknownOutcomesRef.current[clientSecret] !== undefined ||
        askingServerForRef.current === clientSecret ||
        completedSecretsRef.current.has(clientSecret) ||
        (page.isPaying && page.clientSecret === clientSecret)
      ) {
        return null;
      }
      const release: {
        eventId: string;
        out: Promise<EmbedReleaseOutcome> | null;
        answered: EmbedReleaseOutcome | null;
        left: boolean;
      } = { eventId, out: null, answered: null, left: false };
      // `out` never rejects, whatever settling the answer does: the
      // buyer's Continue can be waiting on it.
      const settle = (outcome: EmbedReleaseOutcome) => {
        // The entry of the latest release for this order (a press after one
        // that went unanswered makes a new one), which is the one that
        // knows whether the page has left the order.
        const current = releasesRef.current.get(clientSecret) ?? release;
        current.answered = outcome;
        try {
          latest.current.settleRelease(
            clientSecret,
            eventId,
            outcome,
            current.left,
          );
        } catch (err: unknown) {
          traceIgnoredError("embed.settleReleaseThrew")(
            new Error(
              `settling a release threw: ${err instanceof Error ? err.name : "not an Error"}`,
            ),
          );
        }
      };
      release.out = releaseEmbedOrder(
        () =>
          sendReleaseRef.current({
            embedId,
            hostOrigin: getEmbedHostOrigin(),
            clientSecret,
          }),
        {
          // The server answered after the widget stopped waiting. "Let go"
          // is news whenever it comes: the order is cancelled, whatever the
          // buyer was told meanwhile. A late "kept" changes nothing they
          // were told.
          onLateAnswer: (late) => {
            if (late !== "kept") settle(late);
          },
        },
      ).then((outcome) => {
        release.out = null;
        settle(outcome);
        return outcome;
      });
      releasesRef.current.set(clientSecret, release);
      return release.out;
    },
    // `latest` is a ref declared further down: read when the answer comes,
    // never in the render that made this callback.
    [embedId],
  );
  /**
   * An order the page has left and that is still on the server: released if
   * it may be, and remembered. While the release is out nothing is said of
   * its tickets; `settleRelease` then says they are back on sale, or that
   * they can stay reserved. An order that may not be released is remembered
   * as reserved at once.
   */
  const leaveOrderOnServer = useCallback(
    (order: Pick<EmbedPaymentOrder, "clientSecret" | "eventId" | "orderFees">) => {
      const { clientSecret, eventId } = order;
      const answered = releasesRef.current.get(clientSecret)?.answered;
      // Released before (the same order answered a second time): it holds
      // nothing, and there is nothing to remember.
      if (answered === "released" || answered === "gone") return;
      const releasing = startRelease(clientSecret, eventId) !== null;
      const release = releasesRef.current.get(clientSecret);
      if (release) release.left = true;
      const reservedUntil = leftOrderReservedUntil(order.orderFees.holdExpiresAt);
      const now = Date.now();
      setLeftOrders((prev) => ({
        ...withoutLapsedLeftOrders(prev, now),
        [clientSecret]: {
          eventId,
          reservedUntil,
          status: releasing ? "releasing" : "reserved",
        },
      }));
    },
    [startRelease],
  );
  // Drops what is no longer true of an event the buyer opens: reservations
  // whose time is up, and "back on sale" about an order released earlier.
  const forgetSettledLeftOrders = useCallback((eventId: string) => {
    const now = Date.now();
    setLeftOrders((prev) =>
      withoutReleasedLeftOrders(withoutLapsedLeftOrders(prev, now), eventId),
    );
  }, []);
  // The buyer's next Continue waits for a release that is still out for the
  // event: until the old order has let go, the new checkout can be refused
  // by the old order's own tickets. Bounded by the release's own wait, and
  // never rejects; the checkout goes on whatever the answer.
  const waitForReleases = useCallback(async () => {
    const out = [...releasesRef.current.values()].flatMap((release) =>
      release.out !== null && release.eventId === selectedEventId
        ? [release.out]
        : [],
    );
    if (out.length > 0) await Promise.all(out);
  }, [selectedEventId]);

  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [confirmationOrder, setConfirmationOrder] =
    useState<EmbedCheckoutConfirmation | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [initialPromoCodes, setInitialPromoCodes] = useState<string[]>([]);
  // Why a redirect payment came back VERIFIED failed, shown over whichever
  // screen the buyer lands on until they move on.
  const [redirectNotice, setRedirectNotice] = useState<string | null>(null);
  // A redirect payment the server answered for: the confirmation screen
  // shows the server's status and the amount Stripe.js read (the fresh
  // iframe load has no cart or email).
  const [redirectPayment, setRedirectPayment] =
    useState<EmbedRedirectPayment | null>(null);

  // Ref mirror of `confirmationOrder`, ALWAYS written through
  // `commitConfirmationOrder`. Free orders call onCheckoutCreated →
  // onPaymentSuccess synchronously in one continuation, so the
  // onPaymentSuccess closure still sees the PREVIOUS render's
  // `confirmationOrder` (null) and would skip the hf:orderComplete bridge
  // emission — host modals then never auto-close. The ref is readable in the
  // same tick; the state copy still drives EmbedConfirmation rendering.
  const confirmationOrderRef = useRef<EmbedCheckoutConfirmation | null>(null);
  const commitConfirmationOrder = useCallback(
    (order: EmbedCheckoutConfirmation | null) => {
      confirmationOrderRef.current = order;
      setConfirmationOrder(order);
    },
    [],
  );

  const clientKeyRef = useRef<string>(generateClientKey());

  // A failed guest checkout gets a fresh idempotency key, or a request that
  // died holding the server's lock (up to 900 s) would refuse every retry
  // until it lapsed. Not while that lock is still held by a running attempt.
  // EmbedCheckout reads the new key on the re-render its error message
  // triggers.
  const handleCheckoutFailed = useCallback((error: unknown) => {
    if (!keepsCheckoutClientKey(error)) {
      clientKeyRef.current = generateClientKey();
    }
  }, []);

  // Another email is another buyer, so another purchase: a fresh key. The
  // server keys an order by the buyer its email resolves to as well as by
  // this key, so one made for the old email is never replayed for the new
  // one. What the fresh key does here: an order that was asked for under the
  // old email and lands late is one the page has left (`adoptCreatedOrder`),
  // not the order the buyer pays, with its tickets sent to the old address.
  const handleGuestEmailChange = useCallback(
    (next: string) => {
      setGuestEmail(next);
      if (next.trim() !== guestEmail.trim()) {
        clientKeyRef.current = generateClientKey();
      }
    },
    [guestEmail],
  );

  // Leaves the order behind: the payment step closes, and the next Continue
  // creates a fresh order under a fresh key. An order still on the server is
  // released there (`leaveOrderOnServer`); one that cannot be keeps its
  // tickets until the cart reaper cancels it and its PaymentIntent
  // (release-expired-carts), which is later than its 15-minute countdown
  // (see `leftOrderReservedUntil`).
  // Its PaymentIntent secret leaves the page's order state here, so no
  // payment form can confirm it afterwards. The secret does live on as the
  // key of what the widget remembers of the order (`leftOrders`, and its
  // unknown-outcome record if it has one). It is read back for two things:
  // the release itself, and to ask the server what became of that order
  // (`askAboutEarlierOrders`). Nothing confirms a payment with it.
  const discardPaymentOrder = useCallback(
    (
      order: EmbedPaymentOrder,
      why: EmbedOrderNoticeKind,
      // False only when the server is known to have cleaned the order up.
      stillOnServer = true,
    ) => {
      setPaymentOrder(null);
      commitConfirmationOrder(null);
      // A decline on the old order says nothing about the next one.
      setCheckoutError(null);
      setOrderNotice({ kind: why, eventId: order.eventId });
      // The order is still on the server with its tickets, whether it was
      // left for another cart or ran past its time to pay: the buyer's next
      // Continue for the same seats can be refused by it. So it is released.
      if (stillOnServer) leaveOrderOnServer(order);
      clientKeyRef.current = generateClientKey();
    },
    [commitConfirmationOrder, leaveOrderOnServer],
  );

  // Opening another event or another date leaves this one's order behind
  // without a notice: the buyer is no longer looking at it. It is released
  // all the same; if that does not happen, its tickets stay reserved, which
  // is remembered for when they come back.
  const leavePaymentOrder = useCallback(() => {
    if (paymentOrder) leaveOrderOnServer(paymentOrder);
    setPaymentOrder(null);
  }, [paymentOrder, leaveOrderOnServer]);

  // A cart that is a different purchase (`isSameEmbedCart`) gets a fresh
  // checkout key, whether or not an order is on screen. The server cannot be
  // relied on to refuse the old key: its idempotency hash covers ticket types,
  // quantities, pay-what-you-want amounts and promo codes but NOT seat ids,
  // so a same-quantity seat swap under a kept key (a lost response keeps it)
  // would be answered with the OLD order, for the old seats. The same cart
  // keeps its key, so a retry after a lost response still replays.
  const handleCartChange = useCallback(
    (next: CartItem[]) => {
      setCart(next);
      if (isSameEmbedCart(cart, next)) return;
      clientKeyRef.current = generateClientKey();
      if (paymentOrder && !isSameEmbedCart(paymentOrder.cart, next)) {
        discardPaymentOrder(paymentOrder, "changed");
      }
    },
    [cart, paymentOrder, discardPaymentOrder],
  );

  // The checkout's own cart updates (a re-quote after `seat_price_changed`)
  // go through the same rule. A re-quote changes prices, not the purchase, so
  // it keeps the key and any order; an update that changed WHAT is bought
  // would rotate the key and discard the order like any other cart change.
  // The checkout only calls this while its create is in flight, when Back is
  // locked and the cart cannot change under it, so `cart` here is current.
  const handleCartUpdate = useCallback(
    (update: (current: CartItem[]) => CartItem[]) =>
      handleCartChange(update(cart)),
    [cart, handleCartChange],
  );

  // The order's reservation running out discards it the same way: its
  // tickets are no longer the buyer's to pay for. One timer per order, held
  // here because EmbedCheckout (and its countdown) is unmounted while the
  // buyer is back on the event detail. A confirm in flight is waited out: it
  // may still land, and its result needs the order it belongs to.
  // `useHasPassed` checks when the time is due and again whenever the page
  // comes back into view, so a device that slept through the 15 minutes
  // wakes to the order already gone, not to its payment form.
  // The discard itself is `discardWhenReservationRanOut`, further down.
  const reservedUntil = livePaymentOrder?.orderFees.holdExpiresAt ?? null;
  const reservationRanOut = useHasPassed(reservedUntil);
  // Stripe says the order's PaymentIntent is canceled (the payment form asks
  // after a confirm fails): the server cleaned the order up after its time
  // to pay, whatever this device's clock says. Its tickets went back with
  // it, so nothing of it is left reserved.
  const handlePaymentOrderExpired = useCallback(() => {
    if (livePaymentOrder) {
      // A canceled PaymentIntent was not charged, whatever was unknown.
      forgetUnknownOutcome(livePaymentOrder.clientSecret);
      discardPaymentOrder(livePaymentOrder, "expired", false);
    }
  }, [livePaymentOrder, discardPaymentOrder, forgetUnknownOutcome]);

  // What the buyer is told about orders they left, for the event on screen.
  const earlierReservedUntil = selectedEventId
    ? leftOrdersReservedUntil(leftOrders, selectedEventId)
    : null;
  const earlierReservationOver = useHasPassed(earlierReservedUntil);
  const earlierOrderReserved =
    earlierReservedUntil !== null && !earlierReservationOver;
  // An order left for this event was released. Said only when none is still
  // reserved (see EmbedOrderNotice).
  const earlierOrderReleased =
    selectedEventId !== null &&
    hasReleasedLeftOrder(leftOrders, selectedEventId) &&
    !earlierOrderReserved;
  const noticeForThisEvent =
    orderNotice?.eventId === selectedEventId
      ? (orderNotice?.kind ?? null)
      : null;
  // "You changed your tickets" stays up across further cart changes while
  // the order it is about can still have tickets reserved, and goes when
  // that time passes (or when a new order is created: `onCheckoutCreated`).
  const shownOrderNotice =
    noticeForThisEvent === "changed" &&
    earlierReservedUntil !== null &&
    earlierReservationOver
      ? null
      : noticeForThisEvent;
  // The earlier order's reservation is said once: beside a refused checkout
  // when there is one (EmbedCheckout prints it under the error), otherwise
  // in the notice above the screen.
  const checkoutRefused =
    screen === "checkout" && !livePaymentOrder && Boolean(checkoutError);
  // One completion per order, however many times it is reported (a free
  // order's late response and its retry can both land).
  const completedOrderIdRef = useRef<string | null>(null);

  // Billing + acceptance draft, held on the page so it survives EmbedCheckout
  // unmounting when the buyer steps back to the event detail and forward
  // again. A ref (not state) avoids re-rendering the whole widget on every
  // keystroke — the remount itself is a page render that reads `.current`.
  const checkoutDraftRef = useRef<EmbedCheckoutDraft | null>(null);
  // Re-renders the widget so EmbedCheckout is handed a key rotated outside
  // any state change (it sends the `clientKey` prop of its last render).
  const [, handOverNewClientKey] = useReducer((n: number) => n + 1, 0);
  const handleCheckoutDraftChange = useCallback((draft: EmbedCheckoutDraft) => {
    const codesBefore = checkoutDraftRef.current?.promoCodes ?? [];
    checkoutDraftRef.current = draft;
    // Other promo codes are another purchase, like another email: a fresh
    // key, so an order asked for with the old codes that lands late is left
    // behind instead of quietly taking the place of the one the buyer asked
    // for next.
    if (codesBefore.join("\n") !== draft.promoCodes.join("\n")) {
      clientKeyRef.current = generateClientKey();
      handOverNewClientKey();
    }
  }, []);

  const { emitOrderComplete, emitCartUpdate } = useEmbedBridge(embedId, screen);

  // Apply URL-based theme overrides (CSS custom properties on <html>). The
  // widget's own chrome reads `--hf-*` directly (embed-theme.ts); SHARED app
  // components (event cards, EventDetail, the checkout stepper) paint with
  // platform tokens, so the screen root below bridges the active overrides
  // onto those names. The calendar browse view gets the values too — its
  // engine needs a calendar-specific mapping (brand → the frame rule).
  const themeOverrides = useEmbedThemeOverrides();

  // Read ?promo= param from URL on mount and pass to checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const promo = params.get("promo");
    if (!promo) return;
    const codes = promo
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length >= 3 && c.length <= 50)
      .slice(0, 5);
    if (codes.length > 0) setInitialPromoCodes(codes);
  }, []);

  // Emit cart updates to the parent frame
  useEffect(() => {
    emitCartUpdate(cart);
  }, [cart, emitCartUpdate]);

  // ── Browse queries (one per view, lazily enabled) ─────────────────
  // Only ONE fires on load. `enabled` is derived from signals that do NOT
  // depend on query data, so there is no circular gate: `preResolvedView`
  // enables exactly its own query. It is null ONLY when the server lookup
  // degraded, and then the grid query doubles as the config probe (which is
  // also what a bare /embed/[id] rendered before this feature).
  //
  // `*Activated` is a one-way latch: once a view has been shown, its query
  // observer STAYS mounted. With `staleTime: 60_000` and the client's
  // `refetchOnWindowFocus: false` (plus `refetchOnReconnect: false` below),
  // that makes repeated flips cost exactly one fetch per view for the life of
  // the widget (NFR-002).
  const [listActivated, setListActivated] = useState(false);
  const [calendarActivated, setCalendarActivated] = useState(false);
  const listEnabled = preResolvedView !== "calendar" || listActivated;
  const calendarEnabled = preResolvedView === "calendar" || calendarActivated;

  const { data, error, refetch } = trpc.embeds.getForWidget.useQuery(
    { embedId, hostOrigin: getEmbedHostOrigin(), scope },
    {
      enabled: listEnabled,
      staleTime: 60_000,
      // Both observers stay mounted after a toggle flip (see the latch above),
      // so a reconnect would otherwise refetch BOTH payloads at once — the
      // widget only ever renders one.
      refetchOnReconnect: false,
      // An origin-allowlist rejection is deterministic — retrying can't
      // succeed, so don't burn two extra round-trips on FORBIDDEN.
      retry: (failureCount, err) =>
        err.data?.code !== "FORBIDDEN" && failureCount < 2,
      retryDelay: 1500,
    },
  );

  const calendarQuery = trpc.embeds.getCalendarEvents.useQuery(
    { embedId, hostOrigin: getEmbedHostOrigin(), scope },
    {
      enabled: calendarEnabled,
      staleTime: 60_000,
      // Both observers stay mounted after a toggle flip (see the latch above),
      // so a reconnect would otherwise refetch BOTH payloads at once — the
      // widget only ever renders one.
      refetchOnReconnect: false,
      // An origin-allowlist rejection is deterministic — retrying can't
      // succeed, so don't burn two extra round-trips on FORBIDDEN.
      retry: (failureCount, err) =>
        err.data?.code !== "FORBIDDEN" && failureCount < 2,
      retryDelay: 1500,
    },
  );

  // The stored default: server-resolved when available, else off whichever
  // payload landed — both procedures return the same `defaultView` /
  // `viewToggle` (FR-005), so resolution behaves identically either way.
  const configuredDefaultView =
    initialDefaultView ??
    data?.embed.defaultView ??
    calendarQuery.data?.embed.defaultView ??
    null;

  const view: EmbedView =
    viewerView ??
    resolveEmbedBrowseView({
      routeView,
      viewParam,
      configuredDefaultView,
    });
  const isCalendarView = view === "calendar";

  // Latch the active view's query on. Deliberately an effect and not a render
  // -time ref write: `view` can only become "calendar" here after a payload
  // resolved it (or the viewer flipped the toggle), both of which are already
  // past first paint.
  useEffect(() => {
    if (view === "calendar") setCalendarActivated(true);
    else setListActivated(true);
  }, [view]);

  const { data: platformSettings } =
    trpc.embeds.getPlatformPublicSettings.useQuery(undefined, {
      staleTime: 300_000,
      retry: 1,
    });
  const supportEmail = platformSettings?.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  // For single-event embeds, auto-select the event and skip the grid.
  // LIST VIEW ONLY: an event-subject CALENDAR still has a calendar to browse
  // (and go back to), so it never auto-skips.
  const isSingleEvent = !isCalendarView && data?.embed.subjectType === "event";

  useEffect(() => {
    if (isSingleEvent && data?.event && !selectedEventId) {
      setSelectedEventId(data.event.id);
      // Never off a redirect-return confirmation: this data can land AFTER
      // Stripe.js verified the payment, and swapping "Payment received" for an
      // open ticket picker invites a second charge. Done still finds the event.
      setScreen((s) => (s === "confirmation" ? s : "eventDetail"));
    }
  }, [isSingleEvent, data?.event, selectedEventId]);

  const goForward = useCallback((next: Screen) => {
    setSlideDir("forward");
    setScreen(next);
    setRedirectNotice(null);
  }, []);

  // Canonical Ithas Fire event URL used by link-out embeds. Prefer the slug,
  // fall back to the event id. Always opened in a NEW TAB by the embed (never
  // navigates the iframe's top frame). One builder for the whole widget.
  const buildEventUrl = embedEventUrl;

  // ── Redirect return from a payment method (Amazon Pay, Cash App…) ──
  // Stripe sends the buyer back with its params on the URL. The buyer MAY
  // HAVE PAID: buying reopens only on a failure Stripe.js verifies, and
  // anything it cannot settle is a terminal screen (useEmbedRedirectReturn).
  // Seeded from `useSearchParams` so the server render agrees.
  //
  // `hf:orderComplete` does NOT fire on this path. The server's answer now
  // gives the order id the return URL lacked, but the event's `totalCents`
  // is the order's ticket subtotal (`amountGrossCents`, what the in-page
  // purchase sends), and a redirect return has only the PaymentIntent's
  // amount: the whole charge, fees and tax included. Sending that under the
  // same field would give a host page two meanings for one number
  // (embed-widgets.md says so).
  const handleRedirectConfirmed = useCallback(
    (payment: EmbedRedirectPayment) => {
      // The server confirmed the order, or says the payment is clearing and
      // the webhook will finish it.
      setRedirectPayment(payment);
      // The origin saved for this return has done its work.
      forgetEmbedHostOrigin(embedId);
      goForward("confirmation");
    },
    [goForward, embedId],
  );
  // The reason shows as a notice over whichever screen the buyer lands on,
  // and goes once they move on (never carried into the next checkout).
  const handleRedirectFailed = useCallback((message: string) => {
    setRedirectNotice(message);
  }, []);
  const {
    state: redirectReturn,
    pendingNotice,
    dismissPendingNotice,
    settlePendingPayment,
    stripeSaid: redirectStripeSaid,
    checkAgain: checkRedirectAgain,
    checking: checkingRedirect,
    stillUnconfirmed: redirectStillUnconfirmed,
    final: redirectFinal,
  } = useEmbedRedirectReturn({
    embedId,
    seeded: hasStripeRedirectParams((key) => searchParams.has(key)),
    onConfirmed: handleRedirectConfirmed,
    onFailed: handleRedirectFailed,
    askServer: askServerOnRedirectReturn,
  });
  useLayoutEffect(() => {
    settlePendingPaymentRef.current = settlePendingPayment;
  });

  const goBack = useCallback((next: Screen) => {
    setSlideDir("back");
    setScreen(next);
  }, []);

  // ── Answers that arrive late ──────────────────────────────────────
  // An order can land long after it was asked for: the checkout stops
  // waiting for `createGuestCheckout` after a while, the request does not,
  // and Stripe and the server are asked about a payment across an await. The
  // handlers below are therefore never called from the render that started the wait
  // (whose cart, order and screen are long out of date). They are reached
  // through `latest`, which always holds the ones from the last render.

  /**
   * A created order: whether it becomes the page's order.
   *
   * It does not when the buyer has moved on to another purchase since it was
   * asked for. The checkout key says so (it rotates on any change of cart,
   * event, date, email or promo codes, and when the widget is closed), and
   * so does an order already on screen or a payment in flight: neither is
   * ever replaced by an answer that comes in behind it. A paid order left
   * behind this way still exists on the server with its tickets: it is
   * released like any order the page leaves. A free one is complete (its tickets
   * went to the email it was asked for with); the page stays where it is.
   */
  const adoptCreatedOrder = (
    payload: EmbedCheckoutConfirmation,
    created: EmbedPaymentOrder | null,
    sentClientKey: string,
  ): boolean => {
    if (payload.orderId === completedOrderIdRef.current) {
      // The order already on the confirmation, answered again (its first
      // request landing behind the retry that completed it). There is
      // nothing left to adopt, pay or complete a second time.
      return false;
    }
    if (created && livePaymentOrder?.clientSecret === created.clientSecret) {
      // The order on screen, answered a second time (a retry replays it,
      // and the first answer can still land).
      return true;
    }
    const sentUnder = created?.clientKey ?? sentClientKey;
    if (
      sentUnder !== clientKeyRef.current ||
      livePaymentOrder !== null ||
      isPaying
    ) {
      if (created) {
        // "You changed your tickets" only where that is what happened.
        if (
          created.eventId === selectedEventId &&
          !isSameEmbedCart(created.cart, cart)
        ) {
          setOrderNotice({ kind: "changed", eventId: created.eventId });
        }
        leaveOrderOnServer(created);
      }
      return false;
    }
    setPaymentOrder(created);
    commitConfirmationOrder(payload);
    setOrderNotice(null);
    if (created) {
      const { eventId } = created;
      setLeftOrders((prev) => withoutReleasedLeftOrders(prev, eventId));
    }
    return true;
  };

  /**
   * Puts the tickets a server answer carries on the PAGE's order, for its
   * confirmation to show. Called only where the answer has already been
   * matched to the page's order by client secret, and `ticketsForOrder`
   * checks the order id again: an answer about an order the buyer left
   * (`takeEarlierOrderAnswer`) never reaches here, so its tickets are never
   * shown as this purchase.
   *
   * The widget keeps the tickets on `confirmationOrder` only: `handleClose`
   * drops them with it, and `hf:orderComplete` is sent the order id, the
   * subtotal and the currency by name, never the order object. The codes
   * also stay in memory in React Query's mutation results (the confirm's
   * and the create's) until their gcTime runs out; never in storage.
   */
  const holdTicketsOf = (answer: EmbedServerAnswer) => {
    const order = confirmationOrderRef.current;
    if (!order) return;
    const tickets = ticketsForOrder(order.orderId, answer);
    if (tickets.length > 0) commitConfirmationOrder({ ...order, tickets });
  };

  /**
   * The page's order has its answer: on to the confirmation. A free order
   * is complete as created; a paid one gets here only on the server's
   * "confirmed" or "processing" (`settlePaidOrder`).
   */
  const completeOrder = (
    email: string,
    serverSaid: "confirmed" | "processing" = "confirmed",
  ) => {
    // Once per order: a second report of the same order (see
    // `completedOrderIdRef`) must not tell the host page about a second
    // sale.
    const completedId = confirmationOrderRef.current?.orderId ?? null;
    if (completedId !== null && completedOrderIdRef.current === completedId) {
      return;
    }
    completedOrderIdRef.current = completedId;
    setCompletion(serverSaid);
    setUnconfirmed(null);
    setConfirmationEmail(email);
    // Paid (or free): there is no order left to pay, so nothing for a
    // lapsing reservation to discard under the confirmation.
    setPaymentOrder(null);
    setOrderNotice(null);
    // This order is settled. What is on record about EARLIER orders is not,
    // and is not dropped with it: each has its client secret, so the server
    // is asked about each one. One it says was paid for is said plainly over
    // the confirmation, one it settles as not charged is forgotten, and the
    // rest keep their reminder (`takeEarlierOrderAnswer`).
    const completedSecret = confirmationOrderRef.current?.clientSecret ?? null;
    if (completedSecret !== null) {
      // Before its record goes: the record is what kept it from release.
      completedSecretsRef.current.add(completedSecret);
      forgetUnknownOutcome(completedSecret);
    }
    void askAboutEarlierOrders(
      Object.entries(unknownOutcomes)
        .filter(
          ([clientSecret, record]) =>
            clientSecret !== completedSecret && record.serverSaid === null,
        )
        .map(([clientSecret]) => clientSecret),
    );
    // A purchase that just succeeded in-page settles any earlier
    // unconfirmed-redirect reminder (a host reload would nag).
    clearPendingMarker(embedId);
    // And a "still being confirmed" reminder already on screen, when it is
    // about THIS payment: it is confirmed. One about a different payment
    // stays up: nothing was learned of that one.
    if (completedSecret !== null) {
      settlePendingPayment(paymentIntentIdOf(completedSecret));
    }
    // Read the REF, not the state: free orders reach here in the same
    // continuation as `adoptCreatedOrder`, before a re-render, so the state
    // is still null and the emission would be silently skipped (host modals
    // never auto-close).
    const order = confirmationOrderRef.current;
    // Not once the widget is gone: the host page is told of a sale only by
    // a widget that is showing its confirmation.
    if (order && mountedRef.current) {
      // Currency rides the confirmation payload (resolved by EmbedCheckout
      // from getEventDetail — the same `event.currency ?? "usd"` rule
      // getForWidget maps, and for the ACTUAL charged event, so
      // series-sibling dates missing from the browse list resolve
      // correctly). The calendar browse has no getForWidget list, so both
      // modes read it here.
      emitOrderComplete(
        order.orderId,
        order.orderFees.amountGrossCents,
        order.currency,
      );
    }
    goForward("confirmation");
  };

  /**
   * Stripe's browser side says an order is paid (`stripeSaid`: "succeeded",
   * or "processing" for a payment still clearing). The server is asked
   * before anything is shown as confirmed.
   *
   * Recorded first, under the order: from here on the widget never says
   * "you have not been charged" about it, whatever happens to the ask.
   * `askTwice` is false for the buyer's own "Check again".
   */
  const confirmPaidOrder = (
    clientSecret: string,
    stripeSaid: PaidStatus,
    askTwice = true,
  ) => {
    keptUnansweredRef.current.delete(clientSecret);
    if (askingServerForRef.current === clientSecret) return;
    changeUnknownOutcomes((prev) => ({
      ...prev,
      [clientSecret]: { ...(prev[clientSecret] ?? NOTHING_KNOWN), stripeSaid },
    }));
    if (paymentOrder?.clientSecret !== clientSecret) {
      // Not the page's order (the buyer has left it): asked about as an
      // earlier order, and the page stays where it is.
      void askAboutEarlierOrders([clientSecret]);
      return;
    }
    askingServerForRef.current = clientSecret;
    setAskingServerFor(clientSecret);
    setUnconfirmed((shown) =>
      shown?.clientSecret === clientSecret
        ? { ...shown, stillUnconfirmed: false }
        : shown,
    );
    void askServer(clientSecret, {
      askTwice,
      // An ask the widget stopped waiting for can still be answered. A
      // "paid" answer is news whenever it comes: the buyer moves on to
      // their confirmation without pressing anything. (`settlePaidOrder`
      // leaves the page alone if it has left the order by then.)
      onLateAnswer: (late) => {
        if (late.outcome !== "not_paid") {
          latest.current.settlePaidOrder(clientSecret, late, false);
        }
      },
    }).then((answer) =>
      latest.current.settlePaidOrder(clientSecret, answer, !askTwice),
    );
  };

  /** The server's answer about an order `confirmPaidOrder` asked it about. */
  const settlePaidOrder = (
    clientSecret: string,
    answer: EmbedServerAnswer,
    afterCheckAgain: boolean,
  ) => {
    if (!mountedRef.current) return;
    if (askingServerForRef.current === clientSecret) {
      askingServerForRef.current = null;
    }
    setAskingServerFor((asking) => (asking === clientSecret ? null : asking));
    if (
      paymentOrder?.clientSecret !== clientSecret ||
      confirmationOrderRef.current?.clientSecret !== clientSecret
    ) {
      // The page left this order while the server was asked (the buyer
      // changed the cart or opened another event). The answer is kept with
      // the order's record and the page does not move.
      takeEarlierOrderAnswer(clientSecret, answer);
      return;
    }
    if (answer.outcome === "confirmed" || answer.outcome === "processing") {
      holdTicketsOf(answer);
      // The order's email is the page's: the details form is not on screen
      // while an order is.
      completeOrder(guestEmail.trim(), answer.outcome);
      return;
    }
    // The server did not answer, or said "not paid" against Stripe's "paid".
    // Neither is "you were not charged": the buyer is told the payment went
    // through, that the order is not confirmed yet, and can ask again.
    const refusedForGood = answer.outcome === "unanswered" && answer.final;
    setUnconfirmed({
      clientSecret,
      stillUnconfirmed: afterCheckAgain,
      final: refusedForGood,
    });
    // A remount (the host page reloads, or the iframe does) loads the widget
    // fresh, with none of this. The order is held as a redirect return, so
    // that load resumes it as one: Stripe.js reads the PaymentIntent, the
    // server is asked again, and the buyer sees the confirmation on its word
    // or this screen again (`holdUnconfirmedOrder`: sessionStorage only, 30
    // minutes). A final refusal is the same answer every time: nothing to
    // ask again, so its secret goes, as on a redirect return.
    // Held ONCE per order: the window counts from that hold, and a Check
    // again past it must not store the secret afresh.
    if (refusedForGood) {
      releaseHeldOrder(embedId, clientSecret);
    } else if (!heldOrdersRef.current.has(clientSecret)) {
      heldOrdersRef.current.add(clientSecret);
      holdUnconfirmedOrder(embedId, clientSecret);
    }
    // And where storage would not take the hold, or after a final refusal,
    // the marker brings back the reminder to check their email before
    // buying again. The PaymentIntent's ID, never its secret.
    writePendingMarker(embedId, paymentIntentIdOf(clientSecret));
  };

  /**
   * What Stripe said about an order whose reservation ran out while nobody
   * could say whether its payment went through (`status`: null when Stripe
   * could not be asked either).
   */
  const settleExpiredOrder = (
    order: EmbedPaymentOrder,
    status: string | null,
  ) => {
    // Gone meanwhile: the buyer changed the cart or closed the widget.
    if (paymentOrder?.clientSecret !== order.clientSecret) return;
    const paid = asPaidStatus(status);
    if (paid) {
      // The charge landed after all, as far as Stripe says: the server is
      // asked about the order before any confirmation.
      confirmPaidOrder(order.clientSecret, paid);
      return;
    }
    // Stripe's answer is about THIS order, and settles it only when no
    // confirm of ours can still land on it (`settlesAsUnpaid`). Otherwise the
    // order goes with its outcome still unknown, and the buyer keeps being
    // told to check their email.
    const confirmsStillOut =
      unknownOutcomes[order.clientSecret]?.confirmsStillOut ?? 0;
    if (settlesAsUnpaid(status, confirmsStillOut)) {
      forgetUnknownOutcome(order.clientSecret);
    }
    // A canceled PaymentIntent means the server cleaned the order up, and
    // its tickets went back with it.
    discardPaymentOrder(order, "expired", status !== "canceled");
  };

  /**
   * What came of a release (`startRelease`).
   *
   * For an order the page had left: its tickets are back on sale, or they
   * can stay reserved after all, and the buyer is told which.
   *
   * For the order still on the page, which is the buyer's own press on "Let
   * these tickets go": released, it leaves the page as a discarded order
   * does, with nothing remembered as reserved; not released, it stays the
   * page's order, still payable, and the notice says the tickets are still
   * theirs.
   */
  const settleRelease = (
    clientSecret: string,
    eventId: string,
    outcome: EmbedReleaseOutcome,
    left: boolean,
  ) => {
    if (!mountedRef.current) return;
    const letGo = outcome === "released" || outcome === "gone";
    setLettingGo((secret) => (secret === clientSecret ? null : secret));
    if (letGo) {
      // The server has cancelled the order's PaymentIntent (or found the
      // order already cancelled): nothing was charged on it and nothing can
      // be. A record that says its payment is unknown is settled by that.
      keptUnansweredRef.current.delete(clientSecret);
      forgetUnknownOutcome(clientSecret);
    }
    setLeftOrders((prev) => {
      const remembered = prev[clientSecret];
      if (!remembered || remembered.status === "released") return prev;
      // "Let go" also for an order already said to be reserved: its release
      // went unanswered, and the answer has come after all.
      if (!letGo && remembered.status !== "releasing") return prev;
      return {
        ...prev,
        [clientSecret]: {
          ...remembered,
          status: letGo ? "released" : "reserved",
        },
      };
    });
    if (!left && paymentOrder?.clientSecret === clientSecret) {
      if (!letGo) {
        setLetGoFailed(clientSecret);
      } else if (!pageOrderRef.current.isPaying) {
        // The control went with the order. Focus follows to the notice that
        // says what happened, unless the buyer has put it somewhere else.
        const active = document.activeElement;
        focusOrderNoticeRef.current =
          active === null ||
          active === document.body ||
          active === letGoButtonRef.current;
        discardPaymentOrder(paymentOrder, "released", false);
      }
      // Let go with a confirm in flight on it (an answer that came late,
      // after the buyer went on to pay): the order is not pulled from under
      // the payment form. The confirm fails on the cancelled PaymentIntent,
      // and the form's own path discards the order as expired.
    }
    // The server kept the order: it may have been paid for. Asked once.
    if (outcome === "kept") {
      const take = (answer: EmbedServerAnswer) =>
        latest.current.settleKeptOrder(clientSecret, answer);
      void askServer(clientSecret, {
        askTwice: false,
        onLateAnswer: take,
      }).then(take);
    }
  };

  /**
   * The server's answer about an order it would not release.
   *
   * - Paid: the page's own order goes to its confirmation, and an order the
   *   page has left is said as an earlier order that was paid for.
   * - No answer: the server refused to cancel the order, and "it is paid" is
   *   one of its reasons, so nobody can say the buyer was not charged. The
   *   order gets an unknown-outcome record: "you have not been charged" is
   *   withheld, the reminder to check their email shows, the order is asked
   *   about again when a later one completes, and it is not offered for
   *   release a second time.
   * - Not paid: nothing changes and nothing shows. If it comes late, after
   *   "no answer" started a record, it settles that record like any earlier
   *   order's.
   */
  const settleKeptOrder = (clientSecret: string, answer: EmbedServerAnswer) => {
    if (!mountedRef.current) return;
    if (answer.outcome === "unanswered") {
      keptUnansweredRef.current.add(clientSecret);
      changeUnknownOutcomes((prev) =>
        clientSecret in prev
          ? prev
          : { ...prev, [clientSecret]: NOTHING_KNOWN },
      );
      setOutcomeReminderDismissed(false);
      return;
    }
    const startedRecord = keptUnansweredRef.current.delete(clientSecret);
    if (answer.outcome === "not_paid") {
      if (startedRecord) takeEarlierOrderAnswer(clientSecret, answer);
      return;
    }
    if (
      releasesRef.current.get(clientSecret)?.left !== true &&
      paymentOrder?.clientSecret === clientSecret &&
      confirmationOrderRef.current?.clientSecret === clientSecret
    ) {
      holdTicketsOf(answer);
      completeOrder(guestEmail.trim(), answer.outcome);
      return;
    }
    takeEarlierOrderAnswer(clientSecret, answer, true);
  };

  /** The buyer pressed "Let these tickets go" for the order on the page. */
  const letGoOfOrder = () => {
    if (!livePaymentOrder) return;
    const { clientSecret, eventId } = livePaymentOrder;
    // Null: the order may not be released (the gate). A second press while
    // the first is out gets the same release back, and sends nothing.
    if (startRelease(clientSecret, eventId) === null) return;
    setLettingGo(clientSecret);
    setLetGoFailed(null);
  };

  /**
   * Continue from the event detail. While the page's order is being let go
   * the checkout would open its payment form on an order about to be
   * cancelled, so Continue waits for the answer and then goes on, if the
   * buyer is still where they pressed it, with the tickets they pressed it
   * on. One Continue is kept at a time: a second press while it waits adds
   * nothing.
   */
  const continueToCheckout = () => {
    const out = livePaymentOrder
      ? (releasesRef.current.get(livePaymentOrder.clientSecret)?.out ?? null)
      : null;
    if (out === null) {
      goForward("checkout");
      return;
    }
    if (continueKeptRef.current) return;
    continueKeptRef.current = true;
    const pressedOn = { eventId: selectedEventId, cart };
    void out.then(() => {
      continueKeptRef.current = false;
      latest.current.continueAfterRelease(pressedOn);
    });
  };
  const continueAfterRelease = (pressedOn: {
    eventId: string | null;
    cart: CartItem[];
  }) => {
    if (!mountedRef.current) return;
    if (
      screen === "eventDetail" &&
      selectedEventId === pressedOn.eventId &&
      isSameEmbedCart(pressedOn.cart, cart)
    ) {
      goForward("checkout");
    }
  };

  const latestHandlers = {
    adoptCreatedOrder,
    completeOrder,
    confirmPaidOrder,
    settlePaidOrder,
    settleExpiredOrder,
    settleRelease,
    settleKeptOrder,
    letGoOfOrder,
    continueToCheckout,
    continueAfterRelease,
  };
  const latest = useRef(latestHandlers);
  // In the commit, not after paint: an answer cannot arrive in between and
  // find the handlers of the render before.
  useLayoutEffect(() => {
    latest.current = latestHandlers;
  });
  const handleCheckoutCreated = useCallback(
    (
      payload: EmbedCheckoutConfirmation,
      created: EmbedPaymentOrder | null,
      sentClientKey: string,
    ) => latest.current.adoptCreatedOrder(payload, created, sentClientKey),
    [],
  );
  const handleLetGo = useCallback(() => latest.current.letGoOfOrder(), []);
  const handleContinueToCheckout = useCallback(
    () => latest.current.continueToCheckout(),
    [],
  );
  // Where focus goes when the buyer's own press released the page's order:
  // from the button they pressed (`letGoButtonRef`, compared by identity)
  // to the notice that says what happened.
  const orderNoticeRef = useRef<HTMLParagraphElement>(null);
  const focusOrderNoticeRef = useRef(false);
  useEffect(() => {
    if (!focusOrderNoticeRef.current) return;
    focusOrderNoticeRef.current = false;
    orderNoticeRef.current?.focus();
  });
  const handlePaymentSuccess = useCallback(
    (email: string, paid?: { clientSecret: string; status: PaidStatus }) =>
      paid
        ? latest.current.confirmPaidOrder(paid.clientSecret, paid.status)
        : // A free order: nothing was charged and it is complete as created.
          latest.current.completeOrder(email),
    [],
  );

  // The order's reservation ran out (`reservationRanOut`): it is discarded.
  // A confirm in flight is waited out: it may still land, and its result
  // needs the order it belongs to.
  //
  // One case is not discarded on sight: a payment on THIS order that nobody
  // could confirm or rule out. (An unsettled payment on an earlier order says
  // nothing about this one, and asking about this one settles nothing there.)
  // While the order was live a second attempt reused its PaymentIntent, so
  // the buyer could not pay twice. That ends here: the key rotates and the notice invites them to reserve again. So
  // Stripe is asked once more first, once per order, and a charge that did
  // land goes to the server for the order's confirmation instead.
  //
  // An order Stripe has ALREADY said is paid is never discarded here: the
  // server is being asked about it, or the buyer is on the screen that says
  // the payment went through and the order is not confirmed yet. Inviting
  // them to reserve again would be inviting a second charge.
  const askedAtExpiryRef = useRef<string | null>(null);
  const liveRecord = livePaymentOrder
    ? unknownOutcomes[livePaymentOrder.clientSecret]
    : undefined;
  const liveOutcomeUnknown = liveRecord !== undefined;
  const liveStripeSaid = liveRecord?.stripeSaid ?? null;
  // The server is being asked about the order on the page.
  const isConfirmingOrder =
    livePaymentOrder !== null &&
    askingServerFor === livePaymentOrder.clientSecret;
  useEffect(
    function discardWhenReservationRanOut() {
      if (!livePaymentOrder || !reservationRanOut || isPaying) return;
      if (liveStripeSaid !== null || isConfirmingOrder) return;
      if (!liveOutcomeUnknown) {
        discardPaymentOrder(livePaymentOrder, "expired");
        return;
      }
      if (askedAtExpiryRef.current === livePaymentOrder.clientSecret) return;
      askedAtExpiryRef.current = livePaymentOrder.clientSecret;
      const order = livePaymentOrder;
      void readEmbedPaymentStatus(order.clientSecret).then((status) =>
        latest.current.settleExpiredOrder(order, status),
      );
    },
    [
      livePaymentOrder,
      reservationRanOut,
      isPaying,
      liveOutcomeUnknown,
      liveStripeSaid,
      isConfirmingOrder,
      discardPaymentOrder,
    ],
  );

  const handleSelectEventById = useCallback(
    (eventId: string) => {
      setSelectedEventId(eventId);
      setCart([]);
      setCheckoutError(null);
      setOrderNotice(null);
      // Reset all payment-tied state so the new event starts a fresh purchase.
      // Mirrors handleClose: a stale clientSecret/confirmationOrder would let a
      // buyer pay for the previously-selected occurrence.
      leavePaymentOrder();
      // Drops what is no longer true of the event being opened.
      forgetSettledLeftOrders(eventId);
      commitConfirmationOrder(null);
      clientKeyRef.current = generateClientKey();
      goForward("eventDetail");
    },
    [
      goForward,
      commitConfirmationOrder,
      leavePaymentOrder,
      forgetSettledLeftOrders,
    ],
  );

  const handleSelectEvent = useCallback(
    (event: EventItem) => handleSelectEventById(event.id),
    [handleSelectEventById],
  );

  // Switch the active event to a sibling series date. Stays on the event-detail
  // screen (no navigation) and resets the cart, mirroring handleSelectEvent.
  const handleSelectSeriesDate = useCallback(
    (nextEventId: string) => {
      setSelectedEventId(nextEventId);
      setCart([]);
      setCheckoutError(null);
      setRedirectNotice(null);
      setOrderNotice(null);
      // Reset all payment-tied state so the new date starts a fresh purchase.
      // Without this, a stale clientSecret/confirmationOrder from the prior date
      // survives the switch and the buyer can pay for the WRONG occurrence.
      leavePaymentOrder();
      forgetSettledLeftOrders(nextEventId);
      commitConfirmationOrder(null);
      clientKeyRef.current = generateClientKey();
    },
    [commitConfirmationOrder, leavePaymentOrder, forgetSettledLeftOrders],
  );

  const handleBack = useCallback(() => {
    if (screen === "eventDetail") {
      // Single-event GRID embeds have no grid to go back to; every other
      // combination (incl. an event-subject calendar) returns to the browse
      // screen — grid or calendar, both live in the "grid" screen state.
      if (!isSingleEvent) goBack("grid");
    } else if (screen === "checkout") {
      // An order stays behind the buyer: Continue with the same cart returns
      // to paying it (a changed cart discards it, in handleCartChange). On
      // purpose: their tickets stay theirs while they look again, and the
      // notice there offers to let them go.
      goBack("eventDetail");
    }
  }, [screen, goBack, isSingleEvent]);

  const handleClose = useCallback(() => {
    setSlideDir("back");
    if (isSingleEvent && data?.event) {
      // Single-event: reset to event detail (no grid)
      setScreen("eventDetail");
      setSelectedEventId(data.event.id);
    } else {
      setScreen("grid");
      setSelectedEventId(null);
    }
    setCart([]);
    setGuestName("");
    setGuestEmail("");
    setPaymentOrder(null);
    setCheckoutError(null);
    setRedirectNotice(null);
    setRedirectPayment(null);
    setConfirmationEmail("");
    commitConfirmationOrder(null);
    setOrderNotice(null);
    // An order still reserved on the server (or still being released) is as
    // reserved after Done as before. Only "back on sale" has had its say.
    setLeftOrders((prev) => {
      const kept = Object.entries(prev).filter(
        ([, order]) => order.status !== "released",
      );
      return kept.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(kept);
    });
    setLettingGo(null);
    setLetGoFailed(null);
    setCompletion("confirmed");
    setUnconfirmed(null);
    // What is on record about earlier orders stays (`unknownOutcomes`): Done
    // closes the confirmation of ONE order, and a payment on another that
    // nobody could confirm is as unconfirmed after it as before.
    clientKeyRef.current = generateClientKey();
    // Full reset (mirrors clearing guestName/guestEmail) — drop the billing
    // draft so the next buyer starts clean.
    checkoutDraftRef.current = null;
  }, [isSingleEvent, data?.event, commitConfirmationOrder]);

  // Derive stepper state
  const stepperStepId = useMemo((): CheckoutStepId => {
    if (screen === "confirmation") return "confirmed";
    if (screen === "checkout")
      return checkoutStep === "payment" ? "payment" : "details";
    if (screen === "eventDetail") return "tickets";
    return "tickets";
  }, [screen, checkoutStep]);

  const completedStepIds = useMemo((): CheckoutStepId[] => {
    const ids: CheckoutStepId[] = [];
    if (screen === "checkout" || screen === "confirmation") ids.push("tickets");
    if (
      (screen === "checkout" && checkoutStep === "payment") ||
      screen === "confirmation"
    )
      ids.push("details");
    if (screen === "confirmation") ids.push("payment", "confirmed");
    return ids;
  }, [screen, checkoutStep]);

  // ── Viewer view toggle (FR-004) ───────────────────────────────────
  // Whichever payload landed first supplies the config. Event subjects never
  // get a switcher (a calendar of one event is noise) and neither does a
  // `place` subject, which cannot reach this widget at all. A named-calendar
  // subject DOES get one — it is the events widget filtered to one stream, and
  // the server accepts `defaultView`/`viewToggle` on it (FR-010).
  const embedSubjectType =
    data?.embed.subjectType ?? calendarQuery.data?.embed.subjectType ?? null;
  const viewToggleEnabled =
    (data?.embed.viewToggle ?? calendarQuery.data?.embed.viewToggle) === true;
  const isCalendarSubject = embedSubjectType === "calendar";
  const TOGGLE_ELIGIBLE_SUBJECTS = ["organization", "human", "calendar"];
  // BROWSE SCREEN ONLY — never over detail / checkout / confirmation.
  const showViewToggle =
    viewToggleEnabled &&
    screen === "grid" &&
    TOGGLE_ELIGIBLE_SUBJECTS.includes(embedSubjectType ?? "");

  // Kept mounted through the browse screen's loading and error states too, so
  // flipping to a view that is still fetching (or that the allowlist rejects)
  // never traps the viewer with no way back.
  //
  // The flip also snapshots the OUTGOING view's rendered height: the incoming
  // view unmounts the browse subtree while it fetches, and hf-resize.js would
  // faithfully report that collapse to the host page — a ~760px calendar
  // shrinking to a spinner yanks the host's scroll. Holding the old height as
  // a floor keeps the frame still across the swap.
  const browseToggle = showViewToggle ? (
    <EmbedViewToggle
      value={view}
      onChange={(next) => {
        setTransitionMinHeight(browseRootRef.current?.offsetHeight ?? null);
        setViewerView(next);
      }}
    />
  ) : null;

  // ── Loading state ─────────────────────────────────────────────────
  // Derived from "no data yet, no error yet" rather than `isLoading`: when the
  // toggle enables the second query, react-query reports the not-yet-mounted
  // observer as pending-but-idle for a render, which `isLoading` reads as
  // false — that one frame would flash the error screen.
  const browseError = isCalendarView ? calendarQuery.error : error;
  const hasBrowseData = isCalendarView ? !!calendarQuery.data : !!data;

  // Release the flip-time height floor once the incoming view has rendered —
  // otherwise a calendar→list flip would leave the list padded to the month
  // grid's height for the rest of the session.
  useEffect(() => {
    if (hasBrowseData) setTransitionMinHeight(null);
  }, [hasBrowseData]);

  // A redirect return still being checked, or one nobody could confirm:
  // nothing to browse or buy until it settles (a reload checks again).
  if (redirectReturn !== null) {
    return (
      <EmbedRedirectReturnScreen
        state={redirectReturn}
        supportEmail={supportEmail}
        paid={
          redirectStripeSaid
            ? {
                stripeSaid: redirectStripeSaid,
                onCheckAgain: checkRedirectAgain,
                checking: checkingRedirect,
                stillUnconfirmed: redirectStillUnconfirmed,
                final: redirectFinal,
              }
            : undefined
        }
      />
    );
  }

  // The page's order is paid as far as Stripe's browser side knows, and the
  // server has not confirmed it. Terminal, like an unverified redirect
  // return: no confirmation, and nothing to browse or buy (a second checkout
  // could be a second charge). "Check again" asks the server once more.
  if (
    livePaymentOrder &&
    liveStripeSaid !== null &&
    unconfirmed?.clientSecret === livePaymentOrder.clientSecret
  ) {
    const { clientSecret } = livePaymentOrder;
    return (
      <EmbedRedirectReturnScreen
        state="paid-unconfirmed"
        supportEmail={supportEmail}
        paid={{
          stripeSaid: liveStripeSaid,
          onCheckAgain: () =>
            latest.current.confirmPaidOrder(clientSecret, liveStripeSaid, false),
          checking: isConfirmingOrder,
          stillUnconfirmed: unconfirmed.stillUnconfirmed,
          final: unconfirmed.final,
        }}
      />
    );
  }

  // The server is being asked about the page's order while the buyer is not
  // on the checkout (Stripe said "paid" when the reservation ran out, with
  // the buyer back on the event). The checkout locks Back and says why;
  // these screens cannot, and a cart change here would leave an order the
  // buyer has paid for. So nothing else is shown until the answer is in.
  if (isConfirmingOrder && screen !== "checkout") {
    return (
      <EmbedRedirectReturnScreen state="verifying" supportEmail={supportEmail} />
    );
  }

  // A redirect payment the server answered for: its own confirmation,
  // whatever the browse payload is doing (it needs none of it).
  if (screen === "confirmation" && redirectPayment) {
    return (
      <EmbedRedirectConfirmation payment={redirectPayment} onDone={handleClose} />
    );
  }

  if (!hasBrowseData && !browseError) {
    return (
      <>
        {browseToggle}
        <EmbedWidgetFallback minHeight={transitionMinHeight ?? undefined} />
      </>
    );
  }

  // ── Error state ───────────────────────────────────────────────────
  if (browseError || !hasBrowseData) {
    return (
      <>
        {browseToggle}
        <EmbedErrorScreen
          error={browseError}
          onRetry={() => {
            void (isCalendarView ? calendarQuery.refetch() : refetch());
          }}
          supportEmail={supportEmail}
        />
      </>
    );
  }

  // Which embed config drives the detail screen's link-out affordance. In
  // calendar mode a linkOut embed never reaches the detail screen (clicks
  // open a new tab), but pass the real flag for consistency.
  const embedLinkOut = isCalendarView
    ? (calendarQuery.data?.embed.linkOut ?? false)
    : (data?.embed.linkOut ?? false);

  // The selected event's gate as the list card or the single-event payload
  // reported it, so the detail screen asks for an ungated event's fee rates
  // beside its detail read and never asks for a gated one's. The calendar
  // payload does not carry it; the detail screen then waits for its own read.
  const selectedGateTypeHint = !selectedEventId
    ? undefined
    : data?.event?.id === selectedEventId
      ? data.event.gateType
      : data?.events?.find((e) => e.id === selectedEventId)?.gateType;

  // ── Screen router ─────────────────────────────────────────────────
  const animClass =
    screen === "confirmation"
      ? "th-embed-fade-in"
      : slideDir === "forward"
        ? "th-embed-slide-forward"
        : "th-embed-slide-back";

  // What is said about the order the buyer had, on the screens that do not
  // show a payment form.
  const orderNoticeOnScreen =
    (screen === "eventDetail" || screen === "checkout") && !livePaymentOrder;
  // A reservation that ran out with its payment unsettled: the notice that
  // invites the buyer to reserve again carries the reminder itself, where it
  // cannot be dismissed, so the banner above it does not say it twice.
  //
  // The banner speaks of every order on record but one: the page's own
  // order while Stripe says it is paid, which the checkout (the server is
  // being asked) or its own screen is already saying.
  const recordsToSay = Object.entries(unknownOutcomes)
    .filter(
      ([clientSecret, record]) =>
        !(
          clientSecret === livePaymentOrder?.clientSecret &&
          record.stripeSaid !== null
        ),
    )
    .map(([, record]) => record);
  const someOutcomeUnknown = recordsToSay.some(
    (record) => record.serverSaid === null,
  );
  const noticeSaysCheckEmail =
    orderNoticeOnScreen && shownOrderNotice === "expired" && someOutcomeUnknown;
  // An earlier order the server says was paid for is said plainly, as that:
  // "that payment went through", never "that order is confirmed" (the
  // server's "confirmed" on a re-ask outlives a later refund).
  const reminderSentences = [
    recordsToSay.some((record) => record.serverSaid === "confirmed")
      ? String(t("checkout.embedEarlierOrderPaid"))
      : null,
    recordsToSay.some((record) => record.serverSaid === "processing")
      ? String(t("checkout.embedEarlierOrderClearing"))
      : null,
    someOutcomeUnknown && !noticeSaysCheckEmail
      ? String(
          t(
            // Over a confirmation the unknown payment is on another order
            // than the one just confirmed, and the sentence says so.
            screen === "confirmation"
              ? "checkout.embedEarlierOrderUnknown"
              : "checkout.embedPaymentOutcomeUnknown",
          ),
        )
      : null,
  ].filter((sentence): sentence is string => sentence !== null);
  const outcomeReminderOnScreen =
    reminderSentences.length > 0 && !outcomeReminderDismissed;
  // The in-page confirmation of a payment still with the bank shows the
  // charge: subtotal, the buyer's fees and tax, as EmbedConfirmation totals.
  const clearingAmountCents = confirmationOrder
    ? confirmationOrder.orderFees.amountGrossCents +
      confirmationOrder.orderFees.buyerFeesCents +
      (confirmationOrder.orderFees.feeMode === "PASS_THROUGH"
        ? (confirmationOrder.orderFees.processorFeeCents ?? 0)
        : 0) +
      confirmationOrder.orderFees.taxAmountCents
    : null;

  return (
    <LayoutGroup id="embed-widget">
      {(pendingNotice || outcomeReminderOnScreen) && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            background: WARNING_BG,
            padding: "10px 14px",
          }}
        >
          <p style={{ margin: 0, fontSize: 12, fontWeight: 500, color: TEXT }}>
            {outcomeReminderOnScreen
              ? reminderSentences.join(" ")
              : "You may have a payment still being confirmed. Check your email before buying again."}
          </p>
          <button
            type="button"
            onClick={() => {
              dismissPendingNotice();
              setOutcomeReminderDismissed(true);
            }}
            aria-label="Dismiss payment notice"
            style={{
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: TEXT,
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              // Comfortably past the 24px minimum tap target (WCAG 2.5.8).
              minWidth: 32,
              minHeight: 32,
              padding: 0,
            }}
          >
            {"\u2715"}
          </button>
        </div>
      )}
      {redirectNotice && (
        <div
          role="alert"
          style={{ background: DANGER_BG, padding: "10px 14px" }}
        >
          <p
            style={{ margin: 0, fontSize: 12, fontWeight: 500, color: DANGER }}
          >
            {redirectNotice}
          </p>
        </div>
      )}
      {/* The order behind the payment step, said out loud on the screens
          that do not show the payment form. */}
      {screen === "eventDetail" && livePaymentOrder && (
        <EmbedReservedNotice
          reservedUntil={reservedUntil}
          // Not offered for an order a payment may have gone through on (the
          // gate in `startRelease`, which the press goes through again).
          onLetGo={
            lettingGo === livePaymentOrder.clientSecret ||
            (!liveOutcomeUnknown && !isPaying && !isConfirmingOrder)
              ? handleLetGo
              : undefined
          }
          lettingGo={lettingGo === livePaymentOrder.clientSecret}
          letGoFailed={letGoFailed === livePaymentOrder.clientSecret}
          letGoRef={letGoButtonRef}
        />
      )}
      {orderNoticeOnScreen && (
        <EmbedOrderNotice
          kind={shownOrderNotice}
          mayHaveBeenCharged={paymentOutcomeUnknown}
          outcomeUnknown={someOutcomeUnknown}
          earlierReservedUntil={
            earlierOrderReserved && !checkoutRefused
              ? earlierReservedUntil
              : null
          }
          earlierReleased={
            earlierOrderReleased && shownOrderNotice !== "released"
          }
          noticeRef={orderNoticeRef}
        />
      )}
      {browseToggle}
      <div
        ref={browseRootRef}
        style={{
          position: "relative",
          overflow: "hidden",
          ...embedThemeBridgeStyle(themeOverrides),
        }}
      >
        <AnimatePresence>
          {/* Browse grid — organization, human OR named-calendar subjects.
              Gated on the EVENTS PAYLOAD, not on `owner`: a calendar-subject
              embed returns `{ calendar, events }` with no `owner` at all, so
              the old `data?.owner &&` gate rendered an EMPTY widget in the
              default list view (venue-hierarchy FR-010). `data.organization`
              is still populated for org subjects, so org behavior is
              unchanged. The header name falls back through owner → calendar. */}
          {screen === "grid" &&
            !isCalendarView &&
            !isSingleEvent &&
            data?.events && (
              <EmbedEventGrid
                key="grid"
                orgName={data.owner?.name ?? data.calendar?.name ?? ""}
                events={data.events as EventItem[]}
                onSelectEvent={handleSelectEvent}
                /**
                 * Calendar subjects ALWAYS link out, whatever the embed's own
                 * `linkOut` flag says. The events on a venue's calendar can
                 * belong to any creator, and `assertEventAllowedForEmbed` —
                 * the gate the in-iframe detail and checkout procedures run —
                 * fails closed for a "calendar" subject. Honouring `linkOut:
                 * false` here would open an in-iframe detail panel that then
                 * errors on every single card. This is the same posture the
                 * calendar browse view takes via `checkoutEligible: false`.
                 */
                linkOut={data.embed.linkOut || isCalendarSubject}
                buildEventUrl={buildEventUrl}
              />
            )}

          {/* Calendar browse — the same "grid" screen slot, rendered as a
              month calendar. Clicks route in-iframe only for checkout-eligible
              events; everything else opens the canonical event page. */}
          {screen === "grid" && isCalendarView && calendarQuery.data && (
            <EmbedCalendarBrowse
              key="calendar"
              ownerName={calendarQuery.data.ownerName}
              events={calendarQuery.data.events}
              linkOut={calendarQuery.data.embed.linkOut}
              buildEventUrl={buildEventUrl}
              onSelectEvent={handleSelectEventById}
              themeOverrides={themeOverrides}
            />
          )}

          {/* Event detail — expands from clicked card via layoutId (grid mode;
              calendar mode has no source card, so it mounts without a morph) */}
          {screen === "eventDetail" && selectedEventId && (
            <motion.div
              key="detail"
              layoutId={`embed-card-${selectedEventId}`}
              exit={{ opacity: 0 }}
              style={{ background: SURFACE, overflow: "hidden" }}
              transition={{
                layout: { type: "spring", bounce: 0.2, duration: 0.5 },
              }}
            >
              <EmbedEventDetail
                embedId={embedId}
                eventId={selectedEventId}
                cart={cart}
                onCartChange={handleCartChange}
                onBack={handleBack}
                onContinueToCheckout={handleContinueToCheckout}
                onSelectDate={handleSelectSeriesDate}
                stepperStepId={stepperStepId}
                completedStepIds={completedStepIds}
                showBackButton={!isSingleEvent}
                linkOut={embedLinkOut}
                buildEventUrl={buildEventUrl}
                gateTypeHint={selectedGateTypeHint}
              />
            </motion.div>
          )}

          {/* Checkout */}
          {screen === "checkout" && selectedEventId && (
            <div key="checkout" className={animClass}>
              <EmbedCheckout
                embedId={embedId}
                eventId={selectedEventId}
                cart={cart}
                guestName={guestName}
                guestEmail={guestEmail}
                onGuestNameChange={setGuestName}
                onGuestEmailChange={handleGuestEmailChange}
                initialDraft={checkoutDraftRef.current ?? undefined}
                onDraftChange={handleCheckoutDraftChange}
                clientKey={clientKeyRef.current}
                paymentOrder={livePaymentOrder}
                checkoutError={checkoutError}
                checkoutStep={checkoutStep}
                onCheckoutCreated={handleCheckoutCreated}
                onCheckoutError={setCheckoutError}
                onCheckoutFailed={handleCheckoutFailed}
                onCartUpdate={handleCartUpdate}
                isPaying={isPaying}
                onPayingChange={handlePayingChange}
                isConfirming={isConfirmingOrder}
                loadedAsRedirectReturn={loadedAsRedirectReturn}
                onPaymentOutcomeUnknown={handlePaymentOutcomeUnknown}
                earlierReservedUntil={
                  earlierOrderReserved ? earlierReservedUntil : null
                }
                onPaymentOrderExpired={handlePaymentOrderExpired}
                waitForReleases={waitForReleases}
                onPaymentSuccess={handlePaymentSuccess}
                onBack={handleBack}
                stepperStepId={stepperStepId}
                completedStepIds={completedStepIds}
                initialPromoCodes={initialPromoCodes}
              />
            </div>
          )}

          {/* Confirmation */}
          {screen === "confirmation" && (
            <div key="confirmation" className="th-embed-fade-in">
              {completion === "processing" ? (
                // The payment is still with the buyer's bank: the order is
                // not confirmed and no ticket has been sent, so the screen
                // that says both is not the one shown.
                <EmbedRedirectConfirmation
                  payment={{
                    status: "processing",
                    amountCents: clearingAmountCents,
                    currency: confirmationOrder?.currency ?? null,
                  }}
                  onDone={handleClose}
                />
              ) : (
                <EmbedConfirmation
                  embedId={embedId}
                  eventId={selectedEventId}
                  email={confirmationEmail}
                  checkout={confirmationOrder}
                  onDone={handleClose}
                  completedStepIds={completedStepIds}
                />
              )}
            </div>
          )}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}
