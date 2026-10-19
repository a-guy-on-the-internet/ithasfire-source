import { describe, expect, it, vi } from "vitest";

import {
  createCommunityListing,
  type CreateCommunityListingDeps,
} from "../create-community-listing";
import type { CreateCommunityListingInput as RepoCreateInput } from "@th/ports/repos/events";
import { ADMIN_ID, MODERATOR_ID, NOW, makeClock, makeContentFilter, makeStaffAuthz } from "./helpers";

/**
 * A community listing used to be born PUBLISHED, full stop. It can now be born
 * DRAFT so it can be authored in the real EventBuilder (the body-image and
 * hero upload paths key to `events/{eventId}/...`, so the row has to exist
 * before it is public).
 *
 * Two things are pinned here and they pull in opposite directions:
 *  1. DRAFT actually behaves like a draft — null `publishedAt`, and it does
 *     NOT settle held dates (an invisible listing must not evict a venue's
 *     holds; `publishCommunityListing` is where that happens).
 *  2. Every EXISTING caller is untouched. `status` defaults to "PUBLISHED",
 *     so the standalone moderator form, the QA seed script and the original
 *     create tests all keep create-is-go-live without passing anything.
 */

const CREATED_EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const VALID_INPUT = {
  actorHumanId: MODERATOR_ID,
  title: "Weekly Open Mic",
  startsAt: new Date("2026-08-01T20:00:00.000Z"),
  endsAt: new Date("2026-08-01T23:00:00.000Z"),
  timezone: "America/Chicago",
  addressText: "123 Main St, Austin, TX",
  countryCode: "us",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.27,
  lng: -97.74,
};

function buildDeps(
  overrides: { calendarId?: string | null } = {},
) {
  const createCommunityListingMock = vi.fn(async (input: RepoCreateInput) => ({
    id: CREATED_EVENT_ID,
    orgId: null,
    humanId: null,
    title: input.title,
    status: input.status,
    attendanceMode: input.attendanceMode,
    stewardship: input.stewardship,
    visibility: "PUBLIC",
    gateType: "NONE",
    timezone: input.timezone,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    slug: input.slug,
    shortId: input.shortId,
    publishedAt: input.publishedAt,
    // The hold-settlement entry point reads this FIRST and no-ops on null.
    // Non-null in the "PUBLISHED settles" case so the call is observable.
    calendarId: overrides.calendarId ?? null,
  }));

  const audit = { log: vi.fn() };
  // settleHeldDatesForEvent's FIRST read once a calendar is present. Returning
  // null makes the helper no-op AFTER it has proved it was called at all —
  // which is exactly the signal these tests want (did the rule run, not what
  // it decided).
  const calendars = { findById: vi.fn(async () => null) };

  const txRepos = {
    events: { createCommunityListing: createCommunityListingMock },
    categories: { getById: vi.fn(async () => ({ id: "c", active: true })) },
    calendars,
    audit,
  };

  const deps: CreateCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as CreateCommunityListingDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    contentFilter: makeContentFilter(),
    // No `search` dep → reindexAfterMutation short-circuits, so nothing is
    // indexed from these tests either way.
  };

  return { deps, createCommunityListingMock, audit, calendars };
}

