import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { ContentFilterPort } from "@th/ports/content-filter";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  CommunityEditableFieldValues,
  EventRecord,
} from "@th/ports/repos/events";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { EventBody } from "@th/schema";
import { eventEditSuggestionRecordSchema } from "@th/schema";
import { fail } from "@th/errors";
import { plainTextMultilineOptional } from "../../lib/sanitize-plain-text";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import {
  bookingHoldNotificationIntentSchema,
  bookingHoldStaffRecipientHintSchema,
} from "../booking-holds/_shared/booking-hold-intents";
import {
  computeConflicts,
  GEO_GROUP_FIELDS,
  parseSuggestionFields,
  snapshotSuggestionBase,
} from "../events/_shared/suggestion-fields";
import { sanitizeEventBody } from "../events/_shared/event-body-sanitizer";
import {
  COMMUNITY_MODERATION_ROLES,
  ensureHeroImageReferenceValid,
  ensureProposedScheduleValid,
  ensureSuggestionTextAllowed,
  resolveCurrentHeroImageId,
  serializeSuggestionFields,
} from "./_shared/suggestion-validation";
import {
  noCommunityEditPostCommit,
  recordCommunityEditApplied,
  type CommunityEditPostCommit,
} from "./_shared/community-edit-applied";
import { notifySuggestionReviewed } from "./_shared/suggestion-notifications";
import { suggestionRejection } from "./_shared/suggestion-rejection";
import { ensureActorHoldsHumanEventRole } from "../../lib/event-edit-rights";

/**
 * FR-008/FR-009/FR-013 + NFR-002 (community-managed-event-listings spec):
 * the event's approver side reviews a PENDING suggestion. APPROVE atomically
 * applies the non-conflicting whitelisted diff + writes the before/after
 * AuditLog (one repos.tx); REJECT records the decision.
 *
 * ORDERING (authz vs claim): the claim guard stamps reviewedBy/At on the
 * PENDING row, so claiming BEFORE authz would let a forbidden actor burn the
 * claim (the legitimate reviewer would then see ALREADY_REVIEWED on a row
 * nobody reviewed). We therefore load the suggestion + event via getById
 * first, run the FR-008 authz branch, and only THEN claim. The claim is still
 * the atomic double-review guard: two AUTHORIZED reviewers racing both pass
 * authz, but only one wins the claim (the loser re-reads and reports
 * ALREADY_REVIEWED).
 *
 * RE-VALIDATION FAILURE AT APPROVE: stored Json is never trusted — every
 * applied value is re-parsed (whitelist), re-sanitized (body schema + embed
 * allowlist + cta hrefs), re-content-filtered, and the hero/date rules are
 * re-checked against the CURRENT event. A failure FAILS the approve with
 * EDIT_SUGGESTION_INVALID_FIELDS (tx rolls back; the suggestion stays
 * PENDING) rather than silently auto-rejecting: the reviewer sees the error
 * and can REJECT manually with a note. This satisfies the acceptance
 * criterion ("a stored suggestion that somehow contains one is NOT applied at
 * approve") while keeping the decision a human one.
 *
 * FR-009: fields whose base-version value drifted from the current event are
 * SKIPPED and flagged (`conflictedFields`); non-conflicting fields still
 * apply. An all-conflicted APPROVE still marks the suggestion APPROVED with
 * empty appliedFields (and writes no event mutation / event audit row).
 */

export const reviewEventEditSuggestionInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    suggestionId: z.uuid(),
    decision: z.enum(["APPROVE", "REJECT"]),
    reviewNote: plainTextMultilineOptional(1000).optional(),
  })
  .strict();

export const reviewEventEditSuggestionOutputSchema = z
  .object({
    suggestion: eventEditSuggestionRecordSchema,
    appliedFields: z.array(z.string()),
    conflictedFields: z.array(z.string()),
    /**
     * Booking-hold notifications an APPROVE owes (FR-018: it moved a
     * PUBLISHED event's start onto a held calendar+date). Server-side only —
     * they name other acts' requests; transport strips them and dispatches
     * post-commit.
     */
    notificationIntents: z.array(bookingHoldNotificationIntentSchema).optional(),
    staffRecipientHint: bookingHoldStaffRecipientHintSchema.nullable().optional(),
  })
  .strict();

