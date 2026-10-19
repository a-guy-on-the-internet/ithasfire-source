import { subjectHref } from "../../reports/_components/entity-report-queue.helpers";

/**
 * Pure helpers for /platform/invite-pauses (invite complaint auto-pause, W4).
 * Kept out of the view so ordering and link rules are unit-testable.
 */

export type InvitePauseFilter = "AWAITING_REVIEW" | "OPEN" | "LIFTED";

export type InvitePauseOwnerKind = "ORG" | "HUMAN";

/** One queue row. Mirrors `platform.invitePauses.list` items, dates as ISO. */
export type InvitePauseQueueItem = {
  id: string;
  ownerKind: InvitePauseOwnerKind;
  ownerId: string;
  ownerName: string | null;
  /**
   * The owner's PUBLIC-PAGE (EntityPage) slug. Only ORG links use it; a
   * person always links to the staff humans search (see invitePauseOwnerHref).
   */
  ownerSlug: string | null;
  reason: "COMPLAINT_COUNT" | "COMPLAINT_RATE";
  complaintCount: number;
  recipientCount: number;
  pausedAt: string;
  reviewRequestedAt: string | null;
  reviewRequestNote: string | null;
  decision: "LIFTED" | "KEPT" | null;
  decidedAt: string | null;
  decisionNote: string | null;
  liftedAt: string | null;
};

/**
 * Review requests first, oldest ask first; then the rest, oldest pause
 * first. Lifted pauses keep the server's order (newest lift first).
 */
export function orderInvitePauses(
  items: readonly InvitePauseQueueItem[],
  filter: InvitePauseFilter,
): InvitePauseQueueItem[] {
  if (filter === "LIFTED") return [...items];
  const time = (iso: string) => new Date(iso).getTime();
  return [...items].sort((a, b) => {
    const aAsk = a.reviewRequestedAt;
    const bAsk = b.reviewRequestedAt;
    if (aAsk !== null && bAsk !== null) {
      const byAsk = time(aAsk) - time(bAsk);
      if (byAsk !== 0) return byAsk;
    } else if (aAsk !== null || bAsk !== null) {
      return aAsk !== null ? -1 : 1;
    }
    return time(a.pausedAt) - time(b.pausedAt);
  });
}

/**
 * Where the organiser's name links.
 * - Organisation: its public page `/orgs/<pageSlug>`, built (and sanitised)
 *   exactly as the reports queue links subjects; no slug → plain text.
 * - Person: ALWAYS the platform humans list filtered by name (as the payouts
 *   and dispute desks do), never `/humans/<slug>`. That public page 404s while
 *   person profiles are off, for private pages and for banned owners, and the
 *   staff page works in every case. No name → plain text.
 */
export function invitePauseOwnerHref(item: {
  ownerKind: InvitePauseOwnerKind;
  ownerName: string | null;
  ownerSlug: string | null;
}): string | null {
  if (item.ownerKind === "ORG") return subjectHref("ORGANIZATION", item.ownerSlug);
  const name = item.ownerName?.trim();
  return name ? `/platform/humans?q=${encodeURIComponent(name)}` : null;
}

/** Complaints as a percentage of people invited; null with nobody invited. */
export function complaintRatePercent(
  complaintCount: number,
  recipientCount: number,
): number | null {
  if (recipientCount <= 0) return null;
  return (complaintCount / recipientCount) * 100;
}

/** Waiting = asked for a review and not yet answered (a KEEP clears the ask). */
export function isAwaitingReview(item: {
  reviewRequestedAt: Date | string | null;
  liftedAt: Date | string | null;
}): boolean {
  return item.reviewRequestedAt !== null && item.liftedAt === null;
}
