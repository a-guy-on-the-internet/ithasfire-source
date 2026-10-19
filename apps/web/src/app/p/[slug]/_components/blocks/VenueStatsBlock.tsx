"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";
import type { VenueStatsBlockData } from "@th/core/use-cases/entity-pages";
import { useFormatters, useTranslations } from "@th/ui";

import { BlockSection, BlockHeading } from "./block-primitives";
import { useBlockRenderMode } from "./block-render-context";
import {
  ReviewTierCount,
  ReviewTierHeadline,
  ReviewTierStamp,
} from "./review-tier";
import styles from "./block-primitives.module.css";
import vs from "./VenueStatsBlock.module.css";

type Props = {
  block: PageBlockRecord;
};

type Headline = VenueStatsBlockData["snapshot"]["headline"];

/**
 * Score rows in display-priority order (booking-review-data-weave FR-005).
 * Only the keys present in the snapshot render — a below-threshold slice is
 * ABSENT, never zeroed, per the anonymization policy.
 */
const SCORE_ROWS: ReadonlyArray<{
  key: keyof Omit<Headline, "reviewCountBand" | "wouldPlayAgainPct">;
  labelKey: string;
}> = [
  { key: "soundScore", labelKey: "venueStats.scoreSound" },
  { key: "stageEquipmentScore", labelKey: "venueStats.scoreStageEquipment" },
  { key: "parkingScore", labelKey: "venueStats.scoreParking" },
  { key: "bookerScore", labelKey: "venueStats.scoreBooker" },
  { key: "staffSupportScore", labelKey: "venueStats.scoreStaffSupport" },
  { key: "promotionScore", labelKey: "venueStats.scorePromotion" },
];

const METHOD_LABEL_KEYS: ReadonlyArray<{
  key: keyof NonNullable<
    NonNullable<VenueStatsBlockData["snapshot"]["payout"]>["methodPcts"]
  >;
  labelKey: string;
}> = [
  { key: "guarantee", labelKey: "venueStats.methodGuarantee" },
  { key: "doorSplit", labelKey: "venueStats.methodDoorSplit" },
  { key: "ticketSales", labelKey: "venueStats.methodTicketSales" },
  { key: "barPercentage", labelKey: "venueStats.methodBarPercentage" },
  { key: "tips", labelKey: "venueStats.methodTips" },
  { key: "payToPlay", labelKey: "venueStats.methodPayToPlay" },
  { key: "unpaid", labelKey: "venueStats.methodUnpaid" },
  { key: "other", labelKey: "venueStats.methodOther" },
];

/**
 * ── WHY EVERY FORMATTER HERE TAKES `fmt` ──────────────────────────────────
 * These used to call `toLocaleString(undefined, …)`, `toLocaleDateString(
 * undefined, …)` and `new Intl.NumberFormat(undefined, …)`. `undefined` means
 * "the runtime's default locale", and this block is server-rendered and then
 * hydrated — so Node's ICU formatted the HTML while the browser's formatted
 * the client render, and React threw the server tree away on every
 * Spanish-locale load. It also rendered Spanish copy with English numerals.
 *
 * `useFormatters()` resolves off the APP's locale (`AppLocaleProvider` feeds
 * the same value to server and client), so the two agree by construction.
 *
 * The mismatch is INVISIBLE to a console-error gate: React 19 reports
 * recoverable hydration errors through `onRecoverableError`, which Next's dev
 * overlay consumes without ever calling `console.error`. Verify by comparing
 * SSR HTML against the hydrated DOM, never by a clean console.
 */
type Formatters = ReturnType<typeof useFormatters>;

