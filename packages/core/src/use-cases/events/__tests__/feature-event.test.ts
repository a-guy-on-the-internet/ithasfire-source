import { describe, expect, it, vi } from "vitest";

import type { FeatureEventDeps } from "../feature-event";
import { featureEvent } from "../feature-event";

const admin = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  name: "Admin",
  phone: null,
  status: "ACTIVE",

  roles: ["ADMIN"],
  emailVerified: true,
  phoneVerified: false,
};

const publishedEvent = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId: "33333333-3333-4333-8333-333333333333",
  humanId: null,
  title: "Show",
  status: "PUBLISHED" as const,
  startsAt: new Date("2025-05-01T20:00:00.000Z"),
  endsAt: new Date("2025-05-01T23:00:00.000Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "show",
  shortId: "show1",
  regionCode: null,
  publishedAt: new Date("2025-04-01T18:00:00.000Z"),
  agreementPrimaryId: "44444444-4444-4444-8444-444444444444",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
};

type TestOverrides = Partial<FeatureEventDeps> & {
  eventStatus?: string;
  /** The authz port's answer for the actor. Defaults to an enrolled ADMIN. */
  staff?: { allowed: boolean; secondFactorRequired?: true };
};

const buildDeps = (
  overrides: TestOverrides = {},
): FeatureEventDeps & {
  txAuditLog: ReturnType<typeof vi.fn>;
  hasStaffRole: ReturnType<typeof vi.fn>;
  upsertPlacement: ReturnType<typeof vi.fn>;
} => {
  const event = overrides.eventStatus
    ? {
        ...publishedEvent,
        status: overrides.eventStatus as typeof publishedEvent.status,
      }
    : publishedEvent;

  const txAuditLog = vi.fn();

  const upsertPlacement = vi.fn(async () => ({
    id: "55555555-5555-4555-8555-555555555555",
    eventId: event.id,
    curatedByHumanId: admin.id,
    curatedAt: overrides.clock
      ? overrides.clock.now()
      : new Date("2025-04-15T00:00:00.000Z"),
    curatedUntil: event.endsAt,
    notes: null,
  }));

  const tx = {
    events: {
      getById: vi.fn(async () => event),
    },
    featuredEvents: {
      upsertPlacement,
    },
    audit: {
      log: txAuditLog,
    },
  } as any;

  const repos = {
    // The raw role read says ADMIN for everyone; the port's answer decides.
    humans: {
      getById: vi.fn(async () => admin),
    },
    tx: vi.fn((fn: (txRepos: typeof tx) => Promise<any>) => fn(tx)),
  } as unknown as FeatureEventDeps["repos"];

  const hasStaffRole = vi.fn(async () => overrides.staff ?? { allowed: true });

  const clock =
    overrides.clock ??
    ({
      now: vi.fn(() => new Date("2025-04-15T00:00:00.000Z")),
    } as FeatureEventDeps["clock"]);

  return {
    repos,
    authz: { hasStaffRole },
    clock,
    logger: overrides.logger,
    txAuditLog,
    hasStaffRole,
    upsertPlacement,
  };
};

describe("featureEvent", () => {
  it("allows admins to feature published events", async () => {
    const deps = buildDeps();

    const result = await featureEvent(deps, {
      actorHumanId: admin.id,
      eventId: publishedEvent.id,
    });

    expect(result).toMatchObject({
      eventId: publishedEvent.id,
      curatedUntil: publishedEvent.endsAt,
      featuredAt: deps.clock.now(),
    });
    expect(deps.txAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: publishedEvent.id,
        action: "event_featured",
      }),
    );
    // The default probe: no opt-out, so the port applies the second-factor rule.
    expect(deps.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: admin.id,
      requiredRoles: ["ADMIN"],
    });
  });

  it("rejects non-admins", async () => {
    const deps = buildDeps({ staff: { allowed: false } });

    await expect(
      featureEvent(deps, {
        actorHumanId: admin.id,
        eventId: publishedEvent.id,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(deps.upsertPlacement).not.toHaveBeenCalled();
    expect(deps.txAuditLog).not.toHaveBeenCalled();
  });

  it("refuses an ADMIN with no second factor, writing nothing: SECOND_FACTOR_REQUIRED", async () => {
    const deps = buildDeps({
      staff: { allowed: false, secondFactorRequired: true },
    });

    await expect(
      featureEvent(deps, {
        actorHumanId: admin.id,
        eventId: publishedEvent.id,
      }),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(deps.upsertPlacement).not.toHaveBeenCalled();
    expect(deps.txAuditLog).not.toHaveBeenCalled();
  });

  it("requires the event to be published", async () => {
    const deps = buildDeps({ eventStatus: "DRAFT" });

    await expect(
      featureEvent(deps, {
        actorHumanId: admin.id,
        eventId: publishedEvent.id,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHED" });
  });
});