/**
 * What transport puts on the wire: the intents + routing hint stay
 * server-side. Built from the omitted `.shape` (not `.omit()` on the strict
 * object) so `.parse(liveResult)` STRIPS the two keys instead of refusing the
 * result with `unrecognized_keys` the first time a listing actually owes one.
 */
export const reviewEventEditSuggestionWireOutputSchema = z.object(
  reviewEventEditSuggestionOutputSchema.omit({
    notificationIntents: true,
    staffRecipientHint: true,
  }).shape,
);

export type ReviewEventEditSuggestionInput = z.infer<
  typeof reviewEventEditSuggestionInputSchema
>;
export type ReviewEventEditSuggestionOutput = z.infer<
  typeof reviewEventEditSuggestionOutputSchema
>;

export type ReviewEventEditSuggestionDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  contentFilter: ContentFilterPort;
  /**
   * Best-effort incremental search-index update after an APPROVE commits. An
   * approved suggestion is how a public "the venue moved" report reaches a
   * live listing, so without this the page and the attendee notice both update
   * while search keeps serving the old venue until the nightly
   * `search.full-reindex`. Owned by the shared post-apply pipeline (see
   * `_shared/community-edit-applied.ts`), which is why the direct-edit path
   * cannot have it while this one does not. No-ops when omitted.
   */
  search?: MultiSearchPort;
  logger?: LoggerPort;
  /**
   * ReporterPort convention. The ONLY swallow on this path is that post-commit
   * reindex, which `reindexAfterMutation` owns; this is threaded so the
   * swallow stays Sentry-visible rather than silent.
   */
  reportError?: ReporterPort;
};

