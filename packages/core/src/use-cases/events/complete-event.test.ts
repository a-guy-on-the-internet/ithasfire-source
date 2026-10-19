import { describe, expect, it, beforeEach, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { completeEvent } from "./complete-event";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const ADMIN_HUMAN_ID = "00000000-0000-4000-8000-000000000005";

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Event 1",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    stewardship: "OWNED",
    slug: "ev-1",
    shortId: "EV1",
    ...overrides,
  }) as unknown as EventRecord;

type RepoMocks = {
  events: {
    getById: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  };
  authz: {
    getHumanDelegation: ReturnType<typeof vi.fn>;
    getOrgMembership: ReturnType<typeof vi.fn>;
  };
  audit: {
    log: ReturnType<typeof vi.fn>;
  };
  hasStaffRole: ReturnType<typeof vi.fn>;
};

const createMocks = (): {
  repos: Repos;
  authz: { hasStaffRole: ReturnType<typeof vi.fn> };
  mocks: RepoMocks;
} => {
  const events = {
    getById: vi.fn(),
    // The completion locks the event row (holds-without-a-request).
    lockRows: vi.fn(async () => undefined),
    complete: vi.fn(),
  };
  const repoAuthz = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(),
  };
  const audit = {
    log: vi.fn(),
  };
  const hasStaffRole = vi.fn(async () => ({ allowed: false }));

  const tx = {
    events: events as unknown as TxRepos["events"],
    audit: audit as unknown as TxRepos["audit"],
    // A COMMUNITY completion calls off its remaining nights (none here; the
    // call-off is covered in __tests__/community-listing-calls-off-remaining-dates).
    eventDates: { listByEvent: vi.fn(async () => []) },
    // Booking-timeline reverse lookup: none of these events came from a
    // booking. The linked case is covered in __tests__/booking-event-lifecycle.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    events: events as unknown as Repos["events"],
    audit: audit as unknown as Repos["audit"],
    authz: repoAuthz as unknown as Repos["authz"],
  } as unknown as Repos;

  return {
    repos,
    authz: { hasStaffRole },
    mocks: { events, authz: repoAuthz, audit, hasStaffRole },
  };
};

describe("completeEvent", () => {
  const clock: ClockPort = { now: () => new Date("2024-02-01T00:00:00Z") };

  let repos: Repos;
  let authz: { hasStaffRole: ReturnType<typeof vi.fn> };
  let mocks: RepoMocks;

  beforeEach(() => {
    ({ repos, authz, mocks } = createMocks());
  });

  it("completes a PUBLISHED org event for an org admin (owner path)", async () => {
    const event = buildEvent();
    mocks.events.getById.mockResolvedValue(event);
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);
    mocks.events.complete.mockResolvedValue({ ...event, status: "COMPLETED" });

    const result = await completeEvent(
      { repos, authz, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result).toEqual({ eventId: EVENT_ID, status: "COMPLETED" });
    expect(mocks.events.complete).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "completed",
        data: { actorHumanId: HUMAN_ID },
        at: clock.now(),
      }),
    );
  });

  it("completes a PUBLISHED personal event for its human owner", async () => {
    const event = buildEvent({ orgId: null, humanId: HUMAN_ID });
    mocks.events.getById.mockResolvedValue(event);
    mocks.events.complete.mockResolvedValue({ ...event, status: "COMPLETED" });

    const result = await completeEvent(
      { repos, authz, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("COMPLETED");
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
  });

  it("lets a platform ADMIN complete an OWNED event they don't belong to", async () => {
    const event = buildEvent();
    mocks.events.getById.mockResolvedValue(event);
    mocks.hasStaffRole.mockResolvedValue({ allowed: true });
    mocks.events.complete.mockResolvedValue({ ...event, status: "COMPLETED" });

    const result = await completeEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("COMPLETED");
    // Owner checks skipped entirely on the admin override path.
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    // Admin-path mutations MUST be attributed with `via: "platform_admin"`.
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "completed",
        data: { actorHumanId: ADMIN_HUMAN_ID, via: "platform_admin" },
      }),
    );
  });

  it("lets a platform ADMIN complete an ownerless COMMUNITY event", async () => {
    const event = buildEvent({
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
    });
    mocks.events.getById.mockResolvedValue(event);
    // First hasStaffRole (override) returns false; requirePlatformStaff then allows.
    mocks.hasStaffRole
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    mocks.events.complete.mockResolvedValue({ ...event, status: "COMPLETED" });

    const result = await completeEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("COMPLETED");
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        // A listing with no nights ahead: nothing called off, nobody told.
        data: {
          actorHumanId: ADMIN_HUMAN_ID,
          via: "platform_admin",
          datesCalledOff: 0,
          notifiedCount: 0,
        },
      }),
    );
  });

  it("denies a non-ADMIN staff (e.g. COMMUNITY_MODERATOR) on an ownerless COMMUNITY event", async () => {
    const event = buildEvent({
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
    });
    mocks.events.getById.mockResolvedValue(event);
    // Neither the override check nor requirePlatformStaff(["ADMIN"]) allows a
    // moderator / plain user: hasStaffRole always denies.
    mocks.hasStaffRole.mockResolvedValue({ allowed: false });

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(mocks.events.complete).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("rejects a non-owner, non-admin actor on an org event", async () => {
    const event = buildEvent();
    mocks.events.getById.mockResolvedValue(event);
    mocks.authz.getOrgMembership.mockResolvedValue(undefined);

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(mocks.events.complete).not.toHaveBeenCalled();
  });

  it("rejects a non-owner actor on a personal event", async () => {
    const event = buildEvent({ orgId: null, humanId: HUMAN_ID });
    mocks.events.getById.mockResolvedValue(event);

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws EVENT_NOT_FOUND when the event is missing", async () => {
    mocks.events.getById.mockResolvedValue(null);

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws EVENT_ALREADY_COMPLETED when already COMPLETED", async () => {
    const event = buildEvent({ status: "COMPLETED" });
    mocks.events.getById.mockResolvedValue(event);
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_COMPLETED" });
    expect(mocks.events.complete).not.toHaveBeenCalled();
  });

  it("throws EVENT_NOT_COMPLETABLE for any other non-PUBLISHED status", async () => {
    const event = buildEvent({ status: "DRAFT" });
    mocks.events.getById.mockResolvedValue(event);
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

    await expect(
      completeEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_COMPLETABLE" });
    expect(mocks.events.complete).not.toHaveBeenCalled();
  });
});
