import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type {
  EntityPageRecord,
  PageBlockRecord,
} from "@th/types/repos/entity-pages";
import { createTestLogger } from "@th/test-utils";

import {
  listPublicEventHumans,
  type ListPublicEventHumansDeps,
} from "../list-public-event-humans";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = randomUUID();

const SPOTIFY_ARTIST = "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF";
const SOUNDCLOUD_TRACK = "https://soundcloud.com/forss/flickermood";

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? EVENT_ID,
  orgId: "orgId" in overrides ? overrides.orgId! : randomUUID(),
  humanId: overrides.humanId ?? null,
  title: overrides.title ?? "Test Event",
  status: overrides.status ?? "PUBLISHED",
  visibility: "PUBLIC" as const,
  gateType: "NONE" as const,
  locationMode: "EXACT" as const,
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-08-01T18:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Test St",
  lat: 38.9517,
  lng: -92.3341,
  slug: "test-event",
  shortId: "tst001",
  regionCode: "mo",
  publishedAt: null,
  agreementPrimaryId: randomUUID(),
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED" as const,
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
});

const eventHumanFactory = (
  overrides: Partial<EventHumanRecord> = {},
): EventHumanRecord => ({
  id: overrides.id ?? randomUUID(),
  eventId: overrides.eventId ?? EVENT_ID,
  humanId: "humanId" in overrides ? (overrides.humanId ?? null) : null,
  externalName:
    "externalName" in overrides
      ? (overrides.externalName ?? null)
      : "External Artist",
  externalUrl: overrides.externalUrl ?? null,
  role: overrides.role ?? "PERFORMER",
  customRoleLabel: overrides.customRoleLabel ?? null,
  sortOrder: overrides.sortOrder ?? 0,
  profileSlug: overrides.profileSlug ?? null,
  humanDisplayName: overrides.humanDisplayName ?? null,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

const pageFactory = (
  overrides: Partial<EntityPageRecord> = {},
): EntityPageRecord => ({
  id: overrides.id ?? randomUUID(),
  ownerType: overrides.ownerType ?? "HUMAN",
  ownerId: overrides.ownerId ?? randomUUID(),
  slug: overrides.slug ?? `page-${randomUUID().slice(0, 8)}`,
  displayName: overrides.displayName ?? null,
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: overrides.visibility ?? "PUBLIC",
  allowFollows: true,
  showFollowerCount: false,
  category: null,
  templateAppliedCategories: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

let blockSeq = 0;
const blockFactory = (
  overrides: Partial<PageBlockRecord> = {},
): PageBlockRecord => {
  blockSeq += 1;
  return {
    id: overrides.id ?? randomUUID(),
    pageId: overrides.pageId ?? randomUUID(),
    kind: overrides.kind ?? "tracks",
    orderIndex: overrides.orderIndex ?? blockSeq,
    data: "data" in overrides ? overrides.data : {},
    visible: overrides.visible ?? true,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

function makeDeps(overrides: {
  event?: EventRecord | null;
  eventHumans?: EventHumanRecord[];
  humans?: Array<{ id: string; name: string | null }>;
  pages?: EntityPageRecord[];
  blocks?: PageBlockRecord[];
}) {
  const {
    event = eventFactory(),
    eventHumans = [],
    humans = [],
    pages = [],
    blocks = [],
  } = overrides;

  const deps = {
    repos: {
      events: {
        getById: vi.fn(async () => event),
      } as any,
      eventHumans: {
        listByEvent: vi.fn(async () => eventHumans),
      } as any,
      humans: {
        getByIds: vi.fn(async () => humans),
      } as any,
      entityPages: {
        getByOwners: vi.fn(async () => pages),
        listBlocksByPageIds: vi.fn(async () => blocks),
      } as any,
    },
    logger: createTestLogger(),
  } satisfies ListPublicEventHumansDeps;

  return deps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listPublicEventHumans — listenUrl derivation", () => {
  it("derives listenUrl from a PUBLIC page's visible tracks block", async () => {
    const humanId = randomUUID();
    const page = pageFactory({ ownerId: humanId });
    const deps = makeDeps({
      eventHumans: [eventHumanFactory({ humanId })],
      humans: [{ id: humanId, name: "Forss" }],
      pages: [page],
      blocks: [
        blockFactory({
          pageId: page.id,
          kind: "tracks",
          data: { tracks: [{ url: SOUNDCLOUD_TRACK, title: "Flickermood" }] },
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Forss");
    expect(result[0]!.listenUrl).toBe(SOUNDCLOUD_TRACK);
  });

  it("returns null listenUrl for a non-PUBLIC page", async () => {
    const humanId = randomUUID();
    const page = pageFactory({ ownerId: humanId, visibility: "UNLISTED" });
    const deps = makeDeps({
      eventHumans: [eventHumanFactory({ humanId })],
      humans: [{ id: humanId, name: "Hidden" }],
      pages: [page],
      blocks: [
        blockFactory({
          pageId: page.id,
          kind: "tracks",
          data: { tracks: [{ url: SOUNDCLOUD_TRACK }] },
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result[0]!.listenUrl).toBeNull();
    // No PUBLIC pages → the blocks query is skipped entirely.
    expect(deps.repos.entityPages.listBlocksByPageIds).not.toHaveBeenCalled();
  });

  it("skips hidden blocks (visible=false) when deriving", async () => {
    const humanId = randomUUID();
    const page = pageFactory({ ownerId: humanId });
    const deps = makeDeps({
      eventHumans: [eventHumanFactory({ humanId })],
      humans: [{ id: humanId, name: "Shy" }],
      pages: [page],
      blocks: [
        blockFactory({
          pageId: page.id,
          kind: "tracks",
          visible: false,
          data: { tracks: [{ url: SOUNDCLOUD_TRACK }] },
        }),
        blockFactory({
          pageId: page.id,
          kind: "links",
          visible: true,
          data: { links: [{ label: "Spotify", url: SPOTIFY_ARTIST }] },
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    // The hidden tracks block must not contribute; the visible links block does.
    expect(result[0]!.listenUrl).toBe(SPOTIFY_ARTIST);
  });

  it("returns null listenUrl when the human has no page", async () => {
    const humanId = randomUUID();
    const deps = makeDeps({
      eventHumans: [eventHumanFactory({ humanId })],
      humans: [{ id: humanId, name: "Pageless" }],
      pages: [],
      blocks: [],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result[0]!.listenUrl).toBeNull();
  });

  it("external entry: Spotify artist externalUrl becomes listenUrl", async () => {
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({
          humanId: null,
          externalName: "Touring Act",
          externalUrl: SPOTIFY_ARTIST,
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result[0]!.listenUrl).toBe(SPOTIFY_ARTIST);
    // profileUrl still carries the raw externalUrl.
    expect(result[0]!.profileUrl).toBe(SPOTIFY_ARTIST);
  });

  it("external entry: a plain website externalUrl yields null listenUrl", async () => {
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({
          humanId: null,
          externalName: "Website Band",
          externalUrl: "https://example.com/band",
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result[0]!.listenUrl).toBeNull();
    expect(result[0]!.profileUrl).toBe("https://example.com/band");
  });

  it("external entry: a YouTube externalUrl yields null (music providers only)", async () => {
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({
          humanId: null,
          externalName: "Vlogger",
          externalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result[0]!.listenUrl).toBeNull();
  });

  it("calls the batched accessors exactly once for a multi-member lineup", async () => {
    const humanA = randomUUID();
    const humanB = randomUUID();
    const pageA = pageFactory({ ownerId: humanA });
    const pageB = pageFactory({ ownerId: humanB });
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({ humanId: humanA, sortOrder: 0 }),
        eventHumanFactory({ humanId: humanB, sortOrder: 1 }),
        eventHumanFactory({
          humanId: null,
          externalName: "Ext",
          sortOrder: 2,
        }),
      ],
      humans: [
        { id: humanA, name: "A" },
        { id: humanB, name: "B" },
      ],
      pages: [pageA, pageB],
      blocks: [
        blockFactory({
          pageId: pageA.id,
          kind: "music",
          data: { embeds: [{ url: SOUNDCLOUD_TRACK }] },
        }),
      ],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(deps.repos.entityPages.getByOwners).toHaveBeenCalledTimes(1);
    expect(deps.repos.entityPages.getByOwners).toHaveBeenCalledWith("HUMAN", [
      humanA,
      humanB,
    ]);
    expect(deps.repos.entityPages.listBlocksByPageIds).toHaveBeenCalledTimes(1);
    expect(deps.repos.entityPages.listBlocksByPageIds).toHaveBeenCalledWith([
      pageA.id,
      pageB.id,
    ]);

    const byName = new Map(result.map((r) => [r.name, r]));
    expect(byName.get("A")!.listenUrl).toBe(SOUNDCLOUD_TRACK);
    expect(byName.get("B")!.listenUrl).toBeNull();
    expect(byName.get("Ext")!.listenUrl).toBeNull();
  });

  it("skips page queries entirely when the lineup has no linked humans", async () => {
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({ humanId: null, externalName: "Solo Ext" }),
      ],
    });

    await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(deps.repos.entityPages.getByOwners).not.toHaveBeenCalled();
    expect(deps.repos.entityPages.listBlocksByPageIds).not.toHaveBeenCalled();
  });

  it("still filters VOLUNTEER records out of the public lineup", async () => {
    const humanId = randomUUID();
    const deps = makeDeps({
      eventHumans: [
        eventHumanFactory({ humanId, role: "PERFORMER" }),
        eventHumanFactory({
          humanId: randomUUID(),
          role: "VOLUNTEER" as EventHumanRecord["role"],
        }),
      ],
      humans: [{ id: humanId, name: "Performer" }],
    });

    const result = await listPublicEventHumans(deps, { eventId: EVENT_ID });

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("Performer");
  });

  it("throws EVENT_NOT_FOUND for a missing event", async () => {
    const deps = makeDeps({ event: null });

    await expect(
      listPublicEventHumans(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws EVENT_NOT_PUBLISHED for a draft event", async () => {
    const deps = makeDeps({ event: eventFactory({ status: "DRAFT" }) });

    await expect(
      listPublicEventHumans(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });
});
