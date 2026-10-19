import { describe, expect, it, vi } from "vitest";

import { upsertEmbed } from "../upsert-embed";
import { listEmbeds } from "../list-embeds";
import { revokeEmbed } from "../revoke-embed";
import { getMembershipWidget } from "../get-membership-widget";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * The "memberships" embed subject (recurring-memberships owner flow step 3):
 * subjectId = the tier OWNER (Organization id or Human id, resolved
 * org-first). Write-path RBAC mirrors the organization/human subjects; the
 * widget READ path serves ACTIVE public tiers only, fails closed on origin,
 * and renders a suspended owner as an EMPTY list (never an oracle on the
 * owner's risk state — see list-public-tiers.ts).
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";
const ORG_ID = "00000000-0000-4000-8000-000000000006";
const HUMAN_OWNER_ID = "00000000-0000-4000-8000-000000000007";
const TIER_ID = "00000000-0000-4000-8000-000000000008";
const DOMAIN = "collective.example.com";

const membershipsEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "memberships",
  subjectId: ORG_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: ACTOR_ID,
  createdAt: new Date("2026-01-01"),
};

const activeTier = {
  id: TIER_ID,
  name: "Sustaining Member",
  description: "Keep the lights on.",
  // The owner's own claim about what members get — public by design on this
  // widget, same as on the entity-page card it shares.
  benefitsDescription: "Two free drinks a month.",
  priceCents: 1000,
  currency: "usd",
  interval: "MONTH" as const,
  sortOrder: 0,
};

type DepsOpts = {
  embed?: EmbedRecord | null;
  /** Org row returned for the subjectId lookup (null ⇒ not an org owner). */
  org?: { id: string; name: string } | null;
  /** Human row returned for the subjectId lookup. */
  human?: { id: string; name: string | null } | null;
  /** The actor's membership role in the org (null ⇒ no membership). */
  membershipRole?: string | null;
  standing?: { suspended: boolean } | null;
  tiers?: (typeof activeTier)[];
  page?: { slug: string; visibility: string } | null;
};

function makeRepos(opts: DepsOpts = {}) {
  const {
    embed = membershipsEmbed,
    org = { id: ORG_ID, name: "Dev QA Collective" },
    human = null,
    membershipRole = "OWNER",
    standing = null,
    tiers = [activeTier],
    page = { slug: "demo", visibility: "PUBLIC" },
  } = opts;

  const upsertFn = vi.fn(
    async (input: {
      subjectType: string;
      subjectId: string;
      domain: string;
      createdBy: string;
    }): Promise<EmbedRecord> => ({
      ...membershipsEmbed,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      domain: input.domain,
      createdBy: input.createdBy,
    }),
  );
  const revokeFn = vi.fn(async () => ({
    ...membershipsEmbed,
    status: "REVOKED",
  }));
  const listTiersFn = vi.fn(async () => tiers);

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn, revoke: revokeFn } as any,
    audit: { log: vi.fn() } as any,
  };

  const repos = {
    embeds: {
      getById: vi.fn(async () => embed),
      listBySubject: vi.fn(async () => (embed ? [embed] : [])),
    },
    organizations: {
      getById: vi.fn(async (id: string) =>
        org && id === org.id ? org : null,
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        human && id === human.id ? human : null,
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        membershipRole ? { role: membershipRole } : null,
      ),
    },
    entityPages: {
      getByOwner: vi.fn(async () => page),
    },
    membershipStandings: {
      findForOwner: vi.fn(async () => standing),
    },
    membershipTiers: {
      listForOwner: listTiersFn,
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
  } as unknown as Repos;

  return { repos, upsertFn, revokeFn, listTiersFn };
}

// ── upsertEmbed ──────────────────────────────────────────────────────────────

