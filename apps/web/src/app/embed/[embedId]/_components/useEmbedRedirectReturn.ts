import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearStripeRedirectParams,
  readStripeRedirectParams,
  redirectFailureReason,
  redirectPaymentIntentId,
  type RedirectFailureReason,
  type StripeRedirectReturnParams,
} from "@/lib/stripe-redirect-return";
import { traceIgnoredError } from "@/lib/trace-ignored-error";
import { verifyRedirectPaymentIntent } from "@/lib/verify-redirect-payment-intent";

import type { EmbedServerOutcome } from "./ask-embed-server";
import type { EmbedServerAnswer, PaidStatus } from "./embed-payment-status";
import { readEmbedTickets, type EmbedTicketCode } from "./embed-tickets";

/**
 * Where an embed redirect return stands:
 *  - `verifying`: Stripe.js is retrieving the PaymentIntent, or the server
 *    is being asked about the order of one Stripe.js says is paid;
 *  - `unverified`: terminal, buying closed. Nobody could confirm the payment
 *    either way, or the PaymentIntent is still live and can yet be charged;
 *  - `paid-unconfirmed`: terminal, buying closed. Stripe.js says the payment
 *    went through (or is clearing) and the server has not confirmed the
 *    order: it could not be asked, did not answer, or disagreed. The buyer
 *    can ask again (`checkAgain`);
 *  - `null`: not a redirect return, or settled (the server confirmed the
 *    order, or a verified failure reopened buying).
 */
export type EmbedRedirectReturnState =
  | "verifying"
  | "unverified"
  | "paid-unconfirmed"
  | null;

/** A redirect payment whose order the server answered for. */
export type EmbedRedirectPayment = {
  /**
   * The SERVER's answer, in Stripe's words: "succeeded" for an order the
   * payment finalized, "processing" for one still clearing with the bank.
   */
  status: PaidStatus;
  /** The PaymentIntent's amount in the currency's minor unit, if Stripe said. */
  amountCents: number | null;
  currency: string | null;
  /** The order the server confirmed (the return URL itself names none). */
  orderId: string;
  /**
   * That order's tickets, from the server's "confirmed" answer. Empty for
   * "processing", for an older API and when the server withholds the codes.
   * Component state only (see embed-tickets.ts).
   */
  tickets: EmbedTicketCode[];
};

/** Asks the server about one order (see `askEmbedServer`). Never rejects. */
export type AskEmbedServer = (
  clientSecret: string,
  options: {
    askTwice: boolean;
    /** An answer that lands after the ask was given up on (`askEmbedServer`). */
    onLateAnswer?: (answer: EmbedServerOutcome) => void;
  },
) => Promise<EmbedServerAnswer>;

/**
 * The embed's copy for a VERIFIED-dead redirect payment. The embed widget's
 * own strings are English literals (it has no `t()` on this path), so these
 * follow that convention; the checkout maps the same reasons through t().
 */
const EMBED_REDIRECT_FAILURE_COPY: Record<RedirectFailureReason, string> = {
  declined: "Payment was declined. Please try a different payment method.",
  not_completed: "Payment was not completed. Please try again.",
  canceled: "Payment was canceled. Please try again.",
};

/** How long a pending marker still warrants the "check your email" notice. */
export const PENDING_REDIRECT_NOTICE_MS = 30 * 60 * 1000;

/**
 * The per-embed sessionStorage key for a redirect payment that ended on the
 * terminal screen. A host-page reload loads the iframe from its `src`,
 * WITHOUT Stripe's params, so the terminal screen cannot come back; this
 * marker is what remembers it. It holds the PaymentIntent id and a
 * timestamp, NEVER the client secret.
 */
export const pendingRedirectKey = (embedId: string) =>
  `hf:embed:pending-redirect:${embedId}`;

type PendingMarker = { paymentIntentId: string | null; at: number };

/**
 * Remembers a payment that ended on a terminal screen, for a host-page
 * reload. `paymentIntentId` is the PaymentIntent's ID, NEVER its client
 * secret: this is written to storage.
 */
export function writePendingMarker(
  embedId: string,
  paymentIntentId: string | null,
) {
  try {
    const marker: PendingMarker = { paymentIntentId, at: Date.now() };
    window.sessionStorage.setItem(
      pendingRedirectKey(embedId),
      JSON.stringify(marker),
    );
  } catch {
    // Storage blocked (a third-party iframe in a strict browser): the
    // terminal screen still shows; only a host reload loses the reminder.
  }
}

