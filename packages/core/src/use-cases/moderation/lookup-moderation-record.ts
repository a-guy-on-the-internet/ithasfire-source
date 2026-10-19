import { z } from "zod";

import type { Repos } from "@th/ports/repos";
import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";

import { parseInput } from "../../lib/io";
import { isUnreviewedContentHold } from "./_shared/ops-withholding";

// ─────────────────────────────────────────────────────────────────────────────
// FIND ONE RECORD BY ITS STORAGE KEY.
//
// The operational case is narrow and real: a Sentry event, a CDN log line or a
// support ticket hands you a key like `events/<id>/hero.jpg`, and until now
// there was no way to ask the system what it thinks about that object short of
// paging through a bucket that may not even contain it.
//
// THE WITHHOLDING IS THE WHOLE DESIGN PROBLEM, AND THE FIRST CUT GOT THE THREAT
// MODEL BACKWARDS. This procedure is gated ADMIN/DEVELOPER like the rest of the
// ops surface, which admits people who are not moderators. The drill-down
// withholds `storageKey` for un-reviewed content holds because a key plus the
// (non-secret) public base URL reconstructs the image — so the first version of
// this file withheld `storageKey` and `lastError` here too and called it done.
//
// That protected nothing. THE CALLER ALREADY HAS THE KEY; supplying it is what
// a lookup IS. Withholding the one field they just typed while returning
// `status: "FLAGGED"`, `degraded: false`, `subjectType`, `subjectId` and
// `moderatedAt` handed over the actual disclosure: not the key, but the fact
// that THIS key is un-reviewed flagged content, on THAT event, held since THEN.
// A non-moderator with a key from a CDN log could confirm exactly what the
// drill-down exists to refuse, and the docblock said so in the same paragraph
// where the code did the opposite.
//
// So a content hold now returns its `recordId` and essentially nothing else —
// enough to hand to a moderator ("review record X at /moderate/images"), which
// is the only legitimate next action anyway.
//
// WHAT REMAINS, STATED HONESTLY RATHER THAN PAPERED OVER. `found: true` with a
// withheld body still signals "this key is a content hold". That residual is
// deliberate: the alternative is answering `found: false`, which would be a
// lie, and a lookup that lies about existence is worse than one that is clear
// about what it will not say. The residual is also BOUNDED — it discloses the
// existence of a hold and nothing about what is in the image, who uploaded it,
// what it scored, or what it is attached to.
//
// WHY THIS STAYS ADMIN/DEVELOPER AND IS NOT NARROWED TO ADMIN. The tool exists
// for a DEVELOPER holding a key from a Sentry report at 3am. Narrowing the gate
// would take it away from exactly that person for every operational case —
// PENDING, ORPHANED, degraded — where there is no content to protect and the
// full record is returned. Withholding per-RECORD keeps the tool useful where
// it matters and silent where it must be.
//
// `withheld` is returned rather than left implicit, and it now names EVERY
// suppressed field rather than the two the first cut happened to think of. A
// field that is simply absent is indistinguishable from a field that is null,
// and an operator who reads "no storage key" as "this record has no object"
// will chase the wrong thing for an hour.
// ─────────────────────────────────────────────────────────────────────────────

export type LookupModerationRecordDeps = {
  repos: Pick<Repos, "imageModerationRecords">;
};

export const lookupModerationRecordInputSchema = z
  .object({
    /**
     * The R2 object key, verbatim. Bounded because it is free text off an
     * operator's clipboard; 1024 is S3/R2's own key limit, so anything longer
     * cannot name a real object and is a paste accident.
     *
     * NOT sanitized. A storage key is matched EXACTLY against a unique column —
     * stripping characters would silently look up a different key and report
     * "not found" for an object that exists, which is a worse answer than an
     * empty result. Nothing here is rendered as markup; the transport's zod
     * output schema and the UI's escaping are the sinks.
     */
    storageKey: z.string().min(1).max(1024),
  })
  .strict();

