import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PerformerBookingDefaultsRecord } from "@th/ports/repos/performer-booking-defaults";

import { getPerformerBookingDefaults } from "../get-performer-booking-defaults";
import type { GetPerformerBookingDefaultsDeps } from "../get-performer-booking-defaults";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-07-11T12:00:00.000Z");

function buildRecord(
  overrides: Partial<PerformerBookingDefaultsRecord> = {},
): PerformerBookingDefaultsRecord {
  return {
    id: RECORD_ID,
    ownerType: "human",
    ownerId: ACTOR_ID,
    actName: "The Testers",
    lineupSize: 4,
    setLengthMinutes: 45,
    techNeeds: "2 DIs, 4 vocal mics",
    contactPhone: "+1 (615) 555-0100",
    feeType: "GUARANTEE",
    feeAmountCents: 50000,
    feeCurrency: "usd",
    messageTemplate: "Hi, we'd love to play your room.",
    includeVerifiedStats: true,
    linkMusic: "https://example.com/music",
    linkVideo: "https://example.com/video",
    linkSocial: "https://example.com/social",
    linkEpk: "https://example.com/epk",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

type BuildDepsOptions = {
  record?: PerformerBookingDefaultsRecord | null;
  membership?: OrgMembership | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const performerBookingDefaults = {
    getByOwner: vi.fn(async () =>
      options.record === undefined ? null : options.record,
    ),
    upsert: vi.fn(),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };

  const deps: GetPerformerBookingDefaultsDeps = {
    repos: { performerBookingDefaults, authz } as unknown as
      GetPerformerBookingDefaultsDeps["repos"],
  };

  return { deps, mocks: { performerBookingDefaults, authz } };
}

describe("getPerformerBookingDefaults", () => {
  it("returns saved defaults for the actor's own human identity", async () => {
    const { deps, mocks } = buildDeps({ record: buildRecord() });

    const result = await getPerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
    });

    expect(result.hasSaved).toBe(true);
    expect(result.defaults.actName).toBe("The Testers");
    expect(result.defaults.feeAmountCents).toBe(50000);
    expect(result.defaults.linkEpk).toBe("https://example.com/epk");
    // Maps the polymorphic wire owner type to the stored party type.
    expect(mocks.performerBookingDefaults.getByOwner).toHaveBeenCalledWith({
      ownerType: "human",
      ownerId: ACTOR_ID,
    });
  });

  it("returns an all-null shape when nothing is saved", async () => {
    const { deps } = buildDeps({ record: null });

    const result = await getPerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
    });

    expect(result.hasSaved).toBe(false);
    expect(result.defaults.actName).toBeNull();
    expect(result.defaults.feeType).toBeNull();
    expect(result.defaults.includeVerifiedStats).toBeNull();
  });

  it("rejects a human reading someone else's defaults", async () => {
    const { deps, mocks } = buildDeps({ record: buildRecord() });

    await expect(
      getPerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: OTHER_HUMAN_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.performerBookingDefaults.getByOwner).not.toHaveBeenCalled();
  });

  it("allows an org EDITOR to read the org's defaults", async () => {
    const { deps } = buildDeps({
      record: buildRecord({ ownerType: "organization", ownerId: ORG_ID }),
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
    });

    const result = await getPerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "org",
      ownerId: ORG_ID,
    });

    expect(result.hasSaved).toBe(true);
  });

  it("rejects an org VIEWER (edit roles required)", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });

    await expect(
      getPerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "org",
        ownerId: ORG_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(mocks.performerBookingDefaults.getByOwner).not.toHaveBeenCalled();
  });
});
