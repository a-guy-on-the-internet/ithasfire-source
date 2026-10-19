import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { getEventForEdit } from "../get-event-for-edit";
import { ensureActorCanEditEvent } from "../_shared/ensure-actor-can-edit-event";

// Risk mitigation for community-managed-event-listings (FR-006/FR-008):
// COMMUNITY listings are ownerless — direct edits must be rejected
// EXPLICITLY (not just via the null-owner fallthrough); every change flows
// through the moderated suggestion queue.
//
// THE TWO GUARDS NOW DIVERGE, AND THE DIVERGENCE IS THE DESIGN.
// `getEventForEdit` grew a COMMUNITY_MODERATION_ROLES branch because community
// listings are authored in the SAME EventBuilder as ticketed events, and the
// builder hydrates through it — a read of the listing's own fields.
// `ensureActorCanEditEvent` did NOT, because it gates a dozen OWNED-event write
// surfaces (settings, access controls, application-form CRUD, listing
// priority, provenance) that an ownerless RSVP listing has no business
// carrying. Both halves are pinned here so neither can drift into the other.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

function makeCommunityEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "PUBLISHED",
    timezone: "America/Chicago",
    publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    ...overrides,
  });
}

/** Read-side repos `getEventForEdit` touches past the authz gate. */
function makeEditRepos(event: EventRecord) {
  const getOrgMembership = vi.fn(async () => null);
  return {
    getOrgMembership,
    repos: {
      events: {
        getById: vi.fn(async () => event),
        getContent: vi.fn(async () => null),
        getPopularityStats: vi.fn(async () => []),
      },
      places: { getById: vi.fn(async () => null) },
      categories: { getById: vi.fn(async () => null) },
      payoutTerms: { getById: vi.fn(async () => null) },
      seriesOccurrences: {
        getCalendarInfoForEventIds: vi.fn(async () => []),
      },
      series: { getById: vi.fn(async () => null) },
      authz: { getOrgMembership },
    } as unknown as Repos,
  };
}

const staffAuthz = (allowed: boolean) => ({
  hasStaffRole: vi.fn(async () => ({ allowed })),
});

describe("getEventForEdit COMMUNITY moderator branch", () => {
  it("lets a COMMUNITY_MODERATOR hydrate a DRAFT listing — community is authored in the SAME builder", async () => {
    const event = makeCommunityEvent({ status: "DRAFT", publishedAt: null });
    const { repos } = makeEditRepos(event);
    const authz = staffAuthz(true);

    const result = await getEventForEdit(
      { repos, authz },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
    );

    expect(result.id).toBe(EVENT_ID);
    expect(result.status).toBe("DRAFT");
    // The gate is the SAME role set community.createListing / publishListing /
    // updateListing use — not a new one invented for hydration.
    expect(authz.hasStaffRole).toHaveBeenCalledWith(
      expect.objectContaining({
        actorHumanId: ACTOR_ID,
        requiredRoles: expect.arrayContaining(["COMMUNITY_MODERATOR", "ADMIN"]),
      }),
    );
  });

  it("lets a moderator hydrate a PUBLISHED listing too (the write gate is what is DRAFT-only)", async () => {
    const { repos } = makeEditRepos(makeCommunityEvent());

    await expect(
      getEventForEdit(
        { repos, authz: staffAuthz(true) },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).resolves.toMatchObject({ id: EVENT_ID, status: "PUBLISHED" });
  });

  // THE HALF THAT MUST NOT HAVE MOVED. A non-moderator's refusal has to be
  // byte-identical to what it was before the branch existed — same code, same
  // meta — or the branch itself becomes the signal.
  it("still refuses a signed-in stranger with the SAME NOT_RESOURCE_OWNER as before", async () => {
    const { repos, getOrgMembership } = makeEditRepos(makeCommunityEvent());

    await expect(
      getEventForEdit(
        { repos, authz: staffAuthz(false) },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "event" },
    });
    // Short-circuits before any org-membership lookup, exactly as it always did.
    expect(getOrgMembership).not.toHaveBeenCalled();
  });

  it("still refuses an ORG member who is not a moderator", async () => {
    // Being an editor of SOME org buys nothing on an ownerless listing: the
    // community branch is the only way through, and it is role-gated.
    const { repos, getOrgMembership } = makeEditRepos(makeCommunityEvent());
    getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "OWNER",
    } as never);

    await expect(
      getEventForEdit(
        { repos, authz: staffAuthz(false) },
        { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "event" },
    });
    expect(getOrgMembership).not.toHaveBeenCalled();
  });
});

describe("ensureActorCanEditEvent COMMUNITY rejection", () => {
  function makeTx(event: EventRecord) {
    const getOrgMembership = vi.fn(async () => null);
    const tx = {
      events: {
        getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
      },
      authz: { getOrgMembership },
    } as unknown as TxRepos;
    return { tx, getOrgMembership };
  }

  it("rejects a COMMUNITY listing with INSUFFICIENT_ROLE", async () => {
    const { tx, getOrgMembership } = makeTx(makeCommunityEvent());

    await expect(
      ensureActorCanEditEvent(tx, EVENT_ID, ACTOR_ID),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(getOrgMembership).not.toHaveBeenCalled();
  });

  // The counterpart to the hydration branch above. This guard fronts
  // updateEventSettings / updateEventAccessControls / the application-form
  // CRUD / setEventListingPriority / getEventProvenance — none of which an
  // ownerless RSVP listing should carry, and none of which pass the FR-007
  // field whitelist. It takes no authz port at all, so a moderator is
  // structurally incapable of reaching through it; this pins that the
  // hydration change did not quietly plumb one in.
  it.each(["DRAFT", "PUBLISHED"] as const)(
    "stays shut on a %s COMMUNITY listing even though hydration opened — writes go through community.updateListing",
    async (status) => {
      const { tx } = makeTx(
        makeCommunityEvent({
          status,
          publishedAt: status === "DRAFT" ? null : new Date(),
        }),
      );

      await expect(
        ensureActorCanEditEvent(tx, EVENT_ID, ACTOR_ID),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    },
  );

  it("still allows the personal owner of an OWNED event", async () => {
    const owned = makeStubEventRecord({
      id: EVENT_ID,
      orgId: null,
      humanId: ACTOR_ID,
      stewardship: "OWNED",
      attendanceMode: "TICKETED",
      timezone: "America/Chicago",
    });
    const { tx } = makeTx(owned);

    await expect(
      ensureActorCanEditEvent(tx, EVENT_ID, ACTOR_ID),
    ).resolves.toMatchObject({ id: EVENT_ID });
  });
});