export async function reviewEventEditSuggestion(
  deps: ReviewEventEditSuggestionDeps,
  rawInput: unknown,
): Promise<ReviewEventEditSuggestionOutput> {
  const scopedLogger = deps.logger?.child({
    useCase: "reviewEventEditSuggestion",
  });

  const execute = async (): Promise<ReviewEventEditSuggestionOutput> => {
    const input = parseInput(reviewEventEditSuggestionInputSchema, rawInput);
    const reviewNote = input.reviewNote ?? null;

    const result = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();

      // ── Load + authz BEFORE claiming (see module doc comment) ────────────
      const suggestion = await tx.eventEditSuggestions.getById(
        input.suggestionId,
      );
      if (!suggestion) {
        throw fail("EDIT_SUGGESTION_NOT_FOUND");
      }
      if (suggestion.status !== "PENDING") {
        throw fail("EDIT_SUGGESTION_ALREADY_REVIEWED");
      }

      // Row-lock the event BEFORE reading it, so the linked-place guard below
      // and the apply see the same row: a concurrent place link cannot commit
      // between this read and the write. No venue lock is taken on this path,
      // so the venue-then-rows lock order is not at risk.
      await tx.events.lockRows({ ids: [suggestion.eventId], mode: "update" });
      const event = await tx.events.getById(suggestion.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }

      await ensureActorCanReview(deps, tx, event, input.actorHumanId);

      // ── Four-eyes: block self-APPROVAL on ownerless COMMUNITY listings ───
      // (S3-d) On a COMMUNITY (wiki-style) listing the reviewer is not the
      // resource owner, so approving your OWN suggestion bypasses independent
      // review — a one-actor path to mutate a public listing. Block APPROVE
      // when the actor is the submitter. Self-REJECT (withdrawal) stays
      // allowed, and org/personal events are unaffected: there the reviewer
      // already holds direct edit rights, so self-approval is equivalent to
      // editing directly. Checked BEFORE the claim so a forbidden self-approve
      // never burns the PENDING claim. Reuses FORBIDDEN (403) with a typed
      // reason rather than a bespoke code.
      if (
        input.decision === "APPROVE" &&
        event.stewardship === "COMMUNITY" &&
        suggestion.submitterHumanId !== null &&
        suggestion.submitterHumanId === input.actorHumanId
      ) {
        throw fail("FORBIDDEN", {
          meta: {
            reason: "self_review",
            eventId: event.id,
            suggestionId: suggestion.id,
          },
        });
      }

      // ── A listing that is over takes no edits ────────────────────────────
      // CANCELLED, ARCHIVED and COMPLETED are end states (a take-down,
      // archive or completion). Applying an edit there changes a page that
      // says "Event cancelled" / "No longer available" / "Event ended", and
      // an approved schedule edit could put nights back on a listing that is
      // over. APPROVE is refused with the codes `restoreEventDate` uses for
      // the same states; REJECT still works, which is how a moderator closes
      // the suggestion out. Checked BEFORE the claim, like the self-review
      // check, so a refused approve leaves the suggestion PENDING.
      if (input.decision === "APPROVE") {
        if (event.status === "CANCELLED") {
          throw fail("EVENT_ALREADY_CANCELLED");
        }
        if (event.status === "ARCHIVED") {
          throw fail("EVENT_ARCHIVED");
        }
        if (event.status === "COMPLETED") {
          throw fail("EVENT_ALREADY_COMPLETED");
        }
      }

      // ── Atomic claim (double-review guard) ───────────────────────────────
      const claimed = await tx.eventEditSuggestions.claimPendingForReview({
        id: suggestion.id,
        reviewedByHumanId: input.actorHumanId,
        reviewedAt: now,
      });
      if (!claimed) {
        // Lost a race after our PENDING read — the row exists, so this can
        // only mean another reviewer claimed it.
        throw fail("EDIT_SUGGESTION_ALREADY_REVIEWED");
      }

      // ── REJECT ───────────────────────────────────────────────────────────
      if (input.decision === "REJECT") {
        const reviewed = await tx.eventEditSuggestions.markReviewed({
          id: suggestion.id,
          status: "REJECTED",
          reviewedByHumanId: input.actorHumanId,
          reviewedAt: now,
          reviewNote,
        });

        await auditSuggestionReviewed(tx, {
          suggestion,
          actorHumanId: input.actorHumanId,
          decision: "REJECT",
          status: "REJECTED",
          reviewNote,
          appliedFields: [],
          conflictedFields: [],
          at: now,
        });

        return {
          reviewed,
          appliedFieldNames: [],
          conflicted: [] as string[],
          event,
          // A REJECT applies nothing, so it owes nothing after commit: no line
          // was taken and no indexed field moved.
          postCommit: noCommunityEditPostCommit,
        };
      }

      // ── APPROVE: re-validate + re-sanitize EVERY applied value ───────────
      const proposed = revalidateStoredFields(suggestion.fields);

      // An event linked to a place takes its address from the place, so an
      // address/geo suggestion would make the two disagree: REFUSED, never
      // auto-unlinked (same code as the direct edit's refusal). The throw
      // rolls back the claim, so nothing is written and the suggestion stays
      // PENDING. If the venue really moved, the moderator unlinks in the
      // builder and then approves: unlinking leaves the address untouched, so
      // the suggestion's base snapshot still matches and it applies cleanly.
      // Non-address suggestions (title, body, …) still apply to a linked
      // event.
      if (event.placeId) {
        const addressFields = GEO_GROUP_FIELDS.filter(
          (field) => proposed[field] !== undefined,
        );
        if (addressFields.length > 0) {
          throw suggestionRejection("unsupported_fields", addressFields);
        }
      }

      let content: EventBody | null | undefined;
      if (proposed.content !== undefined) {
        content =
          proposed.content === null
            ? null
            : sanitizeBodyOrReject(proposed.content);
        proposed.content = content;
      }

      // Same helper as the submit path, so submit-time and apply-time agree on
      // the filtered field set by construction (FR-006).
      await ensureSuggestionTextAllowed({
        contentFilter: deps.contentFilter,
        title: proposed.title,
        note: suggestion.note,
        content: content ?? null,
      });

      ensureProposedScheduleValid({ proposed, event });

      if (typeof proposed.heroImageId === "string") {
        await ensureHeroImageReferenceValid({
          images: tx.images,
          eventId: event.id,
          heroImageId: proposed.heroImageId,
          submitterHumanId: suggestion.submitterHumanId,
        });
      }

      // ── FR-009 conflict detection against the CURRENT event ─────────────
      const currentContent = await tx.events.getContent({ eventId: event.id });
      const currentHeroImageId = await resolveCurrentHeroImageId(
        tx.images,
        event,
      );
      const current = snapshotSuggestionBase({
        event,
        content: currentContent,
        heroImageId: currentHeroImageId,
      });

      const { applicable, conflicted } = computeConflicts({
        proposed: proposed as Record<string, unknown>,
        base: suggestion.baseVersion,
        current,
      });

      const applicableFields = applicable as CommunityEditableFieldValues;
      const appliedFieldNames = Object.keys(applicable);
      const appliedFieldsJson = serializeSuggestionFields(applicableFields);

      // ── Apply (whitelisted repo write; geohash re-derived adapter-side) ──
      // Stays the no-op dispatcher on an ALL-CONFLICTED approve: nothing was
      // written, so nothing is indexed and no line was taken.
      let postCommit: CommunityEditPostCommit = noCommunityEditPostCommit;
      if (appliedFieldNames.length > 0) {
        const updated = await tx.events.applyCommunityEdit({
          eventId: event.id,
          fields: applicableFields,
        });

        // THE SHARED POST-APPLY PIPELINE (FR-018 hold settlement + the
        // FR-008/FR-013 `event_edit.applied` version-history row + the FR-013
        // change-notice outbox). `updateCommunityListing`'s direct-edit path
        // runs the SAME function on the same rows — see
        // `_shared/community-edit-applied.ts` for why the two must never be
        // separate copies. Runs BEFORE `markReviewed` so a settle refusal
        // (open challenge on the new line) rolls the approve back with the
        // suggestion still PENDING.
        ({ postCommit } = await recordCommunityEditApplied(tx, {
          before: event,
          after: updated,
          applied: applicableFields,
          beforeSnapshot: current,
          actorHumanId: input.actorHumanId,
          now,
          suggestionId: suggestion.id,
          conflictedFields: conflicted,
          useCaseName: "reviewEventEditSuggestion",
        }));

        // Suggestion-borne hero upload: attach in the SAME tx (FR-007).
        if (typeof applicableFields.heroImageId === "string") {
          const heroImage = await tx.images.getById(
            applicableFields.heroImageId,
          );
          if (heroImage && !heroImage.attached) {
            await tx.images.attach({
              ownerId: event.id,
              imageIds: [heroImage.id],
              attachedAt: now,
            });
          }
        }
      }

      const reviewed = await tx.eventEditSuggestions.markReviewed({
        id: suggestion.id,
        status: "APPROVED",
        reviewedByHumanId: input.actorHumanId,
        reviewedAt: now,
        reviewNote,
        appliedFields: appliedFieldsJson,
        conflictedFields: conflicted,
      });

      await auditSuggestionReviewed(tx, {
        suggestion,
        actorHumanId: input.actorHumanId,
        decision: "APPROVE",
        status: "APPROVED",
        reviewNote,
        appliedFields: appliedFieldNames,
        conflictedFields: conflicted,
        at: now,
      });

      return { reviewed, appliedFieldNames, conflicted, event, postCommit };
    });

    // THE POST-COMMIT HALF of the shared pipeline: fire the best-effort
    // incremental search reindex (an approved venue/title/schedule change must
    // stop serving stale immediately, not at the next nightly full reindex)
    // and take the FR-018 settlement result off it. Run here, OUTSIDE the tx,
    // because indexing a row the tx might still have rolled back would publish
    // an edit that never happened — and because a slow search backend must not
    // hold this event's row locks. Never throws: `reindexAfterMutation`
    // swallows and reports through `deps.reportError`.
    const heldDates = result.postCommit({
      repos: deps.repos,
      clock: deps.clock,
      search: deps.search,
      logger: deps.logger,
      ...(deps.reportError ? { reportError: deps.reportError } : {}),
    });

    // Close the submitter-side feedback loop (Requirement B). Best-effort and
    // AFTER commit — anonymous submissions get nothing (handled inside), and a
    // notification failure never fails the review.
    await notifySuggestionReviewed(deps, {
      event: result.event,
      suggestion: result.reviewed,
      decision: input.decision,
      reviewNote,
      conflictedFields: result.conflicted,
    });

    return reviewEventEditSuggestionOutputSchema.parse({
      suggestion: result.reviewed,
      appliedFields: result.appliedFieldNames,
      conflictedFields: result.conflicted,
      ...(heldDates && heldDates.intents.length > 0
        ? {
            notificationIntents: heldDates.intents,
            staffRecipientHint: heldDates.staffRecipientHint,
          }
        : {}),
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("reviewEventEditSuggestion", execute);
  }

  return execute();
}

