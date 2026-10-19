import { getAppErrorCode } from "@/lib/app-error";

/**
 * Where a sale is, as a discriminated union.
 *
 * Deliberately one union rather than a handful of booleans: at a door, the
 * states are mutually exclusive and the failure mode of booleans — a screen
 * that is somehow both "waiting on the reader" and "done" — is a screen that
 * takes money twice.
 */
export type SellStage =
  /** Building the cart. The catalogue is live. */
  | { kind: "ring-up" }
  /** Cart is fixed; picking how they pay. */
  | { kind: "tender" }
  /**
   * Dispatched to a reader; the prompt is on the device and we are polling
   * for the webhook to finalise the order.
   */
  | {
      kind: "card-waiting";
      orderId: string;
      posReaderId: string;
      readerLabel: string;
      /** What the reader asks for: `startSale.amountCents`, the server's charge. */
      amountCents: number;
      /**
       * The card total the quote showed before the sale started, or null when
       * there was none. When it differs from `amountCents` (the event's tax
       * rate moved in between) the screen says so before the buyer taps.
       */
      quotedCents: number | null;
    }
  /**
   * The reader didn't take it, OR the operator cleared the prompt. Either way
   * the ORDER IS STILL OPEN: nothing was charged, the cart survives, and there
   * are three ways out (retry, another reader, cash). A failure that sends the
   * operator back to the catalogue loses the customer.
   */
  | {
      kind: "card-open";
      orderId: string;
      posReaderId: string;
      readerLabel: string;
      amountCents: number;
      /** Carried through so a retry's waiting screen can still compare. */
      quotedCents: number | null;
      headline: string;
      detail: string;
    }
  /** Paid, minted, admitted. */
  | {
      kind: "done";
      amountCents: number;
      ticketCount: number;
      isComp: boolean;
      autoAdmitted: boolean;
      seatLabels: string[];
      tender: "card" | "cash" | "comp";
      /**
       * Promo discount the sale applied. A paid sale at $0 with a discount is
       * "free with a code", which is a SALE, never "Comped": comp means only
       * the Comp button.
       */
      discountCents: number;
      /**
       * The promo codes the sale redeemed (`recordCashSale`'s `promoCodes`),
       * so a $0 sale reads "Free with <CODE>". Empty for a card sale (never
       * $0) and for a comp.
       */
      promoCodes: string[];
      /** The address the receipt went to, as sent; null when none was given. */
      buyerEmail: string | null;
      /**
       * Cash handed over minus what the server charged (`recordCashSale`'s
       * `changeCents`). The till collects the quote's cash total, so this is
       * 0 unless the sale came out LOWER than the quote (a hand-entered tax
       * rate replaced by a lower looked-up one in between). Then the buyer is
       * owed the difference and the done screen says so.
       */
      changeCents: number;
    };

/**
 * Reader failures we are willing to render as a friendly, recoverable screen.
 *
 * Kept to an ALLOW-LIST on purpose. Flattening every Stripe failure into
 * "the reader isn't responding" would be friendly and wrong — it would tell an
 * operator to retry through a declined card or a misconfigured account, and it
 * would bury a real defect behind reassuring copy. Anything not on this list
 * stays an error, surfaces as a toast, and reaches Sentry through the normal
 * backstops.
 */
const RECOVERABLE_READER_CODES = new Set([
  "POS_READER_OFFLINE",
  "POS_READER_BUSY",
]);

export type RecoverableReaderFailure = {
  headline: string;
  detail: string;
};

/**
 * Classify a dispatch failure.
 *
 * Returns null when the failure is NOT one of the two we can honestly offer a
 * retry for — the caller must then surface it as a real error rather than a
 * reassuring one.
 *
 * The detail line answers the operator's actual first thought — "did it take
 * the money twice?" — before offering any buttons.
 */
export function classifyReaderFailure(
  error: unknown,
  readerLabel: string,
  amountLabel: string,
): RecoverableReaderFailure | null {
  const code = getAppErrorCode(error);
  if (!code || !RECOVERABLE_READER_CODES.has(code)) return null;

  if (code === "POS_READER_BUSY") {
    return {
      headline: `${readerLabel} is already taking a payment`,
      detail: `It's mid-transaction for something else. Nothing was charged — the ${amountLabel} sale is still open.`,
    };
  }

  return {
    headline: `${readerLabel} isn't responding`,
    detail: `It's offline or off the network. Nothing was charged — the ${amountLabel} sale is still open.`,
  };
}

/**
 * Does this `completeSale` status mean the sale is finished, one way or
 * another?
 *
 * PENDING and PROCESSING are the poll's normal answers while the
 * `payment_intent.succeeded` webhook is in flight, so they are the ONLY two
 * that keep polling. Everything else stops — including the ones that are not
 * good news, because a till that polls forever on a CANCELLED order looks
 * identical to one waiting on a slow tap.
 */
export function isTerminalSaleStatus(status: string): boolean {
  return status !== "PENDING" && status !== "PROCESSING";
}

