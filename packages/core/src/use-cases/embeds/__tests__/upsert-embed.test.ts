import { describe, expect, it, vi } from "vitest";

import { upsertEmbed } from "../upsert-embed";
import type { UpsertEmbedDeps } from "../upsert-embed";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EmbedRecord } from "@th/types/repos/embeds";
import type { EventRecord } from "@th/ports/repos/events";

// ── Defaults ─────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const DOMAIN = "shop.example.com";

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: null,
  humanId: ACTOR_ID,
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

/**
 * Builds deps with a stateful in-memory embeds upsert mock so we can assert
 * persistence + toggling behaviour across multiple calls.
 */
function makeDeps(opts: { event?: EventRecord | null } = {}): {
  deps: UpsertEmbedDeps;
  upsertFn: ReturnType<typeof vi.fn>;
} {
  const { event = baseEvent } = opts;

  const store = new Map<string, EmbedRecord>();
  const upsertFn = vi.fn(
    async (input: {
      subjectType: string;
      subjectId: string;
      domain: string;
      createdBy: string;
      requireAuth?: boolean;
      linkOut?: boolean;
      defaultView?: string;
      viewToggle?: boolean;
    }): Promise<EmbedRecord> => {
      const key = `${input.subjectType}:${input.subjectId}:${input.domain}`;
      const existing = store.get(key);
      const record: EmbedRecord = {
        id: existing?.id ?? "00000000-0000-4000-8000-0000000000ff",
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        domain: input.domain,
        status: "ACTIVE",
        requireAuth:
          input.requireAuth ?? existing?.requireAuth ?? false,
        linkOut: input.linkOut ?? existing?.linkOut ?? false,
        defaultView: input.defaultView ?? existing?.defaultView ?? "list",
        viewToggle: input.viewToggle ?? existing?.viewToggle ?? false,
        createdBy: input.createdBy,
        createdAt: existing?.createdAt ?? new Date("2025-01-01"),
      };
      store.set(key, record);
      return record;
    },
  );

  const txRepos: Partial<TxRepos> = {
    embeds: { upsert: upsertFn } as any,
    audit: { log: vi.fn() } as any,
  };

  const deps = {
    repos: {
      events: {
        getById: vi.fn(async () => event),
      },
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as TxRepos),
      ),
    } as unknown as Repos,
  };

  return { deps, upsertFn };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("upsertEmbed — domain normalization", () => {
  const baseInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "event" as const,
    subjectId: EVENT_ID,
  };

  it("normalizes a pasted URL to its bare lowercase hostname", async () => {
    const { deps, upsertFn } = makeDeps();
    const result = await upsertEmbed(deps, {
      ...baseInput,
      domain: "https://Example.com/path",
    });

    expect(result.embed.domain).toBe("example.com");
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "example.com" }),
    );
  });

  it("strips a trailing slash / path from a scheme-less paste", async () => {
    const { deps } = makeDeps();
    const result = await upsertEmbed(deps, {
      ...baseInput,
      domain: "shop.example.com/tickets/",
    });
    expect(result.embed.domain).toBe("shop.example.com");
  });

  it("rejects input that cannot yield a hostname with EMBED_DOMAIN_INVALID", async () => {
    const { deps, upsertFn } = makeDeps();
    await expect(
      upsertEmbed(deps, { ...baseInput, domain: "not a domain at all" }),
    ).rejects.toMatchObject({ code: "EMBED_DOMAIN_INVALID" });
    expect(upsertFn).not.toHaveBeenCalled();
  });
});

describe("upsertEmbed — linkOut", () => {
  const baseInput = {
    actorHumanId: ACTOR_ID,
    subjectType: "event" as const,
    subjectId: EVENT_ID,
    domain: DOMAIN,
  };

  it("persists and returns linkOut: true when requested", async () => {
    const { deps } = makeDeps();
    const result = await upsertEmbed(deps, { ...baseInput, linkOut: true });
    expect(result.embed.linkOut).toBe(true);
  });

  it("defaults linkOut to false when omitted", async () => {
    const { deps } = makeDeps();
    const result = await upsertEmbed(deps, baseInput);
    expect(result.embed.linkOut).toBe(false);
  });

  it("toggles linkOut on an existing (subjectType, subjectId, domain) embed", async () => {
    const { deps } = makeDeps();

    const created = await upsertEmbed(deps, { ...baseInput, linkOut: true });
    expect(created.embed.linkOut).toBe(true);

    const toggledOff = await upsertEmbed(deps, {
      ...baseInput,
      linkOut: false,
    });
    expect(toggledOff.embed.id).toBe(created.embed.id);
    expect(toggledOff.embed.linkOut).toBe(false);
  });
});