/**
 * FR-008 approver routing:
 *  - COMMUNITY listing → any COMMUNITY_MODERATOR (or platform ADMIN);
 *  - org-owned event   → ORG_EDIT_ROLES member of THAT org (a moderator who
 *    is not a member cannot review it);
 *  - personal event    → the humanId owner only.
 */
async function ensureActorCanReview(
  deps: Pick<ReviewEventEditSuggestionDeps, "authz">,
  tx: TxRepos,
  event: EventRecord,
  actorHumanId: string,
): Promise<void> {
  if (event.stewardship === "COMMUNITY") {
    const staff = await deps.authz.hasStaffRole({
      actorHumanId,
      requiredRoles: [...COMMUNITY_MODERATION_ROLES],
    });
    if (!staff.allowed) {
      throw fail("STAFF_ONLY");
    }
    return;
  }

  if (event.orgId) {
    await requireOrgMembership({
      repos: tx,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
      errorCode: "INSUFFICIENT_ROLE",
    });
    return;
  }

  await ensureActorHoldsHumanEventRole(tx.authz, event.humanId, actorHumanId);
}

/**
 * Stored fields Json is untrusted (could have been poisoned between submit
 * and approve). Re-run the whitelist parse; a structural failure keeps its
 * typed code, anything else is promoted to it.
 */
