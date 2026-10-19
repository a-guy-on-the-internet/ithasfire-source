import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  PayoutLineConfirmationStatus,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";

import { parseInput } from "../../lib/io";
import { fail } from "@th/errors";

export const confirmPayoutLineInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    payoutTermsLineId: z.string().uuid(),
    decision: z.enum(["CONFIRM", "COUNTER", "DECLINE"]),
    /**
     * The line's economics as the client displayed them. Every decision is
     * an answer to THESE terms: under the terms lock they must still be the
     * stored ones, or the decision is refused (CONFLICT
     * `answered_terms_changed`). Storage units: whole percent, cents.
     */
    answered: z
      .object({
        percent: z.number().int().min(0).max(100),
        floorCents: z.number().int().min(0),
        capPercent: z.number().int().min(0).max(100).nullable(),
      })
      .strict(),
    /** COUNTER only — the payee's proposed share, in basis points. */
    counterPercentBps: z.number().int().min(0).max(10000).optional(),
    /** COUNTER only — required context for the ask, shared with the parties. */
    counterNote: z.string().trim().min(10).max(2000).optional(),
  })
  .strict();

export const confirmPayoutLineOutputSchema = z
  .object({
    lineId: z.string().uuid(),
    confirmationStatus: z.enum([
      "PENDING",
      "CONFIRMED",
      "COUNTERED",
      "DECLINED",
    ]),
    confirmedAt: z.date().nullable(),
  })
  .strict();

export type ConfirmPayoutLineInput = z.infer<
  typeof confirmPayoutLineInputSchema
>;
export type ConfirmPayoutLineOutput = z.infer<
  typeof confirmPayoutLineOutputSchema
>;

