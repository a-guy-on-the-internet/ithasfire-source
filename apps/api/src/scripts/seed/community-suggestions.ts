import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { encodeGeohash } from "@th/core/lib/geo/geohash";

import { DEMO_IDS } from "./ids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Community edit-suggestion fixtures
//
// Gives the community moderation surfaces real data to review:
//   - one PUBLISHED, PUBLIC, ownerless COMMUNITY listing (RSVP), and
//   - four PENDING EventEditSuggestion rows —
//       three against the community listing (anonymous + two authed), so the
//       moderator queue (/moderate/suggestions, scope "community") is non-empty,
//       and one against an existing demo-org event, so the FR-016 owner/org
//       "Suggestions" inbox (scope "org", listForOwner) also has data.
//
// Idempotent: everything is upserted by a deterministic id. Re-running the seed
// resets each suggestion back to PENDING (clears any prior review outcome) so
// the queues are always reviewable after a fresh seed. `fields` are a subset of
// the whitelisted edit fields; `baseVersion` mirrors the server's
// `snapshotSuggestionBase` (packages/core/.../events/_shared/suggestion-fields.ts)
// so conflict detection finds no drift on approve.
//
// NOTE: the listing body is intentionally kept null and the free text avoids
// apostrophe contractions to steer clear of a content-filter false positive.
//
// RELATED: an older standalone script `apps/api/src/scripts/seed-community-
// suggestions.ts` also creates community-suggestion test data, but by driving
// the real use cases (non-idempotent, re-inserts on every run). THIS module is
// the idempotent in-seed-run fixture (upsert by deterministic id) wired into
// `seed-data.ts`. The two overlap; retiring the standalone script is a human
// decision — do not delete it here.
// ─────────────────────────────────────────────────────────────────────────────

/** The whitelisted-field snapshot the review pipeline compares against. */
type SuggestionBaseFields = {
  id: string;
  title: string;
  body: unknown | null;
  startsAt: Date;
  endsAt: Date | null;
  timezone: string;
  addressText: string | null;
  countryCode: string | null;
  region: string | null;
  locality: string | null;
  postalCode: string | null;
  lat: number | null;
  lng: number | null;
  categoryId: string | null;
  heroImageId: string | null;
  ageLimit: number | null;
};

const SUGGESTION_BASE_SELECT = {
  id: true,
  title: true,
  body: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  addressText: true,
  countryCode: true,
  region: true,
  locality: true,
  postalCode: true,
  lat: true,
  lng: true,
  categoryId: true,
  heroImageId: true,
  ageLimit: true,
} as const;

/**
 * Build the suggestion `baseVersion` snapshot from an event's CURRENT values.
 * Mirrors `snapshotSuggestionBase` exactly: same keys, dates as ISO strings,
 * absent values normalized to null.
 */
function snapshotBase(event: SuggestionBaseFields): Record<string, unknown> {
  return {
    title: event.title,
    content: event.body ?? null,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt ? event.endsAt.toISOString() : null,
    timezone: event.timezone,
    addressText: event.addressText ?? null,
    countryCode: event.countryCode ?? null,
    region: event.region ?? null,
    locality: event.locality ?? null,
    postalCode: event.postalCode ?? null,
    lat: event.lat ?? null,
    lng: event.lng ?? null,
    categoryId: event.categoryId ?? null,
    heroImageId: event.heroImageId ?? null,
    ageLimit: event.ageLimit ?? null,
  };
}

/** Upsert one PENDING suggestion, resetting any prior review outcome. */
async function upsertPendingSuggestion(
  prisma: PrismaClient,
  params: {
    id: string;
    eventId: string;
    submitterHumanId: string | null;
    submitterIp: string | null;
    fields: Record<string, unknown>;
    baseVersion: Record<string, unknown>;
    note: string | null;
  },
): Promise<void> {
  const data = {
    eventId: params.eventId,
    submitterHumanId: params.submitterHumanId,
    submitterIp: params.submitterIp,
    fields: params.fields as object,
    baseVersion: params.baseVersion as object,
    note: params.note,
    status: "PENDING" as const,
    // Clear any review outcome from a prior run so the queue is reviewable.
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
    // JsonNull sentinel: clear the applied/conflicted Json columns.
    appliedFields: Prisma.JsonNull,
    conflictedFields: Prisma.JsonNull,
  };
  await prisma.eventEditSuggestion.upsert({
    where: { id: params.id },
    update: data,
    create: { id: params.id, ...data },
  });
}

