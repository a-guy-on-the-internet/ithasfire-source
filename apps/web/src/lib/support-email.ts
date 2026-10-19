/**
 * Fallback support address, safe to import from both server and client
 * modules. Used when the platform `supportEmail` setting is absent or the
 * footer-defaults query fails. The `/support` page is linked from
 * transactional emails, so the mailto must always resolve to something.
 */
export const FALLBACK_SUPPORT_EMAIL = "support@ithasfire.com";
