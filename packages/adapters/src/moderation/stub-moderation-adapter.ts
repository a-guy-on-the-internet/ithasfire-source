import type {
  ImageModerationResult,
  ModerationPort,
} from "@th/ports/moderation";

/**
 * Deterministic no-network moderation adapter for dev / test / CI where no
 * Azure key is present. Returns APPROVED (maxSeverity 0) by default so local
 * flows aren't blocked; pass `opts` to force a different verdict/severity. The
 * composition root picks the Azure adapter when a key is configured, else this.
 */
export function createStubModerationAdapter(opts?: {
  verdict?: "APPROVED" | "FLAGGED";
  maxSeverity?: number;
}): ModerationPort {
  const verdict = opts?.verdict ?? "APPROVED";
  const maxSeverity = opts?.maxSeverity ?? 0;

  return {
    async moderateImage(): Promise<ImageModerationResult> {
      return {
        verdict,
        maxSeverity,
        categories: [],
        provider: "stub-moderation",
        rawSeverityScale: "four",
        degraded: false,
      };
    },
  };
}
