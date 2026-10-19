import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils";

import {
  attachEventHuman,
  type AttachEventHumanDeps,
} from "./attach-event-human";

const ACTOR_ID = randomUUID();
const EVENT_ID = randomUUID();
const ORG_ID = randomUUID();

const now = new Date("2026-04-22T12:00:00.000Z");

const eventFactory = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: overrides.id ?? EVENT_ID,
  orgId: "orgId" in overrides ? overrides.orgId! : ORG_ID,
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
  startsAt: new Date("2026-05-01T18:00:00.000Z"),
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

function makeDeps(overrides?: {
  event?: EventRecord | null;
}): AttachEventHumanDeps {
  const event = overrides?.event ?? eventFactory();

  const tx = {
    events: {
      getById: vi.fn(async () => event),
    },
    eventHumans: {
      attach: vi.fn(async (input) => ({
        id: randomUUID(),
        eventId: input.eventId,
        humanId: input.humanId ?? null,
        externalName: input.externalName ?? null,
        externalUrl: input.externalUrl ?? null,
        role: input.role,
        customRoleLabel: input.customRoleLabel ?? null,
        sortOrder: input.sortOrder ?? 0,
        createdAt: now,
        updatedAt: now,
        profileSlug: null,
        humanDisplayName: null,
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER",
      })),
    },
    audit: {
      log: vi.fn(async () => undefined),
    },
  } as any;

  return {
    repos: {
      tx: vi.fn(async (fn) => fn(tx)),
    } as any,
    clock: { now: () => now },
    logger: createTestLogger(),
  };
}

describe("attachEventHuman", () => {
  it("allows null externalUrl for normal external lineup entries", async () => {
    const deps = makeDeps();

    const result = await attachEventHuman(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      externalName: "External Artist",
      externalUrl: null,
      role: "PERFORMER",
      sortOrder: 0,
    });

    expect(result.externalUrl).toBeNull();
  });

  it("rejects unsafe externalUrl protocols", async () => {
    const deps = makeDeps();

    await expect(
      attachEventHuman(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        externalName: "External Artist",
        externalUrl: "javascript:alert(1)",
        role: "PERFORMER",
        sortOrder: 0,
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: expect.arrayContaining([
        expect.objectContaining({ message: "external_url_invalid_protocol" }),
      ]),
    });
  });
});
