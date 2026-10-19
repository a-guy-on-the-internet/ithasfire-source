import { describe, expect, it, vi } from "vitest";

import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";
import type { Ctx } from "../../context";

// Transport coverage for the viewer leg of `places.getBookingOptions`
// (owner ruling 2026-09-08: the builder shows the third-party controls to a
// true third party only). The procedure is `optionalProcedure`: an
// anonymous caller is still served, an authenticated caller's identity is
// taken from ctx — never from the input — and the `owner` the builder will
// save under travels as input.

const PLACE_ID = "00000000-0000-4000-8000-00000000d030";
const OWNER_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ORG_ID = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const VIEWER_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-09-08T12:00:00.000Z");

function buildRepos(
  options: {
    orgOwned?: boolean;
    grant?: Record<string, unknown> | null;
    membershipRole?: string | null;
  } = {},
) {
  const findActiveForActor = vi.fn(async () =>
    options.grant ? { placeId: PLACE_ID, ...options.grant } : null,
  );
  const getOrgMembership = vi.fn(
    async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
      options.membershipRole
        ? { orgId, humanId, role: options.membershipRole }
        : null,
  );
  const repos = {
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        acceptsBookingRequests: true,
        humanIdsWithAccess: options.orgOwned ? [] : [OWNER_HUMAN_ID],
        orgIdsWithAccess: options.orgOwned ? [OWNER_ORG_ID] : [],
      })),
    },
    calendars: { listByPlace: vi.fn(async () => []) },
    placeBookingGrants: { findActiveForActor },
    authz: { getOrgMembership },
  } as unknown as Ctx["repos"];
  return { repos, findActiveForActor, getOrgMembership };
}

function callerFor(
  repos: Ctx["repos"],
  actorHumanId: string | null,
  options: { manages?: boolean } = {},
) {
  // `canManagePlace` (place-address-withholding W1): a viewer who manages the
  // place is the venue whatever owner they save under.
  const authz = {
    canManagePlace: vi.fn(async () => ({ allowed: options.manages === true })),
  } as unknown as Ctx["authz"];
  return createCaller(
    { places: placesRouter },
    { repos, actorHumanId, clock: { now: () => NOW } as Ctx["clock"], authz },
  ).caller;
}

describe("places.getBookingOptions — viewer.authority", () => {
  it("anonymous caller → none; nothing viewer-shaped is read", async () => {
    const { repos, findActiveForActor, getOrgMembership } = buildRepos({
      grant: { id: "g1" },
    });
    const out = await callerFor(repos, null).places.getBookingOptions({
      placeId: PLACE_ID,
    });
    expect(out.viewer).toEqual({ authority: "none" });
    expect(findActiveForActor).not.toHaveBeenCalled();
    expect(getOrgMembership).not.toHaveBeenCalled();
  });

  it("the ctx actor who owns the place → owner", async () => {
    const { repos } = buildRepos();
    const out = await callerFor(repos, OWNER_HUMAN_ID).places.getBookingOptions(
      { placeId: PLACE_ID },
    );
    expect(out.viewer.authority).toBe("owner");
  });

  it("edit-role member naming the owning org as the owner → owner; the same human as themselves → owner too, because they MANAGE the place (W1); a non-manager as themselves → none", async () => {
    const { repos } = buildRepos({ orgOwned: true, membershipRole: "EDITOR" });
    const caller = callerFor(repos, VIEWER_ID, { manages: true });

    const asOrg = await caller.places.getBookingOptions({
      placeId: PLACE_ID,
      owner: { kind: "org", orgId: OWNER_ORG_ID },
    });
    expect(asOrg.viewer.authority).toBe("owner");

    const asHuman = await caller.places.getBookingOptions({
      placeId: PLACE_ID,
      owner: { kind: "human" },
    });
    expect(asHuman.viewer.authority).toBe("owner");

    const stranger = await callerFor(repos, VIEWER_ID, {
      manages: false,
    }).places.getBookingOptions({
      placeId: PLACE_ID,
      owner: { kind: "human" },
    });
    expect(stranger.viewer.authority).toBe("none");
  });

  it("grant-holder → grant, keyed on the CTX actor and the ctx clock", async () => {
    const { repos, findActiveForActor } = buildRepos({
      grant: { id: "g1" },
    });
    const out = await callerFor(repos, VIEWER_ID).places.getBookingOptions({
      placeId: PLACE_ID,
    });
    expect(out.viewer.authority).toBe("grant");
    expect(findActiveForActor).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      calendarId: null,
      humanIds: [VIEWER_ID],
      orgIds: [],
      now: NOW,
    });
  });

  it("refuses a client-supplied actorHumanId outright (BAD_REQUEST, no read)", async () => {
    const { repos, findActiveForActor } = buildRepos({
      grant: { id: "g1" },
    });
    await expect(
      callerFor(repos, null).places.getBookingOptions({
        placeId: PLACE_ID,
        actorHumanId: VIEWER_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(findActiveForActor).not.toHaveBeenCalled();
  });

  it("rejects a malformed owner with BAD_REQUEST", async () => {
    const { repos } = buildRepos();
    await expect(
      callerFor(repos, VIEWER_ID).places.getBookingOptions({
        placeId: PLACE_ID,
        owner: { kind: "org" },
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
