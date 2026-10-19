import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import { createTestLogger } from "@th/test-utils";

import { listEventHumans, type ListEventHumansDeps } from "./list-event-humans";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? randomUUID(),
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
  startsAt: new Date("2025-07-01T18:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: "123 Test St",
  lat: 38.9517,
  lng: -92.3341,
  slug: "slug" in overrides ? (overrides.slug as string | null) : "test-event",
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
  eventId: overrides.eventId ?? randomUUID(),
  humanId: overrides.humanId ?? null,
  externalName: overrides.externalName ?? "External Artist",
  externalUrl: overrides.externalUrl ?? null,
  role: overrides.role ?? "PERFORMER",
  customRoleLabel: overrides.customRoleLabel ?? null,
  sortOrder: overrides.sortOrder ?? 0,
  profileSlug: overrides.profileSlug ?? null,
  humanDisplayName: overrides.humanDisplayName ?? null,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_ID = randomUUID();
const ORG_ID = randomUUID();
const EVENT_ID = randomUUID();

function makeDeps(overrides: {
  event?: EventRecord | null;
  eventHumans?: EventHumanRecord[];
  membershipRole?: string | null;
}): ListEventHumansDeps {
  const {
    event = eventFactory({ id: EVENT_ID, orgId: ORG_ID }),
    eventHumans = [],
    membershipRole = "OWNER",
  } = overrides;

  return {
    repos: {
      events: {
        getById: vi.fn(async () => event),
      } as any,
      eventHumans: {
        listByEvent: vi.fn(async () => eventHumans),
      } as any,
      authz: {
        getHumanDelegation: vi.fn(async () => null),
        getOrgMembership: vi.fn(async () =>
          membershipRole
            ? { orgId: ORG_ID, humanId: ACTOR_ID, role: membershipRole }
            : null,
        ),
      } as any,
    },
    logger: createTestLogger(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventHumans", () => {
  it("returns all lineup members with enriched profileSlug and humanDisplayName", async () => {
    const humanId = randomUUID();
    const linked = eventHumanFactory({
      eventId: EVENT_ID,
      humanId,
      externalName: null,
      profileSlug: "janedoe",
      humanDisplayName: "Jane Doe",
    });
    const external = eventHumanFactory({
      eventId: EVENT_ID,
      humanId: null,
      externalName: "External DJ",
      externalUrl: "https://example.com",
      profileSlug: null,
      humanDisplayName: null,
    });

    const deps = makeDeps({ eventHumans: [linked, external] });

    const result = await listEventHumans(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toHaveLength(2);

    const linkedResult = result.find((r) => r.id === linked.id)!;
    expect(linkedResult.humanId).toBe(humanId);
    expect(linkedResult.profileSlug).toBe("janedoe");
    expect(linkedResult.humanDisplayName).toBe("Jane Doe");

    const externalResult = result.find((r) => r.id === external.id)!;
    expect(externalResult.humanId).toBeNull();
    expect(externalResult.profileSlug).toBeNull();
    expect(externalResult.humanDisplayName).toBeNull();
    expect(externalResult.externalName).toBe("External DJ");
  });

  it("returns empty array when no lineup members exist", async () => {
    const deps = makeDeps({ eventHumans: [] });

    const result = await listEventHumans(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual([]);
  });

  it("handles linked human with humanId but no EntityPage (profileSlug null)", async () => {
    const humanId = randomUUID();
    const noPage = eventHumanFactory({
      eventId: EVENT_ID,
      humanId,
      profileSlug: null,
      humanDisplayName: null,
    });

    const deps = makeDeps({ eventHumans: [noPage] });

    const result = await listEventHumans(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result[0]!.humanId).toBe(humanId);
    expect(result[0]!.profileSlug).toBeNull();
    expect(result[0]!.humanDisplayName).toBeNull();
  });

  it("throws not_found when event does not exist", async () => {
    const deps = makeDeps({ event: null });

    await expect(
      listEventHumans(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws forbidden when actor is not an org member", async () => {
    const deps = makeDeps({ membershipRole: null });

    await expect(
      listEventHumans(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws forbidden when actor is a personal-event non-owner", async () => {
    const otherOwnerId = randomUUID();
    const personalEvent = eventFactory({
      id: EVENT_ID,
      orgId: null,
      humanId: otherOwnerId,
    });
    const deps = makeDeps({ event: personalEvent });

    await expect(
      listEventHumans(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("allows access when actor is the personal-event owner", async () => {
    const personalEvent = eventFactory({
      id: EVENT_ID,
      orgId: null,
      humanId: ACTOR_ID,
    });
    const deps = makeDeps({
      event: personalEvent,
      eventHumans: [],
    });

    // Override authz to not be called (personal event path skips org check)
    const result = await listEventHumans(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual([]);
  });
});
