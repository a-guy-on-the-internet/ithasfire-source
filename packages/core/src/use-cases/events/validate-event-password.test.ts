import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord, Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { hashEventPassword } from "../../lib/security/event-password";
import { validateEventPassword } from "./validate-event-password";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const HUMAN_ID = "30000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "30000000-0000-4000-8000-000000000004";

// No viewer here holds a staff role.
const noStaffRead = { hasStaffRole: async () => ({ allowed: false }) };

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Org Event",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "PASSWORD",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-01-01T00:00:00Z"),
  endsAt: new Date("2024-01-01T02:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "event",
  shortId: "EVT",
  regionCode: "US-CA",
  publishedAt: new Date("2023-12-20T00:00:00Z"),
  agreementPrimaryId: "40000000-0000-4000-8000-000000000005",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  ...overrides,
});

const createRepos = () => {
  const events = {
    getById: vi.fn(),
  };

  const authz = {
    getOrgMembership: vi.fn(),
  };

  const eventUnlocks = {
    upsert: vi.fn(),
    isUnlocked: vi.fn(),
    get: vi.fn(),
    revoke: vi.fn(),
    listByEventId: vi.fn(),
    listByHumanId: vi.fn(),
  };

  const repos = { events, authz, eventUnlocks } as unknown as Pick<
    Repos,
    "events" | "authz" | "eventUnlocks"
  >;
  return { repos, events, authz, eventUnlocks };
};

const createLogger = () => {
  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return { logger, info };
};

describe("validateEventPassword", () => {
  let repos: Pick<Repos, "events" | "authz" | "eventUnlocks">;
  let events: { getById: ReturnType<typeof vi.fn> };
  let authz: { getOrgMembership: ReturnType<typeof vi.fn> };
  let eventUnlocks: { upsert: ReturnType<typeof vi.fn> };
  let loggerInfo: ReturnType<typeof vi.fn>;
  let logger: LoggerPort;

  beforeEach(() => {
    ({ repos, events, authz, eventUnlocks } = createRepos());
    ({ logger, info: loggerInfo } = createLogger());
  });

  it("unlocks gate when viewer bypasses", async () => {
    const event = buildEvent();
    events.getById.mockResolvedValue(event);
    authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

    const result = await validateEventPassword(
      { repos, logger, authz: noStaffRead },
      {
        eventId: EVENT_ID,
        password: "does-not-matter",
        viewerHumanId: HUMAN_ID,
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      unlocked: true,
      bypassed: true,
      persisted: false,
    });
    expect(authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        eventId: EVENT_ID,
        action: "password_attempt",
        result: "bypassed",
      }),
    );
    // Bypass doesn't persist an unlock
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("validates password hash when viewer cannot bypass", async () => {
    const passwordHash = hashEventPassword("super-secret");
    const event = buildEvent({ passwordHash });
    events.getById.mockResolvedValue(event);

    const result = await validateEventPassword(
      { repos, logger, authz: noStaffRead },
      { eventId: EVENT_ID, password: "super-secret", viewerHumanId: null },
    );

    // No humanId means unlock cannot be persisted
    expect(result).toEqual({
      eventId: EVENT_ID,
      unlocked: true,
      bypassed: false,
      persisted: false,
    });
    expect(loggerInfo).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        action: "password_attempt",
        result: "success",
      }),
    );
    expect(authz.getOrgMembership).not.toHaveBeenCalled();
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("persists unlock when viewer has humanId", async () => {
    const passwordHash = hashEventPassword("super-secret");
    const event = buildEvent({ passwordHash });
    events.getById.mockResolvedValue(event);

    const result = await validateEventPassword(
      { repos, logger, authz: noStaffRead },
      {
        eventId: EVENT_ID,
        password: "super-secret",
        viewerHumanId: OTHER_HUMAN_ID,
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      unlocked: true,
      bypassed: false,
      persisted: true,
    });
    expect(eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: OTHER_HUMAN_ID,
      source: "PASSWORD",
    });
  });

  it("rejects invalid passwords and logs failure", async () => {
    const passwordHash = hashEventPassword("right-pass");
    const event = buildEvent({ passwordHash });
    events.getById.mockResolvedValue(event);

    await expect(
      validateEventPassword(
        { repos, logger, authz: noStaffRead },
        {
          eventId: EVENT_ID,
          password: "wrong-pass",
          viewerHumanId: OTHER_HUMAN_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_PASSWORD_INVALID" });

    expect(loggerInfo).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ result: "failure" }),
    );
  });

  it("throws when event is not password gated", async () => {
    const event = buildEvent({ gateType: "NONE" });
    events.getById.mockResolvedValue(event);

    await expect(
      validateEventPassword(
        { repos, logger, authz: noStaffRead },
        { eventId: EVENT_ID, password: "anything", viewerHumanId: null },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PASSWORD_GATED" });
  });
});
