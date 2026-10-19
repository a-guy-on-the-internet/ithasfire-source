import { z } from "zod";

import type { TxRepos } from "@th/ports/repos";
import type {
  ApplicationMessageAuthorSide,
  ApplicationMessageRecord,
  OpenCallFormRecord,
  OpenCallSubmissionRecord,
} from "@th/ports/repos/events";

import { openCallApplicantAuthSchema, resolveOpenCallApplication } from "./open-call-application";
import { resolveOrganizerSubmission } from "./organizer-side";

/**
 * The applicant <-> organizer thread of one application (spec FR-015, Q22),
 * mirroring booking-requests/messages: author side, body, read markers.
 *
 * One thread per submission, reached only through that submission, so
 * applicant-to-applicant messaging is impossible by construction: an
 * applicant can only ever resolve their OWN submission (session or status
 * token), and the organizer side only a submission of a call it is on.
 */

/** Body bound: BOOKING_MESSAGE_MAX's 1..4000, sanitized (multiline) first. */
export const APPLICATION_MESSAGE_MAX = 4000;

/**
 * Who is acting on the thread, and how they prove it:
 *   - ORGANIZER: a signed-in human on the call's organizer side
 *     (`isOnOrganizerSide`), naming the call and the application. The
 *     submission must belong to that call.
 *   - APPLICANT: the SAME auth as the status page (step 4): the signed-in
 *     submitter (session) or the status-link token, with its expiry
 *     (OPEN_CALL_LINK_EXPIRED). Guests read and reply through their token.
 */
export const applicationThreadPartySchema = z.discriminatedUnion("side", [
  z
    .object({
      side: z.literal("ORGANIZER"),
      actorHumanId: z.uuid(),
      formId: z.uuid(),
      submissionId: z.uuid(),
    })
    .strict(),
  z.object({ side: z.literal("APPLICANT"), auth: openCallApplicantAuthSchema }).strict(),
]);

export type ApplicationThreadParty = z.infer<typeof applicationThreadPartySchema>;

export interface ResolvedThreadParty {
  side: ApplicationMessageAuthorSide;
  submission: OpenCallSubmissionRecord;
  form: OpenCallFormRecord;
  /**
   * Stored as the message author: the organizer human, or the signed-in
   * submitter. Null through a status token (whoever holds the link).
   */
  authorHumanId: string | null;
}

type ThreadRepos = Pick<
  TxRepos,
  "eventApplications" | "events" | "series" | "eventDates" | "seriesOccurrences" | "authz"
>;

/** Resolve the acting party or refuse (same refusals as step 4 / organizer side). */
export async function resolveThreadParty(
  repos: ThreadRepos,
  party: ApplicationThreadParty,
  now: Date,
): Promise<ResolvedThreadParty> {
  if (party.side === "ORGANIZER") {
    const { form, submission } = await resolveOrganizerSubmission(repos, party);
    return { side: "ORGANIZER", form, submission, authorHumanId: party.actorHumanId };
  }
  const { form, submission } = await resolveOpenCallApplication(repos, party.auth, now);
  return {
    side: "APPLICANT",
    form,
    submission,
    authorHumanId: party.auth.kind === "session" ? party.auth.actorHumanId : null,
  };
}

/**
 * DECISION (step 5): a WITHDRAWN application's thread is READ-ONLY. The
 * applicant left (withdrew, or dropped out after a pick, FR-017), so
 * neither side posts; both still read it and clear unread badges. Every
 * other status posts, including after a decision (FR-018: a "not this
 * time" can be answered) and EXPIRED (the call was pulled, FR-022).
 */
export function threadIsReadOnly(submission: Pick<OpenCallSubmissionRecord, "status">): boolean {
  return submission.status === "WITHDRAWN";
}

/** One thread message on the wire. */
export const applicationMessageSchema = z
  .object({
    id: z.uuid(),
    authorSide: z.enum(["ORGANIZER", "APPLICANT"]),
    /**
     * Which organizer member wrote it. Organizer reads only: always null on
     * an applicant read (the applicant talks to "the organizers").
     */
    authorHumanId: z.uuid().nullable(),
    body: z.string(),
    readAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();

export type ApplicationMessage = z.infer<typeof applicationMessageSchema>;

/** Field by field, with the author id withheld from the applicant side. */
export function projectApplicationMessage(
  row: ApplicationMessageRecord,
  readerSide: ApplicationMessageAuthorSide,
): ApplicationMessage {
  return {
    id: row.id,
    authorSide: row.authorSide,
    authorHumanId: readerSide === "ORGANIZER" ? row.authorHumanId : null,
    body: row.body,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

/**
 * The notice seam for FR-015 ("a new message notifies the other side"):
 * composed by the transport (`makeOpenCallNotifier`) and called AFTER the
 * message commits. A throwing notifier never fails the committed message
 * (deliberate swallow + reportError). The message's author and body ride
 * along so the notifier never notifies the sender and can quote the message
 * without re-reading it.
 */
export type NotifyApplicationMessagePostedFn = (input: {
  formId: string;
  submissionId: string;
  messageId: string;
  recipientSide: ApplicationMessageAuthorSide;
  /** The signed-in author; null through a status token. */
  authorHumanId: string | null;
  /** The stored (sanitised) body. */
  body: string;
}) => Promise<void>;
