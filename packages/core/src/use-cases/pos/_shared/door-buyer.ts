import { z } from "zod";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";

import { ensureGuestHumanKeepingName } from "../../../lib/ensure-guest-human";
import { describeError } from "../../../lib/io";
import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import { sendTicketIssuedEmail } from "../../orders/send-ticket-issued-email";

/**
 * The optional buyer email a door sale takes (spec 2026-10-07
 * door-sales-same-price-and-tax, FR-011; owner ruling R7): validated as
 * online guest checkout validates its guest email (trimmed, at most 320
 * characters, an address), and lowercased, because sign-up stores the address
 * lowercased and the ticket must be found under it when the buyer signs up.
 *
 * Optional, and an empty or whitespace-only value counts as NOT GIVEN: a till
 * sends its email field as typed, and a blank field is a buyer who declined,
 * not a malformed address to refuse the sale over. The parsed value is then
 * `undefined`, so the sale hashes and records exactly as with no field.
 * The outer bound caps the work before trimming.
 */
export const doorBuyerEmailSchema = z
  .string()
  .max(1024)
  .trim()
  .toLowerCase()
  .pipe(
    z.union([
      z.literal("").transform(() => undefined),
      z.string().max(320).email(),
    ]),
  )
  .optional();

/**
 * The buyer a door order is recorded against, inside the sale's transaction.
 *
 * - No email: a per-sale phantom Human (`source: POS_WALKUP`, FR-004), as
 *   before.
 * - An email: the guest-checkout mechanism (`ensureGuestHumanKeepingName`,
 *   as the embed checkout and comp issuance use it). An address that already
 *   has an account gets the ticket on that account; a new one gets a shadow
 *   Human + an unverified, password-less auth row keyed by the address, which
 *   a later sign-up with that address takes over, tickets included. No
 *   sign-in account is created, no name is written, and no consent (marketing
 *   or otherwise) is recorded.
 */
export async function resolveDoorBuyer(
  tx: Pick<TxRepos, "humans">,
  buyerEmail: string | undefined,
): Promise<string> {
  if (buyerEmail) {
    const { humanId } = await ensureGuestHumanKeepingName(tx.humans, {
      email: buyerEmail,
    });
    return humanId;
  }
  const phantom = await tx.humans.create({
    name: null,
    status: "ACTIVE",
    source: "POS_WALKUP",
  });
  return phantom.id;
}

/** What a door path needs to email the receipt. All or nothing. */
export type DoorReceiptMailConfig = {
  mailer: MailerPort;
  publicAppUrl: string;
  supportUrl: string;
  tileServerUrl?: string | null;
  /** Wall-clock cap on the whole send. Defaults to {@link DOOR_RECEIPT_SEND_BUDGET_MS}; tests shorten it. */
  sendBudgetMs?: number;
};

/**
 * The longest the cash till's response waits on the buyer's emails (the
 * reads and both sends together), after the sale committed. The operator is
 * holding the buyer's cash and waiting for the tickets; a mail provider that
 * hangs must not stall that, or the operator taps again and sells twice.
 * Past the cap the sale returns and the miss is reported once.
 */
export const DOOR_RECEIPT_SEND_BUDGET_MS = 3_000;

const RECEIPT_BUDGET_EXHAUSTED = Symbol("door_receipt_budget_exhausted");

/**
 * Email the door buyer their ticket and itemised receipt, AFTER the sale
 * committed (`sendTicketIssuedEmail`: the online confirmation, plus the
 * receipt it sends for a door order). Used by the cash till; a card sale's
 * receipt goes out from the payment webhook, after the order finalises.
 *
 * A DELIBERATE SWALLOW (CLAUDE.md, Error Reporting Convention): the sale is
 * paid and committed, the tickets are minted, and the operator is handing
 * them over; a mail fault must not turn that into a failed sale or a retry
 * that sells again. It is logged at `error` and reported, and never throws
 * (a throwing reporter included). Exactly-once delivery rides the mailer's
 * idempotency keys (`ticket-issued:` / `door-sale-receipt:` + order id) and
 * the sale's own idempotency record (a replayed sale returns before this).
 *
 * Capped at {@link DOOR_RECEIPT_SEND_BUDGET_MS} of wall time: past it the
 * till gets its answer and the miss is reported (`door_receipt_send_timed_out`).
 */
export async function sendDoorReceiptAfterCommit(
  deps: {
    repos: Repos;
    logger?: LoggerPort;
    reportError?: ReporterPort;
    receiptMail?: DoorReceiptMailConfig | null;
  },
  args: { orderId: string; eventId: string; useCase: string },
): Promise<void> {
  const config = deps.receiptMail;
  try {
    if (!config) {
      // A buyer asked for a receipt this deployment cannot send.
      throw new Error("door_receipt_mail_not_configured");
    }
    const send = sendTicketIssuedEmail(
      {
        repos: deps.repos,
        mailer: config.mailer,
        ...(deps.logger ? { logger: deps.logger } : {}),
        reportError: deps.reportError,
      },
      {
        orderId: args.orderId,
        publicAppUrl: config.publicAppUrl,
        supportUrl: config.supportUrl,
        ...(config.tileServerUrl ? { tileServerUrl: config.tileServerUrl } : {}),
      },
    );
    const budgetMs = config.sendBudgetMs ?? DOOR_RECEIPT_SEND_BUDGET_MS;
    const outcome = await withinReceiptBudget(send, budgetMs);
    if (outcome === RECEIPT_BUDGET_EXHAUSTED) {
      // Awaited, not fire-and-forget: Cloud Run may freeze the CPU once the
      // response is sent, so an abandoned send may never finish. The report
      // below is the signal; a late result (or rejection) of the abandoned
      // send is dropped so it is not reported a second time.
      throw new Error("door_receipt_send_timed_out");
    }
  } catch (err) {
    try {
      deps.logger?.error("pos.door_receipt.send_failed", {
        orderId: args.orderId,
        eventId: args.eventId,
        error: describeError(err),
      });
    } catch {
      // A broken logger must not undo a committed sale either.
    }
    reportBestEffort(deps.reportError, err, {
      tags: { useCase: args.useCase, step: "sendDoorReceipt" },
      extra: { orderId: args.orderId, eventId: args.eventId },
    });
  }
}

/**
 * `work`, or {@link RECEIPT_BUDGET_EXHAUSTED} once `ms` of real time passed
 * (real time, not the use case's clock: the cap is about how long the till
 * waits). The same shape as the tax lookup's budget in
 * `resolve-checkout-tax-rate.ts`.
 */
async function withinReceiptBudget<T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof RECEIPT_BUDGET_EXHAUSTED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof RECEIPT_BUDGET_EXHAUSTED>((resolve) => {
    timer = setTimeout(() => resolve(RECEIPT_BUDGET_EXHAUSTED), Math.max(0, ms));
  });
  try {
    const result = await Promise.race([work, timeout]);
    // A late rejection of the abandoned send must not surface as unhandled.
    if (result === RECEIPT_BUDGET_EXHAUSTED) work.catch(() => {});
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
