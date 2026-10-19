import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { HumanRecord } from "@th/types/repos/humans";
import { createTestLogger } from "@th/test-utils";

import {
  getPerformerShareLinks,
  type GetPerformerShareLinksDeps,
} from "./get-performer-share-links";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? randomUUID(),
  orgId: overrides.orgId ?? randomUUID(),
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
  // Defaults to "has been live": every pre-existing case here describes a
  // PUBLISHED event, and `publishedAt` is now the field the share-link gate
  // reads. Cases that want a never-announced event pass `publishedAt: null`.
  publishedAt:
    "publishedAt" in overrides
      ? (overrides.publishedAt as Date | null)
      : new Date("2025-06-01T00:00:00.000Z"),
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
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

const humanFactory = (overrides: Partial<HumanRecord> = {}): HumanRecord => ({
  id: overrides.id ?? randomUUID(),
  name: overrides.name ?? "Platform Human",
  status: "ACTIVE" as const,
  roles: [],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
  trustTier: "NEW" as const,
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date(),
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
  humans?: HumanRecord[];
  membershipRole?: string | null;
}): GetPerformerShareLinksDeps {
  const {
    event = eventFactory({ id: EVENT_ID, orgId: ORG_ID }),
    eventHumans = [],
    humans = [],
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
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          humans.filter((h) => ids.includes(h.id)),
        ),
      } as any,
      authz: {
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

describe("getPerformerShareLinks", () => {
  it("returns only performer-role humans with correct share URLs", async () => {
    const performerEH = eventHumanFactory({
      eventId: EVENT_ID,
      role: "PERFORMER",
      externalName: "Performer One",
    });
    const djEH = eventHumanFactory({
      eventId: EVENT_ID,
      role: "DJ",
      externalName: "DJ Two",
    });
    const hostEH = eventHumanFactory({
      eventId: EVENT_ID,
      role: "HOST",
      externalName: "Host Three",
    });
    const vendorEH = eventHumanFactory({
      eventId: EVENT_ID,
      role: "VENDOR",
      externalName: "Vendor Four",
    });

    const deps = makeDeps({
      eventHumans: [performerEH, djEH, hostEH, vendorEH],
    });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    // HOST is no longer treated as a performer (removed from PERFORMER_ROLES
    // when the share-links UX was tightened — HOSTs don't get attribution
    // share URLs alongside actual artists).
    expect(result.performers).toHaveLength(2);
    expect(result.venueUrl).toBe(
      "https://ithasfire.com/events/test-event",
    );

    const ids = result.performers.map((p) => p.eventHumanId);
    expect(ids).toContain(performerEH.id);
    expect(ids).toContain(djEH.id);
    expect(ids).not.toContain(hostEH.id);
    expect(ids).not.toContain(vendorEH.id);

    for (const p of result.performers) {
      expect(p.shareUrl).toBe(`${result.venueUrl}?ref=${p.eventHumanId}`);
    }
  });

  it("returns empty performers array when no event humans exist", async () => {
    const deps = makeDeps({ eventHumans: [] });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.performers).toEqual([]);
    expect(result.venueUrl).toBe(
      "https://ithasfire.com/events/test-event",
    );
  });

  it("throws not_found when event does not exist", async () => {
    const deps = makeDeps({ event: null });

    await expect(
      getPerformerShareLinks(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("resolves name from linked human when humanId is set, falls back to externalName", async () => {
    const linkedHumanId = randomUUID();
    const linkedHuman = humanFactory({
      id: linkedHumanId,
      name: "Linked Artist",
    });

    const withLinkedHuman = eventHumanFactory({
      eventId: EVENT_ID,
      role: "PERFORMER",
      humanId: linkedHumanId,
      externalName: "Fallback Name",
    });
    const withExternalOnly = eventHumanFactory({
      eventId: EVENT_ID,
      role: "SPEAKER",
      humanId: null,
      externalName: "External Speaker",
    });
    const withNothing: EventHumanRecord = {
      ...eventHumanFactory({
        eventId: EVENT_ID,
        role: "INSTRUCTOR",
        humanId: null,
      }),
      externalName: null,
    };

    const deps = makeDeps({
      eventHumans: [withLinkedHuman, withExternalOnly, withNothing],
      humans: [linkedHuman],
    });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.performers).toHaveLength(3);

    const linked = result.performers.find(
      (p) => p.eventHumanId === withLinkedHuman.id,
    );
    expect(linked?.name).toBe("Linked Artist");

    const external = result.performers.find(
      (p) => p.eventHumanId === withExternalOnly.id,
    );
    expect(external?.name).toBe("External Speaker");

    const unknown = result.performers.find(
      (p) => p.eventHumanId === withNothing.id,
    );
    expect(unknown?.name).toBe("Unknown");
  });

  it("emits NO share links when the event has no slug", async () => {
    const event = eventFactory({ id: EVENT_ID, orgId: ORG_ID, slug: null });
    const performer = eventHumanFactory({
      eventId: EVENT_ID,
      role: "PERFORMER",
      externalName: "Artist",
    });

    const deps = makeDeps({ event, eventHumans: [performer] });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    // The old `?? event.id` fallback handed every performer a link that 404s
    // (the public event route resolves by slug / slug history only). No slug →
    // no link, rather than a set of dead ones a performer would go post.
    expect(result.venueUrl).toBeNull();
    expect(result.performers[0].shareUrl).toBeNull();
  });

  it("emits NO share links for a NEVER-PUBLISHED draft, even though it HAS a slug", async () => {
    // Slug-at-create means a draft carries a slug from birth, so "has a slug"
    // stopped being a proxy for "has been announced". Without the publishedAt
    // check this use case would have quietly started handing every performer a
    // working public `?ref=` URL for an unannounced show.
    const event = eventFactory({
      id: EVENT_ID,
      orgId: ORG_ID,
      status: "DRAFT",
      publishedAt: null,
      slug: "acme/us/mo/test-event-2025-07-01-1800--abc1234567",
    });
    const performer = eventHumanFactory({
      eventId: EVENT_ID,
      role: "PERFORMER",
      externalName: "Artist",
    });

    const deps = makeDeps({ event, eventHumans: [performer] });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.venueUrl).toBeNull();
    expect(result.performers[0].shareUrl).toBeNull();
  });

  it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "KEEPS share links for a %s event that was published",
    async (status) => {
      // The gate is "was this ever public?", not "is it selling right now".
      // Gating on `status === "PUBLISHED"` would delete a performer's
      // attribution link the moment the gig ended or got called off — exactly
      // when they are most likely to go looking for it — and would override
      // public-urls.ts's deliberate "status is not a condition" rule for this
      // one caller.
      const event = eventFactory({
        id: EVENT_ID,
        orgId: ORG_ID,
        status,
        slug: "acme/us/mo/test-event-2025-07-01-1800--abc1234567",
      });
      const deps = makeDeps({
        event,
        eventHumans: [
          eventHumanFactory({ eventId: EVENT_ID, role: "PERFORMER" }),
        ],
      });

      const result = await getPerformerShareLinks(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      });

      expect(result.venueUrl).toBe(
        "https://ithasfire.com/events/acme/us/mo/test-event-2025-07-01-1800--abc1234567",
      );
      expect(result.performers[0].shareUrl).toBe(
        `${result.venueUrl}?ref=${result.performers[0].eventHumanId}`,
      );
    },
  );

  it("emits NO share links for an UNPUBLISHED event that never went live", async () => {
    // A draft that was saved, never published, then archived. `publishedAt`
    // stays null, so there is nothing to share.
    const event = eventFactory({
      id: EVENT_ID,
      orgId: ORG_ID,
      status: "ARCHIVED",
      publishedAt: null,
      slug: "acme/us/mo/test-event-2025-07-01-1800--abc1234567",
    });
    const deps = makeDeps({
      event,
      eventHumans: [eventHumanFactory({ eventId: EVENT_ID, role: "PERFORMER" })],
    });

    const result = await getPerformerShareLinks(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result.venueUrl).toBeNull();
  });

  it("throws forbidden when actor lacks org access", async () => {
    const deps = makeDeps({ membershipRole: null });

    await expect(
      getPerformerShareLinks(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});
