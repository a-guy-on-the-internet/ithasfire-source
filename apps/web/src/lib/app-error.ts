import { fromLegacyCode } from "@th/errors";

/**
 * Extracts the canonical {@link AppErrorCode}-shaped identifier from an error
 * thrown by a tRPC call (or any error-ish value).
 *
 * Background: the error-contract migration moves server error identifiers from
 * legacy lowercase snake_case (e.g. `paid_ticketing_requires_stripe`) to
 * canonical SCREAMING_SNAKE codes (e.g. `PAID_TICKETING_REQUIRES_STRIPE`). A
 * `TRPCClientError` carries the identifier in two places:
 *   - `error.data.appCode` — the structured, preferred channel.
 *   - `error.message` — older / partial server builds still surface the code
 *     here (the message *is* the code when no custom message is set).
 *
 * The migration is still in flight, so a given server path may emit EITHER a
 * canonical code OR a legacy lowercase one. This helper is migration-proof:
 * both shapes resolve to the canonical code, so callers can compare against
 * canonical {@link AppErrorCode} constants regardless of which the server sent.
 *
 * Resolution:
 *   1. Pick a raw candidate: `data.appCode` (non-empty string) else `message`.
 *   2. Run the candidate through `fromLegacyCode`, which uppercases it and
 *      validates against the canonical code registry. This handles both
 *      already-canonical codes (`QUOTA_EXCEEDED`) and legacy lowercase ones
 *      (`quota_exceeded`), and returns `null` for human-readable sentences,
 *      unknown tokens, and canonical-shaped-but-bogus strings.
 *
 * The helper therefore only ever returns a real {@link AppErrorCode} or `null`
 * — never a bogus SCREAMING_SNAKE passthrough.
 *
 * @returns the canonical {@link AppErrorCode} (UPPERCASE), or `null` when the
 *   error carries no recognized code.
 */
export function getAppErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  // Resolve a raw candidate: prefer the structured `data.appCode`, then fall
  // back to the message (older builds surface the code there).
  const appCode = (error as { data?: { appCode?: unknown } }).data?.appCode;
  const message = (error as { message?: unknown }).message;
  let raw: string | null = null;
  if (typeof appCode === "string" && appCode.trim().length > 0) {
    raw = appCode;
  } else if (typeof message === "string") {
    raw = message;
  }
  if (raw === null) return null;

  // `fromLegacyCode` uppercases + validates against the code Set, so it accepts
  // both canonical and legacy shapes and rejects anything not in the registry
  // (including canonical-looking but non-existent codes like `TOTALLY_FAKE_CODE`).
  return fromLegacyCode(raw);
}
