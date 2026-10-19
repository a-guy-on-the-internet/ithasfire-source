/**
 * Maps raw error codes from use-case / tRPC errors — canonical SCREAMING_SNAKE
 * `AppErrorCode`s and legacy lowercase snake_case alike — to human-readable
 * messages suitable for displaying in toasts & inline alerts.
 *
 * If the error message is already human-readable (contains a space), it is
 * returned as-is. Unknown codes get a generic fallback, and the raw code is
 * logged (once) so devs can still track down the issue.
 */

import { lookupOwn } from "./lookup-own";

/**
 * Copy for `ORDER_DISPUTED_REFUND_BLOCKED` (a refund refused because the
 * charge is under an open / under-review / lost dispute). The code sits in
 * the INTERNAL tier ONLY because its `errors.orderDisputedRefundBlocked` en/es
 * catalog entries are still pending, so this is the single place the sentence
 * lives: the dictionary below serves the server refusal, and the refund
 * surfaces (admin order panel, buyer refund page) render it up front instead
 * of waiting for that refusal. Once the catalog entries land, promote the
 * code to USER_FACING and delete both this constant and the dictionary key.
 */
// i18n: key pending — errors.orderDisputedRefundBlocked
export const ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE =
  "This order is under dispute with the buyer's card issuer, so it can't be refunded right now. Once the dispute closes you can refund it if anything is still owed.";

/**
 * Staff wording when the dispute was LOST: permanent, unlike the sentence
 * above. The server code is the same (`ORDER_DISPUTED_REFUND_BLOCKED`); the
 * admin order panel picks this one from `disputeStatus === "LOST"`.
 */
// i18n: key pending — admin.refundBlockedByDisputeLost
export const ORDER_DISPUTED_LOST_REFUND_BLOCKED_MESSAGE =
  "This charge was lost to a chargeback. The cardholder already has the money back, so no refund is possible.";

