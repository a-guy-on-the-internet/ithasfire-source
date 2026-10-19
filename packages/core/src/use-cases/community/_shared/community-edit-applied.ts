import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  CommunityEditableFieldValues,
  EventRecord,
} from "@th/ports/repos/events";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import {
  heldDatesOwnerOf,
  settleHeldDatesForEvent,
  type SettleHeldDatesForEventResult,
} from "../../booking-holds/settle-held-dates-for-published-event";
import {
  computeMaterial,
  GEO_GROUP_FIELDS,
  PLACE_LINK_FIELD,
  SCHEDULE_GROUP_FIELDS,
} from "../../events/_shared/suggestion-fields";
import { reindexAfterMutation } from "../../search/reindex-after-mutation";
import { markForSearchReindex } from "../../search/search-reindex-marks";
import { serializeSuggestionFields } from "./suggestion-validation";

/**
 * THE POST-APPLY PIPELINE for a whitelisted community edit — everything a
 * write through `tx.events.applyCommunityEdit` owes once it lands on a row.
 *
 * IT HAS TWO HALVES, because two of the four obligations cannot share a
 * moment:
 *
 * IN-TRANSACTION (this function, called with `tx`):
 *  1. FR-018 hold settlement when a PUBLISHED event's start moves;
 *  2. the FR-008/FR-013 `event_edit.applied` AuditLog row (before/after per
 *     field + the material marker) — this row IS the version history;
 *  3. the FR-013 transactional change-notice outbox, one notice per changed
 *     material GROUP.
 *
 * AFTER COMMIT (the {@link CommunityEditPostCommit} this function RETURNS):
 *  4. the best-effort incremental search reindex, so a title/venue/schedule
 *     change on a live listing stops serving stale the moment it is saved
 *     instead of at the next nightly `search.full-reindex`.
 *
 * ## Why it is one function and not two copies
 *
 * TWO callers apply the same whitelisted diff to the same rows:
 *
 *  - `reviewEventEditSuggestion` — a moderator APPROVES a public proposal;
 *  - `updateCommunityListing`    — a moderator edits the listing DIRECTLY.
 *
 * They differ only in how the diff was authored. Everything downstream of the
 * write is identical, and the cost of letting the two drift is specific and
 * expensive: the copy that loses a branch stops telling RSVPers that the event
 * they are going to has moved, or stops telling search that the venue changed.
 * A silently-missing notice or a silently-missing reindex has no error, no
 * failed test and no Sentry event — it is only visible as attendees turning up
 * at the old venue. So the pipeline lives here, once, and both callers run it.
 *
 * ## Why the reindex is a RETURNED FUNCTION and not a fourth step inline
 *
 * Indexing must never happen inside the transaction: it would publish rows the
 * tx may still roll back, and a slow or failing search backend would hold row
 * locks and could fail an edit that deserved to succeed. But the DECISION —
 * whether to reindex at all, and which document — must stay here, or the third
 * caller to arrive re-derives it and gets it wrong.
 *
 * So this function decides, and hands back a closure that carries the decision
 * to the other side of the commit. The caller cannot quietly drop it: the
 * closure's RETURN VALUE is the FR-018 settlement result, which is the only
 * way to get the booking-hold notification intents the caller owes on its
 * output. Skipping the dispatch is not an omission you can make and still
 * compile into a working edit path. (`community-edit-reindex.test.ts` pins the
 * same rule statically, for a hypothetical caller that wants no intents.)
 *
 * ## Caller contract
 *
 * Call INSIDE the caller's `repos.tx`, IMMEDIATELY AFTER
 * `tx.events.applyCommunityEdit` returns, and BEFORE any status/claim write
 * the caller owes. Ordering is load-bearing in both directions:
 *
 *  - AFTER the apply, because {@link settleHeldDatesForEvent} must see the row
 *    the tx will commit (the moved start is what picks the lines to take);
 *  - BEFORE the caller's own bookkeeping, because an open challenge on the new
 *    line throws out of the settle and must roll the whole edit back with
 *    nothing marked reviewed.
 *
 * Then call the returned `postCommit` exactly ONCE, AFTER `repos.tx` resolves.
 *
 * A no-op when `applied` is empty (an all-conflicted APPROVE writes nothing:
 * no settle, no audit row, no notice, no reindex).
 */
