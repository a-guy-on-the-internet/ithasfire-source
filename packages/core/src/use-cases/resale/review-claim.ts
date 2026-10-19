import { z } from "zod";

import { randomUUID } from "node:crypto";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PaymentProcessorPort,
  PaymentRefundStatus,
} from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import { asKnownError, fail } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { parseInput } from "../../lib/io";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";
import {
  groupReversalsByPayee,
  writeRefundDebitsForOrder,
  writeTransferReversalCreditsForOrder,
} from "../orders/_shared/write-refund-debits";
import { withOrderRefundMutex } from "../orders/_shared/refund-mutex";
import { assertOrderNotDisputeBlocked } from "../orders/_shared/dispute-refund-guard";
import { reverseTransfersForItems } from "../orders/reverse-transfers-for-items";
import { buildRefundMetadata } from "../orders/_shared/dispute-refund-guard";
import {
  assertResaleOrderCanBeUnwound,
  unwindResaleOrderAfterRefund,
} from "./unwind-resale-order-after-refund";
import { claimantHoldsTicket } from "../_helpers/claimant-holds-ticket";
import { requireClaimDeskStaff } from "./claim-desk-staff";
import { notifyClaimResolved } from "./notify-resale-events";
import {
  notifyClaimRefunded,
  type ClaimRefundAmountSource,
} from "./notify-claim-refunded";
import { computeExpectedPaymentAmount } from "../../lib/orders/compute-expected-payment-amount";
import { fail as appFail } from "@th/errors";

// ── Schemas ────────────────────────────────────────────────────────────────

export const reviewClaimInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  claimId: z.string().uuid(),
  status: z.enum(["under_review", "approved", "denied"]),
  /**
   * Accepted for compatibility only: the status decides the resolution (an
   * approved claim is a full refund, a denied one refunds nothing). There is
   * no partial refund (owner ruling Q5, 2026-10-06).
   */
  resolution: z.literal("full_refund").optional(),
  /** Both parties see it and it may be emailed: sanitized like evidence. */
  resolutionNote: plainTextMultilineOptional(2000).optional(),
});

export const reviewClaimOutputSchema = z.object({
  claimId: z.string().uuid(),
  status: z.string(),
  resolution: z.string().nullable(),
});

export type ReviewClaimInput = z.infer<typeof reviewClaimInputSchema>;
export type ReviewClaimOutput = z.infer<typeof reviewClaimOutputSchema>;

export type ReviewClaimDeps = {
  repos: Repos;
  /** Claim-desk staff gate (`CLAIM_DESK_ROLES`) — checked before any read. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  /** Required when approving claims — triggers buyer refund via Stripe. */
  payments?: PaymentProcessorPort;
  mailer?: MailerPort;
  publicAppUrl?: string;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter for the refund-debit swallow branches
   * (missing pre-cutover credits, attribution drift). Wire from
   * `ctx.reportError`; a throwing reporter never changes behaviour.
   */
  reportError?: ReporterPort | null;
};

const IDEMPOTENCY_TTL_SECONDS = 300;

interface StoredReviewClaimRecord {
  response: ReviewClaimOutput;
}

interface ReviewClaimResult {
  claimId: string;
  status: string;
  resolution: string | null;
  _claimantId: string;
  _respondentId: string;
  _eventId: string;
  _orderId: string;
}

function isSucceededRefundStatus(status: PaymentRefundStatus): boolean {
  return status === "succeeded";
}

/**
 * Set when THIS approval's refund is known to have gone through (Stripe said
 * `succeeded`, or a retry found its own earlier refund committed), so the
 * buyer can be told. Null when the refund is still pending (the webhook tells
 * them), was refunded by another path, or no refund was issued.
 *
 * The amount shown is read from Stripe by the notifier (the claim's own
 * refund, so a part-refunded order shows the remainder); `fallbackCents` is
 * only for when Stripe cannot say.
 */
