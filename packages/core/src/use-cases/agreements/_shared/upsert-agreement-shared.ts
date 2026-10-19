import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PayoutTermsRecord,
  PayoutTermsLineInput,
  PayoutTermsLineRecord,
  PayoutTermsLineRounding,
} from "@th/ports/repos/payout-terms";
import type { PayeesRepo, PayeeRecord } from "@th/ports/repos/payees";
import type { Repos } from "@th/ports/repos";
import { payoutTermsLineRoundingSchema } from "@th/schema";

import {
  assessCapSatisfiability,
  isCompleteAllocation,
  SPLITS_TARGET_PCT,
} from "../../../lib/pricing/caps-satisfiable";
import { fail } from "@th/errors";
import type { DealChangeNoticeDeps } from "../../deals/_shared/deal-freeze";

export { describeError, parseInput } from "../../../lib/io";

export const agreementLineInputSchema = z.object({
  lineId: z.uuid().optional(),
  payeeId: z.uuid(),
  percent: z.coerce.number().int().min(0).max(100),
  floorCents: z.coerce.number().int().min(0).default(0),
  capPercent: z
    .union([z.coerce.number().int().min(0).max(100), z.null()])
    .optional()
    .transform((value) => (value === undefined ? null : value)),
  priority: z.coerce.number().int(),
  rounding: payoutTermsLineRoundingSchema.default("FLOOR"),
});

export type AgreementLineInputDto = z.infer<typeof agreementLineInputSchema>;

export type UpsertAgreementDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
} & DealChangeNoticeDeps;

export interface NormalizedAgreementLine {
  id?: string;
  payeeId: string;
  percent: number;
  floorCents: number;
  capPercent: number | null;
  priority: number;
  rounding: PayoutTermsLineRounding;
}

export function normalizeLines(
  lines: AgreementLineInputDto[],
): NormalizedAgreementLine[] {
  return lines.map((line) => ({
    id: line.lineId,
    payeeId: line.payeeId,
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent ?? null,
    priority: line.priority,
    rounding: line.rounding,
  }));
}

export function validateLines(
  lines: NormalizedAgreementLine[],
  existingLines: PayoutTermsLineRecord[] | null,
): void {
  // Inputs are zod-coerced integers — exact comparison, no float slack.
  const totalPercent = lines.reduce((sum, line) => sum + line.percent, 0);
  if (totalPercent > 100) {
    throw {
      code: "invalid_input",
      message: "AGREEMENT_PERCENT_TOTAL_EXCEEDED",
      issues: [
        {
          code: "custom",
          path: ["lines"],
          message: "The total percent across lines must be ≤ 100",
        },
      ],
    } as const;
  }

  // Caps must be able to reach the whole basis — the same predicate
  // `publishEvent`'s Gate 1b runs, applied at the WRITE. `upsertAgreementLine`
  // can rewrite the lines of terms that are already ACTIVE on a selling event, so a cap lowered here would take
  // effect on the very next order: `distributeRemainder` honours it, leaves
  // the shortfall unallocated, and nothing downstream compares the split rows
  // back to the basis.
  //
  // Only a COMPLETE set is held to it — this engine deliberately accepts
  // `Σ percent ≤ 100`, so a half-composed deal must stay saveable.
  const capReport = assessCapSatisfiability(lines);
  if (isCompleteAllocation(lines) && !capReport.satisfiable) {
    throw fail("SPLITS_CAPS_UNSATISFIABLE", {
      meta: {
        totalCapPct: capReport.totalCapPct,
        totalAllocatedPct: capReport.totalPercent,
        targetPct: SPLITS_TARGET_PCT,
        cappedLineIds: capReport.cappedLineIds,
      },
    });
  }

  const payeeIds = new Set<string>();
  for (const line of lines) {
    if (payeeIds.has(line.payeeId)) {
      throw {
        code: "invalid_input",
        message: "duplicate_payee",
        issues: [
          {
            code: "custom",
            path: ["lines"],
            message: "Each payee may only appear once",
          },
        ],
      } as const;
    }
    payeeIds.add(line.payeeId);
  }

  if (existingLines) {
    const existingIds = new Set(existingLines.map((line) => line.id));
    for (const line of lines) {
      if (line.id && !existingIds.has(line.id)) {
        throw {
          code: "invalid_input",
          message: "invalid_line_reference",
          issues: [
            {
              code: "custom",
              path: ["lines"],
              message: "Referenced lineId does not belong to this agreement",
            },
          ],
        } as const;
      }
    }
  }
}

