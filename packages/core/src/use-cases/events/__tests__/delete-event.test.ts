import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import { createFakeIdempotencyPort, type FakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  DELETE_EVENT_OPEN_CALL_NOTICES_MAX,
  deleteEvent,
  type DeleteEventDeps,
} from "../delete-event";
import { openCallNoticeKey, type OpenCallNoticeKind } from "../open-calls/notify-open-call-notices";
import {
  OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES,
  openCallNoticeFailuresKey,
} from "../open-calls/_shared/open-call-notice-failures";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000005";
const NOW = new Date("2026-05-01T12:00:00.000Z");

type RepoMocks = {
  tx: ReturnType<typeof vi.fn>;
  events: {
    getById: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  authz: {
    getHumanDelegation: ReturnType<typeof vi.fn>;
    getOrgMembership: ReturnType<typeof vi.fn>;
  };
  audit: {
    log: ReturnType<typeof vi.fn>;
  };
  audioUploads: {
    listByEventIdIncludingDeleted: ReturnType<typeof vi.fn>;
  };
  images: {
    listByEventId: ReturnType<typeof vi.fn>;
  };
  pendingObjectDeletions: {
    enqueueMany: ReturnType<typeof vi.fn>;
  };
  resourceQuotas: {
    incrementUsage: ReturnType<typeof vi.fn>;
  };
  eventApplications: {
    getOpenCall: ReturnType<typeof vi.fn>;
    lockOpenCallForClose: ReturnType<typeof vi.fn>;
    setOpenCallClosed: ReturnType<typeof vi.fn>;
    expireUndecidedOpenCallSubmissions: ReturnType<typeof vi.fn>;
    listOpenCallSubmissionsByFormStatus: ReturnType<typeof vi.fn>;
    countSubmissionsByForm: ReturnType<typeof vi.fn>;
  };
};

function buildEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "DRAFT",
    title: "Draft Event",
    publishedAt: null,
    startsAt: new Date("2026-06-01T20:00:00.000Z"),
    endsAt: new Date("2026-06-01T22:00:00.000Z"),
    ...overrides,
  } as EventRecord;
}

function buildMembership(role: OrgMembership["role"]): OrgMembership {
  return {
    orgId: ORG_ID,
    humanId: ACTOR_ID,
    role,
  };
}

function createDeps(): { deps: DeleteEventDeps; mocks: RepoMocks } {
  const events = {
    getById: vi.fn(),
    delete: vi.fn(async () => true),
  };
  const authz = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(),
  };
  const audit = {
    log: vi.fn(async () => undefined),
  };
  const audioUploads = {
    listByEventIdIncludingDeleted: vi.fn(async () => []),
  };
  const images = {
    listByEventId: vi.fn(async () => []),
  };
  const pendingObjectDeletions = {
    enqueueMany: vi.fn(async () => undefined),
  };
  const resourceQuotas = {
    incrementUsage: vi.fn(async () => undefined),
  };
  // No open call by default (open calls FR-022 tests below seed one).
  const eventApplications = {
    getOpenCall: vi.fn(async () => null),
    lockOpenCallForClose: vi.fn(async () => null),
    setOpenCallClosed: vi.fn(async () => undefined),
    expireUndecidedOpenCallSubmissions: vi.fn(async () => ({ ids: [] as string[] })),
    listOpenCallSubmissionsByFormStatus: vi.fn(async () => []),
    countSubmissionsByForm: vi.fn(async () => 0),
  };

  const txRepos = {
    events,
    authz,
    audit,
    audioUploads,
    images,
    pendingObjectDeletions,
    resourceQuotas,
    eventApplications,
  } as unknown as TxRepos;
  const tx = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
    fn(txRepos),
  );
  const repos = {
    ...txRepos,
    tx,
  } as unknown as Repos;
  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  };

  return {
    deps: { repos, clock },
    mocks: {
      tx,
      events,
      authz,
      audit,
      audioUploads,
      images,
      pendingObjectDeletions,
      resourceQuotas,
      eventApplications,
    },
  };
}

