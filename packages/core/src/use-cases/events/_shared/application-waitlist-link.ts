import type { TxRepos } from "@th/ports/repos";
import type { EventWaitlistEntryRecord } from "@th/ports/repos/events";

/**
 * WAITLISTED-decision ↔ EventWaitlistEntry linkage (spec Phase 2 item 2).
 * Shared between review-event-application-submission (decision WAITLISTED →
 * create/link an entry) and rescind-event-application-decision (rescind →
 * DROP the linked entry).
 */

type WaitlistSubmissionIdentity = {
  humanId: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

/**
 * WAITLISTED decision → EventWaitlistEntry with `source: APPLICATION` and a
 * `metadata.submissionId` linkback (finally writing the enum value). Dedupe
 * follows join-event-waitlist's identity ladder (humanId → email → phone):
 * ONE entry per event + person. When an entry already exists it is LINKED,
 * not duplicated — metadata gains the submissionId, and a previously DROPPED
 * entry is revived to PENDING (other statuses are preserved; a
 * NOTIFIED/PURCHASED entrant keeps their state).
 *
 * The pre-existing entry's `source` is deliberately NOT rewritten: it is the
 * durable record of how the person originally joined, and it is half of what
 * a later rescind keys on — an entry this link step merely ANNOTATED (source
 * PUBLIC/INVITE) is only UNLINKED on rescind, never dropped. The other half
 * is `metadata.publicJoinedAt`, stamped by `joinEventWaitlist` when the
 * person joins an entry that already exists — which is the REVERSE ordering
 * (decision first, self-join second, where `source` is APPLICATION and would
 * otherwise look drop-safe). See {@link dropWaitlistEntryForSubmission}.
 */
export async function linkWaitlistEntryForSubmission(
  tx: Pick<TxRepos, "eventWaitlists">,
  context: {
    eventId: string;
    submission: WaitlistSubmissionIdentity & { id: string };
    at: Date;
  },
): Promise<EventWaitlistEntryRecord> {
  const { eventId, submission, at } = context;

  const existing = await findWaitlistEntryForSubmission(tx, {
    eventId,
    submission,
  });

  if (!existing) {
    return tx.eventWaitlists.createEntry({
      eventId,
      humanId: submission.humanId,
      contactEmail: submission.contactEmail,
      contactPhone: submission.contactPhone,
      source: "APPLICATION",
      status: "PENDING",
      metadata: { submissionId: submission.id },
    });
  }

  return tx.eventWaitlists.updateEntry({
    entryId: existing.id,
    status: existing.status === "DROPPED" ? "PENDING" : existing.status,
    metadata: { ...existing.metadata, submissionId: submission.id },
    updatedAt: at,
  });
}

export type DropWaitlistEntryResult =
  /** The entry existed only because of this decision — DROPPED. */
  | "dropped"
  /**
   * The person expressed INDEPENDENT waitlist intent (joined themselves,
   * before or after the decision) or holds a live/settled offer — the
   * submissionId linkback was stripped and the entry, status included, was
   * left exactly as it stood.
   */
  | "unlinked"
  /** No linked entry to touch. */
  | "none";

/**
 * Rescind of a WAITLISTED decision. A DROP is only correct when the entry
 * exists SOLELY because of the decision being rescinded; every other case
 * unlinks. Three guards, because
 * {@link linkWaitlistEntryForSubmission} has two behaviours (create vs
 * annotate) and the applicant can also join around it in either order:
 *
 *  1. `metadata.submissionId` must match this submission — otherwise the
 *     entry has nothing to do with the decision and is untouched;
 *  2. `source` must be APPLICATION — i.e. the link step CREATED the entry.
 *     A merged pre-existing entry (source PUBLIC/INVITE — the person joined
 *     the waitlist independently BEFORE the decision) is only unlinked;
 *  3. `metadata.publicJoinedAt` must be absent — it is stamped by
 *     `joinEventWaitlist` when someone joins an entry that already exists,
 *     which is the REVERSE ordering: the decision created the entry
 *     (source APPLICATION) and the applicant then submitted the gate's
 *     WaitlistJoinForm. Without this the self-join is invisible (that branch
 *     is otherwise a pure no-op) and the rescind would silently cancel a
 *     waitlist signup the UI told them had worked.
 *
 * Status guards: PURCHASED and DROPPED are never touched at all, and
 * NOTIFIED is UNLINKED rather than dropped — that entrant has already been
 * told a spot opened, and revoking a live offer because the organizer
 * changed an unrelated application decision is not ours to do. DROP means
 * status DROPPED, never delete — WaitlistEntryStatus keeps the row for
 * history.
 */
export async function dropWaitlistEntryForSubmission(
  tx: Pick<TxRepos, "eventWaitlists">,
  context: {
    eventId: string;
    submission: WaitlistSubmissionIdentity & { id: string };
    at: Date;
  },
): Promise<DropWaitlistEntryResult> {
  const { eventId, submission, at } = context;

  const entry = await findWaitlistEntryForSubmission(tx, {
    eventId,
    submission,
  });
  if (!entry) return "none";
  if (entry.metadata.submissionId !== submission.id) return "none";
  if (entry.status === "DROPPED" || entry.status === "PURCHASED") {
    return "none";
  }

  const createdByThisDecision =
    entry.source === "APPLICATION" && !entry.metadata.publicJoinedAt;

  if (!createdByThisDecision || entry.status === "NOTIFIED") {
    // Independent intent (either ordering) or a live offer: strip the
    // linkback, keep everything else (status, remaining metadata) intact.
    const { submissionId: _removed, ...remainingMetadata } = entry.metadata;
    await tx.eventWaitlists.updateEntry({
      entryId: entry.id,
      status: entry.status,
      metadata: remainingMetadata,
      updatedAt: at,
    });
    return "unlinked";
  }

  await tx.eventWaitlists.updateEntry({
    entryId: entry.id,
    status: "DROPPED",
    updatedAt: at,
  });
  return "dropped";
}

/**
 * The submission's waitlist entry, by the same identity ladder
 * join-event-waitlist dedupes on (humanId → contactEmail → contactPhone).
 */
export async function findWaitlistEntryForSubmission(
  tx: Pick<TxRepos, "eventWaitlists">,
  context: {
    eventId: string;
    submission: WaitlistSubmissionIdentity;
  },
): Promise<EventWaitlistEntryRecord | null> {
  const { eventId, submission } = context;

  if (submission.humanId) {
    const byHuman = await tx.eventWaitlists.findEntry({
      eventId,
      humanId: submission.humanId,
    });
    if (byHuman) return byHuman;
  }

  if (submission.contactEmail) {
    const byEmail = await tx.eventWaitlists.findEntry({
      eventId,
      contactEmail: submission.contactEmail,
    });
    if (byEmail) return byEmail;
  }

  if (submission.contactPhone) {
    const byPhone = await tx.eventWaitlists.findEntry({
      eventId,
      contactPhone: submission.contactPhone,
    });
    if (byPhone) return byPhone;
  }

  return null;
}
