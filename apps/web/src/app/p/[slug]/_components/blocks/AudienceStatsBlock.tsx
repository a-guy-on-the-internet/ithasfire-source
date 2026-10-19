"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
// Deep import: `AudienceStatsBlockData` lives in get-public-page.ts. The barrel
// (@th/core/use-cases/entity-pages) re-exports its sibling VenueStatsBlockData
// but not this one yet, and the contract is frozen — the @th/core "./*"
// subpath export resolves this path directly without touching core.
import type { AudienceStatsBlockData } from "@th/core/use-cases/entity-pages/get-public-page";
import { useTranslations } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockRenderMode } from "./block-render-context";
import styles from "./block-primitives.module.css";
import au from "./AudienceStatsBlock.module.css";

type Props = {
  block: PageBlockRecord;
};

type Summary = AudienceStatsBlockData["snapshot"]["summary"];

/**
 * Facet score rows in display-priority order (attendee-reviews FR-005). Only
 * the keys present in the snapshot render — a below-threshold facet is ABSENT,
 * never zeroed, per the anonymization policy.
 */
const FACET_ROWS: ReadonlyArray<{
  key: keyof Omit<
    Summary,
    "reviewCountBand" | "overallScore" | "recommendPct"
  >;
  labelKey: string;
}> = [
  { key: "soundQualityScore", labelKey: "audienceStats.scoreSound" },
  { key: "venueComfortScore", labelKey: "audienceStats.scoreVenueComfort" },
  { key: "organizationScore", labelKey: "audienceStats.scoreOrganization" },
  { key: "valueForMoneyScore", labelKey: "audienceStats.scoreValue" },
];

/** 0–5 half-step score → "4" / "4.5" (text, never color-only). */
function formatScore(score: number): string {
  return score.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatAsOf(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/**
 * Verified-attendee ratings aggregated anonymously from scanned-ticket holders
 * (attendee-reviews FR-005/FR-007). The AUDIENCE-perspective sibling of the
 * performer `venue_stats` block — same calm, factual visual language, distinct
 * provenance ("Rated by N verified attendees").
 *
 * SECURITY: trust ONLY the server-injected `dataSource: "audience_stats"`
 * payload (same discipline as `venue_stats`). Owner-stored block data is
 * stripped to `heading` server-side, so a page owner cannot forge aggregates
 * via managePageBlocks. No marker (or a mismatched one) → render nothing. The
 * server omits the block entirely when there is no publishable snapshot, so the
 * public path never needs an empty state; `snapshot.summary` is guaranteed
 * present when the marker is.
 */
export function AudienceStatsBlock({ block }: Props) {
  const t = useTranslations();
  const mode = useBlockRenderMode();

  // Owner editor: stored data has no server marker (get-my-page doesn't inject
  // audience_stats), so show a labelled placeholder the owner can position or
  // hide — mirrors the venue_stats editor treatment.
  if (mode === "editor") {
    return (
      <div className={styles.editorPlaceholder}>
        <span className={styles.editorPlaceholderLabel}>
          {String(t("admin.peBlockKindAudienceStats"))}
        </span>
        <p className={styles.editorPlaceholderHint}>
          {String(t("admin.peBlockAudienceStatsEditorHint"))}
        </p>
      </div>
    );
  }

  const data = block.data as Partial<AudienceStatsBlockData> | undefined;
  if (data?.dataSource !== "audience_stats") return null;

  const summary = data.snapshot?.summary;
  if (!summary?.reviewCountBand) return null;

  const heading = data.heading?.trim() || String(t("audienceStats.heading"));
  const facetRows = FACET_ROWS.filter((row) => summary[row.key] != null);
  // COMMUNITY (unverified) line — computed + suppressed INDEPENDENTLY of the
  // verified headline (FR-010). Present only when it clears its own threshold.
  // Rendered as a clearly-labelled, visually distinct line; NEVER merged into
  // the verified figures above (FR-005/FR-011).
  const community = data.snapshot?.community;

  return (
    <BlockSection className={au.section}>
      <p className={au.provenance}>
        {String(
          t("audienceStats.ratedBy", { count: summary.reviewCountBand }),
        )}
      </p>
      <BlockHeading>{heading}</BlockHeading>

      <div className={styles.statGrid}>
        <div className={styles.statCell}>
          <div className={styles.statCellValue}>
            {String(
              t("audienceStats.scoreOutOf", {
                score: formatScore(summary.overallScore),
              }),
            )}
          </div>
          <div className={styles.statCellLabel}>
            {String(t("audienceStats.overall"))}
          </div>
        </div>
        {summary.recommendPct != null && (
          <div className={styles.statCell}>
            <div className={styles.statCellValue}>{summary.recommendPct}%</div>
            <div className={styles.statCellLabel}>
              {String(t("audienceStats.wouldRecommend"))}
            </div>
          </div>
        )}
      </div>

      {facetRows.length > 0 && (
        <dl className={au.scoreList}>
          {facetRows.map((row) => (
            <div className={au.scoreRow} key={row.key}>
              <dt className={au.scoreLabel}>{String(t(row.labelKey))}</dt>
              <dd className={au.scoreValue}>
                {String(
                  t("audienceStats.scoreOutOf", {
                    score: formatScore(summary[row.key] as number),
                  }),
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {community?.reviewCountBand && (
        <div className={au.communitySection}>
          <p className={au.communityLabel}>
            {String(t("audienceStats.communityLabel"))}
          </p>
          <div className={au.communityRow}>
            <span className={au.communityScore}>
              {String(
                t("audienceStats.scoreOutOf", {
                  score: formatScore(community.overallScore),
                }),
              )}
            </span>
            <span className={au.communityCount}>
              {String(
                t("audienceStats.communityRatedBy", {
                  count: community.reviewCountBand,
                }),
              )}
            </span>
          </div>
          <p className={au.communityNote}>
            {String(t("audienceStats.communityNote"))}
          </p>
        </div>
      )}

      <p className={`${styles.bodySmall} ${styles.subtleMuted} ${au.metaLine}`}>
        {String(t("audienceStats.updatedPeriodically"))}
        {data.snapshotAt
          ? ` · ${String(t("audienceStats.asOf", { date: formatAsOf(data.snapshotAt) }))}`
          : ""}
      </p>
    </BlockSection>
  );
}
