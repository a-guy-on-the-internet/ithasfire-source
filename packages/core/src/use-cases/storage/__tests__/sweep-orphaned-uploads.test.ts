import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { TxRepos } from "@th/ports/repos";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";

import {
  sweepOrphanedUploads,
  type SweepOrphanedUploadsDeps,
} from "../sweep-orphaned-uploads";

const NOW = new Date("2026-06-30T12:00:00.000Z");

interface SweepCandidateImage {
  id: string;
  key: string;
  ownerType?: string;
  ownerId?: string;
  eventId?: string | null;
  sizeBytes?: bigint | null;
}

interface SweepData {
  stalledAudio?: Array<{ id: string }>;
  expiredAudio?: Array<{ id: string }>;
  imageCandidates?: SweepCandidateImage[];
  expiredImages?: Array<{ id: string }>;
  /** eventId → the raw reference surfaces the GC reads. Omit an event to simulate an unresolvable read. */
  referenceSets?: Record<
    string,
    { heroImageId?: string | null; body?: unknown; bodies?: unknown[] }
  >;
  /** When set, `listMediaReferenceSets` rejects with this error. */
  referenceSetsError?: Error;
  /** Pending edit suggestions: eventId → the raw `fields` JSON. */
  pendingSuggestions?: Array<{ eventId: string; fields: unknown }>;
  /** When set, `listPendingReferenceFields` rejects with this error. */
  suggestionsError?: Error;
  /** Persisted resume point the run should start from. */
  storedCursor?: unknown;
  /** When set, `jobCursors.get` rejects with this error. */
  cursorReadError?: Error;
  /** When set, `jobCursors.set` rejects with this error. */
  cursorWriteError?: Error;
  /** eventId → { orgId, humanId } for the quota-subject lookup. */
  events?: Record<string, { orgId: string | null; humanId: string | null }>;
  /**
   * Reference sets served from the SECOND `listMediaReferenceSets` call onward
   * — i.e. the in-transaction re-read. Simulates an organizer re-referencing an
   * image between the pre-tx decision and the commit.
   */
  referenceSetsAfterFirstCall?: Record<
    string,
    { heroImageId?: string | null; body?: unknown; bodies?: unknown[] }
  >;
}