describe("deleteEvent", () => {
  let deps: DeleteEventDeps;
  let mocks: RepoMocks;

  beforeEach(() => {
    ({ deps, mocks } = createDeps());
  });

  it("deletes draft org events for org admins", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("ADMIN"));

    const result = await deleteEvent(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, deleted: true });
    expect(mocks.tx).toHaveBeenCalledTimes(1);
    expect(mocks.events.delete).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(mocks.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: EVENT_ID,
      action: "event_deleted",
      data: {
        actorHumanId: ACTOR_ID,
        orgId: ORG_ID,
        humanId: null,
        status: "DRAFT",
      },
      at: NOW,
    });
  });

  it("deletes draft human events for the owning human", async () => {
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );

    await expect(
      deleteEvent(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
      }),
    ).resolves.toEqual({ eventId: EVENT_ID, deleted: true });

    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(mocks.events.delete).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("rejects non-admin org members", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("EDITOR"));

    await expect(
      deleteEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(mocks.events.delete).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
  });

  it("rejects human-owned events for other humans", async () => {
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );

    await expect(
      deleteEvent(deps, {
        actorHumanId: OTHER_HUMAN_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });

    expect(mocks.events.delete).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
  });

  it("refuses to delete non-draft events", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent({ status: "PUBLISHED" }));
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("OWNER"));

    await expect(
      deleteEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_DRAFT_USE_CANCEL_INSTEAD" });

    expect(mocks.events.delete).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("refuses to delete draft events that were previously published", async () => {
    mocks.events.getById.mockResolvedValue(
      buildEvent({
        orgId: null,
        humanId: HUMAN_ID,
        publishedAt: new Date("2026-05-02T12:00:00.000Z"),
      }),
    );

    await expect(
      deleteEvent(deps, {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_WAS_PUBLISHED" });

    expect(mocks.events.delete).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("returns typed conflict when repository lifecycle guard refuses deletion", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("OWNER"));
    mocks.events.delete.mockResolvedValueOnce(false);

    await expect(
      deleteEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });

    expect(mocks.events.delete).toHaveBeenCalledWith({ eventId: EVENT_ID });
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("returns not_found for unknown events", async () => {
    mocks.events.getById.mockResolvedValue(null);

    await expect(
      deleteEvent(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });

    expect(mocks.authz.getOrgMembership).not.toHaveBeenCalled();
    expect(mocks.events.delete).not.toHaveBeenCalled();
  });
});

describe("deleteEvent — storage outbox enqueue", () => {
  const SOURCE_KEY = "uploads/audio/aud-1.mp3";
  const HLS_PLAYLIST_KEY = `events/${EVENT_ID}/audio/aud-1/audio.m3u8`;
  const HLS_PREFIX = `events/${EVENT_ID}/audio/aud-1/`;
  const IMAGE_KEY_1 = `events/${EVENT_ID}/images/img-1.jpg`;
  const IMAGE_KEY_2 = `events/${EVENT_ID}/images/img-2.png`;

  /** Pull the single enqueueMany call's item array. */
  function enqueuedItems(
    mocks: RepoMocks,
  ): EnqueuePendingObjectDeletionItem[] {
    expect(mocks.pendingObjectDeletions.enqueueMany).toHaveBeenCalledTimes(1);
    return mocks.pendingObjectDeletions.enqueueMany.mock
      .calls[0][0] as EnqueuePendingObjectDeletionItem[];
  }

  it("enqueues the audio source as KEY, the HLS prefix as PREFIX, and each image as KEY", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      {
        sourceKey: SOURCE_KEY,
        hlsPlaylistKey: HLS_PLAYLIST_KEY,
        segmentCount: 2,
      },
    ]);
    mocks.images.listByEventId.mockResolvedValue([
      { id: "img-1", key: IMAGE_KEY_1 },
      { id: "img-2", key: IMAGE_KEY_2 },
    ]);

    const result = await deleteEvent(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, deleted: true });

    // Keys are collected before the DB delete (rows still exist).
    expect(
      mocks.audioUploads.listByEventIdIncludingDeleted,
    ).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.images.listByEventId).toHaveBeenCalledWith(EVENT_ID);

    const items = enqueuedItems(mocks);
    // Source key + each image key are KEY targets; the HLS folder is a PREFIX.
    expect(items).toContainEqual({
      targetKey: SOURCE_KEY,
      targetKind: "KEY",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: IMAGE_KEY_1,
      targetKind: "KEY",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: IMAGE_KEY_2,
      targetKind: "KEY",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: HLS_PREFIX,
      targetKind: "PREFIX",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
  });

  it("enqueues the source key as a single KEY when the upload has no HLS playlist", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      { sourceKey: SOURCE_KEY, hlsPlaylistKey: null },
    ]);

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

    const items = enqueuedItems(mocks);
    expect(items).toEqual([
      {
        targetKey: SOURCE_KEY,
        targetKind: "KEY",
        source: "event_delete",
        sourceId: EVENT_ID,
      },
    ]);
  });

  it("enqueues an empty list for an event with no media", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    // listByEventId default mocks already return [].

    const result = await deleteEvent(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, deleted: true });
    expect(
      mocks.audioUploads.listByEventIdIncludingDeleted,
    ).toHaveBeenCalledWith(EVENT_ID);
    expect(mocks.images.listByEventId).toHaveBeenCalledWith(EVENT_ID);
    expect(enqueuedItems(mocks)).toEqual([]);
  });

  it("includes soft-deleted image keys in the enqueue", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    // A soft-deleted image (deletedAt set) is still returned by listByEventId
    // and must be enqueued — it cascades away with the event.
    mocks.images.listByEventId.mockResolvedValue([
      { id: "img-1", key: IMAGE_KEY_1 },
      { id: "img-2", key: IMAGE_KEY_2 },
    ]);

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

    const items = enqueuedItems(mocks);
    const keys = items.map((i) => i.targetKey);
    expect(keys).toContain(IMAGE_KEY_1);
    expect(keys).toContain(IMAGE_KEY_2);
  });

  it("includes a soft-deleted audio upload's sourceKey + HLS prefix in the enqueue", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    // A soft-deleted audio upload (deletedAt set) is still returned by
    // listByEventIdIncludingDeleted and must be enqueued — it cascades away
    // with the event, and the orphan sweep can't reclaim a cascade-deleted row.
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      {
        sourceKey: SOURCE_KEY,
        hlsPlaylistKey: HLS_PLAYLIST_KEY,
        deletedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const result = await deleteEvent(deps, {
      actorHumanId: HUMAN_ID,
      eventId: EVENT_ID,
    });

    expect(result).toEqual({ eventId: EVENT_ID, deleted: true });
    const items = enqueuedItems(mocks);
    expect(items).toContainEqual({
      targetKey: SOURCE_KEY,
      targetKind: "KEY",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
    expect(items).toContainEqual({
      targetKey: HLS_PREFIX,
      targetKind: "PREFIX",
      source: "event_delete",
      sourceId: EVENT_ID,
    });
  });

  it("enqueues BEFORE deleting the event (intent committed with the cascade)", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      { sourceKey: SOURCE_KEY, hlsPlaylistKey: null },
    ]);

    const order: string[] = [];
    mocks.pendingObjectDeletions.enqueueMany.mockImplementation(async () => {
      order.push("enqueue");
    });
    mocks.events.delete.mockImplementation(async () => {
      order.push("delete");
      return true;
    });

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

    expect(order).toEqual(["enqueue", "delete"]);
  });

  it("credits the ORG's storage quota by Σ(audio + image) bytes", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(buildEvent()); // org-owned
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("OWNER"));
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      { sourceKey: SOURCE_KEY, hlsPlaylistKey: null, sourceSizeBytes: 5000n },
    ]);
    mocks.images.listByEventId.mockResolvedValue([
      { id: "img-1", key: IMAGE_KEY_1, sizeBytes: 1024n },
      { id: "img-2", key: IMAGE_KEY_2, sizeBytes: 2048n },
    ]);

    await deleteEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    expect(mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ORG",
        subjectId: ORG_ID,
        kind: "STORAGE_BYTES_ORG",
        delta: -(5000n + 1024n + 2048n),
      }),
    );
  });

  it("credits the HUMAN's storage quota for human-owned events", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      { sourceKey: SOURCE_KEY, hlsPlaylistKey: null, sourceSizeBytes: 700n },
    ]);
    mocks.images.listByEventId.mockResolvedValue([
      { id: "img-1", key: IMAGE_KEY_1, sizeBytes: 300n },
    ]);

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

    expect(mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "HUMAN",
        subjectId: HUMAN_ID,
        kind: "STORAGE_BYTES_HUMAN",
        delta: -1000n,
      }),
    );
  });

  it("does not credit quota when the event has no media (zero bytes)", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(
      buildEvent({ orgId: null, humanId: HUMAN_ID }),
    );
    // default media mocks return [].

    await deleteEvent(deps, { actorHumanId: HUMAN_ID, eventId: EVENT_ID });

    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("credits ONLY live bytes — soft-deleted audio + image bytes were already credited by the sweep", async () => {
    const { deps, mocks } = createDeps();
    mocks.events.getById.mockResolvedValue(buildEvent()); // org-owned
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("OWNER"));
    mocks.audioUploads.listByEventIdIncludingDeleted.mockResolvedValue([
      {
        sourceKey: SOURCE_KEY,
        hlsPlaylistKey: null,
        sourceSizeBytes: 5000n,
        deletedAt: null, // live
      },
      {
        sourceKey: "uploads/audio/aud-soft.mp3",
        hlsPlaylistKey: null,
        sourceSizeBytes: 9999n,
        deletedAt: new Date("2026-04-01T00:00:00.000Z"), // already credited
      },
    ]);
    mocks.images.listByEventId.mockResolvedValue([
      { id: "img-1", key: IMAGE_KEY_1, sizeBytes: 1024n, deletedAt: null },
      {
        id: "img-2",
        key: IMAGE_KEY_2,
        sizeBytes: 8000n,
        deletedAt: new Date("2026-04-01T00:00:00.000Z"), // already credited
      },
    ]);

    await deleteEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });

    // Credit = live audio (5000) + live image (1024) only — NOT the totals.
    expect(mocks.resourceQuotas.incrementUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ORG",
        subjectId: ORG_ID,
        kind: "STORAGE_BYTES_ORG",
        delta: -(5000n + 1024n),
      }),
    );
    // Coverage unchanged: all four blobs (live + soft-deleted) still enqueued.
    const items = enqueuedItems(mocks);
    const keys = items.map((i) => i.targetKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        SOURCE_KEY,
        "uploads/audio/aud-soft.mp3",
        IMAGE_KEY_1,
        IMAGE_KEY_2,
      ]),
    );
  });
});

