import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { ImageRecord } from "@th/ports/repos/images";
import type { LoggerPort } from "@th/ports/logger";
import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { EnqueuePendingObjectDeletionItem } from "@th/ports/repos/pending-object-deletions";
import {
  eventStorageQuotaSubject,
  type EventStorageQuotaSubject,
} from "./event-media-targets";
import { collectReferencedImageIds } from "../events/_shared/event-image-references";
import { incrementResourceUsage } from "../quotas/enforce-quota";

/**
 * Key under which the image stage stores its cross-run resume point. Matches
 * the scheduled job name so the row is findable by whoever is debugging the
 * job, not just by whoever wrote this file.
 */
const IMAGE_SWEEP_CURSOR_KEY = "storage.sweep-orphaned-uploads";

// ─────────────────────────────────────────────────────────────────────────────
// Input / Output
// ─────────────────────────────────────────────────────────────────────────────

export const sweepOrphanedUploadsInputSchema = z.object({
  /** Max records to process per sweep (prevents long-running jobs). */
  limit: z.number().int().positive().default(100),
  /** Hours before a PENDING/UPLOADED audio upload is considered stalled. */
  audioStalledAfterHours: z.number().positive().default(1),
  /**
   * Hours an image must exist before the sweep will even consider it. Covers
   * the window between "blob uploaded" and "event body saved with the
   * reference in it" — an image younger than this is never touched, however
   * unreferenced it currently looks.
   */
  unreferencedGracePeriodHours: z.number().positive().default(24),
  /**
   * Max candidate PAGES (of `limit` rows) the image stage will scan per run.
   * Bounds a single run's work.
   *
   * Exhausting this budget genuinely DEFERS work rather than skipping it: the
   * cursor is persisted (`jobCursors`, keyed by job name), so the next run
   * resumes where this one stopped and wraps to the start only after a
   * completed pass. `sweep.image.page_budget_exhausted` says a run was cut
   * short; `completedFullPass: false` says the same in the result.
   *
   * This was NOT always true. With a per-run cursor, every run restarted at the
   * oldest candidate — and because a retained image is never soft-deleted and
   * so stays a candidate forever, anything past `maxPagesPerRun * limit` was
   * never scanned by ANY run. That is the failure this budget must not
   * reintroduce: if you ever drop cursor persistence, this becomes a silent
   * cliff again, not a slower scan.
   */
  maxPagesPerRun: z.number().int().positive().default(50),
  /** Days before a soft-deleted record is hard-deleted. */
  hardDeleteAfterDays: z.number().positive().default(7),
  /** When false, only logs/counts what would be cleaned up — no enqueue or soft-delete. */
  dryRun: z.boolean().default(false),
});

export type SweepOrphanedUploadsInput = z.infer<
  typeof sweepOrphanedUploadsInputSchema
>;

export const sweepOrphanedUploadsOutputSchema = z.object({
  audio: z.object({
    stalledMarkedFailed: z.number(),
    hardDeleted: z.number(),
  }),
  images: z.object({
    unreferencedSoftDeleted: z.number(),
    hardDeleted: z.number(),
    filesEnqueued: z.number(),
    /**
     * Candidates the sweep declined to judge because their reference surfaces
     * could not be read (missing event, truncated walk, failing query). Never
     * deleted. A persistently non-zero value means the GC is blind to some rows
     * and wants investigating, not ignoring.
     *
     * Deliberately does NOT include `racedKept` — a race is benign and
     * expected, blindness is an incident, and one number that mixes them can
     * never be alerted on.
     */
    skippedUnresolvable: z.number(),
    /**
     * Images that looked unreferenced on the pre-transaction read but had been
     * re-referenced by the time the transaction re-checked. Kept, not deleted.
     */
    racedKept: z.number(),
    /** Whether this run picked up a stored cursor rather than starting fresh. */
    resumedFromCursor: z.boolean(),
    /**
     * Whether the scan reached the end of the candidate set this run (and so
     * wrapped the cursor back to the start). False means the page budget cut
     * the run short and the next run resumes mid-table.
     */
    completedFullPass: z.boolean(),
  }),
});