export type RecordCommunityEditAppliedArgs = {
  /**
   * The event row as it was BEFORE the apply. Supplies the pre-edit status
   * (only a PUBLISHED event settles held dates), the pre-edit start (the
   * "did it actually move" comparison), the owner the settle re-checks, and
   * the title the change-notice payload carries.
   */
  before: EventRecord;
  /**
   * The row `applyCommunityEdit` returned — the post-edit state the settle
   * reads its calendar + start from.
   */
  after: EventRecord;
  /**
   * The diff that ACTUALLY applied (post-conflict-filtering on the suggestion
   * path; the whole parsed diff on the direct path). Parsed values, Dates as
   * Dates — serialization for the Json columns happens here.
   */
  applied: CommunityEditableFieldValues;
  /**
   * Snapshot of the event's whitelisted fields BEFORE the apply
   * (`snapshotSuggestionBase`), read inside the same tx. Supplies the `before`
   * half of each audited change.
   */
  beforeSnapshot: Record<string, unknown>;
  actorHumanId: string;
  now: Date;
  /**
   * WHICH KIND OF EDIT THIS WAS, and the one field that distinguishes them on
   * the audit row:
   *
   *  - a suggestion id → a moderator approved somebody else's proposal;
   *  - `null`          → a moderator changed the listing directly.
   *
   * Always written (never omitted) so an `event_edit.applied` row is never
   * ambiguous about its provenance: a reader testing `suggestionId === null`
   * gets a definite answer instead of "the key is missing, so this row is
   * either a direct edit or predates the distinction".
   */
  suggestionId: string | null;
  /**
   * FR-009 fields skipped because the event drifted since the suggestion's
   * base version. Always empty on the direct path — a direct edit has no base
   * version to drift from; the moderator is looking at the row.
   */
  conflictedFields: readonly string[];
  /**
   * The CALLING use case's name, used only to tag the post-commit reindex's
   * logs and Sentry reports so a drifting index can be traced back to the edit
   * path that caused it (`reviewEventEditSuggestion` vs
   * `updateCommunityListing`).
   */
  useCaseName: string;
  /**
   * A change to the listing's place link (`Event.placeId`), when this edit
   * made one. Moderator direct edit only — the suggestion path never sets it.
   * Recorded as the `placeId` entry of the audit `changes` (version
   * history). NOT material by itself: `venueMoved` decides (true for a move
   * from one place to another, even at the same address).
   * Absent = the link did not change.
   */
  placeIdChange?: { before: string | null; after: string | null };
  /**
   * Moderator direct edit only: whether the venue changed
   * (`addressVenueChanged`: the pin moved more than 50 m, a pin appeared or
   * disappeared, or the street line differs; a same-place re-sync uses the
   * pin alone; a move from one place to another is always true), for a place
   * link and for a typed address edit alike. When
   * given, it REPLACES the name-based rule for the address/geo group — the
   * edit is venue-material, and sends VENUE_CHANGED, only if this is true;
   * address text naming the same street line (formatting, a corrected
   * postcode) is written and audited but tells no one. Absent (the
   * suggestion path, or an address edit the pin cannot speak for) = the
   * name-based rule, unchanged. Schedule materiality is never affected.
   */
  venueMoved?: boolean;
  /**
   * Extra columns this edit changed outside the whitelisted diff (the
   * location-privacy reset a place link applies), recorded in the audit
   * `changes` with before/after. Never material.
   */
  additionalChanges?: Record<string, { before: unknown; after: unknown }>;
};

/**
 * Runtime deps the post-commit half needs. Deliberately NOT the tx repos:
 * everything here runs against the committed row, through the caller's
 * non-transactional `deps.repos`.
 */
export type CommunityEditPostCommitDeps = {
  repos: Repos;
  clock: ClockPort;
  /**
   * Best-effort incremental search-index update. No-ops when omitted (the
   * nightly `search.full-reindex` still reconciles), which is what keeps every
   * test and script that has no search port working unchanged.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /**
   * ReporterPort convention. The reindex is fire-and-forget, so its failure
   * reaches no tRPC/fastify backstop; `reindexAfterMutation` owns the swallow
   * AND the `reportError` call inside it, and this is the thread that keeps
   * that swallow visible instead of silent. Thread it from `ctx.reportError`.
   */
  reportError?: ReporterPort;
};

