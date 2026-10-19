// ── Image moderation records used by ImageModerationRecordsRepo ──
//
// One row per moderated public object, keyed by its R2 storage key. The row is
// BOTH the moderation verdict record AND its own drain outbox (status=PENDING is
// the to-do state a jobs-service worker claims). Read-time gating hides any
// object whose record is not APPROVED; the ABSENCE of a record (legacy objects)
// is treated as APPROVED. Mirrors the `ImageModerationRecord` Prisma model.

/**
 * Lifecycle status. Validated in app code (not a Prisma enum):
 * - "PENDING"  → due for the drain worker; hidden on public surfaces.
 * - "APPROVED" → clean; publicly visible.
 * - "FLAGGED"  → at/above threshold OR fail-closed degraded; held for a human.
 * - "REJECTED" → a moderator rejected it; object enqueued for deletion.
 * - "ORPHANED" → the record OUTLIVED its object: storage answered `not_found`,
 *   so there are no bytes to score and nothing to show. Terminal, machine-made,
 *   and deliberately NOT a human's problem — an ORPHANED row is invisible on
 *   public surfaces (the gate is APPROVED-only) and never enters the moderator
 *   queue, because asking a person to approve or reject an image that does not
 *   exist is not a decision anyone can make. Distinct from FLAGGED+degraded,
 *   which means "we could not SCAN bytes that do exist" and is genuinely worth
 *   retrying and, eventually, showing a human.
 */
export type ImageModerationStatus =
  | "PENDING"
  | "APPROVED"
  | "FLAGGED"
  | "REJECTED"
  | "ORPHANED";

/** Which public surface the moderated object serves. */
export type ImageModerationKind = "EVENT_HERO" | "AVATAR" | "BANNER" | "PAGE_MEDIA";

/** The owning entity type, for the queue's deep link + gating joins. */
export type ImageModerationSubjectType =
  | "EVENT"
  | "HUMAN"
  | "ORGANIZATION"
  | "PLACE";

/** Normalized, provider-agnostic moderation categories. */
export type ImageModerationCategory =
  | "SEXUAL"
  | "VIOLENCE"
  | "HATE"
  | "SELF_HARM";

/** A single per-category severity score from the provider. */
export interface ImageModerationCategoryScore {
  category: ImageModerationCategory;
  severity: number;
}