export const seedCommunityEditSuggestions = async (
  prisma: PrismaClient,
  opts: { communityCategoryId: string | null },
): Promise<{ communityEventSlug: string; suggestionCount: number }> => {
  // ── 1. Community listing (ownerless COMMUNITY + RSVP per the DB check) ────
  const now = new Date();
  const startsAt = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);
  startsAt.setUTCHours(23, 0, 0, 0); // 18:00 America/New_York-ish, stored UTC
  const endsAt = new Date(startsAt.getTime() + 3 * 60 * 60 * 1000);

  const lat = 40.662;
  const lng = -73.97;
  const geohash6 = encodeGeohash(lat, lng, 6);
  const slug = "community-neighborhood-jam";

  // `body` is intentionally left unset (defaults to NULL) — keeps
  // baseVersion.content deterministic and sidesteps the content-filter
  // false positive. Prisma rejects a literal `null` for Json columns.
  const listingBase = {
    title: "Community Board: Neighborhood Jam",
    startsAt,
    endsAt,
    status: "PUBLISHED" as const,
    visibility: "PUBLIC" as const,
    attendanceMode: "RSVP" as const,
    stewardship: "COMMUNITY" as const,
    gateType: "NONE" as const,
    timezone: "America/New_York",
    addressText: "Prospect Park Bandshell, Brooklyn, NY 11215",
    countryCode: "US",
    region: "NY",
    locality: "Brooklyn",
    postalCode: "11215",
    lat,
    lng,
    geohash6,
    regionCode: "ny-nyc",
    categoryId: opts.communityCategoryId,
    // Ownerless — required by event_community_ownerless_rsvp_check.
    orgId: null,
    humanId: null,
    placeId: null,
    savedLocationId: null,
    ageLimit: null,
    publishedAt: now,
  };

  await prisma.event.upsert({
    where: { id: DEMO_IDS.communityEvent },
    update: { ...listingBase, slug },
    create: { id: DEMO_IDS.communityEvent, slug, ...listingBase },
  });

  // Read the listing back so baseVersion reflects the actually-stored values.
  const communityEvent = (await prisma.event.findUniqueOrThrow({
    where: { id: DEMO_IDS.communityEvent },
    select: SUGGESTION_BASE_SELECT,
  })) as SuggestionBaseFields;
  const communityBaseVersion = snapshotBase(communityEvent);

  // ── 2a. Anonymous suggestion (title casing fix) ──────────────────────────
  await upsertPendingSuggestion(prisma, {
    id: DEMO_IDS.communitySuggestionAnon,
    eventId: communityEvent.id,
    submitterHumanId: null,
    submitterIp: "203.0.113.10",
    fields: { title: "Community Board — Neighborhood Jam (fixed casing)" },
    baseVersion: communityBaseVersion,
    note: "The em dash reads cleaner than the colon on the card.",
  });

  // ── 2b. Authed suggestion (schedule nudge, +1h on both bounds) ───────────
  const proposedStart = new Date(
    communityEvent.startsAt.getTime() + 60 * 60 * 1000,
  );
  const proposedEnd = new Date(
    (communityEvent.endsAt ?? communityEvent.startsAt).getTime() +
      60 * 60 * 1000,
  );
  await upsertPendingSuggestion(prisma, {
    id: DEMO_IDS.communitySuggestionSchedule,
    eventId: communityEvent.id,
    submitterHumanId: DEMO_IDS.human2,
    submitterIp: null,
    fields: {
      startsAt: proposedStart.toISOString(),
      endsAt: proposedEnd.toISOString(),
    },
    baseVersion: communityBaseVersion,
    note: "Pushing an hour later so folks can get there after work.",
  });

  // ── 2c. Authed suggestion (age limit) ────────────────────────────────────
  await upsertPendingSuggestion(prisma, {
    id: DEMO_IDS.communitySuggestionAge,
    eventId: communityEvent.id,
    submitterHumanId: DEMO_IDS.human4,
    submitterIp: null,
    fields: { ageLimit: 18 },
    baseVersion: communityBaseVersion,
    note: "The bar in the park serves alcohol, so this should be 18 plus.",
  });

  // ── 3. Suggestion against an existing demo-org event (FR-016 org inbox) ───
  // Resolve a stable PUBLISHED event owned by the primary demo org.
  const orgEvent = (await prisma.event.findFirst({
    where: { orgId: DEMO_IDS.org, status: "PUBLISHED" },
    orderBy: { slug: "asc" },
    select: SUGGESTION_BASE_SELECT,
  })) as SuggestionBaseFields | null;

  let suggestionCount = 3;
  if (orgEvent) {
    await upsertPendingSuggestion(prisma, {
      id: DEMO_IDS.orgEventSuggestion,
      eventId: orgEvent.id,
      submitterHumanId: DEMO_IDS.human3,
      submitterIp: null,
      // FIXED short replacement (well under the 140-char title cap) — must NOT
      // be derived from the resolved event's current title, or a long org
      // title could push the proposed value past 140 and make this suggestion
      // non-approvable, defeating the org-inbox surface it exists to exercise.
      fields: { title: "Community copy edit — corrected event title" },
      baseVersion: snapshotBase(orgEvent),
      note: "Small copy edit for the event title.",
    });
    suggestionCount += 1;
  } else {
    console.warn(
      "  [community-suggestions] No PUBLISHED demo-org event found — skipped org-inbox suggestion.",
    );
  }

  return { communityEventSlug: slug, suggestionCount };
};
