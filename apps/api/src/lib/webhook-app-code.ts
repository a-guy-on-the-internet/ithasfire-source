import { type AppErrorCode, fromLegacyCode, isAppError } from "@th/errors";

/**
 * Resolve the canonical {@link AppErrorCode} for an error caught inside a
 * webhook handler, so internal failure logs / Sentry context carry the same
 * stable, machine-readable code the rest of the stack uses (FR-011).
 *
 * This is the webhook-side analogue of `resolveAppCode` in the tRPC plugin —
 * the inputs differ (webhook handlers catch `AppError`s, plain `Error`s from
 * the DB/SDK, and use-case `{ code, message }` objects) so the resolution
 * order is tailored to those shapes:
 *   1. a real {@link AppError} → its `.code`
 *   2. a `{ code }` whose legacy snake_case value maps to a canonical code
 *   3. a `{ message }` (the snake_case domain code today's factories throw)
 *
 * Returns `null` for unmapped / opaque errors so callers can omit the field
 * rather than log a misleading `UNKNOWN`.
 *
 * Logging-only: this never influences the provider-facing HTTP response.
 */
export function resolveWebhookAppCode(error: unknown): AppErrorCode | null {
  if (isAppError(error)) return error.code;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string") {
      const fromCode = fromLegacyCode(record.code);
      if (fromCode) return fromCode;
    }
    if (typeof record.message === "string") {
      const fromMessage = fromLegacyCode(record.message);
      if (fromMessage) return fromMessage;
    }
  }
  return null;
}