function createDeps(data: SweepData = {}) {
  const audioUploads = {
    listStalled: vi.fn(async () => data.stalledAudio ?? []),
    listSoftDeleted: vi.fn(async () => data.expiredAudio ?? []),
    markFailed: vi.fn(async () => undefined),
    softDelete: vi.fn(async () => undefined),
    hardDelete: vi.fn(async () => undefined),
  };
  // Candidates get a synthetic ascending createdAt so the fake can implement
  // the same (createdAt, id) keyset the real adapter does. Without honouring
  // the cursor a fake would hide the starvation bug the cursor exists to fix.
  const allCandidates = (data.imageCandidates ?? []).map((img, i) => ({
    ownerType: "EVENT",
    ownerId: img.eventId ?? "evt-1",
    eventId: img.eventId ?? "evt-1",
    sizeBytes: null,
    createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    ...img,
  }));
  const images = {
    listSweepCandidates: vi.fn(
      async (input: {
        limit: number;
        after?: { createdAt: Date; id: string } | null;
      }) => {
        const after = input.after;
        const remaining = after
          ? allCandidates.filter(
              (c) =>
                c.createdAt.getTime() > after.createdAt.getTime() ||
                (c.createdAt.getTime() === after.createdAt.getTime() &&
                  c.id > after.id),
            )
          : allCandidates;
        return remaining.slice(0, input.limit);
      },
    ),
    listSoftDeleted: vi.fn(async () => data.expiredImages ?? []),
    softDelete: vi.fn(async () => undefined),
    hardDelete: vi.fn(async () => undefined),
  };
  const pendingObjectDeletions = {
    enqueueMany: vi.fn(async () => undefined),
  };
  const eventsMap = data.events ?? {};
  const refSets = data.referenceSets ?? {};
  let mediaReadCount = 0;
  const events = {
    getById: vi.fn(async (id: string) =>
      eventsMap[id] ? { id, ...eventsMap[id] } : null,
    ),
    listMediaReferenceSets: vi.fn(async (eventIds: string[]) => {
      if (data.referenceSetsError) throw data.referenceSetsError;
      mediaReadCount++;
      const active =
        mediaReadCount > 1 && data.referenceSetsAfterFirstCall
          ? data.referenceSetsAfterFirstCall
          : refSets;
      return eventIds
        .filter((id) => id in active)
        .map((id) => ({
          eventId: id,
          heroImageId: active[id]!.heroImageId ?? null,
          bodies: active[id]!.bodies ?? [active[id]!.body ?? null],
        }));
    }),
  };
  const eventEditSuggestions = {
    listPendingReferenceFields: vi.fn(async (eventIds: string[]) => {
      if (data.suggestionsError) throw data.suggestionsError;
      return (data.pendingSuggestions ?? []).filter((s) =>
        eventIds.includes(s.eventId),
      );
    }),
  };
  const jobCursors = {
    get: vi.fn(async () => {
      if (data.cursorReadError) throw data.cursorReadError;
      return data.storedCursor ?? null;
    }),
    set: vi.fn(async () => {
      if (data.cursorWriteError) throw data.cursorWriteError;
      return undefined;
    }),
  };
  const resourceQuotas = {
    incrementUsage: vi.fn(async () => undefined),
  };

  const txRepos = {
    audioUploads,
    images,
    pendingObjectDeletions,
    events,
    eventEditSuggestions,
    jobCursors,
    resourceQuotas,
  } as unknown as TxRepos;

  const tx = vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
    fn(txRepos),
  );

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const clock: ClockPort = { now: vi.fn(() => NOW) };
  const reportError = vi.fn();

  const deps: SweepOrphanedUploadsDeps = {
    repos: {
      audioUploads,
      images,
      pendingObjectDeletions,
      events,
      eventEditSuggestions,
      jobCursors,
      tx,
    } as unknown as SweepOrphanedUploadsDeps["repos"],
    logger: logger as unknown as SweepOrphanedUploadsDeps["logger"],
    clock,
    reportError,
  };

  return {
    deps,
    mocks: {
      audioUploads,
      images,
      pendingObjectDeletions,
      events,
      eventEditSuggestions,
      jobCursors,
      resourceQuotas,
      tx,
      logger,
      reportError,
    },
  };
}

function enqueuedItems(
  mocks: ReturnType<typeof createDeps>["mocks"],
): EnqueuePendingObjectDeletionItem[] {
  return (mocks.pendingObjectDeletions.enqueueMany.mock.calls.at(-1)?.[0] ??
    []) as EnqueuePendingObjectDeletionItem[];
}

const IMAGE_KEY = "events/evt-1/images/img-1.jpg";
const CANDIDATE = { id: "img-1", key: IMAGE_KEY, eventId: "evt-1" };

// ─────────────────────────────────────────────────────────────────────────────
// The invariant: a blob dies only when we have POSITIVELY read every reference
// surface and found it in none of them.
// ─────────────────────────────────────────────────────────────────────────────

