"use client";

import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import { BlockSection, BlockHeading } from "./block-primitives";
import styles from "./block-primitives.module.css";

/**
 * The ONLY metrics the public stats block is allowed to render. The
 * server-built payload never contains anything outside this whitelist; we
 * mirror it here so no future field can leak into the UI (FR-003 / risk
 * mitigation in the spec).
 */
type StatsMetrics = {
  totalEventsPerformed: number;
  avgDrawPerEvent: number | null;
  repeatFanCount: number;
  refLinkTickets: number;
  last90DayTickets: number;
  last90DayEvents: number;
};

type StatsData = {
  /**
   * Server-injected trust marker. This block is read-only and fully
   * server-built from the `HumanStats` aggregate. Owner-stored data can never
   * set this key (block-config strips everything but `heading`).
   */
  dataSource?: string;
  eligible?: boolean;
  computedAt?: string | null;
  metrics?: StatsMetrics;
  heading?: string;
};

type Props = {
  block: PageBlockRecord;
};

function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString();
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

function StatItem({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.statCell}>
      <div className={styles.statCellValue}>{value}</div>
      <div className={styles.statCellLabel}>{label}</div>
    </div>
  );
}

/**
 * Verified performance stats (FR-003).
 *
 * SECURITY: trust ONLY the server-injected `dataSource: "stats"` payload.
 * - No marker (or a mismatched one) → render nothing. This covers the public
 *   page for ineligible performers (the block is hidden by default and the
 *   server omits the marker) and any attempt to fabricate `metrics`.
 * - Marker present + `eligible: false` → owner-editor "not yet eligible" hint.
 *   The public payload never carries this combination.
 * - Marker present + `eligible: true` → render the whitelisted metrics with a
 *   point-in-time "as of" caption (the numbers are computed on a schedule, not
 *   live).
 */
export function StatsBlock({ block }: Props) {
  const data = block.data as StatsData | undefined;
  if (!data || data.dataSource !== "stats") return null;

  const heading = data.heading ?? "By the numbers";

  if (!data.eligible) {
    // Owner-editor only: the public page hides this block until eligible.
    return (
      <BlockSection>
        <BlockHeading>{heading}</BlockHeading>
        <div className={styles.editorPlaceholder}>
          <span className={styles.editorPlaceholderLabel}>Not yet eligible</span>
          <p className={styles.editorPlaceholderHint}>
            Perform at 3+ ticketed shows to unlock verified stats. These numbers
            come straight from platform ticketing data — nothing to type in,
            nothing to fake.
          </p>
        </div>
      </BlockSection>
    );
  }

  const m = data.metrics;
  if (!m) return null;

  return (
    <BlockSection>
      <BlockHeading>{heading}</BlockHeading>
      <div className={styles.statGrid}>
        <StatItem
          value={formatCount(m.totalEventsPerformed)}
          label="Shows performed"
        />
        <StatItem
          value={m.avgDrawPerEvent == null ? "—" : formatCount(m.avgDrawPerEvent)}
          label="Avg draw (fans who bought for this artist)"
        />
        <StatItem
          value={formatCount(m.refLinkTickets)}
          label="Tickets via this artist's links"
        />
        <StatItem value={formatCount(m.repeatFanCount)} label="Repeat fans" />
      </div>
      <p
        className={`${styles.bodySmall} ${styles.muted}`}
        style={{ marginTop: "0.75rem" }}
      >
        Last 90 days: {formatCount(m.last90DayTickets)} tickets across{" "}
        {formatCount(m.last90DayEvents)} shows
      </p>
      {data.computedAt && (
        <p
          className={`${styles.bodySmall} ${styles.subtleMuted}`}
          style={{ marginTop: "0.25rem" }}
        >
          As of {formatAsOf(data.computedAt)}
        </p>
      )}
    </BlockSection>
  );
}