export type ConfirmPayoutLineDeps = {
  repos: Pick<
    Repos,
    "tx" | "payoutTerms" | "payees" | "agreements" | "authz" | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

const AUDIT_ACTIONS = {
  CONFIRM: "payout_line_confirmed",
  COUNTER: "payout_line_countered",
  DECLINE: "payout_line_declined",
} as const;

/**
 * Write-time CAS guards, per decision. The status pre-checks below are
 * friendly fast-fails on a snapshot read; THESE are authoritative — the
 * adapter pins the stored status to this list in the UPDATE's WHERE, so a
 * decision racing a concurrent transition (e.g. a stale COUNTER landing
 * after another actor's CONFIRM + agreement finalize, or a stale CONFIRM
 * over a committed DECLINE) loses with
 * `{ code: "conflict", message: "payout_line_confirmation_changed" }`.
 *
 * `null` mirrors the pre-check's legacy mapping (null ⇒ PENDING): legacy /
 * seed rows with no status yet are decidable exactly like PENDING rows, so
 * every decision's guard includes null.
 */
const EXPECTED_FROM: Record<
  ConfirmPayoutLineInput["decision"],
  readonly (PayoutLineConfirmationStatus | null)[]
> = {
  // CONFIRMED included for the documented idempotent re-confirm.
  CONFIRM: ["PENDING", "COUNTERED", "CONFIRMED", null],
  COUNTER: ["PENDING", "COUNTERED", null],
  DECLINE: ["PENDING", "COUNTERED", null],
};

/**
 * Payee-side action handler for a payout line's confirmation lifecycle.
 *
 * Per-line state machine (an economics edit on the line resets everything
 * back to PENDING with cleared counter fields — see the booking-agreement
 * line editor):
 *
 * - CONFIRM: from PENDING or COUNTERED (accepting the original terms
 *   supersedes one's own counter, so counter fields are cleared), and
 *   idempotently from CONFIRMED (re-stamps `confirmedAt`). Rejected from
 *   DECLINED — a decline is terminal for the current line version.
 * - COUNTER: from PENDING, or from COUNTERED to update one's own ask
 *   (negotiation is iterative; the parties only ever see the latest ask).
 *   Requires BOTH `counterPercentBps` and `counterNote`. Counters are an
 *   ask only — they never mutate the line's actual percent; a party applies
 *   them via the DRAFT line editor.
 * - DECLINE: from PENDING or COUNTERED. Terminal for this line version;
 *   counter fields are cleared (the decline supersedes any open ask).
 *
 * CONFIRM is deliberately permissive about payout-readiness: it stamps
 * confirmedAt without requiring `payee.payoutsEnabled = true`, because
 * confirmation is an informational ack, not a payout-readiness check.
 * Connect-active is enforced separately by the publish gate
 * (`assertEventPublishable`) and the booking-agreement finalize gate.
 *
 * Post-finalize fence: when the line's terms belong to a booking Agreement
 * that has been finalized onto an event (`Agreement.eventId` set), ALL
 * decisions are rejected with `agreement_finalized` — finalize already
 * required every requiresConfirmation line to be CONFIRMED, so any decision
 * after that point is meaningless at best and a settlement-integrity risk at
 * worst. (Lines on an event's own terms are not fenced by this; lines on a
 * default row are refused by the default fence below.)
 *
 * Default fence: a default terms row (`isDefault`) is a template copied
 * into every new event, so an answer on it would ride into deals its payee
 * never saw. Every decision on a default row is refused with
 * AGREEMENT_NOT_EDITABLE (`default_terms_are_a_template`), checked under the
 * terms lock — `answerDealClause`'s rule.
 *
 * Answer what you saw: `input.answered` carries the economics the client
 * displayed. Under the terms lock they must equal the stored line, so an
 * edit that kept the line id at a new share (reset to PENDING) cannot
 * collect a CONFIRM given to the old share.
 *
 * Auth: the actor must own the line's Payee — i.e. be the human (for
 * HUMAN-subject Payees) or an admin of the org (for ORGANIZATION-subject
 * Payees). Co-admins on personal Payees are NOT allowed; acknowledgement
 * is personal.
 */
export async function confirmPayoutLine(
  deps: ConfirmPayoutLineDeps,
  rawInput: unknown,
): Promise<ConfirmPayoutLineOutput> {
  const input = parseInput(confirmPayoutLineInputSchema, rawInput);

  // COUNTER carries a mandatory ask + note; surface the gap as input
  // validation, not a conflict.
  if (
    input.decision === "COUNTER" &&
    (input.counterPercentBps === undefined || input.counterNote === undefined)
  ) {
    throw fail("COUNTER_FIELDS_REQUIRED");
  }

  const line = await deps.repos.payoutTerms.getLineById(
    input.payoutTermsLineId,
  );
  if (!line) {
    throw fail("PAYOUT_LINE_NOT_FOUND");
  }

  const payee = await deps.repos.payees.getById(line.payeeId);
  if (!payee) {
    // Orphan line — should never happen with proper FKs, but treat as not_found
    // rather than 500 so the API doesn't leak internals.
    throw fail("PAYEE_NOT_FOUND");
  }

  // Auth: actor must be the line's payee (human) or admin of the payee's org.
  if (payee.subjectType === "HUMAN") {
    if (payee.subjectId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "payee" } });
    }
  } else {
    // ORGANIZATION subject — actor must be an admin/owner of that org.
    const memberships = await deps.repos.authz.getOrgMemberships({
      orgIds: [payee.subjectId],
      humanId: input.actorHumanId,
    });
    const isAdmin = memberships.some(
      (m) => m.role === "OWNER" || m.role === "ADMIN",
    );
    if (!isAdmin) {
      throw fail("INSUFFICIENT_ROLE");
    }
  }

  // Owner lines don't need confirmation; reject the call rather than
  // silently no-op so client bugs surface loudly.
  if (!line.requiresConfirmation) {
    throw fail("LINE_DOES_NOT_REQUIRE_CONFIRMATION");
  }

  // Legacy/seed rows may carry a null status on a requiresConfirmation line;
  // treat that as PENDING (the editor writes PENDING for new lines).
  const currentStatus = line.confirmationStatus ?? "PENDING";

  if (input.decision === "CONFIRM" && currentStatus === "DECLINED") {
    throw fail("LINE_DECLINED");
  }
  if (
    input.decision === "COUNTER" &&
    currentStatus !== "PENDING" &&
    currentStatus !== "COUNTERED"
  ) {
    throw fail("LINE_NOT_COUNTERABLE");
  }
  if (
    input.decision === "DECLINE" &&
    currentStatus !== "PENDING" &&
    currentStatus !== "COUNTERED"
  ) {
    throw fail("LINE_NOT_DECLINABLE");
  }

  const now = deps.clock.now();

  const write =
    input.decision === "CONFIRM"
      ? ({
          confirmationStatus: "CONFIRMED",
          confirmedAt: now,
          counterPercentBps: null,
          counterNote: null,
        } as const)
      : input.decision === "COUNTER"
        ? ({
            confirmationStatus: "COUNTERED",
            confirmedAt: null,
            counterPercentBps: input.counterPercentBps as number,
            counterNote: input.counterNote as string,
          } as const)
        : ({
            confirmationStatus: "DECLINED",
            confirmedAt: null,
            counterPercentBps: null,
            counterNote: null,
          } as const);

  const updated = await deps.repos.tx(async (tx) => {
    // ── P4b (deal terms) ── the terms row lock first (review B1, round 2):
    // every writer of PayoutTermsLine takes it. Under it, the line must
    // still be the one the payee decided on — same payee, and exactly the
    // economics the client displayed. A deal write or line edit that
    // committed after the client rendered the line (and so reset it to
    // PENDING at a NEW share) would otherwise let this CONFIRM land on a
    // share the payee never saw.
    if (!(await tx.deals.lockTerms(line.payoutTermsId))) {
      throw fail("PAYOUT_LINE_NOT_FOUND");
    }
    // A default is a template: an answer on it would be copied into every
    // event made from it (see doc comment).
    const terms = await tx.payoutTerms.getById(line.payoutTermsId);
    if (!terms) {
      throw fail("PAYOUT_LINE_NOT_FOUND");
    }
    if (terms.isDefault) {
      throw fail("AGREEMENT_NOT_EDITABLE", {
        meta: { reason: "default_terms_are_a_template" },
      });
    }
    const current = await tx.payoutTerms.getLineById(input.payoutTermsLineId);
    if (!current || current.payeeId !== line.payeeId) {
      throw {
        code: "conflict",
        message: "payout_line_confirmation_changed",
      } as const;
    }
    if (!answeredMatches(input.answered, current)) {
      throw fail("CONFLICT", { meta: { reason: "answered_terms_changed" } });
    }

    // Post-finalize fence (see doc comment): once the owning booking
    // Agreement is stamped onto an event, the line's confirmation state is
    // settled. Read inside the transaction so a finalize committing between
    // the snapshot reads above and this write is still seen (belt and
    // braces — the write-time CAS below is the authoritative race guard).
    const agreement = await tx.agreements.getByPayoutTermsId(
      line.payoutTermsId,
    );
    if (agreement && agreement.eventId !== null) {
      throw fail("AGREEMENT_FINALIZED");
    }

    const next = await tx.payoutTerms.updateLineConfirmation({
      lineId: input.payoutTermsLineId,
      expectedFrom: EXPECTED_FROM[input.decision],
      ...write,
    });

    await tx.audit.log({
      entity: "payout_terms_line",
      entityId: input.payoutTermsLineId,
      action: AUDIT_ACTIONS[input.decision],
      data: {
        payoutTermsId: line.payoutTermsId,
        payeeId: line.payeeId,
        actorHumanId: input.actorHumanId,
        previousStatus: currentStatus,
        ...(input.decision === "COUNTER"
          ? {
              counterPercentBps: input.counterPercentBps,
              counterNote: input.counterNote,
            }
          : {}),
      },
      at: now,
    });

    return next;
  });

  deps.logger?.info("payout_terms.confirm_line", {
    lineId: input.payoutTermsLineId,
    payoutTermsId: line.payoutTermsId,
    decision: input.decision,
    actorHumanId: input.actorHumanId,
  });

  return confirmPayoutLineOutputSchema.parse({
    lineId: updated.id,
    confirmationStatus: updated.confirmationStatus ?? write.confirmationStatus,
    confirmedAt: updated.confirmedAt,
  });
}

/** The economics the payee was shown are the economics stored now. */
function answeredMatches(
  answered: ConfirmPayoutLineInput["answered"],
  stored: PayoutTermsLineRecord,
): boolean {
  return (
    answered.percent === stored.percent &&
    answered.floorCents === stored.floorCents &&
    answered.capPercent === (stored.capPercent ?? null)
  );
}
