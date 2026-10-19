import type { OwnerEntityWithSlug } from "@/hooks/useEventOwnerEntities";

export type ListingStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "CANCELLED"
  | "COMPLETED"
  | "ARCHIVED";

/** The filter's values: `ACTIVE` sends no status (DRAFT, PUBLISHED and COMPLETED; the server default). */
export type ListingFilter = "ACTIVE" | ListingStatus;

export const LISTING_FILTERS: readonly ListingFilter[] = [
  "ACTIVE",
  "DRAFT",
  "PUBLISHED",
  "CANCELLED",
  "COMPLETED",
  "ARCHIVED",
];

export const filterToStatus = (filter: ListingFilter): ListingStatus | undefined =>
  filter === "ACTIVE" ? undefined : filter;

/** Taking down (`cancelEvent`) works on a live or draft listing only. */
export const canTakeDownListing = (status: string): boolean =>
  status === "DRAFT" || status === "PUBLISHED";

/**
 * The platform admin's own person entry. Never the org one
 * (`preferredAdminSlug` prefers orgs): community listings are ownerless and
 * the editor opens under the admin's person.
 */
export function humanAdminSlug(
  owners: readonly OwnerEntityWithSlug[] | undefined,
): string | null {
  const human = owners?.find((o) => o.kind === "human");
  return human?.adminSlug ?? null;
}

export const listingEditHref = (adminSlug: string, eventId: string) =>
  `/admin/${adminSlug}/events/${eventId}/edit`;

export const newListingHref = (adminSlug: string) =>
  `/admin/${adminSlug}/events/new/community`;
