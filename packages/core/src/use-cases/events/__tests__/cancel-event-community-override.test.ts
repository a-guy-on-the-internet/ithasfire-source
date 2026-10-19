import { describe, expect, it, vi } from "vitest";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

/**
 * FR-014 (community-managed-event-listings spec): platform ADMIN may cancel
 * (take down) an ownerless COMMUNITY listing; moderators and regular users
 * may not. OWNED-event behavior is unchanged.
 */

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ADMIN_ID = "20000000-0000-4000-8000-000000000003";
const MODERATOR_ID = "20000000-0000-4000-8000-000000000004";
const USER_ID = "20000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeCommunityEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: null,
    humanId: null,
    stewardship: "COMMUNITY",
    attendanceMode: "RSVP",
    status: "PUBLISHED",
    title: "Community Listing",
    slug: "event/us/austin/community-listing",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as EventRecord;
}

function buildDeps(options: {
  event: EventRecord;
  /** Staff roles by humanId for the hasStaffRole fake. */
  rolesByHuman?: Record<string, string[]>;
  membership?: { orgId: string; humanId: string; role: string } | null;
  /** Live/soft-deleted image rows returned by images.listByOwner. */
  images?: Array<{
    id: string;
    key: string;
    sizeBytes: bigint | null;
    deletedAt: Date | null;
    createdByHumanId: string;
  }>;
}) {
  const auditLog = vi.fn(async () => undefined);
  const incrementUsage = vi.fn(async () => undefined);

  const txRepos = {
    events: {
      getById: vi.fn(async () => options.event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ ...options.event, status: "CANCELLED" })),
    },
    orders: { getById: vi.fn(async () => null) },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    orderItems: { updateStatus: vi.fn(async () => undefined) },
    images: {
      listByOwner: vi.fn(async () => options.images ?? []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    // A COMMUNITY cancel calls off remaining nights; these fixtures have none.
    eventDates: {
      listByEvent: vi.fn(async () => []),
      markStatusIf: vi.fn(async () => ({ updated: true })),
    },
    eventDateRsvps: { listHumanIdsForDate: vi.fn(async () => []) },
    rsvpNotices: { createDateCancelled: vi.fn(async () => 0) },
    resourceQuotas: { incrementUsage },
    audit: { log: auditLog },
    // Booking-timeline reverse lookup: this event never came from a booking.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
    authz: {
      getOrgMembership: vi.fn(async () => options.membership ?? null),
      // Every delegate here is an OWNER-role delegate of the event's human
      // owner — the strongest delegation there is.
      getHumanDelegation: vi.fn(async () => ({
        orgId: USER_ID,
        humanId: MODERATOR_ID,
        role: "OWNER",
      })),
    },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
    orders: {
      ...(txRepos as unknown as { orders: object }).orders,
      listAll: vi.fn(async () => ({ items: [], total: 0 })),
    },
  } as unknown as Repos;

  const rolesByHuman = options.rolesByHuman ?? {
    [ADMIN_ID]: ["ADMIN"],
    [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
  };

  const deps: CancelEventDeps = {
    repos,
    authz: {
      hasStaffRole: vi.fn(
        async ({
          actorHumanId,
          requiredRoles,
        }: {
          actorHumanId: string;
          requiredRoles: string[];
        }) => ({
          allowed: (rolesByHuman[actorHumanId] ?? []).some((role) =>
            requiredRoles.includes(role),
          ),
        }),
      ),
    } as CancelEventDeps["authz"],
    payments: {
      refundPaymentIntent: vi.fn(),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
  };

  return { deps, auditLog, txRepos, incrementUsage };
}

describe("cancelEvent — FR-014 community takedown override", () => {
  it("platform ADMIN can cancel a COMMUNITY listing and the takedown is audited via platform_admin", async () => {
    const { deps, auditLog } = buildDeps({ event: makeCommunityEvent() });

    const result = await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "takedown-key-0001",
    });

    expect(result.status).toBe("CANCELLED");
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "cancelled",
        data: expect.objectContaining({
          actorHumanId: ADMIN_ID,
          via: "platform_admin",
        }),
      }),
    );
  });

  // Owner ruling 2026-10-17: the calendar feeds list a cancelled show only if
  // it was PUBLISHED when cancelled. `events.cancel` is the one writer of
  // CANCELLED and records the row's own status (adapter integration test
  // events-calendar-feed-queries); every cancel route must reach it, under the
  // row lock, with the event id and nothing a caller could get wrong.
  it.each([
    { label: "community take-down of a live listing", status: "PUBLISHED" as const, actor: ADMIN_ID, owned: false },
    { label: "community take-down of an unpublished listing", status: "DRAFT" as const, actor: ADMIN_ID, owned: false },
    { label: "owner cancel of a live show", status: "PUBLISHED" as const, actor: USER_ID, owned: true },
    { label: "owner cancel of a draft", status: "DRAFT" as const, actor: USER_ID, owned: true },
  ])("$label goes through events.cancel once, after the row lock", async ({ status, actor, owned }) => {
    const { deps, txRepos } = buildDeps({
      event: makeCommunityEvent({
        status,
        ...(owned ? { orgId: ORG_ID, stewardship: "OWNED", attendanceMode: "TICKETED" } : {}),
      }),
      ...(owned ? { membership: { orgId: ORG_ID, humanId: USER_ID, role: "ADMIN" } } : {}),
    });

    await cancelEvent(deps, { actorHumanId: actor, eventId: EVENT_ID, clientKey: `ruling-1017-${status}-${actor}` });

    const events = txRepos.events as unknown as {
      cancel: ReturnType<typeof vi.fn>;
      lockRows: ReturnType<typeof vi.fn>;
    };
    expect(events.cancel).toHaveBeenCalledTimes(1);
    expect(events.cancel).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(events.lockRows.mock.invocationCallOrder[0]!).toBeLessThan(
      events.cancel.mock.invocationCallOrder[0]!,
    );
  });

  it("takedown credits each live image's bytes back to its UPLOADER's personal storage (FR-015)", async () => {
    const UPLOADER_A = "20000000-0000-4000-8000-00000000000a";
    const UPLOADER_B = "20000000-0000-4000-8000-00000000000b";
    const { deps, incrementUsage } = buildDeps({
      event: makeCommunityEvent(),
      images: [
        {
          id: "img-a1",
          key: `events/${EVENT_ID}/images/img-a1.jpg`,
          sizeBytes: 1000n,
          deletedAt: null,
          createdByHumanId: UPLOADER_A,
        },
        {
          id: "img-a2",
          key: `events/${EVENT_ID}/images/img-a2.jpg`,
          sizeBytes: 500n,
          deletedAt: null,
          createdByHumanId: UPLOADER_A,
        },
        {
          id: "img-b1",
          key: `events/${EVENT_ID}/images/img-b1.png`,
          sizeBytes: 2048n,
          deletedAt: null,
          createdByHumanId: UPLOADER_B,
        },
        {
          // Already soft-deleted — credited by the sweep, must NOT re-credit.
          id: "img-b2",
          key: `events/${EVENT_ID}/images/img-b2.png`,
          sizeBytes: 9999n,
          deletedAt: new Date("2026-06-01T00:00:00.000Z"),
          createdByHumanId: UPLOADER_B,
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ADMIN_ID,
      eventId: EVENT_ID,
      clientKey: "takedown-key-0006",
    });

    // Per-uploader HUMAN credits, summed per human, live images only.
    expect(incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: UPLOADER_A,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -1500n,
      }),
    );
    expect(incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: UPLOADER_B,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -2048n,
      }),
    );
    // No org/ownerless subject credit and no double-credit of swept bytes.
    const storageCalls = (
      incrementUsage as unknown as {
        mock: { calls: Array<[Record<string, unknown>]> };
      }
    ).mock.calls
      .map((call) => call[0])
      .filter(
        (args) =>
          args.kind === "STORAGE_BYTES_HUMAN" ||
          args.kind === "STORAGE_BYTES_ORG",
      );
    expect(storageCalls).toHaveLength(2);
  });

  it("OWNED-event image credit is unchanged: one ORG-subject credit, never per-uploader", async () => {
    const UPLOADER_A = "20000000-0000-4000-8000-00000000000a";
    const { deps, incrementUsage } = buildDeps({
      event: makeCommunityEvent({
        orgId: ORG_ID,
        stewardship: "OWNED",
        attendanceMode: "TICKETED",
      }),
      membership: { orgId: ORG_ID, humanId: USER_ID, role: "ADMIN" },
      images: [
        {
          id: "img-o1",
          key: `events/${EVENT_ID}/images/img-o1.jpg`,
          sizeBytes: 1000n,
          deletedAt: null,
          createdByHumanId: UPLOADER_A,
        },
        {
          id: "img-o2",
          key: `events/${EVENT_ID}/images/img-o2.jpg`,
          sizeBytes: 500n,
          deletedAt: null,
          createdByHumanId: USER_ID,
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
      clientKey: "takedown-key-0007",
    });

    expect(incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ORG",
        subjectId: ORG_ID,
        kind: "STORAGE_BYTES_ORG",
        delta: -1500n,
      }),
    );
    const humanStorageCalls = incrementUsage.mock.calls
      .map((call) => call[0] as unknown as Record<string, unknown>)
      .filter((args) => args.kind === "STORAGE_BYTES_HUMAN");
    expect(humanStorageCalls).toHaveLength(0);
  });

  it("a COMMUNITY_MODERATOR cannot cancel a listing (v1)", async () => {
    const { deps, txRepos } = buildDeps({ event: makeCommunityEvent() });

    await expect(
      cancelEvent(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        clientKey: "takedown-key-0002",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(
      (txRepos.events as unknown as { cancel: ReturnType<typeof vi.fn> })
        .cancel,
    ).not.toHaveBeenCalled();
  });

  it("a regular user cannot cancel a listing", async () => {
    const { deps } = buildDeps({ event: makeCommunityEvent() });

    await expect(
      cancelEvent(deps, {
        actorHumanId: USER_ID,
        eventId: EVENT_ID,
        clientKey: "takedown-key-0003",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("OWNED org events are unchanged: org admin cancels via membership, no via marker", async () => {
    const { deps, auditLog } = buildDeps({
      event: makeCommunityEvent({
        orgId: ORG_ID,
        stewardship: "OWNED",
        attendanceMode: "TICKETED",
      }),
      membership: { orgId: ORG_ID, humanId: USER_ID, role: "ADMIN" },
    });

    const result = await cancelEvent(deps, {
      actorHumanId: USER_ID,
      eventId: EVENT_ID,
      clientKey: "takedown-key-0004",
    });

    expect(result.status).toBe("CANCELLED");
    const cancelledAudit = auditLog.mock.calls
      .map((call) => call[0] as { action: string; data: Record<string, unknown> })
      .find((entry) => entry.action === "cancelled");
    expect(cancelledAudit?.data.via).toBeUndefined();
  });

  it("OWNED org events: platform ADMIN without membership still cannot use the override", async () => {
    const { deps } = buildDeps({
      event: makeCommunityEvent({
        orgId: ORG_ID,
        stewardship: "OWNED",
        attendanceMode: "TICKETED",
      }),
      membership: null,
    });

    await expect(
      cancelEvent(deps, {
        actorHumanId: ADMIN_ID,
        eventId: EVENT_ID,
        clientKey: "takedown-key-0005",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

// Owner ruling 2026-09-28: a delegate does everything the principal can on
// the principal's personal events except payout ROUTING — cancelling (and
// refunding) included. Cancel is an ORG_ADMIN_ROLES action, so an OWNER/ADMIN
// delegate may, an EDITOR delegate may not (same as an org EDITOR).
describe("cancelEvent — a human owner's delegates", () => {
  const ownedEvent = () =>
    makeCommunityEvent({
      humanId: USER_ID,
      stewardship: "OWNED",
      attendanceMode: "TICKETED",
    });

  it("an OWNER-role delegate cancels the principal's event, audited as the delegate", async () => {
    const { deps, txRepos, auditLog } = buildDeps({
      event: ownedEvent(),
      rolesByHuman: {},
    });

    const result = await cancelEvent(deps, {
      actorHumanId: MODERATOR_ID,
      eventId: EVENT_ID,
      clientKey: "delegate-cancel-0001",
    });

    expect(result.status).toBe("CANCELLED");
    expect(txRepos.authz.getHumanDelegation).toHaveBeenCalledWith({
      principalId: USER_ID,
      delegateId: MODERATOR_ID,
    });
    const cancelled = auditLog.mock.calls
      .map((call) => call[0] as { action: string; data: Record<string, unknown> })
      .find((entry) => entry.action === "cancelled");
    expect(cancelled?.data.actorHumanId).toBe(MODERATOR_ID);
  });

  it("an EDITOR-role delegate is refused (cancel is an ADMIN-bar action)", async () => {
    const { deps, txRepos } = buildDeps({
      event: ownedEvent(),
      rolesByHuman: {},
    });
    vi.mocked(txRepos.authz.getHumanDelegation).mockResolvedValue({
      orgId: USER_ID,
      humanId: MODERATOR_ID,
      role: "EDITOR",
    } as never);

    await expect(
      cancelEvent(deps, {
        actorHumanId: MODERATOR_ID,
        eventId: EVENT_ID,
        clientKey: "delegate-cancel-0002",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(txRepos.events.cancel).not.toHaveBeenCalled();
  });
});
