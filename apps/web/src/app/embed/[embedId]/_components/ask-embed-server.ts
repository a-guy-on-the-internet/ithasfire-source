import { getAppErrorCode } from "@/lib/app-error";
import { traceIgnoredError } from "@/lib/trace-ignored-error";

import type { EmbedServerAnswer } from "./embed-payment-status";
import type { EmbedTicketCode } from "./embed-tickets";
import {
  CONFIRM_ORDER_RETRY_DELAY_MS,
  CONFIRM_ORDER_TIMEOUT_MS,
  settledWithin,
} from "./embed-request-timeouts";

// Asking the server what became of an order (`embeds.confirmGuestPayment`).
// The widget shows "Order confirmed" on this answer and on nothing else. A
// call that fails or never answers is "unanswered": the buyer may have been
// charged, so it is never read as "not paid".

/**
 * What `embeds.confirmGuestPayment` answers.
 *
 * `tickets` rides "confirmed" only, and may be missing (an API older than
 * this web build) or empty (the server withholds the codes). It is read
 * through `ticketsForOrder`, never trusted as typed, and never traced.
 */
export type EmbedServerOutcome =
  | { outcome: "confirmed"; orderId: string; tickets?: EmbedTicketCode[] }
  | { outcome: "processing"; orderId: string }
  | { outcome: "not_paid"; orderId: string; paymentIntentStatus: string };

/** One call of the mutation, for one client secret. */
export type SendEmbedConfirm = () => Promise<EmbedServerOutcome>;

/**
 * What a failed ask was:
 * - "locked": a finalize is running for the order right now (the webhook's,
 *   or an earlier ask's). Worth one more ask after a pause.
 * - "rate-limited": the endpoint's budget is spent. Asking again makes it
 *   worse; asking later can work.
 * - "final": a refusal that is the same the second time.
 * - "transient": everything else. A lost connection, a 500, a gateway that
 *   timed out, a code this file does not know. Worth one more ask.
 */
type Failure = "transient" | "locked" | "rate-limited" | "final";

type Attempt =
  | { answered: true; answer: EmbedServerOutcome }
  | { answered: false; failure: Failure };

/**
 * tRPC codes for a refusal asking again cannot change. Nothing else is.
 *
 * NOT_FOUND is not here: it is also what tRPC answers for a procedure the
 * API does not have, which happens when a web build is ahead of the API
 * (the two deploy separately) and is fixed by asking a minute later. It is
 * final only with one of the app codes below.
 */
const FINAL_TRPC_CODES = new Set(["FORBIDDEN", "CONFLICT", "BAD_REQUEST"]);
/**
 * Refusals that are final by app code: the NOT_FOUND ones, and any of the
 * others on an error that carries only its app code.
 */
const FINAL_APP_CODES = new Set([
  "ORDER_NOT_PROCESSABLE",
  "PAYMENT_INTENT_ORDER_MISMATCH",
  "PAYMENT_INTENT_MISMATCH",
  "AMOUNT_MISMATCH",
  "EMBED_ORIGIN_NOT_ALLOWED",
  "EMBED_NOT_FOUND",
  "EVENT_NOT_FOUND",
  "ORDER_NOT_FOUND",
]);

function failureOf(error: unknown): Failure {
  // The app code first. The server sends the finalize lock as tRPC
  // TOO_MANY_REQUESTS with `appCode: IDEMPOTENCY_LOCK_IN_PROGRESS`
  // (`appCodeToTrpc` in packages/transport/trpc/src/utils.ts), so read by
  // its tRPC code alone it is indistinguishable from a spent rate limit.
  const appCode = getAppErrorCode(error);
  if (appCode === "IDEMPOTENCY_LOCK_IN_PROGRESS") return "locked";
  const trpcCode = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (trpcCode === "TOO_MANY_REQUESTS") return "rate-limited";
  if (typeof trpcCode === "string" && FINAL_TRPC_CODES.has(trpcCode)) {
    return "final";
  }
  if (appCode !== null && FINAL_APP_CODES.has(appCode)) return "final";
  return "transient";
}

/**
 * The refusal an API gives an input its schema does not take: tRPC
 * BAD_REQUEST with no app code. Every refusal the use case itself makes
 * carries an app code; only the transport's input parse comes without one.
 */
function isInputSchemaRefusal(error: unknown): boolean {
  const trpcCode = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return trpcCode === "BAD_REQUEST" && getAppErrorCode(error) === null;
}

/**
 * One confirm call, carrying the order's receipt secret when the tab holds
 * one (embed-receipt-secret.ts), which is what earns the ticket codes.
 *
 * The confirm input is `.strict()`, so an API older than receipt secrets
 * refuses the field with a bare BAD_REQUEST, which `failureOf` reads as
 * final. Holding a secret does not prove the API takes one: the API that
 * answered the create may have been rolled back since. So a call that
 * carried the field and got exactly that refusal is sent ONCE more without
 * it. That answer is the confirm the buyer needs, with no codes (the email
 * carries them). Any other failure, and any failure of a call without the
 * field, is the caller's as it stands.
 */