describe("sweepOrphanedUploads — images referenced by their event are kept", () => {
  it("keeps an image referenced by the event's hero FK", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: "img-1" } },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
  });

  it("keeps an image referenced by a v1 body image block", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: {
        "evt-1": {
          body: {
            sections: [
              {
                layout: {
                  columns: [
                    { blocks: [{ type: "image", asset: { assetId: "img-1" } }] },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
  });

  it("keeps an image referenced by a nested ProseMirror imageBlock", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: {
        "evt-1": {
          body: {
            sections: [
              {
                layout: {
                  columns: [
                    {
                      blocks: [
                        {
                          type: "richText",
                          doc: {
                            type: "doc",
                            content: [
                              {
                                type: "paragraph",
                                content: [
                                  {
                                    type: "imageBlock",
                                    attrs: { imageId: "img-1" },
                                  },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });

    await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
  });

  /**
   * The regression guard that matters most. The pre-fix reader was shape-aware
   * and returned NOTHING for a body it did not recognise — under a GC that
   * reads "no references found" as "delete it all". A body shape we have never
   * seen must still surrender its references.
   */
  it("keeps an image referenced by a body shape the walker has never seen", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: {
        "evt-1": {
          body: {
            version: 99,
            widgets: [
              { kind: "gallery", items: [{ caption: "x", imageId: "img-1" }] },
            ],
          },
        },
      },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
  });

  it("keeps an image referenced by a SECOND body column, not just the builder body", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      // e.g. Event.waitlistEmailBody. The adapter hands every JSON column over
      // as `bodies`; the sweep must walk all of them, not just the first.
      referenceSets: {
        "evt-1": { bodies: [null, { doc: { imageId: "img-1" } }] },
      },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
  });

  it("treats a truncated walk in ANY body column as unreadable", async () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { child: deep };

    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { bodies: [null, deep] } },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.skippedUnresolvable).toBe(1);
  });

  /**
   * KNOWN GAP, not a designed guarantee: reachability is evaluated only against
   * the image's OWNING event. `sync-series-drafts` copies a pivot event's
   * `content` onto sibling drafts, so a sibling's body can legitimately mention
   * an image owned by another event — and this sweep would not see that.
   *
   * Harm is currently bounded because `resolveBodyImageMap` refuses to render
   * an image whose `ownerId` is not the event being rendered, so such a
   * reference never displays anyway. Widen this to "any event whose body
   * mentions the id" if cross-event references ever become renderable.
   */
  it("evaluates reachability against the owning event only (known gap)", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-1", key: IMAGE_KEY, eventId: "evt-1" },
        { id: "img-2", key: "events/evt-2/images/img-2.jpg", eventId: "evt-2" },
      ],
      // evt-2 references img-1 — which belongs to evt-1, not to it.
      referenceSets: {
        "evt-1": { body: null },
        "evt-2": { heroImageId: "img-1" },
      },
    });

    const result = await sweepOrphanedUploads(deps, {});

    // Both are unreferenced BY THEIR OWN event.
    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-1", "img-2"],
      deletedAt: NOW,
    });
    expect(result.images.unreferencedSoftDeleted).toBe(2);
  });
});

/**
 * A suggestion-borne upload is referenced ONLY by the pending suggestion's
 * `fields` until a moderator approves it. Deleting it makes the suggestion
 * permanently unapprovable — `ensureHeroImageReferenceValid` rejects a
 * soft-deleted image — and the blob is unrecoverable.
 */
describe("sweepOrphanedUploads — pending edit suggestions are a reference surface", () => {
  it("keeps an image a pending suggestion proposes as hero", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      pendingSuggestions: [
        { eventId: "evt-1", fields: { heroImageId: "img-1" } },
      ],
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
  });

  it("keeps an image referenced inside a pending suggestion's content", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      pendingSuggestions: [
        {
          eventId: "evt-1",
          fields: {
            content: {
              sections: [
                {
                  layout: {
                    columns: [
                      {
                        blocks: [
                          { type: "image", asset: { assetId: "img-1" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      ],
    });

    await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
  });

  it("still sweeps an image no suggestion mentions", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      pendingSuggestions: [
        { eventId: "evt-1", fields: { heroImageId: "some-other-image" } },
      ],
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-1"],
      deletedAt: NOW,
    });
    expect(result.images.unreferencedSoftDeleted).toBe(1);
  });

  /**
   * Guards the `if (!referenced.has(row.eventId)) continue;` line in
   * `resolveReferences`. Without it, a pending suggestion would CREATE a
   * reference-set entry for an event whose media read came back empty — turning
   * "could not read this event" into "read it, found only this suggestion" and
   * deleting everything the hero FK and body would have protected.
   */
  it("does not let a suggestion fabricate a reference set for an unreadable event", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-1", key: "k/1.jpg", eventId: "evt-1" },
        { id: "img-2", key: "k/2.jpg", eventId: "evt-1" },
      ],
      // The event's own media read returns nothing for evt-1.
      referenceSets: {},
      // …but a pending suggestion mentions only img-1.
      pendingSuggestions: [
        { eventId: "evt-1", fields: { heroImageId: "img-1" } },
      ],
    });

    const result = await sweepOrphanedUploads(deps, {});

    // img-2 must NOT be deleted just because the suggestion didn't name it.
    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
    expect(result.images.skippedUnresolvable).toBe(2);
  });

  it("abandons the stage when the suggestion read throws", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { body: null } },
      suggestionsError: new Error("db down"),
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.skippedUnresolvable).toBe(1);
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalled();
  });
});

/**
 * Referenced images are never soft-deleted, so they stay candidates forever.
 * Without an advancing cursor the oldest N would occupy the window every run
 * and no newer orphan would EVER be collected — a GC that silently stops
 * collecting while reporting all-zero counters.
 */
describe("sweepOrphanedUploads — the candidate scan advances past what it keeps", () => {
  it("reaches an unreferenced image sitting behind a full page of kept ones", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-keep-1", key: "k/1.jpg", eventId: "evt-1" },
        { id: "img-keep-2", key: "k/2.jpg", eventId: "evt-1" },
        { id: "img-dead", key: "k/dead.jpg", eventId: "evt-1" },
      ],
      referenceSets: {
        "evt-1": { body: { a: { imageId: "img-keep-1" }, b: { imageId: "img-keep-2" } } },
      },
    });

    // limit:1 → the first two pages are entirely retained rows. A non-advancing
    // scan would return img-keep-1 forever and never see img-dead.
    const result = await sweepOrphanedUploads(deps, { limit: 1 });

    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-dead"],
      deletedAt: NOW,
    });
    expect(result.images.unreferencedSoftDeleted).toBe(1);
  });

  it("stops at the page budget and says so rather than looking complete", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-a", key: "k/a.jpg", eventId: "evt-1" },
        { id: "img-b", key: "k/b.jpg", eventId: "evt-1" },
        { id: "img-c", key: "k/c.jpg", eventId: "evt-1" },
      ],
      referenceSets: { "evt-1": { body: { x: { imageId: "img-a" } } } },
    });

    await sweepOrphanedUploads(deps, { limit: 1, maxPagesPerRun: 2 });

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "sweep.image.page_budget_exhausted",
      expect.objectContaining({ pagesScanned: 2, maxPagesPerRun: 2 }),
    );
  });
});

