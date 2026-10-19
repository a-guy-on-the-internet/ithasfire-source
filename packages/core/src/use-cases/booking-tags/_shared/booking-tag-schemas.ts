import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { BookingTagRecord } from "@th/ports/repos/booking-tags";
import type { PlaceRecord } from "@th/ports/repos/places";
import { fail } from "@th/errors";

import { sanitizeText, truncate } from "../../../lib/slug-utils";
import { plainTextRequired } from "../../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES } from "../../../lib/rbac";
import { requirePlaceOwnership } from "../../booking-requests/_shared/place-access";

// ─────────────────────────────────────────────────────────────────────────────
// Org booking tags (booking-holds spec FR-017) — shared vocabulary.
// Venue-internal labels on booking requests; never projected to the act.
// ─────────────────────────────────────────────────────────────────────────────

/** Design-token NAMES, never hex — the UI maps each to a chip variant. */
export const BOOKING_TAG_COLORS = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "danger",
] as const;

export type BookingTagColor = (typeof BOOKING_TAG_COLORS)[number];

export const BOOKING_TAG_NAME_MAX = 40;
export const BOOKING_TAG_SLUG_MAX = 48;

export const bookingTagColorSchema = z.enum(BOOKING_TAG_COLORS);

/** Sanitized (house `plainText*` helper BEFORE the length cap) tag name. */
export const bookingTagNameSchema = plainTextRequired(BOOKING_TAG_NAME_MAX);

export const bookingTagOutputSchema = z
  .object({
    id: z.uuid(),
    orgId: z.uuid(),
    name: z.string(),
    slug: z.string(),
    color: z.string(),
    sortOrder: z.number().int(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict();

export type BookingTagOutput = z.infer<typeof bookingTagOutputSchema>;

export function toBookingTagOutput(tag: BookingTagRecord): BookingTagOutput {
  return {
    id: tag.id,
    orgId: tag.orgId,
    name: tag.name,
    slug: tag.slug,
    color: tag.color,
    sortOrder: tag.sortOrder,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

/**
 * Per-org unique slug from a display name — the event-tag normalisation
 * (`sanitizeText`: NFKD, strip marks, non-alphanumeric runs → `-`, lower),
 * capped at the slug bound. A name that sanitizes to nothing ("!!!") is
 * rejected as invalid input rather than colliding on an empty slug.
 */
export function toBookingTagSlug(name: string): string {
  const slug = sanitizeText(name);
  if (!slug) {
    throw {
      code: "invalid_input",
      message: "invalid_input",
      issues: [{ code: "custom", message: "booking_tag_name_unsluggable", path: ["name"] }],
    } as const;
  }
  return truncate(slug, BOOKING_TAG_SLUG_MAX);
}

/** The adapter's (orgId, slug) unique → domain error. */
export function isTagSlugTakenConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "conflict" &&
    (error as { message?: unknown }).message === "booking_tag_slug_taken"
  );
}

/**
 * The org whose tags a TO_VENUE request can wear: the org the actor's
 * edit-role access came through, else the place's first owning org. A venue
 * owned directly by a human has no org and therefore no tags (FR-017 tags are
 * ORG-scoped) → BOOKING_TAG_NOT_FOUND for any non-empty attach.
 */
export async function resolveRequestTagOrg(
  repos: Pick<Repos, "authz">,
  place: PlaceRecord,
  actorHumanId: string,
): Promise<string | null> {
  const ownership = await requirePlaceOwnership(repos, place, actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });
  if (ownership.via === "org" && ownership.orgId) return ownership.orgId;
  return place.orgIdsWithAccess[0] ?? null;
}

export function requireTagRow<T>(row: T | null, meta: Record<string, unknown>): T {
  if (!row) {
    throw fail("BOOKING_TAG_NOT_FOUND", { meta });
  }
  return row;
}
