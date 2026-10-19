import type { TxRepos } from "@th/ports/repos";
import type { OpenCallFormRecord, OpenCallSubmissionRecord } from "@th/ports/repos/events";

import { anchorOfForm } from "./open-call-anchor";

/**
 * What made the organizer side "open" an application (FR-010). Opening the
 * card shows its answers; a vote, a note, a pick or a "not this time" is a
 * judgement on them. All of them lock the applicant's edit, so nobody can
 * vote YES on an answer and then see it change. A thread message is NOT
 * here: asking "please add your link" must leave the edit open.
 */
export type FirstOpenVia = "open" | "vote" | "note" | "pick" | "decline";

/**
 * Stamp `openedAt` if nobody has yet, inside the caller's transaction. The
 * write is one guarded UPDATE (`... WHERE openedAt IS NULL`), so it lands
 * once even when two organizers act together, and it serialises with the
 * applicant's guarded edit on the row lock: the edit either commits first
 * or matches nothing. Audited as `open_call_application_opened` (with
 * `via`) when this call stamped it. Returns true when it did.
 */
export async function stampFirstOpen(
  tx: TxRepos,
  input: {
    form: OpenCallFormRecord;
    submission: OpenCallSubmissionRecord;
    actorHumanId: string;
    now: Date;
    via: FirstOpenVia;
  },
): Promise<boolean> {
  if (input.submission.openedAt !== null) return false;
  const stamped = await tx.eventApplications.markOpenCallSubmissionOpened({
    submissionId: input.submission.id,
    formId: input.form.id,
    openedAt: input.now,
  });
  if (!stamped) return false;
  const ref = anchorOfForm(input.form);
  await tx.audit.log({
    entity: ref.kind === "event" ? "event" : "event_series",
    entityId: ref.kind === "event" ? ref.eventId : ref.seriesId,
    action: "open_call_application_opened",
    data: {
      actorHumanId: input.actorHumanId,
      formId: input.form.id,
      submissionId: input.submission.id,
      via: input.via,
    },
    at: input.now,
  });
  return true;
}