/**
 * Cents → whole dollars. Values are $25-bucket-aligned; never show cents.
 * Currency style keeps symbol and digit grouping locale-consistent — a bare
 * "$" prefix with locale grouping renders "$1.500" in es-ES, which reads as
 * $1.50.
 *
 * Two deliberate non-choices, both of which look like mistakes:
 *
 *  · NOT `<Money>` (the design system's mandatory money primitive). The result
 *    is interpolated into an ICU message (`venueStats.payoutRange`,
 *    `admin.bkStatsLineMedianPayout`) as a STRING, so a React component cannot
 *    stand in without restructuring the copy.
 *  · NOT `fmt.currency`. Its parameter is TYPED `cents` but the implementation
 *    passes the value straight to `Intl.NumberFormat` without dividing, so a
 *    correct call reads `fmt.currency(cents / 100, …)` — which looks like a
 *    double conversion at every call site and invites a wrong "fix".
 *    `fmt.number` with currency options does the same job and says what it
 *    does. (The misnomer lives in `packages/locale`; flagged, not changed.)
 */
export function formatBucketDollars(fmt: Formatters, cents: number): string {
  return fmt.number(Math.round(cents / 100), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/** 0–5 half-step score → "4" / "4.5" (text, never color-only). */
function formatScore(fmt: Formatters, score: number): string {
  return fmt.number(score, { maximumFractionDigits: 1 });
}

/**
 * The snapshot's recompute date.
 *
 * NOT `<DateTime>`, deliberately — see the twin note in AudienceStatsBlock.
 * `<DateTime>` demands an explicit `timeZone` because an EVENT time without
 * one is a real harm; this is platform bookkeeping about when the aggregate
 * was recomputed and has no venue zone to carry.
 */
function formatAsOf(fmt: Formatters, iso: string): string {
  try {
    return fmt.dateTime(iso, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

/** 0 (Sunday) – 6 (Saturday) → localized short weekday name. */
function dayName(fmt: Formatters, day: number): string {
  // Jan 7 2024 is a Sunday; offset by the 0-based day-of-week index. UTC is
  // pinned so the synthetic date can never slip a day in a western zone.
  return fmt.dateTime(new Date(Date.UTC(2024, 0, 7 + day)), {
    weekday: "short",
    timeZone: "UTC",
  });
}

/**
 * Crowd-sourced venue stats reported anonymously by performers
 * (booking-review-data-weave FR-005/FR-007).
 *
 * SECURITY: trust ONLY the server-injected `dataSource: "venue_stats"`
 * payload (same discipline as the HUMAN `stats` block). Owner-stored data can
 * never carry the marker — block-config strips everything but `heading` — so
 * a page owner cannot inject fake aggregates via managePageBlocks. No marker
 * (or a mismatched one) → render nothing. The server omits the block entirely
 * when there is no publishable snapshot, so the public path never needs an
 * empty state.
 *
 * FR-007 framing: this is performer testimony, not venue marketing — the
 * PERFORMERS tier stamp leads, and every value is a policy-coarsened aggregate
 * presented as calm, factual data.
 *
 * PAIRING: this is the PERFORMER half of the review-tier pair; `audience_stats`
 * carries the ATTENDEE half and the PLACE template renders the two back to
 * back. Both open with the same stamp and render their headline percentage
 * through the same `review-tier.tsx` primitives, because "would you play here
 * again?" and "would you come back?" are the same question from the two sides
 * of the stage and a reader must be able to compare them at a glance — and
 * must never have to guess which side a number came from.
 *
 * Counts here are anonymization BANDS ("7", "20+"), printed verbatim. Nothing
 * in this file may do arithmetic on one.
 */
export function VenueStatsBlock({ block }: Props) {
  const t = useTranslations();
  const fmt = useFormatters();
  const mode = useBlockRenderMode();

  // Owner editor: stored data has no server marker (get-my-page doesn't
  // inject venue_stats), so show a labelled placeholder the owner can
  // position/hide — mirrors the request_to_play editor treatment.
  if (mode === "editor") {
    return (
      <div className={styles.editorPlaceholder}>
        <span className={styles.editorPlaceholderLabel}>
          {String(t("admin.peBlockKindVenueStats"))}
        </span>
        <p className={styles.editorPlaceholderHint}>
          {String(t("admin.peBlockVenueStatsEditorHint"))}
        </p>
      </div>
    );
  }

  const data = block.data as Partial<VenueStatsBlockData> | undefined;
  if (data?.dataSource !== "venue_stats") return null;

  const headline = data.snapshot?.headline;
  if (!headline?.reviewCountBand) return null;

  const heading = data.heading?.trim() || String(t("venueStats.heading"));
  const payout = data.snapshot?.payout;

  const scoreRows = SCORE_ROWS.filter((row) => headline[row.key] != null);

  const methodParts = payout?.methodPcts
    ? METHOD_LABEL_KEYS.filter((m) => payout.methodPcts?.[m.key] != null)
        .map((m) => ({
          label: String(t(m.labelKey)),
          pct: payout.methodPcts?.[m.key] ?? 0,
        }))
        .sort((a, b) => b.pct - a.pct)
        .map((m) => `${m.label} ${m.pct}%`)
    : [];

  const nightParts = (data.snapshot?.dayOfWeek ?? [])
    .slice()
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3)
    .map((entry) => `${dayName(fmt, entry.day)} ${entry.pct}%`);

  const genres = data.snapshot?.genres ?? [];

  return (
    <BlockSection className={vs.section}>
      <ReviewTierStamp>{String(t("venueStats.tier"))}</ReviewTierStamp>
      <BlockHeading>{heading}</BlockHeading>

      {/* The mirrorable number leads, in the shared pair treatment. When no
          performer answered it the figure is ABSENT and the provenance count
          stands on its own line — never a 0%. */}
      {headline.wouldPlayAgainPct != null ? (
        <ReviewTierHeadline
          figure={`${headline.wouldPlayAgainPct}%`}
          label={String(t("venueStats.wouldPlayAgain"))}
          count={String(
            t("venueStats.reportedBy", { count: headline.reviewCountBand }),
          )}
        />
      ) : (
        <ReviewTierCount>
          {String(
            t("venueStats.reportedBy", { count: headline.reviewCountBand }),
          )}
        </ReviewTierCount>
      )}

      {payout && (
        <div className={styles.statGrid}>
          <div className={styles.statCell}>
            <div className={styles.statCellValue}>
              {formatBucketDollars(fmt, payout.medianCents)}
            </div>
            <div className={styles.statCellLabel}>
              {String(t("venueStats.medianPayout"))}
            </div>
            {payout.minCents !== payout.maxCents && (
              <div className={vs.statCellSub}>
                {String(
                  t("venueStats.payoutRange", {
                    min: formatBucketDollars(fmt, payout.minCents),
                    max: formatBucketDollars(fmt, payout.maxCents),
                  }),
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {scoreRows.length > 0 && (
        <dl className={vs.scoreList}>
          {scoreRows.map((row) => (
            <div className={vs.scoreRow} key={row.key}>
              <dt className={vs.scoreLabel}>{String(t(row.labelKey))}</dt>
              <dd className={vs.scoreValue}>
                {String(
                  t("venueStats.scoreOutOf", {
                    score: formatScore(fmt, headline[row.key] as number),
                  }),
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {methodParts.length > 0 && (
        <p className={`${styles.bodySmall} ${styles.muted} ${vs.metaLine}`}>
          {String(t("venueStats.methodMix", { list: methodParts.join(" · ") }))}
        </p>
      )}

      {genres.length > 0 && (
        <p className={`${styles.bodySmall} ${styles.muted} ${vs.metaLine}`}>
          {String(t("venueStats.genres", { list: genres.join(", ") }))}
        </p>
      )}

      {nightParts.length > 0 && (
        <p className={`${styles.bodySmall} ${styles.muted} ${vs.metaLine}`}>
          {String(t("venueStats.nights", { list: nightParts.join(" · ") }))}
        </p>
      )}

      <p className={`${styles.bodySmall} ${styles.subtleMuted} ${vs.metaLine}`}>
        {String(t("venueStats.updatedPeriodically"))}
        {data.snapshotAt
          ? ` · ${String(t("venueStats.asOf", { date: formatAsOf(fmt, data.snapshotAt) }))}`
          : ""}
      </p>
    </BlockSection>
  );
}