/**
 * The pre-transaction read decides; the in-transaction read is the last line of
 * defence. An organizer who re-inserts a >24h-old image into the body between
 * those two moments must not lose it.
 */
describe("sweepOrphanedUploads — the in-transaction re-check", () => {
  it("spares an image that became referenced after the first read", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 2048n }],
      // Pre-tx: unreferenced → chosen for deletion.
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      // In-tx: the organizer just set it as hero.
      referenceSetsAfterFirstCall: { "evt-1": { heroImageId: "img-1" } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
    // Counted as a benign race, NOT as blindness.
    expect(result.images.racedKept).toBe(1);
    expect(result.images.skippedUnresolvable).toBe(0);
  });

  it("does not credit quota for an image the race check spared", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 2048n }],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      referenceSetsAfterFirstCall: { "evt-1": { heroImageId: "img-1" } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    await sweepOrphanedUploads(deps, {});

    // Crediting bytes back for an image that still exists would inflate the
    // org's free quota permanently.
    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("credits only the images that actually commit in a mixed race", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-raced", key: "k/raced.jpg", eventId: "evt-1", sizeBytes: 1000n },
        { id: "img-dead", key: "k/dead.jpg", eventId: "evt-1", sizeBytes: 25n },
      ],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      referenceSetsAfterFirstCall: { "evt-1": { heroImageId: "img-raced" } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-dead"],
      deletedAt: NOW,
    });
    // 25n only — NOT 1025n.
    expect(
      (mocks.resourceQuotas.incrementUsage as any).mock.calls.map(
        (c: any[]) => c[0],
      ),
    ).toEqual([
      {
        subjectType: "ORG",
        subjectId: "org-1",
        kind: "STORAGE_BYTES_ORG",
        delta: -25n,
      },
    ]);
    expect(result.images.racedKept).toBe(1);
    expect(result.images.unreferencedSoftDeleted).toBe(1);
  });
});

/**
 * The scan must make progress ACROSS runs, not just within one. Retained
 * images stay candidates forever, so a per-run cursor meant every run rescanned
 * the same oldest rows and anything past the page budget was never examined by
 * any run — silently, with all-zero counters.
 */
