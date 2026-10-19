/**
 * EventHuman roles that count as headliners for attribution + share-link
 * generation — i.e. people a buyer would say "I'm here to see them" about.
 *
 * Intentionally excludes HOST (MCs/announcers), VENDOR (booths),
 * VOLUNTEER (operational), and OTHER (catch-all). Those roles still
 * render in the public lineup but never show up in "who are you most
 * excited to see?" pickers or in artist-attribution analytics.
 *
 * Update this list when adding new roles that should appear in referral
 * analytics.
 */
export const PERFORMER_ROLES = [
  "PERFORMER",
  "DJ",
  "SPEAKER",
  "INSTRUCTOR",
] as const;

export type PerformerRole = (typeof PERFORMER_ROLES)[number];

/**
 * EventHuman roles that surface on the PUBLIC lineup — and therefore on the
 * credited human's profile show listings (`shows` / `past_shows` /
 * `upcoming_events` derivations). Product rule: if an event's public lineup
 * credits you, your profile lists the show.
 *
 * Every role EXCEPT VOLUNTEER, mirroring the public lineup filter in
 * `use-cases/event-humans/list-public-event-humans.ts` — volunteers are
 * operational assignments that live on EventHuman only so the volunteer flow
 * can reuse the relation, and are filtered out of public lineups entirely.
 *
 * `PERFORMER_ROLES` above stays analytics/picker-only ("who are you excited
 * to see?" + attribution/share links) — do NOT use it for profile listings.
 */
export const PUBLIC_LINEUP_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "SPEAKER",
  "INSTRUCTOR",
  "VENDOR",
  "OTHER",
] as const;

export type PublicLineupRole = (typeof PUBLIC_LINEUP_ROLES)[number];

/**
 * EventHuman roles that make a signed-in human an ACT ON THE BILL for the
 * address and load-in (arrival-areas FR-009; owner ruling 2026-10-16, "I
 * think your answer is fine"). VENDOR, VOLUNTEER and OTHER do not count.
 * Wider than `PERFORMER_ROLES` (HOST is here): a host loads in too.
 */
export const ACT_ON_BILL_ROLES = [
  "PERFORMER",
  "HOST",
  "DJ",
  "INSTRUCTOR",
  "SPEAKER",
] as const;

export type ActOnBillRole = (typeof ACT_ON_BILL_ROLES)[number];

const ACT_ON_BILL_ROLE_SET: ReadonlySet<string> = new Set(ACT_ON_BILL_ROLES);

/**
 * Whether `viewerHumanId` is an act on the bill of the event these lineup
 * rows belong to: a row LINKED to that human (`humanId`, never a free-text
 * `externalName` row and never a group `orgId` row) with an act role. The
 * caller passes the rows of ONE event; this does not check `eventId`. A
 * missing viewer is never an act. Fail closed on anything malformed.
 */
export function isActOnBill(
  rows: ReadonlyArray<{
    humanId?: string | null;
    orgId?: string | null;
    role?: string | null;
  }>,
  viewerHumanId: string | null | undefined,
): boolean {
  if (typeof viewerHumanId !== "string" || viewerHumanId.length === 0) {
    return false;
  }
  return rows.some(
    (row) =>
      typeof row.humanId === "string" &&
      row.humanId === viewerHumanId &&
      (row.orgId ?? null) === null &&
      typeof row.role === "string" &&
      ACT_ON_BILL_ROLE_SET.has(row.role),
  );
}
