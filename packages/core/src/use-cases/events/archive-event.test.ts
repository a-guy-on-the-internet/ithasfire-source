import { describe, expect, it, beforeEach, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { archiveEvent } from "./archive-event";

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
    archive: ReturnType<typeof vi.fn>;
  };
  authz: {
    getHumanDelegation: ReturnType<typeof vi.fn>;
    getOrgMembership: ReturnType<typeof vi.fn>;
  };
  audit: {
    log: ReturnType<typeof vi.fn>;
  };
  eventChangeNotices: {
    create: ReturnType<typeof vi.fn>;
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
    archive: vi.fn(),
  };
  const repoAuthz = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(),
  };
  const audit = {
    log: vi.fn(),
  };
  const eventChangeNotices = {
    create: vi.fn(async () => ({ id: "notice-1", createdAt: new Date() })),
  };
  const hasStaffRole = vi.fn(async () => ({ allowed: false }));

  const tx = {
    // The archive locks the listing row before it calls nights off. A
    // default spread UNDER `events`, so a fixture's own lockRows wins.
    events: {
      lockRows: vi.fn(async () => undefined),
      ...events,
    } as unknown as TxRepos["events"],
    audit: audit as unknown as TxRepos["audit"],
    eventChangeNotices:
      eventChangeNotices as unknown as TxRepos["eventChangeNotices"],
    // A COMMUNITY archive calls off remaining nights; these fixtures have none.
    eventDates: {
      listByEvent: vi.fn(async () => []),
      markStatusIf: vi.fn(async () => ({ updated: true })),
    },
    eventDateRsvps: { listHumanIdsForDate: vi.fn(async () => []) },
    rsvpNotices: { createDateCancelled: vi.fn(async () => 0) },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    events: events as unknown as Repos["events"],
    audit: audit as unknown as Repos["audit"],
    authz: repoAuthz as unknown as Repos["authz"],
    eventChangeNotices:
      eventChangeNotices as unknown as Repos["eventChangeNotices"],
  } as unknown as Repos;

  return {
    repos,
    authz: { hasStaffRole },
    mocks: { events, authz: repoAuthz, audit, eventChangeNotices, hasStaffRole },
  };
};

