import type { SuggestionRejectionReason } from "@th/core/use-cases/community/_shared/suggestion-rejection";

/**
 * SHARED client mapping for `EDIT_SUGGESTION_INVALID_FIELDS` rejections, used by
 * BOTH the public propose form and the moderator review queue so the reason →
 * message table (and the `meta` reader) exist in exactly one place.
 *
 * The map is typed `Record<SuggestionRejectionReason, string>` on purpose:
 * `SuggestionRejectionReason` is the core's canonical reason union
 * (`@th/core/use-cases/community/_shared/suggestion-rejection`), so if the
 * server grows a new rejection reason and this table isn't updated, THIS FILE
 * FAILS TO COMPILE. That compile error is the anti-rot guarantee — a reason can
 * never again fall through to a misleading generic message unnoticed.
 *
 * Values are i18n keys (resolved with `t(...)` at the call site). Each message
 * is written to read truthfully in BOTH surfaces: inline next to a form field,
 * and in a moderator toast.
 */
export const SUGGESTION_REASON_MESSAGE_KEYS: Record<
  SuggestionRejectionReason,
  string
> = {
  not_an_object: "suggestEdit.errCannotAccept",
  unsupported_fields: "suggestEdit.errCannotAccept",
  lat_lng_must_pair: "suggestEdit.errLocationIncomplete",
  empty_diff: "suggestEdit.errEmptyDiff",
  invalid_body: "suggestEdit.errInvalidBody",
  blocked_content: "suggestEdit.errBlockedContent",
  ends_before_starts: "suggestEdit.errEndsBeforeStarts",
  not_an_event_image: "suggestEdit.errNotAnEventImage",
  upload_not_finalized: "suggestEdit.errUploadNotFinalized",
  unattached_not_own_upload: "suggestEdit.errUnattachedNotOwnUpload",
  stored_fields_revalidation_failed: "suggestEdit.errStoredRevalidation",
};

/**
 * Neutral, truthful fallback for a wire `reason` value we don't recognize.
 * Given the exhaustive map above this should be unreachable in practice — it
 * only guards against a server sending a reason string this build predates.
 */
const FALLBACK_MESSAGE_KEY = "errors.editSuggestionInvalidFields";

/**
 * Resolve the i18n message key for a rejection `reason` (from `meta.reason`),
 * falling back to the neutral message for an unknown wire value.
 */
export function suggestionReasonMessageKey(
  reason: string | null | undefined,
): string {
  if (reason && reason in SUGGESTION_REASON_MESSAGE_KEYS) {
    return SUGGESTION_REASON_MESSAGE_KEYS[reason as SuggestionRejectionReason];
  }
  return FALLBACK_MESSAGE_KEY;
}

export interface InvalidFieldsMeta {
  /** The discriminating rejection reason (see SuggestionRejectionReason). */
  reason?: string;
  /** Whitelisted field name(s) the rejection is attributed to, if any. */
  fields?: string[];
  /** First content-filter match, on the `blocked_content` path only. */
  term?: string;
}

/**
 * Read the structured `meta` off an `EDIT_SUGGESTION_INVALID_FIELDS` tRPC error
 * (`error.data.meta`). Returns null when the error carries no usable meta. One
 * reader shared by both suggestion surfaces (replaces the per-surface
 * `getInvalidFieldsReason` / `getInvalidFieldsList` duplication).
 */
export function getInvalidFieldsMeta(error: unknown): InvalidFieldsMeta | null {
  if (!error || typeof error !== "object") return null;
  const meta = (error as { data?: { meta?: unknown } }).data?.meta;
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;

  const out: InvalidFieldsMeta = {};
  if (typeof record.reason === "string") out.reason = record.reason;
  if (Array.isArray(record.fields)) {
    const fields = record.fields.filter(
      (field): field is string => typeof field === "string",
    );
    if (fields.length > 0) out.fields = fields;
  }
  if (typeof record.term === "string") out.term = record.term;

  return out.reason || out.fields || out.term ? out : null;
}
