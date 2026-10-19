import { describe, expect, it, vi } from "vitest";

import { cancelEvent } from "../cancel-event";
import type { CancelEventDeps } from "../cancel-event";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const CLIENT_KEY = "cancel-key-12345";
const BASE_DATE = new Date("2024-06-01T00:00:00.000Z");

// Owned events never hit the FR-014 platform-staff override; deny-all stub.
const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Test Event",
    slug: "test-event",
    startsAt: BASE_DATE,
    endsAt: BASE_DATE,
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    ...overrides,
  } as EventRecord;
}

interface AudioStub {
  id: string;
  sourceKey: string;
  hlsPlaylistKey: string | null;
  sourceSizeBytes?: bigint | null;
  deletedAt?: Date | null;
}

interface BuildDepsOptions {
  event?: Partial<EventRecord>;
  images?: Array<{
    id: string;
    key: string;
    sizeBytes: bigint | null;
    deletedAt: Date | null;
  }>;
  audio?: AudioStub[];
}

function buildDeps(options: BuildDepsOptions = {}) {
  const event = makeEvent(options.event);
  const images = options.images ?? [];
  const audio = options.audio ?? [];

  const eventsRepo = {
    getById: vi.fn(async () => event),
    lockRows: vi.fn(async () => undefined),
    cancel: vi.fn(async () => event),
  };

  const authzRepo = {
    getOrgMembership: vi.fn(async () => ({
      orgId: event.orgId,
      humanId: ACTOR_ID,
      role: "OWNER" as const,
    })),
  };

  const ordersRepo = {
    listAll: vi.fn(async () => ({ items: [], total: 0 })),
    // The cancellation's door cash phase: no cash sales here.
    listSucceededCashOrderIdsForEvent: vi.fn(async () => []),
    markRefunded: vi.fn(async () => undefined),
  };

  const orderItemsRepo = {
    listByOrderId: vi.fn(async () => []),
  };

  const ticketsRepo = {
    listByOrderId: vi.fn(async () => []),
    setStatus: vi.fn(async () => undefined),
  };

  const imagesRepo = {
    listByOwner: vi.fn(async () => images),
    softDelete: vi.fn(async () => undefined),
  };

  const audioUploadsRepo = {
    listByEventIdIncludingDeleted: vi.fn(async () => audio),
    softDelete: vi.fn(async () => undefined),
  };

  const pendingObjectDeletionsRepo = {
    enqueueMany: vi.fn(async () => undefined),
  };

  const eventChangeNoticesRepo = {
    create: vi.fn(async () => undefined),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const resourceQuotasRepo = {
    incrementUsage: vi.fn(async () => undefined),
  };

  const txRepos = {
    events: eventsRepo,
    authz: authzRepo,
    orders: ordersRepo,
    orderItems: orderItemsRepo,
    tickets: ticketsRepo,
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    images: imagesRepo,
    audioUploads: audioUploadsRepo,
    pendingObjectDeletions: pendingObjectDeletionsRepo,
    eventChangeNotices: eventChangeNoticesRepo,
    audit: auditRepo,
    resourceQuotas: resourceQuotasRepo,
    // Booking-timeline reverse lookup: this event never came from a booking.
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
  } as unknown as Repos;
  (repos as any).tx = vi.fn(async (fn: (tx: TxRepos) => Promise<any>) =>
    fn(repos as unknown as TxRepos),
  );

  const payments = {
    refundPaymentIntent: vi.fn(async () => ({
      refundId: "re_test",
      status: "succeeded",
    })),
    getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 0 })),
  } as unknown as CancelEventDeps["payments"];

  const idempotency = createFakeIdempotencyPort();

  const clock = {
    now: vi.fn(() => BASE_DATE),
  };

  const logger = createTestLogger();
  const reportError = vi.fn();

  return {
    deps: {
      repos,
      authz: denyStaffAuthz,
      payments,
      idempotency,
      clock,
      logger,
      reportError,
    } satisfies CancelEventDeps,
    mocks: {
      eventsRepo,
      imagesRepo,
      audioUploadsRepo,
      pendingObjectDeletionsRepo,
      resourceQuotasRepo,
      eventChangeNoticesRepo,
      reportError,
      // The transaction boundary. The fake runs the callback inline, so
      // "before the transaction" and "inside it" are indistinguishable
      // WITHOUT comparing invocation order against this mock.
      tx: (repos as any).tx as ReturnType<typeof vi.fn>,
    },
  };
}

/** Pull the single enqueueMany call's item array. */
function enqueuedItems(
  mocks: ReturnType<typeof buildDeps>["mocks"],
): EnqueuePendingObjectDeletionItem[] {
  expect(mocks.pendingObjectDeletionsRepo.enqueueMany).toHaveBeenCalledTimes(1);
  return (mocks.pendingObjectDeletionsRepo.enqueueMany as any).mock
    .calls[0][0] as EnqueuePendingObjectDeletionItem[];
}

