import type { ImageModerationCategory } from "@th/types/repos/image-moderation-records";

import type { Env } from "./env";

/**
 * Which image-moderation adapter this process actually selected at boot.
 *
 * - "azure"       → Azure AI Content Safety, real scanning.
 * - "fail-closed" → production with the Azure secrets missing. Every image is
 *   held FLAGGED for a human; nothing auto-approves.
 * - "stub"        → non-production with the secrets missing. Auto-approves
 *   everything, which is fine locally and catastrophic anywhere else.
 *
 * This is the single most operationally surprising fact about the pipeline, and
 * until now it appeared in exactly one place: a `logger.warn` at boot, which is
 * NOT Sentry-captured (CLAUDE.md). The /platform ops page reads it through
 * `GET /moderation/config`.
 */
export type ModerationProviderMode = "azure" | "stub" | "fail-closed";

/** The env pair the Azure adapter needs. Both, or it is not configured. */
type ModerationEnv = Pick<
  Env,
  | "AZURE_CONTENT_SAFETY_ENDPOINT"
  | "AZURE_CONTENT_SAFETY_KEY"
  | "NODE_ENV"
  | "IMAGE_MODERATION_REVIEW_THRESHOLD"
  | "IMAGE_MODERATION_THRESHOLD_SEXUAL"
  | "IMAGE_MODERATION_THRESHOLD_VIOLENCE"
  | "IMAGE_MODERATION_THRESHOLD_HATE"
  | "IMAGE_MODERATION_THRESHOLD_SELF_HARM"
>;

/**
 * THE provider-selection condition. The container picks the adapter from this,
 * and the config endpoint reports this — one function, so the page cannot
 * confidently describe a provider the process is not using. Re-deriving it from
 * env at the endpoint would be a second implementation of a two-branch rule,
 * which is exactly how a dashboard ends up lying during an outage.
 */
export function resolveModerationProvider(
  env: ModerationEnv,
): ModerationProviderMode {
  const azureConfigured = !!(
    env.AZURE_CONTENT_SAFETY_ENDPOINT && env.AZURE_CONTENT_SAFETY_KEY
  );
  if (azureConfigured) return "azure";
  return env.NODE_ENV === "production" ? "fail-closed" : "stub";
}

/** Every category, so the resolved map below is total by construction. */
const MODERATION_CATEGORIES = [
  "SEXUAL",
  "VIOLENCE",
  "HATE",
  "SELF_HARM",
] as const satisfies readonly ImageModerationCategory[];

/**
 * The thresholds `moderate-image` will ACTUALLY compare against, with every
 * absent override filled in from `reviewThreshold`.
 *
 * This mirrors `exceedsCategoryThreshold`'s
 * `config.categoryThresholds?.[entry.category] ?? config.reviewThreshold`
 * fallback. The container deliberately passes a PARTIAL map (an absent key must
 * degrade to the uniform threshold, never to zero, which would flag
 * everything) — so a page rendering that partial map raw would show blanks
 * where a real, enforced number exists. Resolving it here means the endpoint
 * reports the decision rule, not its storage format.
 */
export function resolveModerationCategoryThresholds(
  reviewThreshold: number,
  overrides: Partial<Record<ImageModerationCategory, number>>,
): Record<ImageModerationCategory, number> {
  return Object.fromEntries(
    MODERATION_CATEGORIES.map((category) => [
      category,
      overrides[category] ?? reviewThreshold,
    ]),
  ) as Record<ImageModerationCategory, number>;
}