const ERROR_MESSAGES: Record<string, string> = {
  // ── Generic ────────────────────────────────────────────────────────────
  invalid_input:
    "Some of the information you entered is invalid. Please check the form and try again.",
  forbidden: "You don't have permission to perform this action.",
  unauthorized: "You need to be signed in to do that.",
  staff_only: "This action is restricted to staff members.",

  // ── Auth / roles ───────────────────────────────────────────────────────
  insufficient_role: "You don't have the required role to perform this action.",
  human_not_found:
    "Your user account could not be found. Please sign in again.",
  human_mismatch: "This resource belongs to a different account.",
  actor_not_found:
    "Your user account could not be found. Please sign in again.",

  // ── Organisations ──────────────────────────────────────────────────────
  organization_not_found: "Group not found.",
  organization_inactive: "This group is no longer active.",
  cannot_demote_last_owner: "Cannot remove the last owner of the group.",

  // ── Events ─────────────────────────────────────────────────────────────
  event_not_found: "Event not found.",
  event_not_draft:
    "This event is no longer a draft and cannot be edited this way.",
  event_not_editable: "This event can no longer be edited.",
  event_owner_mismatch: "You don't own this event.",
  event_archived: "This event has been archived.",
  event_not_publishable: "This event cannot be published yet.",
  event_category_missing: "Please select a category before publishing.",
  event_format_missing: "Please select a format before publishing.",
  event_not_application_gated:
    "This event does not use application-based access.",

  // ── Categories / event types ──────────────────────────────────────────
  category_already_exists: "That category already exists.",
  event_type_already_exists:
    "That sub-category already exists for this category.",
  category_slug_required: "Select a category before requesting a sub-category.",
  category_request_not_found: "Category request not found.",
  category_request_already_reviewed: "This request has already been reviewed.",
  category_request_scope_missing:
    "This sub-category request is missing its category scope.",
  invalid_category_request_name:
    "Use a category name with letters or numbers, without links, repeated filler, or blocked language.",
  category_not_found: "The selected category could not be found.",
  category_inactive: "The selected category is inactive.",

  // ── Dates ──────────────────────────────────────────────────────────────
  "endsAt must be after startsAt": "The end date must be after the start date.",

  // ── Locations / places ─────────────────────────────────────────────────
  place_not_found: "The selected place could not be found.",
  place_not_verified:
    "This place page isn't available until the place has been verified.",
  place_not_active:
    "This place has been suspended and can't host new events right now.",
  place_layout_not_found: "No seat layout has been uploaded for this place.",
  not_authorized_for_place: "You don't have permission to manage this place.",
  saved_location_not_found: "The saved location could not be found.",
  not_place_owner: "You don't own this place.",

  // ── Ticket types ───────────────────────────────────────────────────────
  ticket_types_required:
    "At least one ticket type is required before publishing.",
  ticket_type_not_found: "Ticket type not found.",
  ticket_type_capacity_invalid:
    "One or more ticket types have an invalid capacity.",
  ticket_type_name_taken:
    "A ticket type with that name already exists for this event.",
  ticket_type_not_seated: "This ticket type does not support assigned seating.",
  paid_ticketing_requires_stripe:
    "Paid tickets require a connected Stripe account. Set up payments first.",
  paid_ticketing_requires_fee_policy:
    "Paid tickets aren’t available on this event yet because pricing hasn’t been configured on our side. Please contact support — free tickets still work.",
  tickets_already_issued:
    "Tickets have already been issued and some changes are no longer allowed.",

  // ── Orders ─────────────────────────────────────────────────────────────
  event_sales_closed: "Ticket sales have ended for this event.",
  order_not_found: "Order not found.",
  order_not_paid: "This order has not been paid.",
  order_not_refundable: "This order is not eligible for a refund.",
  order_already_refunded: "This order has already been refunded.",
  order_not_processable: "This order cannot be processed right now.",
  order_not_succeeded: "This order hasn't been completed yet.",
  order_item_not_found: "Order item not found.",
  // SCREAMING key on purpose: the tRPC boundary passes an AppError's message
  // through verbatim (message === code) and this lookup is case-sensitive
  // (see the INTERNAL-tier test). See ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE.
  ORDER_DISPUTED_REFUND_BLOCKED: ORDER_DISPUTED_REFUND_BLOCKED_MESSAGE,
  refund_amount_zero: "There is nothing left to refund on this order.",

  // ── Seats ──────────────────────────────────────────────────────────────
  seat_unavailable: "One or more selected seats are no longer available.",
  seat_taken: "A selected seat has already been taken.",
  // A seat's price override was edited between the buyer's quote and the
  // charge; checkout refuses rather than charging a number nobody saw
  // (seat-price-overrides spec D-007).
  // Catalog copy: errors.seatPriceChanged (en + es); this entry is the
  // fallback for call sites that pass no translator.
  seat_price_changed:
    "The price of one of your seats changed. Check the new price and try again.",
  seat_not_found: "Seat not found.",
  seat_ids_invalid: "One or more seat IDs are invalid.",
  seat_ids_duplicate: "Duplicate seat selections detected.",
  seat_section_mismatch:
    "A selected seat does not belong to the expected section.",
  seat_assignment_qty_mismatch:
    "The number of seats doesn't match the requested quantity.",
  seat_duplicate_in_request: "A seat was selected more than once.",

  // ── Agreements & payouts ───────────────────────────────────────────────
  agreement_not_found: "Payout agreement not found.",
  agreement_not_editable: "This agreement can no longer be edited.",
  agreement_subject_mismatch:
    "This agreement doesn't belong to the specified entity.",
  agreement_missing_lines: "The payout agreement is missing line items.",
  agreement_missing_fee_policy: "The payout agreement is missing a fee policy.",
  multiple_active_agreements:
    "Multiple active agreements were found — please contact support.",
  another_active_agreement_exists:
    "An active agreement already exists for this entity.",
  primary_agreement_missing:
    "A primary payout agreement must be set up before publishing.",
  agreement_missing: "The payout agreement could not be found.",
  chargeback_terms_required:
    "This event is temporarily unavailable for paid checkout while the organizer updates payment terms. Please check back soon or contact the organizer.",

  // ── Payees ─────────────────────────────────────────────────────────────
  payee_not_found: "Payee not found.",
  payee_not_active: "This payee is no longer active.",
  payee_already_assigned: "This payee is already assigned.",
  payee_change_not_allowed: "Changing the payee is not allowed on this line.",

  // ── Fee policies ───────────────────────────────────────────────────────
  fee_policy_not_found: "Fee policy not found.",
  fee_policy_not_active: "This fee policy is no longer active.",
  fee_policy_out_of_scope: "This fee policy is not applicable here.",

  // ── Stripe / payments ──────────────────────────────────────────────────
  stripe_event_conflict:
    "A duplicate payment event was detected. No action is needed.",
  stripe_not_connected:
    "The organizer's payment account isn't set up yet. Please contact the event organizer.",
  stripe_not_connected_owner:
    "Your payment account isn't fully set up yet. Finish connecting Stripe in Payments settings, or contact support if you've already completed setup.",
  payment_intent_mismatch: "Payment intent does not match this order.",
  event_mismatch: "The event does not match the order.",
  non_positive_amount:
    "The order total is invalid. Please adjust your selection and try again.",
  no_ticket_types: "No tickets are currently available for this event.",
  buyer_must_be_actor: "You can only purchase tickets for yourself.",

  // ── Promos ──────────────────────────────────────────────────────────────
  promo_not_found:
    "That promo code wasn't recognised. Please check and try again.",
  promo_expired: "This promo code has expired.",
  promo_not_applicable:
    "This promo code can't be applied to your current selection.",
  promo_max_redeemed: "This promo code has reached its maximum number of uses.",
  promo_redeemed_by_human: "You've already used this promo code.",
  promo_minimum_not_met:
    "Your order doesn't meet the minimum amount for this promo.",
  promo_min_order_not_met:
    "Your order doesn't meet the minimum amount for this promo.",
  duplicate_promo_code: "This promo code has already been entered.",
  duplicate_promo: "This promo has already been applied.",
  promo_not_stackable:
    "This promo code can't be combined with other promo codes.",

  // ── Idempotency / concurrency ──────────────────────────────────────────
  idempotency_key_conflict: "This action has already been completed.",
  idempotency_lock_in_progress:
    "Your order is already being processed. Please wait a moment.",

  // ── Images / uploads ───────────────────────────────────────────────────
  avatar_key_not_owned: "You don't have permission to use this image.",
  uploaded_avatar_not_found: "The uploaded image could not be found.",

  // ── Passwords & magic links ────────────────────────────────────────────
  event_password_invalid: "Incorrect password. Please try again.",
  magic_link_not_found: "This magic link is invalid or has expired.",
  magic_link_expired: "This magic link has expired.",

  // ── Applications ───────────────────────────────────────────────────────
  form_not_found: "Application form not found.",
  form_mismatch: "The form does not match the expected application.",

  // ── Misc ───────────────────────────────────────────────────────────────
  dependency_failed:
    "A required service is temporarily unavailable. Please try again shortly.",
  event_slug_context_missing:
    "Unable to generate an event URL. Please try again.",
  settlement_reload_failed:
    "Settlement could not be verified. Please try again.",

  // ── Quotas ─────────────────────────────────────────────────────────────
  quota_exceeded:
    "You've reached the limit for this resource. You can request an increase.",
  expansion_request_already_pending:
    "An expansion request is already pending for this resource.",
};

