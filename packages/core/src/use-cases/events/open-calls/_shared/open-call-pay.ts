import { z } from "zod";

import type { OpenCallPayKind } from "@th/ports/repos/events";

import { plainTextMultilineOptional } from "../../../../lib/sanitize-plain-text";

/**
 * Pay on an open call (open calls FR-002, Q7/Q20/Q24): a REQUIRED kind plus
 * details text. Nothing here ever charges an applicant; these are the terms
 * the poster offers the act.
 */
export const OPEN_CALL_PAY_KINDS = [
  "FIXED",
  "DOOR_SPLIT",
  "TICKET_SHARE",
  "TICKET_QUOTA",
  "UNPAID",
  "DISCUSSED_AFTER",
] as const satisfies readonly OpenCallPayKind[];

export const openCallPayKindSchema = z.enum(OPEN_CALL_PAY_KINDS);

/** Kinds whose details text is required (FR-002). */
export const PAY_KINDS_REQUIRING_DETAILS: ReadonlySet<OpenCallPayKind> = new Set([
  "FIXED",
  "DOOR_SPLIT",
  "TICKET_SHARE",
  "TICKET_QUOTA",
]);

/** Upper bound on the details text, measured after sanitizing. */
export const PAY_DETAILS_MAX_LENGTH = 500;

/**
 * Input field for pay details: sanitized (tags, control and bidi characters
 * stripped) BEFORE the length check, then an all-blank value becomes null so
 * "required" can't be met with whitespace. Absent = leave unchanged, null =
 * clear (presence semantics of the form upsert).
 */
export const payDetailsInputSchema = plainTextMultilineOptional(PAY_DETAILS_MAX_LENGTH)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional();

/**
 * TICKET_QUOTA must "state the number of tickets" (FR-002). The minimal
 * check: the details contain a whole number of at least 1 written in digits
 * ("Sell 10 tickets to play", "15 presales"). A number in words ("ten")
 * does not count; the form asks for digits.
 */
export function statesTicketCount(details: string): boolean {
  const runs = details.match(/\d+/g) ?? [];
  return runs.some((run) => Number.parseInt(run, 10) >= 1);
}

/**
 * Validates the EFFECTIVE pay of a PERFORM form, after merging the input over
 * what is stored (a partial update can drop below the bar without either
 * value being wrong alone). Issues surface as `invalid_input`, like the
 * window-order check of the form upsert:
 *   - pay_kind_required        — no kind at all;
 *   - pay_details_required     — FIXED / DOOR_SPLIT / TICKET_SHARE /
 *                                TICKET_QUOTA with no details;
 *   - ticket_quota_needs_count — TICKET_QUOTA details state no number.
 */
export const effectiveOpenCallPaySchema = z
  .object({
    payKind: openCallPayKindSchema.nullable(),
    payDetails: z.string().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.payKind === null) {
      ctx.addIssue({
        code: "custom",
        path: ["payKind"],
        message: "pay_kind_required",
      });
      return;
    }
    const details = value.payDetails?.trim() ?? "";
    if (PAY_KINDS_REQUIRING_DETAILS.has(value.payKind) && details.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["payDetails"],
        message: "pay_details_required",
      });
      return;
    }
    if (value.payKind === "TICKET_QUOTA" && !statesTicketCount(details)) {
      ctx.addIssue({
        code: "custom",
        path: ["payDetails"],
        message: "ticket_quota_needs_count",
      });
    }
  });
