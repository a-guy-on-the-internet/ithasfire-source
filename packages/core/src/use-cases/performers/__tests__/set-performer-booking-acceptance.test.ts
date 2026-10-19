import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";

import { setPerformerBookingAcceptance } from "../set-performer-booking-acceptance";
import type { SetPerformerBookingAcceptanceDeps } from "../set-performer-booking-acceptance";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-07-21T12:00:00.000Z");

function buildProfile(
  overrides: Partial<PerformerProfileRecord> = {},
): PerformerProfileRecord {
  return {
    id: PROFILE_ID,
    ownerType: "human",
    ownerId: ACTOR_ID,
    enabledAt: NOW,
    disabledAt: null,
    acceptsBookingRequests: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type BuildDepsOptions = {
  existingProfile?: PerformerProfileRecord | null;
  membership?: OrgMembership | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const existing =
    options.existingProfile === undefined ? null : options.existingProfile;

  const performerProfiles = {
    getByOwner: vi.fn(async () => existing),
    setAcceptsBookingRequests: vi.fn(
      async (input: { ownerType: string; ownerId: string; accepts: boolean }) =>
        buildProfile({
          ownerType: input.ownerType as PerformerProfileRecord["ownerType"],
          ownerId: input.ownerId,
          acceptsBookingRequests: input.accepts,
        }),
    ),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };

  const repos = { performerProfiles, authz, audit };
  const tx = vi.fn(
    async <R>(fn: (txRepos: typeof repos) => Promise<R>): Promise<R> =>
      fn(repos),
  );

  const deps: SetPerformerBookingAcceptanceDeps = {
    repos: {
      ...repos,
      tx,
    } as unknown as SetPerformerBookingAcceptanceDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { performerProfiles, authz, audit, tx } };
}

describe("setPerformerBookingAcceptance", () => {
  it("enables acceptance on an enabled profile and audits", async () => {
    const { deps, mocks } = buildDeps({ existingProfile: buildProfile() });

    const result = await setPerformerBookingAcceptance(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: true,
    });

    expect(result).toEqual({ accepts: true });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: true,
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "performer_profile",
        action: "performer_profile.booking_acceptance_enabled",
      }),
    );
    expect(mocks.tx).toHaveBeenCalledTimes(1);
  });

  it("rejects enabling when performer mode is not enabled (disabled profile)", async () => {
    const { deps, mocks } = buildDeps({
      existingProfile: buildProfile({ disabledAt: NOW }),
    });

    await expect(
      setPerformerBookingAcceptance(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).not.toHaveBeenCalled();
  });

  it("rejects enabling when no profile exists at all", async () => {
    const { deps } = buildDeps({ existingProfile: null });

    await expect(
      setPerformerBookingAcceptance(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
  });

  it("disabling with no profile is a pure no-op success", async () => {
    const { deps, mocks } = buildDeps({ existingProfile: null });

    const result = await setPerformerBookingAcceptance(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: false,
    });

    expect(result).toEqual({ accepts: false });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("disabling works even when performer mode is off (stale acceptance cleanup)", async () => {
    const { deps, mocks } = buildDeps({
      existingProfile: buildProfile({
        disabledAt: NOW,
        acceptsBookingRequests: true,
      }),
    });

    const result = await setPerformerBookingAcceptance(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: false,
    });

    expect(result).toEqual({ accepts: false });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: false,
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "performer_profile.booking_acceptance_disabled",
      }),
    );
  });

  it("is idempotent: re-enabling an accepting profile skips the write but audits intent", async () => {
    const { deps, mocks } = buildDeps({
      existingProfile: buildProfile({ acceptsBookingRequests: true }),
    });

    const result = await setPerformerBookingAcceptance(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      accepts: true,
    });

    expect(result).toEqual({ accepts: true });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledTimes(1);
  });

  it("rejects a human toggling someone else's acceptance", async () => {
    const { deps } = buildDeps({ existingProfile: buildProfile() });

    await expect(
      setPerformerBookingAcceptance(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: OTHER_HUMAN_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("requires an ADMIN-level org role for an org act", async () => {
    const editor: OrgMembership = {
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "EDITOR",
    } as OrgMembership;
    const { deps } = buildDeps({
      existingProfile: buildProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
      membership: editor,
    });

    await expect(
      setPerformerBookingAcceptance(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "org",
        ownerId: ORG_ID,
        accepts: true,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("allows an org OWNER to enable acceptance for the org act", async () => {
    const owner: OrgMembership = {
      orgId: ORG_ID,
      humanId: ACTOR_ID,
      role: "OWNER",
    } as OrgMembership;
    const { deps, mocks } = buildDeps({
      existingProfile: buildProfile({
        ownerType: "organization",
        ownerId: ORG_ID,
      }),
      membership: owner,
    });

    const result = await setPerformerBookingAcceptance(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "org",
      ownerId: ORG_ID,
      accepts: true,
    });

    expect(result).toEqual({ accepts: true });
    expect(
      mocks.performerProfiles.setAcceptsBookingRequests,
    ).toHaveBeenCalledWith({
      ownerType: "organization",
      ownerId: ORG_ID,
      accepts: true,
    });
  });
});