/**
 * Convert a raw error code to the camelCase segment of its `errors.*` i18n key.
 *
 * Handles BOTH shapes that reach this funnel:
 *   - canonical SCREAMING_SNAKE `AppErrorCode`s — `AppError.message` IS the code
 *     (`packages/errors/src/app-error.ts` does `super(opts.message ?? code)`) and
 *     the tRPC boundary passes `err.message` through verbatim.
 *     e.g. "EVENT_NOT_TICKETED" → "eventNotTicketed"
 *   - legacy lowercase snake_case domain codes.
 *     e.g. "event_not_found" → "eventNotFound"
 *
 * Lowercasing first is what makes the SCREAMING form work; the character class
 * includes digits so "HTTP_500" → "http500" rather than "http_500".
 *
 * This MUST stay byte-identical to `toKey()` in `@th/errors`
 * (`packages/errors/src/codes.ts`), which is what the catalog keys were
 * generated from and what `error-code-parity.test.ts` gates. A drift guard in
 * this module's test file asserts the two agree across every `APP_ERROR_CODES`
 * member.
 *
 * DO NOT "de-duplicate" this by importing `toKey` from `@th/errors`. This module
 * is pulled into CLIENT bundles (every bespoke `onError` toast in the app), and
 * the `@th/errors` barrel re-exports `APP_ERROR_CODES` / `USER_FACING_CODES` /
 * `INTERNAL_CODES` — ~508 string literals — from the same file as `toKey`.
 * Importing it risks shipping all of that to the browser for a five-token regex.
 * The `@th/errors` import stays TEST-ONLY (see the drift guard), which is what
 * keeps the arrays out of the bundle while still pinning the two in lockstep.
 */