/** An in-page purchase succeeded: the earlier unconfirmed-redirect reminder is moot. */
export function clearPendingMarker(embedId: string) {
  try {
    window.sessionStorage.removeItem(pendingRedirectKey(embedId));
  } catch {
    // Storage blocked: nothing was written either.
  }
}

/** A marker younger than {@link PENDING_REDIRECT_NOTICE_MS}, else `null`. */
function recentPendingMarker(embedId: string): PendingMarker | null {
  try {
    const raw = window.sessionStorage.getItem(pendingRedirectKey(embedId));
    if (!raw) return null;
    const marker = JSON.parse(raw) as Partial<PendingMarker> | null;
    const at = typeof marker?.at === "number" ? marker.at : NaN;
    const age = Date.now() - at;
    if (!(age >= 0 && age < PENDING_REDIRECT_NOTICE_MS)) {
      clearPendingMarker(embedId);
      return null;
    }
    return {
      paymentIntentId:
        typeof marker?.paymentIntentId === "string"
          ? marker.paymentIntentId
          : null,
      at,
    };
  } catch {
    return null;
  }
}

/** The prefix of every embed's held-return key ({@link heldRedirectReturnKey}). */
const HELD_REDIRECT_RETURN_PREFIX = "hf:embed:redirect-return:";

/**
 * The per-embed sessionStorage key for a redirect return still being worked
 * out. Stripe's params leave the URL the moment they are read (the client
 * secret is the guest's proof of payment, and a URL is copied, logged and
 * sent as a Referer), so this is what a reload, or a remount, of an
 * unsettled return reads them back from. It DOES hold the client secret:
 * sessionStorage only (never localStorage, never a log line or a message).
 *
 * Its lifetime: written when the return is read off the URL, and deleted
 * when the return settles or ends on a terminal screen, except on
 * `paid-unconfirmed` (Stripe says paid, the server has not confirmed),
 * where it stays so a reload asks the server again. An IN-FRAME payment
 * that lands on that screen is held here too, so a remount resumes it as a
 * return ({@link holdUnconfirmedOrder}). It is never kept past
 * {@link HELD_REDIRECT_RETURN_MS} from that first read: a read finds an
 * older one dead and deletes it, and every widget mount deletes every
 * embed's dead ones ({@link sweepExpiredHeldRedirectReturns}). What can
 * outlive the window is an entry no embed widget is ever mounted again to
 * sweep, or one whose widget stays mounted on `paid-unconfirmed` past the
 * window (the same secret is in memory there anyway); the next mount
 * sweeps it, and sessionStorage drops it when the tab closes.
 */
export const heldRedirectReturnKey = (embedId: string) =>
  `${HELD_REDIRECT_RETURN_PREFIX}${embedId}`;

/** How long a held return is still resumed (the pending notice's window). */
const HELD_REDIRECT_RETURN_MS = PENDING_REDIRECT_NOTICE_MS;

/**
 * `inFrame`: an in-frame payment held for a remount
 * ({@link holdUnconfirmedOrder}), not a return from a payment page. Resumed
 * the same way; it only differs in what the load's referrer names (see
 * {@link hasHeldRedirectReturn}).
 */
type HeldRedirectReturn = StripeRedirectReturnParams & {
  at: number;
  inFrame?: true;
};

function holdRedirectReturn(
  embedId: string,
  redirect: StripeRedirectReturnParams,
  inFrame = false,
) {
  const held: HeldRedirectReturn = {
    ...redirect,
    at: Date.now(),
    ...(inFrame ? { inFrame: true as const } : {}),
  };
  try {
    window.sessionStorage.setItem(
      heldRedirectReturnKey(embedId),
      JSON.stringify(held),
    );
  } catch {
    // Storage blocked: the effect's re-run still finds it in memory
    // (`readRef`); a reload or a remount loses it.
  }
}

/** The return is settled, or on its terminal screen: let it go. */
function releaseRedirectReturn(embedId: string) {
  try {
    window.sessionStorage.removeItem(heldRedirectReturnKey(embedId));
  } catch {
    // Storage blocked: nothing was written either.
  }
}

/**
 * A stored held return, if it is still usable: younger than
 * {@link HELD_REDIRECT_RETURN_MS}, with a secret or an id to verify.
 * Throws on unparseable JSON; writes nothing.
 */
