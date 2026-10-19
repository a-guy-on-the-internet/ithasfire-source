import type {
  ImageModerationResult,
  ModerationPort,
} from "@th/ports/moderation";

/**
 * Fail-CLOSED moderation adapter for PRODUCTION when Azure is not configured.
 *
 * Every image resolves to a degraded FLAGGED result (no network) so it is HELD
 * for human review rather than auto-approved and published un-analyzed. The
 * composition root selects this over the auto-approving stub whenever the Azure
 * secrets are missing IN PRODUCTION — a cleared/omitted secret must not silently
 * open the trust boundary. `degraded = true` is the signal the use case uses to
 * force FLAGGED + mark the record degraded (FR-006).
 */
export function createFailClosedModerationAdapter(): ModerationPort {
  return {
    async moderateImage(): Promise<ImageModerationResult> {
      return {
        verdict: "FLAGGED",
        maxSeverity: 6,
        categories: [],
        provider: "unconfigured-fail-closed",
        rawSeverityScale: "four",
        degraded: true,
      };
    },
  };
}