describe("upsertEmbed — memberships subject", () => {
  const orgInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "memberships" as const,
    subjectId: ORG_ID,
    domain: DOMAIN,
  };

  it("allows an org member with an edit role (org owner)", async () => {
    const { repos, upsertFn } = makeRepos({ membershipRole: "EDITOR" });
    const result = await upsertEmbed({ repos }, orgInput);
    expect(result.embed.subjectType).toBe("memberships");
    expect(result.embed.domain).toBe(DOMAIN);
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "memberships",
        subjectId: ORG_ID,
      }),
    );
  });

  it("rejects an org member with only a viewer role", async () => {
    const { repos, upsertFn } = makeRepos({ membershipRole: "VIEWER" });
    await expect(upsertEmbed({ repos }, orgInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("allows a human owner managing their OWN subject", async () => {
    const { repos } = makeRepos({
      org: null,
      human: { id: ACTOR_ID, name: "Alex" },
    });
    const result = await upsertEmbed(
      { repos },
      { ...orgInput, subjectId: ACTOR_ID },
    );
    expect(result.embed.subjectType).toBe("memberships");
  });

  it("rejects an actor targeting ANOTHER human's subject", async () => {
    const { repos, upsertFn } = makeRepos({
      org: null,
      human: { id: HUMAN_OWNER_ID, name: "Sam" },
    });
    await expect(
      upsertEmbed({ repos }, { ...orgInput, subjectId: HUMAN_OWNER_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("rejects a subjectId that is neither an org nor a human", async () => {
    const { repos } = makeRepos({ org: null, human: null });
    await expect(upsertEmbed({ repos }, orgInput)).rejects.toMatchObject({
      code: "OWNER_NOT_FOUND",
    });
  });

  it("rejects view fields — the memberships widget has no views", async () => {
    const { repos, upsertFn } = makeRepos();
    await expect(
      upsertEmbed({ repos }, { ...orgInput, defaultView: "calendar" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      upsertEmbed({ repos }, { ...orgInput, viewToggle: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(upsertFn).not.toHaveBeenCalled();
  });
});

// ── listEmbeds ───────────────────────────────────────────────────────────────

describe("listEmbeds — memberships subject", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    subjectType: "memberships" as const,
    subjectId: ORG_ID,
  };

  it("lists embeds for an org member with an edit role", async () => {
    const { repos } = makeRepos({ membershipRole: "ADMIN" });
    const result = await listEmbeds({ repos }, input);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]!.subjectType).toBe("memberships");
  });

  it("rejects a non-member", async () => {
    const { repos } = makeRepos({ membershipRole: null });
    await expect(listEmbeds({ repos }, input)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("rejects when the owner no longer exists", async () => {
    const { repos } = makeRepos({ org: null, human: null });
    await expect(listEmbeds({ repos }, input)).rejects.toMatchObject({
      code: "OWNER_NOT_FOUND",
    });
  });
});

// ── revokeEmbed ──────────────────────────────────────────────────────────────

describe("revokeEmbed — memberships subject", () => {
  const input = { actorHumanId: ACTOR_ID, embedId: EMBED_ID };

  it("revokes for an org member with an edit role", async () => {
    const { repos, revokeFn } = makeRepos({ membershipRole: "OWNER" });
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
    expect(revokeFn).toHaveBeenCalledWith(EMBED_ID);
  });

  it("revokes for the human owner themself", async () => {
    const { repos } = makeRepos({
      embed: { ...membershipsEmbed, subjectId: ACTOR_ID },
      org: null,
      human: { id: ACTOR_ID, name: "Alex" },
    });
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
  });

  it("rejects a stranger to a human-owned embed", async () => {
    const { repos, revokeFn } = makeRepos({
      embed: { ...membershipsEmbed, subjectId: HUMAN_OWNER_ID },
      org: null,
      human: { id: HUMAN_OWNER_ID, name: "Sam" },
    });
    await expect(revokeEmbed({ repos }, input)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
    });
    expect(revokeFn).not.toHaveBeenCalled();
  });
});

// ── getMembershipWidget (public read) ────────────────────────────────────────

describe("getMembershipWidget", () => {
  const input = { embedId: EMBED_ID, hostOrigin: `https://${DOMAIN}` };

  it("returns ACTIVE tiers, the owner, and the join slug", async () => {
    const { repos, listTiersFn } = makeRepos();
    const result = await getMembershipWidget({ repos }, input);
    expect(result.embed.id).toBe(EMBED_ID);
    expect(result.owner).toEqual({
      kind: "organization",
      id: ORG_ID,
      name: "Dev QA Collective",
      joinSlug: "demo",
    });
    expect(result.tiers).toEqual([activeTier]);
    // ACTIVE-only is delegated to listPublicTiers — pin the statuses filter
    // so a regression there can't silently serve DRAFT/ARCHIVED tiers here.
    expect(listTiersFn).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["ACTIVE"] }),
    );
  });

  it("serves a human owner via the human fallback lookup", async () => {
    const { repos } = makeRepos({
      embed: { ...membershipsEmbed, subjectId: HUMAN_OWNER_ID },
      org: null,
      human: { id: HUMAN_OWNER_ID, name: "Sam" },
      page: { slug: "sam", visibility: "PUBLIC" },
    });
    const result = await getMembershipWidget({ repos }, input);
    expect(result.owner).toEqual({
      kind: "human",
      id: HUMAN_OWNER_ID,
      name: "Sam",
      joinSlug: "sam",
    });
  });

  it("returns an EMPTY tier list for a suspended owner (quiet, not an error)", async () => {
    const { repos } = makeRepos({ standing: { suspended: true } });
    const result = await getMembershipWidget({ repos }, input);
    expect(result.tiers).toEqual([]);
  });

  it("omits the join slug when the owner's page is PRIVATE", async () => {
    const { repos } = makeRepos({
      page: { slug: "demo", visibility: "PRIVATE" },
    });
    const result = await getMembershipWidget({ repos }, input);
    expect(result.owner.joinSlug).toBeNull();
  });

  it("omits the join slug when the owner has no entity page", async () => {
    const { repos } = makeRepos({ page: null });
    const result = await getMembershipWidget({ repos }, input);
    expect(result.owner.joinSlug).toBeNull();
  });

  it("refuses a REVOKED embed", async () => {
    const { repos } = makeRepos({
      embed: { ...membershipsEmbed, status: "REVOKED" },
    });
    await expect(getMembershipWidget({ repos }, input)).rejects.toMatchObject({
      code: "EMBED_NOT_FOUND",
    });
  });

  it("fails closed on a non-allowlisted origin", async () => {
    const { repos, listTiersFn } = makeRepos();
    await expect(
      getMembershipWidget(
        { repos },
        { embedId: EMBED_ID, hostOrigin: "https://evil.example.net" },
      ),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(listTiersFn).not.toHaveBeenCalled();
  });

  it("fails closed on a MISSING origin", async () => {
    const { repos } = makeRepos();
    await expect(
      getMembershipWidget({ repos }, { embedId: EMBED_ID, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
  });

  it("rejects a non-memberships subject", async () => {
    const { repos } = makeRepos({
      embed: { ...membershipsEmbed, subjectType: "organization" },
    });
    await expect(getMembershipWidget({ repos }, input)).rejects.toMatchObject({
      code: "UNSUPPORTED_SUBJECT_TYPE",
    });
  });
});
