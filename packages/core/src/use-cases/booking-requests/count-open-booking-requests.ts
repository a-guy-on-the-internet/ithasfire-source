import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import { OPEN_BOOKING_REQUEST_STATUSES } from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import { ORG_ANY_ROLE, requireOrgMembership } from "../../lib/rbac";
import {
  listOwnerScopePlaces,
  type OwnerScope,
} from "./_shared/org-owned-places";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHOSE counts: an org (by id) or the actor themself as a direct venue owner.
 * Discriminated so the human case cannot be spelled by omission — a caller
 * that forgets `orgId` must not silently get a plausible-looking personal
 * count instead of a validation error.
 */
export const countOpenBookingRequestsOwnerSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("org"), orgId: z.uuid() }).strict(),
    /**
     * The PERSONAL admin context: the actor's own directly-owned venues
     * (PlaceOwnership HUMAN) PLUS the venues of every org the actor belongs
     * to. Carries no id by construction — the subject is always the session
     * actor, so a caller cannot count someone else's venues.
     */
    z.object({ kind: z.literal("human") }).strict(),
  ],
);

/**
 * Pre-refine base — the transport derives its client input from THIS (the
 * cross-field refine below blocks `.omit()`), and the use case re-parses with
 * the refined schema so the selector rule is enforced either way.
 */
export const countOpenBookingRequestsBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    /**
     * LEGACY selector — the org whose open counts are summarized. Kept so
     * every existing `countOpen({ orgId })` caller stays valid; equivalent to
     * `owner: { kind: "org", orgId }`.
     */
    orgId: z.uuid().optional(),
    /** Explicit selector (org by id, or the actor as a human venue owner). */
    owner: countOpenBookingRequestsOwnerSchema.optional(),
  })
  .strict();

export const countOpenBookingRequestsInputSchema =
  countOpenBookingRequestsBaseSchema.superRefine((value, ctx) => {
    // Exactly ONE selector. Both is ambiguous (which org? or a human?) and
    // neither is the silent-default footgun the discriminant exists to kill.
    const selectors = [value.orgId, value.owner].filter(
      (selector) => selector !== undefined,
    ).length;
    if (selectors !== 1) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of orgId or owner is required",
        path: ["owner"],
      });
    }
  });

export const countOpenBookingRequestsOutputSchema = z
  .object({
    /**
     * Open TO_PERFORMER requests addressed to the owner AS AN ACT — for an org
     * the exact row set `listBookingRequests({ scope: "performer-inbox",
     * performerOwnerType: "org" })` renders; for a human owner, the actor's
     * own `performer-inbox` (default human identity).
     */
    performerInbox: z.number().int().nonnegative(),
    /**
     * THE AUTHORITATIVE VENUE LIST for the Bookings surface — not a
     * count sidecar. One entry per place the selected scope covers (an org's
     * holdings, or the actor's own plus their orgs'), in the owned-places
     * listing order (name asc, id asc), carrying the display name so the
     * venue block renders entirely off THIS response: one `countOpen` call,
     * no companion place query (FR-006's "network panel: one countOpen call").
     *
     * Consumers must NOT pair these entries against a separately-fetched place
     * list. The two would be different SETS: `places.listHumanPlaces({
     * ownedOnly: true })` filters ownership WITHOUT the `verified: true` /
     * `revokedAt IS NULL` clauses this list requires (prisma/places.ts:332-358
     * vs :499-537), so it can show venues that are correctly absent here — and
     * "absent" would silently render as "0 open". Conversely this list is
     * `status: "ACTIVE"`-scoped while `requirePlaceOwnership` checks no
     * status, so a SUSPENDED/ARCHIVED owned venue's inbox still opens and can
     * hold open requests that never appear in a count. One list, one truth.
     *
     * Places with no open request are present with `openCount: 0` — the badge
     * is the only conditional bit, so a missing entry would be
     * indistinguishable from "we didn't look".
     */
    venues: z.array(
      z
        .object({
          placeId: z.uuid(),
          /** Denormalized display name, from the same owned-places read. */
          placeName: z.string(),
          openCount: z.number().int().nonnegative(),
          /**
           * The venue's programming calendars — the OPTIONS of the inbox's
           * grouped filter, where the venue itself is the group.
           *
           * Authoritative, and here rather than derived from the loaded rows,
           * for the same reason the venue list is: a calendar missing from
           * this array cannot be filtered to, and its requests would read as
           * "nothing there" rather than "we never offered you that choice". A
           * calendar with no requests is legitimately empty and must still be
           * selectable.
           *
           * Empty only for a place with no calendars at all (pre-hierarchy
           * data); a venue-side request always routes to one, so an empty
           * array on a venue that HAS requests is a data defect, not a state
           * the UI needs to model.
           */
          calendars: z.array(
            z.object({ id: z.uuid(), name: z.string() }).strict(),
          ),
        })
        .strict(),
    ),
    /**
     * True when the owner holds MORE active places than one response carries
     * (`MAX_OWNED_PLACES` in `_shared/org-owned-places.ts`) and the tail was
     * cut. Truncation is silent
     * and alphabetical at the repo, so without this flag the cut venues would
     * be ABSENT rather than `openCount: 0` — reproducing, at 100 venues, the
     * exact ">N venues get no badge" hole FR-006 exists to kill, and making
     * the FR-007 rail sum undercount. Surfaced so the UI can say "showing the
     * first 100 venues" instead of mislabelling the rest as quiet.
     */
    ownedPlacesTruncated: z.boolean(),
  })
  .strict();