/** Mirrors the `ImageModerationRecord` Prisma model. */
export interface ImageModerationRecord {
  id: string;
  storageKey: string;
  kind: ImageModerationKind;
  status: ImageModerationStatus;
  subjectType: ImageModerationSubjectType | null;
  subjectId: string | null;
  publicUrl: string | null;
  contentType: string | null;
  createdByHumanId: string | null;
  maxSeverity: number | null;
  categories: ImageModerationCategoryScore[] | null;
  provider: string | null;
  degraded: boolean;
  moderatedAt: Date | null;
  reviewedByHumanId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  /** How many times the degraded-requeue has revived this row. Bounds churn. */
  requeues: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A moderation record to create. Idempotent on `storageKey`: creating for a key
 * that already has a record RESETS it to PENDING (attempts 0, nextAttemptAt now)
 * and refreshes the descriptive fields — this handles image replacement /
 * re-moderation. Defaults `status` to "PENDING".
 */
export interface CreateImageModerationRecordInput {
  storageKey: string;
  kind: ImageModerationKind;
  status?: ImageModerationStatus;
  subjectType?: ImageModerationSubjectType;
  subjectId?: string;
  publicUrl?: string;
  contentType?: string;
  createdByHumanId?: string;
}

export interface ClaimDueImageModerationsInput {
  now: Date;
  limit: number;
}

/**
 * Selection for the degraded-requeue. See `ImageModerationRecordsRepo.requeueDegraded`
 * — the four match clauses there are the safety property, not an optimisation.
 */
export interface RequeueDegradedModerationsInput {
  now: Date;
  limit: number;
  /**
   * Only requeue rows that dead-lettered at or before this instant. Keeps the
   * job from fighting the drain over a row that is still inside its retry
   * window, and gives an operator a way to requeue only an old outage.
   */
  moderatedBefore: Date;
  /**
   * Cap on `requeues`. A row at or above this stays FLAGGED for a human —
   * the terminal state for an object that can never be scanned.
   */
  maxRequeues: number;
}

/**
 * Cutoffs for the hourly queue-health count. All four are absolute instants
 * computed by the caller, so the repo does no clock arithmetic of its own.
 */
export interface CountModerationQueueHealthInput {
  /** PENDING rows due before this are OVERDUE — nothing is draining them. */
  pendingDueBefore: Date;
  /** Unreviewed content holds moderated before this are rotting in the queue. */
  moderatedBefore: Date;
  /**
   * Degraded verdicts at/after this instant indicate a LIVE scanner failure.
   * Reused as the window for `orphanedRecent` — both answer "is this happening
   * NOW", so a second cutoff would be two names for one question.
   */
  degradedSince: Date;
  /** `requeues` at/above this means we have given up trying to scan the object. */
  maxRequeues: number;
}

/**
 * Five independent failure signals. They are counted separately rather than
 * summed because they call for different responses: a dead drain is an incident,
 * a rotting hold is a moderator nudge, and an exhausted object is usually
 * garbage that should be deleted.
 */
export interface ModerationQueueHealth {
  /** PENDING and past due — the drain job is not running at all. */
  pendingOverdue: number;
  /** Genuine content holds no human has decided yet. */
  awaitingReview: number;
  /** Degraded verdicts written recently — the scanner is failing NOW. */
  degradedRecent: number;
  /** Degraded rows that burned the requeue cap — unscannable, needs a human. */
  degradedExhausted: number;
  /**
   * Rows resolved to ORPHANED recently — objects vanishing out from under live
   * moderation records.
   *
   * ORPHANED is terminal and invisible: the row leaves the review queue, leaves
   * the requeue selection, and no automation ever revisits it. That makes it
   * the one status with NO other operational surface — without this count it is
   * observable only in Sentry, and the August 2026 provider outage established
   * that Sentry alone is not a signal anyone acts on. A trickle is normal
   * (someone deleted an image). A spike means storage is lying to us.
   */
  orphanedRecent: number;
}

/**
 * ALL-TIME totals for the two signals whose health counts are WINDOWED.
 *
 * WHY THIS IS A SECOND METHOD AND NOT TWO MORE FIELDS ON
 * {@link ModerationQueueHealth}. Those five predicates are shared verbatim with
 * the hourly Discord alert (`report-moderation-queue-health.ts`) and with the
 * drill-down, through the adapter's single `queueHealthWhere` builder. Widening
 * that shape would change WHAT THE PLATFORM PAGES ABOUT — the signal table in
 * the alert use case is a TOTAL `Record` over `keyof ModerationQueueHealth`, so
 * a sixth key would compile-force new alert copy and a new fingerprint segment,
 * i.e. a new thing that wakes someone up. These totals are a comprehension aid
 * for a human reading a dashboard, not an alert. Separate method, separate
 * shape, no shared predicate.
 *
 * WHY THEY ARE NEEDED. `awaitingReview` counts only holds older than
 * `awaitingReviewHours` (24 by default) and `orphanedRecent` only the last
 * `degradedWindowMinutes`. Both tiles therefore read 0 while six images flagged
 * this morning wait on a human and the table holds thousands of orphans. A zero
 * that means "none in the last two hours" and a zero that means "none at all"
 * are different facts, and a tile showing one while an operator reads the other
 * is a comprehension trap, not a rounding error.
 */
export interface ModerationQueueTotals {
  /**
   * EVERY un-reviewed content hold, regardless of age — `status = "FLAGGED"`,
   * `degraded = false`, `reviewedAt IS NULL`, no `moderatedAt` clause.
   * Necessarily >= `ModerationQueueHealth.awaitingReview`.
   */
  awaitingReviewAll: number;
  /**
   * EVERY ORPHANED row, all time. Necessarily >=
   * `ModerationQueueHealth.orphanedRecent`. ORPHANED is terminal and nothing
   * ever removes these rows, so this number only grows — which is exactly why
   * it is worth showing beside a windowed count that keeps returning to zero.
   */
  orphanedAll: number;
}

/**
 * Per-`kind` split of the five queue-health signals.
 *
 * Counts are otherwise global, so `EVENT_HERO` failing to scan while `AVATAR`
 * is fine is invisible: one number moves and nothing says which surface is
 * broken. Implementations MUST derive each bucket from the SAME
 * `queueHealthWhere` predicate the totals use, so a breakdown can never drift
 * from the tile it sits under.
 */
export interface ModerationQueueHealthByKind {
  /** Dense over every {@link ImageModerationKind} — absent kinds are zeroed. */
  byKind: Record<ImageModerationKind, ModerationQueueHealth>;
  /**
   * Rows whose `kind` column is NOT one of the four known values.
   *
   * `kind` is an app-validated String, not a Prisma enum, so a typo'd or
   * retired value is representable in the table. Without this bucket the
   * per-kind columns would silently fail to sum to the tile above them, and the
   * discrepancy would look like a counting bug rather than a data-quality one.
   * `byKind` + `unrecognizedKinds` equals the global counts by construction.
   */
  unrecognizedKinds: ModerationQueueHealth;
}

/**
 * One severity bucket of the scanned-severity histogram: how many rows the
 * provider scored at exactly this integer severity.
 */
export interface ModerationSeverityBucket {
  /** Integer severity as written by the provider. Azure emits 0, 2, 4 or 6. */
  severity: number;
  count: number;
}

/**
 * Window for the severity histogram. ABSOLUTE instants, same convention as
 * {@link CountModerationQueueHealthInput} — the repo does no clock arithmetic.
 *
 * Counts only rows that were actually SCANNED (`maxSeverity IS NOT NULL`):
 * PENDING rows have no score yet, orphans never had bytes, and a requeue
 * clears the column, so every one of those would otherwise land in a phantom
 * "severity null" bucket and make the distribution read lower than it is.
 */
export interface CountModerationSeverityHistogramInput {
  /** Inclusive lower bound on `moderatedAt`. */
  moderatedSince: Date;
  /** EXCLUSIVE upper bound on `moderatedAt`, so adjacent windows never double-count. */
  moderatedBefore: Date;
}

/**
 * One of the five {@link ModerationQueueHealth} buckets, named so an operator
 * surface can drill from a COUNT into the ROWS that count covered.
 *
 * Derived from `keyof ModerationQueueHealth` rather than re-listed as a literal
 * union, for the same reason `report-moderation-queue-health.ts` types its
 * signal table as a TOTAL `Record` over the same keys: a sixth count added to
 * the health shape must not be able to exist without a drill-down predicate.
 * Because this alias widens automatically, the compile error lands where it is
 * useful — on the adapter's exhaustive `queueHealthWhere` switch, which cannot
 * return a `WhereInput` for a bucket nobody has written a predicate for.
 *
 * Current members: "pendingOverdue" | "awaitingReview" | "degradedRecent" |
 * "degradedExhausted" | "orphanedRecent".
 */
export type ModerationQueueHealthSignal = keyof ModerationQueueHealth;

/**
 * The five signals in the order an operator reads them — the same order
 * `QUEUE_HEALTH_SIGNALS` in `report-moderation-queue-health.ts` declares, which
 * is the order the alert copy and the alert fingerprint use. Exported as a
 * runtime tuple so transports can build an enum from it instead of re-typing
 * the strings.
 */
export const MODERATION_QUEUE_HEALTH_SIGNALS = [
  "pendingOverdue",
  "degradedRecent",
  "degradedExhausted",
  "orphanedRecent",
  "awaitingReview",
] as const satisfies readonly ModerationQueueHealthSignal[];

/**
 * Compile-time proof that the tuple above is TOTAL over the signal union, not
 * merely a subset of it. `satisfies` alone only proves every listed name is
 * valid; this proves every valid name is listed, so a sixth count breaks the
 * build here too rather than quietly becoming undrillable.
 *
 * TWO WRONG WAYS TO WRITE THIS, both of which compile green while proving
 * nothing — the first shipped here and was caught in review:
 *
 *   const _: MissingQueueHealthSignal[] = [];
 *     An EMPTY ARRAY LITERAL is assignable to any array type, `never[]`
 *     included. It type-checks whether the tuple is total or not.
 *
 *   type _ = MissingQueueHealthSignal extends never ? true : never;
 *     A bare conditional DISTRIBUTES over a naked type parameter, and
 *     distributing over `never` yields `never` without ever evaluating a
 *     branch — so the "missing" case silently resolves the same way as the
 *     "nothing missing" case.
 *
 * The tuple wrapper `[T] extends [never]` is what defeats distribution, and
 * assigning `true` to the `never` branch is what makes the failure an ERROR
 * rather than an unused type alias nobody reads.
 */
type MissingQueueHealthSignal = Exclude<
  ModerationQueueHealthSignal,
  (typeof MODERATION_QUEUE_HEALTH_SIGNALS)[number]
>;
const _everySignalIsListed: [MissingQueueHealthSignal] extends [never]
  ? true
  : never = true;
void _everySignalIsListed;

/**
 * Drill-down selection: the SAME cutoffs {@link CountModerationQueueHealthInput}
 * carries, plus which bucket to list and a page window. Sharing the cutoff
 * fields is deliberate — the list a tile links to must be the set that tile
 * counted, and the only way to guarantee that is to hand the repo one set of
 * instants and one predicate builder.
 */
export interface ListQueueHealthSignalInput
  extends CountModerationQueueHealthInput {
  signal: ModerationQueueHealthSignal;
  limit: number;
  /** Opaque cursor (the previous page's last row id). Same convention as `listFlagged`. */
  cursor?: string;
}

/** The verdict to write back onto a record after a provider call. */
export interface MarkImageModerationResultInput {
  storageKey: string;
  status: ImageModerationStatus;
  maxSeverity: number;
  categories: ImageModerationCategoryScore[];
  provider: string;
  degraded: boolean;
  moderatedAt: Date;
}

/**
 * Terminal resolution for a record whose object is GONE (storage answered
 * `not_found`). Carries no verdict fields on purpose: there were no bytes, so
 * `maxSeverity` / `categories` / `provider` stay null rather than being filled
 * with a fabricated severity just to satisfy
 * {@link MarkImageModerationResultInput}'s shape.
 */
export interface MarkImageModerationOrphanedInput {
  storageKey: string;
  /**
   * When we established the object was gone. Stamped on `moderatedAt`,
   * unless `removedOnPurpose`.
   */
  resolvedAt: Date;
  /** The storage error, kept for triage (`lastError`). */
  lastError: string;
  /**
   * The object was deleted on purpose before it was scanned (a place page
   * image nothing names any more; moderate-image.ts `isRemovedPageImage`).
   * `moderatedAt` is then left null, as `resolveUnscannable` leaves it, so
   * `orphanedRecent` (which counts ORPHANED rows by `moderatedAt`, and means
   * "storage answers gone for things that are not") does not count it.
   */
  removedOnPurpose?: boolean;
}

export interface MarkImageModerationFailedInput {
  id: string;
  lastError: string;
  nextAttemptAt: Date;
}

export interface ReviewImageModerationInput {
  id: string;
  status: "APPROVED" | "REJECTED";
  reviewedByHumanId: string;
  reviewedAt: Date;
  reviewNote?: string;
}

/**
 * OPERATOR ACTION: terminally resolve one unscannable row to ORPHANED.
 *
 * Everything here is a CAS input, not a data input — see
 * `ImageModerationRecordsRepo.resolveUnscannable` for why each clause is
 * load-bearing and what the write deliberately leaves alone.
 */
export interface ResolveUnscannableImageModerationInput {
  id: string;
  /**
   * The requeue cap the operator was LOOKING AT when they clicked.
   *
   * Passed rather than defaulted so the eligibility the button promised is the
   * eligibility the UPDATE enforces. If the page rendered `degradedExhausted`
   * against a cap of 3 and the repo quietly used its own 5, the action would
   * refuse rows the operator can plainly see in the list — an "it does nothing"
   * bug with no error to read.
   */
  maxRequeues: number;
  /** The operator. Stamped on `reviewedByHumanId`. */
  resolvedByHumanId: string;
  /** When they resolved it. Stamped on `reviewedAt`, NOT on `moderatedAt`. */
  resolvedAt: Date;
  /** Optional operator note, stamped on `reviewNote`. */
  note?: string;
}

/**
 * OPERATOR ACTION: send one row back to PENDING for a re-scan.
 *
 * Carries no status: the ELIGIBLE statuses are fixed in the implementation's
 * WHERE (see `ImageModerationRecordsRepo.requeueForRescan`) precisely so no
 * caller can widen them.
 */
export interface RequeueImageModerationForRescanInput {
  id: string;
  /** Stamped on `nextAttemptAt` so the drain picks it up on its next tick. */
  now: Date;
}

export interface ListFlaggedImageModerationsInput {
  limit: number;
  cursor?: string;
}
