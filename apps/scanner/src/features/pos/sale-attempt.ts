/**
 * One door sale's idempotency key, and what the till may do while an attempt
 * under it is unresolved.
 *
 * Ported from the web box office (`apps/web/.../sell/_components/sell-stage.ts`
 * and the `settleFailedAttempt` / `closeOpenOrder` logic in `SellView.tsx`), so
 * both tills hold a key the same way. Pure: the screen keeps a `SaleAttempt`
 * in state and runs these transitions on it.
 *
 * Why the key handling is not "fresh key every press": both sell procedures
 * key on `pos:{actorHumanId}:{clientKey}` with a payload-hash check. A press
 * whose response was LOST may have recorded a sale; replaying it under the
 * same key returns that sale instead of selling the tickets twice. A press the
 * server REFUSED wrote `failed:` under its key for fifteen minutes, so reusing
 * that key could only ever answer IDEMPOTENCY_LOCK_IN_PROGRESS; it rotates.
 */
import type { RouterOutputs } from "../../trpc";
import { getAppErrorCode } from "./sell-quote";

export type Tender = "card" | "cash" | "comp";

export type AttemptLock = {
  tender: Tender;
  /**
   * `no-answer`: no response came back; `processing`: the server says an
   * attempt under this key is still running (LOCK_IN_PROGRESS).
   */
  reason: "no-answer" | "processing";
};

export type SaleAttempt = {
  /** The key the next press sends; null until the first press of a sale. */
  key: string | null;
  /**
   * The tender whose last attempt is unresolved. While set, the cart, the
   * codes, the email and the OTHER tenders lock: only a replay of this exact
   * attempt is safe.
   */
  lock: AttemptLock | null;
  /** LOCK_IN_PROGRESS answers in a row; see PROCESSING_PRESSES_BEFORE_CHECK. */
  processingPresses: number;
  /**
   * The server said this key may already hold a sale (KEY_CONFLICT, or a
   * LOCK_IN_PROGRESS that didn't clear). No tender may be pressed; the
   * operator checks what was recorded and clears the sale to start over.
   */
  mayAlreadyBeRecorded: boolean;
};

/**
 * React Query options for every mutation sent under a sale's key
 * (`pos.startSale`, `pos.recordCashSale`, `pos.cancelSale`).
 *
 * No automatic retry. The app's default is `mutations.retry: 1`
 * (`src/query-client.ts`), and both sale use cases mark the key `failed:`
 * for fifteen minutes on ANY refusal. A retry a second later on the same key
 * can only answer IDEMPOTENCY_LOCK_IN_PROGRESS, and THAT is the error the till
 * would see: CASH_AMOUNT_SHORT, a sold-out tier or a tax refusal would read
 * "Still being processed" and then "may already be recorded". The operator's
 * own press is the replay; it goes through `attemptFailed` and knows which
 * kind of failure it is replaying.
 */
export const SALE_MUTATION_OPTIONS = { retry: false } as const;

export const NEW_ATTEMPT: SaleAttempt = {
  key: null,
  lock: null,
  processingPresses: 0,
  mayAlreadyBeRecorded: false,
};

/**
 * LOCK_IN_PROGRESS answers in a row before the till stops saying "wait" and
 * says "this sale may already be recorded" (a lost refusal holds the key for
 * fifteen minutes, so waiting can't clear it).
 */
export const PROCESSING_PRESSES_BEFORE_CHECK = 3;

/** The key for this press: the held one, or a new one on a sale's first press. */
export function keyForPress(
  attempt: SaleAttempt,
  mint: () => string,
): { attempt: SaleAttempt; key: string } {
  if (attempt.key !== null) return { attempt, key: attempt.key };
  const key = mint();
  return { attempt: { ...attempt, key }, key };
}

/**
 * The attempt answered. The key stays (a lost answer to the NEXT call in the
 * same flow, or a double-tap, must replay this sale) until the sale is closed
 * or the screen moves on to the next one.
 */
export function attemptAnswered(attempt: SaleAttempt): SaleAttempt {
  return { ...attempt, lock: null, processingPresses: 0 };
}

/**
 * Did the SERVER answer? Any app code, or any HTTP status, means it reached a
 * decision. No response at all means it may or may not have recorded a sale.
 * A bare 500 with no code still counts as answered: a Prisma timeout surfaces
 * that way, and treating it as "no answer" locked its own retry out for
 * fifteen minutes on the web till.
 */
