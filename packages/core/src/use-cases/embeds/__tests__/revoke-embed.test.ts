import { describe, expect, it, vi } from "vitest";

import { revokeEmbed } from "../revoke-embed";
import type { RevokeEmbedDeps } from "../revoke-embed";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { EventRecord } from "@th/ports/repos/events";

// ── Defaults ─────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EMBED_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-4000-8000-000000000004";

const baseEmbed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "event",
  subjectId: EVENT_ID,
  domain: "example.com",
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: ACTOR_ID,
  createdAt: new Date("2025-01-01"),
};

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Launch Party",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-02-01T20:00:00Z"),
  endsAt: new Date("2025-02-01T23:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  locality: null,
  region: null,
  countryCode: null,
  postalCode: null,
  shortId: null,
  slug: null,
  currency: "usd",
  heroImageUrl: null,
  content: null,
  payoutSchedule: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  feePolicyId: null,
  seriesId: null,
  nextOccurrenceId: null,
  timezone: null,
  cancelledAt: null,
  createdAt: new Date("2025-01-01"),
  updatedAt: new Date("2025-01-01"),
} as EventRecord;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: {
  embed?: EmbedRecord | null;
  event?: EventRecord | null;
  orgExists?: boolean;
  membershipRole?: string | null;
  revokedEmbed?: Partial<EmbedRecord>;
}): RevokeEmbedDeps {
  const {
    embed = baseEmbed,
    event = baseEvent,
    orgExists = true,
    membershipRole = "ADMIN",
    revokedEmbed,
  } = overrides;

  const revokeFn = vi.fn(async () => ({
    ...embed!,
    status: "REVOKED",
    ...revokedEmbed,
  }));

  const txRepos: Partial<TxRepos> = {
    embeds: { revoke: revokeFn } as any,
    audit: { log: vi.fn() } as any,
  };

  return {
    repos: {
      embeds: {
        getById: vi.fn(async () => embed),
      },
      events: {
        getById: vi.fn(async () => event),
      },
      organizations: {
        getById: vi.fn(async () =>
          orgExists ? { id: ORG_ID, name: "Acme Org" } : null,
        ),
      },
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn(async () =>
          membershipRole ? { role: membershipRole } : null,
        ),
      },
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("revokeEmbed", () => {
  const validInput = { actorHumanId: ACTOR_ID, embedId: EMBED_ID };

  it("revokes an event-scoped embed for an org admin", async () => {
    const deps = makeDeps({});
    const result = await revokeEmbed(deps, validInput);
    expect(result.embed.status).toBe("REVOKED");
    expect(result.embed.id).toBe(EMBED_ID);
  });

  it("revokes an event-scoped embed for a solo human owner", async () => {
    const deps = makeDeps({
      event: { ...baseEvent, orgId: null, humanId: ACTOR_ID },
      membershipRole: null,
    });
    const result = await revokeEmbed(deps, validInput);
    expect(result.embed.status).toBe("REVOKED");
  });

  it("revokes an organization-scoped embed for an org admin", async () => {
    const deps = makeDeps({
      embed: { ...baseEmbed, subjectType: "organization", subjectId: ORG_ID },
    });
    const result = await revokeEmbed(deps, validInput);
    expect(result.embed.status).toBe("REVOKED");
  });

  it("returns early when embed is already revoked", async () => {
    const deps = makeDeps({
      embed: { ...baseEmbed, status: "REVOKED" },
    });
    const result = await revokeEmbed(deps, validInput);
    expect(result.embed.status).toBe("REVOKED");
    // tx should not be called
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("throws not_found when embed does not exist", async () => {
    const deps = makeDeps({ embed: null });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
  });

  it("throws forbidden when org member lacks MANAGE role (event embed)", async () => {
    const deps = makeDeps({ membershipRole: "VIEWER" });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden when org member lacks MANAGE role (org embed)", async () => {
    const deps = makeDeps({
      embed: { ...baseEmbed, subjectType: "organization", subjectId: ORG_ID },
      membershipRole: "VIEWER",
    });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws not_found when organization does not exist (org embed)", async () => {
    const deps = makeDeps({
      embed: { ...baseEmbed, subjectType: "organization", subjectId: ORG_ID },
      orgExists: false,
    });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("throws forbidden when actor is not the solo event owner", async () => {
    const deps = makeDeps({
      event: {
        ...baseEvent,
        orgId: null,
        humanId: "00000000-0000-4000-8000-000000000099",
      },
      membershipRole: null,
    });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found when event does not exist (event embed)", async () => {
    const deps = makeDeps({ event: null });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws invalid_input for unsupported subject type", async () => {
    // "place" became a supported subject (booking-request embed button) —
    // use a genuinely unknown type to exercise the fail-closed default.
    const deps = makeDeps({
      embed: { ...baseEmbed, subjectType: "series" },
    });
    await expect(revokeEmbed(deps, validInput)).rejects.toMatchObject({ code: "UNSUPPORTED_SUBJECT_TYPE" });
  });
});
