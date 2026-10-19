import { getAppErrorCode } from "@/lib/app-error";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import { RELEASE_ORDER_TIMEOUT_MS, settledWithin } from "./embed-request-timeouts";

// Giving back an order the buyer left (`embeds.releaseGuestOrder`): the
// server cancels it and its tickets go back on sale, instead of staying
// reserved until the server's own clean-up reaches the order.
//
// One call, one bounded wait, no second try. The server decides: it refuses
// to cancel an order that is paid or may yet be ("kept"), so a release that
// fails or is never answered changes nothing for the buyer, who is told
// what they would have been told with no release at all.

/** What `embeds.releaseGuestOrder` answers. */
export type EmbedReleaseAnswer = {
  outcome: "released" | "gone" | "kept";
  orderId: string;
};

/** One call of the mutation, for one client secret. */
export type SendEmbedRelease = () => Promise<EmbedReleaseAnswer>;

/**
 * What became of a release:
 * - "released": the order was cancelled and its tickets are back on sale.
 * - "gone": it was cancelled already. It holds nothing.
 * - "kept": the order still stands. It is paid or being paid, Stripe could
 *   not say its payment is dead, or something else got to the order first.
 * - "unanswered": the call was refused, failed, or nobody answered in time.
 *   The order may or may not have been released. It is never read as
 *   "released".
 */
export type EmbedReleaseOutcome = "released" | "gone" | "kept" | "unanswered";

const ANSWERS = new Set<string>(["released", "gone", "kept"]);

/** The failure's kind, and nothing else of it. */
function kindOf(error: unknown): string {
  const appCode = getAppErrorCode(error);
  if (appCode !== null) return appCode;
  // The tRPC code (`data.code`: CONFLICT, FORBIDDEN, TOO_MANY_REQUESTS, …).
  // Read only when it is one of tRPC's own words, never passed through as a
  // string that could hold something else.
  const trpcCode = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof trpcCode === "string" && /^[A-Z_]{1,40}$/.test(trpcCode)
    ? trpcCode
    : "no code";
}

/**
 * Failures that are the system working, not a defect, so they are not traced:
 * the order's own release budget is spent (`RATE_LIMITED`), the order is not
 * this embed's or was made before the embed binding existed
 * (`PAYMENT_INTENT_ORDER_MISMATCH`, expected for orders made before that
 * deploy), or the connection dropped (a `TypeError` with one of fetch's own
 * messages, with no tRPC `data`). Reads codes and the error's type only, never the request, which
 * holds the client secret.
 */
function isExpectedReleaseFailure(error: unknown): boolean {
  const e = error as {
    data?: { code?: unknown };
    cause?: unknown;
  } | null;
  if (typeof e !== "object" || e === null) return false;
  // A real refusal from the server always carries `data.code`; the app code
  // alone (it can also come from `message`) is not enough.
  const trpcCode = e.data?.code;
  if (trpcCode !== undefined) {
    const appCode = getAppErrorCode(error);
    return (
      (trpcCode === "TOO_MANY_REQUESTS" && appCode === "RATE_LIMITED") ||
      (trpcCode === "CONFLICT" && appCode === "PAYMENT_INTENT_ORDER_MISMATCH")
    );
  }
  if (e.data) return false;
  return isFetchNetworkFailure(error) || isFetchNetworkFailure(e.cause);
}

/**
 * A `TypeError` with a message a failed `fetch` produces. Any other
 * `TypeError` is a bug in our own code and stays traced. The message is
 * matched, never output.
 */
const FETCH_FAILURE_MESSAGES = new Set([
  "Failed to fetch", // Chrome
  "NetworkError when attempting to fetch resource.", // Firefox
  "Load failed", // Safari
  "fetch failed", // undici
]);
function isFetchNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && FETCH_FAILURE_MESSAGES.has(error.message);
}

/**
 * Asks the server to release one order and waits `RELEASE_ORDER_TIMEOUT_MS`
 * for the answer. Never rejects.
 *
 * `onLateAnswer`: the call this function stopped waiting for can still be
 * answered, and by then the order may be cancelled on the server while the
 * buyer was told its tickets are still reserved. The server's answer is
 * handed over, once, after the function has returned "unanswered". A call
 * that fails late hands nothing over. The caller decides whether the answer
 * still applies.
 */
export async function releaseEmbedOrder(
  send: SendEmbedRelease,
  {
    onLateAnswer,
  }: {
    onLateAnswer?: (outcome: Exclude<EmbedReleaseOutcome, "unanswered">) => void;
  } = {},
): Promise<EmbedReleaseOutcome> {
  // Sent now, inside the executor: a `send` that throws before it returns a
  // promise is a failed call like any other.
  const sent = new Promise<EmbedReleaseAnswer>((resolve) => resolve(send()));
  const answered = sent.then(
    (answer): EmbedReleaseOutcome =>
      ANSWERS.has(answer?.outcome) ? answer.outcome : "unanswered",
    (error: unknown): EmbedReleaseOutcome => {
      // A fresh Error naming only the failure's kind: the request carried
      // the client secret, and nothing of it may reach a trace.
      traceIgnoredError("embed.releaseOrderFailed", () =>
        isExpectedReleaseFailure(error),
      )(
        new Error(`embeds.releaseGuestOrder failed: ${kindOf(error)}`),
      );
      return "unanswered";
    },
  );
  const outcome = await settledWithin(answered, RELEASE_ORDER_TIMEOUT_MS);
  if (outcome === null) {
    traceIgnoredError("embed.releaseOrderTimedOut")(
      new Error("embeds.releaseGuestOrder gave no answer in time"),
    );
    void answered.then((late) => {
      if (late !== "unanswered") onLateAnswer?.(late);
    });
    return "unanswered";
  }
  return outcome;
}
