import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadEventSeo } from "@/server/events";

import { ListingSchedule } from "./_components/ListingSchedule";
import { OutOfScopeNotice } from "./_components/OutOfScopeNotice";

export const metadata: Metadata = {
  title: "Listing schedule",
  description: "Change the recurrence rule on a community listing.",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/moderate/listings/[eventId]/schedule` — the whole schedule of ONE
 * community listing.
 *
 * ── THERE IS NO LISTINGS INDEX, ON PURPOSE ─────────────────────────────────
 *
 * Nothing links to `/moderate/listings`, and nothing is missing. The one way
 * in is the "Manage schedule" link on the listing's own public event page
 * (the moderator bar inside its "Upcoming dates" section): a moderator gets
 * here because they were already looking at the listing, so an index was
 * shelved rather than built. If one is ever wanted it links here unchanged —
 * this route reads its subject entirely from the path.
 *
 * ── ACCESS ─────────────────────────────────────────────────────────────────
 *
 * Inherited, not re-implemented. `/moderate/**` is gated three times over:
 * the edge middleware (`middleware/staff-route-gate.ts`) fronts it with
 * `community.checkModeratorAccess` AND the step-up 2FA requirement,
 * `moderate/layout.tsx` re-checks server-side and redirects to `/sign-in`,
 * `/access-denied` or `/enroll-2fa`, and `ModerateShell` re-checks on the
 * client. This page adds no gate of its own — a fourth copy of the
 * authorization matrix is how they drift.
 *
 * What it DOES check is SCOPE: recurrence editing is a community-listing
 * capability, and `updateCommunityRecurrence` refuses anything else with
 * `EVENT_NOT_COMMUNITY`. Answering that here means an org-owned event gets a
 * sentence instead of a page full of controls that cannot work.
 */
export default async function ModerateListingSchedulePage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  // The id is a path segment and reaches a `z.uuid()` input either way; failing
  // here keeps a junk URL out of the API entirely.
  if (!UUID_RE.test(eventId)) {
    notFound();
  }

  // `loadEventSeo` resolves slug-or-id (the events repo accepts a UUID as a
  // stable fallback identifier) and is `cache()`d per request.
  const event = await loadEventSeo(eventId);
  if (!event) {
    notFound();
  }

  if (event.stewardship !== "COMMUNITY") {
    return <OutOfScopeNotice />;
  }

  return (
    <ListingSchedule
      eventId={event.id}
      title={event.name}
      // `getEventSeo` types `timezone` as optional — a community listing always
      // carries one (the create use case requires it), and UTC is the honest
      // degrade for a legacy row: a wrong zone is a wrong time on every row.
      timezone={event.timezone ?? "UTC"}
      startsAtIso={event.startsAt.toISOString()}
      listingHref={`/events/${event.slug}`}
      listingStatus={event.status}
    />
  );
}