function toI18nKeySegment(code: string): string {
  return code
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Code-shaped tokens we're willing to warn about when unmapped: lowercase
 * snake_case OR SCREAMING_SNAKE. Deliberately excludes mixed-case words so a
 * stray human-readable fragment (e.g. "Failure") doesn't trip the warning.
 */
const CODE_SHAPED = /^(?:[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]*)$/;

/**
 * Already-warned `<kind>:<code>` pairs, so a retrying mutation doesn't flood the
 * console. Keyed by kind as well as code because the two diagnostics below mean
 * different things: seeing the `no-translator` nudge for a code must not suppress
 * a later, genuine `unmapped` report for that same code from a translated caller.
 */
const warnedCodes = new Set<string>();

/** Test-only: clear the one-shot warn dedupe so specs can assert it in isolation. */
export function __resetWarnedCodes(): void {
  warnedCodes.clear();
}

/**
 * Convert an error (typically from a tRPC mutation) into a user-friendly string.
 *
 * When an optional `t` (translation) function is supplied, error codes are
 * looked up via `errors.<camelCaseCode>` before falling back to the hardcoded
 * dictionary. Existing callers that omit `t` continue to work unchanged.
 *
 * @example
 * ```ts
 * catch (error) {
 *   toast.danger({ title: "Save failed", message: formatErrorMessage(error) });
 * }
 * ```
 */
export function formatErrorMessage(
  error: unknown,
  t?: (key: string) => string,
): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (!raw) return "Something went wrong. Please try again.";

  // Detect raw Zod / tRPC validation JSON leaked into the message.
  // These look like `[ { "code": "...", ... } ]` or `[{ ... }]`.
  if (/^\s*\[/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        typeof parsed[0]?.code === "string"
      ) {
        // Try to extract human-readable field-level messages from the Zod issues.
        const fieldMessages = parsed
          .map((issue: { path?: string[]; message?: string }) => {
            const field = issue.path?.length ? issue.path.join(".") : null;
            const msg = issue.message ?? "invalid";
            return field ? `${field}: ${msg}` : msg;
          })
          .filter(Boolean);

        if (fieldMessages.length > 0) {
          return `Please fix the following: ${fieldMessages.join("; ")}.`;
        }
        return "Some of the information submitted was invalid. Please check your input and try again.";
      }
    } catch {
      // Not valid JSON — fall through to normal handling.
    }
  }

  // Already a human-readable sentence (contains a space and starts with an uppercase letter)
  if (/^[A-Z].*\s/.test(raw)) return raw;

  // Try i18n lookup when a translator is available
  if (t) {
    const i18nKey = `errors.${toI18nKeySegment(raw)}`;
    const translated = t(i18nKey);
    if (translated !== i18nKey) return translated;
  }

  const mapped = lookupOwn(ERROR_MESSAGES, raw);
  if (mapped) return mapped;

  // No copy resolved: never surface raw identifiers in user-facing toasts. Log
  // so devs can still trace it, but the user sees a generic message. (Sentry
  // already captures the original error upstream of this function via
  // GlobalQueryErrorLogger / mutation hooks.)
  //
  // The two reasons we can land here are diagnosed SEPARATELY, because they have
  // opposite fixes and conflating them sends devs hunting for a catalog entry
  // that already exists:
  //   - `t` supplied → the catalog was consulted and genuinely has no key.
  //   - `t` omitted  → the catalog was never consulted at all. The fix is at the
  //     CALL SITE (thread `t` through), not in en.ts / es.ts.
  if (typeof console !== "undefined" && CODE_SHAPED.test(raw)) {
    const kind = t ? "unmapped" : "no-translator";
    if (!warnedCodes.has(`${kind}:${raw}`)) {
      warnedCodes.add(`${kind}:${raw}`);
      if (t) {
        console.warn(
          `[formatErrorMessage] no copy for error code "${raw}" — add \`errors.${toI18nKeySegment(raw)}\` to en.ts AND es.ts, or list the code in INTERNAL_CODES if it must never be shown.`,
        );
      } else {
        console.warn(
          `[formatErrorMessage] error code "${raw}" was not translated: this call site passed no \`t\`, so \`errors.${toI18nKeySegment(raw)}\` was never consulted. Pass a translator — formatErrorMessage(error, t) — rather than adding catalog copy.`,
        );
      }
    }
  }
  return "Something went wrong. Please try again or contact support.";
}