function usableHeldReturn(raw: string): StripeRedirectReturnParams | null {
  const held = JSON.parse(raw) as Partial<HeldRedirectReturn> | null;
  if (!held || typeof held !== "object") return null;
  const age = Date.now() - (typeof held.at === "number" ? held.at : NaN);
  const clientSecret =
    typeof held.clientSecret === "string" && held.clientSecret !== ""
      ? held.clientSecret
      : null;
  const paymentIntentId = redirectPaymentIntentId(
    typeof held.paymentIntentId === "string" ? held.paymentIntentId : null,
    clientSecret,
  );
  if (
    !(age >= 0 && age < HELD_REDIRECT_RETURN_MS) ||
    (!clientSecret && !paymentIntentId)
  ) {
    return null;
  }
  return { clientSecret, paymentIntentId, failedHint: held.failedHint === true };
}

/** A usable held return for this embed; a dead one is deleted. */
function heldRedirectReturn(
  embedId: string,
): StripeRedirectReturnParams | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(heldRedirectReturnKey(embedId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let usable: StripeRedirectReturnParams | null;
  try {
    usable = usableHeldReturn(raw);
  } catch {
    usable = null;
  }
  if (!usable) releaseRedirectReturn(embedId);
  return usable;
}

/**
 * Whether this embed has a held return in storage, usable or not: a load
 * that resumes one (an iframe-only reload mid-verify, whose URL is already
 * clean) counts as a redirect return. A pure read, safe in a render: `false`
 * on the server and when storage is blocked.
 *
 * Not an in-frame payment held for a remount (`inFrame`): what this answers
 * is whether the load's referrer may name a payment page, so the host origin
 * read from it is not saved (embed-saved-host-origin.ts). That load came
 * from the host page (a host reload, or an iframe reload whose referrer is
 * still the host), and a payment made on it must save that origin: on
 * Firefox it is the only one a redirect return would have.
 */
export function hasHeldRedirectReturn(embedId: string): boolean {
  if (typeof window === "undefined") return false;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(heldRedirectReturnKey(embedId));
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const held = JSON.parse(raw) as Partial<HeldRedirectReturn> | null;
    return held?.inFrame !== true;
  } catch {
    // Unparseable: whatever wrote it, it counts as before.
    return true;
  }
}

/**
 * Deletes every embed's held return that is past its window or unusable.
 * A read only checks the embed it is for, so without this a secret held by
 * an embed that never loads again (an unmount mid-verify, a return that
 * threw) would sit in storage past its window.
 */
export function sweepExpiredHeldRedirectReturns(): void {
  try {
    const store = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(HELD_REDIRECT_RETURN_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      let usable: StripeRedirectReturnParams | null;
      try {
        const raw = store.getItem(key);
        usable = raw ? usableHeldReturn(raw) : null;
      } catch {
        usable = null;
      }
      if (!usable) store.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing was written either.
  }
}

/**
 * An in-frame payment Stripe's browser side said went through, whose order
 * the server has not confirmed: the widget is on the "payment went through,
 * order not confirmed yet" screen, and holds the order's client secret in
 * React memory only. A remount (the host page reloads, or the iframe does)
 * would lose it, leaving the buyer a "check your email" notice beside an
 * open widget and no way to ask again.
 *
 * So it is held as a redirect return, under the same key and the same rules
 * ({@link heldRedirectReturnKey}): sessionStorage only, the 30-minute
 * window, swept by {@link sweepExpiredHeldRedirectReturns}. The next mount
 * resumes it the way it resumes a return: Stripe.js reads the PaymentIntent
 * afresh (no status is stored, so nothing stale decides) and the server is
 * asked, with the receipt secret the tab holds for it (embed-receipt-secret.ts),
 * before any confirmation. `failedHint` is false: no redirect said "failed".
 *
 * The window counts from the FIRST hold of an order: the caller holds an
 * order once (EmbedWidget's `heldOrdersRef`), so asking again and being
 * left unconfirmed does not restart it, and once it has run out the secret
 * is not stored again (the screen on view keeps it in memory, as before).
 * This check is the same rule for a hold still in storage. A different
 * order's hold is replaced: the screen this is written from closes buying,
 * so the order on it is the buyer's latest.
 */
export function holdUnconfirmedOrder(embedId: string, clientSecret: string) {
  if (heldRedirectReturn(embedId)?.clientSecret === clientSecret) return;
  holdRedirectReturn(
    embedId,
    {
      clientSecret,
      paymentIntentId: redirectPaymentIntentId(null, clientSecret),
      failedHint: false,
    },
    true,
  );
}

/**
 * The order behind `clientSecret` is settled (the server confirmed it, a
 * release cancelled it, Stripe settled it as not charged, or the server's
 * refusal is final): its hold goes. Only ITS hold: one for another payment
 * stays, since nothing was learned about that one.
 */
export function releaseHeldOrder(embedId: string, clientSecret: string) {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(heldRedirectReturnKey(embedId));
  } catch {
    // Storage blocked: nothing was written either.
    return;
  }
  if (!raw) return;
  let heldSecret: unknown;
  try {
    heldSecret = (JSON.parse(raw) as Partial<HeldRedirectReturn> | null)
      ?.clientSecret;
  } catch {
    // Unparseable: no order's, and the next mount's sweep deletes it.
    return;
  }
  if (heldSecret === clientSecret) releaseRedirectReturn(embedId);
}