describe("createCommunityListing — DRAFT birth state", () => {
  it("writes status DRAFT with a NULL publishedAt", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    const result = await createCommunityListing(deps, {
      ...VALID_INPUT,
      status: "DRAFT",
    });

    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput.status).toBe("DRAFT");
    expect(repoInput.publishedAt).toBeNull();
    // Everything else about the row is unchanged — still ownerless RSVP.
    expect(repoInput).toMatchObject({
      attendanceMode: "RSVP",
      stewardship: "COMMUNITY",
    });
    expect(result.event.status).toBe("DRAFT");
  });

  it("does NOT settle held dates for a DRAFT, even with a calendar", async () => {
    const { deps, calendars } = buildDeps({
      calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });

    await createCommunityListing(deps, { ...VALID_INPUT, status: "DRAFT" });

    // settleHeldDatesForEvent's first act on a calendared event is this read.
    // Never reached ⇒ the hold rule never ran ⇒ no venue hold was evicted by
    // an invisible listing.
    expect(calendars.findById).not.toHaveBeenCalled();
  });

  it("DOES settle held dates when the listing is born PUBLISHED", async () => {
    const { deps, calendars } = buildDeps({
      calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    });

    await createCommunityListing(deps, { ...VALID_INPUT, status: "PUBLISHED" });

    // The counterpart of the test above: the FR-018 rule is still wired on the
    // path where a listing becomes live at create.
    expect(calendars.findById).toHaveBeenCalledTimes(1);
  });

  it("records the birth status on the audit row", async () => {
    const { deps, audit } = buildDeps();

    await createCommunityListing(deps, { ...VALID_INPUT, status: "DRAFT" });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "community_listing.created",
        data: expect.objectContaining({
          actorHumanId: MODERATOR_ID,
          status: "DRAFT",
        }),
      }),
    );
  });

  it("rejects a status outside DRAFT | PUBLISHED", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    await expect(
      createCommunityListing(deps, { ...VALID_INPUT, status: "CANCELLED" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(createCommunityListingMock).not.toHaveBeenCalled();
  });
});

describe("createCommunityListing — existing callers are unaffected", () => {
  it("defaults to PUBLISHED with a stamped publishedAt when status is omitted", async () => {
    const { deps, createCommunityListingMock } = buildDeps();

    // The EXACT payload shape every pre-change caller sends: no `status` key.
    const result = await createCommunityListing(deps, VALID_INPUT);

    const repoInput = createCommunityListingMock.mock.calls[0]![0];
    expect(repoInput.status).toBe("PUBLISHED");
    expect(repoInput.publishedAt).toEqual(NOW);
    expect(result.event.status).toBe("PUBLISHED");
  });
});

/**
 * Follower outbox at create. A listing is born ownerless and placeless today,
 * so nothing qualifies in production — the same "wired so the rule cannot be
 * missed" posture as the held-dates settle above. The repo fake returns a
 * venue-stamped row so the wiring is observable.
 */
describe("createCommunityListing — follower outbox", () => {
  const PLACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  function withStampedVenue() {
    const built = buildDeps();
    const base = built.createCommunityListingMock.getMockImplementation()!;
    built.createCommunityListingMock.mockImplementation(async (input: RepoCreateInput) => ({
      ...(await base(input)),
      placeId: PLACE_ID,
      locationMode: "EXACT",
      venueConfirmedAt: new Date("2026-06-30T00:00:00Z"),
      venueConfirmedPlaceId: PLACE_ID,
    }) as never);
    const enqueue = vi.fn();
    const original = built.deps.repos.tx;
    built.deps.repos.tx = ((fn: (tx: any) => unknown) => original(async (tx: any) => fn({
      ...tx,
      entityPages: { getByOwner: vi.fn(async (type: string, id: string) => ({ id: `${type}:${id}`, ownerType: type, ownerId: id, visibility: "PUBLIC", allowFollows: true })) },
      places: { getById: vi.fn(async () => ({ id: PLACE_ID, locationMode: "EXACT", orgIdsWithAccess: [], humanIdsWithAccess: [], acceptsCommunityListings: false })) },
      entityEventNotices: { enqueue },
    }))) as typeof built.deps.repos.tx;
    return { ...built, enqueue };
  }

  it("enqueues inside the create transaction when the listing is born PUBLISHED", async () => {
    const { deps, enqueue } = withStampedVenue();
    await createCommunityListing(deps, { ...VALID_INPUT, status: "PUBLISHED" });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ entityPageId: `PLACE:${PLACE_ID}`, eventId: CREATED_EVENT_ID, at: NOW });
  });

  it("does NOT enqueue a DRAFT", async () => {
    const { deps, enqueue } = withStampedVenue();
    await createCommunityListing(deps, { ...VALID_INPUT, status: "DRAFT" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does NOT enqueue a real (ownerless, placeless) listing", async () => {
    const { deps } = buildDeps();
    const enqueue = vi.fn();
    const original = deps.repos.tx;
    deps.repos.tx = ((fn: (tx: any) => unknown) => original(async (tx: any) => fn({ ...tx, entityEventNotices: { enqueue } }))) as typeof deps.repos.tx;
    await createCommunityListing(deps, { ...VALID_INPUT, status: "PUBLISHED" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