describe("sweepOrphanedUploads — the cursor survives the run", () => {
  const THREE = [
    { id: "img-a", key: "k/a.jpg", eventId: "evt-1" },
    { id: "img-b", key: "k/b.jpg", eventId: "evt-1" },
    { id: "img-c", key: "k/c.jpg", eventId: "evt-1" },
  ];
  // All three are referenced, so nothing is ever deleted and the candidate set
  // never shrinks — precisely the condition that caused the starvation.
  const ALL_REFERENCED = {
    "evt-1": {
      body: {
        a: { imageId: "img-a" },
        b: { imageId: "img-b" },
        c: { imageId: "img-c" },
      },
    },
  };

  it("persists where it stopped when the page budget cuts the run short", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: THREE,
      referenceSets: ALL_REFERENCED,
    });

    const result = await sweepOrphanedUploads(deps, {
      limit: 1,
      maxPagesPerRun: 2,
    });

    expect(result.images.completedFullPass).toBe(false);
    // Stopped after img-b, so that is the resume point.
    expect(mocks.jobCursors.set).toHaveBeenCalledWith(
      "storage.sweep-orphaned-uploads",
      expect.objectContaining({ id: "img-b" }),
    );
  });

  it("resumes from the stored cursor instead of the oldest row", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: THREE,
      referenceSets: ALL_REFERENCED,
      storedCursor: {
        createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
        id: "img-b",
      },
    });

    const result = await sweepOrphanedUploads(deps, { limit: 1 });

    expect(result.images.resumedFromCursor).toBe(true);
    // The very first query must carry the stored cursor, not null.
    expect(mocks.images.listSweepCandidates.mock.calls[0]![0].after).toEqual({
      createdAt: new Date(Date.UTC(2026, 0, 2)),
      id: "img-b",
    });
  });

  it("wraps back to the start after a completed pass", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: THREE,
      referenceSets: ALL_REFERENCED,
    });

    const result = await sweepOrphanedUploads(deps, { limit: 10 });

    expect(result.images.completedFullPass).toBe(true);
    // Null, so the next run picks up newly-aged rows from the beginning and a
    // cursor can never park permanently past the end of the table.
    expect(mocks.jobCursors.set).toHaveBeenCalledWith(
      "storage.sweep-orphaned-uploads",
      null,
    );
  });

  it("eventually reaches every candidate across successive runs, then wraps", async () => {
    // One row per run. Nothing is ever deleted, so the candidate set is
    // identical every time — only the persisted cursor moves the scan forward.
    const seen: string[] = [];
    let cursor: unknown = null;

    for (let run = 0; run < 4; run++) {
      const { deps, mocks } = createDeps({
        imageCandidates: THREE,
        referenceSets: ALL_REFERENCED,
        storedCursor: cursor,
      });
      await sweepOrphanedUploads(deps, { limit: 1, maxPagesPerRun: 1 });
      cursor = mocks.jobCursors.set.mock.calls.at(-1)![1];
      seen.push((cursor as { id: string } | null)?.id ?? "END");
    }

    // Without persistence every entry would be "img-a" and img-b/img-c would
    // never be examined by any run. The 4th run finds nothing left and wraps.
    expect(seen).toEqual(["img-a", "img-b", "img-c", "END"]);
  });

  it("does not write a cursor on a dry run", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: THREE,
      referenceSets: ALL_REFERENCED,
    });

    await sweepOrphanedUploads(deps, { dryRun: true });

    expect(mocks.jobCursors.set).not.toHaveBeenCalled();
  });
});

describe("sweepOrphanedUploads — cursor bookkeeping never breaks the job", () => {
  it("starts from the beginning when the stored cursor is unparseable", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: "img-1" } },
      storedCursor: { garbage: true },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(result.images.resumedFromCursor).toBe(false);
    expect(mocks.images.listSweepCandidates.mock.calls[0]![0].after).toBeNull();
  });

  it("starts from the beginning when the cursor read throws", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: "img-1" } },
      cursorReadError: new Error("db down"),
    });

    const result = await sweepOrphanedUploads(deps, {});

    // A GC that crashes on its own bookkeeping stops collecting entirely.
    expect(result.images.resumedFromCursor).toBe(false);
    expect(mocks.logger.error).toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it("still reports its work when the cursor write throws", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
      cursorWriteError: new Error("db down"),
    });

    const result = await sweepOrphanedUploads(deps, {});

    // The sweep itself succeeded; only the resume point was lost.
    expect(result.images.unreferencedSoftDeleted).toBe(1);
    expect(mocks.reportError).toHaveBeenCalled();
  });
});

