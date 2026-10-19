import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";

import { setPerformerMode } from "../set-performer-mode";
import type { SetPerformerModeDeps } from "../set-performer-mode";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-06-10T12:00:00.000Z");

function buildProfile(
  overrides: Partial<PerformerProfileRecord> = {},
): PerformerProfileRecord {
  return {
    id: PROFILE_ID,
    ownerType: "human",
    ownerId: ACTOR_ID,
    enabledAt: NOW,
    disabledAt: null,
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
  const existing = options.existingProfile ?? null;

  const performerProfiles = {
    getByOwner: vi.fn(async () => existing),
    upsertEnabled: vi.fn(
      async (input: { enabled: boolean; ownerType: string; ownerId: string }) =>
        buildProfile({
          ownerType: input.ownerType as PerformerProfileRecord["ownerType"],
          ownerId: input.ownerId,
          enabledAt: input.enabled ? NOW : (existing?.enabledAt ?? null),
          disabledAt: input.enabled ? null : NOW,
        }),
    ),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };

  const repos = { performerProfiles, authz, audit };
  // Passthrough tx: the same mocks serve as both root and tx-scoped repos,
  // mirroring the booking-requests test helpers.
  const tx = vi.fn(
    async <R>(fn: (txRepos: typeof repos) => Promise<R>): Promise<R> =>
      fn(repos),
  );

  const deps: SetPerformerModeDeps = {
    repos: { ...repos, tx } as unknown as SetPerformerModeDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { performerProfiles, authz, audit, tx } };
}

describe("setPerformerMode", () => {
  it("enables performer mode for the actor's own human identity and audits", async () => {
    const { deps, mocks } = buildDeps();

    const result = await setPerformerMode(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      enabled: true,
    });

    expect(result).toEqual({ performerProfileId: PROFILE_ID, enabled: true });
    expect(mocks.performerProfiles.upsertEnabled).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
      enabled: true,
      now: NOW,
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "performer_profile",
        action: "performer_mode_enabled",
      }),
    );
    // Read → upsert → audit all run in one transaction.
    expect(mocks.tx).toHaveBeenCalledTimes(1);
  });

  it("rejects a human toggling someone else's performer mode", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      setPerformerMode(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: OTHER_HUMAN_ID,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.performerProfiles.upsertEnabled).not.toHaveBeenCalled();
  });

  it("is idempotent: re-enabling an enabled profile emits no audit log", async () => {
    const { deps, mocks } = buildDeps({ existingProfile: buildProfile() });

    const result = await setPerformerMode(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      enabled: true,
    });

    expect(result.enabled).toBe(true);
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("disables performer mode and audits the transition", async () => {
    const { deps, mocks } = buildDeps({ existingProfile: buildProfile() });

    const result = await setPerformerMode(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      enabled: false,
    });

    expect(result.enabled).toBe(false);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "performer_mode_disabled" }),
    );
  });

  it("allows an org ADMIN to toggle the org's performer mode", async () => {
    const { deps } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
    });

    const result = await setPerformerMode(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "org",
      ownerId: ORG_ID,
      enabled: true,
    });

    expect(result.enabled).toBe(true);
  });

  it("rejects an org EDITOR (admin roles required)", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
    });

    await expect(
      setPerformerMode(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "org",
        ownerId: ORG_ID,
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(mocks.performerProfiles.upsertEnabled).not.toHaveBeenCalled();
  });

  it("stores org owners under the 'organization' party type", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "OWNER" },
    });

    await setPerformerMode(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "org",
      ownerId: ORG_ID,
      enabled: true,
    });

    expect(mocks.performerProfiles.upsertEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "organization", ownerId: ORG_ID }),
    );
  });
});
