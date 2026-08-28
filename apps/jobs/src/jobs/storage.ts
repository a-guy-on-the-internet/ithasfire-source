/**
 * Storage Cleanup Jobs
 *
 * Periodic sweep to clean up orphaned uploads:
 * - Audio files stuck in PENDING/UPLOADED (stalled transcodes)
 * - Images no event still references (not its hero, not in its body, not in a
 *   pending edit suggestion) — reachability is COMPUTED per run, never read
 *   off a stored flag; see sweepOrphanedUploads for why that distinction cost
 *   a customer their images
 * - Soft-deleted records past their retention period (hard-delete)
 *
 * Deletes both the DB records and the actual files from R2/MinIO.
 */
import { z } from "zod";
import { defineScheduledTask } from "../lib/define-job";
import { getSchedule } from "../lib/manifest";
import {
  sweepOrphanedUploads,
  sweepOrphanedUploadsInputSchema,
  drainPendingDeletions,
  drainPendingDeletionsInputSchema,
} from "@th/core/use-cases/storage";

// ─────────────────────────────────────────────────────────────────────────────
// storage.sweep-orphaned-uploads
// Runs nightly to clean up detached/stalled audio and image uploads.
// ─────────────────────────────────────────────────────────────────────────────

export const sweepOrphanedUploadsJob = defineScheduledTask({
  name: "storage.sweep-orphaned-uploads",
  description:
    "Clean up orphaned audio and image uploads: mark stalled transcodes as failed, " +
    "soft-delete images no longer referenced by their event's hero or body after a " +
    "grace period, hard-delete expired records, and enqueue their blobs into the " +
    "deletion outbox for the drain job to remove from R2/MinIO.",
  input: sweepOrphanedUploadsInputSchema,
  schedule: getSchedule("storage.sweep-orphaned-uploads"),
  handler: async ({ input, ctx }) => {
    const result = await sweepOrphanedUploads(
      {
        repos: {
          audioUploads: ctx.repos.audioUploads,
          images: ctx.repos.images,
          pendingObjectDeletions: ctx.repos.pendingObjectDeletions,
          events: ctx.repos.events,
          eventEditSuggestions: ctx.repos.eventEditSuggestions,
          // Cross-run resume point for the paged candidate scan.
          jobCursors: ctx.repos.jobCursors,
          tx: ctx.repos.tx,
        },
        logger: ctx.logger,
        clock: ctx.clock,
        reportError: ctx.reportError,
      },
      input,
    );
    ctx.logger.info("storage.sweep-orphaned-uploads.completed", result);
    return result;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// storage.drain-pending-deletions
// Drains the object-storage deletion outbox: deletes the keys/prefixes enqueued
// (in-transaction) by event deletes, with exponential backoff + dead-lettering.
// ─────────────────────────────────────────────────────────────────────────────

export const drainPendingDeletionsJob = defineScheduledTask({
  name: "storage.drain-pending-deletions",
  description:
    "Drain the object-storage (R2/MinIO) deletion outbox: delete the keys and " +
    "prefixes enqueued in-transaction by event deletes, retrying with " +
    "exponential backoff and dead-lettering rows that exhaust their attempts.",
  input: drainPendingDeletionsInputSchema,
  schedule: getSchedule("storage.drain-pending-deletions"),
  handler: async ({ input, ctx }) => {
    const result = await drainPendingDeletions(
      {
        repos: { pendingObjectDeletions: ctx.repos.pendingObjectDeletions },
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
        clock: ctx.clock,
      },
      input,
    );
    ctx.logger.info("storage.drain-pending-deletions.completed", result);
    return result;
  },
});

export const storageJobs = [sweepOrphanedUploadsJob, drainPendingDeletionsJob];