/**
 * The other half of the pipeline, to be run once the caller's transaction has
 * COMMITTED. Fires the search reindex and hands back the FR-018 settlement
 * result the caller puts on its output.
 */
export type CommunityEditPostCommit = (
  deps: CommunityEditPostCommitDeps,
) => SettleHeldDatesForEventResult | null;

/**
 * The post-commit half for a path that applied NOTHING — a REJECT, an
 * all-conflicted APPROVE, a DRAFT save. Nothing was written, so there is
 * nothing to index and no line was taken.
 *
 * Exported so those branches can be explicit about owing nothing rather than
 * leaving a `postCommit` off the shape and reopening the hole this structure
 * closes.
 */
export const noCommunityEditPostCommit: CommunityEditPostCommit = () => null;

export type RecordCommunityEditAppliedResult = {
  /** The applied field names, in whitelist order. */
  appliedFieldNames: string[];
  /** Whether the applied diff is material to attendees (FR-013). */
  material: boolean;
  /**
   * RUN THIS ONCE THE TRANSACTION HAS COMMITTED — see the module doc.
   *
   * It fires the incremental search reindex and RETURNS the FR-018 settlement
   * result (null when no PUBLISHED start moved). The caller puts that result's
   * `intents` / `staffRecipientHint` on its output for transport to dispatch.
   * The settlement result is deliberately reachable ONLY through here, so a
   * caller that wants it cannot also skip the reindex.
   */
  postCommit: CommunityEditPostCommit;
};