function revalidateStoredFields(
  fields: Record<string, unknown>,
): CommunityEditableFieldValues {
  try {
    return parseSuggestionFields(fields);
  } catch (error) {
    if (isAppErrorWithCode(error, "EDIT_SUGGESTION_INVALID_FIELDS")) {
      throw error;
    }
    throw suggestionRejection("stored_fields_revalidation_failed", undefined, {
      cause: error,
    });
  }
}

function sanitizeBodyOrReject(value: unknown): EventBody {
  try {
    return sanitizeEventBody(value);
  } catch (error) {
    throw suggestionRejection("invalid_body", ["content"], { cause: error });
  }
}

function isAppErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

async function auditSuggestionReviewed(
  tx: TxRepos,
  params: {
    suggestion: EventEditSuggestionRecord;
    actorHumanId: string;
    decision: "APPROVE" | "REJECT";
    status: "APPROVED" | "REJECTED";
    reviewNote: string | null;
    appliedFields: string[];
    conflictedFields: string[];
    at: Date;
  },
): Promise<void> {
  await tx.audit.log({
    entity: "event_edit_suggestion",
    entityId: params.suggestion.id,
    action: "event_edit_suggestion.reviewed",
    data: {
      actorHumanId: params.actorHumanId,
      eventId: params.suggestion.eventId,
      decision: params.decision,
      status: params.status,
      reviewNote: params.reviewNote,
      appliedFields: params.appliedFields,
      conflictedFields: params.conflictedFields,
    },
    at: params.at,
  });
}