describe("cancelEvent — image storage reclamation", () => {
  it("soft-deletes event images, enqueues their blobs, and decrements STORAGE_BYTES_ORG", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
        {
          id: "img-2",
          key: "events/ev1/images/img-2.png",
          sizeBytes: 2048n,
          deletedAt: null,
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Images should be soft-deleted.
    expect(mocks.imagesRepo.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-1", "img-2"],
      deletedAt: BASE_DATE,
    });

    // Blobs routed through the outbox (KEY targets, source event_cancel).
    const items = enqueuedItems(mocks);
    expect(items).toContainEqual({
      targetKey: "events/ev1/images/img-1.jpg",
      targetKind: "KEY",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: "events/ev1/images/img-2.png",
      targetKind: "KEY",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });

    // Quota should be decremented with total bytes.
    expect(mocks.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ORG",
        subjectId: ORG_ID,
        kind: "STORAGE_BYTES_ORG",
        delta: -3072n,
      }),
    );
  });

  it("decrements STORAGE_BYTES_HUMAN for human-owned events", async () => {
    const { deps, mocks } = buildDeps({
      event: { orgId: null, humanId: HUMAN_ID },
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 512n,
          deletedAt: null,
        },
      ],
    });

    // Patch authz to skip org check for human-owned event
    (deps.repos as any).authz.getOrgMembership = vi.fn(async () => null);
    (deps.repos as any).events.getById = vi.fn(async () =>
      makeEvent({ orgId: null, humanId: HUMAN_ID }),
    );

    await cancelEvent(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -512n,
      }),
    );
  });

  it("skips already-deleted images", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
        {
          id: "img-2",
          key: "events/ev1/images/img-2.png",
          sizeBytes: 2048n,
          deletedAt: new Date("2024-01-01"),
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Only the live image should be soft-deleted.
    expect(mocks.imagesRepo.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-1"],
      deletedAt: BASE_DATE,
    });

    // Only the live image's blob is enqueued (the soft-deleted one is left to
    // the orphan sweep, mirroring the prior R2-cleanup behaviour).
    const items = enqueuedItems(mocks);
    const keys = items.map((i) => i.targetKey);
    expect(keys).toContain("events/ev1/images/img-1.jpg");
    expect(keys).not.toContain("events/ev1/images/img-2.png");

    // Quota should reflect only the live image's size.
    expect(mocks.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "STORAGE_BYTES_ORG",
        delta: -1024n,
      }),
    );
  });

  it("does not decrement quota when event has no images", async () => {
    const { deps, mocks } = buildDeps({ images: [] });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.imagesRepo.softDelete).not.toHaveBeenCalled();
    // The only incrementUsage call should be for EVENTS_PER_ORG, not storage.
    const storageCalls = (
      mocks.resourceQuotasRepo.incrementUsage as any
    ).mock.calls.filter(
      (c: any[]) =>
        c[0].kind === "STORAGE_BYTES_ORG" ||
        c[0].kind === "STORAGE_BYTES_HUMAN",
    );
    expect(storageCalls).toHaveLength(0);
  });

  it("collects media targets BEFORE the transaction opens (a best-effort read must not be able to condemn the tx)", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
      ],
      audio: [
        { id: "aud-1", sourceKey: "uploads/audio/aud-1.mp3", hlsPlaylistKey: null },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Both collection reads happen strictly before repos.tx is entered. The
    // fake runs the tx callback inline, so this ordering check is the ONLY
    // thing distinguishing "hoisted out" from "still inside the transaction".
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    const txOrder = mocks.tx.mock.invocationCallOrder[0]!;
    const imagesOrder = mocks.imagesRepo.listByOwner.mock.invocationCallOrder[0]!;
    const audioOrder =
      mocks.audioUploadsRepo.listByEventIdIncludingDeleted.mock
        .invocationCallOrder[0]!;
    expect(imagesOrder).toBeLessThan(txOrder);
    expect(audioOrder).toBeLessThan(txOrder);
  });

  it("still cancels the event when media-target COLLECTION (a read) throws — read runs pre-tx, reported + logged at error, the tx runs to completion", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
      ],
    });

    // Make the image listByOwner READ throw. The collection is best-effort
    // and runs BEFORE the transaction, so a transient list failure cannot
    // abort the Postgres session the cancel commits on — the cancel proceeds
    // with no media targets. A swallow that is only logged is invisible, so
    // it must also reach the reporter. cancelEvent logs via a child logger;
    // pin the child to a controllable instance to observe the error call.
    const childLogger = createTestLogger();
    const errorSpy = childLogger.error as ReturnType<typeof vi.fn>;
    (deps.logger as any).child = vi.fn(() => childLogger);
    const listByOwner = vi.fn(async () => {
      throw new Error("DB failure");
    });
    (deps.repos as any).images = {
      ...((deps.repos as any).images ?? {}),
      listByOwner,
      softDelete: vi.fn(),
    };

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // The cancel itself should still succeed.
    expect(result.status).toBe("CANCELLED");

    // The failing read ran BEFORE the transaction opened. Inside it, the
    // aborted session would have surfaced as a 25P02 on the change-notice
    // write and the cancel would have FAILED, not degraded.
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(listByOwner.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.tx.mock.invocationCallOrder[0]!,
    );

    // The transaction ran to its last statement with the empty target set.
    expect(mocks.eventChangeNoticesRepo.create).toHaveBeenCalledTimes(1);
    expect(mocks.pendingObjectDeletionsRepo.enqueueMany).toHaveBeenCalledWith(
      [],
    );

    // The collection failure is alertable (error level), not a silent warn …
    expect(errorSpy).toHaveBeenCalledWith(
      "cancel_event_media_collection_failed",
      expect.objectContaining({ eventId: EVENT_ID, error: "DB failure" }),
    );
    // … AND it reaches the reporter (a log-only swallow is invisible).
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "DB failure" }),
      expect.objectContaining({
        tags: { useCase: "cancelEvent", stage: "media_collection" },
        extra: { eventId: EVENT_ID },
      }),
    );
  });

  it("a throwing reporter never changes the media-collection swallow's behaviour", async () => {
    const { deps, mocks } = buildDeps({ images: [] });
    (deps.repos as any).images = {
      ...((deps.repos as any).images ?? {}),
      listByOwner: vi.fn(async () => {
        throw new Error("DB failure");
      }),
      softDelete: vi.fn(),
    };
    mocks.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    const result = await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(result.status).toBe("CANCELLED");
    expect(mocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("ROLLS BACK the cancel when enqueueMany rejects — the outbox intent is atomic with the cancellation", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
      ],
    });

    // The blob-deletion WRITE fails. Because the enqueue is UNGUARDED inside
    // the tx, this must propagate — cancelEvent rejects and the tx (cancel +
    // refunds + soft-deletes) rolls back rather than committing without the
    // deletion intent.
    (mocks.pendingObjectDeletionsRepo.enqueueMany as any).mockRejectedValue(
      new Error("outbox write failed"),
    );

    await expect(
      cancelEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toThrow("outbox write failed");
  });

  it("ROLLS BACK the cancel when an audio softDelete WRITE rejects", async () => {
    const { deps, mocks } = buildDeps({
      audio: [
        {
          id: "aud-1",
          sourceKey: "uploads/audio/aud-1.mp3",
          hlsPlaylistKey: null,
        },
      ],
    });

    (mocks.audioUploadsRepo.softDelete as any).mockRejectedValue(
      new Error("audio softDelete failed"),
    );

    await expect(
      cancelEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        clientKey: CLIENT_KEY,
      }),
    ).rejects.toThrow("audio softDelete failed");
  });
});

