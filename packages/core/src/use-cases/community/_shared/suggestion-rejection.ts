import { fail } from "@th/errors";

/**
 * SINGLE SOURCE OF TRUTH for every way an event edit suggestion can be
 * rejected with the `EDIT_SUGGESTION_INVALID_FIELDS` code
 * (community-managed-event-listings spec FR-006..FR-009 + NFR-001).
 *
 * The code is intentionally ONE code carrying a discriminating `meta.reason`
 * (rather than eleven distinct codes) so the transport surface + clients handle
 * a single error family. The anti-rot guarantee is this module: EVERY throw
 * site goes through {@link suggestionRejection}, which only accepts a
 * {@link SuggestionRejectionReason}, so a new rejection can't invent an
 * untracked reason string, and the web's exhaustive
 * `Record<SuggestionRejectionReason, string>` message map turns a missing
 * client mapping into a COMPILE error.
 *
 * Reasons, and where they originate:
 *  - `not_an_object`               — proposed fields payload isn't an object
 *  - `unsupported_fields`          — payload carries non-whitelisted keys
 *  - `lat_lng_must_pair`           — lat/lng must travel together (both or none)
 *  - `empty_diff`                  — no whitelisted field with a defined value
 *  - `invalid_body`               — event body failed schema / embed-allowlist
 *  - `blocked_content`             — a free-text field tripped the content filter
 *  - `ends_before_starts`          — proposed schedule would invert the bounds
 *  - `not_an_event_image`          — heroImageId doesn't reference this event
 *  - `upload_not_finalized`        — heroImageId references an un-uploaded row
 *  - `unattached_not_own_upload`   — unattached hero upload isn't the submitter's
 *  - `stored_fields_revalidation_failed` — stored Json failed re-parse at approve
 */
export const SUGGESTION_REJECTION_REASONS = [
  "not_an_object",
  "unsupported_fields",
  "lat_lng_must_pair",
  "empty_diff",
  "invalid_body",
  "blocked_content",
  "ends_before_starts",
  "not_an_event_image",
  "upload_not_finalized",
  "unattached_not_own_upload",
  "stored_fields_revalidation_failed",
] as const;

export type SuggestionRejectionReason =
  (typeof SUGGESTION_REJECTION_REASONS)[number];

/**
 * The ONLY constructor for an `EDIT_SUGGESTION_INVALID_FIELDS` rejection. Every
 * throw site in the suggestion pipeline calls this, so a reason is always a
 * tracked {@link SuggestionRejectionReason} and the `meta` shape is uniform:
 *
 *   `{ reason, fields?: string[], term? }`
 *
 * `fields` (when present) names the offending whitelisted field(s) so a client
 * can anchor the message inline; `term` (optional) is the first content-filter
 * match, surfaced only on the `blocked_content` path for telemetry — clients
 * decide whether to echo it (the web deliberately does not).
 *
 * Returns `never` (delegates to {@link fail}), so both `throw
 * suggestionRejection(...)` and a bare `suggestionRejection(...)` statement
 * type-check.
 */
export function suggestionRejection(
  reason: SuggestionRejectionReason,
  fields?: readonly string[],
  extra?: { term?: string; cause?: unknown },
): never {
  const meta: Record<string, unknown> = { reason };
  if (fields && fields.length > 0) {
    meta.fields = [...fields];
  }
  if (extra?.term) {
    meta.term = extra.term;
  }
  return fail("EDIT_SUGGESTION_INVALID_FIELDS", {
    meta,
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  });
}
