import type { ImageModerationCategoryScore } from "@th/types/repos/image-moderation-records";

/**
 * Normalized, provider-agnostic result of an image moderation check.
 *
 * The port reports SEVERITIES only — it makes NO threshold / visibility
 * decision. Mapping `maxSeverity` to APPROVED vs FLAGGED against the configured
 * review threshold is the use case's job (kept out of the port so it stays
 * testable and provider-independent). `verdict` here is the adapter's own
 * clean/flag signal (e.g. transport-level fail-closed); the use case still owns
 * the final status.
 *
 * `degraded = true` means the verdict came from the fail-closed path (provider
 * unreachable / errored / timed out), not a real analysis — the use case must
 * treat it as FLAGGED and report the underlying error (see FR-006).
 *
 * `rawSeverityScale` exposes the provider's native severity scale so callers can
 * interpret `severity` values: "four" = Azure's 0/2/4/6, "eight" = a 0-7 scale.
 */
export interface ImageModerationResult {
  verdict: "APPROVED" | "FLAGGED";
  maxSeverity: number;
  categories: ImageModerationCategoryScore[];
  provider: string;
  rawSeverityScale: "four" | "eight";
  degraded: boolean;
}

/**
 * Provider-agnostic port for automated image moderation.
 *
 * The caller (use case) fetches the raw bytes from storage and passes them in,
 * so the adapter stays free of storage concerns and is trivially unit-testable
 * with a fixture image. Implementations MUST NOT throw on provider failure —
 * they return a degraded, fail-closed {@link ImageModerationResult} so the use
 * case can hold the image for a human and report the error.
 */
export interface ModerationPort {
  moderateImage(input: {
    imageBytes: Uint8Array;
    contentType: string;
    imageId: string;
    subjectType?: string;
    subjectId?: string;
  }): Promise<ImageModerationResult>;
}
