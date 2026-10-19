/**
 * Result of a content-filter check that also reports WHAT matched. `matches`
 * is best-effort (present only when the implementation can surface the offending
 * term(s)); callers must not rely on it being populated when `blocked` is true.
 */
export interface ContentFilterMatch {
  blocked: boolean;
  /** Offending term(s), first-match-first. Optional / best-effort. */
  matches?: string[];
}

/**
 * Port for checking user-submitted text against content moderation rules.
 *
 * Implementations should return true when the text contains content that
 * must be rejected before it reaches persistence or review queues.
 */
export interface ContentFilterPort {
  hasBlockedContent(input: { text: string }): Promise<boolean>;
  /**
   * Optional richer check that also reports the matched term(s). Non-breaking:
   * older implementations (and test fakes) may omit it, so callers must fall
   * back to {@link ContentFilterPort.hasBlockedContent} when it's absent.
   */
  findBlocked?(input: { text: string }): Promise<ContentFilterMatch>;
}