export async function ensurePayeesActive(
  payeesRepo: PayeesRepo,
  lines: NormalizedAgreementLine[],
  _logger?: LoggerPort,
): Promise<void> {
  for (const line of lines) {
    const payee = await payeesRepo.getById(line.payeeId);

    if (!payee) {
      throw fail("PAYEE_NOT_FOUND");
    }
    if (!isPayeeEligible(payee)) {
      throw fail("PAYEE_NOT_ACTIVE");
    }
  }
}

function isPayeeEligible(payee: PayeeRecord): boolean {
  return (
    payee.status === "ACTIVE" && payee.payoutsEnabled && payee.chargesEnabled
  );
}

/**
 * Map a normalized line to repo input, carrying confirmation lifecycle state
 * through the delete-and-recreate rewrite:
 *
 * - no prior line for this payee → plain input (adapter defaults apply:
 *   `requiresConfirmation = false`, no confirmation state);
 * - prior `requiresConfirmation` line with CHANGED economics (percent /
 *   floorCents / capPercent) → keep `requiresConfirmation`, reset to PENDING
 *   and clear `confirmedAt` + counter fields so the payee re-confirms;
 * - otherwise → preserve the prior confirmation state verbatim.
 *
 * Used by `upsertAgreementLine` so the legacy rewrite path agrees with the
 * booking-agreements engine (`_shared/agreement-lines.ts`).
 */
export function toRepoLineInput(
  line: NormalizedAgreementLine,
  prior?: PayoutTermsLineRecord,
): PayoutTermsLineInput {
  const base: PayoutTermsLineInput = {
    id: line.id,
    payeeId: line.payeeId,
    percent: line.percent,
    floorCents: line.floorCents,
    capPercent: line.capPercent,
    priority: line.priority,
    rounding: line.rounding,
  };

  if (!prior) {
    return base;
  }

  const economicsChanged =
    prior.percent !== line.percent ||
    prior.floorCents !== line.floorCents ||
    prior.capPercent !== line.capPercent;

  if (prior.requiresConfirmation && economicsChanged) {
    return {
      ...base,
      ticketTypeId: prior.ticketTypeId,
      requiresConfirmation: true,
      confirmationStatus: "PENDING",
      confirmedAt: null,
      counterPercentBps: null,
      counterNote: null,
    };
  }

  return {
    ...base,
    ticketTypeId: prior.ticketTypeId,
    requiresConfirmation: prior.requiresConfirmation,
    confirmationStatus: prior.confirmationStatus,
    confirmedAt: prior.confirmedAt,
    counterPercentBps: prior.counterPercentBps,
    counterNote: prior.counterNote,
  };
}

export async function fetchExistingAgreement(
  repos: Pick<Repos, "payoutTerms" | "agreements">,
  agreementId: string,
): Promise<PayoutTermsRecord> {
  const agreement = await repos.payoutTerms.getById(agreementId);

  if (!agreement) {
    throw fail("AGREEMENT_NOT_FOUND");
  }

  // Security fence: PayoutTerms referenced by a two-party booking `Agreement`
  // are owned by the booking-agreements engine (party RBAC, DRAFT-only edits,
  // per-payee confirmation lifecycle). This legacy engine has none of those
  // guards — booking-cloned terms stay PENDING forever, so without this check
  // either party could rewrite the other side's payout lines here at ANY
  // booking status (even post-finalize) and erase `requiresConfirmation`
  // gates. Event/org/human default terms are never Agreement-referenced (the
  // only `Agreement.payoutTermsId` writer is the booking-request accept
  // clone), so legitimate flows never hit this.
  const bookingAgreement =
    await repos.agreements.getByPayoutTermsId(agreementId);
  if (bookingAgreement) {
    throw fail("FORBIDDEN");
  }

  if (agreement.status !== "PENDING") {
    throw fail("AGREEMENT_NOT_EDITABLE");
  }

  return agreement;
}
