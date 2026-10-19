import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { Repos } from "@th/ports/repos";
import {
  MODERATION_QUEUE_HEALTH_SIGNALS,
  type ImageModerationRecord,
} from "@th/ports/repos/image-moderation-records";

import type { CountModerationQueueHealthInput } from "@th/ports/repos/image-moderation-records";
import type { ModerationQueueHealthSignal } from "@th/ports/repos/image-moderation-records";

import { parseInput } from "../../lib/io";
import { IMAGE_MODERATION_REJECT_DELETION_SOURCE } from "./_shared/moderation-deletion-source";
import { signalWithholdsContent } from "./_shared/ops-withholding";
import {
  deriveQueueHealthCutoffs,
  moderationQueueHealthWindowShape,
} from "./_shared/queue-health-window";

// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT `reportModerationQueueHealth`
//
// The hourly alert job and this page read the same five counts, and the obvious
// move is to have the page call the job's use case. That would be a bug, not a
// shortcut: `reportModerationQueueHealth` WRITES
// `PlatformSetting["moderation:queueHealthAlertState"]` as part of its
// edge-trigger gate. Every page load would overwrite the last-paged fingerprint
// and `sentAt` — so opening the ops page would reset the suppression window,
// and (worse) a healthy-looking read would CLEAR the row and re-arm an alert
// that had already fired. A human watching the dashboard would silently change
// who gets paged and when.
//
// So: these deps declare READ-ONLY repos and, specifically, NOT
// `platformSettings`. The line being drawn is about the alert state, not about
// repo count — `pendingObjectDeletions` was added later for the
// "rejected but not deleted" tile and is a pure `count`, which changes nothing
// about the property below. What must never appear here is the repo this page
// could WRITE the alert fingerprint through.
//
// Be precise about what the declaration buys — the transport passes the whole
// `ctx.repos` object into a `Pick<Repos, …>` slot, so the other repos are still
// reachable AT RUNTIME through a cast. The guarantee is therefore twofold and
// neither half is a sandbox:
//   1. TYPE-LEVEL: this file cannot reach `repos.platformSettings` without an
//      explicit cast, which is the thing a reviewer would catch.
//   2. TEST-LEVEL: `get-moderation-queue-snapshot.test.ts` runs both use cases
//      against a deps object whose `platformSettings` is a Proxy that THROWS on
//      any property read, so an added access fails loudly rather than silently
//      resetting the alert fingerprint.
// If a future edit needs settings here, that is the signal to stop and re-read
// this paragraph.
//
// Read-only throughout. Failures propagate — a swallow here would render an
// "all clear" ops page during exactly the outage the page exists to show, and
// per CLAUDE.md a swallow would also owe a `reportError` branch. Throwing is
// both simpler and more honest.
// ─────────────────────────────────────────────────────────────────────────────

export type ModerationQueueSnapshotDeps = {
  /**
   * Two READ-ONLY repos. `pendingObjectDeletions` joined `imageModerationRecords`
   * when the "rejected but not deleted" tile landed — see the block comment
   * above for why that widening is consistent with the containment rather than
   * a hole in it: the repo that must stay out is `platformSettings`, because it
   * is the one this page could WRITE through.
   */
  repos: Pick<Repos, "imageModerationRecords" | "pendingObjectDeletions">;
  clock: ClockPort;
};

/**
 * The drill-down takes NO clock.
 *
 * Structural, not stylistic: the list must be computed from the window the tile
 * was counted with, and the only way to guarantee that is to make a second
 * `now` unavailable. See {@link listModerationQueueSignal}.
 */
export type ListModerationQueueSignalDeps = {
  repos: Pick<Repos, "imageModerationRecords">;
};

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot (the tiles)
// ─────────────────────────────────────────────────────────────────────────────