export function serverAnsweredRequest(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (getAppErrorCode(error) !== null) return true;
  const status = (error as { data?: { httpStatus?: unknown } | null }).data
    ?.httpStatus;
  return typeof status === "number" && status > 0;
}

/** IDEMPOTENCY_KEY_CONFLICT: a different sale is stored under this key. */
export function keyMayHoldASale(error: unknown): boolean {
  return getAppErrorCode(error) === "IDEMPOTENCY_KEY_CONFLICT";
}

/** IDEMPOTENCY_LOCK_IN_PROGRESS: an attempt under this key is still running. */
export function saleStillProcessing(error: unknown): boolean {
  return getAppErrorCode(error) === "IDEMPOTENCY_LOCK_IN_PROGRESS";
}

/**
 * Settle the key after a failed press.
 *
 * Returns the next attempt state and `handled`: true when the failure is
 * fully explained by the till's own notice (no answer, still processing, may
 * already be recorded), so the caller shows no error banner. A plain refusal
 * returns `handled: false`, rotates the key and leaves the message to the
 * caller.
 */
export function attemptFailed(
  attempt: SaleAttempt,
  error: unknown,
  tender: Tender,
  mint: () => string,
): { attempt: SaleAttempt; handled: boolean } {
  if (keyMayHoldASale(error)) {
    return { attempt: { ...attempt, mayAlreadyBeRecorded: true }, handled: true };
  }
  if (saleStillProcessing(error)) {
    const processingPresses = attempt.processingPresses + 1;
    return {
      attempt: {
        ...attempt,
        processingPresses,
        lock: { tender, reason: "processing" },
        mayAlreadyBeRecorded:
          attempt.mayAlreadyBeRecorded ||
          processingPresses >= PROCESSING_PRESSES_BEFORE_CHECK,
      },
      handled: true,
    };
  }
  if (!serverAnsweredRequest(error)) {
    return {
      attempt: { ...attempt, lock: { tender, reason: "no-answer" } },
      handled: true,
    };
  }
  // The server refused. The key is spent (`failed:` for 15 minutes); the next
  // press is a new attempt.
  return {
    attempt: { ...attempt, key: mint(), lock: null, processingPresses: 0 },
    handled: false,
  };
}

/** True while the current key may hold a sale nobody has seen yet. */
export function isUnresolved(attempt: SaleAttempt): boolean {
  return attempt.lock !== null || attempt.mayAlreadyBeRecorded;
}

/** The button the operator presses again for each tender. */
export const TENDER_BUTTON: Record<Tender, string> = {
  card: "Tap to Pay",
  cash: "Confirm cash",
  comp: "Comp them",
};

/** The amber line for an unresolved attempt, or null when there is none. */
export function unresolvedNotice(attempt: SaleAttempt): string | null {
  if (attempt.mayAlreadyBeRecorded) {
    return "This sale may already be recorded. Check the event's orders and cash sales on the web. If it isn't there, clear the sale and ring it up again.";
  }
  if (attempt.lock?.reason === "processing") {
    return `Still being processed. Wait a moment, then press ${TENDER_BUTTON[attempt.lock.tender]} again.`;
  }
  if (attempt.lock) {
    const line = `No answer came back about that sale. Press ${TENDER_BUTTON[attempt.lock.tender]} again: if it went through, you'll see that sale, not a second one.`;
    // A card may have been charged: the cart's Cash is shut, but say it.
    return attempt.lock.tender === "card"
      ? `${line} Don't take cash for these tickets.`
      : line;
  }
  return null;
}

/**
 * May this tender be pressed? Shared by the Sell screen's two buttons and
 * the cash sheet, so "the other tenders lock" is one rule.
 *
 * - `card` needs a READY quote with a card total (a $0 cart has none).
 * - `cash` needs a READY quote.
 * - `comp` needs no quote: a comp charges no tax, so it is the one sale that
 *   still works while the tax lookup is down.
 * - Nothing may be pressed while busy, while the email is an obvious typo, or
 *   once the key may already hold a sale; and while one tender is locked,
 *   only that tender may be pressed again.
 */
export function tenderOpen(
  tender: Tender,
  args: {
    quoteReady: boolean;
    hasCardTotal: boolean;
    attempt: SaleAttempt;
    emailInvalid: boolean;
    busy: boolean;
  },
): boolean {
  const { quoteReady, hasCardTotal, attempt, emailInvalid, busy } = args;
  if (busy || emailInvalid || attempt.mayAlreadyBeRecorded) return false;
  if (attempt.lock !== null && attempt.lock.tender !== tender) return false;
  if (tender === "card") return quoteReady && hasCardTotal;
  if (tender === "cash") return quoteReady;
  return true;
}

