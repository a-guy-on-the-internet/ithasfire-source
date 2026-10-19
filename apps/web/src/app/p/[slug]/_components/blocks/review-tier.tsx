"use client";

import type { ReactNode } from "react";

import rt from "./review-tier.module.css";

/* ── The review-tier pair ───────────────────────────────────────────────────
 *
 * Shared chrome for the two blocks that publish review aggregates about a
 * venue: `venue_stats` (what PERFORMERS report) and `audience_stats` (what
 * ATTENDEES report). The PLACE template renders them back to back
 * (`page-templates.ts`), and they answer the same question from opposite sides
 * of the stage — "would you come back?" vs "would you play here again?".
 *
 * These primitives exist so that pairing is structural rather than a
 * coincidence of two stylesheets: both blocks open with an identical TIER
 * STAMP naming their source, and both render their headline percentage with
 * the same figure/label/count treatment. A reader comparing 90% to 85% is
 * comparing like with like, and can never be unsure which side a number came
 * from.
 *
 * COUNTS ARE OPAQUE LABELS. Every count that reaches these components is a
 * suppression band produced by the aggregation policy ("5", "20+", "8+") —
 * a string to print, never a number to compute with. Nothing here parses,
 * sums, or compares one.
 */

/**
 * The source stamp. Holds the tier word and nothing else: it is the pair's
 * shared signature, so its content must stay a bare noun (ATTENDEES /
 * PERFORMERS) rather than a sentence.
 */
export function ReviewTierStamp({ children }: { children: ReactNode }) {
  return <p className={rt.tierStamp}>{children}</p>;
}

/**
 * A provenance count on its own line — used when the block has no headline
 * percentage for the count to sit under.
 */
export function ReviewTierCount({ children }: { children: ReactNode }) {
  return (
    <p className={`${rt.tierCount} ${rt.tierCountStandalone}`}>{children}</p>
  );
}

/**
 * The mirrored headline: one percentage, a label that names WHOSE percentage
 * it is, and the count band it was computed over.
 *
 * `count` is optional because the performer and attendee snapshots band their
 * headline populations differently; a caller with nothing honest to print
 * passes nothing rather than a placeholder.
 */
export function ReviewTierHeadline({
  figure,
  label,
  count,
}: {
  figure: string;
  label: string;
  count?: string;
}) {
  return (
    <p className={rt.tierHeadline}>
      <span className={rt.tierFigure}>{figure}</span>
      <span className={rt.tierFigureLabel}>{label}</span>
      {count ? <span className={rt.tierCount}>{count}</span> : null}
    </p>
  );
}

/**
 * "Most named · sound was clear (9), doors on time (8)". The kicker is the
 * mono label idiom; the list is plain text so it reads as a sentence.
 */
export function ReviewTierTagLine({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <p className={rt.tagLine}>
      <span className={rt.tagLineLabel}>{label}</span>
      {children}
    </p>
  );
}

/** The quiet line that names which axes the other side of the stage rates too. */
export function ReviewTierMirrorNote({ children }: { children: ReactNode }) {
  return <p className={rt.tierMirrorNote}>{children}</p>;
}