describe("sweepOrphanedUploads — genuinely unreferenced images", () => {
  it("enqueues the KEY and soft-deletes the row atomically", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { heroImageId: null, body: null } },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(enqueuedItems(mocks)).toEqual([
      {
        targetKey: IMAGE_KEY,
        targetKind: "KEY",
        source: "sweep_unreferenced_image",
        sourceId: "img-1",
      },
    ]);
    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-1"],
      deletedAt: NOW,
    });
    expect(result.images.unreferencedSoftDeleted).toBe(1);
    expect(result.images.filesEnqueued).toBe(1);
  });

  it("sweeps only the unreferenced image out of a mixed batch", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-hero", key: "k/hero.jpg", eventId: "evt-1" },
        { id: "img-body", key: "k/body.jpg", eventId: "evt-1" },
        { id: "img-dead", key: "k/dead.jpg", eventId: "evt-1" },
      ],
      referenceSets: {
        "evt-1": {
          heroImageId: "img-hero",
          body: { blocks: [{ imageId: "img-body" }] },
        },
      },
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).toHaveBeenCalledWith({
      imageIds: ["img-dead"],
      deletedAt: NOW,
    });
    expect(result.images.unreferencedSoftDeleted).toBe(1);
  });
});

describe("sweepOrphanedUploads — unreadable references never authorize a delete", () => {
  it("skips a candidate whose event did not come back", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: {}, // evt-1 absent
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
    expect(result.images.skippedUnresolvable).toBe(1);
  });

  it("abandons the stage entirely when the reference read throws", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE, { id: "img-2", key: "k/2.jpg" }],
      referenceSetsError: new Error("db down"),
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.images.unreferencedSoftDeleted).toBe(0);
    expect(result.images.skippedUnresolvable).toBe(2);
    expect(mocks.logger.error).toHaveBeenCalled();
    // A GC that has gone blind exits 0 with all-zero deletion counts, which is
    // indistinguishable from "nothing to do" — it MUST reach Sentry.
    expect(mocks.reportError).toHaveBeenCalled();
  });

  it("skips an image whose owner type it does not understand", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-org", key: "k/org.jpg", ownerType: "ORG", ownerId: "org-1" },
      ],
      referenceSets: {},
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result.images.skippedUnresolvable).toBe(1);
  });
});

/**
 * The prod incident (2026-08-08) deleted a live event's audio because the sweep
 * treated `attached: false` as "orphaned". Audio is reachable for as long as
 * its event lives, so this job must never touch it.
 */
describe("sweepOrphanedUploads — audio is never collected by this job", () => {
  it("does not soft-delete or enqueue audio, however old", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [],
      stalledAudio: [],
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.audioUploads.softDelete).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.audio).toEqual({ stalledMarkedFailed: 0, hardDeleted: 0 });
  });

  it("never asks the audio repo for anything beyond stalled + soft-deleted", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [CANDIDATE],
      referenceSets: { "evt-1": { body: null } },
    });

    await sweepOrphanedUploads(deps, {});

    // Sweeping an image must not drag audio into the deletion batch.
    expect(mocks.audioUploads.softDelete).not.toHaveBeenCalled();
    expect(
      enqueuedItems(mocks).every((i) => i.source === "sweep_unreferenced_image"),
    ).toBe(true);
  });
});

describe("sweepOrphanedUploads — storage quota credit", () => {
  function storageDecrements(mocks: ReturnType<typeof createDeps>["mocks"]) {
    return (mocks.resourceQuotas.incrementUsage as any).mock.calls.map(
      (c: any[]) => c[0],
    );
  }

  it("credits swept image bytes back to the event's HUMAN owner", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 1500n }],
      referenceSets: { "evt-1": { body: null } },
      events: { "evt-1": { orgId: null, humanId: "human-1" } },
    });

    await sweepOrphanedUploads(deps, {});

    expect(storageDecrements(mocks)).toContainEqual({
      subjectType: "HUMAN",
      subjectId: "human-1",
      kind: "STORAGE_BYTES_HUMAN",
      delta: -1500n,
    });
    expect(mocks.tx).toHaveBeenCalled();
  });

  it("credits swept image bytes back to the event's ORG owner", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 4096n }],
      referenceSets: { "evt-1": { body: null } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    await sweepOrphanedUploads(deps, {});

    expect(storageDecrements(mocks)).toContainEqual({
      subjectType: "ORG",
      subjectId: "org-1",
      kind: "STORAGE_BYTES_ORG",
      delta: -4096n,
    });
  });

  it("does NOT credit bytes for an image it kept", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 4096n }],
      referenceSets: { "evt-1": { heroImageId: "img-1" } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    await sweepOrphanedUploads(deps, {});

    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
  });

  it("groups credits per-event for a batch spanning two events", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [
        { id: "img-a", key: "k/a.jpg", eventId: "evt-a", sizeBytes: 100n },
        { id: "img-a2", key: "k/a2.jpg", eventId: "evt-a", sizeBytes: 200n },
        { id: "img-b", key: "k/b.jpg", eventId: "evt-b", sizeBytes: 50n },
      ],
      referenceSets: { "evt-a": { body: null }, "evt-b": { body: null } },
      events: {
        "evt-a": { orgId: "org-a", humanId: null },
        "evt-b": { orgId: null, humanId: "human-b" },
      },
    });

    await sweepOrphanedUploads(deps, {});

    const decrements = storageDecrements(mocks);
    expect(decrements).toContainEqual({
      subjectType: "ORG",
      subjectId: "org-a",
      kind: "STORAGE_BYTES_ORG",
      delta: -300n,
    });
    expect(decrements).toContainEqual({
      subjectType: "HUMAN",
      subjectId: "human-b",
      kind: "STORAGE_BYTES_HUMAN",
      delta: -50n,
    });
  });
});

