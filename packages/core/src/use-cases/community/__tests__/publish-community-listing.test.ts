import { describe, expect, it, vi } from "vitest";

import {
  publishCommunityListing,
  type PublishCommunityListingDeps,
} from "../publish-community-listing";
import type { EventRecord } from "@th/ports/repos/events";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  NOW,
  USER_ID,
  makeClock,
  makeCommunityEvent,
  makeOrgEvent,
  makeStaffAuthz,
} from "./helpers";

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const VALID_INPUT = { actorHumanId: MODERATOR_ID, eventId: EVENT_ID };

function makeDraftListing(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeCommunityEvent({
    status: "DRAFT",
    publishedAt: null,
    ...overrides,
  });
}

function buildDeps(
  overrides: {
    event?: EventRecord | null;
    rolesByHuman?: Record<string, string[]>;
  } = {},
) {
  const event =
    "event" in overrides ? overrides.event : makeDraftListing();

  const getById = vi.fn(async () => event);
  // The CAS write, in its winning shape. The two CAS-LOSS cases build their
  // own deps below (they need getById to answer differently across the two
  // reads), so this fake stays the simple one.
  const publish = vi.fn(
    async ({ eventId, publishedAt }: { eventId: string; publishedAt: Date }) =>
      ({
        ...(event as EventRecord),
        id: eventId,
        status: "PUBLISHED",
        publishedAt,
      }) as EventRecord,
  );
  const audit = { log: vi.fn() };
  // settleHeldDatesForEvent's FIRST read once the event carries a calendar.
  // Returning null makes the helper no-op AFTER proving it ran.
  const calendars = { findById: vi.fn(async () => null) };

  const txRepos = {
    events: { getById, publishCommunityListingIfDraft: publish },
    calendars,
    audit,
  };

  const deps: PublishCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as PublishCommunityListingDeps["repos"],
    authz: makeStaffAuthz(
      overrides.rolesByHuman ?? {
        [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
        [ADMIN_ID]: ["ADMIN"],
      },
    ),
    clock: makeClock(),
    // No `search` dep → reindexAfterMutation short-circuits.
  };

  return { deps, getById, publish, audit, calendars };
}