describe("deleteEvent — open call on the draft (FR-022)", () => {
  const FORM_ID = "00000000-0000-4000-8000-0000000000f1";
  type Status = "PENDING" | "WAITLISTED" | "APPROVED" | "REJECTED" | "EXPIRED" | "WITHDRAWN";
  type Row = { id: string; status: Status };
  const subId = (n: number) => `sub-${String(n).padStart(4, "0")}`;
  const rows = (status: Status, count: number, from = 0): Row[] =>
    Array.from({ length: count }, (_, i) => ({ id: subId(from + i), status }));

  /**
   * A stateful call + applications behind the mocks, the notice ledger as a
   * fake idempotency store, and notifiers that write it like the real one.
   */
  function seed(initial: Row[] = rows("PENDING", 2)) {
    const { deps, mocks } = createDeps();
    const subs = initial.map((r) => ({ ...r }));
    const form = { id: FORM_ID, eventId: EVENT_ID, seriesId: null, postedAt: NOW as Date | null, closedAt: null as Date | null };
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("ADMIN"));
    mocks.eventApplications.getOpenCall.mockImplementation(async () => ({ ...form }));
    mocks.eventApplications.lockOpenCallForClose.mockImplementation(async () => ({ ...form }));
    mocks.eventApplications.setOpenCallClosed.mockImplementation(async (input: { closedAt: Date | null }) => {
      form.closedAt = input.closedAt;
      return { ...form };
    });
    mocks.eventApplications.expireUndecidedOpenCallSubmissions.mockImplementation(async () => {
      const ids: string[] = [];
      for (const r of subs) {
        if (r.status !== "PENDING" && r.status !== "WAITLISTED") continue;
        r.status = "EXPIRED";
        ids.push(r.id);
      }
      return { ids };
    });
    mocks.eventApplications.listOpenCallSubmissionsByFormStatus.mockImplementation(
      async (input: { statuses: Status[]; afterId: string | null; limit: number }) =>
        subs
          .filter((r) => input.statuses.includes(r.status) && (!input.afterId || r.id > input.afterId))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, input.limit)
          .map((r) => ({ submissionId: r.id, status: r.status })),
    );
    mocks.eventApplications.countSubmissionsByForm.mockImplementation(
      async (input: { statuses: Status[] }) => subs.filter((r) => input.statuses.includes(r.status)).length,
    );

    const ledger = createFakeIdempotencyPort({ withStatus: true });
    const markSent = async (kind: OpenCallNoticeKind, id: string) => {
      const key = openCallNoticeKey(kind, id);
      await ledger.begin(key, 60);
      await ledger.commit(key, { sentAt: "x" }, 3600);
    };
    const order: string[] = [];
    /** Submission ids whose notice throws. */
    const failing = new Set<string>();
    /** Submission ids whose notifier returns but leaves the ledger open (a recipient failed). */
    const unsettled = new Set<string>();
    const notifier = (kind: OpenCallNoticeKind) =>
      vi.fn(async (n: { submissionId: string }) => {
        order.push(`${kind}:${n.submissionId}`);
        if (failing.has(n.submissionId)) throw new Error(`mail down for ${n.submissionId}`);
        if (unsettled.has(n.submissionId)) return;
        await markSent(kind, n.submissionId);
      });
    const notifyOpenCallPulled = notifier("pulled");
    const notifyOpenCallNotThisTime = notifier("not-this-time");
    mocks.events.delete.mockImplementation(async () => {
      order.push("delete");
      return true;
    });
    const reportError = vi.fn();
    return {
      deps: {
        ...deps,
        notifyOpenCallPulled,
        notifyOpenCallNotThisTime,
        openCallNoticeLedger: ledger,
        reportError,
      } satisfies DeleteEventDeps,
      mocks,
      subs,
      form,
      notifyOpenCallPulled,
      notifyOpenCallNotThisTime,
      order,
      failing,
      unsettled,
      markSent,
      reportError,
    };
  }
  type Seeded = ReturnType<typeof seed>;
  const run = (s: Seeded) => deleteEvent(s.deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID });
  const reasons = (s: Seeded) =>
    s.reportError.mock.calls.map((c) => (c[1] as { tags: { reason: string } }).tags.reason);

  it("closes the call, expires PENDING and tells each applicant BEFORE the cascade", async () => {
    const s = seed();
    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.mocks.eventApplications.setOpenCallClosed).toHaveBeenCalledWith({
      formId: FORM_ID,
      closedAt: NOW,
      closedByHumanId: ACTOR_ID,
    });
    expect(s.mocks.eventApplications.expireUndecidedOpenCallSubmissions).toHaveBeenCalledWith({
      formId: FORM_ID,
      reviewedAt: NOW,
    });
    expect(s.notifyOpenCallPulled).toHaveBeenCalledWith({
      kind: "open_call_pulled",
      submissionId: subId(0),
      formId: FORM_ID,
      anchor: { kind: "event", eventId: EVENT_ID },
      title: "Draft Event",
    });
    expect(s.order).toEqual([`pulled:${subId(0)}`, `pulled:${subId(1)}`, "delete"]);
    expect(s.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "open_call_pulled", entityId: EVENT_ID }),
    );
  });

  it("refuses a stranger before touching the call", async () => {
    const s = seed();
    s.mocks.authz.getOrgMembership.mockResolvedValue(buildMembership("EDITOR"));
    await expect(run(s)).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(s.mocks.eventApplications.lockOpenCallForClose).not.toHaveBeenCalled();
    expect(s.mocks.eventApplications.expireUndecidedOpenCallSubmissions).not.toHaveBeenCalled();
    expect(s.notifyOpenCallPulled).not.toHaveBeenCalled();
  });

  it("a failing notice REFUSES the delete (rows survive for the reconcile); a retry sends only what is missing", async () => {
    const s = seed();
    s.failing.add(subId(0));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
    expect(s.subs.map((r) => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(reasons(s)).toEqual(["notice_failed", "notices_unsettled"]);
    expect(s.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ useCase: "deleteEvent", reason: "notices_unsettled" }) }),
    );

    // Mail is back: the retry re-sends the one that failed, not the other.
    s.failing.clear();
    s.order.length = 0;
    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.order).toEqual([`pulled:${subId(0)}`, "delete"]);
  });

  it("a notifier that returns with a recipient unsent (ledger open) also refuses", async () => {
    const s = seed();
    s.unsettled.add(subId(1));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
    expect(reasons(s)).toEqual(["notices_unsettled"]);
  });

  it("dead after 3 failures: two deletes refuse, the third failure inside a delete lets it proceed and reports it", async () => {
    const s = seed();
    s.failing.add(subId(0));
    const ledger = s.deps.openCallNoticeLedger;
    const failuresOf = () => ledger.get(openCallNoticeFailuresKey("pulled", subId(0)));

    for (let attempt = 1; attempt < OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES; attempt += 1) {
      await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
      expect(await failuresOf()).toEqual({ count: attempt });
      expect(s.mocks.events.delete).not.toHaveBeenCalled();
      expect(reasons(s)).not.toContain("open_call.notice_undeliverable_on_delete");
    }

    s.order.length = 0;
    s.reportError.mockClear();
    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    // The third send was still attempted, then the delete went ahead.
    expect(s.order).toEqual([`pulled:${subId(0)}`, "delete"]);
    expect(await failuresOf()).toEqual({ count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES });
    expect(reasons(s)).toEqual(["notice_failed", "notice_undeliverable", "open_call.notice_undeliverable_on_delete"]);
    const report = s.reportError.mock.calls.find(
      (c) => (c[1] as { tags: { reason: string } }).tags.reason === "open_call.notice_undeliverable_on_delete",
    )!;
    // Ids and kind only: never a guest email or status token.
    expect(report[1]).toEqual({
      tags: { useCase: "deleteEvent", reason: "open_call.notice_undeliverable_on_delete", kind: "pulled" },
      extra: {
        eventId: EVENT_ID,
        formId: FORM_ID,
        submissionId: subId(0),
        kind: "pulled",
        failures: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES,
      },
    });
    // Reported only once the cascade committed.
    expect(s.reportError.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
      s.mocks.events.delete.mock.invocationCallOrder[0]!,
    );
  });

  it("a notice that dies during a delete that is then refused is still reported (once)", async () => {
    const s = seed(rows("EXPIRED", 2));
    s.form.closedAt = new Date(NOW.getTime() - 60_000);
    await s.deps.openCallNoticeLedger.commit(
      openCallNoticeFailuresKey("pulled", subId(0)),
      { count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES - 1 },
      3600,
    );
    s.failing.add(subId(0));
    s.failing.add(subId(1));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
    const crossed = s.reportError.mock.calls.filter(
      (c) => (c[1] as { tags: { reason: string } }).tags.reason === "notice_undeliverable",
    );
    expect(crossed).toHaveLength(1);
    // Ids and kind only: never a guest email or status token.
    expect(crossed[0]![1]).toEqual({
      tags: { useCase: "deleteEvent", reason: "notice_undeliverable", kind: "pulled", pass: "delete" },
      extra: { submissionId: subId(0), formId: FORM_ID, failures: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES },
    });
    expect(reasons(s)).not.toContain("open_call.notice_undeliverable_on_delete");
  });

  describe("fail closed when the ledger misbehaves", () => {
    const FAILURES_PREFIX = "open-call-notice-failures:";
    const mocksOf = (s: Seeded) => (s.deps.openCallNoticeLedger as unknown as FakeIdempotencyPort).__mocks;

    it("(a) the failure-counter read rejects: the delete rejects and nothing is deleted", async () => {
      const s = seed(rows("EXPIRED", 2));
      s.form.closedAt = new Date(NOW.getTime() - 60_000);
      const get = mocksOf(s).get;
      const real = get.getMockImplementation()!;
      get.mockImplementation(async (key: string, ...rest: unknown[]) => {
        if (key.startsWith(FAILURES_PREFIX)) throw new Error("store down");
        return real(key, ...rest);
      });
      await expect(run(s)).rejects.toThrow("store down");
      expect(s.mocks.events.delete).not.toHaveBeenCalled();
      expect(s.notifyOpenCallPulled).not.toHaveBeenCalled();
    });

    it("(b) one ledger read rejecting inside a batch of 10 fails the whole delete", async () => {
      const s = seed(rows("EXPIRED", 10));
      s.form.closedAt = new Date(NOW.getTime() - 60_000);
      const status = mocksOf(s).status;
      const real = status.getMockImplementation()!;
      status.mockImplementation(async (key: string, ...rest: unknown[]) => {
        if (key === openCallNoticeKey("pulled", subId(7))) throw new Error("read failed");
        return real(key, ...rest);
      });
      await expect(run(s)).rejects.toThrow("read failed");
      expect(s.mocks.events.delete).not.toHaveBeenCalled();
      expect(s.notifyOpenCallPulled).not.toHaveBeenCalled();
    });

    it("(c) the counter commit rejecting after a failed send refuses the delete and is reported", async () => {
      const s = seed(rows("EXPIRED", 1));
      s.form.closedAt = new Date(NOW.getTime() - 60_000);
      s.failing.add(subId(0));
      const commit = mocksOf(s).commit;
      const real = commit.getMockImplementation()!;
      commit.mockImplementation(async (key: string, ...rest: unknown[]) => {
        if (key.startsWith(FAILURES_PREFIX)) throw new Error("commit failed");
        return real(key, ...rest);
      });
      await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
      expect(s.mocks.events.delete).not.toHaveBeenCalled();
      expect(reasons(s)).toEqual(["notice_failed", "notice_failure_count_failed", "notices_unsettled"]);
    });
  });

  it("a row already dead (e.g. counted by the hourly sweep) is not re-sent and does not block", async () => {
    const s = seed(rows("EXPIRED", 2));
    s.form.closedAt = new Date(NOW.getTime() - 60_000);
    await s.deps.openCallNoticeLedger.commit(
      openCallNoticeFailuresKey("pulled", subId(0)),
      { count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES },
      3600,
    );
    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.order).toEqual([`pulled:${subId(1)}`, "delete"]);
    expect(reasons(s)).toEqual(["open_call.notice_undeliverable_on_delete"]);
  });

  it("a row below the dead threshold still refuses (and its failure is counted)", async () => {
    const s = seed(rows("EXPIRED", 1));
    s.form.closedAt = new Date(NOW.getTime() - 60_000);
    await s.deps.openCallNoticeLedger.commit(
      openCallNoticeFailuresKey("pulled", subId(0)),
      { count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES - 2 },
      3600,
    );
    s.unsettled.add(subId(0));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
    expect(await s.deps.openCallNoticeLedger.get(openCallNoticeFailuresKey("pulled", subId(0)))).toEqual({
      count: OPEN_CALL_NOTICE_DEAD_AFTER_FAILURES - 1,
    });
  });

  it("close then delete with >25 applicants: the 15 close left to the reconcile are told before the cascade", async () => {
    // Close flipped 40 PENDING → REJECTED and sent the first 25 in-request.
    const s = seed(rows("REJECTED", 40));
    s.form.closedAt = new Date(NOW.getTime() - 60_000);
    for (const r of s.subs.slice(0, 25)) await s.markSent("not-this-time", r.id);

    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });

    const told = s.order.filter((o) => o !== "delete");
    expect(told).toEqual(s.subs.slice(25).map((r) => `not-this-time:${r.id}`));
    expect(s.order.at(-1)).toBe("delete");
    expect(s.notifyOpenCallNotThisTime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "open_call_not_this_time", submissionId: subId(25), formId: FORM_ID }),
    );
    // Already closed: the close stamp is kept.
    expect(s.mocks.eventApplications.setOpenCallClosed).not.toHaveBeenCalled();
  });

  it("more owed than the in-request cap: sends one batch and refuses; a later delete finishes", async () => {
    // Close's request died before sending anything: all 40 are owed.
    const s = seed(rows("REJECTED", 40));
    s.form.closedAt = new Date(NOW.getTime() - 60_000);

    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.notifyOpenCallNotThisTime).toHaveBeenCalledTimes(DELETE_EVENT_OPEN_CALL_NOTICES_MAX);
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
    expect(reasons(s)).toEqual(["notices_over_cap"]);

    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.notifyOpenCallNotThisTime).toHaveBeenCalledTimes(40);
  });

  it("a mix: REJECTED owed not-this-time, EXPIRED from an earlier attempt owed pulled; already-told rows are skipped", async () => {
    const s = seed([...rows("REJECTED", 2), ...rows("EXPIRED", 2, 2), { id: subId(4), status: "APPROVED" }, { id: subId(5), status: "WITHDRAWN" }]);
    s.form.closedAt = new Date(NOW.getTime() - 60_000);
    await s.markSent("not-this-time", subId(0));
    await s.markSent("pulled", subId(2));

    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.order).toEqual([`not-this-time:${subId(1)}`, `pulled:${subId(3)}`, "delete"]);
  });

  it("WAITLISTED applicants are expired with the PENDING ones and told the call was pulled", async () => {
    const s = seed([{ id: subId(0), status: "PENDING" }, { id: subId(1), status: "WAITLISTED" }]);
    await expect(run(s)).resolves.toEqual({ eventId: EVENT_ID, deleted: true });
    expect(s.subs.map((r) => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(s.order).toEqual([`pulled:${subId(0)}`, `pulled:${subId(1)}`, "delete"]);
  });

  it("unwired notifiers or ledger with anyone owed: refused and reported, nothing sent", async () => {
    for (const missing of ["notifyOpenCallPulled", "notifyOpenCallNotThisTime", "openCallNoticeLedger"] as const) {
      const s = seed();
      const deps = { ...s.deps, [missing]: undefined };
      await expect(deleteEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID })).rejects.toMatchObject({
        code: "EVENT_NOT_DELETABLE",
      });
      expect(s.mocks.events.delete).not.toHaveBeenCalled();
      expect(reasons(s)).toEqual(["notice_seams_unwired"]);
    }
  });

  it("a posted call nobody applied to deletes without any seam", async () => {
    const s = seed([]);
    const deps = { ...s.deps, notifyOpenCallPulled: undefined, notifyOpenCallNotThisTime: undefined, openCallNoticeLedger: undefined };
    await expect(deleteEvent(deps, { actorHumanId: ACTOR_ID, eventId: EVENT_ID })).resolves.toEqual({
      eventId: EVENT_ID,
      deleted: true,
    });
  });

  it("a draft (never posted) call is left to the cascade: nothing to tell", async () => {
    const s = seed();
    s.form.postedAt = null;
    await run(s);
    expect(s.mocks.tx).toHaveBeenCalledTimes(1);
    expect(s.mocks.eventApplications.expireUndecidedOpenCallSubmissions).not.toHaveBeenCalled();
    expect(s.notifyOpenCallPulled).not.toHaveBeenCalled();
  });

  it("refuses the delete when an undecided application is on the call at delete time", async () => {
    const s = seed();
    s.mocks.eventApplications.countSubmissionsByForm.mockResolvedValue(1);
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.eventApplications.countSubmissionsByForm).toHaveBeenCalledWith({
      formId: FORM_ID,
      statuses: ["PENDING", "WAITLISTED"],
    });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
  });

  it("refuses the delete when the call was reopened after its notices were settled", async () => {
    const s = seed();
    // The delete transaction's lock reads the call reopened (closedAt cleared).
    s.mocks.eventApplications.lockOpenCallForClose
      .mockImplementationOnce(async () => ({ ...s.form }))
      .mockImplementationOnce(async () => ({ ...s.form, closedAt: null }));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
  });

  it("refuses the delete when the call was posted after the retire check", async () => {
    const s = seed();
    // First read (outside any tx) sees an unposted call; the delete tx sees it posted.
    s.mocks.eventApplications.getOpenCall.mockImplementationOnce(async () => ({ ...s.form, postedAt: null }));
    await expect(run(s)).rejects.toMatchObject({ code: "EVENT_NOT_DELETABLE" });
    expect(s.mocks.events.delete).not.toHaveBeenCalled();
  });
});