/**
 * Handle the return from a redirect payment method inside the embed.
 *
 * Stripe.js reads the PaymentIntent first, and the confirmation waits for
 * the server (`embeds.confirmGuestPayment`, which takes the client secret on
 * the return URL as the guest's proof of ownership):
 *  - `succeeded` / `processing` → the server is asked, still on
 *    "Confirming your payment…". On its "confirmed" or "processing":
 *    `onConfirmed(payment)`. On anything else (it said "not paid", the call
 *    failed, or nobody answered) → `paid-unconfirmed`: a pending marker
 *    saved, and `checkAgain` re-asks with the secret held in memory. Never
 *    "confirmed" on Stripe.js's word alone, and never "not paid" against it;
 *  - `requires_payment_method` / `canceled` → `onFailed(copy)`, buying
 *    reopens. `redirect_status=failed` is a hint and only picks the
 *    "declined" copy here, never decides;
 *  - a still-live status (`requires_action`, …), no Stripe.js, a retrieve
 *    error or a timeout → `unverified`, and a pending marker saved.
 *
 * Stripe's params leave the URL synchronously, as soon as they are read and
 * before anything is awaited: the client secret on them is the guest's proof
 * of payment, which the server answers with door-admission ticket codes.
 * The return is held in per-embed sessionStorage
 * ({@link heldRedirectReturnKey}) until an outcome, so a reload or a remount
 * mid-verify picks it up again; on `paid-unconfirmed` it stays (a reload
 * asks the server again), for 30 minutes from when it was read. A terminal
 * screen leaves the pending marker (PaymentIntent id, never the secret): a
 * later load with no held return, iframe or host-page reload alike, gets
 * the reminder.
 *
 * A load that is NOT a redirect return, within 30 minutes of a pending
 * marker, gets `pendingNotice` (a dismissible "check your email" notice
 * that does not block buying).
 *
 * `seeded` is the render-time answer to "is this a redirect return"
 * (`hasStripeRedirectParams` over `useSearchParams`, which the server render
 * sees too), so the first render already shows "Confirming your payment…".
 */