// ── Closing an open card sale ───────────────────────────────────────────────

export type CompletedSale = RouterOutputs["pos"]["completeSale"];

/**
 * - `closed`: cancelled, or the order is gone. Nothing holds stock; the cart
 *   may be rung up again (cash included).
 * - `paid`: the card went through (SUCCEEDED). Show the card sale; NEVER take
 *   cash for it.
 * - `unknown`: everything else. The order reads PENDING from the tap until
 *   the payment webhook lands, so PENDING after a failed cancel proves
 *   nothing; only the void itself proves the PaymentIntent dead. Stay put,
 *   never take cash. "Check again" re-sends the cancel, which reads the
 *   PaymentIntent's real state. There is no in-screen Clear: the cancel
 *   refusals that would leave the payment untouched (role, event) make
 *   `completeSale` refuse too, so the till can never tell that case apart.
 *   Leaving the tab ("Clear it anyway") is the way out.
 */
export type CloseOutcome =
  | { kind: "closed" }
  | { kind: "paid"; order: CompletedSale }
  | {
      kind: "unknown";
      /** The server said ORDER_NOT_PROCESSABLE: the payment may have gone through. */
      paidNotFinalised: boolean;
      /** False when no app code came back (lost answer, 5xx, Stripe error). */
      cancelAnswered: boolean;
      status: string | null;
      error: unknown;
    };

/**
 * Cancel an open card order, and find out what it really was if the cancel
 * didn't plainly close it. Every cancel failure but ORDER_NOT_FOUND asks the
 * server (`completeSale`, uncached); only CANCELLED / SUCCEEDED are
 * definitive.
 */
export async function closeOpenCardSale(deps: {
  cancel: () => Promise<unknown>;
  check: () => Promise<CompletedSale>;
}): Promise<CloseOutcome> {
  let code: string | null = null;
  try {
    await deps.cancel();
    return { kind: "closed" };
  } catch (err) {
    code = getAppErrorCode(err);
    if (code === "ORDER_NOT_FOUND") return { kind: "closed" };
  }
  const unknown = (status: string | null, error: unknown): CloseOutcome => ({
    kind: "unknown",
    paidNotFinalised: code === "ORDER_NOT_PROCESSABLE",
    cancelAnswered: code !== null,
    status,
    error,
  });
  let order: CompletedSale;
  try {
    order = await deps.check();
  } catch (err) {
    return unknown(null, err);
  }
  if (order.status === "CANCELLED") return { kind: "closed" };
  if (order.status === "SUCCEEDED") return { kind: "paid", order };
  return unknown(order.status, null);
}

/**
 * Where the till goes after a close. Only `closed` returns to the cart, which
 * is the one screen with a Cash button: a card the server says was paid (or
 * might be) must never be followed by a cash sale for the same tickets.
 */
export function stageAfterClose(
  outcome: CloseOutcome,
): "cart" | "done" | "checking" {
  if (outcome.kind === "closed") return "cart";
  if (outcome.kind === "paid") return "done";
  return "checking";
}

/**
 * What the card-closing screen says. `label` is the mono state line above
 * the (muted) amount; the screen always leads with "Don't take cash for these
 * tickets." and then `explanation`. `settling`: the payment is being
 * confirmed and the screen moves on by itself, so it shows a spinner and
 * "Check again" steps back.
 */
export type CloseView = {
  label: string;
  explanation: string;
  settling: boolean;
  /**
   * The answer won't change by asking again (refunded, disputed, an unknown
   * status): "Check again" is the secondary action and a new sale is offered.
   */
  deadEnd?: boolean;
};

/** The first close is still running. */
export const CLOSING_VIEW: CloseView = {
  label: "Closing card sale",
  explanation: "Asking the server to cancel it.",
  settling: true,
};

/** Another press holds the till; "Check again" retries. */
export const CLOSE_DEFERRED_VIEW: CloseView = {
  label: "Card sale not closed",
  explanation: "Still closing the card sale. Press Check again in a moment.",
  settling: false,
};

/** Statuses a re-check can't move: the order is closed in a way the till can't act on. */
function isDeadEndStatus(status: string): boolean {
  return !["PENDING", "PROCESSING"].includes(status);
}