describe("sweepOrphanedUploads — dryRun", () => {
  it("counts but does not enqueue, soft-delete, or credit quota", async () => {
    const { deps, mocks } = createDeps({
      imageCandidates: [{ ...CANDIDATE, sizeBytes: 1024n }],
      referenceSets: { "evt-1": { body: null } },
      events: { "evt-1": { orgId: "org-1", humanId: null } },
    });

    const result = await sweepOrphanedUploads(deps, { dryRun: true });

    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(mocks.resourceQuotas.incrementUsage).not.toHaveBeenCalled();
    expect(mocks.tx).not.toHaveBeenCalled();

    // Counts still reflect what WOULD be cleaned up (but filesEnqueued stays 0).
    expect(result.images.unreferencedSoftDeleted).toBe(1);
    expect(result.images.filesEnqueued).toBe(0);
  });
});

describe("sweepOrphanedUploads — unchanged DB-only stages", () => {
  it("marks stalled audio as failed (no enqueue)", async () => {
    const { deps, mocks } = createDeps({
      stalledAudio: [{ id: "aud-stalled" }],
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.audioUploads.markFailed).toHaveBeenCalledWith({
      id: "aud-stalled",
      failedAt: NOW,
      failureReason: "Stalled: no finalization after upload timeout",
    });
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.audio.stalledMarkedFailed).toBe(1);
  });

  it("hard-deletes expired soft-deleted audio + images (no enqueue)", async () => {
    const { deps, mocks } = createDeps({
      expiredAudio: [{ id: "aud-expired" }],
      expiredImages: [{ id: "img-expired" }],
    });

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.audioUploads.hardDelete).toHaveBeenCalledWith("aud-expired");
    expect(mocks.images.hardDelete).toHaveBeenCalledWith("img-expired");
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(result.audio.hardDeleted).toBe(1);
    expect(result.images.hardDeleted).toBe(1);
  });
});

describe("sweepOrphanedUploads — empty inputs", () => {
  it("no-ops with all-zero counts and no writes", async () => {
    const { deps, mocks } = createDeps({});

    const result = await sweepOrphanedUploads(deps, {});

    expect(mocks.tx).not.toHaveBeenCalled();
    expect(mocks.pendingObjectDeletions.enqueueMany).not.toHaveBeenCalled();
    expect(mocks.audioUploads.softDelete).not.toHaveBeenCalled();
    expect(mocks.images.softDelete).not.toHaveBeenCalled();
    expect(result).toEqual({
      audio: {
        stalledMarkedFailed: 0,
        hardDeleted: 0,
      },
      images: {
        unreferencedSoftDeleted: 0,
        hardDeleted: 0,
        filesEnqueued: 0,
        skippedUnresolvable: 0,
        racedKept: 0,
        resumedFromCursor: false,
        completedFullPass: true,
      },
    });
  });

  it("does not even read reference sets when there are no candidates", async () => {
    const { deps, mocks } = createDeps({});

    await sweepOrphanedUploads(deps, {});

    expect(mocks.events.listMediaReferenceSets).not.toHaveBeenCalled();
  });
});
