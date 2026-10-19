/**
 * Versions of the legal documents currently in effect. Bump these whenever
 * the user-facing copy changes materially. The server keeps an allow-list
 * of accepted versions in
 * `packages/core/src/use-cases/consent/schemas.ts` — add new entries there
 * too, never remove old ones (historical clients may still hold a stale
 * bundle when they click).
 */
export const PRIVACY_POLICY_VERSION = "2026-10-07";
export const COOKIE_POLICY_VERSION = "2026-07-30";
