import { describe, expect, it, vi } from "vitest";

import { upsertEmbed } from "../upsert-embed";
import { listEmbeds } from "../list-embeds";
import { revokeEmbed } from "../revoke-embed";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * RBAC coverage for the "human" embed subject — the personal (non-org) admin
 * context.
 *
 * Regression origin: the admin embeds view sent `subjectType: "organization"`
 * with a HUMAN id as `subjectId` when the admin owner was a person, so
 * `organizations.getById(humanId)` returned null and every personal-context
 * embed failed with ORGANIZATION_NOT_FOUND. "human" is now a first-class
 * subject type.
 *
 * Rule under test: an actor may manage ONLY their own human subject — there is
 * no delegation model for personal contexts.
 */

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000002";
const EMBED_ID = "00000000-0000-4000-8000-000000000003";
const DOMAIN = "myband.example.com";

const actorHuman = { id: ACTOR_ID, name: "Ada Lovelace" } as HumanRecord;
const otherHuman = { id: OTHER_HUMAN_ID, name: "Grace Hopper" } as HumanRecord;

const humanEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "human",
  subjectId: ACTOR_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: ACTOR_ID,
  createdAt: new Date("2026-01-01"),
};

type Opts = {
  /** Humans the repo knows about, keyed by id. */
  humans?: HumanRecord[];
  embed?: EmbedRecord | null;
};

function makeRepos(opts: Opts = {}) {
  const { humans = [actorHuman, otherHuman], embed = humanEmbed } = opts;

  const upsertFn = vi.fn(
    async (input: {
      subjectType: string;
      subjectId: string;
      domain: string;
      createdBy: string;
    }): Promise<EmbedRecord> => ({
      ...humanEmbed,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      domain: input.domain,
      createdBy: input.createdBy,
    }),
  );
  const revokeFn = vi.fn(async () => ({ ...humanEmbed, status: "REVOKED" }));

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn, revoke: revokeFn } as any,
    audit: { log: vi.fn() } as any,
  };

  const repos = {
    embeds: {
      getById: vi.fn(async () => embed),
      listBySubject: vi.fn(async () => (embed ? [embed] : [])),
    },
    humans: {
      getById: vi.fn(async (id: string) => humans.find((h) => h.id === id) ?? null),
    },
    // Present but must never be consulted for a human subject — a human
    // subjectId is NOT an org id (that confusion was the original bug).
    organizations: { getById: vi.fn(async () => null) },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
      fn(txRepos as TxRepos),
    ),
  } as unknown as Repos;

  return { repos, upsertFn, revokeFn };
}

// ── upsertEmbed ──────────────────────────────────────────────────────────────

describe("upsertEmbed — human subject", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    subjectType: "human" as const,
    subjectId: ACTOR_ID,
    domain: DOMAIN,
  };

  it("allows an actor to register a domain for their OWN human subject", async () => {
    const { repos, upsertFn } = makeRepos();
    const result = await upsertEmbed({ repos }, input);

    expect(result.embed.subjectType).toBe("human");
    expect(result.embed.subjectId).toBe(ACTOR_ID);
    expect(result.embed.domain).toBe(DOMAIN);
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: "human", subjectId: ACTOR_ID }),
    );
  });

  it("never routes a human subject through the organizations repo (the original bug)", async () => {
    const { repos } = makeRepos();
    await upsertEmbed({ repos }, input);
    expect(repos.organizations.getById).not.toHaveBeenCalled();
  });

  it("rejects an actor managing someone ELSE's human subject", async () => {
    const { repos, upsertFn } = makeRepos();
    await expect(
      upsertEmbed({ repos }, { ...input, subjectId: OTHER_HUMAN_ID }),
    ).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "human" },
    });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("rejects a missing human subject with HUMAN_NOT_FOUND (not an authz error)", async () => {
    const { repos, upsertFn } = makeRepos({ humans: [] });
    await expect(upsertEmbed({ repos }, input)).rejects.toMatchObject({
      code: "HUMAN_NOT_FOUND",
    });
    expect(upsertFn).not.toHaveBeenCalled();
  });

  it("normalizes the domain to a bare hostname like every other subject", async () => {
    const { repos, upsertFn } = makeRepos();
    await upsertEmbed({ repos }, { ...input, domain: "https://MyBand.example.com/" });
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "myband.example.com" }),
    );
  });
});

// ── listEmbeds ───────────────────────────────────────────────────────────────

describe("listEmbeds — human subject", () => {
  const input = {
    actorHumanId: ACTOR_ID,
    subjectType: "human" as const,
    subjectId: ACTOR_ID,
  };

  it("lists embeds for the actor's own human subject", async () => {
    const { repos } = makeRepos();
    const result = await listEmbeds({ repos }, input);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]!.subjectType).toBe("human");
  });

  it("rejects listing someone ELSE's human embeds", async () => {
    const { repos } = makeRepos();
    await expect(
      listEmbeds({ repos }, { ...input, subjectId: OTHER_HUMAN_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects a missing human subject", async () => {
    const { repos } = makeRepos({ humans: [] });
    await expect(listEmbeds({ repos }, input)).rejects.toMatchObject({
      code: "HUMAN_NOT_FOUND",
    });
  });
});

// ── revokeEmbed ──────────────────────────────────────────────────────────────

describe("revokeEmbed — human subject", () => {
  const input = { actorHumanId: ACTOR_ID, embedId: EMBED_ID };

  it("revokes the actor's own human embed", async () => {
    const { repos, revokeFn } = makeRepos();
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
    expect(revokeFn).toHaveBeenCalledWith(EMBED_ID);
  });

  it("rejects revoking an embed whose STORED subject is another human", async () => {
    const { repos, revokeFn } = makeRepos({
      embed: { ...humanEmbed, subjectId: OTHER_HUMAN_ID },
    });
    await expect(revokeEmbed({ repos }, input)).rejects.toMatchObject({
      code: "NOT_RESOURCE_OWNER",
      meta: { entity: "human" },
    });
    expect(revokeFn).not.toHaveBeenCalled();
  });

  it("rejects when the stored human subject no longer exists", async () => {
    const { repos } = makeRepos({ humans: [] });
    await expect(revokeEmbed({ repos }, input)).rejects.toMatchObject({
      code: "HUMAN_NOT_FOUND",
    });
  });

  it("is idempotent for an already-revoked embed", async () => {
    const { repos, revokeFn } = makeRepos({
      embed: { ...humanEmbed, status: "REVOKED" },
    });
    const result = await revokeEmbed({ repos }, input);
    expect(result.embed.status).toBe("REVOKED");
    expect(revokeFn).not.toHaveBeenCalled();
  });
});
