import type {
  ClaimDueImageModerationsInput,
  CreateImageModerationRecordInput,
  ImageModerationCategoryScore,
  ImageModerationKind,
  ImageModerationRecord,
  ImageModerationRecordsRepo,
  ImageModerationStatus,
  ImageModerationSubjectType,
  ListFlaggedImageModerationsInput,
  ListQueueHealthSignalInput,
  MarkImageModerationFailedInput,
  MarkImageModerationOrphanedInput,
  RequeueDegradedModerationsInput,
  RequeueImageModerationForRescanInput,
  ResolveUnscannableImageModerationInput,
  CountModerationQueueHealthInput,
  CountModerationSeverityHistogramInput,
  ModerationQueueHealth,
  ModerationQueueHealthByKind,
  ModerationQueueHealthSignal,
  ModerationQueueTotals,
  ModerationSeverityBucket,
  MarkImageModerationResultInput,
  ReviewImageModerationInput,
} from "@th/ports/repos/image-moderation-records";
import { Prisma } from "@prisma/client";

import type { PrismaClientOrTx } from "./types";

type ImageModerationRow = {
  id: string;
  storageKey: string;
  kind: string;
  status: string;
  subjectType: string | null;
  subjectId: string | null;
  publicUrl: string | null;
  contentType: string | null;
  createdByHumanId: string | null;
  maxSeverity: number | null;
  categories: unknown;
  provider: string | null;
  degraded: boolean;
  moderatedAt: Date | null;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  requeues: number;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: ImageModerationRow): ImageModerationRecord {
  return {
    id: row.id,
    storageKey: row.storageKey,
    kind: row.kind as ImageModerationKind,
    status: row.status as ImageModerationStatus,
    subjectType: (row.subjectType as ImageModerationSubjectType | null) ?? null,
    subjectId: row.subjectId,
    publicUrl: row.publicUrl,
    contentType: row.contentType,
    createdByHumanId: row.createdByHumanId,
    maxSeverity: row.maxSeverity,
    categories:
      (row.categories as ImageModerationCategoryScore[] | null) ?? null,
    provider: row.provider,
    degraded: row.degraded,
    moderatedAt: row.moderatedAt,
    reviewedByHumanId: row.reviewedByHumanId,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
    attempts: row.attempts,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
    requeues: row.requeues,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * THE predicate for each of the five queue-health buckets. ONE definition,
 * used by both `countQueueHealth` (five COUNTs) and `listQueueHealthSignal`
 * (the drill-down page).
 *
 * These used to live inline in `countQueueHealth`. Adding a drill-down list
 * with its own copy of the same five WHEREs would have been the drift the
 * whole ops page exists to prevent: a tile saying 12 that opens a list of 9,
 * with neither surface able to say which one is lying. The `switch` is
 * exhaustive over `ModerationQueueHealthSignal` (which is `keyof
 * ModerationQueueHealth`), so a sixth count cannot be added to the health
 * shape without a predicate landing here — the `never` assignment below is
 * what turns that into a build failure rather than a runtime `undefined`.
 */
function queueHealthWhere(
  signal: ModerationQueueHealthSignal,
  input: CountModerationQueueHealthInput,
): Prisma.ImageModerationRecordWhereInput {
  switch (signal) {
    // Due to be drained, and wasn't. Means the drain job is not running —
    // note this deliberately does NOT look at `attempts`: a row legitimately
    // backing off has `next_attempt_at` in the FUTURE and is excluded.
    case "pendingOverdue":
      return {
        status: "PENDING",
        nextAttemptAt: { lte: input.pendingDueBefore },
      };
    // A genuine CONTENT hold nobody has decided. `degraded: false` is what
    // separates "a human needs to judge this" from "our scanner broke".
    case "awaitingReview":
      return {
        status: "FLAGGED",
        degraded: false,
        reviewedAt: null,
        moderatedAt: { lte: input.moderatedBefore },
      };
    // The scanner is failing right now.
    case "degradedRecent":
      return {
        status: "FLAGGED",
        degraded: true,
        moderatedAt: { gte: input.degradedSince },
      };
    // Burned the requeue cap: unscannable, and no automation will fix it.
    case "degradedExhausted":
      return {
        status: "FLAGGED",
        degraded: true,
        reviewedAt: null,
        requeues: { gte: input.maxRequeues },
      };
    // Objects that vanished out from under a live record. ORPHANED rows
    // appear on no other surface — not the queue, not the requeue job — so
    // this count is their ONLY operational signal. `moderatedAt` is the
    // resolution instant stamped by `markOrphaned`.
    case "orphanedRecent":
      return {
        status: "ORPHANED",
        moderatedAt: { gte: input.degradedSince },
      };
    default: {
      const unhandled: never = signal;
      throw new Error(`unhandled queue-health signal: ${String(unhandled)}`);
    }
  }
}

/**
 * Bucket-appropriate ordering for the drill-down.
 *
 * `pendingOverdue` is the odd one out on purpose: those rows have no
 * `moderatedAt` at all (nothing has moderated them — that IS the problem), and
 * the OLDEST `nextAttemptAt` is the interesting row because it dates the start
 * of the stall. The other four sort newest-decision-first like the moderator
 * queue. `id` is the tiebreak in both cases so the keyset cursor is stable.
 *
 * `nulls: "last"` is not decoration. `degradedExhausted` is the one bucket
 * whose predicate carries NO `moderatedAt` clause (it selects on `requeues >=
 * cap`), so a row with a null `moderatedAt` is selectable — and Postgres
 * `ORDER BY ... DESC` defaults to NULLS FIRST, which would float such a row to
 * the top of page one and then break keyset pagination against it. Every
 * writer of a FLAGGED row stamps `moderatedAt` today, so this is currently
 * unreachable; nothing ENFORCES that, and the cost of being right anyway is
 * one clause. (One writer does leave it null: `markOrphaned` with
 * `removedOnPurpose`, but that row is ORPHANED, never in this bucket.)
 *
 * Deliberately fixed in the ORDER BY and not in `queueHealthWhere`: that helper
 * is shared with `countQueueHealth`, so adding a not-null clause there would
 * silently change what the hourly Discord alert counts.
 */
function queueHealthOrderBy(
  signal: ModerationQueueHealthSignal,
): Prisma.ImageModerationRecordOrderByWithRelationInput[] {
  return signal === "pendingOverdue"
    ? [{ nextAttemptAt: "asc" }, { id: "asc" }]
    : [{ moderatedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }];
}

/**
 * THE "genuinely undecided again" reset. ONE definition.
 *
 * Three paths put a row back into the drain's to-do list — a re-upload to the
 * same key ({@link ImageModerationRecordsRepo.create}), the hourly degraded
 * requeue, and now an operator's manual re-scan — and each one must leave the
 * row in the SAME state. A half-cleared row is the nasty version of this bug:
 * the record claims PENDING while the moderator queue still renders a stale
 * severity and a stale reviewer, and nothing in either surface admits which of
 * the two is current.
 *
 * `requeues` is NOT here on purpose. It measures how many windows the
 * AUTOMATION has spent on an object and bounds its churn loop; `attempts`
 * measures failures inside one window. Only `requeueDegraded` touches
 * `requeues`, and it increments rather than resets.
 */
function rescanResetFields(now: Date) {
  return {
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    maxSeverity: null,
    categories: Prisma.JsonNull,
    provider: null,
    degraded: false,
    moderatedAt: null,
    reviewedByHumanId: null,
    reviewedAt: null,
    reviewNote: null,
  } satisfies Prisma.ImageModerationRecordUpdateInput;
}

/**
 * Rows a machine put here, and therefore the ONLY rows an operator re-scan may
 * touch. See `ImageModerationRecordsRepo.requeueForRescan`.
 *
 * The complement is the point: APPROVED, REJECTED, and FLAGGED with
 * `degraded = false` are all decisions a HUMAN made, and none of them is
 * reachable through this predicate. Expressed as an OR over three shapes rather
 * than `status: { in: [...] }` because the FLAGGED case is conditional on
 * `degraded` — a plain `in` list would sweep content holds in with scanner
 * failures, which is the exact mistake this guard exists to prevent.
 */
const RESCANNABLE_MACHINE_STATES: Prisma.ImageModerationRecordWhereInput = {
  OR: [
    { status: "PENDING" },
    { status: "ORPHANED" },
    { status: "FLAGGED", degraded: true },
  ],
};

/** The four known `kind` values, in a fixed order, for dense breakdowns. */
const IMAGE_MODERATION_KINDS: ImageModerationKind[] = [
  "EVENT_HERO",
  "AVATAR",
  "BANNER",
  "PAGE_MEDIA",
];

const ZERO_HEALTH = (): ModerationQueueHealth => ({
  pendingOverdue: 0,
  awaitingReview: 0,
  degradedRecent: 0,
  degradedExhausted: 0,
  orphanedRecent: 0,
});

export function makeImageModerationRecordsRepo(
  p: PrismaClientOrTx,
): ImageModerationRecordsRepo {
  return {
    async create(
      input: CreateImageModerationRecordInput,
    ): Promise<ImageModerationRecord> {
      const now = new Date();
      // Idempotent on storageKey: an existing record for the key is RESET to
      // PENDING (attempts 0, nextAttemptAt now) with the descriptive fields
      // refreshed and prior verdict/review fields cleared — this re-queues the
      // object for moderation on image replacement / re-upload to the same key.
      const row = await p.imageModerationRecord.upsert({
        where: { storageKey: input.storageKey },
        create: {
          storageKey: input.storageKey,
          kind: input.kind,
          status: input.status ?? "PENDING",
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          publicUrl: input.publicUrl ?? null,
          contentType: input.contentType ?? null,
          createdByHumanId: input.createdByHumanId ?? null,
        },
        update: {
          // The verdict/review clear + attempts/nextAttemptAt reset is shared
          // verbatim with `requeueForRescan` (see `rescanResetFields`) so the
          // two paths cannot drift into leaving a row half-decided.
          ...rescanResetFields(now),
          status: input.status ?? "PENDING",
          // The DESCRIPTIVE columns are refreshed here and NOT in the shared
          // helper: a re-upload may genuinely change them, an operator re-scan
          // of the same object must not.
          kind: input.kind,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          publicUrl: input.publicUrl ?? null,
          contentType: input.contentType ?? null,
          createdByHumanId: input.createdByHumanId ?? null,
        },
      });
      return toRecord(row as ImageModerationRow);
    },

    async getByKey(storageKey: string): Promise<ImageModerationRecord | null> {
      const row = await p.imageModerationRecord.findUnique({
        where: { storageKey },
      });
      return row ? toRecord(row as ImageModerationRow) : null;
    },

    async resolveByKeys(
      storageKeys: string[],
    ): Promise<Map<string, ImageModerationRecord>> {
      const map = new Map<string, ImageModerationRecord>();
      if (storageKeys.length === 0) return map;
      const rows = await p.imageModerationRecord.findMany({
        where: { storageKey: { in: storageKeys } },
      });
      for (const row of rows) {
        const record = toRecord(row as ImageModerationRow);
        map.set(record.storageKey, record);
      }
      return map;
    },

    async getById(id: string): Promise<ImageModerationRecord | null> {
      const row = await p.imageModerationRecord.findUnique({ where: { id } });
      return row ? toRecord(row as ImageModerationRow) : null;
    },

    async claimDue(
      input: ClaimDueImageModerationsInput,
    ): Promise<ImageModerationRecord[]> {
      const rows = await p.imageModerationRecord.findMany({
        where: {
          status: "PENDING",
          nextAttemptAt: { lte: input.now },
        },
        orderBy: { nextAttemptAt: "asc" },
        take: input.limit,
      });
      return rows.map((row) => toRecord(row as ImageModerationRow));
    },

    async markResult(input: MarkImageModerationResultInput): Promise<void> {
      // updateMany so a vanished row is a 0-row no-op (no P2025); idempotent
      // overwrite of the verdict fields.
      //
      // Scoped to still-PENDING rows to close the overlapping-drain clobber
      // race: a slow worker must NOT overwrite a human decision (a moderator's
      // FLAGGED→APPROVED/REJECTED transition) back to a machine verdict. This is
      // safe because every markResult caller runs on a still-PENDING row —
      // moderate-image only writes a verdict for a PENDING record, and the
      // drain's exhaustion dead-letter runs on a PENDING row too (markFailed
      // keeps status PENDING). Once a human (or a peer run) has moved the row
      // off PENDING, this write becomes a 0-row no-op.
      await p.imageModerationRecord.updateMany({
        where: { storageKey: input.storageKey, status: "PENDING" },
        data: {
          status: input.status,
          maxSeverity: input.maxSeverity,
          categories: input.categories as unknown as Prisma.InputJsonValue,
          provider: input.provider,
          degraded: input.degraded,
          moderatedAt: input.moderatedAt,
        },
      });
    },

    async markOrphaned(
      input: MarkImageModerationOrphanedInput,
    ): Promise<void> {
      // Terminal resolution for a record whose object is gone. Same PENDING-only
      // compare-and-set as markResult (never clobber a human decision or a peer
      // run), and the same updateMany-so-a-vanished-row-is-a-no-op posture.
      //
      // The verdict columns are left ALONE, not written: an orphan was never
      // scanned, so maxSeverity/categories/provider stay null and `degraded`
      // stays false. `degraded: false` also keeps the row out of
      // requeueDegraded's selection, which is the point — reviving a row whose
      // object cannot be fetched just burns another retry window.
      //
      // `attempts` is not incremented: this is a resolution, not a failed try.
      await p.imageModerationRecord.updateMany({
        where: { storageKey: input.storageKey, status: "PENDING" },
        data: {
          status: "ORPHANED",
          // A deliberate removal stays out of `orphanedRecent`, which counts
          // by `moderatedAt` (see MarkImageModerationOrphanedInput).
          moderatedAt: input.removedOnPurpose ? null : input.resolvedAt,
          lastError: input.lastError,
        },
      });
    },

    async markFailed(input: MarkImageModerationFailedInput): Promise<void> {
      // updateMany so a vanished row is a 0-row no-op (no P2025). Stays PENDING
      // for the next attempt.
      await p.imageModerationRecord.updateMany({
        where: { id: input.id },
        data: {
          attempts: { increment: 1 },
          lastError: input.lastError,
          nextAttemptAt: input.nextAttemptAt,
        },
      });
    },

    async requeueDegraded(
      input: RequeueDegradedModerationsInput,
    ): Promise<number> {
      // The WHERE is the safety property — see the port docblock. Every clause
      // is load-bearing:
      //   status FLAGGED      → never revives an APPROVED/REJECTED terminal row
      //   degraded true       → never revives a real CONTENT verdict
      //   reviewedAt null     → never undoes a human decision (defence in depth)
      //   requeues < cap      → bounds the churn loop for unscannable objects
      //   moderatedAt <= T    → don't fight the drain over a row still retrying
      //
      // `updateMany` rather than a read-then-write: the selection and the
      // mutation are one statement, so two overlapping runs of this job cannot
      // both revive the same row and double-count `requeues`.
      //
      // NOTE the deliberate absence of a `take` — Prisma's updateMany has no
      // limit. `input.limit` is enforced by the caller narrowing
      // `moderatedBefore`; the eligible set is bounded by the partial index and
      // is an outage artefact, so it is small by construction.
      const result = await p.imageModerationRecord.updateMany({
        where: {
          status: "FLAGGED",
          degraded: true,
          reviewedAt: null,
          requeues: { lt: input.maxRequeues },
          moderatedAt: { lte: input.moderatedBefore },
        },
        data: {
          status: "PENDING",
          // Genuinely undecided again — a half-cleared row would leave a stale
          // severity on display in the queue while the record claims PENDING.
          degraded: false,
          maxSeverity: null,
          moderatedAt: null,
          attempts: 0,
          lastError: null,
          nextAttemptAt: input.now,
          // NOT reset by the attempts clear above: `attempts` measures one
          // window, `requeues` measures how many windows we have spent.
          requeues: { increment: 1 },
        },
      });
      return result.count;
    },

    async countQueueHealth(
      input: CountModerationQueueHealthInput,
    ): Promise<ModerationQueueHealth> {
      // Five counts, not one grouped scan. They have different WHEREs (two of
      // them filter on `degraded`, one on `next_attempt_at`, one on
      // `reviewed_at`, one on a different `status` entirely), so a single
      // groupBy would need post-filtering in JS and would read rows this does
      // not. At the volume this table sees, five indexed COUNTs an hour is
      // free.
      //
      // The five WHEREs live in `queueHealthWhere` (module scope) so the
      // drill-down list selects with the exact same predicate this counts
      // with. Each branch's reasoning moved with it — read it there.
      const count = (signal: ModerationQueueHealthSignal) =>
        p.imageModerationRecord.count({ where: queueHealthWhere(signal, input) });

      const [
        pendingOverdue,
        awaitingReview,
        degradedRecent,
        degradedExhausted,
        orphanedRecent,
      ] = await Promise.all([
        count("pendingOverdue"),
        count("awaitingReview"),
        count("degradedRecent"),
        count("degradedExhausted"),
        count("orphanedRecent"),
      ]);

      return {
        pendingOverdue,
        awaitingReview,
        degradedRecent,
        degradedExhausted,
        orphanedRecent,
      };
    },

    async countQueueTotals(): Promise<ModerationQueueTotals> {
      // Deliberately NOT built from `queueHealthWhere`. These are the same two
      // buckets with their TIME CLAUSE REMOVED, and expressing that as "the
      // shared predicate minus a key" would make the shared predicate mutable
      // from here — one refactor away from changing what the hourly Discord
      // alert counts. Two small standalone WHEREs that can only ever be wrong
      // about themselves is the cheaper failure.
      //
      // The relationship that matters is an INEQUALITY, not an identity:
      // awaitingReviewAll >= awaitingReview and orphanedAll >= orphanedRecent,
      // always, because these drop a clause rather than add one. The adapter
      // integration test pins exactly that.
      const [awaitingReviewAll, orphanedAll] = await Promise.all([
        p.imageModerationRecord.count({
          where: { status: "FLAGGED", degraded: false, reviewedAt: null },
        }),
        p.imageModerationRecord.count({ where: { status: "ORPHANED" } }),
      ]);
      return { awaitingReviewAll, orphanedAll };
    },

    async countQueueHealthByKind(
      input: CountModerationQueueHealthInput,
    ): Promise<ModerationQueueHealthByKind> {
      // Five groupBys over the SAME `queueHealthWhere` predicates the tiles
      // count with, so a column can never disagree with the tile above it.
      // Five round trips rather than one because the five WHEREs genuinely
      // differ (two filter on `degraded`, one on `next_attempt_at`, one on
      // `reviewed_at`, one on a different `status`); a single grouped scan
      // would need post-filtering in JS over rows it had no business reading.
      const signals = [
        "pendingOverdue",
        "awaitingReview",
        "degradedRecent",
        "degradedExhausted",
        "orphanedRecent",
      ] as const satisfies readonly ModerationQueueHealthSignal[];

      const grouped = await Promise.all(
        signals.map((signal) =>
          p.imageModerationRecord.groupBy({
            by: ["kind"],
            where: queueHealthWhere(signal, input),
            _count: { _all: true },
          }),
        ),
      );

      const byKind = Object.fromEntries(
        IMAGE_MODERATION_KINDS.map((kind) => [kind, ZERO_HEALTH()]),
      ) as Record<ImageModerationKind, ModerationQueueHealth>;
      const unrecognizedKinds = ZERO_HEALTH();

      signals.forEach((signal, i) => {
        for (const row of grouped[i] ?? []) {
          // `kind` is an app-validated String, not a Prisma enum, so a value
          // outside the four is REPRESENTABLE in this table. Dropping such a
          // row would make the columns quietly fail to sum to the tile; it
          // goes in its own bucket instead, and the sum invariant holds.
          const bucket = (
            IMAGE_MODERATION_KINDS as string[]
          ).includes(row.kind)
            ? byKind[row.kind as ImageModerationKind]
            : unrecognizedKinds;
          bucket[signal] += row._count._all;
        }
      });

      return { byKind, unrecognizedKinds };
    },

    async countSeverityHistogram(
      input: CountModerationSeverityHistogramInput,
    ): Promise<ModerationSeverityBucket[]> {
      // `maxSeverity: { not: null }` is the "was actually SCANNED" clause.
      // Without it PENDING rows, orphans and freshly-requeued rows would all
      // land in a phantom null bucket and drag the distribution down — and the
      // question this answers is "is the review threshold in the right place",
      // which a null-inflated histogram answers wrongly.
      //
      // `gte` / `lt` (not `lte`) on the upper bound so two adjacent windows
      // never count the same row twice.
      const rows = await p.imageModerationRecord.groupBy({
        by: ["maxSeverity"],
        where: {
          maxSeverity: { not: null },
          moderatedAt: {
            gte: input.moderatedSince,
            lt: input.moderatedBefore,
          },
        },
        _count: { _all: true },
        orderBy: { maxSeverity: "asc" },
      });

      return rows.flatMap((row) =>
        // The `not: null` above makes this unreachable; keeping it a FILTER
        // rather than a `!` means a future WHERE change degrades to a missing
        // bucket instead of a `severity: null` that fails output parsing.
        row.maxSeverity === null
          ? []
          : [{ severity: row.maxSeverity, count: row._count._all }],
      );
    },

    async resolveUnscannable(
      input: ResolveUnscannableImageModerationInput,
    ): Promise<number> {
      // THE WHERE IS THE SAFETY PROPERTY — see the port docblock. Every clause
      // is load-bearing, and `degraded: true` is the one that keeps this from
      // becoming a backdoor around a moderator:
      //   status FLAGGED       → never touches a terminal APPROVED/REJECTED row
      //   degraded true        → NEVER a genuine content hold. A human decides
      //                          those, and only through `review`.
      //   reviewedAt null      → idempotent; a second click affects 0 rows
      //   requeues >= cap      → only rows automation has genuinely given up on
      //
      // `updateMany` rather than read-then-write: the eligibility check and the
      // mutation are ONE statement, so a moderator deciding this row
      // concurrently cannot lose the race to a stale read.
      //
      // Note what is NOT in `data`: `moderatedAt` (re-stamping it would make
      // this cleanup trip the `orphanedRecent` storage-fault alert), `degraded`
      // (it is the record of why the row is here, and ORPHANED already excludes
      // it from `requeueDegraded`), `attempts` and `requeues`.
      const { count } = await p.imageModerationRecord.updateMany({
        where: {
          id: input.id,
          status: "FLAGGED",
          degraded: true,
          reviewedAt: null,
          requeues: { gte: input.maxRequeues },
        },
        data: {
          status: "ORPHANED",
          reviewedByHumanId: input.resolvedByHumanId,
          reviewedAt: input.resolvedAt,
          reviewNote: input.note ?? null,
        },
      });
      return count;
    },

    async requeueForRescan(
      input: RequeueImageModerationForRescanInput,
    ): Promise<number> {
      // The guard IS this WHERE (`RESCANNABLE_MACHINE_STATES`), not a check in
      // the calling use case. `create` would happily reset an APPROVED or
      // REJECTED row — re-scanning a REJECTED image could put it back into
      // circulation — and a read-then-`create` guard leaves a TOCTOU window
      // against a moderator deciding the same row mid-flight. One statement,
      // and the human states are unreachable by construction.
      const { count } = await p.imageModerationRecord.updateMany({
        where: { id: input.id, ...RESCANNABLE_MACHINE_STATES },
        // Same reset `create` writes, from the same helper. Descriptive
        // columns are untouched: the object did not change, our reading of it
        // did.
        data: { ...rescanResetFields(input.now), status: "PENDING" },
      });
      return count;
    },

    async listQueueHealthSignal(input: ListQueueHealthSignalInput): Promise<{
      items: ImageModerationRecord[];
      nextCursor: string | null;
    }> {
      // Same keyset shape as `listFlagged` (opaque cursor = last row's id,
      // take limit+1 to detect more) and — critically — the SAME WHERE the
      // count used, from `queueHealthWhere`. `limit` is bounded at the
      // transport (`.max(100)`), exactly as `listFlagged`'s is.
      const rows = await p.imageModerationRecord.findMany({
        where: queueHealthWhere(input.signal, input),
        orderBy: queueHealthOrderBy(input.signal),
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

      return {
        items: page.map((row) => toRecord(row as ImageModerationRow)),
        nextCursor,
      };
    },

    async listFlagged(input: ListFlaggedImageModerationsInput): Promise<{
      items: ImageModerationRecord[];
      nextCursor: string | null;
    }> {
      // Keyset pagination over the flagged queue (newest moderatedAt first).
      // The opaque cursor is the last row's id; take limit+1 to detect more.
      const rows = await p.imageModerationRecord.findMany({
        where: { status: "FLAGGED" },
        orderBy: [{ moderatedAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor
          ? { cursor: { id: input.cursor }, skip: 1 }
          : {}),
      });

      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

      return {
        items: page.map((row) => toRecord(row as ImageModerationRow)),
        nextCursor,
      };
    },

    async review(input: ReviewImageModerationInput): Promise<number> {
      // CAS on status: only a currently-FLAGGED record transitions. Re-reviewing
      // a record that is no longer FLAGGED is a 0-row no-op. Return the affected
      // count so the caller fires the approve-after-hold notification ONLY on a
      // genuine FLAGGED→decision transition (1), not on a repeat (0).
      const { count } = await p.imageModerationRecord.updateMany({
        where: { id: input.id, status: "FLAGGED" },
        data: {
          status: input.status,
          reviewedByHumanId: input.reviewedByHumanId,
          reviewedAt: input.reviewedAt,
          reviewNote: input.reviewNote ?? null,
        },
      });
      return count;
    },
  };
}