export type LookupModerationRecordInput = z.infer<
  typeof lookupModerationRecordInputSchema
>;

/**
 * The drill-down's shape (`ModerationQueueSignalItem`), with every field that
 * could describe a held image made OPTIONAL.
 *
 * WHY MORE IS WITHHELD HERE THAN IN THE DRILL-DOWN. The drill-down's caller
 * arrived from a TILE, so it already knows the bucket — telling it that these
 * rows are un-reviewed holds is not news, and the fields that describe WHICH
 * event a hold belongs to are what make "7 holds, 5 of them event heroes"
 * renderable. A key lookup's caller knows nothing and is asking. Answering with
 * status + subject + timing is answering the question the control exists to
 * refuse. Same predicate (`isUnreviewedContentHold`), stricter consequence,
 * because the two surfaces disclose against different priors.
 *
 * The four fields that SURVIVE a withheld lookup, and why each is safe:
 *   - `recordId`      — an opaque id. The whole point: hand it to a moderator.
 *   - `kind`          — derivable from the key the caller already supplied
 *                       (`events/…/hero.jpg` is an EVENT_HERO by construction),
 *                       so it is not a marginal disclosure.
 *   - `requeues` / `attempts` — drain bookkeeping, and BOTH ARE ZERO for a
 *                       content hold by definition: the row scanned
 *                       successfully and was flagged on its verdict, not on a
 *                       failure. They carry no signal about the image.
 * `nextAttemptAt` goes, even though it is only a retry timestamp, because for a
 * decided row it correlates with when the image was uploaded.
 *
 * No `publicUrl` for anything, ever. Same as the drill-down.
 */
const lookupItemSchema = z
  .object({
    // ── Always present ──
    recordId: z.string(),
    kind: z.enum(["EVENT_HERO", "AVATAR", "BANNER", "PAGE_MEDIA"]),
    requeues: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),

    // ── ABSENT for an un-reviewed content hold ──
    //
    // Every one of these is OPTIONAL rather than nullable, without exception:
    // a withheld field must be MISSING from the payload, because `null` makes
    // "we are not telling you" and "there is nothing here" serialize
    // identically, and a reader cannot tell a control from a fact.
    // `lastError` is `.nullable().optional()` because it is ALSO legitimately
    // null on a row that never failed.
    storageKey: z.string().optional(),
    lastError: z.string().nullable().optional(),
    status: z
      .enum(["PENDING", "APPROVED", "FLAGGED", "REJECTED", "ORPHANED"])
      .optional(),
    subjectType: z
      .enum(["EVENT", "HUMAN", "ORGANIZATION", "PLACE"])
      .nullable()
      .optional(),
    subjectId: z.string().nullable().optional(),
    degraded: z.boolean().optional(),
    moderatedAt: z.date().nullable().optional(),
    nextAttemptAt: z.date().optional(),
  })
  .strict();

export type LookupModerationRecordItem = z.infer<typeof lookupItemSchema>;

/**
 * The fields suppressed for an un-reviewed content hold, reported per field.
 *
 * A TOTAL, `.strict()` object rather than a `string[]`, so the page can render
 * a "withheld" affordance per row without string-matching, and so adding a
 * withholdable field to the item is a compile error here rather than a silent
 * omission from the map. All seven move together — they are decided by ONE
 * predicate, and reporting them individually is about legibility, not about
 * them ever differing.
 */
const withheldSchema = z
  .object({
    storageKey: z.boolean(),
    lastError: z.boolean(),
    status: z.boolean(),
    subjectType: z.boolean(),
    subjectId: z.boolean(),
    degraded: z.boolean(),
    moderatedAt: z.boolean(),
    nextAttemptAt: z.boolean(),
  })
  .strict();

