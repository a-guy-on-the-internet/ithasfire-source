import { fail } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { VolunteerAskRecord } from "@th/ports/repos/volunteering";

/**
 * Resolve the EVENT-subject `VolunteerAsk` for an event, creating it lazily
 * when the event never got one (volunteering enabled AFTER the A1 backfill
 * migration ran). Every event-path role/signup create calls this so `askId`
 * is stamped on new rows exactly like the backfill stamped it on old ones —
 * the invariant "every volunteering row hangs off an ask" must not decay for
 * post-migration events.
 *
 * The lazy create mirrors the A1 backfill mapping
 * (packages/db/prisma/migrations/20260701180000_add_volunteer_asks):
 * title/description from the event, status mirrors `volunteeringEnabled`
 * (OPEN/CLOSED), knobs copied from the event-level volunteer settings, and
 * `smsOptInEnabled: true` because the event signup form offers the SMS
 * opt-in unconditionally today.
 *
 * Race safety: the DB enforces at most one EVENT-subject ask per event via
 * the partial unique index `VolunteerAsk_event_subject_key`. The insert goes
 * through `createAskIfAbsent` (ON CONFLICT DO NOTHING) rather than
 * `createAsk`: this helper always runs inside `repos.tx()`, and a plain
 * create's P2002 would abort the Postgres transaction (25P02), poisoning
 * every later statement — including any recovery re-read. DO NOTHING keeps
 * the tx healthy, so the race loser simply re-reads the winner's row.
 * (Management flows keep `createAsk`, where the surfaced
 * `duplicate_event_ask` conflict is the desired user-facing error.)
 *
 * Note the ask's status is a snapshot of `volunteeringEnabled` at creation
 * time — event-path reads keep gating on the event flag itself
 * (`event.volunteeringEnabled`), never on the EVENT ask's status, so later
 * toggles don't need to touch the ask.
 */
export async function resolveOrCreateEventAsk(
  tx: TxRepos,
  event: EventRecord,
): Promise<VolunteerAskRecord> {
  const existing = await tx.volunteering.listAsksBySubject("EVENT", event.id);
  if (existing[0]) return existing[0];

  await tx.volunteering.createAskIfAbsent({
    subjectType: "EVENT",
    subjectId: event.id,
    orgId: event.orgId ?? null,
    title: event.title,
    description: event.volunteerIntroText ?? null,
    status: event.volunteeringEnabled ? "OPEN" : "CLOSED",
    cadence: "ONE_TIME",
    autoApprove: event.volunteerAutoApprove ?? false,
    waiverRequired: event.volunteerWaiverRequired ?? false,
    smsOptInEnabled: true,
    formSchema: {},
  });

  // Re-read regardless of whether OUR insert won or a concurrent tx's did —
  // both leave exactly one EVENT-subject ask behind. NOTE: seeing the
  // winner's row after a skipped insert relies on READ COMMITTED taking a
  // fresh per-statement snapshot; under a stricter isolation level
  // (REPEATABLE READ+) the re-read could miss it and the INTERNAL branch
  // below becomes reachable.
  const resolved = await tx.volunteering.listAsksBySubject("EVENT", event.id);
  if (resolved[0]) return resolved[0];

  // Unreachable unless storage is corrupt (insert skipped AND nothing to
  // read back). Surface as internal — never a user-facing conflict.
  throw fail("INTERNAL", {
    message: "event_ask_unresolvable_after_insert",
    meta: { eventId: event.id },
  });
}
