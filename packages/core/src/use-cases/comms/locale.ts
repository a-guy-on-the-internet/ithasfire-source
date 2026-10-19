// ─────────────────────────────────────────────────────────────────────────────
// The languages notification copy exists in (owner ruling 2026-10-03, option A:
// in-app text is rendered at READ time in the reader's language).
//
// This list is the ONE source of truth for core's notification copy. Every copy
// catalog under `./copy/` is typed as a full `{ [L in NotificationLocale]: … }`,
// so adding a locale here fails the typecheck until every catalog has that
// locale's copy. A test (`__tests__/notification-locale-parity.test.ts`) fails
// when the web app's `SUPPORTED_LOCALES` lists a locale this list lacks.
//
// Why not `@th/locale`: same reason as
// `saved-snippets/_shared/starter-reasons.ts` — core does not depend on it, and
// its message JSON is off-limits owner WIP.
// ─────────────────────────────────────────────────────────────────────────────

export const NOTIFICATION_LOCALES = ["en", "es"] as const;

export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const DEFAULT_NOTIFICATION_LOCALE: NotificationLocale = "en";

/**
 * The BCP 47 tag each locale formats dates with. English stays "en-US" because
 * that is what every renderer formatted with before locales existed, and the
 * stored English text must not change.
 */
export const NOTIFICATION_INTL_LOCALE: {
  readonly [L in NotificationLocale]: string;
} = {
  en: "en-US",
  es: "es",
};

function isNotificationLocale(value: string): value is NotificationLocale {
  return (NOTIFICATION_LOCALES as readonly string[]).includes(value);
}

/**
 * Maps anything a client sends to a locale we have copy for.
 *
 * - exact match, case-insensitive ("ES" → "es");
 * - a regional tag falls back to its language ("es-MX", "es_419" → "es");
 * - anything else (unknown language, non-string, empty, garbage) → English.
 *
 * Never throws: an unrecognised locale is a reason to show English, not to
 * fail the request.
 */
export function resolveNotificationLocale(value: unknown): NotificationLocale {
  if (typeof value !== "string") return DEFAULT_NOTIFICATION_LOCALE;
  const normalized = value.trim().toLowerCase();
  if (isNotificationLocale(normalized)) return normalized;
  const language = normalized.split(/[-_]/u)[0] ?? "";
  if (isNotificationLocale(language)) return language;
  return DEFAULT_NOTIFICATION_LOCALE;
}