export type CountOpenBookingRequestsInput = z.infer<
  typeof countOpenBookingRequestsInputSchema
>;
export type CountOpenBookingRequestsOutput = z.infer<
  typeof countOpenBookingRequestsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NO `reportError` here, deliberately (NFR-004 + the ReporterPort convention
 * in CLAUDE.md): this use case has no catch-and-fallback branch. Every failure
 * — authz, places lookup, either count — propagates, and the tRPC/fastify
 * backstop captures it. A reporter would only be correct if a swallow existed;
 * declaring one without a swallow is cargo cult. The BADGE's fail-soft
 * behaviour (FR-007) lives in the UI query, not in here.
 */
export type CountOpenBookingRequestsDeps = {
  repos: Pick<Repos, "bookingRequests" | "places" | "authz" | "calendars">;
};

// The owned-place ceiling and its truncation signal live in
// `_shared/org-owned-places.ts` — shared verbatim with
// `listBookingRequests({ scope: "org-venues" | "human-venues" })`, the inbox
// these badges link into, so the two surfaces can never disagree about which
// venues an owner holds.
// A `reportError` would be wrong for the cut (there is no swallow here); the
// `ownedPlacesTruncated` flag is the honest fix.

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open-request counts for an org in one call (booking-inbox-placement FR-006):
 * the org-as-act inbox plus a per-owned-venue breakdown. Powers the Bookings
 * hub badges and the admin rail badge, replacing the hub's capped fan-out of
 * full list queries.
 *
 * "Open" is the ONE shared definition — `OPEN_BOOKING_REQUEST_STATUSES`
 * (PENDING | VIEWED) from `@th/types/repos/booking-requests`, the single
 * module the repo finders, this use case AND the web `OPEN_BOOKING_STATUSES`
 * filter now all import (the web copy was an independent hand-written literal
 * until this change; it is a re-export now). Re-declaring the set is how the
 * badges would drift from the lists they summarize — the spec's LOW risk,
 * "countOpen and the list views disagree" — so the constant is imported once
 * and forwarded to BOTH counts.
 *
 * Authz mirrors the list scopes this summarizes, not something stricter:
 * - org owner: `requireOrgMembership(ORG_ANY_ROLE)` — the same gate as
 *   `listBookingRequests({ scope: "organizer" | "org-venues" })` and the
 *   org-act `performer-inbox` scope, so a non-member gets the identical
 *   `INSUFFICIENT_ROLE` shape.
 * - human owner: NO gate — the owner is the actor (`owner.kind: "human"`
 *   carries no id by construction, so a caller cannot name another human).
 *   Same posture as `listBookingRequests({ scope: "human-venues" })`.
 * Venue counts are restricted to the places the SCOPE actually covers via
 * `listOwnerScopePlaces` — for an org, that org's holdings and nothing else;
 * for the personal context, the actor's own venues plus their orgs'. Its
 * verified + non-revoked ownership predicate (and, for the org leg,
 * membership-any) is exactly the relation `requirePlaceOwnership` reads on the
 * view path — so nothing here can name a venue the caller cannot already open
 * the inbox for one at a time.
 *
 * READ-ONLY (NFR-003): COUNT/groupBy queries only — no `viewedAt` stamping, no
 * writes, no side effects. Two waves of round trips (membership+inbox count +
 * owned places, then the grouped venue count).
 */
