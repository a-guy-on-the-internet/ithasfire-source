import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PerformerOwnerType } from "@th/types/repos/performer-profiles";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// Performer display-name resolution, shared by every read that projects a
// booking request's sender as a name: the inbox rows (list-booking-requests)
// and the admin calendar hold overlay (booking-hold-overlay). ONE batched
// read per owner kind per call — never per row.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows the resolver needs — the polymorphic owner pair + anonymous contact. */
export type PerformerSenderRow = Pick<
  BookingRequestRecord,
  | "performerOwnerType"
  | "performerOwnerId"
  | "contactName"
  | "contactEmail"
  // Needed to tell a REAL owner from the shadow pair venue outreach attaches
  // to an unclaimed inquiry (booking-inquirer-outreach) — see the resolver.
  | "claimedAt"
>;

/** Map key for a performer owner ref, e.g. `human:<id>` / `organization:<id>`. */
export function performerOwnerKey(
  ownerType: PerformerOwnerType,
  ownerId: string,
): string {
  return `${ownerType}:${ownerId}`;
}

/**
 * Batch-resolve display names for the distinct performer owners in `records`:
 * one `humans.getByIds` + one `organizations.getByIds` total — never per row.
 * Owners that no longer resolve (or humans without a name) are omitted; the
 * caller falls back to `null`. Corrupt rows (neither identity) are skipped
 * here — reporting them is the caller's job, once per row.
 */
export async function resolvePerformerDisplayNames(
  repos: Pick<Repos, "humans" | "organizations">,
  records: readonly PerformerSenderRow[],
): Promise<Map<string, string>> {
  const humanIds = new Set<string>();
  const orgIds = new Set<string>();
  for (const record of records) {
    let sender;
    try {
      sender = getBookingRequestSender(record);
    } catch {
      continue;
    }
    // Anonymous senders have no platform entity to resolve — their display
    // identity is the contact fields. So do UNCLAIMED inquiries that carry a
    // shadow owner pair: resolving it would put the shadow Human's name in
    // front of the venue instead of the name the inquirer submitted.
    if (sender.kind !== "owned") continue;
    if (isUnclaimedBookingInquiry(record)) continue;
    if (sender.performerOwnerType === "human") {
      humanIds.add(sender.performerOwnerId);
    } else {
      orgIds.add(sender.performerOwnerId);
    }
  }

  const [humans, orgs] = await Promise.all([
    humanIds.size > 0 ? repos.humans.getByIds([...humanIds]) : [],
    orgIds.size > 0 ? repos.organizations.getByIds([...orgIds]) : [],
  ]);

  const names = new Map<string, string>();
  for (const human of humans) {
    if (human.name) names.set(performerOwnerKey("human", human.id), human.name);
  }
  for (const org of orgs) {
    names.set(performerOwnerKey("organization", org.id), org.name);
  }
  return names;
}

/**
 * The resolved platform display name for ONE row, out of a batch from
 * {@link resolvePerformerDisplayNames}. Null for anonymous senders (their
 * name is `contactName`, a different field with different trust), for
 * UNCLAIMED inquiries carrying a venue-outreach shadow pair, for owners that
 * did not resolve, and for corrupt rows.
 */
export function lookupPerformerDisplayName(
  record: PerformerSenderRow,
  names: ReadonlyMap<string, string>,
): string | null {
  let sender;
  try {
    sender = getBookingRequestSender(record);
  } catch {
    return null;
  }
  if (sender.kind !== "owned") return null;
  if (isUnclaimedBookingInquiry(record)) return null;
  return (
    names.get(
      performerOwnerKey(sender.performerOwnerType, sender.performerOwnerId),
    ) ?? null
  );
}
