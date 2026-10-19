/**
 * A listing in one of these states no longer takes changes: the server refuses
 * restoring a night, a new recurrence rule and approving an edit suggestion.
 * CANCELLED and ARCHIVED read as "taken down"; COMPLETED reads as "ended".
 */
export type ListingClosedKind = "takenDown" | "ended";

export function listingClosedKind(
  status: string | null | undefined,
): ListingClosedKind | null {
  if (status === "CANCELLED" || status === "ARCHIVED") return "takenDown";
  if (status === "COMPLETED") return "ended";
  return null;
}

/**
 * The appCodes the server answers with when a write lands on a closed
 * listing — the status changed after the page loaded.
 */
export function listingClosedKindFromAppCode(
  appCode: string | null | undefined,
): ListingClosedKind | null {
  if (appCode === "EVENT_ALREADY_CANCELLED" || appCode === "EVENT_ARCHIVED") {
    return "takenDown";
  }
  if (appCode === "EVENT_ALREADY_COMPLETED") return "ended";
  return null;
}