describe("publishCommunityListing", () => {
  it("flips a DRAFT COMMUNITY listing to PUBLISHED and stamps publishedAt", async () => {
    const { deps, publish } = buildDeps();

    const result = await publishCommunityListing(deps, VALID_INPUT);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      publishedAt: NOW,
    });
    expect(result.changed).toBe(true);
    expect(result.publishedAt).toEqual(NOW);
    expect(result.event.status).toBe("PUBLISHED");
    expect(result.event.stewardship).toBe("COMMUNITY");
  });

  it("audits the publisher — attribution never lands on the ownerless row", async () => {
    const { deps, audit } = buildDeps();

    await publishCommunityListing(deps, VALID_INPUT);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "community_listing.published",
        data: expect.objectContaining({
          actorHumanId: MODERATOR_ID,
          publishedAt: NOW.toISOString(),
        }),
        at: NOW,
      }),
    );
  });

  it("settles held dates (FR-018) — the rule create used to own runs here now", async () => {
    const { deps, calendars } = buildDeps({
      event: makeDraftListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
    });

    await publishCommunityListing(deps, VALID_INPUT);

    expect(calendars.findById).toHaveBeenCalledTimes(1);
    expect(calendars.findById).toHaveBeenCalledWith(CALENDAR_ID);
  });

  it("settles AFTER the status write, against the WRITTEN row", async () => {
    // publishEvent's lock-ordering rule: the status UPDATE takes the row lock
    // first, then the hold lines. Settling on the pre-write snapshot raced
    // confirmVenueEvent into a published, venue-confirmed event with every
    // competitor hold still live.
    const { deps, publish, calendars } = buildDeps({
      event: makeDraftListing({ calendarId: CALENDAR_ID } as Partial<EventRecord>),
    });

    await publishCommunityListing(deps, VALID_INPUT);

    expect(publish.mock.invocationCallOrder[0]!).toBeLessThan(
      calendars.findById.mock.invocationCallOrder[0]!,
    );
  });

  it("allows a platform ADMIN as well as a community moderator", async () => {
    const { deps, publish } = buildDeps();

    await expect(
      publishCommunityListing(deps, { ...VALID_INPUT, actorHumanId: ADMIN_ID }),
    ).resolves.toMatchObject({ changed: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects non-moderators with STAFF_ONLY and never writes", async () => {
    const { deps, publish, audit } = buildDeps();

    await expect(
      publishCommunityListing(deps, { ...VALID_INPUT, actorHumanId: USER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(publish).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("rejects a missing event with EVENT_NOT_FOUND", async () => {
    const { deps, publish } = buildDeps({ event: null });

    await expect(publishCommunityListing(deps, VALID_INPUT)).rejects.toMatchObject(
      { code: "EVENT_NOT_FOUND" },
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses an OWNED event — publishEvent owns that path", async () => {
    const { deps, publish } = buildDeps({
      event: makeOrgEvent({ status: "DRAFT", publishedAt: null }),
    });

    await expect(publishCommunityListing(deps, VALID_INPUT)).rejects.toMatchObject(
      { code: "EVENT_NOT_COMMUNITY" },
    );
    expect(publish).not.toHaveBeenCalled();
  });

  describe("idempotency", () => {
    it("an already-PUBLISHED listing succeeds with changed: false", async () => {
      const alreadyLive = makeCommunityEvent({
        status: "PUBLISHED",
        publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      const { deps, publish } = buildDeps({ event: alreadyLive });

      const result = await publishCommunityListing(deps, VALID_INPUT);

      expect(result.changed).toBe(false);
      expect(result.event.status).toBe("PUBLISHED");
      // The ORIGINAL go-live stamp, not a fresh one.
      expect(result.publishedAt).toEqual(new Date("2026-06-01T00:00:00.000Z"));
      expect(publish).not.toHaveBeenCalled();
    });

    it("the replay writes no audit row and re-settles nothing", async () => {
      const { deps, audit, calendars } = buildDeps({
        event: makeCommunityEvent({
          status: "PUBLISHED",
          publishedAt: NOW,
          calendarId: CALENDAR_ID,
        } as Partial<EventRecord>),
      });

      await publishCommunityListing(deps, VALID_INPUT);

      // Re-settling would re-notify everyone in the line for a publish that
      // already happened.
      expect(calendars.findById).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    // THE RACE THE CAS EXISTS FOR. Under READ COMMITTED both transactions read
    // DRAFT; the CAS guard in the WHERE is what makes the loser a no-op rather
    // than a second publishedAt stamp, a second audit row and a second
    // FR-018 settlement that re-notifies the whole line.
    it("a CAS loss (a concurrent publish won the row) degrades to the replay, not a double write", async () => {
      const draft = makeDraftListing({
        calendarId: CALENDAR_ID,
      } as Partial<EventRecord>);
      const winnerResult = makeCommunityEvent({
        status: "PUBLISHED",
        publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      });
      // First read (our guard) sees DRAFT; the re-read after the CAS misses
      // sees what the WINNER committed.
      const getById = vi
        .fn()
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(winnerResult);
      const publish = vi.fn(async () => null);
      const audit = { log: vi.fn() };
      const calendars = { findById: vi.fn(async () => null) };
      const deps: PublishCommunityListingDeps = {
        repos: {
          tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
              events: { getById, publishCommunityListingIfDraft: publish },
              calendars,
              audit,
            }),
          ),
        } as unknown as PublishCommunityListingDeps["repos"],
        authz: makeStaffAuthz({ [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] }),
        clock: makeClock(),
      };

      const result = await publishCommunityListing(deps, VALID_INPUT);

      expect(publish).toHaveBeenCalledTimes(1);
      expect(result.changed).toBe(false);
      expect(result.publishedAt).toEqual(new Date("2026-06-01T00:00:00.000Z"));
      expect(audit.log).not.toHaveBeenCalled();
      expect(calendars.findById).not.toHaveBeenCalled();
    });

    it("a CAS loss to a CANCEL is still a refusal, not a success echo", async () => {
      const getById = vi
        .fn()
        .mockResolvedValueOnce(makeDraftListing())
        .mockResolvedValueOnce(makeCommunityEvent({ status: "CANCELLED" }));
      const publish = vi.fn(async () => null);
      const audit = { log: vi.fn() };
      const deps: PublishCommunityListingDeps = {
        repos: {
          tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
            fn({
              events: { getById, publishCommunityListingIfDraft: publish },
              calendars: { findById: vi.fn() },
              audit,
            }),
          ),
        } as unknown as PublishCommunityListingDeps["repos"],
        authz: makeStaffAuthz({ [MODERATOR_ID]: ["COMMUNITY_MODERATOR"] }),
        clock: makeClock(),
      };

      await expect(
        publishCommunityListing(deps, VALID_INPUT),
      ).rejects.toMatchObject({
        code: "EVENT_NOT_PUBLISHABLE",
        meta: { status: "CANCELLED", raced: true },
      });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "refuses to resurrect a %s listing",
    async (status) => {
      const { deps, publish } = buildDeps({
        event: makeCommunityEvent({ status, publishedAt: NOW }),
      });

      await expect(
        publishCommunityListing(deps, VALID_INPUT),
      ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHABLE" });
      expect(publish).not.toHaveBeenCalled();
    },
  );
});

describe("publishCommunityListing — follower outbox", () => {
  const PLACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const STAMP = { venueConfirmedAt: new Date("2026-06-30T00:00:00Z"), venueConfirmedPlaceId: PLACE_ID };
  function withFollowFakes(deps: PublishCommunityListingDeps) {
    const enqueue = vi.fn();
    const getByOwner = vi.fn(async (type: string, id: string) => ({ id: `${type}:${id}`, ownerType: type, ownerId: id, visibility: "PUBLIC", allowFollows: true }));
    const place = { id: PLACE_ID, locationMode: "EXACT", orgIdsWithAccess: [], humanIdsWithAccess: [], acceptsCommunityListings: true };
    const original = deps.repos.tx;
    deps.repos.tx = ((fn: (tx: any) => unknown) => original(async (tx: any) => fn({
      ...tx,
      entityPages: { getByOwner },
      places: { getById: vi.fn(async () => place) },
      entityEventNotices: { enqueue },
    }))) as typeof deps.repos.tx;
    return { enqueue, getByOwner };
  }

  it("enqueues the venue's followers when the venue stamped the listing", async () => {
    const { deps } = buildDeps({ event: makeDraftListing({ placeId: PLACE_ID, ...STAMP } as Partial<EventRecord>) });
    const { enqueue } = withFollowFakes(deps);
    await publishCommunityListing(deps, VALID_INPUT);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ entityPageId: `PLACE:${PLACE_ID}`, eventId: EVENT_ID, at: NOW });
  });

  it("does NOT enqueue on the community arm alone (anyone could write the listing)", async () => {
    const { deps } = buildDeps({ event: makeDraftListing({ placeId: PLACE_ID } as Partial<EventRecord>) });
    const { enqueue } = withFollowFakes(deps);
    await publishCommunityListing(deps, VALID_INPUT);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does NOT enqueue a gated listing", async () => {
    const { deps } = buildDeps({ event: makeDraftListing({ placeId: PLACE_ID, ...STAMP, gateType: "PASSWORD" } as Partial<EventRecord>) });
    const { enqueue } = withFollowFakes(deps);
    await publishCommunityListing(deps, VALID_INPUT);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does NOT enqueue on the idempotent replay of an already-published listing", async () => {
    const { deps } = buildDeps({ event: makeCommunityEvent({ placeId: PLACE_ID, ...STAMP } as Partial<EventRecord>) });
    const { enqueue } = withFollowFakes(deps);
    const result = await publishCommunityListing(deps, VALID_INPUT);
    expect(result.changed).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