export async function sendConfirmWithReceiptSecret<
  Input extends object,
  Output,
>(
  send: (input: Input & { receiptSecret?: string }) => Promise<Output>,
  input: Input,
  receiptSecret: string | null,
): Promise<Output> {
  if (!receiptSecret) return send(input);
  try {
    return await send({ ...input, receiptSecret });
  } catch (error: unknown) {
    if (!isInputSchemaRefusal(error)) throw error;
    // Seen, without the input: the request carried both secrets.
    traceIgnoredError("embed.receiptSecretRefused")(
      new Error("embeds.confirmGuestPayment refused receiptSecret; asked without it"),
    );
    return send(input);
  }
}

/** One ask. Never rejects: a throw is an attempt that was not answered. */
function attempt(send: SendEmbedConfirm): Promise<Attempt> {
  return send().then(
    (answer): Attempt => ({ answered: true, answer }),
    (error: unknown): Attempt => {
      // A fresh Error naming only the failure's kind: the request carried
      // the client secret, and nothing of it may reach a trace.
      traceIgnoredError("embed.confirmOrderFailed")(
        new Error(
          `embeds.confirmGuestPayment failed: ${getAppErrorCode(error) ?? "no app code"}`,
        ),
      );
      return { answered: false, failure: failureOf(error) };
    },
  );
}

/** The first of `attempts` to be answered; the last failure when none is. */
function firstAnswered(attempts: Promise<Attempt>[]): Promise<Attempt> {
  return new Promise((resolve) => {
    let left = attempts.length;
    for (const one of attempts) {
      void one.then((result) => {
        left -= 1;
        if (result.answered || left === 0) resolve(result);
      });
    }
  });
}

const pause = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const unansweredAfter = (failure: Failure | null): EmbedServerAnswer => ({
  outcome: "unanswered",
  final: failure === "final",
  ...(failure === "rate-limited" ? { rateLimited: true } : {}),
});

/**
 * Asks the server about one order and waits `CONFIRM_ORDER_TIMEOUT_MS` for
 * the answer. Never rejects.
 *
 * A second ask follows a first that failed because a finalize is already
 * running for the order. With `askTwice` it also follows a first that was
 * silent or failed in transit (a first ask that is still out can answer
 * during the second wait, and is taken if it does). At most two asks, each
 * sent twice at most when the API refuses the receipt secret
 * (`sendConfirmWithReceiptSecret`), against the endpoint's budgets of 20 per
 * minute per IP and 20 per minute per PaymentIntent.
 *
 * `onLateAnswer`: an ask this function stopped waiting for can still be
 * answered. The first such answer is handed over, once, after the function
 * has returned "unanswered". The caller decides whether it still applies.
 */
export async function askEmbedServer(
  send: SendEmbedConfirm,
  {
    askTwice,
    onLateAnswer,
  }: {
    askTwice: boolean;
    onLateAnswer?: (answer: EmbedServerOutcome) => void;
  },
): Promise<EmbedServerAnswer> {
  let returned = false;
  let lateHandedOver = false;
  const watched = (asked: Promise<Attempt>): Promise<Attempt> => {
    void asked.then((result) => {
      if (!returned || lateHandedOver || !result.answered) return;
      lateHandedOver = true;
      onLateAnswer?.(result.answer);
    });
    return asked;
  };
  const giveUp = (failure: Failure | null): EmbedServerAnswer => {
    returned = true;
    return unansweredAfter(failure);
  };

  const first = watched(attempt(send));
  const firstResult = await settledWithin(first, CONFIRM_ORDER_TIMEOUT_MS);
  if (firstResult?.answered) return firstResult.answer;
  if (firstResult === null) {
    traceIgnoredError("embed.confirmOrderTimedOut")(
      new Error("embeds.confirmGuestPayment gave no answer in time"),
    );
    if (!askTwice) return giveUp(null);
  } else {
    const { failure } = firstResult;
    const again = failure === "locked" || (askTwice && failure === "transient");
    if (!again) return giveUp(failure);
    // Failed outright: give a finalize that is running time to end.
    await pause(CONFIRM_ORDER_RETRY_DELAY_MS);
  }

  // Silent: the first ask is still out, and may answer while the second
  // one is waited on.
  const second = watched(attempt(send));
  const secondResult = await settledWithin(
    firstResult === null ? firstAnswered([first, second]) : second,
    CONFIRM_ORDER_TIMEOUT_MS,
  );
  if (secondResult?.answered) return secondResult.answer;
  if (secondResult === null) {
    traceIgnoredError("embed.confirmOrderTimedOut")(
      new Error("embeds.confirmGuestPayment gave no answer in time, twice"),
    );
    return giveUp(null);
  }
  return giveUp(secondResult.failure);
}
