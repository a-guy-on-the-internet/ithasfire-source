import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type { PerformerBookingDefaultsRecord } from "@th/ports/repos/performer-booking-defaults";

import { updatePerformerBookingDefaults } from "../update-performer-booking-defaults";
import type { UpdatePerformerBookingDefaultsDeps } from "../update-performer-booking-defaults";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_HUMAN_ID = "12121212-1212-4121-8121-121212121212";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const RECORD_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-07-11T12:00:00.000Z");

type BuildDepsOptions = {
  membership?: OrgMembership | null;
};

function buildDeps(options: BuildDepsOptions = {}) {
  // The upsert echoes the input back as a record (with an id) so we can assert
  // exactly what the use case persisted.
  const performerBookingDefaults = {
    getByOwner: vi.fn(),
    upsert: vi.fn(
      async (
        input: Record<string, unknown>,
      ): Promise<PerformerBookingDefaultsRecord> => ({
        id: RECORD_ID,
        createdAt: NOW,
        updatedAt: NOW,
        ...(input as Omit<
          PerformerBookingDefaultsRecord,
          "id" | "createdAt" | "updatedAt"
        >),
      }),
    ),
  };
  const authz = {
    getOrgMembership: vi.fn(async () => options.membership ?? null),
  };
  const audit = { log: vi.fn(async () => {}) };

  const repos = { performerBookingDefaults, authz, audit };
  const tx = vi.fn(
    async <R>(fn: (txRepos: typeof repos) => Promise<R>): Promise<R> =>
      fn(repos),
  );

  const deps: UpdatePerformerBookingDefaultsDeps = {
    repos: { ...repos, tx } as unknown as
      UpdatePerformerBookingDefaultsDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks: { performerBookingDefaults, authz, audit, tx } };
}

const FULL_INPUT = {
  actorHumanId: ACTOR_ID,
  ownerType: "human" as const,
  ownerId: ACTOR_ID,
  actName: "The Testers",
  lineupSize: 4,
  setLengthMinutes: 45,
  techNeeds: "2 DIs, 4 vocal mics",
  contactPhone: "+1 (615) 555-0100",
  feeType: "GUARANTEE" as const,
  feeAmountCents: 50000,
  messageTemplate: "Hi, we'd love to play your room.",
  includeVerifiedStats: true,
  linkMusic: "https://example.com/music",
  linkVideo: "https://example.com/video",
  linkSocial: "https://example.com/social",
  linkEpk: "https://example.com/epk",
};

describe("updatePerformerBookingDefaults", () => {
  it("round-trips all fields and snapshots feeCurrency when an amount is set", async () => {
    const { deps, mocks } = buildDeps();

    const result = await updatePerformerBookingDefaults(deps, FULL_INPUT);

    expect(result).toEqual({ ok: true });
    expect(mocks.performerBookingDefaults.upsert).toHaveBeenCalledWith({
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
    });
    // Upsert + audit run in one transaction.
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "performer_booking_defaults",
        action: "performer_booking_defaults.updated",
        entityId: RECORD_ID,
      }),
    );
  });

  it("clears fields that are omitted (persists the full state as null)", async () => {
    const { deps, mocks } = buildDeps();

    await updatePerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      actName: "Solo Act",
    });

    expect(mocks.performerBookingDefaults.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        actName: "Solo Act",
        lineupSize: null,
        setLengthMinutes: null,
        techNeeds: null,
        contactPhone: null,
        feeType: null,
        feeAmountCents: null,
        feeCurrency: null,
        messageTemplate: null,
        includeVerifiedStats: null,
        linkMusic: null,
        linkVideo: null,
        linkSocial: null,
        linkEpk: null,
      }),
    );
  });

  it("clears a field via an explicit null", async () => {
    const { deps, mocks } = buildDeps();

    await updatePerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "human",
      ownerId: ACTOR_ID,
      actName: null,
      contactPhone: null,
    });

    expect(mocks.performerBookingDefaults.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ actName: null, contactPhone: null }),
    );
  });

  it("rejects a human saving someone else's defaults", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: OTHER_HUMAN_ID,
        actName: "Hijack",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.performerBookingDefaults.upsert).not.toHaveBeenCalled();
  });

  it("rejects an org VIEWER (edit roles required)", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "org",
        ownerId: ORG_ID,
        actName: "Org Band",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(mocks.performerBookingDefaults.upsert).not.toHaveBeenCalled();
  });

  it("allows an org EDITOR and stores under the 'organization' party type", async () => {
    const { deps, mocks } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" },
    });

    await updatePerformerBookingDefaults(deps, {
      actorHumanId: ACTOR_ID,
      ownerType: "org",
      ownerId: ORG_ID,
      actName: "Org Band",
    });

    expect(mocks.performerBookingDefaults.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ ownerType: "organization", ownerId: ORG_ID }),
    );
  });

  it("rejects a fee amount with a NEGOTIABLE fee type (cross-field)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        feeType: "NEGOTIABLE",
        feeAmountCents: 10000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(mocks.performerBookingDefaults.upsert).not.toHaveBeenCalled();
  });

  it("rejects a fee amount with no fee type (cross-field)", async () => {
    const { deps } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        feeAmountCents: 10000,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a non-preset set length", async () => {
    const { deps } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        setLengthMinutes: 37,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an invalid contact phone", async () => {
    const { deps } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        contactPhone: "call me maybe",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a non-http(s) link scheme", async () => {
    const { deps } = buildDeps();

    await expect(
      updatePerformerBookingDefaults(deps, {
        actorHumanId: ACTOR_ID,
        ownerType: "human",
        ownerId: ACTOR_ID,
        linkMusic: "javascript:alert(1)",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