/** One phrase per order status, said as a sentence. */
function statusSentence(status: string): string {
  switch (status) {
    case "PENDING":
      return "The server still has this card sale open and can't say yet whether the card went through.";
    case "PROCESSING":
      return "The card payment is still processing.";
    case "PART_REFUNDED":
    case "REFUNDED":
      return "That card sale was paid and has been refunded, so it can't be closed from here. Check the event's orders.";
    case "DISPUTED":
      return "That card sale is disputed, so it can't be closed from here. Check the event's orders.";
    default:
      return "That card sale can't be closed from here. Check the event's orders.";
  }
}

/** The view for an outcome that stays on the screen (null for closed / paid). */
export function closeOutcomeView(outcome: CloseOutcome): CloseView | null {
  if (outcome.kind !== "unknown") return null;
  if (outcome.paidNotFinalised) {
    return {
      label: "Confirming card",
      explanation:
        "The card may have gone through and is being confirmed. This screen moves on by itself.",
      settling: true,
    };
  }
  if (!outcome.cancelAnswered) {
    return {
      label: "Card sale not closed",
      explanation:
        "No clear answer came back about closing it: the card may have gone through. Check again asks the server to close it.",
      settling: false,
    };
  }
  if (outcome.status) {
    return {
      label: outcome.status === "PROCESSING" ? "Confirming card" : "Card sale not closed",
      explanation: statusSentence(outcome.status),
      settling: outcome.status === "PROCESSING",
      ...(isDeadEndStatus(outcome.status) ? { deadEnd: true } : {}),
    };
  }
  return {
    label: "Card sale not closed",
    explanation: "Couldn't check that card sale. Check again before going on.",
    settling: false,
  };
}

// ── The card-cleared notice ─────────────────────────────────────────────────

/**
 * What the till says after "Clear it anyway" left an open card sale behind.
 * Starts as `unconfirmed` (the best-effort cancel is in flight) and moves to
 * what the cancel answered. Never a "you may take cash" line: even a confirmed
 * cancel only says the card wasn't charged.
 */
export type CardClearedKind = "unconfirmed" | "maybe-paid" | "cancelled";

/**
 * The notice's words. The title leads with the instruction and points at the
 * OLD sale by its card amount ("these tickets" pointed at nothing: the cart
 * was emptied, and later it means the next buyer's cart). `amount` is the
 * already-formatted card total the reader was asking for, or null if unknown.
 */
export function cardClearedCopy(
  kind: CardClearedKind,
  amount: string | null,
): { title: string; body: string } {
  if (kind === "cancelled") {
    return {
      title: "Card sale cancelled",
      body: "The card wasn't charged. You can ring those tickets up again.",
    };
  }
  const title = `Don't take cash for ${
    amount ? `the ${amount} card sale` : "the card sale"
  } you cleared`;
  return kind === "maybe-paid"
    ? {
        title,
        body: "That card may have gone through. If it did, the sale stands.",
      }
    : {
        title,
        body: "If that card went through, the sale stands. Its tickets may stay held for a few minutes.",
      };
}

/**
 * The notice after the best-effort cancel answered. `null` = it went
 * through; otherwise the error it threw.
 */
export function cardClearedAfterCancel(error: unknown): CardClearedKind {
  if (error === null) return "cancelled";
  const code = getAppErrorCode(error);
  if (code === "ORDER_NOT_FOUND") return "cancelled";
  if (code === "ORDER_NOT_PROCESSABLE") return "maybe-paid";
  // ORDER_NOT_PENDING (could be paid), any refusal, no answer at all.
  return "unconfirmed";
}

// ── Leaving the Sell tab ────────────────────────────────────────────────────

/**
 * Why leaving the Sell tab (or switching events) would drop something the
 * till must not lose, or null when it wouldn't:
 * - `sending`: a press is waiting on the server; its answer would land
 *   nowhere.
 * - `card`: a card sale is open on the reader, or being closed. Losing that
 *   screen is how a paid card gets followed by cash.
 * - `unresolved`: the key may hold a sale nobody has seen; a new key for the
 *   same tickets could sell them twice.
 */
export type LeaveRisk = "sending" | "card" | "unresolved";

export function saleLeaveRisk(args: {
  stage: "browse" | "cash" | "tap-to-pay" | "card-closing" | "result";
  attempt: SaleAttempt;
  busy: boolean;
}): LeaveRisk | null {
  if (args.stage === "tap-to-pay" || args.stage === "card-closing") return "card";
  if (args.busy) return "sending";
  if (isUnresolved(args.attempt)) return "unresolved";
  return null;
}