describe("cancelEvent — audio storage reclamation", () => {
  const SOURCE_KEY = "uploads/audio/aud-1.mp3";
  const HLS_PLAYLIST_KEY = `events/${EVENT_ID}/audio/aud-1/audio.m3u8`;
  const HLS_PREFIX = `events/${EVENT_ID}/audio/aud-1/`;

  it("soft-deletes audio rows and enqueues source KEY + HLS PREFIX", async () => {
    const { deps, mocks } = buildDeps({
      audio: [
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: HLS_PLAYLIST_KEY },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Audio rows are read (including soft-deleted) and soft-deleted.
    expect(
      mocks.audioUploadsRepo.listByEventIdIncludingDeleted,
    ).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.audioUploadsRepo.softDelete).toHaveBeenCalledWith({
      audioUploadIds: ["aud-1"],
      deletedAt: BASE_DATE,
    });

    const items = enqueuedItems(mocks);
    expect(items).toContainEqual({
      targetKey: SOURCE_KEY,
      targetKind: "KEY",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: HLS_PREFIX,
      targetKind: "PREFIX",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });
  });

  it("credits the audio bytes back to the owner's storage quota", async () => {
    const { deps, mocks } = buildDeps({
      audio: [
        {
          id: "aud-1",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: HLS_PLAYLIST_KEY,
          sourceSizeBytes: 4096n,
        },
        {
          id: "aud-2",
          sourceKey: "uploads/audio/aud-2.mp3",
          hlsPlaylistKey: null,
          sourceSizeBytes: null, // null → 0n
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ORG",
        subjectId: ORG_ID,
        kind: "STORAGE_BYTES_ORG",
        delta: -4096n,
      }),
    );
  });

  it("does NOT credit an already-soft-deleted audio row's bytes (it was credited by the sweep) but STILL enqueues its blobs", async () => {
    const { deps, mocks } = buildDeps({
      audio: [
        {
          id: "aud-live",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: null,
          sourceSizeBytes: 1000n,
          deletedAt: null, // live
        },
        {
          id: "aud-soft",
          sourceKey: "uploads/audio/aud-soft.mp3",
          hlsPlaylistKey: HLS_PLAYLIST_KEY,
          sourceSizeBytes: 9999n, // already credited by the sweep
          deletedAt: new Date("2024-04-01T00:00:00.000Z"),
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // Quota credit is LIVE-only: 1000n, not 1000n + 9999n.
    const storageDeltas = (
      mocks.resourceQuotasRepo.incrementUsage as any
    ).mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a.kind === "STORAGE_BYTES_ORG")
      .map((a: any) => a.delta as bigint);
    expect(storageDeltas).toContain(-1000n);
    expect(storageDeltas).not.toContain(-9999n);
    expect(storageDeltas).not.toContain(-(1000n + 9999n));

    // Coverage unchanged: both rows soft-deleted + both blobs enqueued.
    expect(mocks.audioUploadsRepo.softDelete).toHaveBeenCalledWith({
      audioUploadIds: ["aud-live", "aud-soft"],
      deletedAt: BASE_DATE,
    });
    const keys = enqueuedItems(mocks).map((i) => i.targetKey);
    expect(keys).toContain(SOURCE_KEY);
    expect(keys).toContain("uploads/audio/aud-soft.mp3");
    expect(keys).toContain(HLS_PREFIX);
  });

  it("credits audio AND image bytes (separate decrements summing correctly)", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
      ],
      audio: [
        {
          id: "aud-1",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: null,
          sourceSizeBytes: 2048n,
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    const storageDeltas = (
      mocks.resourceQuotasRepo.incrementUsage as any
    ).mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a.kind === "STORAGE_BYTES_ORG")
      .map((a: any) => a.delta as bigint);

    // One decrement for images (-1024n) and one for audio (-2048n).
    expect(storageDeltas).toContain(-1024n);
    expect(storageDeltas).toContain(-2048n);
    expect(storageDeltas.reduce((s: bigint, d: bigint) => s + d, 0n)).toBe(
      -3072n,
    );
  });

  it("includes an already-soft-deleted audio upload (source + HLS prefix)", async () => {
    const { deps, mocks } = buildDeps({
      audio: [
        {
          id: "aud-soft",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: HLS_PLAYLIST_KEY,
          deletedAt: new Date("2024-04-01T00:00:00.000Z"),
        },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    // The already-soft-deleted row is still soft-deleted (idempotent) and its
    // blobs are still enqueued — a cascade can't be reclaimed by the sweep.
    expect(mocks.audioUploadsRepo.softDelete).toHaveBeenCalledWith({
      audioUploadIds: ["aud-soft"],
      deletedAt: BASE_DATE,
    });
    const items = enqueuedItems(mocks);
    expect(items).toContainEqual({
      targetKey: SOURCE_KEY,
      targetKind: "KEY",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: HLS_PREFIX,
      targetKind: "PREFIX",
      source: "event_cancel",
      sourceId: EVENT_ID,
    });
  });

  it("enqueues only the source KEY when the upload has no HLS playlist", async () => {
    const { deps, mocks } = buildDeps({
      audio: [{ id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: null }],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    const items = enqueuedItems(mocks);
    expect(items).toEqual([
      {
        targetKey: SOURCE_KEY,
        targetKind: "KEY",
        source: "event_cancel",
        sourceId: EVENT_ID,
      },
    ]);
  });

  it("does not soft-delete audio rows when the event has no audio", async () => {
    const { deps, mocks } = buildDeps({ audio: [] });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    expect(mocks.audioUploadsRepo.softDelete).not.toHaveBeenCalled();
    // enqueueMany is still called once (with an empty list — a no-op in the
    // adapter) since there were no media blobs.
    expect(enqueuedItems(mocks)).toEqual([]);
  });

  it("enqueues both audio and image targets together", async () => {
    const { deps, mocks } = buildDeps({
      images: [
        {
          id: "img-1",
          key: "events/ev1/images/img-1.jpg",
          sizeBytes: 1024n,
          deletedAt: null,
        },
      ],
      audio: [
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: HLS_PLAYLIST_KEY },
      ],
    });

    await cancelEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      clientKey: CLIENT_KEY,
    });

    const items = enqueuedItems(mocks);
    const keys = items.map((i) => i.targetKey);
    expect(keys).toContain("events/ev1/images/img-1.jpg");
    expect(keys).toContain(SOURCE_KEY);
    expect(keys).toContain(HLS_PREFIX);
  });
});