export type SweepOrphanedUploadsOutput = z.infer<
  typeof sweepOrphanedUploadsOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type SweepOrphanedUploadsDeps = {
  repos: Pick<
    Repos,
    | "audioUploads"
    | "images"
    | "pendingObjectDeletions"
    | "events"
    | "eventEditSuggestions"
    | "jobCursors"
    | "tx"
  >;
  logger: LoggerPort;
  clock: ClockPort;
  /**
   * Required by the project's error-reporting convention for any branch that
   * catches a failure and returns a degraded result instead of throwing. Both
   * such branches live in this file, and both are silent-failure shaped: the
   * job still exits 0 and the scheduler still records success, so without this
   * a GC that has gone blind looks exactly like a GC with nothing to do.
   */
  reportError?: ReporterPort;
};

/**
 * Resolves an event's storage-quota subject, caching by eventId across a batch
 * so we never refetch the same event. Swept rows always reference a live event
 * (a deleted event would have cascade-removed them), so getById should resolve
 * — a null result is handled defensively by the callers (skip credit).
 */
async function makeEventQuotaSubjectResolver(
  repos: Pick<Repos, "events">,
  logger: LoggerPort,
  reportError?: ReporterPort,
) {
  const cache = new Map<string, EventStorageQuotaSubject | null>();
  return async (
    eventId: string | null,
  ): Promise<EventStorageQuotaSubject | null> => {
    if (!eventId) return null;
    if (cache.has(eventId)) return cache.get(eventId) ?? null;
    let event: EventRecord | null = null;
    try {
      event = await repos.events.getById(eventId);
    } catch (err) {
      // The sweep still deletes the blob — only the byte CREDIT is lost, and
      // it is lost permanently (the row is soft-deleted, so no later run
      // revisits it). That silently inflates the owner's storage usage, so it
      // must be visible rather than swallowed.
      logger.error("sweep.quota_subject_lookup_failed", { err, eventId });
      reportError?.(err, {
        tags: { job: "storage.sweep-orphaned-uploads" },
        extra: { eventId, effect: "storage quota credit skipped" },
      });
      event = null;
    }
    const subject = event ? eventStorageQuotaSubject(event) : null;
    cache.set(eventId, subject);
    return subject;
  };
}

/** Accumulates freed bytes per quota subject, keyed by subjectType+subjectId+kind. */
function addFreedBytes(
  acc: Map<string, { subject: EventStorageQuotaSubject; bytes: bigint }>,
  subject: EventStorageQuotaSubject | null,
  bytes: bigint,
): void {
  if (!subject || bytes <= 0n) return;
  const key = `${subject.subjectType}:${subject.subjectId}:${subject.kind}`;
  const existing = acc.get(key);
  if (existing) {
    existing.bytes += bytes;
  } else {
    acc.set(key, { subject, bytes });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Periodic sweep job that cleans up orphaned audio and image uploads.
 *
 * Stages:
 * 1. **Stalled audio** — PENDING/UPLOADED > N hours → mark FAILED (DB-only)
 * 2. **Unreferenced images** — older than the grace period AND not reachable
 *    from ANY of their event's three reference surfaces (hero FK, builder body
 *    JSON, and the `fields` of any PENDING edit suggestion) → enqueue the blobs into the
 *    deletion outbox + soft-delete the rows, atomically in one tx. The drain
 *    job (storage.drain-pending-deletions) then removes the objects durably
 *    with retries — no best-effort inline delete that could orphan bytes once
 *    the row hard-deletes and loses the reference.
 * 3. **Expired** — soft-deleted > N days → hard-delete record (DB-only)
 *
 * ## Reachability is computed, never cached
 *
 * Stage 2 asks the event itself whether it still points at the image. It used
 * to consult an `Image.attached` boolean instead, which read like an orphan
 * test and was not one: outside the seed script, NOTHING in the codebase ever
 * set `attached` — not the upload finalizer, not the event save, not the hero
 * assignment. Every genuinely organizer-uploaded image therefore sat at
 * `attached: false` forever and this job deleted it, irrecoverably, 24 hours
 * after upload. It reached production (2026-08-08) and destroyed a live
 * event's hero image, an in-body image, and its audio.
 *
 * The invariant that replaced it: **a blob may only be deleted when we have
 * positively read the surfaces that could reference it and found it in none of
 * them.** Anything that prevents that read — a missing event, a body shape the
 * walker does not recognise, a throwing query — must keep the blob, not
 * collect it. Keeping an unused blob costs a few KB; the other error is
 * permanent. Preserve this asymmetry in any future change here.
 *
 * ## Why audio has no unreferenced stage
 *
 * `AudioUpload.eventId` is NOT NULL and cascade-deletes with the event, so
 * audio that outlives its event is handled where the event dies: `deleteEvent`
 * and `cancelEvent` enqueue its blobs into the same outbox, transactionally.
 *
 * This used to add "and `resolveEventAudio` surfaces EVERY non-soft-deleted
 * upload, so a live row is referenced by definition." That is NO LONGER TRUE:
 * the public path now serves only uploads the event body references, because
 * removing a track means deleting its `audioBlock` and the row survives.
 *
 * KNOWN GAP as a result: an upload that was removed from the body is now
 * invisible to the public AND uncollectable — no delete-audio use case exists,
 * and this job does not sweep audio. Its blob sits in R2 until the event is
 * deleted. Closing that means computing audio reachability from the body the
 * way the image stage does, plus a grace period long enough to cover "uploaded
 * but not inserted yet" (the builder shows transcode progress before a track is
 * placed). Do NOT reintroduce a flag-based audio stage to fix it — `attached`
 * is set by nothing, which is what made this job destroy live media.
 */