type ClaimRefundCompletion = {
  orderId: string;
  currency: string;
  amount: ClaimRefundAmountSource;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * Claim-desk staff (`CLAIM_DESK_ROLES`) reviews and transitions a claim.
 *
 * Valid transitions:
 *  - open → under_review
 *  - open | under_review → approved (full refund, blocks seller payout)
 *  - open | under_review → denied (no refund, unblocks seller payout)
 *
 * Staff may approve or deny at any time; nothing waits for the seller's reply
 * (owner ruling Q8, 2026-10-06).
 *
 * The staff gate runs first — before the idempotency `begin`, before any repo
 * read, before the payments port. `claims.review` is a bare `authedProcedure`
 * at the root router, so this line is the only thing between any signed-in
 * user and a Stripe refund.
 */
export async function reviewClaim(
  deps: ReviewClaimDeps,
  rawInput: unknown,
): Promise<ReviewClaimOutput> {
  const input = parseInput(reviewClaimInputSchema, rawInput);
  await requireClaimDeskStaff(deps, input.actorHumanId);
  const now = deps.clock.now();

  const execution =
    input.status === "approved"
      ? await reviewApprovedClaim(deps, input, now)
      : await reviewNonApprovedClaim(deps, input, now);

  deps.logger?.info("reviewClaim.succeeded", {
    claimId: execution.response.claimId,
    status: execution.response.status,
  });

  // Fire-and-forget: notify both parties on final resolution
  if (
    execution.notify &&
    deps.mailer &&
    deps.publicAppUrl &&
    (execution.notify.status === "approved" ||
      execution.notify.status === "denied")
  ) {
    const notice = execution.notify;
    const mailer = deps.mailer;
    const publicAppUrl = deps.publicAppUrl;
    notifyClaimResolved(
      {
        repos: deps.repos,
        mailer,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        claimId: notice.claimId,
        claimantId: notice.claimantId,
        respondentId: notice.respondentId,
        eventId: notice.eventId,
        status: notice.status,
        resolution: notice.resolution,
        publicAppUrl,
      },
    )
      .catch(() => {}) // swallow — already logged inside
      // After the approval notice, so the buyer's inbox reads in order:
      // "approved, a refund will be processed", then "it has gone through".
      // Sent at most once per claim across this path and the webhook
      // (notify-claim-refunded.ts); never throws.
      .then(async () => {
        if (notice.status !== "approved" || !notice.refunded) return;
        await notifyClaimRefunded(
          {
            repos: deps.repos,
            idempotency: deps.idempotency,
            mailer,
            publicAppUrl,
            payments: deps.payments ?? null,
            logger: deps.logger,
            reportError: deps.reportError,
          },
          {
            claimId: notice.claimId,
            claimantId: notice.claimantId,
            orderId: notice.refunded.orderId,
            eventId: notice.eventId,
            currency: notice.refunded.currency,
            amount: notice.refunded.amount,
          },
        );
      })
      .catch((err: unknown) => {
        // notifyClaimRefunded never throws by contract; anything that does
        // reach here is a bug in it and must be visible.
        try {
          deps.reportError?.(err, {
            tags: { useCase: "reviewClaim", step: "claimRefundedNotice" },
            extra: { claimId: notice.claimId },
          });
        } catch {
          // A throwing reporter never changes behaviour.
        }
      });
  }

  return execution.response;
}

async function reviewApprovedClaim(
  deps: ReviewClaimDeps,
  input: ReviewClaimInput,
  now: Date,
): Promise<{
  response: ReviewClaimOutput;
  notify?: {
    claimId: string;
    claimantId: string;
    respondentId: string;
    eventId: string;
    status: "approved";
    resolution: string | null;
    refunded: ClaimRefundCompletion | null;
  };
}> {
  // A row approved before partial refunds were removed (Q5) may carry
  // `partial_refund`; its resume must reuse the key it was approved under.
  // `approved` is terminal, so this unlocked read cannot go stale.
  const existing = await deps.repos.claims.getById(input.claimId);
  const idempotencyKey = buildReviewClaimApprovalIdempotencyKey(
    input.claimId,
    existing?.status === "approved" &&
      existing.resolution === LEGACY_PARTIAL_REFUND
      ? LEGACY_PARTIAL_REFUND
      : "full_refund",
  );
  const replay =
    await deps.idempotency.get<StoredReviewClaimRecord>(idempotencyKey);
  if (replay) {
    return {
      response: reviewClaimOutputSchema.parse(replay.response),
    };
  }

  // ── Dispute guard ────────────────────────────────────────────────────────
  // Approval refunds the resale order's charge. If that charge is under an
  // OPEN / UNDER_REVIEW / LOST dispute Stripe refuses the refund, so refuse
  // here with the typed code — after the replay lookup, BEFORE the claim is
  // transitioned and BEFORE the idempotency claim (a refusal is not an
  // attempt; it must not leave the record failed or the claim half-approved).
  await assertClaimOrderNotDisputeBlocked(deps, input.claimId);

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const afterWait =
      await deps.idempotency.get<StoredReviewClaimRecord>(idempotencyKey);
    if (afterWait) {
      return {
        response: reviewClaimOutputSchema.parse(afterWait.response),
      };
    }

    throw appFail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  let result: ReviewClaimResult;
  let response: ReviewClaimOutput;
  let refunded: ClaimRefundCompletion | null;
  try {
    result = await transitionClaim(deps, input, now, {
      allowApprovedResume: true,
    });

    refunded = await confirmApprovedClaimRefund(
      deps,
      result,
      now,
      idempotencyKey,
    );
  } catch (error) {
    // Release, not `fail`: a `failed` record locks the admin's same-key
    // retry out for 15 minutes (lib/idempotency-claim.ts). A same-key retry
    // is safe: it resumes the approved claim (`allowApprovedResume`) and
    // re-sends the stable `:reverse-transfer` / `:refund-payment-intent`
    // Stripe keys, so Stripe returns the earlier reversal/refund.
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "reviewClaim",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("review_claim", error);
  }

  // Everything below is outside the abandon path: the refund and its tx have
  // committed, so a throw here leaves the claim standing until its TTL
  // rather than freeing the key for a retry that would redo committed work.
  // The parse keeps the error shape callers saw when it ran inside the try.
  try {
    response = toReviewClaimOutput(result);
  } catch (error) {
    throw asKnownError("review_claim", error);
  }
  await deps.idempotency.commit<StoredReviewClaimRecord>(idempotencyKey, {
    response,
  });

  return {
    response,
    notify: {
      claimId: result.claimId,
      claimantId: result._claimantId,
      respondentId: result._respondentId,
      eventId: result._eventId,
      status: "approved",
      resolution: result.resolution,
      refunded,
    },
  };
}

async function reviewNonApprovedClaim(
  deps: ReviewClaimDeps,
  input: ReviewClaimInput,
  now: Date,
): Promise<{
  response: ReviewClaimOutput;
  notify?: {
    claimId: string;
    claimantId: string;
    respondentId: string;
    eventId: string;
    status: "denied";
    resolution: string | null;
  };
}> {
  const result = await transitionClaim(deps, input, now, {
    allowApprovedResume: false,
  });

  return {
    response: toReviewClaimOutput(result),
    notify:
      result.status === "denied"
        ? {
            claimId: result.claimId,
            claimantId: result._claimantId,
            respondentId: result._respondentId,
            eventId: result._eventId,
            status: "denied",
            resolution: result.resolution,
          }
        : undefined,
  };
}

async function transitionClaim(
  deps: ReviewClaimDeps,
  input: ReviewClaimInput,
  now: Date,
  options: { allowApprovedResume: boolean },
): Promise<ReviewClaimResult> {
  return deps.repos.tx(async (tx) => {
    // Every transition takes the order item's claim lock FIRST (before any
    // write) and decides on a re-read under it. Since staff may decide from
    // `open` (Q8), "start review", "approve" and "deny" all start from the
    // same status; without the lock two of them could both pass their checks
    // and the later write would overwrite the earlier decision (a review
    // landing on an approved, refunded claim; a deny overwritten and then
    // approved). The same lock createClaim and the ticket-move sites take.
    const unlocked = await tx.claims.getById(input.claimId);
    if (!unlocked) {
      throw appFail("CLAIM_NOT_FOUND");
    }
    await tx.claims.lockOrderItem(unlocked.orderItemId);
    const claim = await tx.claims.getById(input.claimId);
    if (!claim) {
      throw appFail("CLAIM_NOT_FOUND");
    }

    const resolution =
      input.status === "approved"
        ? ("full_refund" as const)
        : input.status === "denied"
          ? "denied"
          : undefined;

    if (claim.status === "approved") {
      if (
        input.status === "approved" &&
        options.allowApprovedResume &&
        isFullRefundResolution(claim.resolution)
      ) {
        return {
          claimId: claim.id,
          status: claim.status,
          resolution: claim.resolution,
          _claimantId: claim.claimantId,
          _respondentId: claim.respondentId,
          _eventId: claim.eventId,
          _orderId: claim.orderId,
        };
      }

      throw appFail("CLAIM_ALREADY_RESOLVED");
    }

    if (claim.status === "denied" || claim.status === "expired") {
      throw appFail("CLAIM_ALREADY_RESOLVED");
    }

    if (input.status === "under_review" && claim.status !== "open") {
      throw {
        code: "invalid_input",
        message: "Can only move to under_review from open",
      } as const;
    }

    // A claim filed before createClaim checked the holder can sit on a ticket
    // the buyer has since given away. Approving it would refund the buyer and
    // the unwind would take the ticket from whoever holds it now, so refuse
    // (owner ruling 2026-10-05); support denies it instead. Under the claim
    // lock taken above (the one the move sites and createClaim take); nothing
    // has been written yet,
    // so a refusal leaves the claim where it was (open or under_review) with
    // no refund. An order another path already refunded is exempt: approval
    // then takes the "refunded elsewhere" branch, which never unwinds the
    // ticket, and refusing would force a "denied" on a buyer who was refunded.
    if (input.status === "approved") {
      const order = await tx.orders.getById(claim.orderId);
      if (
        order?.status !== "REFUNDED" &&
        !(await claimantHoldsTicket(
          tx,
          claim.orderItemId,
          claim.claimantId,
        ))
      ) {
        throw appFail("CLAIM_APPROVAL_TICKET_NOT_HELD");
      }
    }

    // Conditional on the status read under the lock (belt and braces: a
    // writer that skipped the lock still cannot overwrite a decision).
    const updatedClaim = await tx.claims.updateStatus(input.claimId, {
      fromStatus: claim.status,
      status: input.status,
      resolvedById:
        input.status === "approved" || input.status === "denied"
          ? input.actorHumanId
          : undefined,
      resolutionNote: input.resolutionNote,
      resolution,
    });
    if (!updatedClaim) {
      throw appFail("CLAIM_ALREADY_RESOLVED");
    }

    await tx.audit.log({
      entity: "claim",
      entityId: claim.id,
      action: `reviewed_${input.status}`,
      data: {
        claimId: claim.id,
        previousStatus: claim.status,
        newStatus: input.status,
        resolution,
        reviewedBy: input.actorHumanId,
        resolutionNote: input.resolutionNote,
      },
      at: now,
    });

    // NOTE deliberately NO refund debit here (Step C review, BLOCKING): this
    // tx commits whether or not the Stripe refund later succeeds. A debit
    // written now would survive every failure arm of
    // confirmApprovedClaimRefund (payments unwired, missing payment intent,
    // refund throw, Stripe `failed`/`canceled`) — permanently docking the
    // seller with the buyer unrefunded. The debit is written in
    // confirmApprovedClaimRefund's success tx, atomically with markRefunded;
    // the pending/requires_action arm is finalized by the
    // charge.refund.updated webhook, whose reconcile pass debits under the
    // Stripe refund id.

    return {
      claimId: updatedClaim.id,
      status: updatedClaim.status,
      resolution: updatedClaim.resolution,
      _claimantId: claim.claimantId,
      _respondentId: claim.respondentId,
      _eventId: claim.eventId,
      _orderId: claim.orderId,
    };
  });
}

/**
 * Pre-flight for {@link reviewApprovedClaim}: only when a refund would be
 * issued (payments wired, claim + paid order present) — a missing claim or
 * order falls through to the existing not-found / no-payment-intent paths.
 */
async function assertClaimOrderNotDisputeBlocked(
  deps: ReviewClaimDeps,
  claimId: string,
): Promise<void> {
  if (!deps.payments) return;
  const claim = await deps.repos.claims.getById(claimId);
  if (!claim?.orderId) return;
  const order = await deps.repos.orders.getById(claim.orderId);
  if (!order?.stripePaymentIntentId) return;
  assertOrderNotDisputeBlocked(order);
}

async function confirmApprovedClaimRefund(
  deps: ReviewClaimDeps,
  result: ReviewClaimResult,
  now: Date,
  idempotencyKey: string,
): Promise<ClaimRefundCompletion | null> {
  const payments = deps.payments;
  if (!payments) {
    return null;
  }

  // Per-order refund mutex on the RESALE order being refunded: a concurrent
  // buyer/staff refund on the same order conflicts (same `refund-op:` key
  // namespace as every other refund-creating path) and the conflict rides the
  // outer reviewApprovedClaim catch — the claim's own idempotency record is
  // released and the admin retries (allowApprovedResume). The mutex spans the
  // unwind pre-flight, the transfer reversal, the Stripe refund AND the
  // mark-refunded tx below; the order is loaded INSIDE the held section so
  // the paid-out classification and the unwind pre-flight can't act on a
  // snapshot taken before a competing refund's commit.
  // See ../orders/_shared/refund-mutex.ts.
  return withOrderRefundMutex(deps, result._orderId, () =>
    executeApprovedClaimRefund(deps, payments, result, now, idempotencyKey),
  );
}

/**
 * The approved-claim refund body; runs while holding the per-order refund
 * mutex. Returns what the buyer got back when this claim's refund is known to
 * have gone through (see {@link ClaimRefundCompletion}).
 */
async function executeApprovedClaimRefund(
  deps: ReviewClaimDeps,
  payments: PaymentProcessorPort,
  result: ReviewClaimResult,
  now: Date,
  idempotencyKey: string,
): Promise<ClaimRefundCompletion | null> {
  const order = await deps.repos.orders.getById(result._orderId);
  if (!order?.stripePaymentIntentId) {
    // Deliberate degrade that MUST be visible (CLAUDE.md error convention —
    // `logger.warn` is not captured): the claim is approved but no refund
    // can be issued, so the order never reaches REFUNDED and the payee
    // ledger keeps the order's credits FROZEN (the approved-claim arm of
    // CREDIT_NOT_BLOCKED_SQL) until someone refunds the buyer by hand.
    const err = new Error("review_claim_approved_without_payment_intent");
    deps.logger?.error("reviewClaim.no_payment_intent", {
      claimId: result.claimId,
      orderId: result._orderId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "reviewClaim", reason: "no_payment_intent" },
        extra: { claimId: result.claimId, orderId: result._orderId },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return null;
  }
  const stripePaymentIntentId = order.stripePaymentIntentId;
  // Last resort only: the notifier reads the claim refund's own amount from
  // Stripe. A full-PaymentIntent refund returns what is left of the charge.
  const completionFor = (refundId: string | null): ClaimRefundCompletion => ({
    orderId: order.id,
    currency: order.currency,
    amount: {
      refundId,
      paymentIntentId: stripePaymentIntentId,
      fallbackCents: computeExpectedPaymentAmount(order),
    },
  });

  // ── Unwind pre-flight: BEFORE any money moves ───────────────────────────
  // Same guard as refund-full-order's RESALE branch: every ticket item must
  // resolve to its listing and its ticket, or the refund is refused before
  // Stripe is touched (a refund we cannot unwind would leave the claimant
  // holding both the money and a live ticket — the exact bug this closes).
  // `allowAlreadyUnwound: true` (the reconcile-webhook setting, NOT
  // refund-full-order's strict default) because this path is RESUMABLE:
  // a retry after a crash between the success tx's commit and the
  // idempotency commit, or after the charge.refunded webhook reconciled
  // (and unwound) the order first, finds the ticket already back on the
  // seller's original item. A strict guard would refuse that retry forever
  // with TICKET_NOT_FOUND while the claim sits approved. The already-unwound
  // proof is structural (listing no longer SOLD to this order, ticket owned
  // by the seller on a different item), so a corrupt order — ticket missing
  // while the listing is still SOLD here — is still refused.
  await assertResaleOrderCanBeUnwound(deps.repos, order, {
    allowAlreadyUnwound: true,
  });

  // Items this approval refunds: the order's live ticket items. Already
  // refunded/transferred ones keep their state (same skip set as the
  // reconcile pass). Paid-out ones need their transfer reversed FIRST.
  const refundableItems = order.items.filter(
    (item) =>
      item.kind === "ticket" &&
      item.status !== "refunded" &&
      !item.refundedAt &&
      item.status !== "transferred" &&
      !item.transferredAt,
  );
  const requiresReversal = refundableItems.filter((item) =>
    Boolean(item.paidOutAt),
  );

  // ── Reverse transfers for paid-out items (BEFORE the buyer refund) ──────
  // refund-full-order's rule: the seller's money must be back before the
  // platform pays the buyer. RESALE credits are now held until the claim
  // window closes (credit-time floor in `createCreditsFromOrder`, re-checked
  // against the event's CURRENT end in the ledger's payable SQL) and frozen
  // by an open or approved-but-unrefunded claim, so a paid-out seller should
  // only appear for credits minted before those gates existed (their
  // `availableAt` is not retroactive) or for a payout that raced a claim
  // filed in its final instant. This branch stays load-bearing for those:
  // without it the seller's balance went negative and the platform fronted
  // the refund. A reversal failure throws
  // (dependency_failed via callOrDependencyFailed) and NO Stripe refund is
  // issued; the approval record is released and the admin retries. No
  // `itemAmounts`: the refund is full-PI (no amount computed here), so the
  // pre-cutover junction arm reverses the full settlement line and the
  // ledger arm derives the payee-side attribution itself.
  let reversalResults: Awaited<ReturnType<typeof reverseTransfersForItems>> =
    [];
  if (requiresReversal.length > 0) {
    reversalResults = await reverseTransfersForItems(
      {
        repos: deps.repos,
        payments,
        logger: deps.logger,
        reportError: deps.reportError,
      },
      {
        orderItemIds: requiresReversal.map((item) => item.id),
        idempotencyKeyPrefix: `${idempotencyKey}:reverse-transfer`,
      },
    );
  }

  // ── Refund the original payment intent ──────────────────────────────────
  // The Stripe call is idempotent on `${idempotencyKey}:refund-payment-intent`,
  // so safe to re-attempt on retry. We treat the call in three buckets:
  //   - succeeded → mark order refunded below.
  //   - pending / requires_action → Stripe accepted; the refund will
  //     complete asynchronously and the refund-updated webhook will
  //     reconcile `markRefunded`. Don't mark refunded yet, but the claim
  //     review itself is complete — UNLESS a transfer reversal ran (below).
  //   - failed / canceled OR thrown SDK error → real failure. Throw so
  //     the outer try/catch releases the idempotency lock; the admin sees a
  //     real error, and a retry (allowApprovedResume: true) re-enters
  //     the refund call against the same Stripe idempotency key — which
  //     either picks up the result of a now-succeeded refund or surfaces
  //     the underlying error again so it can't be silently lost.
  // ── Already REFUNDED: the refund is out — never call Stripe for it again ─
  // Read inside the per-order refund mutex. A REFUNDED order means one of:
  //   - this claim's own success tx committed (only its client saw an
  //     error, so the claim was released) — it wrote REFUND_DEBITs keyed on
  //     the claim id (`refundKey: result.claimId` below);
  //   - the charge.refunded reconciler landed OUR refund first, or another
  //     path (refund-full-order's RESALE branch, cancel-event) refunded the
  //     buyer — debits keyed on a Stripe refund id, not on this claim.
  // Re-sending `:refund-payment-intent` would be wrong: the committed /
  // reconciled items have left `refundableItems`, so the request would
  // carry DIFFERENT metadata under the same key — Stripe answers
  // `idempotency_error` and the retry is stuck for good. So no Stripe
  // refund call; the claim completes. Behaviour is the same for every
  // cause; the audit row and log name which one it was.
  //
  // The reversal replay above still runs (it is how an executed reversal
  // gets credited after a reconcile won the race inside one attempt). What
  // it cannot cover: the reconciler flips the paid-out items to `refunded`,
  // so on a LATER attempt they are out of `requiresReversal`, no replay
  // runs, and a reversal an earlier attempt executed is never credited —
  // the seller docked twice. That is checked below and reported at error
  // (recovery — replaying reversals over refunded paid-out items — is a
  // follow-up, not built). The claim still COMPLETES in that case: the
  // buyer is refunded, a retry moves no money and cannot repair the
  // ledger, so failing it would only strand the admin on an error they
  // cannot act on while the report is what reaches someone who can.
  if (order.status === "REFUNDED") {
    const payeeReversals = await resolvePayeeReversals(
      deps,
      order.id,
      reversalResults,
    );
    const paidOutItemIds = order.items
      .filter((item) => item.kind === "ticket" && Boolean(item.paidOutAt))
      .map((item) => item.id);
    const resume = await deps.repos.tx(async (tx) => {
      const freshOrder = await tx.orders.getById(result._orderId);
      if (!freshOrder) {
        throw appFail("ORDER_NOT_FOUND");
      }
      await creditReversalsOnRefundedOrder(
        tx,
        deps,
        result,
        freshOrder,
        payeeReversals,
      );
      const entries = await tx.payeeLedger.listOrderEntries(order.id);
      const claimDebitPrefix = `refund-debit:${order.id}:`;
      const claimDebitSuffix = `:${result.claimId}`;
      const refundedBy = entries.some(
        (entry) =>
          entry.type === "REFUND_DEBIT" &&
          entry.idempotencyKey.startsWith(claimDebitPrefix) &&
          entry.idempotencyKey.endsWith(claimDebitSuffix),
      )
        ? ("claim_tx" as const)
        : ("elsewhere" as const);
      const reversalCreditUnverified =
        paidOutItemIds.length > 0 &&
        !entries.some((entry) => entry.type === "TRANSFER_REVERSAL_CREDIT");
      await tx.audit.log({
        entity: "order",
        entityId: result._orderId,
        action: "refund_confirmed_on_resume",
        data: {
          claimId: result.claimId,
          refundedBy,
          paidOutItemIds,
          reversalCreditUnverified,
          transferReversals:
            reversalResults.length > 0 ? reversalResults : undefined,
        },
        at: now,
      });
      return { refundedBy, reversalCreditUnverified };
    });

    deps.logger?.info(
      resume.refundedBy === "claim_tx"
        ? "reviewClaim.refund_already_committed_by_claim"
        : "reviewClaim.refund_already_refunded_elsewhere",
      {
        claimId: result.claimId,
        orderId: result._orderId,
        transferReversals: reversalResults.length,
      },
    );
    if (resume.reversalCreditUnverified) {
      const err = new Error("review_claim_reversal_credit_unverified_on_resume");
      deps.logger?.error("reviewClaim.reversal_credit_unverified_on_resume", {
        claimId: result.claimId,
        orderId: result._orderId,
        paidOutItemIds,
        refundedBy: resume.refundedBy,
        err,
      });
      try {
        deps.reportError?.(err, {
          tags: {
            useCase: "reviewClaim",
            stage: "reversal_credit_unverified_on_resume",
          },
          extra: {
            claimId: result.claimId,
            orderId: result._orderId,
            paidOutItemIds,
          },
        });
      } catch {
        // A throwing reporter never changes behaviour.
      }
    }
    // Our own earlier attempt committed the refund (its client only saw an
    // error): the buyer may never have been told, so tell them now (at most
    // once). "elsewhere" is the webhook (which tells them itself) or another
    // refund path (which has its own notice).
    return resume.refundedBy === "claim_tx" ? completionFor(null) : null;
  }

  let refund: { refundId: string; status: PaymentRefundStatus };
  try {
    refund = await payments.refundPaymentIntent({
      paymentIntentId: stripePaymentIntentId,
      // Support upholding a buyer's claim refunds at the buyer's request.
      // Stripe accepts only duplicate / fraudulent / requested_by_customer;
      // the "other" sent here before was rejected, so no claim ever refunded.
      reason: "requested_by_customer",
      idempotencyKey: `${idempotencyKey}:refund-payment-intent`,
      // Money audit 2026-09-08 #10: the refund names its items so the
      // charge.refunded reconciler can recover a refund whose tx died.
      metadata: buildRefundMetadata({
        useCase: "reviewClaim",
        orderId: order.id,
        orderItemIds: refundableItems.map((item) => item.id),
        logger: deps.logger,
      }),
    });
  } catch (err) {
    deps.logger?.error("reviewClaim.refund_failed", {
      claimId: result.claimId,
      orderId: result._orderId,
      error: err instanceof Error ? err.message : String(err),
    });
    return appFail("REFUND_FAILED", { cause: err });
  }

  if (refund.status === "failed" || refund.status === "canceled") {
    deps.logger?.error("reviewClaim.refund_rejected", {
      claimId: result.claimId,
      orderId: result._orderId,
      refundId: refund.refundId,
      refundStatus: refund.status,
      paymentIntentId: stripePaymentIntentId,
    });
    return appFail("REFUND_REJECTED");
  }

  if (!isSucceededRefundStatus(refund.status)) {
    if (reversalResults.length > 0) {
      // A reversal already pulled the seller's money back, and the pending
      // arm hands finalisation to the charge.refunded webhook — whose
      // reconcile pass writes the REFUND_DEBIT but knows nothing about
      // this reversal, so it would never write the TRANSFER_REVERSAL_CREDIT:
      // the seller docked once by the debit and once by the reversal. Not
      // "done": fail the approval record (retryable) so the admin retries;
      // the retry replays the reversal and the refund under their stable
      // keys and, once the refund reads succeeded, writes debit + credit
      // together in the tx below (or credits against the webhook's debit
      // if the webhook got there first — see the REFUNDED arm).
      deps.logger?.error("reviewClaim.refund_pending_after_transfer_reversal", {
        claimId: result.claimId,
        orderId: result._orderId,
        refundId: refund.refundId,
        refundStatus: refund.status,
        reversalIds: reversalResults.map((r) => r.reversalId),
      });
      return appFail("TRANSIENT", {
        message: "refund_not_terminal_after_transfer_reversal",
        meta: {
          claimId: result.claimId,
          orderId: result._orderId,
          refundId: refund.refundId,
          refundStatus: refund.status,
        },
      });
    }
    // pending / requires_action — Stripe accepted; webhook will finalize
    // (and tell the buyer once it does).
    deps.logger?.info("reviewClaim.refund_pending", {
      claimId: result.claimId,
      orderId: result._orderId,
      refundId: refund.refundId,
      refundStatus: refund.status,
      paymentIntentId: stripePaymentIntentId,
    });
    return null;
  }

  // Map each successful PRE-CUTOVER reversal's settlement → payee so the
  // ledger's TRANSFER_REVERSAL_CREDIT can be attributed inside the tx
  // below. Read OUTSIDE the tx (pure lookup, no mutation). Ledger-era
  // reversals carry `payeeId` directly (settlementId null) and need no
  // lookup. Same shape as refund-full-order.
  const payeeReversals = await resolvePayeeReversals(
    deps,
    order.id,
    reversalResults,
  );

  await deps.repos.tx(async (tx) => {
    const freshOrder = await tx.orders.getById(result._orderId);
    if (!freshOrder) {
      throw appFail("ORDER_NOT_FOUND");
    }

    if (freshOrder.status === "REFUNDED") {
      await creditReversalsOnRefundedOrder(
        tx,
        deps,
        result,
        freshOrder,
        payeeReversals,
      );
      return;
    }

    // ── Unwind the resale order (what refund-full-order's RESALE branch does)
    // Mark the resale item(s) refunded — 3-arg form: this path refunds the
    // full PaymentIntent without computing per-item amounts, so there is no
    // tax attribution to record (column stays NULL = "not attributed", not
    // a measured zero).
    for (const item of refundableItems) {
      await tx.orderItems.updateStatus(item.id, "refunded", now);
    }

    await tx.orders.markRefunded(result._orderId);

    // Return the ticket to the seller (rotated code — the claimant's QR is
    // dead), restore the seller's original order item, and CANCEL the
    // listing: an approved claim means the buyer proved the ticket was no
    // good for them (invalid / entry denied / wrong seat), so relisting it
    // to a third party is exactly wrong. Same disposition cancel-event uses.
    await unwindResaleOrderAfterRefund(tx, {
      order: freshOrder,
      clock: deps.clock,
      logger: deps.logger,
      listingDisposition: "cancel",
      reportError: deps.reportError,
    });

    // ── The one refund rule (spec §4): debit atomically with the refund ────
    // Written HERE — in the tx that marks the order refunded, gated behind
    // isSucceededRefundStatus — NOT at claim approval (Step C review,
    // BLOCKING: a debit at approval survives refund failure). Keyed on the
    // CLAIM id (stable across retries); the eventual charge.refunded
    // webhook's reconcile pass debits under the Stripe refund id and nets to
    // zero via Σ-prior-debits arithmetic. The refund is full-PI
    // (refundPaymentIntent is called with no amount), so full-refund math
    // applies.
    const refundDebits = await writeRefundDebitsForOrder(tx, {
      order: { id: freshOrder.id, currency: freshOrder.currency },
      refundedItemIds: (freshOrder.items ?? [])
        .filter((item) => item.kind === "ticket")
        .map((item) => item.id),
      refundKey: result.claimId,
      attemptedFullRefund: true,
      useCase: "reviewClaim",
      logger: deps.logger,
      reportError: deps.reportError,
    });
    deps.logger?.info("reviewClaim.refund_debits_written", {
      claimId: result.claimId,
      orderId: result._orderId,
      refundDebits,
    });

    // Spec §4.2: reversal SUCCEEDED (we're past reverseTransfersForItems)
    // → the money came back externally, so credit it back against the
    // debit; net zero. On reversal FAILURE we never get here.
    const reversalCredits = await writeTransferReversalCreditsForOrder(tx, {
      order: { id: freshOrder.id, currency: freshOrder.currency },
      refundKey: result.claimId,
      reversals: payeeReversals,
      debits: refundDebits,
      useCase: "reviewClaim",
      logger: deps.logger,
      reportError: deps.reportError,
    });

    await tx.audit.log({
      entity: "order",
      entityId: result._orderId,
      action: "refund_confirmed",
      data: {
        claimId: result.claimId,
        refundId: refund.refundId,
        refundStatus: refund.status,
        paymentIntentId: stripePaymentIntentId,
        refundedItemIds: refundableItems.map((item) => item.id),
        listingDisposition: "cancel",
        transferReversals:
          reversalResults.length > 0 ? reversalResults : undefined,
        ledgerRefundDebits: refundDebits,
        ledgerReversalCredits:
          reversalCredits.length > 0 ? reversalCredits : undefined,
      },
      at: now,
    });
  });

  deps.logger?.info("reviewClaim.refund_issued", {
    claimId: result.claimId,
    orderId: result._orderId,
    refundId: refund.refundId,
    refundStatus: refund.status,
    paymentIntentId: stripePaymentIntentId,
    transferReversals: reversalResults.length,
  });
  // Stripe says succeeded: the refund is done, whether this tx or a webhook
  // that got in first marked the order REFUNDED.
  return completionFor(refund.refundId);
}

/** Map each reversal to its payee (pre-cutover ones via their settlement). */
async function resolvePayeeReversals(
  deps: ReviewClaimDeps,
  orderId: string,
  reversalResults: Awaited<ReturnType<typeof reverseTransfersForItems>>,
): Promise<ReturnType<typeof groupReversalsByPayee>> {
  let reversalPayeeBySettlementId = new Map<string, string>();
  if (reversalResults.length > 0) {
    const settlementIds = [
      ...new Set(
        reversalResults
          .map((r) => r.settlementId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (settlementIds.length > 0) {
      const reversedSettlements =
        await deps.repos.settlements.getByIds(settlementIds);
      reversalPayeeBySettlementId = new Map(
        reversedSettlements.map((s) => [s.id, s.payeeId]),
      );
    }
  }
  return groupReversalsByPayee(reversalResults, reversalPayeeBySettlementId, {
    useCase: "reviewClaim",
    orderId,
    logger: deps.logger,
    reportError: deps.reportError,
  });
}

/**
 * The order is already REFUNDED (our committed tx, the reconciler, or another
 * path): no unwind, no debit, no second markRefunded.
 */
async function creditReversalsOnRefundedOrder(
  tx: Parameters<Parameters<Repos["tx"]>[0]>[0],
  deps: ReviewClaimDeps,
  result: ReviewClaimResult,
  freshOrder: { id: string; currency: string },
  payeeReversals: ReturnType<typeof groupReversalsByPayee>,
): Promise<void> {
  // Already refunded — e.g. the charge.refunded webhook's reconcile pass
  // got here first, which also unwound the resale order and wrote the
  // debits. Nothing to unwind or debit — but a reversal THIS call
  // executed still has to be credited, or the seller who physically
  // returned the money stays docked by the webhook's debit. The credit
  // writer pairs across keys (headroom = Σ debits − Σ prior credits on
  // the cell), so no debit of our own is needed.
  if (payeeReversals.length > 0) {
    const reversalCredits = await writeTransferReversalCreditsForOrder(
      tx,
      {
        order: { id: freshOrder.id, currency: freshOrder.currency },
        refundKey: result.claimId,
        reversals: payeeReversals,
        debits: [],
        useCase: "reviewClaim",
        logger: deps.logger,
        reportError: deps.reportError,
      },
    );
    deps.logger?.info("reviewClaim.reversal_credited_after_reconcile", {
      claimId: result.claimId,
      orderId: result._orderId,
      reversalCredits,
    });
  }
}

function toReviewClaimOutput(result: ReviewClaimResult): ReviewClaimOutput {
  return reviewClaimOutputSchema.parse({
    claimId: result.claimId,
    status: result.status,
    resolution: result.resolution ?? null,
  });
}

/**
 * Stored on claims approved before partial refunds were removed (owner ruling
 * Q5, 2026-10-06). Never written now, but such a row is still resumable: the
 * money path always refunded the whole payment intent, so it IS a full
 * refund, under the key it was first approved with.
 */
const LEGACY_PARTIAL_REFUND = "partial_refund";

/** An approved claim's stored resolution that the resume path accepts. */
function isFullRefundResolution(resolution: string | null): boolean {
  return resolution === "full_refund" || resolution === LEGACY_PARTIAL_REFUND;
}

// The key text must not change: an in-flight approval's retry, and the
// derived `:reverse-transfer` / `:refund-payment-intent` Stripe keys, hang
// off it. New approvals always use "full_refund"; a legacy partial_refund
// row resumes under the key the old code built from that resolution.
function buildReviewClaimApprovalIdempotencyKey(
  claimId: string,
  resolution: "full_refund" | typeof LEGACY_PARTIAL_REFUND,
): string {
  return `claim:review:${claimId}:approved:${resolution}`;
}