export const getModerationQueueSnapshotInputSchema = z
  .object({
    ...moderationQueueHealthWindowShape,
    /**
     * Grace period before an undrained deletion intent counts as OVERDUE.
     *
     * A knob, not a constant, and NOT part of `moderationQueueHealthWindowShape`
     * — that shape is shared verbatim with the hourly alert job, and adding a
     * key there would silently widen what the job accepts for a number it has
     * no use for.
     *
     * Why a grace period at all: every freshly enqueued row has
     * `nextAttemptAt = now()`, so measuring "overdue" against `now` would count
     * the outbox's normal in-flight work and the tile would be loudest on the
     * days it is healthiest. 60m matches `pendingOverdueMinutes`' reasoning —
     * generous relative to the drain's schedule, so one missed tick is not an
     * incident.
     */
    deletionOverdueMinutes: z.number().int().positive().default(60),
  })
  .strict();

export type GetModerationQueueSnapshotInput = z.infer<
  typeof getModerationQueueSnapshotInputSchema
>;

const queueHealthCountsSchema = z
  .object({
    pendingOverdue: z.number().int().nonnegative(),
    awaitingReview: z.number().int().nonnegative(),
    degradedRecent: z.number().int().nonnegative(),
    degradedExhausted: z.number().int().nonnegative(),
    orphanedRecent: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The resolved knobs and the instants they produced, echoed back.
 *
 * This exists so the page can label a tile "Degraded (last 2h)" from DATA. A UI
 * that hardcodes "2h" is a lie the moment someone passes a different
 * `degradedWindowMinutes`, and it is the kind of lie nobody catches, because
 * the number still looks plausible.
 */
const queueHealthWindowSchema = z
  .object({
    thresholds: z
      .object({
        pendingOverdueMinutes: z.number().int().positive(),
        awaitingReviewHours: z.number().int().positive(),
        degradedWindowMinutes: z.number().int().positive(),
        maxRequeues: z.number().int().positive(),
      })
      .strict(),
    cutoffs: z
      .object({
        /** PENDING rows due before this are OVERDUE. */
        pendingDueBefore: z.date(),
        /** Unreviewed holds moderated before this are rotting. */
        moderatedBefore: z.date(),
        /** Degraded/ORPHANED resolutions at or after this are "happening now". */
        degradedSince: z.date(),
      })
      .strict(),
    /** When the snapshot was taken, from the injected clock. */
    observedAt: z.date(),
  })
  .strict();

/**
 * ALL-TIME counterparts to the two WINDOWED tiles.
 *
 * Sits beside `counts`, never merged into it. The five in `counts` are what the
 * hourly Discord alert pages about, predicate for predicate; these two are for
 * a human reading a dashboard. Keeping them in a separate object is what stops
 * a future edit from "tidying" a total into the alert's signal table, which the
 * type system would then compile-force into new alert copy and a new
 * fingerprint segment — i.e. a new thing that wakes someone up at 3am.
 *
 * Read them AGAINST the tiles. `awaitingReview: 0, awaitingReviewAll: 6` is the
 * common and previously invisible case: six images flagged this morning, none
 * yet 24h old, tile green, six people waiting.
 */
const queueTotalsSchema = z
  .object({
    /** Every un-reviewed content hold, any age. >= `counts.awaitingReview`. */
    awaitingReviewAll: z.number().int().nonnegative(),
    /** Every ORPHANED row, all time. >= `counts.orphanedRecent`. */
    orphanedAll: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The REJECT → deletion outbox, from the moderation side.
 *
 * A moderator REJECT writes the decision and enqueues the R2 object in ONE
 * transaction, which makes the enqueue reliable and says nothing about the
 * DRAIN. If the drain stalls or dead-letters, we have told an uploader their
 * image was removed while the bytes are still served from a public CDN — and
 * the moderation record reads REJECTED, which is true and beside the point.
 * Nothing surfaced this before.
 *
 * Self-contained on purpose: its cutoff lives HERE and not in the top-level
 * `cutoffs` object, because `cutoffs` is the thing the drill-down takes back
 * verbatim and it takes exactly three instants. Growing it would make a
 * caller's `{...snapshot.cutoffs}` fail `.strict()` on a schema that has no
 * business knowing about deletions.
 */
const deletionOutboxSchema = z
  .object({
    /**
     * Rows whose drain attempts are exhausted (`status = "DEAD"`). No
     * automation will ever retry these; the objects stay live until a human
     * acts.
     */
    dead: z.number().int().nonnegative(),
    /**
     * PENDING rows that came due before `dueBefore` and are still here. A
     * non-zero here with a zero `dead` usually means the drain job itself
     * stopped, which affects every producer at once — not just moderation.
     */
    overdue: z.number().int().nonnegative(),
    /** The absolute instant `overdue` was measured against. */
    dueBefore: z.date(),
    /** The knob that produced `dueBefore`, echoed so the UI can label itself. */
    overdueMinutes: z.number().int().positive(),
    /**
     * The `source` these counts are scoped to. Present in the payload so the
     * page can state plainly that this is the moderation slice of the outbox
     * and not the whole table — a count whose scope is only in a comment
     * eventually gets read as the other one.
     */
    source: z.literal(IMAGE_MODERATION_REJECT_DELETION_SOURCE),
  })
  .strict();

export const getModerationQueueSnapshotOutputSchema = queueHealthWindowSchema
  .extend({
    counts: queueHealthCountsSchema,
    totals: queueTotalsSchema,
    deletionOutbox: deletionOutboxSchema,
  })
  .strict();

export type GetModerationQueueSnapshotOutput = z.infer<
  typeof getModerationQueueSnapshotOutputSchema
>;

/**
 * Read-only snapshot of the five image-moderation queue-health counts, plus the
 * window that produced them.
 *
 * Same counts, same cutoffs, same defaults as the hourly Discord alert — and
 * none of its state. See the block comment at the top of this file for why that
 * separation is load-bearing.
 */
export async function getModerationQueueSnapshot(
  deps: ModerationQueueSnapshotDeps,
  rawInput: unknown = {},
): Promise<GetModerationQueueSnapshotOutput> {
  const input = parseInput(getModerationQueueSnapshotInputSchema, rawInput);
  const now = deps.clock.now();
  const cutoffs = deriveQueueHealthCutoffs(now, input);
  const deletionDueBefore = new Date(
    now.getTime() - input.deletionOverdueMinutes * 60_000,
  );

  // ONE `now`, four reads, issued together. Concurrency is not the reason —
  // consistency is: a sequential version would let the tiles and the totals be
  // computed minutes apart during a slow query, and "6 awaiting review, 4 in
  // total" is a number pair no operator can act on. Any failure propagates; a
  // swallow here would render an all-clear page during exactly the outage this
  // page exists to show.
  const [counts, totals, deletionOutbox] = await Promise.all([
    deps.repos.imageModerationRecords.countQueueHealth(cutoffs),
    deps.repos.imageModerationRecords.countQueueTotals(),
    deps.repos.pendingObjectDeletions.countOutboxHealth({
      dueBefore: deletionDueBefore,
      source: IMAGE_MODERATION_REJECT_DELETION_SOURCE,
    }),
  ]);

  return getModerationQueueSnapshotOutputSchema.parse({
    counts,
    totals,
    deletionOutbox: {
      ...deletionOutbox,
      dueBefore: deletionDueBefore,
      overdueMinutes: input.deletionOverdueMinutes,
      source: IMAGE_MODERATION_REJECT_DELETION_SOURCE,
    },
    ...describeWindow(now, input, cutoffs),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down (the rows behind one tile)
// ─────────────────────────────────────────────────────────────────────────────

export const moderationQueueSignalSchema = z.enum(
  MODERATION_QUEUE_HEALTH_SIGNALS,
);

/**
 * THE DRILL-DOWN TAKES ABSOLUTE CUTOFFS, NOT THE RELATIVE KNOBS.
 *
 * The first cut accepted `degradedWindowMinutes` etc. and re-derived the
 * cutoffs from a fresh `clock.now()`. That is a drift bug wearing the costume
 * of a convenience:
 *
 *   - The tile says 40 at 12:00:00. The operator clicks. The list is computed
 *     against a window that starts 40 seconds later and totals 37. Neither
 *     surface can say which number is right — the exact failure the shared
 *     `queueHealthWhere` refactor exists to eliminate, reintroduced one layer
 *     up.
 *   - Worse for pagination. `degradedRecent` / `orphanedRecent` select
 *     `moderatedAt >= degradedSince`, and the DESC cursor walks toward
 *     `degradedSince` — the end that MOVES. A row that was the page-1 cursor
 *     can fall out of the window before page 2 is asked for; Prisma's
 *     `cursor` + `skip: 1` then skips a row that is still legitimately in the
 *     set, and it is invisible (the page just shows one fewer row).
 *
 * So the caller passes back the `cutoffs` + `thresholds.maxRequeues` it already
 * holds from `getModerationQueueSnapshot`. This is never a burden on the page:
 * a drill-down is only reachable from a rendered tile, so the window is always
 * in hand. `getModerationQueueSnapshot` keeps the relative knobs — it is the
 * surface that HAS no prior window and must mint one.
 *
 * `z.coerce.date()` rather than `z.date()` so the schema accepts both a real
 * `Date` (the superjson tRPC path, which is how the page will call it) and an
 * ISO string (anything hand-rolled or JSON-only).
 */
export const listModerationQueueSignalInputSchema = z
  .object({
    /** Echo of `snapshot.cutoffs.pendingDueBefore`. */
    pendingDueBefore: z.coerce.date(),
    /** Echo of `snapshot.cutoffs.moderatedBefore`. */
    moderatedBefore: z.coerce.date(),
    /** Echo of `snapshot.cutoffs.degradedSince`. */
    degradedSince: z.coerce.date(),
    /** Echo of `snapshot.thresholds.maxRequeues`. */
    maxRequeues: z.number().int().positive(),
    signal: moderationQueueSignalSchema,
    limit: z.number().int().min(1).max(100).default(30),
    // `.nullable()` as well as `.optional()`, matching `listFlaggedImages`:
    // tRPC's `useInfiniteQuery` feeds `getNextPageParam`'s return straight back
    // in, and `nextCursor` is `string | null` — so the LAST page hands back
    // `null` and a non-nullable schema would 400 with `invalid_type`.
    cursor: z.string().min(1).nullable().optional(),
    // Also mirroring `listFlaggedImages`: `useInfiniteQuery` injects a
    // top-level `direction` on EVERY request, and `.strict()` would otherwise
    // reject the very first paginated load with `unrecognized_keys`. Allowed
    // and unused.
    direction: z.enum(["forward", "backward"]).optional(),
  })
  .strict();

export type ListModerationQueueSignalInput = z.infer<
  typeof listModerationQueueSignalInputSchema
>;

/**
 * The ops view of a moderation record.
 *
 * NO IMAGE URL, for any bucket. And for `awaitingReview` specifically, NO
 * `storageKey` AND NO `lastError` — those two omissions are the ones that
 * actually enforce anything, and each of them shipped late.
 *
 * WHY DROPPING `publicUrl` ALONE WAS THEATRE. The R2 adapter composes public
 * URLs by pure string join (`${publicBaseUrl}/${key}` —
 * `adapters/src/file-storage/cloudflare-r2/r2-adapter.ts`), and read-time
 * moderation gating is APP-side (`gate-image-visibility.ts`), not enforced at
 * the CDN. The public base URL is not a secret; it is in the `<img src>` of
 * every published event. So `storageKey` IS the image: a DEVELOPER with no
 * moderator role could read it off this list, join two strings, and view
 * un-reviewed flagged content — precisely what withholding `publicUrl` was
 * documented to prevent.
 *
 * WHY `lastError` GOES TOO, AND WHY "THE UI HIDES IT" WAS NOT ENOUGH. For one
 * release this field crossed the wire for `awaitingReview` and was suppressed
 * at render time by the page's `signalShowsLastError` helper. That is the same
 * defect as the `publicUrl` one wearing better clothes: the value is IN the
 * payload, so anyone who can call the procedure — which is every DEVELOPER,
 * moderator or not — reads it straight out of the network tab, and the only
 * thing standing in the way is client code we also ship. A control that lives
 * in the renderer is a decoration. `lastError` is unfiltered provider and
 * storage text attached to a specific un-reviewed hold; it is not as bad as the
 * key, and "not as bad" is not a category this file recognises.
 *
 * WHY ONLY THAT BUCKET. `awaitingReview` is the only one of the five whose rows
 * are un-reviewed CONTENT holds awaiting a human judgement. `pendingOverdue` is
 * un-scanned, `orphanedRecent` has no bytes left to fetch, and the two degraded
 * buckets are scanner failures — those are operational rows an engineer needs
 * to be able to identify AND diagnose in a bucket, so they keep both fields.
 * For the degraded buckets `lastError` is the entire point of the drill-down.
 *
 * The `awaitingReview` row still carries `kind`, `subjectType`, `subjectId` and
 * `moderatedAt` — enough to render "7 holds, oldest 4 days, 5 of them event
 * heroes", which is the whole operational question here. The page links to
 * `/moderate/images` for the actual review, behind the moderator gate.
 */
const moderationQueueSignalItemSchema = z
  .object({
    recordId: z.string(),
    /**
     * ABSENT for the `awaitingReview` bucket — see the docblock above. Present
     * for the other four. Typed optional rather than nullable so the key is
     * genuinely missing from the payload rather than present-and-empty.
     *
     * Withheld together with {@link lastError}, through one predicate. Keep
     * them adjacent.
     */
    storageKey: z.string().optional(),
    kind: z.enum(["EVENT_HERO", "AVATAR", "BANNER", "PAGE_MEDIA"]),
    status: z.enum(["PENDING", "APPROVED", "FLAGGED", "REJECTED", "ORPHANED"]),
    subjectType: z.enum(["EVENT", "HUMAN", "ORGANIZATION", "PLACE"]).nullable(),
    subjectId: z.string().nullable(),
    degraded: z.boolean(),
    /** How many times the degraded-requeue has revived this row. */
    requeues: z.number().int().nonnegative(),
    /** Failed drain attempts inside the CURRENT requeue window. */
    attempts: z.number().int().nonnegative(),
    /**
     * ABSENT for `awaitingReview`, exactly like {@link storageKey} and through
     * the same predicate.
     *
     * `.nullable().optional()`, and the pair is deliberate rather than sloppy:
     * NULLABLE because a row that has never failed genuinely has no error, and
     * OPTIONAL because a withheld field must be MISSING from the payload. If
     * withholding merely wrote `null`, "we are not telling you" and "there was
     * no error" would serialize identically, and a reader could not tell a
     * control from a fact — the same confusion `storageKey` avoids by being
     * optional instead of nullable.
     *
     * The consumer type is therefore `string | null | undefined`. That is a
     * real widening for the page and it is the honest shape.
     */
    lastError: z.string().nullable().optional(),
    moderatedAt: z.date().nullable(),
    nextAttemptAt: z.date(),
  })
  .strict();

export type ModerationQueueSignalItem = z.infer<
  typeof moderationQueueSignalItemSchema
>;

export const listModerationQueueSignalOutputSchema = z
  .object({
    signal: moderationQueueSignalSchema,
    items: z.array(moderationQueueSignalItemSchema),
    nextCursor: z.string().nullable(),
    /**
     * The window this page was selected with, echoed back VERBATIM from the
     * input. Not re-derived — the whole point of taking absolute cutoffs is
     * that there is nothing left to derive, so the page can assert that the
     * list it got back was computed against the tile it clicked.
     */
    cutoffs: z
      .object({
        pendingDueBefore: z.date(),
        moderatedBefore: z.date(),
        degradedSince: z.date(),
      })
      .strict(),
    maxRequeues: z.number().int().positive(),
  })
  .strict();

export type ListModerationQueueSignalOutput = z.infer<
  typeof listModerationQueueSignalOutputSchema
>;

function toSignalItem(
  record: ImageModerationRecord,
  signal: ModerationQueueHealthSignal,
): ModerationQueueSignalItem {
  // `base` is the payload MINUS everything withheld. Built by ADDING the
  // sensitive fields below rather than deleting them, so the withheld path is
  // the one that requires no action — a `delete` here would mean a newly added
  // sensitive field defaults to leaking.
  const base: ModerationQueueSignalItem = {
    recordId: record.id,
    kind: record.kind,
    status: record.status,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    degraded: record.degraded,
    requeues: record.requeues,
    attempts: record.attempts,
    moderatedAt: record.moderatedAt,
    nextAttemptAt: record.nextAttemptAt,
  };

  // `awaitingReview` rows are un-reviewed CONTENT holds. `storageKey` + the
  // (non-secret) public base URL reconstructs the image, and `lastError` is
  // unfiltered provider/storage text bound to that specific hold. Both are
  // withheld HERE, in the use case — not at the transport and emphatically not
  // in the renderer — so every caller of this use case inherits the control
  // rather than each one having to remember it. A field suppressed by client
  // code is still in the payload, and the payload is what a DEVELOPER with no
  // moderator role actually receives.
  //
  // The condition lives in `_shared/ops-withholding.ts` because the storage-key
  // LOOKUP has to apply the same rule from a record rather than a bucket, and a
  // lookup that echoes back what this list withholds defeats the control
  // entirely.
  //
  // ONE `if` for BOTH fields, on purpose: two conditions is how they drift, and
  // the drift is silent because each one still looks correct on its own.
  if (signalWithholdsContent(signal)) return base;

  return {
    ...base,
    storageKey: record.storageKey,
    lastError: record.lastError,
  };
}

function describeWindow(
  now: Date,
  input: z.infer<typeof getModerationQueueSnapshotInputSchema>,
  cutoffs: ReturnType<typeof deriveQueueHealthCutoffs>,
): z.infer<typeof queueHealthWindowSchema> {
  return {
    thresholds: {
      pendingOverdueMinutes: input.pendingOverdueMinutes,
      awaitingReviewHours: input.awaitingReviewHours,
      degradedWindowMinutes: input.degradedWindowMinutes,
      maxRequeues: input.maxRequeues,
    },
    cutoffs: {
      pendingDueBefore: cutoffs.pendingDueBefore,
      moderatedBefore: cutoffs.moderatedBefore,
      degradedSince: cutoffs.degradedSince,
    },
    observedAt: now,
  };
}

/**
 * The ROWS behind one snapshot tile.
 *
 * The window is identical to the one the tile counted because the CALLER HANDS
 * IT BACK — no clock is read here and no cutoff is derived here, so there is no
 * second `now` for the two surfaces to disagree about. Combine that with the
 * repo's single `queueHealthWhere` builder and the identity holds end to end:
 * the set listed is the set counted, by construction rather than by agreement
 * between two files.
 *
 * Same containment as the snapshot: `imageModerationRecords` only, no alert
 * state, read-only.
 */
export async function listModerationQueueSignal(
  deps: ListModerationQueueSignalDeps,
  rawInput: unknown,
): Promise<ListModerationQueueSignalOutput> {
  const input = parseInput(listModerationQueueSignalInputSchema, rawInput);

  const cutoffs: CountModerationQueueHealthInput = {
    pendingDueBefore: input.pendingDueBefore,
    moderatedBefore: input.moderatedBefore,
    degradedSince: input.degradedSince,
    maxRequeues: input.maxRequeues,
  };

  const page = await deps.repos.imageModerationRecords.listQueueHealthSignal({
    ...cutoffs,
    signal: input.signal,
    limit: input.limit,
    // `null` (the last page's `nextCursor`, fed straight back by
    // useInfiniteQuery) means "no cursor", same as absent.
    cursor: input.cursor ?? undefined,
  });

  return listModerationQueueSignalOutputSchema.parse({
    signal: input.signal,
    items: page.items.map((record) => toSignalItem(record, input.signal)),
    nextCursor: page.nextCursor,
    cutoffs: {
      pendingDueBefore: cutoffs.pendingDueBefore,
      moderatedBefore: cutoffs.moderatedBefore,
      degradedSince: cutoffs.degradedSince,
    },
    maxRequeues: cutoffs.maxRequeues,
  });
}