export function useEmbedRedirectReturn({
  embedId,
  seeded,
  onConfirmed,
  onFailed,
  askServer,
}: {
  embedId: string;
  seeded: boolean;
  onConfirmed: (payment: EmbedRedirectPayment) => void;
  onFailed: (message: string) => void;
  askServer: AskEmbedServer;
}): {
  state: EmbedRedirectReturnState;
  pendingNotice: boolean;
  dismissPendingNotice: () => void;
  /**
   * The server confirmed this payment: its marker and its reminder on
   * screen go. Another payment's stay, since nothing was learned about it.
   */
  settlePendingPayment: (paymentIntentId: string | null) => void;
  /** What Stripe.js said of the payment, while `paid-unconfirmed`. */
  stripeSaid: PaidStatus | null;
  /** Asks the server again about a `paid-unconfirmed` payment. */
  checkAgain: () => void;
  /** That ask is in flight. */
  checking: boolean;
  /** The last `checkAgain` came back without a confirmation. */
  stillUnconfirmed: boolean;
  /** The server's refusal is one asking again cannot change: no `checkAgain`. */
  final: boolean;
} {
  const [state, setState] = useState<EmbedRedirectReturnState>(
    seeded ? "verifying" : null,
  );
  const [pendingNotice, setPendingNotice] = useState(false);
  // The payment the reminder on screen is about (null: one whose ID was
  // never learned, which no confirmation can be matched to).
  const pendingNoticeForRef = useRef<string | null>(null);
  const settlePendingPayment = useCallback(
    (paymentIntentId: string | null) => {
      if (!paymentIntentId) return;
      if (recentPendingMarker(embedId)?.paymentIntentId === paymentIntentId) {
        clearPendingMarker(embedId);
      }
      if (pendingNoticeForRef.current === paymentIntentId) {
        pendingNoticeForRef.current = null;
        setPendingNotice(false);
      }
    },
    [embedId],
  );
  const callbacksRef = useRef({ onConfirmed, onFailed, askServer });
  useEffect(() => {
    callbacksRef.current = { onConfirmed, onFailed, askServer };
  }, [onConfirmed, onFailed, askServer]);

  // The payment Stripe.js said went through, kept for `checkAgain`. The
  // client secret stays in memory here; the held return in sessionStorage
  // stays too while the server has not confirmed (a reload asks again), and
  // is let go on a confirmation or a final refusal.
  const paidRef = useRef<{
    clientSecret: string;
    paymentIntentId: string;
    stripeSaid: PaidStatus;
    amountCents: number | null;
    currency: string | null;
  } | null>(null);
  const [stripeSaid, setStripeSaid] = useState<PaidStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [stillUnconfirmed, setStillUnconfirmed] = useState(false);
  const [final, setFinal] = useState(false);
  const checkingRef = useRef(false);
  // The server confirmed the order: said once, however many answers say so
  // (an ask that was given up on can answer beside the one that replaced it).
  const confirmedRef = useRef(false);
  const mountedRef = useRef(true);
  // The return this widget read off its URL. A ref survives StrictMode's dev
  // re-run of the effect below, whose first run already cleaned the URL, in
  // a frame whose storage is blocked too.
  const readRef = useRef<StripeRedirectReturnParams | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Acts on the server's answer for the payment in `paidRef`. */
  const takeServerAnswer = useCallback(
    (answer: EmbedServerAnswer, afterCheckAgain: boolean) => {
      const paid = paidRef.current;
      if (!paid || confirmedRef.current || !mountedRef.current) return;
      if (answer.outcome === "confirmed" || answer.outcome === "processing") {
        confirmedRef.current = true;
        releaseRedirectReturn(embedId);
        clearPendingMarker(embedId);
        settlePendingPayment(paid.paymentIntentId);
        setState(null);
        callbacksRef.current.onConfirmed({
          status: answer.outcome === "confirmed" ? "succeeded" : "processing",
          amountCents: paid.amountCents,
          currency: paid.currency,
          orderId: answer.orderId,
          // No order-id check to make here: the only client secret this
          // load asks about is the one on its return URL (or held for an
          // in-frame payment, `holdUnconfirmedOrder`), and the server names
          // the order from that PaymentIntent. "processing" carries no
          // tickets.
          tickets:
            answer.outcome === "confirmed"
              ? readEmbedTickets(answer.tickets)
              : [],
        });
        return;
      }
      // "not_paid" against Stripe.js's "paid" is a disagreement, and an
      // unanswered ask is no answer: neither says the buyer was not charged.
      // The held return stays (within its window, from when it was first
      // read): a reload asks the server again, as "Check again" does,
      // instead of the "check your email" notice beside an open widget that
      // invites a second purchase. A final refusal is the same answer every
      // time, so its secret goes.
      const refusedForGood =
        answer.outcome === "unanswered" && answer.final;
      if (refusedForGood) releaseRedirectReturn(embedId);
      writePendingMarker(embedId, paid.paymentIntentId);
      setStripeSaid(paid.stripeSaid);
      setStillUnconfirmed(afterCheckAgain);
      setFinal(refusedForGood);
      setState("paid-unconfirmed");
    },
    [embedId, settlePendingPayment],
  );
  /**
   * An answer to an ask that was given up on. Only a "paid" one is news:
   * the order is confirmed after all, and the buyer moves on without
   * pressing anything.
   */
  const takeLateAnswer = useCallback(
    (answer: EmbedServerOutcome) => {
      if (answer.outcome === "not_paid") return;
      checkingRef.current = false;
      if (mountedRef.current) setChecking(false);
      takeServerAnswer(answer, false);
    },
    [takeServerAnswer],
  );

  const checkAgain = useCallback(() => {
    const paid = paidRef.current;
    if (!paid || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setStillUnconfirmed(false);
    // One call per press (two when a finalize was running for the order):
    // the endpoint allows 20 a minute per IP.
    void callbacksRef.current
      .askServer(paid.clientSecret, {
        askTwice: false,
        onLateAnswer: takeLateAnswer,
      })
      .then((answer) => {
        checkingRef.current = false;
        if (!mountedRef.current) return;
        setChecking(false);
        takeServerAnswer(answer, true);
      });
  }, [takeServerAnswer, takeLateAnswer]);

  useEffect(() => {
    // Every embed's dead held returns go, this one's included.
    sweepExpiredHeldRedirectReturns();
    const fromUrl = readStripeRedirectParams(
      new URLSearchParams(window.location.search),
    );
    if (fromUrl) {
      // Off the URL before anything is awaited (see above): held first, so
      // nothing is lost between the two.
      readRef.current = fromUrl;
      holdRedirectReturn(embedId, fromUrl);
      clearStripeRedirectParams();
    }
    const redirect =
      fromUrl ?? readRef.current ?? heldRedirectReturn(embedId);
    if (!redirect) {
      // Seeded as a return the URL no longer shows: never leave the buyer on
      // "Confirming…", and never reopen buying on no evidence.
      setState((current) => (current === "verifying" ? "unverified" : current));
      // A fresh load (a host-page reload drops Stripe's params) soon after
      // an unconfirmed redirect payment: remind, don't block.
      const marker = recentPendingMarker(embedId);
      if (marker) {
        pendingNoticeForRef.current = marker.paymentIntentId;
        setPendingNotice(true);
      }
      return;
    }
    setState("verifying");

    // One gate for every outcome; the `await` below always yields first, so
    // an unmount (or StrictMode's synchronous dev unmount) wins.
    let cancelled = false;
    let settled = false;
    const settle = (fire: () => void) => {
      if (cancelled || settled) return;
      settled = true;
      readRef.current = null;
      fire();
    };

    void (async () => {
      const verdict = await verifyRedirectPaymentIntent(redirect.clientSecret, {
        surface: "embed",
        isCancelled: () => cancelled,
      });
      switch (verdict.kind) {
        case "succeeded":
        case "processing": {
          // Stripe.js says paid. Not a confirmation yet: the server is
          // asked, with the buyer still on "Confirming your payment…".
          if (cancelled || !redirect.clientSecret) return;
          paidRef.current = {
            clientSecret: redirect.clientSecret,
            paymentIntentId: verdict.paymentIntentId,
            stripeSaid: verdict.kind,
            amountCents: verdict.amountCents,
            currency: verdict.currency,
          };
          const answer = await callbacksRef.current.askServer(
            redirect.clientSecret,
            { askTwice: true, onLateAnswer: takeLateAnswer },
          );
          settle(() => takeServerAnswer(answer, false));
          return;
        }
        case "dead":
          settle(() => {
            releaseRedirectReturn(embedId);
            clearPendingMarker(embedId);
            setState(null);
            callbacksRef.current.onFailed(
              EMBED_REDIRECT_FAILURE_COPY[
                redirectFailureReason(verdict.status, redirect.failedHint)
              ],
            );
          });
          return;
        case "live":
        case "unknown":
          settle(() => {
            if (!redirect.clientSecret) {
              // Nothing Stripe.js could retrieve (the URL carries no client
              // secret): as visible as the checkout's equivalent.
              traceIgnoredError("embed.redirectUnverifiable")(
                new Error("embed redirect return without a client secret"),
              );
            }
            releaseRedirectReturn(embedId);
            writePendingMarker(
              embedId,
              verdict.kind === "live"
                ? verdict.paymentIntentId
                : redirect.paymentIntentId,
            );
            setState("unverified");
          });
      }
    })().catch(traceIgnoredError("embed.redirectReturn"));

    return () => {
      cancelled = true;
    };
    // `embedId` is fixed for the life of the widget (the route param).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissPendingNotice = useCallback(() => {
    pendingNoticeForRef.current = null;
    setPendingNotice(false);
    clearPendingMarker(embedId);
  }, [embedId]);

  return {
    state,
    pendingNotice,
    dismissPendingNotice,
    settlePendingPayment,
    stripeSaid,
    checkAgain,
    checking,
    stillUnconfirmed,
    final,
  };
}
