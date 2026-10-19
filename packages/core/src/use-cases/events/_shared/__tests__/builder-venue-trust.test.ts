import { describe, expect, it } from "vitest";

import type { Repos } from "@th/ports/repos";

import { createFakePlaceBookingGrantsRepo } from "../../../booking-holds/__tests__/fakes";
import { classifyBuilderVenueTrust } from "../builder-venue-trust";

// THE venue-trust classification (venue-confirmation spec), shared by the
// save (`resolveBuilderVenueTrust`) and the builder's pre-save read
// (`getPlaceBookingOptions.viewer.authority`). What is pinned here is the
// precedence the save relies on: the persisted row's owner columns
// (`eventOwner`) win over the pair `owner` implies, and the grant is matched
// on the event's OWNER as grantee (holds-without-a-request FR-002): the org
// for an org event, the person for a person's event. The "an org has no
// grant" rule ended with FR-002.

const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_PLACE_ID = "34343434-3434-4343-8343-343434343434";
const OWNING_ORG = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const NON_OWNER_ORG = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const HUMAN = "77777777-7777-4777-8777-777777777777";
const CALENDAR_ID = "ca1e0da1-1111-4111-8111-111111111111";
const OTHER_CALENDAR_ID = "ca1e0da2-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const PLACE = {
  id: PLACE_ID,
  orgIdsWithAccess: [OWNING_ORG],
  humanIdsWithAccess: [] as string[],
};

function buildRepos() {
  const grants = createFakePlaceBookingGrantsRepo();
  const repos = { placeBookingGrants: grants } as unknown as Pick<
    Repos,
    "placeBookingGrants"
  >;
  return { repos, grants };
}

describe("classifyBuilderVenueTrust", () => {
  it("(a) the persisted row's owner columns win over the human `owner`: venue_owned, no grant read", async () => {
    // An org-owned row (the org owns the place) being re-saved with a human
    // OwnerContext must still read as the venue's own event — the row is
    // the truth, not the pair `owner` implies.
    const { repos, grants } = buildRepos();
    grants.seed({ placeId: PLACE_ID, humanId: HUMAN });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "human", humanId: HUMAN },
      eventOwner: { orgId: OWNING_ORG, humanId: null },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "venue_owned" });
    expect(grants.findActiveForActor).not.toHaveBeenCalled();
  });

  it("(b) an org that does not own the place and holds no grant is a third party", async () => {
    const { repos, grants } = buildRepos();

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "org", orgId: NON_OWNER_ORG },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "third_party" });
    expect(grants.findActiveForActor).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: CALENDAR_ID,
      humanIds: [],
      orgIds: [NON_OWNER_ORG],
      now: NOW,
    });
  });

  it("(b') an ORG grantee's own event is `grant` (was: an org never consulted a grant)", async () => {
    const { repos, grants } = buildRepos();
    const grant = grants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: NON_OWNER_ORG },
    });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "org", orgId: NON_OWNER_ORG },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    // The grant it rests on rides along (the stamp's audit records it).
    expect(trust).toEqual({ trust: "grant", grantId: grant.id });
  });

  it("(c) a non-owner person grantee's own event is `grant`; the lookup is the owner as grantee, calendar passed through verbatim", async () => {
    const { repos, grants } = buildRepos();
    const grant = grants.seed({
      placeId: PLACE_ID,
      humanId: HUMAN,
      calendarId: CALENDAR_ID,
    });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "human", humanId: HUMAN },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "grant", grantId: grant.id });
    expect(grants.findActiveForActor).toHaveBeenCalledTimes(1);
    expect(grants.findActiveForActor).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: CALENDAR_ID,
      humanIds: [HUMAN],
      orgIds: [],
      now: NOW,
    });
  });

  it("(c') a place-level question passes `calendarId: null`: a calendar-scoped grant does not answer it", async () => {
    const { repos, grants } = buildRepos();
    grants.seed({ placeId: PLACE_ID, humanId: HUMAN, calendarId: CALENDAR_ID });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "human", humanId: HUMAN },
      calendarId: null,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "third_party" });
    expect(grants.findActiveForActor).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: null }),
    );
  });

  it.each([
    ["no grant", null],
    ["a pending grant", { acceptedAt: null }],
    ["a revoked grant", { revokedAt: new Date(NOW.getTime() - 1) }],
    ["an expired grant", { expiresAt: new Date(NOW.getTime() - 1) }],
    ["a grant on another calendar", { calendarId: OTHER_CALENDAR_ID }],
    ["a grant at another place", { placeId: OTHER_PLACE_ID }],
  ] as const)("(d) same person, %s → third_party", async (_label, over) => {
    const { repos, grants } = buildRepos();
    if (over) grants.seed({ placeId: PLACE_ID, humanId: HUMAN, ...over });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "human", humanId: HUMAN },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "third_party" });
  });

  it("(e) only the grantee's OWN event: a person's grant does not confirm an event owned by an org they act for", async () => {
    const { repos, grants } = buildRepos();
    grants.seed({ placeId: PLACE_ID, humanId: HUMAN });

    const trust = await classifyBuilderVenueTrust(repos, {
      place: PLACE,
      owner: { kind: "org", orgId: NON_OWNER_ORG },
      calendarId: CALENDAR_ID,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "third_party" });
  });

  it("a direct human owner of the place is venue_owned without a grant read", async () => {
    const { repos, grants } = buildRepos();

    const trust = await classifyBuilderVenueTrust(repos, {
      place: { ...PLACE, humanIdsWithAccess: [HUMAN] },
      owner: { kind: "human", humanId: HUMAN },
      calendarId: null,
      now: NOW,
    });

    expect(trust).toEqual({ trust: "venue_owned" });
    expect(grants.findActiveForActor).not.toHaveBeenCalled();
  });
});
