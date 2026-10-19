import { ENTITY_REPORT_REASONS } from "@th/core/use-cases/entity-reports";

/**
 * Reason union derived from core's canonical constant (the web app has no
 * `@th/ports` dependency — see roles-constants.ts — so the type is derived
 * from the value export instead of imported from the ports package).
 */
export type EntityReportReason = (typeof ENTITY_REPORT_REASONS)[number];

/**
 * Keyboard navigation + error discrimination for the ReportEntityDialog
 * (entity-report-intake spec FR-001/FR-002). Plain module (no React) so the
 * radio resolver and error predicates are unit-testable without rendering.
 *
 * The radio resolver follows the house ARIA radio pattern
 * (`payout-schedule-nav.helpers.ts`): pure next-value resolver + roving
 * tabindex in the component + focus-follows-selection by DOM id. The list is
 * vertical, so Up/Down are primary and Left/Right are equivalents; an arrow
 * key moves focus AND selection together, and wrapping is deliberate
 * (WAI-ARIA radio groups are circular). Returns `null` for keys the group
 * does not handle — the caller must then leave the event alone (never
 * `preventDefault` a key you did not act on, or you trap Tab).
 */

/** DOM id for a reason option row, so focus can follow selection. */
export const reportReasonOptionDomId = (reason: EntityReportReason): string =>
  `report-entity-reason-${reason}`;

/**
 * Resolve the reason an arrow/Home/End key should move to, or `null` when the
 * key is not one this group handles.
 */
export function nextReasonForKey(
  current: EntityReportReason | null,
  key: string,
  order: readonly EntityReportReason[],
): EntityReportReason | null {
  if (order.length === 0) return null;

  // Nothing selected yet: forward keys enter at the first option, backward
  // keys at the last (an `idx = -1` sentinel would wrap `idx - 1` onto the
  // second-to-last option instead).
  if (current === null) {
    switch (key) {
      case "ArrowDown":
      case "ArrowRight":
      case "Home":
        return order[0] ?? null;
      case "ArrowUp":
      case "ArrowLeft":
      case "End":
        return order[order.length - 1] ?? null;
      default:
        return null;
    }
  }

  const idx = order.indexOf(current);
  if (idx === -1) return null;

  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return order[(idx + 1) % order.length] ?? null;
    case "ArrowUp":
    case "ArrowLeft":
      return order[(idx - 1 + order.length) % order.length] ?? null;
    case "Home":
      return order[0] ?? null;
    case "End":
      return order[order.length - 1] ?? null;
    default:
      return null;
  }
}

/** Keys that select the currently focused radio without moving focus.
 *  Space per the ARIA radio pattern; Enter as the common harmless addition
 *  (this group lives in a dialog with no form submit-on-Enter to collide
 *  with — the submit button is an explicit press target). */
export function isSelectionKey(key: string): boolean {
  return key === " " || key === "Spacebar" || key === "Enter";
}

/**
 * Whether a submit error is the (reporter, subject, PENDING) dedupe —
 * `submitEntityReport` throws the legacy `report_already_open` shape, whose
 * domain code travels as the error `message` (`data.appCode` only carries the
 * generic CONFLICT). Both the pre-check path and the unique-index race loser
 * throw this same code.
 */
export function isReportAlreadyOpenError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { message?: unknown }).message === "report_already_open"
  );
}

/**
 * Whether a submit error is the transport rate-limit trip
 * (`rateLimit` middleware → TRPCError TOO_MANY_REQUESTS). Same detection the
 * suggestions form uses (ProposeEditsForm) — the tRPC code lives on
 * `data.code`.
 */
export function isRateLimitedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { data?: { code?: unknown } }).data?.code;
  return code === "TOO_MANY_REQUESTS";
}

/**
 * Whether a submit error is an expired/missing session (`requireAuth` →
 * TRPCError UNAUTHORIZED). UNAUTHORIZED is a transport-level tRPC code, NOT a
 * canonical AppErrorCode (`getAppErrorCode` returns null for it), so it must
 * be read off `data.code` directly.
 */
export function isUnauthorizedError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { data?: { code?: unknown } }).data?.code;
  return code === "UNAUTHORIZED";
}