export async function countOpenBookingRequests(
  deps: CountOpenBookingRequestsDeps,
  rawInput: unknown,
): Promise<CountOpenBookingRequestsOutput> {
  const input = parseInput(countOpenBookingRequestsInputSchema, rawInput);

  // Resolve the selector to ONE subject. `orgId` is the legacy spelling of
  // `owner: { kind: "org" }`; the refine guarantees exactly one is present.
  const orgId =
    input.owner?.kind === "org" ? input.owner.orgId : (input.orgId ?? null);

  let subject: OwnerScope;
  let performerOwner: { ownerType: "organization" | "human"; ownerId: string };
  if (orgId !== null) {
    await requireOrgMembership({
      repos: deps.repos,
      orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_ANY_ROLE,
    });
    subject = { kind: "org", orgId };
    // The org AS AN ACT: the owner pair is `{ organization, orgId }` — the
    // repo's `PerformerOwnerType` vocabulary is "organization", NOT the list
    // input's "org" (list-booking-requests.ts does the same mapping).
    performerOwner = { ownerType: "organization", ownerId: orgId };
  } else {
    subject = { kind: "human", humanId: input.actorHumanId };
    // The actor AS AN ACT — the same row set the human `performer-inbox`
    // list scope reads (default human identity).
    performerOwner = { ownerType: "human", ownerId: input.actorHumanId };
  }

  const statuses = [...OPEN_BOOKING_REQUEST_STATUSES];

  const [performerInbox, owned] = await Promise.all([
    // Reuses the existing set-shaped count rather than adding a redundant
    // single-owner method.
    deps.repos.bookingRequests.countForPerformerInbox({
      owners: [performerOwner],
      statuses,
    }),
    listOwnerScopePlaces(deps.repos, subject),
  ]);

  const ownedPlaces = owned.places;
  const placeIds = ownedPlaces.map((place) => place.id);

  // Explicit short circuit for act-only orgs (no venues): the repo would
  // short-circuit too, but skipping the call keeps "pure act org ⇒ zero venue
  // queries" a testable property of the use case rather than an adapter
  // detail.
  // Both reads are keyed on the SAME owned-place set and neither depends on
  // the other, so they go out together — the calendar list is an option set
  // for the inbox's filter, not a second page load.
  const [grouped, calendars] = await Promise.all([
    placeIds.length > 0
      ? deps.repos.bookingRequests.countOpenByPlace({ placeIds, statuses })
      : Promise.resolve([]),
    deps.repos.calendars.listByPlaceIds(placeIds),
  ]);

  const calendarsByPlace = new Map<string, { id: string; name: string }[]>();
  for (const calendar of calendars) {
    const list = calendarsByPlace.get(calendar.placeId) ?? [];
    list.push({ id: calendar.id, name: calendar.name });
    calendarsByPlace.set(calendar.placeId, list);
  }

  // ZERO-FILL: `groupBy` emits no row for a place with no open requests, but
  // the contract is one entry per OWNED place (FR-006 acceptance: two places
  // with 3 and 0 opens return counts 3/0). Driving the output off the OWNED
  // PLACE RECORDS — not off the grouped rows — pins the response to owned
  // places only and carries each venue's display name, so the Bookings venue
  // block needs no second place query.
  const openByPlaceId = new Map(
    grouped.map((row) => [row.placeId, row.openCount]),
  );

  return countOpenBookingRequestsOutputSchema.parse({
    performerInbox,
    venues: ownedPlaces.map((place) => ({
      placeId: place.id,
      placeName: place.name,
      openCount: openByPlaceId.get(place.id) ?? 0,
      // Same zero-fill discipline as the counts: an owned place with no
      // calendars is present with an empty array, never absent.
      calendars: calendarsByPlace.get(place.id) ?? [],
    })),
    ownedPlacesTruncated: owned.truncated,
  });
}