/** Nothing suppressed — a miss, or an operational row. */
const NOTHING_WITHHELD = {
  storageKey: false,
  lastError: false,
  status: false,
  subjectType: false,
  subjectId: false,
  degraded: false,
  moderatedAt: false,
  nextAttemptAt: false,
} as const;

/** Everything suppressible, suppressed — an un-reviewed content hold. */
const ALL_WITHHELD = {
  storageKey: true,
  lastError: true,
  status: true,
  subjectType: true,
  subjectId: true,
  degraded: true,
  moderatedAt: true,
  nextAttemptAt: true,
} as const;

export const lookupModerationRecordOutputSchema = z
  .object({
    /**
     * The key that was looked up, echoed back.
     *
     * Safe unconditionally: the caller already had it — that is what a lookup
     * IS — so echoing it discloses nothing. It is here so a stale or racing
     * response can be matched to the request that asked for it.
     */
    storageKey: z.string(),
    /** False when no record exists for the key. `item` is then null. */
    found: z.boolean(),
    item: lookupItemSchema.nullable(),
    /**
     * What was suppressed on `item`, field by field.
     *
     * All false for a miss and for every operational row. Reported explicitly
     * so the page can say "withheld — un-reviewed content hold, review it at
     * /moderate/images" instead of rendering a row of blank cells that reads
     * like missing data, or worse, like a record with no subject.
     */
    withheld: withheldSchema,
  })
  .strict();

export type LookupModerationRecordOutput = z.infer<
  typeof lookupModerationRecordOutputSchema
>;

/**
 * Look up one moderation record by R2 storage key.
 *
 * A MISS IS NOT AN ERROR. Absence is meaningful here and is the most likely
 * answer for a legacy object: read-time gating treats "no record" as APPROVED,
 * so `found: false` tells the operator the object is unmoderated and visible —
 * which is a finding, not a failure. Throwing `NOT_FOUND` would push that fact
 * through an error channel and the UI would render it as a fault.
 *
 * Read-only. Failures propagate.
 */
export async function lookupModerationRecord(
  deps: LookupModerationRecordDeps,
  rawInput: unknown,
): Promise<LookupModerationRecordOutput> {
  const input = parseInput(lookupModerationRecordInputSchema, rawInput);

  const record = await deps.repos.imageModerationRecords.getByKey(
    input.storageKey,
  );

  if (!record) {
    return lookupModerationRecordOutputSchema.parse({
      storageKey: input.storageKey,
      found: false,
      item: null,
      withheld: NOTHING_WITHHELD,
    });
  }

  const withhold = isUnreviewedContentHold(record);

  return lookupModerationRecordOutputSchema.parse({
    storageKey: input.storageKey,
    found: true,
    item: toLookupItem(record, withhold),
    // The SAME boolean that built the item. One decision, reported twice —
    // never two decisions that could disagree about what was actually sent.
    withheld: withhold ? ALL_WITHHELD : NOTHING_WITHHELD,
  });
}

function toLookupItem(
  record: ImageModerationRecord,
  withhold: boolean,
): LookupModerationRecordItem {
  // `base` is the WITHHELD payload — what a non-moderator gets for an
  // un-reviewed content hold. Built by ADDING the describing fields below
  // rather than deleting them, so the safe path is the one that requires no
  // action: a newly added field defaults to being withheld, not to leaking.
  // A `delete`-based version inverts that and is one forgotten line from a
  // disclosure.
  const base: LookupModerationRecordItem = {
    recordId: record.id,
    // Derivable from the key the caller supplied, and zero-by-definition for a
    // content hold — see the schema docblock for why these three stay.
    kind: record.kind,
    requeues: record.requeues,
    attempts: record.attempts,
  };

  if (withhold) return base;

  return {
    ...base,
    storageKey: record.storageKey,
    lastError: record.lastError,
    status: record.status,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    degraded: record.degraded,
    moderatedAt: record.moderatedAt,
    nextAttemptAt: record.nextAttemptAt,
  };
}