/**
 * Did the SERVER answer this request?
 *
 * This is the question that decides whether a sale's idempotency key may be
 * reused, and it took a real failure at a real till to get right.
 *
 * Both sell procedures wrap their whole body in `try/catch` and call
 * `idempotency.fail(key, …)` on ANY throw. `fail()` writes `failed:…` under
 * the key with a 15-minute TTL, `get()` returns null for anything that is not
 * exactly `"succeeded"`, and `begin()` is a `SET NX`. So once the server has
 * responded with an error, that key is DEAD for fifteen minutes: retrying with
 * it does not reach the use case, it returns IDEMPOTENCY_LOCK_IN_PROGRESS —
 * "your order is already being processed" — and no amount of waiting helps.
 *
 * That means keeping the key after a server error protects nothing. It cannot
 * produce a safe replay, because there is no stored result to replay; it can
 * only produce a lock error. The only case where reuse genuinely prevents a
 * double sale is when the client got NO response at all — a dropped
 * connection, a closed laptop — because there the server may well have reached
 * `idempotency.commit()`, the key holds `"succeeded"`, and a replay returns
 * that same sale instead of selling again.
 *
 * Hence: any HTTP status (or any recognised app code) means the server
 * decided, so rotate. No response means we cannot tell, so keep.
 *
 * The first version of this checked only for a structured app code, which
 * looked right and was not: a Prisma transaction timeout surfaces as a bare
 * 500 with no code, so the very first cash sale that timed out locked its own
 * retry out of the till for fifteen minutes. Observed in a browser, not
 * reasoned about.
 */
export function serverAnsweredRequest(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (getAppErrorCode(error) !== null) return true;
  const status = (error as { data?: { httpStatus?: unknown } }).data
    ?.httpStatus;
  return typeof status === "number" && status > 0;
}

/**
 * IDEMPOTENCY_KEY_CONFLICT: a sale is stored under this key with a different
 * payload (the operator changed the email or the tender after a response
 * went missing). The key is kept, because a fresh one would sell the same
 * tickets again, and the operator is sent to check what was recorded.
 */
export function keyMayHoldASale(error: unknown): boolean {
  return getAppErrorCode(error) === "IDEMPOTENCY_KEY_CONFLICT";
}

/**
 * IDEMPOTENCY_LOCK_IN_PROGRESS: an attempt under this key is still being
 * worked on. `begin()` claims the key before the tax lookup, so the usual
 * cause is the first press still running. Nothing is known yet, so this is
 * a "wait, then press the same tender again", not a "check what was
 * recorded". The key is kept: the next press finds the stored sale.
 *
 * It can also last: a first attempt the server refused while its answer was
 * lost leaves `failed:` under the key for fifteen minutes, and every replay
 * answers LOCK_IN_PROGRESS. The till escalates after a few in a row
 * (`PROCESSING_PRESSES_BEFORE_CHECK`).
 */
export function saleStillProcessing(error: unknown): boolean {
  return getAppErrorCode(error) === "IDEMPOTENCY_LOCK_IN_PROGRESS";
}

/**
 * How many LOCK_IN_PROGRESS answers in a row before the till stops saying
 * "wait" and sends the operator to check what was recorded.
 */
export const PROCESSING_PRESSES_BEFORE_CHECK = 3;

/**
 * Should a failed sale attempt give up its idempotency key?
 *
 * Yes when the server answered with a refusal (see `serverAnsweredRequest`).
 * No when no answer came back (a replay must find the stored sale), when the
 * key may already hold a sale (`keyMayHoldASale`), and when an attempt under
 * it is still running (`saleStillProcessing`).
 */
export function shouldRotateSaleKey(error: unknown): boolean {
  return (
    serverAnsweredRequest(error) &&
    !keyMayHoldASale(error) &&
    !saleStillProcessing(error)
  );
}

/**
 * The sale that just happened, kept so the operator can undo a mistake.
 *
 * Held only in memory, deliberately. A reload loses it, which is acceptable:
 * a card sale is still refundable from the Orders page, and persisting order
 * ids to a shared door tablet's storage buys little and leaks a little.
 */
export type LastSale = {
  orderId: string;
  amountCents: number;
  ticketCount: number;
  tender: "card" | "cash" | "comp";
  /** When the sale completed, by the CLIENT's clock. See `refundWindowLeftMs`. */
  soldAt: number;
};

/** The server's gate-refund window (`GATE_REFUND_WINDOW_MS`), mirrored. */
export const GATE_REFUND_WINDOW_MS = 15 * 60 * 1000;

/**
 * Milliseconds left on the refund window, by the client's clock.
 *
 * The server is the authority — it measures from `order.occurredAt` against
 * its own clock and refuses with `gate_refund_window_expired`. This is only
 * for deciding when to stop offering the button, and it is deliberately
 * PERMISSIVE about skew: a door tablet with a wrong clock should show an
 * affordance that then fails with a clear message, rather than silently hide
 * a refund the server would have allowed. Hiding a valid action leaves the
 * operator with no route at all; offering an invalid one costs a toast.
 */
export function refundWindowLeftMs(sale: LastSale, now: number): number {
  return Math.max(0, sale.soldAt + GATE_REFUND_WINDOW_MS - now);
}

/**
 * Which procedure reverses this sale.
 *
 * Cash and comp are the same call — a comp IS a cash sale with nothing
 * collected — and both are state-only. Card goes through the money path.
 * Getting this wrong is not a silent failure: each use case refuses an order
 * from the other channel (`NOT_A_CASH_ORDER` / `NOT_A_POS_CARD_ORDER`).
 */
export function refundProcedureFor(
  tender: LastSale["tender"],
): "card" | "cash" {
  return tender === "card" ? "card" : "cash";
}