export async function recordCommunityEditApplied(
  tx: TxRepos,
  args: RecordCommunityEditAppliedArgs,
): Promise<RecordCommunityEditAppliedResult> {
  const appliedFieldsJson = serializeSuggestionFields(args.applied);
  if (args.placeIdChange) {
    appliedFieldsJson[PLACE_LINK_FIELD] = args.placeIdChange.after;
  }
  const appliedFieldNames = Object.keys(appliedFieldsJson);
  const additionalChanges = args.additionalChanges ?? {};
  if (
    appliedFieldNames.length === 0 &&
    Object.keys(additionalChanges).length === 0
  ) {
    return {
      appliedFieldNames,
      material: false,
      postCommit: noCommunityEditPostCommit,
    };
  }

  const { before, after, applied, now } = args;

  // ── FR-018: a schedule move on a PUBLISHED event takes its lines ─────────
  // The same take the direct save path does, inside this tx, so an open
  // challenge on the new line refuses the whole edit with nothing committed.
  // A no-op without a calendar; a title-only edit never reaches it; a DRAFT
  // (pencil-in) never reaches it.
  let heldDates: SettleHeldDatesForEventResult | null = null;
  const startsMoved =
    applied.startsAt !== undefined &&
    applied.startsAt.getTime() !== before.startsAt.getTime();
  if (before.status === "PUBLISHED" && startsMoved) {
    heldDates = await settleHeldDatesForEvent(tx, {
      event: after,
      now,
      actorHumanId: args.actorHumanId,
      owner: heldDatesOwnerOf(before),
    });
  }

  // ── FR-008/FR-013: the applied AuditLog row IS the version history ───────
  // before/after per changed field + the material marker + the provenance
  // marker (`suggestionId`).
  const scheduleChanged = appliedFieldNames.some((field) =>
    (SCHEDULE_GROUP_FIELDS as readonly string[]).includes(field),
  );
  const venueChanged =
    args.venueMoved ??
    appliedFieldNames.some((field) =>
      (GEO_GROUP_FIELDS as readonly string[]).includes(field),
    );
  // Without the place-link override this is exactly `computeMaterial`
  // (schedule + address/geo by name), as before.
  const material =
    args.venueMoved === undefined
      ? computeMaterial(appliedFieldNames)
      : scheduleChanged || venueChanged;
  const changes: Record<string, { before: unknown; after: unknown }> = {
    ...additionalChanges,
  };
  for (const field of appliedFieldNames) {
    changes[field] = {
      before:
        field === PLACE_LINK_FIELD
          ? (args.placeIdChange?.before ?? null)
          : (args.beforeSnapshot[field] ?? null),
      after: appliedFieldsJson[field] ?? null,
    };
  }

  await tx.audit.log({
    entity: "event",
    entityId: before.id,
    action: "event_edit.applied",
    data: {
      suggestionId: args.suggestionId,
      actorHumanId: args.actorHumanId,
      changes,
      material,
      conflictedFields: [...args.conflictedFields],
    },
    at: now,
  });

  // ── FR-013: transactional change-notice outbox for material edits ────────
  // One notice per changed GROUP, written in THIS tx so the notification
  // intent commits atomically with the applied edit — a separate drain job
  // parses each payload and tells RSVPers/savers. Non-material applies
  // (title, content, category, hero, ageLimit, timezone) write no notice.
  //
  // A single edit that moves BOTH the schedule AND the venue is two distinct
  // semantic changes to an attendee, so it writes TWO notices (RESCHEDULED +
  // VENUE_CHANGED) rather than collapsing to one — otherwise the venue move
  // would never be communicated.
  if (material) {
    // Schedule fields conflict-group as a whole, so an applied schedule change
    // carries BOTH bounds; still fall back to the event's current values
    // defensively (and for a geo-only VENUE_CHANGED, where no schedule field
    // applied, both fall back to the current schedule).
    const newStartsAt = applied.startsAt ?? before.startsAt;
    const newEndsAt = applied.endsAt ?? before.endsAt;
    const payload = {
      eventTitle: before.title,
      newStartsAt: newStartsAt ? newStartsAt.toISOString() : null,
      newEndsAt: newEndsAt ? newEndsAt.toISOString() : null,
    };
    if (scheduleChanged) {
      await tx.eventChangeNotices.create({
        eventId: before.id,
        changeType: "RESCHEDULED",
        payload,
      });
    }
    if (venueChanged) {
      await tx.eventChangeNotices.create({
        eventId: before.id,
        changeType: "VENUE_CHANGED",
        payload,
      });
    }
  }

  // ── The post-commit half: the incremental search reindex ─────────────────
  // NOT fired here. This runs inside `tx`, and indexing a row the tx may still
  // roll back would publish an edit that never happened — while a slow search
  // backend would hold this row's locks for the length of an HTTP call. The
  // DECISION lives here (that is the whole point of the shared unit); only the
  // CALL is deferred to the caller's post-commit dispatch.
  //
  // NOT gated on `material`. That flag answers "do attendees need to be told",
  // which is a different question from "did a searchable field change": a
  // title-only edit is non-material AND fully searchable, so gating on it
  // would leave the single most common edit serving a stale title.
  //
  // Gated on PUBLISHED because that is the whole of the index —
  // `buildSearchIndex` upserts PUBLISHED events and REMOVES everything else,
  // so reindexing a DRAFT would spend an HTTP round-trip deleting a document
  // that was never written. `applyCommunityEdit` cannot change status, so the
  // pre- and post-edit answers agree; read it off the written row anyway.
  const shouldReindex = after.status === "PUBLISHED";
  // The durable half of that decision, in THIS transaction: the mark commits
  // with the edit, so a failed or starved post-commit reindex is retried by
  // the scheduled drain (`search/search-reindex-marks.ts`).
  if (shouldReindex) {
    await markForSearchReindex(tx, [{ kind: "event", id: after.id }], now);
  }

  return {
    appliedFieldNames,
    material,
    postCommit: (postDeps) => {
      if (shouldReindex) {
        // Best-effort by construction: `reindexAfterMutation` is
        // fire-and-forget, never throws, and owns its own swallow + the
        // `reportError` call inside it. Search being down cannot fail — let
        // alone roll back — an edit that already committed.
        reindexAfterMutation(
          {
            repos: postDeps.repos,
            search: postDeps.search,
            clock: postDeps.clock,
            logger: postDeps.logger,
            ...(postDeps.reportError
              ? { reportError: postDeps.reportError }
              : {}),
          },
          args.useCaseName,
          { kind: "event", id: after.id },
        );
      }
      return heldDates;
    },
  };
}