describe("archiveEvent", () => {
  const clock: ClockPort = { now: () => new Date("2024-02-01T00:00:00Z") };

  let repos: Repos;
  let authz: { hasStaffRole: ReturnType<typeof vi.fn> };
  let mocks: RepoMocks;

  beforeEach(() => {
    ({ repos, authz, mocks } = createMocks());
  });

  const grantOrgAdmin = () =>
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

  it.each(["PUBLISHED", "COMPLETED", "CANCELLED"] as const)(
    "archives an org event from %s (owner path)",
    async (status) => {
      const event = buildEvent({ status });
      mocks.events.getById.mockResolvedValue(event);
      grantOrgAdmin();
      mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

      const result = await archiveEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      );

      expect(result).toEqual({ eventId: EVENT_ID, status: "ARCHIVED" });
      expect(mocks.events.archive).toHaveBeenCalledWith({ eventId: EVENT_ID });
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: "event",
          entityId: EVENT_ID,
          action: "archived",
          data: { actorHumanId: HUMAN_ID },
          at: clock.now(),
        }),
      );
    },
  );

  it("writes an ARCHIVED change-notice when archiving a PUBLISHED OWNED event", async () => {
    const event = buildEvent({ status: "PUBLISHED", title: "Riverside Jazz" });
    mocks.events.getById.mockResolvedValue(event);
    grantOrgAdmin();
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
    );

    expect(mocks.eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(mocks.eventChangeNotices.create).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "ARCHIVED",
      payload: { eventTitle: "Riverside Jazz" },
    });
  });

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "writes NO change-notice when archiving a %s event",
    async (status) => {
      const event = buildEvent({ status });
      mocks.events.getById.mockResolvedValue(event);
      grantOrgAdmin();
      mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

      await archiveEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      );

      expect(mocks.eventChangeNotices.create).not.toHaveBeenCalled();
    },
  );

  // Owner ruling 2026-10-16: "they should be notified that everything is
  // cancelled if archived". A live COMMUNITY listing archived without a cancel
  // first writes the CANCELLED notice in cancel-event's exact shape, not
  // ARCHIVED (`event.unlisted`).
  it("writes a CANCELLED change-notice (not ARCHIVED) when archiving a PUBLISHED COMMUNITY listing", async () => {
    const event = buildEvent({
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
      status: "PUBLISHED",
      title: "Weekly Open Mic",
      startsAt: new Date("2024-03-01T19:00:00.000Z"),
    });
    mocks.events.getById.mockResolvedValue(event);
    mocks.hasStaffRole.mockResolvedValue({ allowed: true });
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(mocks.eventChangeNotices.create).toHaveBeenCalledTimes(1);
    expect(mocks.eventChangeNotices.create).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      changeType: "CANCELLED",
      payload: {
        eventTitle: "Weekly Open Mic",
        startsAt: "2024-03-01T19:00:00.000Z",
        buyers: [],
        pendingRefundBuyerHumanIds: [],
      },
    });
    // The audit row records what it always did; nothing new rides along.
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "archived",
        data: {
          actorHumanId: ADMIN_HUMAN_ID,
          via: "platform_admin",
          datesCalledOff: 0,
          notifiedCount: 0,
        },
      }),
    );
  });

  it("writes a CANCELLED change-notice with a null startsAt for an undated COMMUNITY listing", async () => {
    const event = buildEvent({
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
      status: "PUBLISHED",
      title: "Weekly Open Mic",
      startsAt: null,
    });
    mocks.events.getById.mockResolvedValue(event);
    mocks.hasStaffRole.mockResolvedValue({ allowed: true });
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(mocks.eventChangeNotices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        changeType: "CANCELLED",
        payload: expect.objectContaining({ startsAt: null }),
      }),
    );
  });

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "writes NO change-notice when archiving a %s COMMUNITY listing",
    async (status) => {
      const event = buildEvent({
        orgId: null,
        humanId: null,
        stewardship: "COMMUNITY",
        status,
      });
      mocks.events.getById.mockResolvedValue(event);
      mocks.hasStaffRole.mockResolvedValue({ allowed: true });
      mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

      await archiveEvent(
        { repos, authz, clock },
        { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
      );

      expect(mocks.eventChangeNotices.create).not.toHaveBeenCalled();
    },
  );

  it("archives a personal event for its human owner", async () => {
    const event = buildEvent({ orgId: null, humanId: HUMAN_ID });
    mocks.events.getById.mockResolvedValue(event);
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    const result = await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
  });

  it("lets a platform ADMIN archive an OWNED event they don't belong to", async () => {
    const event = buildEvent();
    mocks.events.getById.mockResolvedValue(event);
    mocks.hasStaffRole.mockResolvedValue({ allowed: true });
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    const result = await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "archived",
        data: { actorHumanId: ADMIN_HUMAN_ID, via: "platform_admin" },
      }),
    );
  });

  it("lets a platform ADMIN archive an ownerless COMMUNITY event", async () => {
    const event = buildEvent({
      orgId: null,
      humanId: null,
      stewardship: "COMMUNITY",
    });
    mocks.events.getById.mockResolvedValue(event);
    mocks.hasStaffRole
      .mockResolvedValueOnce({ allowed: false })
      .mockResolvedValueOnce({ allowed: true });
    mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });

    const result = await archiveEvent(
      { repos, authz, clock },
      { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
    );

    expect(result.status).toBe("ARCHIVED");
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
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
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(mocks.events.archive).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("rejects a non-owner, non-admin actor on an org event", async () => {
    const event = buildEvent();
    mocks.events.getById.mockResolvedValue(event);
    mocks.authz.getOrgMembership.mockResolvedValue(undefined);

    await expect(
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(mocks.events.archive).not.toHaveBeenCalled();
  });

  it("rejects a non-owner actor on a personal event", async () => {
    const event = buildEvent({ orgId: null, humanId: HUMAN_ID });
    mocks.events.getById.mockResolvedValue(event);

    await expect(
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // A delegate gets what an org member with the same role gets: archive is an
  // ORG_ADMIN_ROLES action, so an OWNER/ADMIN delegate may, an EDITOR may not.
  it.each(["OWNER", "ADMIN"])(
    "lets a %s delegate archive the principal's personal event, audited as the delegate",
    async (role) => {
      mocks.events.getById.mockResolvedValue(
        buildEvent({ orgId: null, humanId: HUMAN_ID }),
      );
      mocks.events.archive.mockResolvedValue(
        buildEvent({ orgId: null, humanId: HUMAN_ID, status: "ARCHIVED" }),
      );
      mocks.authz.getHumanDelegation.mockResolvedValue({
        orgId: HUMAN_ID,
        humanId: OTHER_HUMAN_ID,
        role,
      });

      await archiveEvent(
        { repos, authz, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
      );

      expect(mocks.events.archive).toHaveBeenCalledWith({ eventId: EVENT_ID });
      expect(mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "archived",
          data: { actorHumanId: OTHER_HUMAN_ID },
        }),
      );
    },
  );

  it.each([["EDITOR"], ["VIEWER"], ["FINANCE"], ["SCANNER"]])(
    "refuses a %s delegate (archive is an ADMIN-bar action)",
    async (role) => {
      mocks.events.getById.mockResolvedValue(
        buildEvent({ orgId: null, humanId: HUMAN_ID }),
      );
      mocks.authz.getHumanDelegation.mockResolvedValue({
        orgId: HUMAN_ID,
        humanId: OTHER_HUMAN_ID,
        role,
      });

      await expect(
        archiveEvent(
          { repos, authz, clock },
          { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID },
        ),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
      expect(mocks.events.archive).not.toHaveBeenCalled();
    },
  );

  it("throws EVENT_NOT_FOUND when the event is missing", async () => {
    mocks.events.getById.mockResolvedValue(null);

    await expect(
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws EVENT_ALREADY_ARCHIVED when already ARCHIVED", async () => {
    const event = buildEvent({ status: "ARCHIVED" });
    mocks.events.getById.mockResolvedValue(event);
    grantOrgAdmin();

    await expect(
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_ALREADY_ARCHIVED" });
    expect(mocks.events.archive).not.toHaveBeenCalled();
  });

  it("throws EVENT_NOT_ARCHIVABLE for a DRAFT event", async () => {
    const event = buildEvent({ status: "DRAFT" });
    mocks.events.getById.mockResolvedValue(event);
    grantOrgAdmin();

    await expect(
      archiveEvent(
        { repos, authz, clock },
        { actorHumanId: HUMAN_ID, eventId: EVENT_ID },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ARCHIVABLE" });
    expect(mocks.events.archive).not.toHaveBeenCalled();
  });

  describe("under the listing row lock", () => {
    const communityListing = (status: EventRecord["status"]) =>
      buildEvent({ orgId: null, humanId: null, stewardship: "COMMUNITY", status });

    /** Wrap the tx so its event lock and locked re-read are observable. */
    const withLockedRead = (statusUnderLock: EventRecord["status"]) => {
      const lockRows = vi.fn(async () => undefined);
      const lockedGetById = vi.fn(async () => communityListing(statusUnderLock));
      const listByEvent = vi.fn(async () => []);
      const lockedRepos = {
        ...repos,
        tx: <T>(fn: (tx: TxRepos) => Promise<T>) =>
          repos.tx((inner) =>
            fn({
              ...inner,
              events: { ...inner.events, lockRows, getById: lockedGetById },
              eventDates: { ...inner.eventDates, listByEvent },
            } as unknown as TxRepos),
          ),
      } as unknown as Repos;
      return { lockedRepos, lockRows, lockedGetById, listByEvent };
    };

    it("locks the listing row FOR UPDATE before it re-reads it and calls nights off", async () => {
      const event = communityListing("PUBLISHED");
      mocks.events.getById.mockResolvedValue(event);
      mocks.hasStaffRole.mockResolvedValue({ allowed: true });
      mocks.events.archive.mockResolvedValue({ ...event, status: "ARCHIVED" });
      const { lockedRepos, lockRows, lockedGetById, listByEvent } =
        withLockedRead("PUBLISHED");

      await archiveEvent(
        { repos: lockedRepos, authz, clock },
        { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
      );

      expect(lockRows).toHaveBeenNthCalledWith(1, {
        ids: [EVENT_ID],
        mode: "update",
      });
      const locked = lockRows.mock.invocationCallOrder[0]!;
      expect(locked).toBeLessThan(lockedGetById.mock.invocationCallOrder[0]!);
      expect(locked).toBeLessThan(mocks.events.archive.mock.invocationCallOrder[0]!);
      expect(locked).toBeLessThan(listByEvent.mock.invocationCallOrder[0]!);
    });

    it("refuses when the row under the lock is already ARCHIVED: nothing archived, no night called off, nobody told", async () => {
      // Loaded PUBLISHED; a concurrent archive committed while this one
      // waited on the row.
      const event = communityListing("PUBLISHED");
      mocks.events.getById.mockResolvedValue(event);
      mocks.hasStaffRole.mockResolvedValue({ allowed: true });
      const { lockedRepos, listByEvent } = withLockedRead("ARCHIVED");

      await expect(
        archiveEvent(
          { repos: lockedRepos, authz, clock },
          { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
        ),
      ).rejects.toMatchObject({ code: "EVENT_ALREADY_ARCHIVED" });
      expect(mocks.events.archive).not.toHaveBeenCalled();
      expect(listByEvent).not.toHaveBeenCalled();
      expect(mocks.eventChangeNotices.create).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
    });

    it.each(["CANCELLED", "COMPLETED"] as const)(
      "refuses when the listing loaded PUBLISHED is %s under the lock: no second notice, nothing archived",
      async (statusUnderLock) => {
        // A cancel (or complete) committed between the load and the lock. It
        // already told everyone; archiving on would send a second CANCELLED
        // notice decided from the stale PUBLISHED load.
        const event = communityListing("PUBLISHED");
        mocks.events.getById.mockResolvedValue(event);
        mocks.hasStaffRole.mockResolvedValue({ allowed: true });
        const { lockedRepos, listByEvent } = withLockedRead(statusUnderLock);

        await expect(
          archiveEvent(
            { repos: lockedRepos, authz, clock },
            { actorHumanId: ADMIN_HUMAN_ID, eventId: EVENT_ID },
          ),
        ).rejects.toMatchObject({ code: "EVENT_NOT_ARCHIVABLE" });
        expect(mocks.eventChangeNotices.create).not.toHaveBeenCalled();
        expect(mocks.events.archive).not.toHaveBeenCalled();
        expect(listByEvent).not.toHaveBeenCalled();
        expect(mocks.audit.log).not.toHaveBeenCalled();
      },
    );
  });
});
