/**
 * Platform-level defaults rendered into every email footer (CAN-SPAM).
 *
 * Resolved from `PlatformSetting` rows with env fallbacks. Structurally
 * mirrors the `EmailFooterDefaults` type in `@th/ui-email` — the adapter
 * bridges the two via structural typing so the UI package stays free of a
 * dependency on ports.
 */
export interface EmailFooterDefaults {
  /** Physical mailing address (required by CAN-SPAM for commercial mail). */
  physicalAddress?: string;
  /** Contact email shown in the footer. Sourced from the `supportEmail` setting. */
  contactEmail?: string;
  /** Brand/platform name for the footer link. Sourced from the `platformName` setting. */
  brandName?: string;
}

/**
 * In-process cache for footer defaults.
 *
 * `resolve()` returns cached values until the TTL backstop expires;
 * `invalidate()` drops the cache so the next `resolve()` re-reads settings.
 * Invalidation is called on the writing instance when a footer-affecting
 * platform setting changes; the TTL bounds staleness on other instances.
 */
export interface FooterDefaultsCachePort {
  resolve(): Promise<EmailFooterDefaults>;
  invalidate(): void;
}
