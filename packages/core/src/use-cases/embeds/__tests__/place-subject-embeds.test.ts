import { describe, expect, it, vi } from "vitest";

import { upsertEmbed, type UpsertEmbedDeps } from "../upsert-embed";
import { listEmbeds, type ListEmbedsDeps } from "../list-embeds";
import { revokeEmbed, type RevokeEmbedDeps } from "../revoke-embed";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { OrgMembership } from "@th/ports/repos/authz";

/**
 * RBAC coverage for the "place" embed subject (booking-request embed button,
 * spec 2026-07-13 FR-001): venue-owner gate = direct human owner OR owning-org
 * member with an edit-level role. Verification status is deliberately NOT
 * required to manage embed domains — only the widget read gates on VERIFIED.
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";
const PLACE_ID = "00000000-0000-4000-8000-000000000005";
const ORG_ID = "00000000-0000-4000-8000-000000000006";
const DOMAIN = "venue.example.com";

const basePlace = {
  id: PLACE_ID,
  name: "The Basement",
  slug: "the-basement",
  city: "Nashville",
  region: "TN",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [ACTOR_ID],
  orgIdsWithAccess: [],
} as unknown as PlaceRecord;

const placeEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "place",
  subjectId: PLACE_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: ACTOR_ID,
  createdAt: new Date("2025-01-01"),
};

type PlaceDepsOpts = {
  place?: PlaceRecord | null;
  memberships?: OrgMembership[];
  embed?: EmbedRecord | null;
};

function makeRepos(opts: PlaceDepsOpts = {}) {
  const { place = basePlace, memberships = [], embed = placeEmbed } = opts;

  const upsertFn = vi.fn(
    async (input: {
      subjectType: string;
      subjectId: string;
      domain: string;
      createdBy: string;
    }): Promise<EmbedRecord> => ({
      ...placeEmbed,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      domain: input.domain,
      createdBy: input.createdBy,
    }),
  );
  const revokeFn = vi.fn(async () => ({ ...placeEmbed, status: "REVOKED" }));

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn, revoke: revokeFn } as any,
    audit: { log: vi.fn() } as any,
  };

  const repos = {
    embeds: {
      getById: vi.fn(async () => embed),
      listBySubject: vi.fn(async () => (embed ? [embed] : [])),
    },
    places: {
      getById: vi.fn(async () => place),
    },
    authz: {
      getOrgMemberships: vi.fn(async () => memberships),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
  } as unknown as Repos;

  return { repos, upsertFn, revokeFn };
}

// ── upsertEmbed ──────────────────────────────────────────────────────────────

describe("upsertEmbed — place subject", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    subjectType: "place" as const,
    subjectId: PLACE_ID,
    domain: DOMAIN,
  };

  it("allows a direct human owner", async () => {
    const { repos, upsertFn } = makeRepos();
    const result = await upsertEmbed({ repos }, input);
    expect(result.embed.subjectType).toBe("place");
    expect(result.embed.domain).toBe(DOMAIN);
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "place", subjectId: PLACE_ID }),
    );
  });

  it("allows an owning-org member with an edit role", async () => {
    const { repos } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      } as PlaceRecord,
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "EDITOR" }],
    });
    const result = await upsertEmbed({ repos }, input);
    expect(result.embed.subjectType).toBe("place");
  });

  it("rejects an owning-org member with only a viewer role", async () => {
    const { repos, upsertFn } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      } as PlaceRecord,
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });
    await expect(upsertEmbed({ repos }, input)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("rejects an actor with no ownership at all", async () => {
    const { repos, upsertFn } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: ["00000000-0000-4000-8000-000000000099"],
        orgIdsWithAccess: [ORG_ID],
      } as PlaceRecord,
      memberships: [],
    });
    await expect(upsertEmbed({ repos }, input)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("rejects a missing place", async () => {
    const { repos } = makeRepos({ place: null });
    await expect(upsertEmbed({ repos }, input)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("allows registering a domain for an UNVERIFIED place (read path gates instead)", async () => {
    const { repos } = makeRepos({
      place: {
        ...basePlace,
        verificationStatus: "UNVERIFIED",
        acceptsBookingRequests: false,
      } as PlaceRecord,
    });
    const result = await upsertEmbed({ repos }, input);
    expect(result.embed.subjectType).toBe("place");
  });
});

// ── listEmbeds ───────────────────────────────────────────────────────────────

describe("listEmbeds — place subject", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    subjectType: "place" as const,
    subjectId: PLACE_ID,
  };

  it("lists embeds for a direct human owner", async () => {
    const { repos } = makeRepos();
    const result = await listEmbeds({ repos }, input);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]!.subjectType).toBe("place");
  });

  it("rejects an owning-org member with only a viewer role", async () => {
    const { repos } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      } as PlaceRecord,
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });
    await expect(listEmbeds({ repos }, input)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects a missing place", async () => {
    const { repos } = makeRepos({ place: null });
    await expect(listEmbeds({ repos }, input)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });
});

// ── revokeEmbed ──────────────────────────────────────────────────────────────

describe("revokeEmbed — place subject", () => {
  const input = { actorHumanId: ACTOR_ID, embedId: EMBED_ID };

  it("revokes for a direct human owner", async () => {
    const { repos, revokeFn } = makeRepos();
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
    expect(revokeFn).toHaveBeenCalledWith(EMBED_ID);
  });

  it("revokes for an owning-org member with an edit role", async () => {
    const { repos } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      } as PlaceRecord,
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" }],
    });
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
  });

  it("rejects a non-owner", async () => {
    const { repos, revokeFn } = makeRepos({
      place: {
        ...basePlace,
        humanIdsWithAccess: [],
        orgIdsWithAccess: [],
      } as PlaceRecord,
    });
    await expect(revokeEmbed({ repos }, input)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(revokeFn).not.toHaveBeenCalled();
  });

  it("rejects when the place no longer exists", async () => {
    const { repos } = makeRepos({ place: null });
    await expect(revokeEmbed({ repos }, input)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });
});