export async function sweepOrphanedUploads(
  deps: SweepOrphanedUploadsDeps,
  rawInput: unknown,
): Promise<SweepOrphanedUploadsOutput> {
  const { repos, logger, clock } = deps;

  const parsed = sweepOrphanedUploadsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw Object.assign(new Error("invalid_input"), { code: "invalid_input" });
  }
  const input = parsed.data;
  const now = clock.now();

  // Resolves (and caches) each detached row's event → quota subject, so freed
  // storage bytes are credited back to the same org/human the upload charged.
  const resolveQuotaSubject = await makeEventQuotaSubjectResolver(
    repos,
    logger,
    deps.reportError,
  );

  const result: SweepOrphanedUploadsOutput = {
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
      completedFullPass: false,
    },
  };

  // ── Audio: mark stalled uploads as FAILED ──────────────────────────────
  const stalledCutoff = new Date(
    now.getTime() - input.audioStalledAfterHours * 60 * 60 * 1000,
  );
  const stalledUploads = await repos.audioUploads.listStalled({
    olderThan: stalledCutoff,
    limit: input.limit,
  });

  for (const upload of stalledUploads) {
    if (!input.dryRun) {
      await repos.audioUploads.markFailed({
        id: upload.id,
        failedAt: now,
        failureReason: "Stalled: no finalization after upload timeout",
      });
    }
    logger.info("sweep.audio.stalled_marked_failed", {
      id: upload.id,
      dryRun: input.dryRun,
    });
    result.audio.stalledMarkedFailed++;
  }

  // ── Audio: hard-delete expired soft-deletes ────────────────────────────
  const hardDeleteCutoff = new Date(
    now.getTime() - input.hardDeleteAfterDays * 24 * 60 * 60 * 1000,
  );
  const expiredAudio = await repos.audioUploads.listSoftDeleted({
    deletedBefore: hardDeleteCutoff,
    limit: input.limit,
  });

  for (const upload of expiredAudio) {
    if (!input.dryRun) {
      await repos.audioUploads.hardDelete(upload.id);
    }
    logger.info("sweep.audio.hard_deleted", {
      id: upload.id,
      dryRun: input.dryRun,
    });
    result.audio.hardDeleted++;
  }

  /**
   * Resolve every reference surface for a set of events into
   * `eventId → referenced image ids`.
   *
   * Throws if ANY surface cannot be read, so the caller keeps the whole page.
   * An event that yields a truncated body walk is reported via `unreadable` and
   * must also be kept — a partial reference set reads exactly like an empty one
   * and would authorize a delete.
   */
  async function resolveReferences(
    on: Pick<SweepOrphanedUploadsDeps["repos"], "events" | "eventEditSuggestions">,
    eventIds: string[],
  ): Promise<{
    referenced: Map<string, Set<string>>;
    unreadable: Set<string>;
  }> {
    const [mediaSets, suggestionFields] = await Promise.all([
      on.events.listMediaReferenceSets(eventIds),
      on.eventEditSuggestions.listPendingReferenceFields(eventIds),
    ]);

    const referenced = new Map<string, Set<string>>();
    const unreadable = new Set<string>();

    const idsFor = (eventId: string): Set<string> => {
      let set = referenced.get(eventId);
      if (!set) {
        set = new Set<string>();
        referenced.set(eventId, set);
      }
      return set;
    };

    for (const refSet of mediaSets) {
      const set = idsFor(refSet.eventId);
      if (refSet.heroImageId) set.add(refSet.heroImageId);
      for (const body of refSet.bodies) {
        const walked = collectReferencedImageIds(body);
        for (const id of walked.ids) set.add(id);
        if (walked.truncated) unreadable.add(refSet.eventId);
      }
    }

    // PENDING edit suggestions are the third reference surface. A
    // suggestion-borne upload is referenced ONLY here until a moderator
    // approves it — delete the blob and the suggestion can never be approved.
    // Walking `fields` wholesale picks up both `heroImageId` and any image ids
    // inside `content`.
    for (const row of suggestionFields) {
      // LOAD-BEARING, not a tidiness filter. `idsFor` creates a map entry on
      // demand, so without this guard a suggestion for an event whose
      // `listMediaReferenceSets` row was ABSENT would fabricate a reference set
      // for it. The caller would then see a resolved set (rather than the
      // "event unresolved" skip) and delete every image on that event not named
      // by a pending suggestion — with its hero FK and body never read at all.
      if (!referenced.has(row.eventId)) continue;
      const set = idsFor(row.eventId);
      const walked = collectReferencedImageIds(row.fields);
      for (const id of walked.ids) set.add(id);
      if (walked.truncated) unreadable.add(row.eventId);
    }

    return { referenced, unreadable };
  }

  /** Judge one page of candidates and, if anything is unreferenced, sweep it. */
  async function sweepImagePage(page: ImageRecord[]): Promise<{
    softDeleted: number;
    filesEnqueued: number;
    skipped: number;
    racedKept: number;
  }> {
    let skipped = 0;

    // Only EVENT-owned images are in scope: `request-event-image-upload` is the
    // sole creator of Image rows and always stamps ownerType EVENT. An owner
    // type we do not understand has no reference surface we know how to read,
    // so it is skipped rather than guessed at.
    const inScope: ImageRecord[] = [];
    for (const img of page) {
      if (img.ownerType === "EVENT") {
        inScope.push(img);
        continue;
      }
      logger.warn("sweep.image.skipped_unknown_owner_type", {
        id: img.id,
        ownerType: img.ownerType,
      });
      skipped++;
    }
    if (inScope.length === 0) {
      return { softDeleted: 0, filesEnqueued: 0, skipped, racedKept: 0 };
    }

    const eventIds = [...new Set(inScope.map((img) => img.ownerId))];

    let resolved: Awaited<ReturnType<typeof resolveReferences>>;
    try {
      resolved = await resolveReferences(repos, eventIds);
    } catch (err) {
      // A GC that cannot see references must not fall through to deleting.
      logger.error("sweep.image.reference_read_failed", {
        err,
        eventCount: eventIds.length,
      });
      deps.reportError?.(err, {
        tags: { job: "storage.sweep-orphaned-uploads" },
        extra: {
          eventCount: eventIds.length,
          skippedImages: inScope.length,
          effect: "image stage skipped — GC is blind this run",
        },
      });
      return {
        softDeleted: 0,
        filesEnqueued: 0,
        skipped: skipped + inScope.length,
        racedKept: 0,
      };
    }

    const deletionItems: EnqueuePendingObjectDeletionItem[] = [];
    const imageIds: string[] = [];
    const ownerByImageId = new Map<string, string>();
    // Per-image so the credit can be recomputed over exactly the rows that
    // actually commit — crediting bytes for an image the race check spared
    // would inflate the owner's free quota.
    const freedBytesByImage = new Map<
      string,
      { subject: EventStorageQuotaSubject | null; bytes: bigint }
    >();

    for (const img of inScope) {
      const referenced = resolved.referenced.get(img.ownerId);

      // The event did not come back. A live image row implies a live event
      // (the FK cascades), so this is an inconsistent read, not proof of an
      // orphan — keep the blob and count it.
      if (!referenced) {
        logger.warn("sweep.image.skipped_event_unresolved", {
          id: img.id,
          eventId: img.ownerId,
        });
        skipped++;
        continue;
      }

      // Body too deep to walk exhaustively — we cannot prove anything.
      if (resolved.unreadable.has(img.ownerId)) {
        logger.warn("sweep.image.skipped_reference_walk_truncated", {
          id: img.id,
          eventId: img.ownerId,
        });
        skipped++;
        continue;
      }

      if (referenced.has(img.id)) continue;

      imageIds.push(img.id);

      // Credit the image bytes back to the event owner. `ownerId` is the
      // authoritative event for an EVENT-owned image; `eventId` is the nullable
      // cascade FK and should agree.
      if (img.eventId && img.eventId !== img.ownerId) {
        logger.warn("sweep.image.owner_event_mismatch", {
          id: img.id,
          ownerId: img.ownerId,
          eventId: img.eventId,
        });
      }
      const subject = await resolveQuotaSubject(img.eventId ?? img.ownerId);
      freedBytesByImage.set(img.id, { subject, bytes: img.sizeBytes ?? 0n });

      if (img.key) {
        deletionItems.push({
          targetKey: img.key,
          targetKind: "KEY",
          source: "sweep_unreferenced_image",
          sourceId: img.id,
        });
      }
      ownerByImageId.set(img.id, img.ownerId);
    }

    if (imageIds.length === 0 || input.dryRun) {
      // Only reached for dryRun (or nothing to do): nothing commits, so log the
      // would-be deletions here.
      for (const id of imageIds) {
        logger.info("sweep.image.unreferenced_soft_deleted", {
          id,
          eventId: ownerByImageId.get(id),
          dryRun: true,
        });
      }
      return {
        softDeleted: imageIds.length,
        filesEnqueued: 0,
        skipped,
        racedKept: 0,
      };
    }

    // TOCTOU guard: the reference read above happened outside the tx, so an
    // organizer could have re-referenced one of these images in the meantime.
    // Re-read inside the tx and drop anything that became referenced. The
    // window is small; the loss it prevents is permanent.
    let committed = 0;
    let enqueued = 0;
    await repos.tx(async (tx) => {
      // Re-read ON THE TRANSACTION, not the pool: this must observe the tx's
      // snapshot, and acquiring a second pooled connection while holding an
      // interactive transaction risks pool-exhaustion deadlock.
      const fresh = await resolveReferences(tx, eventIds);
      const byId = new Map(inScope.map((c) => [c.id, c]));
      const stillUnreferenced = imageIds.filter((id) => {
        const img = byId.get(id)!;
        const refs = fresh.referenced.get(img.ownerId);
        if (!refs || fresh.unreadable.has(img.ownerId)) return false;
        return !refs.has(id);
      });
      if (stillUnreferenced.length === 0) return;

      const keep = new Set(stillUnreferenced);
      const items = deletionItems.filter(
        (i) => i.sourceId != null && keep.has(i.sourceId),
      );

      // Aggregate the credit over ONLY the rows this tx soft-deletes.
      const freedBytesBySubject = new Map<
        string,
        { subject: EventStorageQuotaSubject; bytes: bigint }
      >();
      for (const id of stillUnreferenced) {
        const freed = freedBytesByImage.get(id);
        if (freed) addFreedBytes(freedBytesBySubject, freed.subject, freed.bytes);
      }

      await tx.pendingObjectDeletions.enqueueMany(items);
      await tx.images.softDelete({ imageIds: stillUnreferenced, deletedAt: now });
      for (const { subject, bytes } of freedBytesBySubject.values()) {
        await incrementResourceUsage(tx, { ...subject, delta: -bytes });
      }
      // Logged HERE, not in the decision loop: an image the race check spared
      // must not leave a "deleted" line behind. These log lines are the audit
      // trail used to reconstruct what the GC actually removed.
      for (const id of stillUnreferenced) {
        logger.info("sweep.image.unreferenced_soft_deleted", {
          id,
          eventId: ownerByImageId.get(id),
          dryRun: false,
        });
      }
      committed = stillUnreferenced.length;
      enqueued = items.length;
    });

    const racedKept = imageIds.length - committed;
    if (racedKept > 0) {
      logger.warn("sweep.image.raced_reference_kept", {
        intended: imageIds.length,
        committed,
      });
    }

    return {
      softDeleted: committed,
      filesEnqueued: enqueued,
      skipped,
      racedKept,
    };
  }

  /**
   * Read the persisted resume point.
   *
   * TOLERANT BY DESIGN. A stored value we cannot parse — an older shape, a
   * hand-edited row, a future format — means "start from the beginning", never
   * an exception. A GC that crashes on its own bookkeeping stops collecting
   * entirely, and restarting the scan only costs one extra pass.
   */
  async function readStoredCursor(): Promise<{
    createdAt: Date;
    id: string;
  } | null> {
    let raw: unknown;
    try {
      raw = await repos.jobCursors.get(IMAGE_SWEEP_CURSOR_KEY);
    } catch (err) {
      logger.error("sweep.image.cursor_read_failed", { err });
      deps.reportError?.(err, {
        tags: { job: "storage.sweep-orphaned-uploads" },
        extra: { effect: "restarted scan from the oldest candidate" },
      });
      return null;
    }
    if (!raw || typeof raw !== "object") return null;

    const { createdAt, id } = raw as { createdAt?: unknown; id?: unknown };
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof createdAt !== "string" && !(createdAt instanceof Date)) {
      return null;
    }
    const parsed =
      createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (Number.isNaN(parsed.getTime())) return null;

    return { createdAt: parsed, id };
  }

  /** Persist the resume point. Never fails the run — worst case we rescan. */
  async function writeStoredCursor(
    next: { createdAt: Date; id: string } | null,
  ): Promise<void> {
    try {
      await repos.jobCursors.set(
        IMAGE_SWEEP_CURSOR_KEY,
        next ? { createdAt: next.createdAt.toISOString(), id: next.id } : null,
      );
    } catch (err) {
      logger.error("sweep.image.cursor_write_failed", { err, next });
      deps.reportError?.(err, {
        tags: { job: "storage.sweep-orphaned-uploads" },
        extra: { effect: "next run restarts from the oldest candidate" },
      });
    }
  }

  // ── Images: enqueue + soft-delete UNREFERENCED (paged) ─────────────────
  //
  // PAGED, and the paging is load-bearing. Referenced images are never
  // soft-deleted, so they remain candidates forever; a single unpaged
  // `take: limit` would return the same retained rows every night and every
  // newer orphan would stay invisible to the GC permanently. The keyset cursor
  // advances past what we keep.
  const imageCandidateCutoff = new Date(
    now.getTime() - input.unreferencedGracePeriodHours * 60 * 60 * 1000,
  );

  // Resume where the last run stopped. Without this the scan restarts at the
  // oldest candidate every night, and since retained images stay candidates
  // forever, everything past one run's page budget would never be examined by
  // ANY run — silently, with all-zero counters.
  let cursor = await readStoredCursor();
  const resumedFrom = cursor;
  let pagesScanned = 0;
  let reachedEnd = false;

  while (pagesScanned < input.maxPagesPerRun) {
    const page: ImageRecord[] = await repos.images.listSweepCandidates({
      createdBefore: imageCandidateCutoff,
      limit: input.limit,
      after: cursor,
    });
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }

    pagesScanned++;
    const last = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };

    const swept = await sweepImagePage(page);
    result.images.unreferencedSoftDeleted += swept.softDeleted;
    result.images.filesEnqueued += swept.filesEnqueued;
    result.images.skippedUnresolvable += swept.skipped;
    result.images.racedKept += swept.racedKept;

    // Persist after EVERY page, not just at the end: a run killed mid-pass
    // (Cloud Run timeout, deploy) would otherwise save nothing and the next
    // run would re-scan the identical pages — so a job that reliably dies at
    // page 40 would never advance past it. Progress must be monotonic.
    if (!input.dryRun) await writeStoredCursor(cursor);

    // A short page means we reached the end of the candidate set.
    if (page.length < input.limit) {
      reachedEnd = true;
      break;
    }
  }

  // Wrap to the start on a completed pass so newly-aged rows are picked up,
  // and so a cursor can never park permanently past the end of the table.
  if (!input.dryRun && reachedEnd) await writeStoredCursor(null);

  result.images.resumedFromCursor = resumedFrom !== null;
  result.images.completedFullPass = reachedEnd;

  if (!reachedEnd) {
    // Never let a bounded scan look like a completed one.
    logger.warn("sweep.image.page_budget_exhausted", {
      pagesScanned,
      maxPagesPerRun: input.maxPagesPerRun,
      resumeAfter: cursor,
    });
  }

  // ── Images: hard-delete expired ────────────────────────────────────────
  const expiredImages = await repos.images.listSoftDeleted({
    deletedBefore: hardDeleteCutoff,
    limit: input.limit,
  });

  for (const img of expiredImages) {
    if (!input.dryRun) {
      await repos.images.hardDelete(img.id);
    }
    logger.info("sweep.image.hard_deleted", {
      id: img.id,
      dryRun: input.dryRun,
    });
    result.images.hardDeleted++;
  }

  logger.info("sweep.orphaned_uploads.completed", result);
  return result;
}
