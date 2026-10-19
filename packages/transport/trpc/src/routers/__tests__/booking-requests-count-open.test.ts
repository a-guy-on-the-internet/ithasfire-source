import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { bookingRequestsRouter } from "../booking-requests";
import { createCaller } from "./test-helpers";

/**
 * Transport contract for `bookingRequests.countOpen`
 * (booking-inbox-placement FR-006).
 *
 * The router is thin by design, so the things worth pinning HERE are the
 * transport-only ones:
 *   - it is a QUERY (read-only summary, NFR-003) reachable from an authed ctx;
 *   - `actorHumanId` comes from `ctx`, never from client input (the omit
 *     pattern at the top of the router) — a client-supplied one is rejected by
 *     the `.strict()` input schema rather than silently honoured;
 *   - typed use-case errors are mapped through `toTrpcError` (non-member →
 *     FORBIDDEN), matching the list scopes this summarizes.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACTOR_ID = "12121212-1212-4121-8121-121212121212";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_PLACE_ID = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";

type BuildReposOptions = {
  member?: boolean;
  performerInbox?: number;
  grouped?: { placeId: string; openCount: number }[];
  ownedPlaces?: { id: string; name: string }[];
};

const DEFAULT_OWNED_PLACES = [
  { id: PLACE_ID, name: "The Ember Room" },
  { id: SECOND_PLACE_ID, name: "The Quiet Corner" },
];

function buildRepos(options: BuildReposOptions = {}) {
  const ownedPlaces = options.ownedPlaces ?? DEFAULT_OWNED_PLACES;
  const mocks = {
    getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
      options.member === false
        ? null
        : { orgId: ORG_ID, humanId, role: "VIEWER" },
    ),
    countForPerformerInbox: vi.fn(async () => options.performerInbox ?? 0),
    countOpenByPlace: vi.fn(async () => options.grouped ?? []),
    listOwnedBySubject: vi.fn(async () => ownedPlaces),
    listCalendarsByPlaceIds: vi.fn(async () => options.calendars ?? []),
  };

  const repos = {
    bookingRequests: {
      countForPerformerInbox: mocks.countForPerformerInbox,
      countOpenByPlace: mocks.countOpenByPlace,
    },
    places: { listOwnedBySubject: mocks.listOwnedBySubject },
    // The use case reads the venue's calendars alongside the open-request
    // counts (one round trip, same owned-place set) so the inbox can offer
    // them as a filter. Empty by default; a test that cares supplies its own.
    calendars: { listByPlaceIds: mocks.listCalendarsByPlaceIds },
    authz: {
      getOrgMembership: mocks.getOrgMembership,
      getOrgMemberships: vi.fn(async () => []),
      listOrgMembershipsByHumanId: vi.fn(async () => []),
    },
  } as unknown as Ctx["repos"];

  return { repos, mocks };
}

describe("bookingRequestsRouter.countOpen", () => {
  it("returns the org-as-act count plus a named, zero-filled entry per owned place", async () => {
    const { repos, mocks } = buildRepos({
      performerInbox: 2,
      grouped: [{ placeId: PLACE_ID, openCount: 3 }],
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.countOpen({ orgId: ORG_ID });

    // `venues` is self-sufficient for the venue block (name + count), so the
    // surface needs no companion place query — the output schema is what
    // crosses the wire, so the name has to survive the `.strict()` parse.
    expect(result).toEqual({
      performerInbox: 2,
      venues: [
        {
          placeId: PLACE_ID,
          placeName: "The Ember Room",
          openCount: 3,
          calendars: [],
        },
        {
          placeId: SECOND_PLACE_ID,
          placeName: "The Quiet Corner",
          openCount: 0,
          calendars: [],
        },
      ],
      ownedPlacesTruncated: false,
    });
    expect(mocks.countForPerformerInbox).toHaveBeenCalledWith({
      owners: [{ ownerType: "organization", ownerId: ORG_ID }],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  it("surfaces ownedPlacesTruncated over the wire when the owned-place read hits the cap", async () => {
    const { repos } = buildRepos({
      ownedPlaces: Array.from({ length: 100 }, (_, index) => ({
        id: `4${index.toString().padStart(7, "0")}-0000-4000-8000-000000000000`,
        name: `Venue ${index}`,
      })),
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.countOpen({ orgId: ORG_ID });

    expect(result.ownedPlacesTruncated).toBe(true);
    expect(result.venues).toHaveLength(100);
  });

  it("takes actorHumanId from ctx and rejects a client-supplied one (.strict omit pattern)", async () => {
    const { repos, mocks } = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    await caller.countOpen({ orgId: ORG_ID });
    expect(mocks.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });

    // Impersonation attempt: the omitted key is not part of the input schema.
    await expect(
      caller.countOpen({ orgId: ORG_ID, actorHumanId: OTHER_ACTOR_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps a non-member to FORBIDDEN (same shape as the list scopes)", async () => {
    const { repos } = buildRepos({ member: false });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    await expect(caller.countOpen({ orgId: ORG_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects an unauthenticated caller", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
    });

    await expect(caller.countOpen({ orgId: ORG_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  // ── Owner selector (personal admin) ───────────────────────────────────────

  it("`owner: { kind: \"human\" }` counts the actor's own venues with no membership read", async () => {
    const { repos, mocks } = buildRepos({
      member: false,
      performerInbox: 1,
      grouped: [{ placeId: PLACE_ID, openCount: 2 }],
    });
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    const result = await caller.countOpen({ owner: { kind: "human" } });

    expect(result).toEqual({
      performerInbox: 1,
      venues: [
        {
          placeId: PLACE_ID,
          placeName: "The Ember Room",
          openCount: 2,
          calendars: [],
        },
        {
          placeId: SECOND_PLACE_ID,
          placeName: "The Quiet Corner",
          openCount: 0,
          calendars: [],
        },
      ],
      ownedPlacesTruncated: false,
    });
    expect(mocks.getOrgMembership).not.toHaveBeenCalled();
    // Owner is the ctx actor — HUMAN ownership, never a client-named id.
    expect(mocks.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "HUMAN",
      ownerId: ACTOR_ID,
      limit: 100,
    });
    expect(mocks.countForPerformerInbox).toHaveBeenCalledWith({
      owners: [{ ownerType: "human", ownerId: ACTOR_ID }],
      statuses: ["PENDING", "VIEWED"],
    });
  });

  it("`owner: { kind: \"org\" }` is the explicit spelling of the legacy `orgId`", async () => {
    const { repos, mocks } = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    await caller.countOpen({ owner: { kind: "org", orgId: ORG_ID } });

    expect(mocks.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
    expect(mocks.listOwnedBySubject).toHaveBeenCalledWith({
      ownerType: "ORGANIZATION",
      ownerId: ORG_ID,
      limit: 100,
    });
  });

  it("rejects an empty selector and a human variant that names an id (BAD_REQUEST)", async () => {
    const { repos, mocks } = buildRepos();
    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });

    // The pre-refine transport schema lets `{}` through; the use case's
    // "exactly one selector" rule is what must reject it.
    await expect(caller.countOpen({})).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      caller.countOpen({
        owner: { kind: "human", humanId: OTHER_ACTOR_ID },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.listOwnedBySubject).not.toHaveBeenCalled();
  });

  it("issues no per-venue list query for badge purposes (FR-006)", async () => {
    const listForPlace = vi.fn();
    const { repos, mocks } = buildRepos({ performerInbox: 1 });
    (
      repos as unknown as { bookingRequests: Record<string, unknown> }
    ).bookingRequests.listForPlace = listForPlace;

    const { caller } = createCaller(bookingRequestsRouter, {
      repos,
      actorHumanId: ACTOR_ID,
    });
    await caller.countOpen({ orgId: ORG_ID });

    expect(listForPlace).not.toHaveBeenCalled();
    expect(mocks.countOpenByPlace).toHaveBeenCalledTimes(1);
  });
});
